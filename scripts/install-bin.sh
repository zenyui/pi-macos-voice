#!/usr/bin/env bash
# Merge the per-arch release builds into one universal (arm64 + x86_64) binary
# and drop it in the darwin platform package. Per-arch builds work with the
# Command Line Tools; the combined `--arch a --arch b` invocation needs full
# Xcode (xcbuild), so we build each arch separately and lipo them here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/packages/picrophone-darwin/bin"
ARM="$(swift build --package-path "$ROOT/native" -c release --arch arm64 --show-bin-path)/picrophone"
X64="$(swift build --package-path "$ROOT/native" -c release --arch x86_64 --show-bin-path)/picrophone"

for f in "$ARM" "$X64"; do
  [ -x "$f" ] || { echo "install-bin: $f missing; run npm run build:swift first" >&2; exit 1; }
done

mkdir -p "$OUT"
lipo -create "$ARM" "$X64" -output "$OUT/picrophone"
chmod +x "$OUT/picrophone"
codesign --force --sign - "$OUT/picrophone"
echo "install-bin: $OUT/picrophone ($(lipo -archs "$OUT/picrophone"))"
