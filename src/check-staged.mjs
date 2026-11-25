/* Scan the git staged set for video files and audit each one.
 * Exits non-zero if any have CRITICAL findings — used as a pre-commit gate.
 * Exit codes: 0 pass, 1 CRITICAL findings, 2 a staged video could not be
 * audited (unreadable or corrupt content, missing ffmpeg, git failure).
 *
 * Usage (via CLI):
 *   trailer-tripwire check [--dir <dir>] [--ext mp4,webm,mov,mkv]
 *
 * `--dir` restricts the scan to one directory, given relative to the
 * repository root (an absolute path inside the repository works too).
 * `brand/trailers`, `brand/trailers/` and `./brand/trailers/` are the same
 * scope, and none of them covers `brand/trailers-raw/`. Default: no
 * restriction, all staged videos are scanned.
 *
 * What is audited is the staged content (the blob in the index), because that
 * is what the commit records. The working tree file is never read. Every git
 * command runs from the repository root, so check works from a subdirectory.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import ffmpegPath from 'ffmpeg-static';
import { audit } from './audit.mjs';
import { resolveBin } from './resolve-bin.mjs';

const MAX_BUFFER = 64 * 1024 * 1024;

// Run git without a shell. `git` is the absolute path from resolveBin, never
// the bare name. Returns the spawnSync result.
function runGit(git, cwd, args, opts = {}) {
  return spawnSync(git, args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, ...opts });
}

// One line saying why a git call failed.
function gitFailure(r) {
  if (r.error) return r.error.message;
  if (r.signal) return `git was killed by ${r.signal}`;
  const err = String(r.stderr || '').trim().split(/\r?\n/)[0];
  return err || `git exited with status ${r.status}`;
}

// An error message as one line of bounded length (ffmpeg's can run to many).
function oneLine(message) {
  const flat = String(message).replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat;
}

function realPath(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

// Delete a temp file or directory. Best effort: a leftover in the temp
// directory must not change the verdict.
function remove(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch { /* left for the OS */ }
}

/* Turn `--dir` into the form staged names are compared with: forward
 * slashes, no leading `./`, exactly one trailing slash. Returns '' for the
 * repository root (no restriction) and null for a directory outside the
 * repository, which could never match a staged name. */
export function scopeOf(dir, root) {
  let d = String(dir);
  if (path.isAbsolute(d)) {
    // Compare resolved paths first, so a symlinked or 8.3 spelling of the
    // root still counts as inside. Fall back to the paths as given.
    const candidates = [[realPath(root), realPath(d)], [path.resolve(root), path.resolve(d)]]
      .map(([from, to]) => path.relative(from, to));
    d = candidates.find(rel => !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..') ?? '..';
  }
  d = path.posix.normalize(d.replace(/\\/g, '/')).replace(/\/+$/, '');
  if (d === '' || d === '.') return '';
  if (d === '..' || d.startsWith('../')) return null;
  return `${d}/`;
}

// The gate fails closed: a video it could not look at is never waved through.
function notAudited(count) {
  console.log('');
  console.log(`trailer-tripwire: ${count} staged video file(s) could not be audited, commit blocked.`);
  console.log('  Options:');
  console.log('    1. Fix the cause named above, then `git add` the file again');
  console.log('    2. Bypass: `git commit --no-verify` (use sparingly)');
  return { exitCode: 2, blocked: 0, errored: count };
}

/* Write the staged content of `name` to the file `dest`. git writes straight
 * into the file, so a large video is never held in memory. --filters applies
 * smudge filters (a Git LFS pointer becomes the real video); git that cannot
 * do that falls back to the raw blob. `:0:<path>` is the index entry at stage
 * 0, spelled out so a path that itself starts with `<digit>:` cannot be
 * misread as a stage number. */
function writeStagedBlob(git, root, name, dest) {
  let r;
  for (const how of [['--filters'], ['blob']]) {
    const fd = fs.openSync(dest, 'w');
    try {
      r = runGit(git, root, ['cat-file', ...how, `:0:${name}`], { stdio: ['ignore', fd, 'pipe'] });
    } finally {
      fs.closeSync(fd);
    }
    if (!r.error && r.status === 0) return;
  }
  throw new Error(`cannot read the staged content: ${gitFailure(r)}`);
}

export function checkStaged({ dir = null, ext = ['mp4', 'webm', 'mov', 'mkv'], cwd = process.cwd() } = {}) {
  const git = resolveBin('git', { cwd });
  if (!git) {
    console.error('trailer-tripwire: cannot run git: it was not found on PATH');
    return { exitCode: 2 };
  }

  // git prints staged names relative to the repository root, whatever the
  // current directory is, so everything below runs from that root.
  const top = runGit(git, cwd, ['rev-parse', '--show-toplevel']);
  if (top.error || top.status !== 0) {
    console.error(`trailer-tripwire: cannot find the repository root: ${gitFailure(top)}`);
    return { exitCode: 2 };
  }
  const root = top.stdout.replace(/\r?\n$/, '');

  const scope = dir ? scopeOf(dir, root) : '';
  if (scope === null) {
    console.error(`trailer-tripwire: --dir ${dir} is outside the repository (${root}), so it can never match a staged file.`);
    return { exitCode: 2 };
  }

  // -z: NUL-separated raw names. The default output C-quotes any name with
  // a non-ASCII byte, a quote or a backslash, and a quoted name no longer
  // ends in its extension. ACMR: a rename or copy is listed under its new
  // path, so a video moved into scope with `git mv` is audited too.
  const r = runGit(git, root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
  if (r.error || r.status !== 0) {
    console.error(`trailer-tripwire: git diff --cached failed: ${gitFailure(r)}`);
    return { exitCode: 2 };
  }

  const staged = r.stdout.split('\0').filter(Boolean);
  const extRe = new RegExp(`\\.(${ext.join('|')})$`, 'i');

  const trailers = staged.filter(f => {
    const fwd = f.replace(/\\/g, '/');
    if (!extRe.test(fwd)) return false;
    if (scope && !fwd.startsWith(scope)) return false;
    return true;
  });

  if (!trailers.length) {
    console.log(`trailer-tripwire: no staged video files${scope ? ` under ${scope}` : ''} - skipping`);
    return { exitCode: 0 };
  }

  // ffmpeg-static downloads its binary in an install script, so an install
  // with scripts disabled leaves the package without one. Say that once,
  // instead of one obscure error per file. (FFMPEG_BIN may hold a program
  // name instead of a path; that is left to the PATH lookup.)
  if (!ffmpegPath || (/[\\/]/.test(ffmpegPath) && !fs.existsSync(ffmpegPath))) {
    const where = ffmpegPath || 'ffmpeg-static has no build for this platform';
    console.error(`trailer-tripwire: the ffmpeg binary is missing (${where}). Try \`npm rebuild ffmpeg-static\`.`);
    return notAudited(trailers.length);
  }

  console.log(`→ trailer-tripwire: auditing ${trailers.length} staged video file(s)...`);

  let blocked = 0;
  let errored = 0;
  // ffmpeg needs a file, so each staged blob goes to a temp file that keeps
  // the extension and is deleted again as soon as it has been audited.
  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailer-tripwire-'));
  } catch (e) {
    console.error(`trailer-tripwire: cannot create a temp directory: ${oneLine(e.message)}`);
    return notAudited(trailers.length);
  }
  try {
    for (const [i, t] of trailers.entries()) {
      const suffix = /\.[a-z0-9]+$/i.exec(t);
      const tmp = path.join(tmpDir, `staged-${i}${suffix ? suffix[0].toLowerCase() : ''}`);
      try {
        writeStagedBlob(git, root, t, tmp);
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
        console.log(`  ! ${t}: could not be audited: ${oneLine(String(e.message).split(tmp).join(t))}`);
        errored++;
      } finally {
        remove(tmp);
      }
    }
  } finally {
    remove(tmpDir);
  }

  if (blocked > 0) {
    console.log('');
    console.log(`✗ trailer-tripwire: ${blocked} trailer(s) have CRITICAL findings — commit blocked.`);
    if (errored > 0) console.log(`  ${errored} more could not be audited (see above).`);
    console.log('  Options:');
    console.log('    1. Fix the findings (run `trailer-tripwire audit <file>` for full details)');
    console.log('    2. Bypass: `git commit --no-verify` (use sparingly)');
    return { exitCode: 1, blocked, errored };
  }

  if (errored > 0) return notAudited(errored);

  console.log('✓ trailer-tripwire: all staged videos pass.');
  return { exitCode: 0, blocked: 0, errored: 0 };
}
