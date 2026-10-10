# Personal Factory Desktop Linux Port

This is an **unofficial, personal-use packaging project** for Factory Desktop
0.194.0. It packages the official Windows app's bundled JavaScript/UI with a
pinned Linux Electron runtime. It is not built from Factory source, supported
by Factory, an RPM/AppImage, or an auto-updater.

## Current status

The official Windows installer was extracted as data only. A portable Linux
x64 bundle has been assembled with the pinned Electron 42.11.12 runtime, the
official matching Droid CLI 0.194.0, and a Linux keytar module. Automated
verification passes, including loading keytar under Electron.

The bundle is **not officially supported and has not been interactively
validated**. Login, callback delivery, Wayland behavior, and real app/daemon
interaction remain untested. The installer publisher signature was not
verified. See [`VALIDATION.md`](VALIDATION.md) for evidence and remaining
checks. The verified build in this workspace is
`dist/factory-desktop-linux-validated/`.

## Inputs and safety

The pinned installer URL and versions are in `versions.json`. `npm run acquire`
downloads only that installer to `inspection/`, validates its HTTPS response
and archive structure, and writes a provenance record. Its local SHA-256
identifies the downloaded bytes but **does not prove publisher authenticity**.
The current record explicitly says Authenticode verification is unavailable.

`npm run extract` treats the Windows installer and nested archives as data.
It never runs the installer or the embedded Factory package manifest. It
rejects unsafe paths, links, special files, and conflicting app archives, and
preserves the Windows app files separately from the extracted app.
Existing extraction output is never overwritten.

Packaging dependencies and the pinned `@factory/cli-linux-x64` binary are
installed in the lockfile-hash-versioned isolated toolchain by
`npm run clean-install`. Lifecycle scripts are disabled, and the existing root
`node_modules` is not modified. The CLI package is pinned in `package-lock.json`
to the official npm tarball and SHA-512 integrity. The build bundles that
Linux x64 ELF as `resources/bin/droid`; it does not use or modify the host's
global CLI. Electron is fetched separately and checked against the published
SHA-256 in the pinned Electron package before extraction.

## Build prerequisites and commands

The supported build target is **Ubuntu 24.04 x86_64**. Native keytar requires
`libsecret-1-dev`. No system packages are installed automatically; request
separate approval before running the privileged package installation.

In a fresh workspace, after any required prerequisite has been approved and
installed:

```sh
npm run clean-install
npm run check
npm test
npm run acquire
npm run extract
npm run electron:fetch
npm run daemon:check
npm run build
npm run verify
```

The daemon smoke test uses an isolated HOME and local loopback only. It checks
the app's exact daemon startup arguments, WebSocket upgrade, loopback binding,
liveness-pipe shutdown, and clean exit. It sends no authentication, JSON-RPC,
or model request. Passing this test is not proof of app/CLI protocol
compatibility.

The build requires the pinned Factory Desktop 0.194.0 and official Linux x64
Droid CLI 0.194.0 package. The smoke test runs that bundled candidate with an
isolated HOME and records evidence for its exact binary hash. The binary is
copied into the app bundle; no global `droid` command or CLI configuration is
read or changed. The keytar native module is rebuilt against the selected
Electron ABI and unpacked from `app.asar`.

The app declares Electron 42.3.3. This port pins 42.11.12, within the same
major version, and records the runtime archive and executable hashes. The
runtime and app still need full compatibility and interactive testing; no
supported or secure release is claimed.

Build outputs use fresh staging directories and no-replace publication.
Existing extraction, runtime, or distribution directories are preserved, not
overwritten or cleaned automatically.

## Launch and isolated testing

Use `launch.sh` for normal use. It preserves the desktop session and keyring
while placing app data under `~/.local/share/factory-desktop-linux/`.

`launch-test.sh` uses isolated workspace-local HOME and XDG directories and
disables keyring access. Do not put real credentials in test data.

The Secret Service test is separate, uses dummy values only, and requires a
dedicated isolated D-Bus/keyring session. It refuses to run unless its
isolation markers are present. Login, callback delivery, persistence across
restart, local sessions, Wayland behavior, clipboard, external links,
second-instance routing, and renderer/daemon interaction still need
interactive validation. Any model task requires the user's explicit approval.

## Desktop integration and rollback

The external callback handler remains unregistered by default. On Linux, the
port's exact-version patches make callback registration opt-in, hide the
update menu item, disable manual updating, and skip the mandatory minimum
version prompt. Desktop integration is an explicit user action:

```sh
./dist/factory-desktop-linux-validated/scripts/install-desktop.sh
```

It records the current association and asks before replacing another
application's handler. It never uses `sudo`. To undo a registration:

```sh
./dist/factory-desktop-linux-validated/scripts/rollback-desktop.sh
```

Rollback refuses to replace a handler that another action changed after
installation.

## Rebuild and cleanup

Automatic updates remain disabled. Rebuild manually from a newly inspected
official release after updating the pinned versions and validating its
provenance and compatibility. Build and verification accept
`FACTORY_DIST_NAME` to select a new distribution directory; it must be a
simple directory name and an existing output is never overwritten. This
workspace also preserves an earlier failed-verification bundle at
`dist/factory-desktop-linux/`. Inspect generated directories before removing
them; these tools do not clean or overwrite existing `build/` or `dist/`
outputs.
