# Changelog

All notable changes to trailer-tripwire.

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
