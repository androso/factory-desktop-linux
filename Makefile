SHELL := /bin/sh
.DEFAULT_GOAL := help
.PHONY: help bootstrap-native build-app rpm deb package install install-native update-native status rollback recover

help:
	@printf '%s\n' \
	  'Ubuntu 24.04 or newer, and Fedora 44, x86_64 local personal-use builds' \
	  '  make bootstrap-native  Install dependencies, build, verify, and install' \
	  '  make build-app         Build and verify without installing' \
	  '  make deb               Build a verified .deb without installing (Ubuntu)' \
	  '  make rpm               Build a verified RPM without installing (Fedora)' \
	  '  make install-native    Build, verify, package, and install with apt or dnf' \
	  '  make update-native     Fast-forward a clean checkout, then build/install' \
	  '  make status            Show managed artifacts and installed package' \
	  '  make rollback          Reinstall the previous managed package' \
	  '  make recover           Reconcile an interrupted installation'

bootstrap-native:
	sh ./scripts/native.sh bootstrap

build-app:
	sh ./scripts/native.sh build

deb rpm package:
	sh ./scripts/native.sh package

install install-native:
	sh ./scripts/native.sh install

update-native:
	sh ./scripts/native.sh update

status:
	sh ./scripts/native.sh status

rollback:
	sh ./scripts/native.sh rollback

recover:
	sh ./scripts/native.sh recover
