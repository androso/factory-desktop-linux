#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP="$ROOT/factory-desktop"
PROFILE="${FACTORY_LINUX_PROFILE:-isolated}"
case "${1:-}" in
  --factory-profile=*) PROFILE=${1#--factory-profile=}; shift ;;
esac
case "$PROFILE" in
  isolated|shared) ;;
  *) printf '%s\n' "Unknown Factory profile: $PROFILE (expected isolated or shared)." >&2; exit 2 ;;
esac

PORT_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/factory-desktop-linux"
PORT_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/factory-desktop-linux"
PORT_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/factory-desktop-linux"
PORT_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/factory-desktop-linux"
UPDATE_STATE="$PORT_STATE/updater"
UPDATE_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/factory-desktop-linux/updater"

if [ ! -x "$APP" ]; then
  printf '%s\n' "Factory Desktop executable is missing or not executable: $APP" >&2
  exit 1
fi

umask 077
mkdir -p "$PORT_DATA/logs" "$PORT_CONFIG" "$PORT_CACHE" "$PORT_STATE"
chmod 700 "$PORT_DATA" "$PORT_DATA/logs" "$PORT_CONFIG" "$PORT_CACHE" "$PORT_STATE"
unset FACTORY_DISABLE_KEYRING
unset FACTORY_DESKTOP_RENDERER_URL FACTORY_E2E_DAEMON_HOOKS
unset FACTORY_ENV FACTORY_DEPLOYMENT_ENV FACTORY_RELEASE_CHANNEL
unset NODE_OPTIONS ELECTRON_RUN_AS_NODE ELECTRON_NO_ASAR
export FACTORY_LINUX_PROFILE="$PROFILE"
export FACTORY_LINUX_HOST_HOME="$HOME"
export FACTORY_LINUX_HOST_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
USER_DATA="$PORT_DATA/user-data"
if [ "$PROFILE" = shared ]; then
  export FACTORY_HOME_OVERRIDE="$HOME"
  USER_DATA="$PORT_DATA/user-data-shared"
else
  export FACTORY_HOME_OVERRIDE="$PORT_DATA/factory-home"
  mkdir -p "$FACTORY_HOME_OVERRIDE" "$PORT_DATA/xdg-data"
  chmod 700 "$FACTORY_HOME_OVERRIDE" "$PORT_DATA/xdg-data"
  export XDG_DATA_HOME="$PORT_DATA/xdg-data"
  export XDG_CONFIG_HOME="$PORT_CONFIG"
  export XDG_CACHE_HOME="$PORT_CACHE"
  export XDG_STATE_HOME="$PORT_STATE"
fi
export FACTORY_ENV=production
export FACTORY_RELEASE_CHANNEL=production
export FACTORY_UPDATE_STATE_HOME="$UPDATE_STATE"
export FACTORY_UPDATE_CACHE_HOME="$UPDATE_CACHE"
mkdir -p "$UPDATE_STATE" "$UPDATE_CACHE"
chmod 700 "$UPDATE_STATE" "$UPDATE_CACHE"

set -- "--user-data-dir=$USER_DATA" \
  --enable-logging=file \
  "--log-file=$PORT_DATA/logs/electron.log" \
  "$@"

if [ -x "$ROOT/updater/bin/node" ] && [ -r "$ROOT/updater/recipes/scripts/factory-update-manager.mjs" ] &&
   [ -x /usr/bin/flock ]; then
  exec 9>"$UPDATE_STATE/install.lock"
  /usr/bin/flock -s 9
  set +e
  "$APP" "$@"
  app_status=$?
  set -e
  /usr/bin/flock -u 9

  set +e
  /usr/bin/factory-update-manager after-app-exit
  update_status=$?
  set -e
  if [ "$update_status" -eq 10 ]; then
    /usr/bin/flock -s 9
    set +e
    "$APP" "$@"
    app_status=$?
    set -e
    /usr/bin/flock -u 9
  fi
  exit "$app_status"
fi

exec "$APP" "$@"
