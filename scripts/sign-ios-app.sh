#!/bin/bash
set -euo pipefail
APP="$1"; ENTITLEMENTS="$2"
ID=$(security find-identity -v -p codesigning | grep "Apple Development" | head -1 | awk '{print $2}')
shopt -s nullglob
for f in "$APP"/Frameworks/*.framework "$APP"/Frameworks/*.dylib; do
  codesign --force --sign "$ID" --timestamp=none "$f" >/dev/null 2>&1
done
codesign --force --sign "$ID" --timestamp=none --entitlements "$ENTITLEMENTS" "$APP" 2>&1 | tail -1
codesign --verify --deep --strict "$APP" && echo "signature verifies"
codesign -d --entitlements - "$APP" 2>/dev/null | grep -c "application-identifier" || true
