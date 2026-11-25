# trailer-tripwire

Node 18+ CLI, MIT, v1.0.0. Catches AI-default patterns in video trailers so AI-slop fails the build before reaching Steam. Eldest of the tripwire siblings (`screenshot-tripwire`, `copy-tripwire`).

## Commands
```
trailer-tripwire ingest <url-or-path> --name <ref>    # reference profile JSON
trailer-tripwire audit <file> [--ref <profile.json>]  # absolute checklist (+ delta vs reference); exit 2 on any CRITICAL
trailer-tripwire check [--dir <dir>] [--ext mp4]      # scan staged; exit 1 on CRITICAL, 2 if a video could not be audited
trailer-tripwire install-hooks [--dir <dir>]          # pre-commit gate
tt audit <file>                                       # short alias
node bin/cli.mjs <command>                            # from source; or npm run audit -- <file>
npm test                                              # node --test on the test/*.test.mjs files listed in package.json
```
- Integration tests run real ffmpeg on `demo/bad-trailer.mp4` (gitignored): slow (~30s+ per audit, 120s timeouts), and pin its documented severities, so threshold changes break them intentionally. Where the fixture is missing (CI, fresh clones) they synthesize a black-gap color slideshow with the bundled ffmpeg instead. CI (`.github/workflows/test.yml`): ubuntu+windows x Node 18/20/22.
- `ffmpeg-static` is bundled (ffmpeg only; `probe()` uses a system ffprobe if present, else parses `ffmpeg -i`). `yt-dlp` is needed for YouTube ingest only: looks for `<tmpdir>/yt-dlp.exe` first (`os.tmpdir()`, always the `.exe` name even off Windows, a code quirk), then `yt-dlp` on PATH.
- Never spawn a bare program name. `git`, `ffprobe` and `yt-dlp` go through `resolveBin()` (`src/resolve-bin.mjs`), which walks PATH and skips empty, relative and current-directory entries, because Windows runs a bare name from the current directory first (a repo could ship its own `git.exe`). `bin/cli.mjs` also sets `NoDefaultCurrentDirectoryInExePath=1`. `test/resolve-bin.test.mjs` plants stand-ins to prove it.

## Thresholds (`src/audit.mjs`, plain `if` branches)
- CRITICAL: fade-to-black >= 40% of cuts; audio RMS stdev < 3 dB.
- WARN: fade-to-black >= 20% of cuts; RMS stdev < 6 dB; > 2 black windows longer than 1.5s; audio peak > -1 dBFS; median shot < 0.4s; silent ratio (below -50 dBFS) > 30%; resolution < 1080p.
- NOTE: median shot > 15s; no audio track on video > 12s; < 4 distinct palette hue families.

Calibrated to corporate-launch aesthetic (Google Canvas, Gemini era, NVIDIA OpenClaw). Action / music-video / art-film vibes misfire: fork and tune, don't tighten in main.

## Pre-commit hook contract (load-bearing)
`src/install-hooks.mjs` is a thin wrapper (hook path via `git rev-parse --git-path hooks`, read, write, print); every decision is in the pure `src/hook-compose.mjs`, which `copy-tripwire` and `screenshot-tripwire` ship byte for byte as `lib/hook-compose.mjs`. Change it in all three repos together or not at all.
- Each tool owns one block: `# <name>:v1`, then `npx --no -- <name> check [args] || exit $?`, then `# <name>:v1 end`. `--no` stops npx from downloading a missing tool from the registry, `|| exit $?` fails closed without `set -e`, and there is no `exec` so later blocks still run. Don't reword the `# trailer-tripwire:v1` marker line: it is the public contract.
- `composeHook()` cases, first match wins: no file, fresh file; own block present, rewrite it in place and nothing else; file made only of comments, `set -e` and tripwire commands (every hook the old installers wrote), rewrite as blocks in the order screenshot, trailer, copy, siblings keeping their args; hand-written content with a tripwire marker or command, drop only the own legacy marker and command lines and append the own block (warns if an `exec` line or an unconditional top-level `exit` sits above it, and if an indented own command is left in place); only column-0 command lines count as own commands; no tripwire trace at all, refuse with exit 1 and print the block.
- Any install order and any number of re-runs must leave every gate and every hand-written line in place. `test/hook-compose.test.mjs` proves that for all three tool names, `test/install-hooks.test.mjs` against real git (core.hooksPath, linked worktree, a commit through the hook).

## `check` contract (load-bearing, same rules as the siblings' `check`)
`src/check-staged.mjs`; `test/check-staged.test.mjs` proves each rule against real git with synthesized videos.
- Staged names come from `git diff --cached --name-only -z --diff-filter=ACMR`, split on NUL. Never parse the quoted (non `-z`) form; `R` is what keeps a video moved into scope with `git mv` audited.
- `--dir` is a directory relative to the repo root (an absolute path inside the repo also works), compared after normalising: backslashes to `/`, no leading `./`, one trailing `/`. So `brand/trailers` does not match `brand/trailers-raw/`. Outside the repo is exit 2. Zero staged videos in scope prints one `skipping` line and exits 0.
- Runs every git command from `git rev-parse --show-toplevel`, so it works from a subdirectory. Audits the staged blob, never the working tree file: `git cat-file --filters :0:<path>` (raw `blob` as fallback) written to a temp file under `os.tmpdir()` that keeps the extension and is deleted in a `finally`.
- Fails closed. Exit 1 = CRITICAL findings (wins when both apply). Exit 2 = something could not be audited: unreadable blob, an `audit()` throw (corrupt or durationless video), missing ffmpeg binary (`ffmpeg-static` fetches it in an install script, so `--ignore-scripts` installs have none), git failure or a git child killed by a signal. Never return 0 for a video that was not audited; `bin/cli.mjs` maps a missing exit code to 1.

## Known limitations (accepted, don't "fix")
- Procedural audio with sharp SFX accents (UI ticks, explosions) passes the RMS-stdev check.
- ffmpeg's scene detector misses dissolves on same-framed content.
- Palette hue detection is coarse: buckets on the first 3 hex digits (red byte + top nibble of green), can't tell teal from navy.
- YouTube ingest depends on yt-dlp; if its CLI surface changes, update the binary.

Does not measure taste, story structure, typography (frame OCR too unreliable for v1), music composition, or narrative coherence. A tripwire against patterns, not a replacement for an editor.

`demo/demo.svg`: regenerate with `bash demo/regen.sh` (real AI-slop sizzle reel, Google Canvas launch film as reference).
