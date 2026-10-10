# Personal Factory Desktop Linux Port

This is an **unofficial, personal-use packaging project** for Factory Desktop
0.194.0. It packages the official Windows app's bundled JavaScript/UI with a
pinned Linux Electron runtime. It is not built from Factory source, officially
supported by Factory, or an auto-updater.

## Current status

The official Windows installer was extracted as data only. A portable Linux
x64 bundle has been assembled with the pinned Electron 42.11.12 runtime, the
official Droid CLI, and a Linux keytar module. The current source pins CLI
0.238.0 independently of Desktop 0.194.0. Automated
verification passes, including loading keytar under Electron.

### CLI upgrade (RPM release 7)

Release 7 targets the official Linux x64 Droid CLI 0.238.0, the latest npm
release checked on 2026-10-10, while retaining Desktop 0.194.0, Electron
42.11.12, and the integrated-header patches. Both `versions.json` and the
package manifest/lockfile pin the CLI exactly, including its npm integrity.
The global CLI and existing bundles are not changed.

Build and verify the new bundle without replacing earlier outputs:

```sh
npm run clean-install
npm run check
npm test
npm run daemon:check
FACTORY_DIST_NAME=factory-desktop-linux-cli-upgrade npm run build
FACTORY_DIST_NAME=factory-desktop-linux-cli-upgrade npm run verify
FACTORY_DIST_NAME=factory-desktop-linux-cli-upgrade npm run package:rpm
```

The release-7 output is
`dist/rpm/factory-desktop-linux-0.194.0-7.fc44.x86_64.rpm`.
It was built and verified on 2026-10-10: all 26 regression tests and all
12 portable verification checks passed, as did RPM metadata/payload checks
and the checksum. The isolated GUI smoke check was skipped because
`xvfb-run` is unavailable. Authenticated chat and tools remain untested
with this mixed-version bundle; the RPM has not been installed.
See `VALIDATION.md` for build results and remaining desktop/CLI compatibility
checks. The daemon smoke check alone does not establish RPC or chat
compatibility. No RPM installation or model request is part of packaging.

The earlier release-6 personal-use RPM was built and verified on Fedora 44 x86_64 at
`dist/rpm/factory-desktop-linux-0.194.0-6.fc44.x86_64.rpm`, with a sibling
`.sha256` checksum. This does not claim compatibility with other RPM
distributions. The RPM build does not install the artifact or register a
callback handler.

The bundle is **not officially supported**. The user reported a successful
browser-to-desktop sign-in handoff on release 4 and a better appearance with
the integrated header now packaged in release 6. Wayland behavior and
renderer/daemon interaction remain untested. The installer publisher
signature was not verified. See [`VALIDATION.md`](VALIDATION.md) for evidence
and remaining checks. The latest verified portable build in this workspace is
`dist/factory-desktop-linux-cli-upgrade/`.

### Integrated Linux header (current source)

The current patches replace the separate desktop title bar with Electron's
window-control overlay inside the existing app header. They also enable the
app's inline menus and reserve space for minimize, maximize/restore, and close.
Bare Alt or F10 opens the application menu without a separate menu row.
Alt combinations are left alone.

Control icons follow Factory's System, Light, or Dark theme setting through
its existing theme synchronization. The header background uses the app's
theme, and control height follows app zoom. These controls do not inherit
KDE window-decoration styling.

The integrated-header portable bundle was built and passed all 12 verification
checks after the required 25 regression tests passed. Launch it with:

```sh
./dist/factory-desktop-linux-integrated-header/launch.sh
```

The existing release-5 RPM and native-titlebar bundle do not contain this
change. Release 6 packages the verified integrated-header bundle and passed
the RPM metadata, payload, and checksum checks. It has not been installed.
The user confirmed the improved header appearance; theme switching and
window-control behavior have not been fully exercised.

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

The supported build hosts are **Ubuntu 24.04 x86_64** and **Fedora 44
x86_64**. The portable build remains available on both. Fedora 44 is the only
supported RPM packaging host, and the RPM is not claimed to work on other
RPM distributions or to be officially supported by Factory.

The native keytar rebuild requires `libsecret-1-dev` on Ubuntu or
`libsecret-devel` on Fedora. Fedora RPM packaging also uses `rpmbuild`, `rpm`,
`rpm2cpio`, `cpio`, `readelf`, `ldd`, and `desktop-file-validate`.
`npm run preflight` reports missing compilers, libraries, and packaging tools,
and prints any privileged package command for separate approval. No system
packages are installed automatically.

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

On Fedora 44, after the portable bundle is freshly verified, build the RPM:

```sh
npm run package:rpm
```

If using a named distribution directory, verify and package that same
directory, for example:

```sh
FACTORY_DIST_NAME=factory-desktop-linux-cli-upgrade npm run verify
FACTORY_DIST_NAME=factory-desktop-linux-cli-upgrade npm run package:rpm
```

RPM packaging requires the latest verification report to match the selected
bundle's file hashes and permissions. It builds under a new workspace-local
`build/.rpm-workspace-*` directory, preserves all existing outputs, and
refuses to overwrite either output file. The Fedora-only artifact and SHA-256
sidecar are:

```text
dist/rpm/factory-desktop-linux-0.194.0-7.fc44.x86_64.rpm
dist/rpm/factory-desktop-linux-0.194.0-7.fc44.x86_64.rpm.sha256
```

The RPM installs the bundle under `/opt/factory-desktop-linux`, a forwarding
command at `/usr/bin/factory-desktop-linux`, a menu entry, an icon, and a
proprietary/unofficial personal-use notice. It does not set a callback MIME
handler, run the application during installation, change global Droid
configuration, or remove user data during uninstall. The RPM is not to be
published. Building it does not install it on the build host.

RPM release 2 makes the installed bundle directories readable and searchable
by normal users. It also fixes callback registration when the application has
already created `~/.local/state/factory-desktop-linux/`. Release 3 accounts
for Fedora/KDE reporting the newly-created app entry as the effective handler
before its MIME association is explicitly written.
Release 4 rebuilds the bundle with that fix and verifies the packaged desktop
integration scripts against the build manifest to reject stale helpers.
Release 5 uses Fedora's native title bar and window controls instead of
hiding them without replacements.
Release 6 moves theme-aware window controls and menus into the app header,
preserving Alt/F10 menu access and matching control height to app zoom.
Release 7 retains that header and upgrades the independently pinned CLI
from 0.194.0 to 0.238.0.

Electron's sandbox remains enabled. The `chrome-sandbox` helper is installed
without setuid/setgid permissions, so the normal user-namespace sandbox must
work. Preflight only probes user-namespace availability; it is not proof that
Electron starts successfully. RPM packaging runs a non-authenticated,
network-isolated startup check when `unshare`, `dbus-run-session`, `xvfb-run`,
and `xauth` are available. If those tools are absent, the smoke check is
reported as skipped. Login, callback delivery, and interactive Wayland
behavior remain unverified unless separately exercised.

After the RPM is built, these are the manual host-installation commands. They
are provided for a separate, explicit approval and are not run by the build:

```sh
sudo dnf install ./dist/rpm/factory-desktop-linux-0.194.0-7.fc44.x86_64.rpm
factory-desktop-linux
sudo dnf remove factory-desktop-linux
```

The daemon smoke test uses an isolated HOME and local loopback only. It checks
the app's exact daemon startup arguments, WebSocket upgrade, loopback binding,
liveness-pipe shutdown, and clean exit. It sends no authentication, JSON-RPC,
or model request. Passing this test is not proof of app/CLI protocol
compatibility.

The build requires the pinned Factory Desktop 0.194.0 and official Linux x64
Droid CLI 0.238.0 package. Desktop and CLI versions are pinned independently;
this mixed-version combination needs interactive compatibility testing.
The smoke test runs that bundled candidate with an
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
version prompt. After installing RPM release 2 or later, register the callback scheme
for your user account with:

```sh
/opt/factory-desktop-linux/scripts/install-desktop.sh
```

This changes only your user-level desktop association, records the previous
association, and asks before replacing another application's handler. It
never uses `sudo`. To undo a registration:

```sh
/opt/factory-desktop-linux/scripts/rollback-desktop.sh
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
