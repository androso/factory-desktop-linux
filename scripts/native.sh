#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "${1:-}" = bootstrap ]; then
  # This entrypoint is an explicit request to install Fedora build prerequisites.
  . /etc/os-release
  if [ "$ID" != fedora ] || [ "$VERSION_ID" != 44 ] || [ "$(uname -m)" != x86_64 ]; then
    printf '%s\n' 'Native installation supports Fedora 44 x86_64 only.' >&2
    exit 1
  fi
  if [ "$(id -u)" = 0 ]; then
    printf '%s\n' 'Run as your normal user, not root.' >&2
    exit 1
  fi
  sudo dnf install -y nodejs npm git make gcc gcc-c++ python3 \
    pkgconf-pkg-config libsecret-devel rpm-build rpm cpio binutils \
    desktop-file-utils util-linux dbus-tools zip xorg-x11-server-Xvfb xorg-x11-xauth
  shift
  set -- install "$@"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v flock >/dev/null 2>&1; then
  printf '%s\n' 'Install nodejs and util-linux, or run make bootstrap-native.' >&2
  exit 1
fi
if [ "$(id -u)" = 0 ]; then
  printf '%s\n' 'Run as your normal user. Only dnf runs through sudo.' >&2
  exit 1
fi
mkdir -p "$ROOT/build/native"
# Kernel-owned locking releases automatically on exit, including interruption.
exec flock -n -E 75 "$ROOT/build/native/workflow.lock" \
  node "$ROOT/scripts/native-cli.mjs" "$@"
