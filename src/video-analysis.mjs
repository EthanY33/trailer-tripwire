/* Video-analysis primitives built on ffmpeg + ffprobe.
 *
 * All functions are async and return plain data (numbers, arrays, objects) —
 * no filesystem side effects. Callers own caching and output.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const FFMPEG = (await import('ffmpeg-static')).default;
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');

/* ─────────────────────────────────────── probe ─── */

export function probe(videoPath) {
  // Use system ffprobe if available, else fall back to the one alongside ffmpeg-static.
  const candidates = [FFPROBE, 'ffprobe'];
  for (const bin of candidates) {
    const r = spawnSync(bin, [
      '-v', 'error', '-print_format', 'json',
      '-show_format', '-show_streams',
      videoPath,
    ], { encoding: 'utf8' });
    if (r.status === 0) {
      const data = JSON.parse(r.stdout);
      const v = data.streams.find(s => s.codec_type === 'video');
      const a = data.streams.find(s => s.codec_type === 'audio');
      return {
        durationSec: parseFloat(data.format.duration),
        width: v ? v.width : null,
        height: v ? v.height : null,
        fps: v ? evalFrameRate(v.r_frame_rate) : null,
        vcodec: v ? v.codec_name : null,
        acodec: a ? a.codec_name : null,
        hasAudio: !!a,
        sizeBytes: parseInt(data.format.size, 10) || 0,
      };
    }
  }
  throw new Error(`ffprobe failed on ${videoPath}`);
}

function evalFrameRate(s) {
  if (!s) return null;
  const [n, d] = s.split('/').map(Number);
  if (!d) return n;
  return n / d;
}

/* ─────────────────────────────────────── shot detection ─── */

/* Returns array of cut timestamps (seconds from start).
 * Uses ffmpeg's scene-detection filter — higher threshold = fewer cuts detected.
 *
 * 0.15 is the calibrated default — motion-graphics-heavy content (Google/NVIDIA
 * launch films) has dissolves and pushes that only register at ~0.15, whereas
 * hard-cut gameplay trailers spike above 0.3. 0.15 catches both classes with
 * minimal false positives on slow pans. */
export function detectShots(videoPath, threshold = 0.15) {
  const r = spawnSync(FFMPEG, [
    '-hide_banner', '-nostats',
    '-i', videoPath,
    '-vf', `select='gt(scene,${threshold})',showinfo`,
    '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  const cuts = [];
  const re = /pts_time:([0-9.]+)/g;
  let m;
  while ((m = re.exec(r.stderr))) cuts.push(parseFloat(m[1]));
  return cuts;
}

/* ─────────────────────────────────────── fade detection ─── */

/* Returns array of { start, end } windows where the frame is near-black.
 * d = minimum duration of dark window in seconds to count as a fade. */
export function detectFades(videoPath, { minDurSec = 0.2, picTh = 0.98 } = {}) {
  const r = spawnSync(FFMPEG, [
    '-hide_banner', '-nostats',
    '-i', videoPath,
    '-vf', `blackdetect=d=${minDurSec}:pic_th=${picTh}`,
    '-an', '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  const fades = [];
  const re = /black_start:([0-9.]+)\s+black_end:([0-9.]+)/g;
  let m;
  while ((m = re.exec(r.stderr))) fades.push({ start: parseFloat(m[1]), end: parseFloat(m[2]) });
  return fades;
}

/* ─────────────────────────────────────── color palette ─── */

/* Extract N dominant colors from the whole video or from a time segment.
 * Returns array of #rrggbb hex strings sorted by frequency. */
export function extractPalette(videoPath, { maxColors = 8, startSec = 0, endSec = null } = {}) {
  const tmp = path.join(os.tmpdir(), `palette-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  try {
    const trimArgs = endSec != null
      ? ['-ss', String(startSec), '-to', String(endSec)]
      : startSec > 0 ? ['-ss', String(startSec)] : [];
    const r = spawnSync(FFMPEG, [
      '-hide_banner', '-nostats',
      ...trimArgs,
      '-i', videoPath,
      '-vf', `fps=1/2,palettegen=max_colors=${maxColors}:stats_mode=full`,
      '-y', tmp,
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`palettegen failed: ${r.stderr.slice(-400)}`);
    return readPalettePng(tmp, maxColors);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/* palettegen writes a tiny PNG (maxColors × 1 px). We read it with raw ffmpeg
 * to avoid pulling in a PNG decoder. Round-trip via rawvideo. */
function readPalettePng(pngPath, maxColors) {
  const r = spawnSync(FFMPEG, [
    '-hide_banner', '-nostats',
    '-i', pngPath,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    '-y', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return [];
  const buf = r.stdout;
  const colors = [];
  for (let i = 0; i < buf.length; i += 3) {
    const hex = '#' + buf[i].toString(16).padStart(2, '0') +
                      buf[i+1].toString(16).padStart(2, '0') +
                      buf[i+2].toString(16).padStart(2, '0');
    colors.push(hex);
  }
  return colors.slice(0, maxColors);
}

/* Palette-over-time: split the video into `buckets` time slices and run
 * palettegen on each. Returns array of { start, end, palette }. */
export function extractPaletteOverTime(videoPath, { buckets = 6, colorsPerBucket = 5 } = {}) {
  const meta = probe(videoPath);
  const slice = meta.durationSec / buckets;
  const out = [];
  for (let i = 0; i < buckets; i++) {
    const start = i * slice;
    const end = (i + 1) * slice;
    out.push({
      start: +start.toFixed(2),
      end: +end.toFixed(2),
      palette: extractPalette(videoPath, { maxColors: colorsPerBucket, startSec: start, endSec: end }),
    });
  }
  return out;
}

/* ─────────────────────────────────────── audio analysis ─── */

/* Returns { rmsPerBucket, silentRatio, hasAudio, peakDbfs }.
 * rmsPerBucket is an array of linear RMS values (0..1-ish) sampled over the
 * whole duration at roughly `buckets` points. silentRatio is the fraction of
 * buckets below -50 dBFS (a heuristic threshold for "silence"). */
export function analyzeAudio(videoPath, { buckets = 60 } = {}) {
  const meta = probe(videoPath);
  if (!meta.hasAudio) return { rmsPerBucket: [], silentRatio: 1, hasAudio: false, peakDbfs: -Infinity };

  const bucketDurSec = meta.durationSec / buckets;

  // Use astats with ametadata print to get RMS level per bucket.
  // Resample at 1/bucketDurSec then read RMS_level keys.
  const r = spawnSync(FFMPEG, [
    '-hide_banner', '-nostats',
    '-i', videoPath,
    '-af', `aresample=48000,asetnsamples=n=${Math.max(1, Math.round(48000 * bucketDurSec))}:p=0,` +
           `astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`,
    '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  // Each bucket prints a block like: `lavfi.astats.Overall.RMS_level=-23.5`
  const rmsPerBucket = [];
  const re = /RMS_level=(-?[0-9.]+|-inf|nan)/gi;
  let m;
  while ((m = re.exec(r.stderr))) {
    const raw = m[1].toLowerCase();
    const db = (raw === '-inf' || raw === 'nan') ? -120 : parseFloat(raw);
    rmsPerBucket.push(db);
  }
  const silentRatio = rmsPerBucket.length
    ? rmsPerBucket.filter(db => db < -50).length / rmsPerBucket.length
    : 1;
  const peakDbfs = rmsPerBucket.length ? Math.max(...rmsPerBucket) : -Infinity;
  return { rmsPerBucket, silentRatio: +silentRatio.toFixed(3), hasAudio: true, peakDbfs: +peakDbfs.toFixed(1) };
}

/* ─────────────────────────────────────── composite: shot stats ─── */

/* Derived stats from a cut list. */
export function shotStats(cuts, totalDurSec) {
  const times = [0, ...cuts, totalDurSec].sort((a, b) => a - b);
  const lengths = [];
  for (let i = 1; i < times.length; i++) lengths.push(times[i] - times[i - 1]);
  if (!lengths.length) return { count: 0, meanSec: 0, medianSec: 0, minSec: 0, maxSec: 0 };
  const sorted = [...lengths].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    count: lengths.length,
    meanSec: +(lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(2),
    medianSec: +median.toFixed(2),
    minSec: +Math.min(...lengths).toFixed(2),
    maxSec: +Math.max(...lengths).toFixed(2),
    cutsPerSec: +(cuts.length / totalDurSec).toFixed(3),
  };
}

/* Ratio of "fade-based" transitions to "hard cut" transitions.
 * A cut is "fade-based" if it sits inside (or at the edge of) a detected
 * black window; otherwise it's a hard cut. */
export function fadeVsCutRatio(cuts, fades) {
  if (!cuts.length) return { fadeCuts: 0, hardCuts: 0, fadeFraction: 0 };
  let fadeCuts = 0;
  for (const t of cuts) {
    for (const f of fades) {
      if (t >= f.start - 0.1 && t <= f.end + 0.1) { fadeCuts++; break; }
    }
  }
  const hardCuts = cuts.length - fadeCuts;
  return {
    fadeCuts,
    hardCuts,
    fadeFraction: +(fadeCuts / cuts.length).toFixed(3),
  };
}
