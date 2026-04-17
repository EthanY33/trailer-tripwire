/* Scan the git staged set for video files and audit each one.
 * Exits non-zero if any have CRITICAL findings — used as a pre-commit gate.
 *
 * Usage (via CLI):
 *   trailer-tripwire check [--dir <path-prefix>] [--ext mp4,webm,mov,mkv]
 *
 * `--dir` restricts to files whose path (forward-slashed) starts with the
 * given prefix. Default: no restriction — scans all staged videos.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { audit } from './audit.mjs';

export function checkStaged({ dir = null, ext = ['mp4', 'webm', 'mov', 'mkv'], cwd = process.cwd() } = {}) {
  const r = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=AM'], {
    cwd, encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error('git diff failed:', r.stderr);
    return { exitCode: 2 };
  }

  const staged = r.stdout.split(/\r?\n/).filter(Boolean);
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
  for (const t of trailers) {
    const abs = path.join(cwd, t);
    if (!fs.existsSync(abs)) {
      console.log(`  · ${t} — missing from working tree, skipping`);
      continue;
    }
    try {
      const result = audit({ videoPath: abs, verbose: false });
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
      console.log(`  ! ${t} — audit error: ${e.message}`);
      errored++;
    }
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
