# CLAUDE.md — trailer-tripwire project memory

Node 18+ CLI, MIT, **v0.1.0**. Catches AI-default patterns in video trailers before they ship. Eldest sibling of the three "tripwire" tools (`screenshot-tripwire`, `copy-tripwire`).

## Commands

```
trailer-tripwire ingest <url-or-path> --name <ref>   # produce reference profile JSON
trailer-tripwire audit <file>                        # absolute checklist
trailer-tripwire audit <file> --ref <profile.json>   # + delta vs reference
trailer-tripwire check [--dir <prefix>] [--ext mp4]  # scan staged
trailer-tripwire install-hooks [--dir <prefix>]      # pre-commit gate
tt audit <file>                                      # short alias
```

`audit` exits 2 on any CRITICAL finding.

## Dependencies

- Node 18+. `ffmpeg-static` is bundled.
- `yt-dlp` needed for YouTube ingest only. Looks for it at `%TMP%/yt-dlp.exe` (Windows) or `/tmp/yt-dlp` (Unix). Not a system-PATH lookup.

## Heuristic thresholds

| Severity | Check | Threshold |
|---|---|---|
| CRITICAL | fade-to-black fraction of cuts | ≥ 40% |
| CRITICAL | audio RMS stdev | < 3 dB |
| WARN | long black windows (>1.5s) | > 2 |
| WARN | audio peak dBFS | > −1 |
| WARN | median shot length | < 0.4s or > 15s |
| WARN | silent ratio below −50 dBFS | > 30% |
| NOTE | distinct palette hue families | < 4 |

Thresholds live in `src/audit.mjs` as plain `if` branches. **Calibration is corporate-launch-aesthetic** (Google Canvas, Gemini era, NVIDIA OpenClaw). Action / music-video / art-film vibes will misfire — fork and tune, don't tighten in main.

## Pre-commit hook contract (load-bearing)

Marker: `# trailer-tripwire:v1`. Idempotent. **Composes** with `# screenshot-tripwire:v1` and `# copy-tripwire:v1`. Refuses to overwrite unrelated hooks. **Don't break this contract** — the siblings rely on it.

## Known limitations (documented, accepted — don't "fix")

- Procedural audio with sharp SFX accents (UI ticks, explosions) passes the RMS-stdev check.
- ffmpeg's scene detector misses dissolves on same-framed content.
- Palette hue detection is coarse (first 2 hex chars as bucket — can't distinguish teal from navy).
- YouTube ingest depends on yt-dlp; if yt-dlp's CLI surface changes, update the binary.

## What it does NOT measure

Taste. Story structure. Typography (OCR on frames is too unreliable for v1). Music composition. Narrative coherence. **It's a tripwire against patterns; it does not replace an editor.**

## Demo

`demo/demo.svg` is regenerated via `bash demo/regen.sh` against a real AI-slop sizzle reel and the Google Canvas launch film as reference.

## Why

Built after Ethan tried to fix an AI-generated sizzle trailer for goneIdle and found iteration only stacked more defaults. The tool exists to fail the build before AI-slop video patterns reach Steam.
