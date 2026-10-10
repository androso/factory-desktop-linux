#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP="$ROOT/factory-desktop"
PORT_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/factory-desktop-linux"
PORT_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/factory-desktop-linux"
PORT_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/factory-desktop-linux"
PORT_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/factory-desktop-linux"

if [ ! -x "$APP" ]; then
  printf '%s\n' "Factory Desktop executable is missing or not executable: $APP" >&2
  exit 1
fi

umask 077
mkdir -p "$PORT_DATA/logs" "$PORT_CONFIG" "$PORT_CACHE" "$PORT_STATE" "$PORT_DATA/factory-home"
chmod 700 "$PORT_DATA" "$PORT_DATA/logs" "$PORT_CONFIG" "$PORT_CACHE" "$PORT_STATE" "$PORT_DATA/factory-home"
unset FACTORY_DISABLE_KEYRING
unset FACTORY_DESKTOP_RENDERER_URL FACTORY_E2E_DAEMON_HOOKS
unset FACTORY_ENV FACTORY_DEPLOYMENT_ENV FACTORY_RELEASE_CHANNEL
unset NODE_OPTIONS ELECTRON_RUN_AS_NODE ELECTRON_NO_ASAR
export FACTORY_HOME_OVERRIDE="$PORT_DATA/factory-home"
export FACTORY_ENV=production
export FACTORY_RELEASE_CHANNEL=production
export XDG_DATA_HOME="$PORT_DATA/xdg-data"
export XDG_CONFIG_HOME="$PORT_CONFIG"
export XDG_CACHE_HOME="$PORT_CACHE"
export XDG_STATE_HOME="$PORT_STATE"
mkdir -p "$XDG_DATA_HOME"
chmod 700 "$XDG_DATA_HOME"

set -- "--user-data-dir=$PORT_DATA/user-data" \
  --enable-logging=file \
  "--log-file=$PORT_DATA/logs/electron.log" \
  "$@"
exec "$APP" "$@"
