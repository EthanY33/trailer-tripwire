#!/usr/bin/env bash
# Regenerate demo/demo.txt and demo/demo.svg.
# Requires: `freeze` on PATH (https://github.com/charmbracelet/freeze).
# Windows install: winget install charmbracelet.freeze
# macOS:  brew install charmbracelet/tap/freeze
set -euo pipefail

cd "$(dirname "$0")/.."

DEMO_CMD="trailer-tripwire audit demo/bad-trailer.mp4 --ref demo/google-canvas.profile.json"

# 1. Capture the audit run (as users would see it) into a plain-text snapshot.
{
  printf '$ %s\n\n' "$DEMO_CMD"
  node bin/cli.mjs audit demo/bad-trailer.mp4 --ref demo/google-canvas.profile.json || true
  printf '\n$ echo $?\n2\n'
} > demo/demo.txt

# 2. Render demo/demo.svg from the snapshot.
freeze demo/demo.txt \
  --output demo/demo.svg \
  --theme "github-dark" \
  --window \
  --background "#0d1117" \
  --padding "30,40" \
  --margin "20" \
  --border.radius 8 \
  --shadow.blur 20 \
  --shadow.y 10 \
  --font.family "JetBrains Mono,Consolas,Menlo,monospace" \
  --font.size 13 \
  --line-height 1.3

echo "Wrote demo/demo.txt ($(wc -c < demo/demo.txt) bytes)"
echo "Wrote demo/demo.svg ($(wc -c < demo/demo.svg) bytes)"
