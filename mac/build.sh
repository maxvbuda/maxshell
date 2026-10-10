#!/bin/sh
# Builds Sage for Mac without Xcode: SwiftPM compiles it, this script makes
# the .app around it (icon, Info.plist with where maxshell and Node are) and
# installs it in ~/Applications. Run by `sage app`, or directly.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
DEST="${SAGE_APP_DIR:-$HOME/Applications}"
APP="$DEST/Sage.app"
NODE="$(command -v node)"
VERSION="$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$ROOT/package.json")"

cd "$HERE"
swift build -c release --product Sage 2>&1 | grep -Ev '^\[|^Building|^Build complete|^Compiling|^Write|^Planning' || true
BIN="$(swift build -c release --show-bin-path)/Sage"
[ -x "$BIN" ] || { echo "build failed" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT
mkdir -p "$WORK/Sage.app/Contents/MacOS" "$WORK/Sage.app/Contents/Resources"
cp "$BIN" "$WORK/Sage.app/Contents/MacOS/Sage"

# the icon, drawn once and kept next to the sources
ICON="$HERE/.build/AppIcon.icns"
if [ ! -f "$ICON" ] || [ "$HERE/icon.swift" -nt "$ICON" ]; then
  swift "$HERE/icon.swift" "$WORK/icon.png"
  mkdir -p "$WORK/AppIcon.iconset"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$WORK/icon.png" --out "$WORK/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$WORK/icon.png" --out "$WORK/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$WORK/AppIcon.iconset" -o "$ICON"
fi
cp "$ICON" "$WORK/Sage.app/Contents/Resources/AppIcon.icns"

cat > "$WORK/Sage.app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Sage</string>
  <key>CFBundleDisplayName</key><string>Sage</string>
  <key>CFBundleIdentifier</key><string>com.maxshell.sage</string>
  <key>CFBundleExecutable</key><string>Sage</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>MaxshellRoot</key><string>$ROOT</string>
  <key>NodePath</key><string>$NODE</string>
  <key>UserPath</key><string>$PATH</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$WORK/Sage.app" >/dev/null 2>&1 || true
mkdir -p "$DEST"
ditto "$WORK/Sage.app" "$APP" # updates our own build in place
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "$APP"
