/* Scan the git staged set for video files and audit each one.
 * Exits non-zero if any have CRITICAL findings — used as a pre-commit gate.
 *
 * Usage (via CLI):
 *   trailer-tripwire check [--dir <path-prefix>] [--ext mp4,webm,mov,mkv]
 *
 * `--dir` restricts to files whose path (forward-slashed) starts with the
 * given prefix. Default: no restriction — scans all staged videos.
 *
 * What is audited is the staged content (the blob in the index), because that
 * is what the commit records. The working tree file is never read. Every git
 * command runs from the repository root, so check works from a subdirectory.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { audit } from './audit.mjs';

const MAX_BUFFER = 64 * 1024 * 1024;

// Run git without a shell. Returns the spawnSync result.
function runGit(cwd, args, opts = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, ...opts });
}

// One line saying why a git call failed.
function gitFailure(r) {
  if (r.error) return r.error.message;
  if (r.signal) return `git was killed by ${r.signal}`;
  const err = String(r.stderr || '').trim().split(/\r?\n/)[0];
  return err || `git exited with status ${r.status}`;
}

/* Write the staged content of `name` to the file `dest`. git writes straight
 * into the file, so a large video is never held in memory. --filters applies
 * smudge filters (a Git LFS pointer becomes the real video); git that cannot
 * do that falls back to the raw blob. `:0:<path>` is the index entry at stage
 * 0, spelled out so a path that itself starts with `<digit>:` cannot be
 * misread as a stage number. */
function writeStagedBlob(root, name, dest) {
  let r;
  for (const how of [['--filters'], ['blob']]) {
    const fd = fs.openSync(dest, 'w');
    try {
      r = runGit(root, ['cat-file', ...how, `:0:${name}`], { stdio: ['ignore', fd, 'pipe'] });
    } finally {
      fs.closeSync(fd);
    }
    if (!r.error && r.status === 0) return;
  }
  throw new Error(`cannot read the staged content: ${gitFailure(r)}`);
}

export function checkStaged({ dir = null, ext = ['mp4', 'webm', 'mov', 'mkv'], cwd = process.cwd() } = {}) {
  // git prints staged names relative to the repository root, whatever the
  // current directory is, so everything below runs from that root.
  const top = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (top.error || top.status !== 0) {
    const notARepo = !top.error && !top.signal;
    console.error(notARepo
      ? 'trailer-tripwire: not inside a git repository'
      : `trailer-tripwire: cannot run git: ${gitFailure(top)}`);
    return { exitCode: 2 };
  }
  const root = top.stdout.replace(/\r?\n$/, '');

  // -z: NUL-separated raw names. The default output C-quotes any name with
  // a non-ASCII byte, a quote or a backslash, and a quoted name no longer
  // ends in its extension. ACMR: a rename or copy is listed under its new
  // path, so a video moved into scope with `git mv` is audited too.
  const r = runGit(root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
  if (r.error || r.status !== 0) {
    console.error(`trailer-tripwire: git diff --cached failed: ${gitFailure(r)}`);
    return { exitCode: 2 };
  }

  const staged = r.stdout.split('\0').filter(Boolean);
  const extRe = new RegExp(`\\.(${ext.join('|')})$`, 'i');

  const trailers = staged.filter(f => {
    const fwd = f.replace(/\\/g, '/');
    if (!extRe.test(fwd)) return false;
    if (dir && !fwd.startsWith(dir.replace(/\\/g, '/'))) return false;
    return true;
  });

  if (!trailers.length) return { exitCode: 0 };

  console.log(`→ trailer-tripwire: auditing ${trailers.length} staged video file(s)...`);

  let blocked = 0;
  let errored = 0;
  // ffmpeg needs a file, so each staged blob goes to a temp file that keeps
  // the extension and is deleted again as soon as it has been audited.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailer-tripwire-'));
  try {
    for (const [i, t] of trailers.entries()) {
      const suffix = /\.[a-z0-9]+$/i.exec(t);
      const tmp = path.join(tmpDir, `staged-${i}${suffix ? suffix[0].toLowerCase() : ''}`);
      try {
        writeStagedBlob(root, t, tmp);
        const result = audit({ videoPath: tmp, verbose: false });
        if (result.hasCritical) {
          console.log(`  ✗ ${t} — CRITICAL findings (blocking):`);
          for (const [sev, tag, msg] of result.findings) {
            if (sev === 'CRITICAL') console.log(`    - [${tag}] ${msg}`);
          }
          blocked++;
        } else {
          console.log(`  ✓ ${t} — no CRITICAL findings`);
        }
      } catch (e) {
        console.log(`  ! ${t} — audit error: ${String(e.message).split(tmp).join(t)}`);
        errored++;
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (blocked > 0) {
    console.log('');
    console.log(`✗ trailer-tripwire: ${blocked} trailer(s) have CRITICAL findings — commit blocked.`);
    console.log('  Options:');
    console.log('    1. Fix the findings (run `trailer-tripwire audit <file>` for full details)');
    console.log('    2. Bypass: `git commit --no-verify` (use sparingly)');
    return { exitCode: 1, blocked, errored };
  }

  if (errored > 0) {
    console.log(`! trailer-tripwire: ${errored} audit error(s) — not blocking, but inspect manually.`);
    return { exitCode: 0, blocked: 0, errored };
  }

  console.log('✓ trailer-tripwire: all staged videos pass.');
  return { exitCode: 0, blocked: 0, errored: 0 };
}
