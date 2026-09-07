#!/usr/bin/env sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
executable="$project_dir/release/electron/linux-unpacked/tiki-taka"
if [ ! -x "$executable" ]; then
  echo "Packaged desktop game not found. Run: npm run electron:pack" >&2
  exit 1
fi
sandbox_helper="$project_dir/release/electron/linux-unpacked/chrome-sandbox"
if [ -e "$sandbox_helper" ] && [ ! -u "$sandbox_helper" ]; then
  echo "Warning: $sandbox_helper is not setuid-root." >&2
  echo "Launching through Steam may abort with a zygote FATAL error and leave an unkillable process." >&2
  echo "Fix it with:" >&2
  echo "  sudo chown root:root $sandbox_helper" >&2
  echo "  sudo chmod 4755 $sandbox_helper" >&2
  echo "See docs/STEAM-TESTING.md. Continuing anyway." >&2
fi

cd "$(dirname -- "$executable")"
unset ELECTRON_RUN_AS_NODE
exec "$executable" "$@"
