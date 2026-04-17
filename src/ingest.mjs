/* Ingest a reference trailer into a structural profile.
 *
 * Usage (via CLI):
 *   trailer-tripwire ingest <url-or-path> [--name <slug>] [--out <dir>] [--threshold <n>]
 *
 * Produces `<out>/<slug>.profile.json` following `reference-profile/v1`.
 * YouTube URLs are downloaded to `<out>/<slug>.mp4` via yt-dlp.
 */

import path from 'node:path';
import fs from 'node:fs';
import {
  probe, detectShots, detectFades, extractPaletteOverTime,
  analyzeAudio, shotStats, fadeVsCutRatio,
} from './video-analysis.mjs';
import { downloadVideo, extractVideoId } from './yt-download.mjs';

export async function ingest({ input, name, outDir, threshold = 0.15 }) {
  if (!input) throw new Error('usage: ingest <url-or-path> [--name <slug>] [--out <dir>]');
  const refsDir = path.resolve(outDir || 'content-refs');
  fs.mkdirSync(refsDir, { recursive: true });

  const isUrl = /^https?:\/\//.test(input);
  const videoId = isUrl ? extractVideoId(input) : null;
  const slug = name || videoId || path.basename(input, path.extname(input));

  let videoPath;
  if (isUrl) {
    console.log(`→ downloading ${input} → ${path.relative(process.cwd(), refsDir)}/${slug}.mp4`);
    videoPath = downloadVideo(input, refsDir, { videoId: slug });
  } else {
    videoPath = path.resolve(input);
    if (!fs.existsSync(videoPath)) throw new Error(`not found: ${videoPath}`);
  }

  console.log('→ probing...');
  const meta = probe(videoPath);
  console.log(`  ${meta.width}×${meta.height} @ ${meta.fps?.toFixed(2)}fps, ${meta.durationSec.toFixed(1)}s, audio=${meta.hasAudio}`);

  console.log(`→ detecting shot cuts (scene threshold ${threshold})...`);
  const cuts = detectShots(videoPath, threshold);
  const stats = shotStats(cuts, meta.durationSec);
  console.log(`  ${cuts.length} cuts | mean shot ${stats.meanSec}s | median ${stats.medianSec}s | ${stats.cutsPerSec}/s`);

  console.log('→ detecting fade-to-black windows...');
  const fades = detectFades(videoPath);
  const fadeRatio = fadeVsCutRatio(cuts, fades);
  console.log(`  ${fades.length} fade windows | fadeFraction ${fadeRatio.fadeFraction}`);

  console.log('→ extracting color palette over time (6 buckets × 5 colors)...');
  const palette = extractPaletteOverTime(videoPath, { buckets: 6, colorsPerBucket: 5 });

  console.log('→ analyzing audio...');
  const audio = analyzeAudio(videoPath, { buckets: 60 });
  console.log(`  hasAudio=${audio.hasAudio} | silentRatio=${audio.silentRatio} | peak=${audio.peakDbfs}dBFS`);

  const profile = {
    schema: 'reference-profile/v1',
    slug,
    source: isUrl ? input : path.relative(process.cwd(), videoPath),
    ingestedAt: new Date().toISOString(),
    meta,
    shots: { cuts, stats, fades, fadeVsCut: fadeRatio, sceneThreshold: threshold },
    palette,
    audio,
  };

  const outPath = path.join(refsDir, `${slug}.profile.json`);
  fs.writeFileSync(outPath, JSON.stringify(profile, null, 2));
  console.log(`✓ wrote ${path.relative(process.cwd(), outPath)} (${(fs.statSync(outPath).size/1024).toFixed(1)}KB)`);
  return profile;
}
