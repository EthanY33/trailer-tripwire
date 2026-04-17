/* Audit a trailer for AI-default tells. Pattern checker, not taste checker.
 *
 * Usage (via CLI):
 *   trailer-tripwire audit <video> [--ref <profile.json>] [--out <report.md>]
 *
 * Returns { findings, ok, report, hasCritical } and (if caller passes an
 * `--out` path) writes the markdown report to disk.
 */

import path from 'node:path';
import fs from 'node:fs';
import {
  probe, detectShots, detectFades, extractPaletteOverTime,
  analyzeAudio, shotStats, fadeVsCutRatio,
} from './video-analysis.mjs';

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length;
  return Math.sqrt(v);
}
function pct(x) { return (x * 100).toFixed(1) + '%'; }

export function audit({ videoPath, refPath = null, outPath = null, verbose = true }) {
  if (!videoPath) throw new Error('usage: audit <video> [--ref <profile.json>] [--out <report.md>]');
  const abs = path.resolve(videoPath);
  if (!fs.existsSync(abs)) throw new Error(`not found: ${abs}`);

  let ref = null;
  if (refPath) {
    ref = JSON.parse(fs.readFileSync(path.resolve(refPath), 'utf8'));
    if (ref.schema !== 'reference-profile/v1') throw new Error(`invalid profile schema: ${ref.schema}`);
  }

  const sceneThreshold = ref ? ref.shots.sceneThreshold : 0.15;

  if (verbose) console.log('→ analyzing', path.relative(process.cwd(), abs));
  const meta = probe(abs);
  const cuts = detectShots(abs, sceneThreshold);
  const stats = shotStats(cuts, meta.durationSec);
  const fades = detectFades(abs);
  const fadeRatio = fadeVsCutRatio(cuts, fades);
  const palette = extractPaletteOverTime(abs, { buckets: 6, colorsPerBucket: 5 });
  const audioData = analyzeAudio(abs, { buckets: Math.max(30, Math.round(meta.durationSec)) });

  const findings = [];
  const ok = [];

  /* ─ Absolute checklist ─ */

  if (stats.medianSec < 0.4) findings.push(['WARN', 'pacing',
    `Median shot length is ${stats.medianSec}s — under 0.4s reads as music-video churn, inappropriate for a studio launch.`]);
  else if (stats.medianSec > 15) findings.push(['NOTE', 'pacing',
    `Median shot length is ${stats.medianSec}s — very static. Works if intentional (tech-launch slow holds); flags as AI-default if unintentional.`]);
  else ok.push(`Pacing: median shot ${stats.medianSec}s, mean ${stats.meanSec}s (${stats.cutsPerSec}/s) — within human-edit range.`);

  if (stats.count >= 3 && fadeRatio.fadeFraction >= 0.4) findings.push(['CRITICAL', 'fade-to-black',
    `${fadeRatio.fadeCuts}/${stats.count} cuts (${pct(fadeRatio.fadeFraction)}) land inside black windows — reads as slideshow. Professional editorial uses hard cuts or match cuts; fade-to-black is for chapter breaks only.`]);
  else if (stats.count >= 3 && fadeRatio.fadeFraction >= 0.2) findings.push(['WARN', 'fade-to-black',
    `${pct(fadeRatio.fadeFraction)} of cuts are fade-based — consider reducing.`]);
  else ok.push(`Fade-to-black: ${fadeRatio.fadeCuts}/${stats.count || 1} cuts (${pct(fadeRatio.fadeFraction)}) — not slideshow-ish.`);

  const longFades = fades.filter(f => f.end - f.start > 1.5);
  if (longFades.length > 2) findings.push(['WARN', 'long-black',
    `${longFades.length} long black windows (>1.5s each) — trailer feels sparse or unfinished.`]);

  if (meta.hasAudio && audioData.silentRatio > 0.3) findings.push(['WARN', 'audio-silence',
    `${pct(audioData.silentRatio)} of the trailer is below -50dBFS — dead air. Composed trailer music carries continuously.`]);
  else if (!meta.hasAudio) ok.push('Silent track (intentional for web-hero loops).');
  else ok.push(`Audio density: ${pct(audioData.silentRatio)} silent (under -50dBFS) — filled.`);

  if (meta.hasAudio) {
    const rmsValid = audioData.rmsPerBucket.filter(x => x > -100);
    const rmsStdev = stdev(rmsValid);
    if (rmsStdev < 3) findings.push(['CRITICAL', 'audio-flat',
      `Audio RMS stdev is ${rmsStdev.toFixed(2)} dB — almost no dynamic variation. This is the procedural-drone tell. Composed music swings 8-15 dB over its duration.`]);
    else if (rmsStdev < 6) findings.push(['WARN', 'audio-flat',
      `Audio RMS stdev is ${rmsStdev.toFixed(2)} dB — less variation than a composed track (typically 8-15 dB).`]);
    else ok.push(`Audio dynamics: RMS stdev ${rmsStdev.toFixed(2)} dB — expressive.`);

    if (audioData.peakDbfs > -1) findings.push(['WARN', 'audio-peak',
      `Peak ${audioData.peakDbfs}dBFS — too hot. Target true-peak ceiling is -1.0 dBTP for streaming platforms.`]);
  }

  if (!meta.hasAudio && meta.durationSec > 12) findings.push(['NOTE', 'no-audio',
    `No audio track on a ${meta.durationSec.toFixed(1)}s video. Only appropriate for silent web-hero loops (<10s).`]);

  if (meta.width < 1080) findings.push(['WARN', 'resolution',
    `${meta.width}×${meta.height} — below 1080p. Platform minimums generally expect ≥1080p.`]);

  const allColors = palette.flatMap(b => b.palette);
  const uniqHues = new Set(allColors.map(c => c.slice(0, 4))).size;
  if (uniqHues < 4) findings.push(['NOTE', 'palette',
    `Only ~${uniqHues} distinct hue families across the whole video. Monochrome can be intentional, but often reads as "stuck in one mood."`]);

  /* ─ Reference deltas ─ */

  const refDelta = [];
  if (ref) {
    const refCutsPerSec = ref.shots.stats.cutsPerSec || 0;
    const delta = stats.cutsPerSec - refCutsPerSec;
    if (Math.abs(delta) > 0.2 && refCutsPerSec > 0) {
      const dir = delta > 0 ? 'faster' : 'slower';
      refDelta.push(['NOTE', 'vs-ref-pacing',
        `Pacing is ${dir} than the reference: ${stats.cutsPerSec}/s vs ${refCutsPerSec}/s.`]);
    } else {
      refDelta.push(['OK', 'vs-ref-pacing',
        `Pacing matches reference within ±0.2/s (${stats.cutsPerSec} vs ${refCutsPerSec}).`]);
    }

    const fadeDelta = fadeRatio.fadeFraction - (ref.shots.fadeVsCut.fadeFraction || 0);
    if (Math.abs(fadeDelta) > 0.2) {
      refDelta.push([fadeDelta > 0 ? 'WARN' : 'OK', 'vs-ref-fades',
        `Fade fraction: ${pct(fadeRatio.fadeFraction)} vs reference ${pct(ref.shots.fadeVsCut.fadeFraction)} (Δ ${(fadeDelta*100).toFixed(1)}pt).`]);
    }

    if (ref.audio.hasAudio && audioData.hasAudio) {
      const refStdev = stdev((ref.audio.rmsPerBucket || []).filter(x => x > -100));
      const thisStdev = stdev(audioData.rmsPerBucket.filter(x => x > -100));
      if (refStdev > 0 && thisStdev < refStdev * 0.5) {
        refDelta.push(['WARN', 'vs-ref-audio-dynamics',
          `Audio dynamic range ${thisStdev.toFixed(1)} dB is less than half the reference's ${refStdev.toFixed(1)} dB — your audio is flatter than the inspiration.`]);
      }
    }
  }

  /* ─ Emit report ─ */

  const lines = [];
  lines.push(`# Trailer audit — ${path.basename(abs)}`);
  lines.push('');
  lines.push(`- **Duration:** ${meta.durationSec.toFixed(1)}s`);
  lines.push(`- **Resolution:** ${meta.width}×${meta.height} @ ${meta.fps?.toFixed(1)}fps`);
  lines.push(`- **Audio:** ${meta.hasAudio ? 'yes' : 'silent'}${meta.hasAudio ? ` | ${pct(audioData.silentRatio)} below -50dBFS | peak ${audioData.peakDbfs}dBFS` : ''}`);
  lines.push(`- **Shots (scene threshold ${sceneThreshold}):** ${stats.count} | median ${stats.medianSec}s | ${stats.cutsPerSec}/s`);
  lines.push(`- **Fade-based transitions:** ${fadeRatio.fadeCuts}/${stats.count || 1} (${pct(fadeRatio.fadeFraction)})`);
  if (ref) lines.push(`- **Reference:** ${ref.slug} (${ref.meta.durationSec.toFixed(1)}s, ${ref.shots.stats.cutsPerSec}/s, fade ${pct(ref.shots.fadeVsCut.fadeFraction || 0)})`);
  lines.push('');

  const all = [...findings, ...refDelta];
  const bySev = (sev) => all.filter(f => f[0] === sev);
  for (const sev of ['CRITICAL', 'WARN', 'NOTE']) {
    const rows = bySev(sev);
    if (!rows.length) continue;
    lines.push(`## ${sev}`);
    for (const [, tag, msg] of rows) lines.push(`- **[${tag}]** ${msg}`);
    lines.push('');
  }
  const okRows = [...ok, ...bySev('OK').map(r => r[2])];
  if (okRows.length) {
    lines.push('## OK');
    for (const msg of okRows) lines.push(`- ${msg}`);
    lines.push('');
  }

  const counts = ['CRITICAL', 'WARN', 'NOTE'].map(s => `${s}=${bySev(s).length}`).join(' · ');
  lines.push(`---`);
  lines.push(`_${counts}_`);

  const report = lines.join('\n');
  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), report);
    if (verbose) console.log('\n✓ wrote', path.relative(process.cwd(), path.resolve(outPath)));
  } else if (verbose) {
    process.stdout.write('\n' + report + '\n');
  }

  return {
    findings: all,
    ok: okRows,
    report,
    hasCritical: bySev('CRITICAL').length > 0,
    counts: { critical: bySev('CRITICAL').length, warn: bySev('WARN').length, note: bySev('NOTE').length },
  };
}
