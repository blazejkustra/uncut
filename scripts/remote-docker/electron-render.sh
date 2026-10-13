#!/bin/sh
# UNCUT_RENDER_BIN for a Linux server: Electron on the container's virtual display. No sandbox:
# Docker doesn't give the user namespaces Chromium's sandbox needs.
DISPLAY="${DISPLAY:-:99}" exec /opt/electron/electron --no-sandbox "$@"
