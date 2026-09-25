#!/bin/sh
# Build iLive Monitor for this Mac and install it to /Applications.
# Local use only: ad-hoc signed, not notarised (other Macs' Gatekeeper will block it).
set -e
cd "$(dirname "$0")/.."
ARCH=$(uname -m)            # arm64 or x86_64
[ "$ARCH" = "x86_64" ] && ARCH=x64
npm run build
rm -rf release
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --"$ARCH" -c.mac.identity=null -c.mac.notarize=false
APP=$(ls -d release/*/mac*/"iLive Monitor.app")
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
osascript -e 'quit app "iLive Monitor"' 2>/dev/null || true
sleep 1
rm -rf "/Applications/iLive Monitor.app"
ditto "$APP" "/Applications/iLive Monitor.app"
echo "Installed /Applications/iLive Monitor.app"
open "/Applications/iLive Monitor.app"
