#!/usr/bin/env bash
# Package the extension into a Chrome Web Store-ready zip.
# Usage:  ./build.sh          → produces dist/amoa-tv-v<version>.zip
#         ./build.sh --clean  → removes dist/ first
#
# What it does:
#   - Copies all runtime source files into a fresh dist/pkg/
#   - Strips the dev environment selector from popup.html
#   - Removes the dev URL from config.js's ENV_URLS
#   - Zips the result

set -euo pipefail
cd "$(dirname "$0")"

if [[ "${1:-}" == "--clean" ]]; then rm -rf dist; fi
mkdir -p dist

VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
STAGE="dist/pkg"
OUT="dist/amoa-tv-v${VERSION}.zip"

rm -rf "$STAGE"
mkdir -p "$STAGE"

# Ship only the runtime files — no build tooling, docs, git metadata.
for f in manifest.json background.js config.js content.js page.js popup.html popup.js; do
  cp "$f" "$STAGE/"
done

# Include icons if present (added later without touching this script).
[[ -d icons ]] && cp -r icons "$STAGE/"

# --- prod-only strips ---
# 1) Remove the env <div class="row" id="envRow">…</div> block from popup.html.
python3 - "$STAGE/popup.html" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s = re.sub(r'\s*<div class="row" id="envRow">.*?</div>\s*', '\n', s, count=1, flags=re.DOTALL)
open(p, 'w').write(s)
PY

# 2) Drop the dev entry from ENV_URLS in config.js so a stray env=dev in
#    someone's storage falls back to prod instead of localhost.
python3 - "$STAGE/config.js" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s = re.sub(r"  dev:\s*'http://localhost:8000',\s*\n", '', s, count=1)
open(p, 'w').write(s)
PY

# --- zip ---
rm -f "$OUT"
( cd "$STAGE" && zip -qr "../amoa-tv-v${VERSION}.zip" . )

BYTES=$(stat -f %z "$OUT" 2>/dev/null || stat -c %s "$OUT")
printf 'built %s (%d bytes)\n' "$OUT" "$BYTES"
