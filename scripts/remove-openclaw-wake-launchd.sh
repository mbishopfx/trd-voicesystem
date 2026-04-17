#!/usr/bin/env bash
set -euo pipefail
PLIST_PATH="$HOME/Library/LaunchAgents/com.trd.openclaw-wake.plist"
launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"
echo "Removed: $PLIST_PATH"
