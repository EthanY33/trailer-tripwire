/* Thin wrapper around yt-dlp for downloading reference trailers. */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/* Prefer a locally-downloaded yt-dlp.exe; fall back to system one. */
function resolveYtDlp() {
  const candidates = [
    path.join(os.tmpdir(), 'yt-dlp.exe'),  // first-run install target
    'yt-dlp',                               // system PATH
  ];
  for (const bin of candidates) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return bin;
  }
  throw new Error(
    'yt-dlp not found. Install it:\n' +
    '  curl -sL -o %TMP%/yt-dlp.exe https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe\n' +
    'or add to PATH.'
  );
}

/* Download a YouTube URL to `destDir` and return the final file path.
 * Picks a best <=1080p MP4 by default. Skips download if the target exists. */
export function downloadVideo(url, destDir, { quality = 'bestvideo[height<=1080]+bestaudio/best', videoId = null } = {}) {
  if (typeof url !== 'string' || !url) {
    throw new Error('downloadVideo: url must be a non-empty string');
  }
  if (url.startsWith('-')) {
    throw new Error(`downloadVideo: url may not start with "-" (got ${JSON.stringify(url)})`);
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`downloadVideo: url must be http(s) (got ${JSON.stringify(url)})`);
  }
  const bin = resolveYtDlp();
  fs.mkdirSync(destDir, { recursive: true });

  const id = videoId || extractVideoId(url) || `video-${Date.now()}`;
  const outPath = path.join(destDir, `${id}.mp4`);
  if (fs.existsSync(outPath)) return outPath;

  const r = spawnSync(bin, [
    '-f', quality,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '-o', outPath,
    url,
  ], { stdio: 'inherit' });

  if (r.status !== 0) throw new Error(`yt-dlp exited ${r.status}`);
  return outPath;
}

export function extractVideoId(url) {
  const m = url.match(/[?&]v=([a-zA-Z0-9_-]{6,})/) || url.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/);
  return m ? m[1] : null;
}
