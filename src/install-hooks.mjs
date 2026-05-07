/* Install a git pre-commit hook that runs `trailer-tripwire check`.
 *
 * Usage (via CLI):
 *   trailer-tripwire install-hooks [--dir <path-prefix>]
 *
 * Writes a hook shim marked `# trailer-tripwire:v1` to `.git/hooks/pre-commit`
 * (or wherever `git config core.hooksPath` points). Idempotent — replaces
 * an existing trailer-tripwire hook but refuses to clobber unrelated ones.
 */

import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const MARKER = '# trailer-tripwire:v1';

/* POSIX single-quote escape: 'foo' -> 'foo', "f'oo" -> 'f'\''oo'.
 * Single-quoted strings in bash do not expand $(...) or backticks, so this is
 * the only safe way to embed an arbitrary --dir value into a hook body.
 * Plain double-quotes still expand $() — JSON.stringify is not enough. */
function shellSingleQuote(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function buildHookBody({ dir }) {
  if (dir != null && /[\r\n\0]/.test(dir)) {
    throw new Error('--dir may not contain newlines or null bytes');
  }
  const checkCmd = dir
    ? `npx trailer-tripwire check --dir ${shellSingleQuote(dir)}`
    : `npx trailer-tripwire check`;
  return `#!/usr/bin/env bash
${MARKER}
# Auto-installed by: trailer-tripwire install-hooks
# Audits any staged video files for AI-default patterns.
# Bypass with: git commit --no-verify

${checkCmd}
`;
}

function resolveHooksDir(cwd) {
  const r = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('not a git repository (cwd: ' + cwd + ')');
  return path.resolve(cwd, r.stdout.trim());
}

export function installHooks({ dir = null, cwd = process.cwd() } = {}) {
  const hooksDir = resolveHooksDir(cwd);
  fs.mkdirSync(hooksDir, { recursive: true });
  const target = path.join(hooksDir, 'pre-commit');

  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, 'utf8');
    if (!existing.includes(MARKER)) {
      console.error(`✗ ${target} already exists and is not ours.`);
      console.error('  Remove it or merge its contents with the hook body and re-run.');
      console.error(`  Expected marker: ${MARKER}`);
      return { ok: false };
    }
    console.log(`  (replacing existing ${path.relative(cwd, target)})`);
  }

  fs.writeFileSync(target, buildHookBody({ dir }));
  try { fs.chmodSync(target, 0o755); } catch { /* windows */ }

  console.log(`✓ installed ${path.relative(cwd, target)}`);
  if (dir) console.log(`  scoped to: ${dir}`);
  console.log('  Gate runs automatically on git commit. Bypass: git commit --no-verify');
  return { ok: true, target };
}
