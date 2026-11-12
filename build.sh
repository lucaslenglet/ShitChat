#!/usr/bin/env bash
# Builds the static site into dist/ (or the directory given as $1):
#   - fetches tailcat at a pinned commit,
#   - compiles its browser package (web/main_js.go) to WebAssembly,
#   - adds ShitChat's own page (web/*).
#
# Requires Go and git. Output is ready for GitHub Pages or any static host.
set -euo pipefail

# Pinned tailcat commit (github.com/tailscale/tailcat). Bump deliberately:
# tailcat makes no API stability promises.
TAILCAT_REPO="https://github.com/tailscale/tailcat.git"
TAILCAT_REF="e00cdde6ff787f801361ff85ed085775c775d4c5"

root="$(cd "$(dirname "$0")" && pwd)"
out="$(realpath -m "${1:-$root/dist}")"
src="$root/.cache/tailcat"

if [ ! -d "$src/.git" ]; then
  git clone --quiet --filter=blob:none "$TAILCAT_REPO" "$src"
fi
if [ "$(git -C "$src" rev-parse HEAD)" != "$TAILCAT_REF" ]; then
  git -C "$src" fetch --quiet origin "$TAILCAT_REF"
  git -C "$src" -c advice.detachedHead=false checkout --quiet "$TAILCAT_REF"
fi

rm -rf "$out"
# tailcat-webdist builds main.wasm (+ .gz/.zst) and copies wasm_exec.js
# plus tailcat's own demo page, which we replace below.
(cd "$src" && go run ./cmd/tailcat-webdist -o "$out")

# Static hosts like GitHub Pages can't negotiate Content-Encoding, so ship
# only the gzipped wasm; app.js decompresses it in the browser.
rm -f "$out/main.wasm" "$out/main.wasm.zst" "$out/index.html" "$out/app.js"
cp "$root"/web/* "$out/"
cp "$src/LICENSE" "$out/LICENSE-tailcat.txt"
touch "$out/.nojekyll"

echo "built $out:"
ls -lh "$out"
