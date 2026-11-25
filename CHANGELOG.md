# Changelog

All notable changes to trailer-tripwire.

## [Unreleased]

**Security**

- The pre-commit hook now runs `npx --no -- trailer-tripwire check`. Where the package is not installed (a fresh linked worktree, a removed `node_modules`) the commit fails instead of downloading and running whatever npm serves under that name. Re-run `install-hooks` to update an existing hook.
- git, ffprobe and yt-dlp are started by the absolute path found on `PATH`, skipping empty, relative and current-directory entries, so a repository containing its own `git.exe` or `ffprobe.exe` no longer has it run by the hook. On Windows the CLI also sets `NoDefaultCurrentDirectoryInExePath`.
- `FFMPEG_BIN` set to a program name is resolved through `PATH` the same way. A name that is not on `PATH` is reported as a missing binary.
- `audit --ref` rejects a reference profile whose scene threshold is not a number between 0 and 1, instead of putting it into the ffmpeg filter graph.

**Fixed**

- `check` now fails closed. A staged video that cannot be audited (corrupt or truncated, no container duration, an ffmpeg pass that fails or is killed, or no ffmpeg binary) blocks the commit with exit 2 and a one-line reason per file. Before, these were counted as warnings and the commit went through. A missing ffmpeg binary is reported once up front.
- `check` audits the staged version of each video, resolved from the repository root. Running it from a subdirectory, deleting a file after `git add`, or re-exporting without `git add` no longer lets a video skip the audit. Videos with non-ASCII names and videos moved into scope with `git mv` are now audited.
- `check --dir` is read as a directory relative to the repository root. `./brand/trailers/` and absolute paths now match, `brand/trailers` no longer also takes in `brand/trailers-raw/`, a directory outside the repository exits 2, and a run with nothing in scope prints one skipping line.
- `check` ends in exit 2 with the one-line reason from the OS or git when it cannot create or delete its temp files or find the repository root, instead of throwing or saying it is not in a git repository.
- The fade-to-black CRITICAL fires only when the share is above 40%. Exactly 40%, which is what the shipped Google Canvas reference records, is a WARN.
- The audio dynamics check measures the RMS spread over audible buckets only (at or above -50 dBFS) and ignores the short leftover frame at the end. Flat audio such as a drone that used to pass is now flagged, in the checklist and in the reference comparison.
- The audio peak check reads the real sample peak, not the loudest bucket's RMS. Audio clipped at full scale now triggers the peak WARN.
- `install-hooks` rewrites only its own marked block in the pre-commit hook. Re-running it keeps hand-merged lines and other tripwire gates, converts hooks written by earlier installers without losing a gate, and leaves an unrelated hook untouched. It warns when the hook ends in an unconditional `exit` that would stop the block from running, and keeps indented commands of its own, with a warning, instead of removing them.
- `ingest --threshold` rejects a value that is not a number between 0 and 1, exiting 2 before downloading or writing a profile. Before, `abc` produced a profile with a null threshold and exit 0.

## [1.0.0] - 2026-09-28

First tagged release. The 0.1.0 commands and checklist are unchanged.

**Security**

- `install-hooks` single-quote-escapes `--dir` in the generated pre-commit hook and rejects newlines and null bytes in it.
- Downloads accept only http(s) URLs. Video analysis rejects paths that start with `-` and protocol URIs.

**Fixed**

- Metadata probing works when no ffprobe is installed: it reads the stream summary from `ffmpeg -i` instead.

**Tests**

- Integration tests run real ffmpeg audits. When `demo/bad-trailer.mp4` is absent they synthesize a slideshow fixture with the bundled ffmpeg. CI runs on Ubuntu and Windows with Node 18, 20 and 22.

## [0.1.0] — initial release

Catch AI-default patterns in video trailers before they ship.

**Commands**

- `ingest` — download/read a reference video; produce a `reference-profile/v1` JSON with shot distribution, fade windows, palette over time, and audio RMS curve.
- `audit` — evaluate a video against an absolute checklist and (optionally) against an ingested reference. Exits `2` on any CRITICAL finding.
- `check` — pre-commit gate; audits any staged video files and exits non-zero if any have CRITICAL findings. Scope with `--dir <prefix>`.
- `install-hooks` — install a `# trailer-tripwire:v1`-marked pre-commit hook that runs `check` on every commit.

**Heuristics**

| Severity | Check | Threshold |
|---|---|---|
| CRITICAL | fade-to-black fraction of cuts | ≥ 40% |
| CRITICAL | audio RMS stdev | < 3 dB |
| WARN | long black windows (>1.5s) | > 2 |
| WARN | audio peak dBFS | > −1 |
| WARN | median shot length | < 0.4s or > 15s |
| WARN | silent ratio below −50dBFS | > 30% |
| NOTE | distinct palette hue families | < 4 |

**Calibration source:** empirically tuned against three human-made corporate launch films (Google Canvas, Google Gemini era, NVIDIA OpenClaw) vs one AI-generated indie studio sizzle. Calibration is one signal among many — fork and tune `src/audit.mjs` thresholds if your target vibe differs.

**Known limitations:** see README.
