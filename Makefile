SHELL := /bin/sh
.DEFAULT_GOAL := help
.PHONY: help bootstrap-native build-app rpm deb package install install-native update-native status rollback recover updater-status updater-check updater-install updater-rollback updater-enable updater-disable

help:
	@printf '%s\n' \
	  'Ubuntu 26.04 DEB or Fedora 44 RPM, x86_64 personal-use builds' \
	  '  make bootstrap-native  Install dependencies, build, verify, and install' \
	  '  make build-app         Build and verify without installing' \
	  '  make rpm               Build a verified Fedora RPM without installing' \
	  '  make deb               Build a verified Ubuntu DEB without installing' \
	  '  make install-native    Build, verify, package, and install natively' \
	  '  make update-native     Fast-forward a clean checkout, then build/install' \
	  '  make status            Show managed artifacts and installed package' \
	  '  make rollback          Reinstall the previous managed package' \
	  '  make recover           Reconcile an interrupted installation' \
	  '  make updater-status   Show updater policy and candidate status' \
	  '  make updater-check    Check the Factory LATEST endpoint now' \
	  '  make updater-install  Install the verified candidate with authorization' \
	  '  make updater-rollback Roll back to the previous managed RPM' \
	  '  make updater-enable  Enable per-user background checks' \
	  '  make updater-disable Disable per-user background checks'

bootstrap-native:
	sh ./scripts/native.sh bootstrap

build-app:
	sh ./scripts/native.sh build

rpm:
	FACTORY_PACKAGE_FORMAT=rpm sh ./scripts/native.sh package

package:
	sh ./scripts/native.sh package

deb:
	FACTORY_PACKAGE_FORMAT=deb sh ./scripts/native.sh package

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

updater-status:
	factory-update-manager status

updater-check:
	factory-update-manager check --now

updater-install:
	factory-update-manager install-ready

updater-rollback:
	factory-update-manager rollback

updater-enable:
	factory-update-manager enable

updater-disable:
	factory-update-manager disable
