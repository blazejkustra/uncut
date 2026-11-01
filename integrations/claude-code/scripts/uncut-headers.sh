#!/bin/sh
# Prints the header Claude Code connects to Uncut with. Uncut writes the token when the user turns on
# Settings, App, Outside agents. UNCUT_DATA_DIR points at another install's data folder.
dir="${UNCUT_DATA_DIR:-$HOME/Library/Application Support/Uncut}"
file="$dir/external-mcp-token"
if [ ! -r "$file" ]; then
  echo "Turn on Outside agents in Uncut's Settings, under App." >&2
  exit 1
fi
printf '{"Authorization":"Bearer %s"}\n' "$(cat "$file")"
