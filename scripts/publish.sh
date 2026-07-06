#!/usr/bin/env bash
# Publish picrophone to npm: the darwin platform package first, then the main
# package (so the optionalDependency version resolves). win32 is intentionally
# skipped until a real Windows binary exists — as an optionalDependency, npm
# silently ignores it not being on the registry.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/packages/picrophone-darwin/bin/picrophone"

# Guard: the darwin package must carry a universal (arm64 + x86_64) binary.
[ -x "$BIN" ] || { echo "publish: $BIN missing — run 'npm run build' first" >&2; exit 1; }
ARCHS="$(lipo -archs "$BIN")"
case "$ARCHS" in
  *arm64*x86_64*|*x86_64*arm64*) : ;;
  *) echo "publish: $BIN is not universal (got: $ARCHS) — run 'npm run build'" >&2; exit 1 ;;
esac

echo "publish: darwin binary is universal ($ARCHS)"
echo "publish: publishing picrophone-darwin…"
( cd "$ROOT/packages/picrophone-darwin" && npm publish --access public )

echo "publish: publishing picrophone (main)…"
( cd "$ROOT" && npm publish --access public )

echo "publish: done."
