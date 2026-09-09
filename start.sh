#!/usr/bin/env sh
set -eu
case "$0" in
  */*) script_path=${0%/*} ;;
  *) script_path=. ;;
esac
script_dir=$(CDPATH= cd -- "$script_path" && pwd)
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js is required. Install Node.js 24 and run npm ci first.' >&2
  exit 1
fi
exec node "$script_dir/scripts/start-local.mjs" "$@"
