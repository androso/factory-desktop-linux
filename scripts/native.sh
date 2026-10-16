#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "${1:-}" = bootstrap ]; then
  # This entrypoint is an explicit request to install native build prerequisites.
  . /etc/os-release
  if [ "$(uname -m)" != x86_64 ] ||
    { [ "$ID" != fedora ] || [ "$VERSION_ID" != 44 ]; } &&
    { [ "$ID" != ubuntu ] || [ "$VERSION_ID" != 26.04 ]; }; then
    printf '%s\n' 'Native installation supports Fedora 44 or Ubuntu 26.04 x86_64 only.' >&2
    exit 1
  fi
  if [ "$(id -u)" = 0 ]; then
    printf '%s\n' 'Run as your normal user, not root.' >&2
    exit 1
  fi
  if [ "$ID" = fedora ]; then
    sudo dnf install -y nodejs npm git make gcc gcc-c++ python3 \
      pkgconf-pkg-config libsecret-devel rpm-build rpm cpio binutils \
      desktop-file-utils util-linux dbus-tools zip xorg-x11-server-Xvfb xorg-x11-xauth
  else
    sudo apt-get update
    sudo apt-get install -y nodejs npm git make build-essential python3 \
      pkg-config libsecret-1-dev dpkg-dev binutils desktop-file-utils \
      util-linux dbus-x11 zip xvfb xauth
  fi
  shift
  set -- install "$@"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v flock >/dev/null 2>&1; then
  printf '%s\n' 'Install Node.js and util-linux, or run make bootstrap-native.' >&2
  exit 1
fi
if [ "$(id -u)" = 0 ]; then
  printf '%s\n' 'Run as your normal user. Only package-manager commands run through sudo.' >&2
  exit 1
fi
mkdir -p "$ROOT/build/native"
# Kernel-owned locking releases automatically on exit, including interruption.
exec flock -n -E 75 "$ROOT/build/native/workflow.lock" \
  node "$ROOT/scripts/native-cli.mjs" "$@"
