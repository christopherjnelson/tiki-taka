#!/usr/bin/env sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
executable="$project_dir/release/electron/linux-unpacked/tiki-taka"
if [ ! -x "$executable" ]; then
  echo "Packaged desktop game not found. Run: npm run electron:pack" >&2
  exit 1
fi
cd "$(dirname -- "$executable")"
unset ELECTRON_RUN_AS_NODE
exec "$executable" "$@"
