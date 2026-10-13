#!/bin/sh
# The container's start: the login key from AUTHORIZED_KEY, a virtual display for Electron, then sshd.
set -eu
if [ -z "${AUTHORIZED_KEY:-}" ]; then
  echo "AUTHORIZED_KEY is not set" >&2
  exit 1
fi
printf '%s\n' "$AUTHORIZED_KEY" > /home/uncut/.ssh/authorized_keys
chown uncut:uncut /home/uncut/.ssh/authorized_keys
chmod 600 /home/uncut/.ssh/authorized_keys
unset AUTHORIZED_KEY
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 &
exec /usr/sbin/sshd -D -e
