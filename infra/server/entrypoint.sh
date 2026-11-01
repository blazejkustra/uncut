#!/bin/sh
# Xvfb is the export rasteriser's display. A restarted container keeps the old lock in /tmp.
set -eu
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 &
exec /opt/uncut/uncut-server "$@" --host 0.0.0.0
