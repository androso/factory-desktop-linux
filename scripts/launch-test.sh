#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP="$ROOT/factory-desktop"
ORIGINAL_HOME="${HOME:-}"
TEST_ROOT="$ROOT/.test"

if [ ! -x "$APP" ]; then
  printf '%s\n' "Factory Desktop executable is missing or not executable: $APP" >&2
  exit 1
fi

umask 077
mkdir -p "$TEST_ROOT/home" "$TEST_ROOT/data" "$TEST_ROOT/config" "$TEST_ROOT/cache" "$TEST_ROOT/state" "$TEST_ROOT/factory-home" "$TEST_ROOT/logs"
chmod 700 "$TEST_ROOT" "$TEST_ROOT/home" "$TEST_ROOT/data" "$TEST_ROOT/config" "$TEST_ROOT/cache" "$TEST_ROOT/state" "$TEST_ROOT/factory-home" "$TEST_ROOT/logs"
if [ -z "${XAUTHORITY:-}" ] && [ -n "$ORIGINAL_HOME" ] && [ -r "$ORIGINAL_HOME/.Xauthority" ]; then
  XAUTHORITY="$ORIGINAL_HOME/.Xauthority"
  export XAUTHORITY
fi
export HOME="$TEST_ROOT/home"
export XDG_DATA_HOME="$TEST_ROOT/data"
export XDG_CONFIG_HOME="$TEST_ROOT/config"
export XDG_CACHE_HOME="$TEST_ROOT/cache"
export XDG_STATE_HOME="$TEST_ROOT/state"
export FACTORY_HOME_OVERRIDE="$TEST_ROOT/factory-home"
export FACTORY_LINUX_PROFILE=isolated
export FACTORY_LINUX_HOST_HOME="$TEST_ROOT/home"
export FACTORY_LINUX_HOST_CONFIG_HOME="$TEST_ROOT/config"
export FACTORY_DISABLE_KEYRING=1
unset FACTORY_DESKTOP_RENDERER_URL FACTORY_E2E_DAEMON_HOOKS
unset FACTORY_ENV FACTORY_DEPLOYMENT_ENV FACTORY_RELEASE_CHANNEL
unset NODE_OPTIONS ELECTRON_RUN_AS_NODE ELECTRON_NO_ASAR
export FACTORY_ENV=production
export FACTORY_RELEASE_CHANNEL=production

exec "$APP" \
  "--user-data-dir=$TEST_ROOT/data/electron-user-data" \
  --enable-logging=file \
  "--log-file=$TEST_ROOT/logs/electron.log" \
  "$@"
