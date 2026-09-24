# trailer-tripwire

Node 18+ CLI, MIT, v0.1.0. Catches AI-default patterns in video trailers so AI-slop fails the build before reaching Steam. Eldest of the tripwire siblings (`screenshot-tripwire`, `copy-tripwire`).

## Commands
```
trailer-tripwire ingest <url-or-path> --name <ref>    # reference profile JSON
trailer-tripwire audit <file> [--ref <profile.json>]  # absolute checklist (+ delta vs reference); exit 2 on any CRITICAL
trailer-tripwire check [--dir <prefix>] [--ext mp4]   # scan staged
trailer-tripwire install-hooks [--dir <prefix>]       # pre-commit gate
tt audit <file>                                       # short alias
node bin/cli.mjs <command>                            # from source; or npm run audit -- <file>
npm test                                              # node --test test/audit.test.mjs
```
- Integration tests run real ffmpeg on `demo/bad-trailer.mp4` (gitignored): slow (~30s+ per audit, 120s timeouts), and pin its documented severities, so threshold changes break them intentionally. Where the fixture is missing (CI, fresh clones) they synthesize a black-gap color slideshow with the bundled ffmpeg instead. CI (`.github/workflows/test.yml`): ubuntu+windows x Node 18/20/22.
- `ffmpeg-static` is bundled. `yt-dlp` is needed for YouTube ingest only: looks for `<tmpdir>/yt-dlp.exe` first (`os.tmpdir()`, always the `.exe` name even off Windows, a code quirk), then `yt-dlp` on PATH.

## Thresholds (`src/audit.mjs`, plain `if` branches)
- CRITICAL: fade-to-black >= 40% of cuts; audio RMS stdev < 3 dB.
- WARN: fade-to-black >= 20% of cuts; RMS stdev < 6 dB; > 2 black windows longer than 1.5s; audio peak > -1 dBFS; median shot < 0.4s; silent ratio (below -50 dBFS) > 30%; resolution < 1080p.
- NOTE: median shot > 15s; no audio track on video > 12s; < 4 distinct palette hue families.

Calibrated to corporate-launch aesthetic (Google Canvas, Gemini era, NVIDIA OpenClaw). Action / music-video / art-film vibes misfire: fork and tune, don't tighten in main.

## Pre-commit hook contract (load-bearing)
Marker `# trailer-tripwire:v1`, written to `.git/hooks/pre-commit` by `src/install-hooks.mjs`. Idempotent for itself but not sibling-aware: refuses on an unrelated hook (merge by hand); on a hook already carrying this marker it overwrites the whole file solo, even if `copy-tripwire`/`screenshot-tripwire` had composed onto it. Composition is one-directional (the siblings' installers detect this marker and compose around it), so install trailer-tripwire's hook first. Don't reword or drop the marker line: siblings grep for it verbatim.

## Known limitations (accepted, don't "fix")
- Procedural audio with sharp SFX accents (UI ticks, explosions) passes the RMS-stdev check.
- ffmpeg's scene detector misses dissolves on same-framed content.
- Palette hue detection is coarse: buckets on the first 3 hex digits (red byte + top nibble of green), can't tell teal from navy.
- YouTube ingest depends on yt-dlp; if its CLI surface changes, update the binary.

Does not measure taste, story structure, typography (frame OCR too unreliable for v1), music composition, or narrative coherence. A tripwire against patterns, not a replacement for an editor.

`demo/demo.svg`: regenerate with `bash demo/regen.sh` (real AI-slop sizzle reel, Google Canvas launch film as reference).
