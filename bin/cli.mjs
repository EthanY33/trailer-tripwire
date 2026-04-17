#!/usr/bin/env node
/* trailer-tripwire CLI entry point.
 *
 * Subcommands:
 *   ingest <url-or-path> [--name <slug>] [--out <dir>] [--threshold <n>]
 *   audit  <video> [--ref <profile.json>] [--out <report.md>]
 *   check  [--dir <prefix>] [--ext mp4,webm,mov,mkv]
 *   install-hooks [--dir <prefix>]
 *   help
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ingest } from '../src/ingest.mjs';
import { audit } from '../src/audit.mjs';
import { checkStaged } from '../src/check-staged.mjs';
import { installHooks } from '../src/install-hooks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a === '--version' || a === '-v') { args.version = true; continue; }
    if (a.startsWith('--')) { args[a.slice(2)] = argv[++i]; continue; }
    args._.push(a);
  }
  return args;
}

const USAGE = `trailer-tripwire — catch AI-default patterns in video trailers

Usage:
  trailer-tripwire <command> [options]

Commands:
  ingest <url-or-path> [--name <slug>] [--out <dir>] [--threshold <n>]
      Download/read a reference video, extract a structural profile.
      Writes <out>/<slug>.profile.json (default <out>: ./content-refs)

  audit <video> [--ref <profile.json>] [--out <report.md>]
      Evaluate a video against absolute thresholds + optional reference.
      Exits 2 if any CRITICAL findings, 0 otherwise.

  check [--dir <prefix>] [--ext mp4,webm,mov,mkv]
      Audit any video files in the git staged set. Used as a pre-commit
      gate. Exits 1 if any CRITICAL findings.

  install-hooks [--dir <prefix>]
      Install a pre-commit hook that runs \`check\` on every commit.
      --dir scopes the check to files under that path prefix.

Examples:
  trailer-tripwire ingest https://youtube.com/watch?v=abc --name corporate-launch
  trailer-tripwire audit out/trailer.mp4 --ref content-refs/corporate-launch.profile.json
  trailer-tripwire install-hooks --dir brand/trailers/
`;

async function main() {
  const raw = process.argv.slice(2);
  if (raw[0] === '--version' || raw[0] === '-v') { console.log(pkg.version); return 0; }
  const [cmd, ...rest] = raw;
  const args = parseArgs(rest);
  if (args.version) { console.log(pkg.version); return 0; }
  if (args.help && !cmd) { console.log(USAGE); return 0; }

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;

    case '--version':
    case '-v':
    case 'version':
      console.log(pkg.version);
      return 0;

    case 'ingest': {
      if (args.help) { console.log(USAGE); return 0; }
      await ingest({
        input: args._[0],
        name: args.name,
        outDir: args.out,
        threshold: args.threshold ? parseFloat(args.threshold) : 0.15,
      });
      return 0;
    }

    case 'audit': {
      if (args.help) { console.log(USAGE); return 0; }
      const result = audit({
        videoPath: args._[0],
        refPath: args.ref || null,
        outPath: args.out || null,
      });
      return result.hasCritical ? 2 : 0;
    }

    case 'check': {
      const ext = args.ext ? args.ext.split(',').map(s => s.trim()) : undefined;
      const { exitCode } = checkStaged({ dir: args.dir || null, ext });
      return exitCode;
    }

    case 'install-hooks': {
      const { ok } = installHooks({ dir: args.dir || null });
      return ok ? 0 : 1;
    }

    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(USAGE);
      return 1;
  }
}

main().then(code => process.exit(code || 0)).catch(e => {
  console.error(e.message || e);
  process.exit(2);
});
