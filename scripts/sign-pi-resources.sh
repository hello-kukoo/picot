#!/usr/bin/env bash
#
# Signs the Mach-O binaries embedded under src-tauri/resources/pi/ (the pi
# runtime binary + its native .node addons) with a Developer ID identity.
#
# Tauri's macOS bundler code-signs the .app bundle itself but does not
# deep-sign arbitrary files copied in via tauri.conf.json's `bundle.resources`
# map. Apple's notary service rejects any Mach-O inside the bundle that
# lacks its own Developer ID signature + hardened runtime + secure
# timestamp, so these need to be signed individually before the outer .app
# gets bundled and signed. Signing the outer .app afterwards does not
# disturb signatures already present on nested files.
#
# Runs as part of tauri.conf.json's beforeBuildCommand, so it fires for
# both local Developer-ID builds (scripts/build.sh with
# APPLE_SIGNING_IDENTITY exported) and CI (.github/workflows/release.yml,
# where tauri-action imports the certificate into a keychain before
# invoking `cargo tauri build`, which is what runs this hook).
#
# No-op when APPLE_SIGNING_IDENTITY is unset or ad-hoc ("-"), since ad-hoc
# builds are never notarized and there's nothing to fix.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [ -z "$IDENTITY" ] || [ "$IDENTITY" = "-" ]; then
    exit 0
fi

PI_DIR="$PROJECT_ROOT/src-tauri/resources/pi"
if [ ! -d "$PI_DIR" ]; then
    exit 0
fi

echo "[sign-pi-resources] Signing embedded pi native binaries with: $IDENTITY"

signed_any=0
while IFS= read -r -d '' f; do
    if file "$f" | grep -q "Mach-O"; then
        codesign --force --options runtime --timestamp --sign "$IDENTITY" "$f"
        signed_any=1
    fi
done < <(find "$PI_DIR" -type f -print0)

if [ "$signed_any" = "0" ]; then
    echo "[sign-pi-resources] WARN: no Mach-O binaries found under $PI_DIR"
fi
