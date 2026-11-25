/* Install a git pre-commit hook that runs `trailer-tripwire check`.
 *
 * Usage (via CLI):
 *   trailer-tripwire install-hooks [--dir <dir>]
 *
 * Thin wrapper: resolve the hook path (honours core.hooksPath and linked
 * worktrees), read the file, let composeHook() decide, write, report. What
 * may be rewritten and what must be left alone is decided in
 * hook-compose.mjs, which the sibling tripwires share byte for byte.
 */

import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildBlock, composeHook } from './hook-compose.mjs';

const SELF = 'trailer-tripwire';

/* POSIX single-quote escape: 'foo' -> 'foo', "f'oo" -> 'f'\''oo'.
 * Single-quoted strings in sh do not expand $(...) or backticks, so this is
 * the only safe way to embed an arbitrary --dir value into a hook body.
 * Plain double-quotes still expand $(), so JSON.stringify is not enough. */
function shellSingleQuote(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function checkArgs(dir) {
  if (dir != null && /[\r\n\0]/.test(dir)) {
    throw new Error('--dir may not contain newlines or null bytes');
  }
  return dir ? `--dir ${shellSingleQuote(dir)}` : '';
}

function resolveHooksDir(cwd) {
  const r = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return path.resolve(cwd, r.stdout.trim());
}

const DONE = {
  created: (where) => `installed ${where}`,
  updated: (where) => `updated its block in ${where}`,
  unchanged: (where) => `${where} is already up to date`,
  migrated: (where) => `rewrote ${where} as managed blocks, one per tripwire gate`,
  appended: (where) => `appended its block to ${where}`,
};

export function installHooks({ dir = null, cwd = process.cwd() } = {}) {
  const args = checkArgs(dir);

  const hooksDir = resolveHooksDir(cwd);
  if (!hooksDir) {
    console.error(`${SELF}: not inside a git repository`);
    return { ok: false };
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  const target = path.join(hooksDir, 'pre-commit');
  const where = path.relative(cwd, target) || target;

  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  const { action, text, warnings } = composeHook(existing, SELF, args);

  if (action === 'refused') {
    console.error(`${SELF}: ${target} is an unrelated pre-commit hook, so it was not modified.`);
    console.error('  To run the gate from that hook, add these three lines to it by hand:');
    console.error('');
    for (const line of buildBlock(SELF, args).split('\n')) console.error(`    ${line}`);
    console.error('');
    console.error('  From then on install-hooks rewrites only the lines between those markers.');
    return { ok: false, target, action };
  }

  if (action !== 'unchanged') fs.writeFileSync(target, text);
  try { fs.chmodSync(target, 0o755); } catch { /* windows */ }

  console.log(`${SELF}: ${DONE[action](where)}`);
  if (dir) console.log(`  scoped to: ${dir}`);
  console.log('  Gate runs automatically on git commit. Bypass: git commit --no-verify');
  for (const warning of warnings) console.error(`${SELF}: warning: ${warning}`);
  return { ok: true, target, action };
}
