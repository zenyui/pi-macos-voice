#!/usr/bin/env bash
# Assemble Picrophone.app from the compiled picrophone binary + Info.plist, then ad-hoc sign.
# STT needs a real .app bundle so TCC attributes mic/speech to Picrophone (its own
# responsible process) instead of the launching terminal.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINDIR="$ROOT/packages/picrophone-darwin/bin"
BIN="$BINDIR/picrophone"
APP="$BINDIR/Picrophone.app"
PLIST="$ROOT/native/Info.plist"

[ -x "$BIN" ] || { echo "build-app: $BIN missing; run npm run build:swift first" >&2; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
# Name the executable "Pi Voice": TCC titles the permission prompt from the
# executable filename (the embedded __info_plist makes TCC treat the Mach-O as
# its own app identity, ignoring the bundle's CFBundleDisplayName), so the
# on-disk name must be the user-facing name.
EXEC="Picrophone"
cp "$BIN" "$APP/Contents/MacOS/$EXEC"
chmod +x "$APP/Contents/MacOS/$EXEC"

# Bundle Info.plist needs CFBundleExecutable + a package type on top of the
# usage strings already in native/Info.plist.
/usr/libexec/PlistBuddy -c "Merge $PLIST" \
  -c "Add :CFBundleExecutable string $EXEC" \
  -c "Add :CFBundlePackageType string APPL" \
  -c "Add :CFBundleShortVersionString string $(node -p "require('$ROOT/package.json').version")" \
  -c "Add :LSUIElement bool true" \
  "$APP/Contents/Info.plist" 2>/dev/null || {
    # PlistBuddy can't Merge into a nonexistent file; seed then merge.
    cp "$PLIST" "$APP/Contents/Info.plist"
    /usr/libexec/PlistBuddy \
      -c "Add :CFBundleExecutable string $EXEC" \
      -c "Add :CFBundlePackageType string APPL" \
      -c "Add :CFBundleShortVersionString string $(node -p "require('$ROOT/package.json').version")" \
      -c "Add :LSUIElement bool true" \
      "$APP/Contents/Info.plist"
  }

codesign --force --deep --sign - "$APP"
echo "build-app: $APP"
