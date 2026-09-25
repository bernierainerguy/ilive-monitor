#!/usr/bin/env bash
# Build, sign, notarise and publish iLive Monitor to whiteleyevents.co.uk.
# Follows ~/Developer/wesc/docs/releasing-to-whiteleyevents.md (the shared Whiteley Events process):
#   Apple Silicon DMG only · Developer ID + hardened runtime · app and DMG
#   notarised and stapled · uploaded via the site's software API · old versions pruned.
#
# Usage:
#   npm run release:site              # build, sign, notarise, upload, prune
#   npm run release:site -- --build-only   # everything except the upload
#
# Needs (not in git):
#   .env with WELM_APP_USER / WELM_APP_PASSWORD   (website application password)
#   Developer ID Application certificate in the login keychain
#   notarytool keychain profile (default WESC_NOTARY)
# The site lists this product as key "weim", "Whiteley Events A&H iLive Monitor" (wp-admin → Software → Products).
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD_ONLY=0
[ "${1:-}" = "--build-only" ] && BUILD_ONLY=1

# Azure credentials never belong in a Mac build: verbose native-module logging prints the environment.
unset AZURE_CLIENT_SECRET AZURE_CLIENT_ID AZURE_TENANT_ID

# One release at a time.
LOCK=".ilive-monitor-release.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "ERROR: another release is running (remove $LOCK if it crashed)." >&2
  exit 1
fi
trap 'rm -rf "$LOCK"' EXIT

TEAM_ID="T57Q5FRCB6"
IDENTITY_HASH="${APPLE_SIGNING_IDENTITY_HASH:-E08DE52E8B6FB53ED78BFBF5979ABC7DF75B08CB}"
NOTARY_PROFILE="${APPLE_KEYCHAIN_PROFILE:-WESC_NOTARY}"
PRODUCT="weim"
VERSION="$(node -p "require('./package.json').version")"
DMG="release/${VERSION}/WEIM-${VERSION}-arm64.dmg"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

say "iLive Monitor ${VERSION} → whiteleyevents.co.uk$([ $BUILD_ONLY = 1 ] && echo ' (build only)')"

# --- preflight -----------------------------------------------------------------
[ -z "$(git status --porcelain)" ] || die "uncommitted changes; commit first so the build matches a commit."
git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null || die "v${VERSION} isn't tagged. Cut it first (npm run release:minor / :patch)."
[ "$(git rev-parse HEAD)" = "$(git rev-parse "v${VERSION}^{commit}")" ] || die "HEAD isn't v${VERSION}. Publish tagged releases only."
[ "$(uname -m)" = "arm64" ] || die "build on an Apple Silicon Mac."
if [ $BUILD_ONLY = 0 ] && [ ! -f .env ]; then
  echo "WARNING: no .env (WELM_APP_USER / WELM_APP_PASSWORD): building and notarising, but not uploading."
  BUILD_ONLY=1
fi
python3 -c 'import reportlab' 2>/dev/null || die "python3 reportlab missing (needed for the legal PDFs): pip3 install reportlab"
IDENTITIES="$(security find-identity -v -p codesigning 2>&1 || true)"
grep -q "$IDENTITY_HASH" <<<"$IDENTITIES" \
  || die "Developer ID certificate ${IDENTITY_HASH} not in the login keychain."

# notarytool's credential lives in the data-protection keychain, unreadable while the Mac is locked:
# wait for an unlock (up to 5 min) rather than failing a release part-way.
wait_for_notary() {
  local tries=0
  until xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ $tries -ge 20 ] && die "notary profile '${NOTARY_PROFILE}' not usable after 5 min (create it with: xcrun notarytool store-credentials ${NOTARY_PROFILE})."
    [ $tries = 1 ] && echo "Waiting for the notary credential (is the Mac locked?)…"
    sleep 15
  done
}
wait_for_notary

# --- test and build ---------------------------------------------------------------
say "Running CI (typecheck, tests, coverage, build, e2e)"
npm run ci

say "Building the legal PDFs (EULA, privacy notice, third-party licences)"
LEGAL_PDFS=(legal/WEIM-EULA.pdf legal/WEIM-Privacy-Notice.pdf legal/WEIM-Third-Party-Licences.pdf)
rm -f "${LEGAL_PDFS[@]}"
python3 scripts/build-legal-pdfs.py
for f in "${LEGAL_PDFS[@]}"; do [ -s "$f" ] || die "$f was not produced."; done

say "Packaging, signing and notarising the app"
rm -rf "release/${VERSION}"
# codesign rejects resource forks / Finder info ("detritus"): strip macOS metadata first.
xattr -cr out node_modules/electron/dist 2>/dev/null || true
find . -name '.DS_Store' -not -path './node_modules/*' -delete 2>/dev/null || true
APPLE_KEYCHAIN_PROFILE="$NOTARY_PROFILE" CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --mac dmg --arm64 --publish never -c.mac.identity="$IDENTITY_HASH"
[ -f "$DMG" ] || die "expected $DMG was not produced."

APP="$(ls -d "release/${VERSION}"/mac-arm64/*.app)"
codesign --verify --deep --strict --verbose=2 "$APP"
# Captured first: with pipefail, `grep -q` quitting early can SIGPIPE codesign and fail a correctly signed app.
SIGNED_BY="$(codesign -dv --verbose=2 "$APP" 2>&1 || true)"
grep -q "TeamIdentifier=${TEAM_ID}" <<<"$SIGNED_BY" || die "app is not signed by team ${TEAM_ID}."
xcrun stapler validate "$APP"

say "Launching the packaged app (the artefact itself is what gets tested)"
node scripts/smoke-packaged.mjs "$APP" "$VERSION"

say "Signing, notarising and stapling the DMG"
codesign --force --timestamp --sign "$IDENTITY_HASH" "$DMG"
codesign --verify --verbose=2 "$DMG"
wait_for_notary
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple -v "$DMG"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature -vvv "$DMG"

if [ $BUILD_ONLY = 1 ]; then
  say "Build only: $DMG is signed, notarised and ready. Nothing uploaded."
  exit 0
fi

# --- publish -----------------------------------------------------------------------
# Nothing has touched the live site until now: the DMG exists, launched, and is notarised.
# The legal PDFs go to the product's DOCS folder (the upload script routes .pdf there).
UPLOADS=("$DMG" "${LEGAL_PDFS[@]}")
say "Uploading to whiteleyevents.co.uk (chunked)"
WHE_UPLOAD_PRODUCT="$PRODUCT" WHE_UPLOAD_ALLOW_CHUNKS=1 WHE_UPLOAD_CHUNK_SIZE_MB=4 \
  node scripts/upload-to-site.cjs "${UPLOADS[@]}"

# Prune last, after every upload succeeded. The keep-list is built from the upload list so they can't drift.
say "Pruning older versions"
KEEP=()
for f in "${UPLOADS[@]}"; do KEEP+=(--keep "$f"); done
WHE_UPLOAD_PRODUCT="$PRODUCT" node scripts/cleanup-old-versions.cjs --prefix "WEIM" --prefix "iLive-Monitor" --prefix "iLive Monitor" "${KEEP[@]}"

say "Checking the update feed"
FEED="$(curl -fsS "https://whiteleyevents.co.uk/welm-api.php?action=latest&product=${PRODUCT}")"
# The shape installed copies read (see ~/Developer/wesc-update-checks.md): data.version, and the
# macos-arm installer that was just uploaded.
LIVE="$(node -e 'const d=JSON.parse(process.argv[1]).data||{};console.log(d.version||"")' "$FEED")"
[ "$LIVE" = "$VERSION" ] || die "the site's feed reports '${LIVE:-nothing}', not ${VERSION}."
# The feed's filename is a folder path (".../MAC/WEIM-x-arm64.dmg"): compare its last part.
LIVE_DMG="$(node -e 'const d=JSON.parse(process.argv[1]).data||{};console.log((((d.platforms||{})["macos-arm"]||{}).filename||"").split("/").pop())' "$FEED")"
[ "$LIVE_DMG" = "$(basename "$DMG")" ] || die "the feed's macos-arm installer is '${LIVE_DMG:-missing}', not $(basename "$DMG"); installed copies would only be offered the download page."
say "Published iLive Monitor ${VERSION}. Installed copies will offer the update."
