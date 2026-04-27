#!/usr/bin/env bash
# Build a Node.js-runnable Claude Code from the official bun-compiled npm
# package, on Linux / macOS / Windows-WSL alike.
#
# Pre-reqs: node >= 18, npm. No binutils, no objcopy, no python.
#
# Usage:
#   scripts/build-claude-code.sh [VERSION] [PLATFORM] [OUT_DIR]
#
# Defaults:
#   VERSION  = latest (queried via `npm view`)
#   PLATFORM = auto-detected from `uname` (override with linux-x64 |
#              darwin-arm64 | darwin-x64 | win32-x64)
#   OUT_DIR  = out/<version>-<platform>
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-latest}"
PLATFORM="${2:-auto}"
OUT_DIR="${3:-}"

if [ "$VERSION" = "latest" ]; then
  VERSION="$(npm view @anthropic-ai/claude-code version)"
fi

if [ "$PLATFORM" = "auto" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)   PLATFORM="linux-x64"   ;;
    Darwin-arm64)   PLATFORM="darwin-arm64";;
    Darwin-x86_64)  PLATFORM="darwin-x64"  ;;
    *) echo "[build] cannot auto-detect platform; pass one explicitly" >&2; exit 1 ;;
  esac
fi

OUT_DIR="${OUT_DIR:-$here/out/${VERSION}-${PLATFORM}}"

echo "[build] version=$VERSION platform=$PLATFORM out=$OUT_DIR"
mkdir -p "$OUT_DIR"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
cd "$workdir"

pkg="@anthropic-ai/claude-code-${PLATFORM}@${VERSION}"
echo "[build] fetching $pkg"
tgz="$(npm pack "$pkg" 2>/dev/null | tail -1)"
tar xzf "$tgz"

bin_path="$workdir/package/claude"
[ -f "$bin_path" ] || bin_path="$workdir/package/claude.exe"
[ -f "$bin_path" ] || { echo "[build] ERROR: bin not found in tgz"; exit 1; }

echo "[build] extracting bun payload"
node "$here/scripts/extract.cjs" "$bin_path" "$OUT_DIR" >"$OUT_DIR/_extract.log"
tail -5 "$OUT_DIR/_extract.log"

echo "[build] unwrapping CJS IIFE → cli.js"
node "$here/scripts/unwrap-cjs.cjs" "$OUT_DIR/src/entrypoints/cli.js" "$OUT_DIR/cli.js"

cat > "$OUT_DIR/package.json" <<EOF
{
  "name": "claude-code-extracted",
  "version": "${VERSION}",
  "type": "commonjs",
  "bin": { "claude": "./cli.js" },
  "dependencies": {
    "ws": "*",
    "ajv": "*",
    "ajv-formats": "*",
    "node-fetch": "*",
    "undici": "*",
    "yaml": "*"
  }
}
EOF

echo "[build] installing external deps"
( cd "$OUT_DIR" && npm install --silent )

echo "[build] smoke test: --version"
( cd "$OUT_DIR" && node ./cli.js --version )

echo "[build] done."
echo "  ln -sf '$OUT_DIR/cli.js' ~/.local/bin/claude"
