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
export FACTORY_HOME_OVERRIDE="${FACTORY_HOME_OVERRIDE:-$HOME}"
export FACTORY_ENV=production
export FACTORY_RELEASE_CHANNEL=production
HOST_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
HOST_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
HOST_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
HOST_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"

export XDG_DATA_DIRS="$HOST_DATA_HOME:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
export XDG_DATA_HOME="$PORT_DATA/xdg-data"
for MIME_FILE in "$HOST_CONFIG_HOME/mimeapps.list" "$HOST_CONFIG_HOME/"*-mimeapps.list; do
  if [ -f "$MIME_FILE" ]; then
    ln -sfn "$MIME_FILE" "$PORT_CONFIG/$(basename -- "$MIME_FILE")"
  fi
done
export XDG_CONFIG_HOME="$PORT_CONFIG"
export XDG_CACHE_HOME="$PORT_CACHE"
export XDG_STATE_HOME="$PORT_STATE"
mkdir -p "$XDG_DATA_HOME"
chmod 700 "$XDG_DATA_HOME"

# The isolated XDG directories above hold the app's own state. Links the app
# opens must still land in the user's real desktop, so hand the host
# environment back through a wrapper on PATH. A Chromium-family browser
# derives its profile from XDG_CONFIG_HOME, so without this a link starts a
# second, signed-out instance under the isolated config instead of opening in
# the user's running browser.
HOST_XDG_OPEN="$(command -v xdg-open || true)"
if [ -n "$HOST_XDG_OPEN" ] && [ "$HOST_XDG_OPEN" != "$PORT_DATA/bin/xdg-open" ]; then
  mkdir -p "$PORT_DATA/bin"
  cat >"$PORT_DATA/bin/xdg-open" <<EOF
#!/bin/sh
export XDG_CONFIG_HOME='$HOST_CONFIG_HOME'
export XDG_DATA_HOME='$HOST_DATA_HOME'
export XDG_CACHE_HOME='$HOST_CACHE_HOME'
export XDG_STATE_HOME='$HOST_STATE_HOME'
exec '$HOST_XDG_OPEN' "\$@"
EOF
  chmod 700 "$PORT_DATA/bin/xdg-open"
  export PATH="$PORT_DATA/bin:$PATH"
fi

set -- "--user-data-dir=$PORT_DATA/user-data" \
  --enable-logging=file \
  "--log-file=$PORT_DATA/logs/electron.log" \
  "$@"
exec "$APP" "$@"
