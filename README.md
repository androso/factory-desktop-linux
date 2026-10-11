# Personal Factory Desktop Linux Port

This is an **unofficial, personal-use packaging project** for Factory Desktop
0.194.0. It packages the official Windows app's bundled JavaScript/UI with a
pinned Linux Electron runtime. It is not built from Factory source, officially
supported by Factory. Native updates are explicitly requested local rebuilds,
not an upstream auto-updater.

## Easy Ubuntu installation and updates

On **Ubuntu 24.04 or newer x86_64**, clone this repository and run:

```sh
make bootstrap-native
```

This explicitly installs build prerequisites through `sudo apt-get`, then
builds, tests, verifies, packages a `.deb`, and installs it with `apt`. Run it
as your normal user, not with `sudo make`. If Node.js and the build
prerequisites are already installed, use `make install-native`. You can also use
`npm run bootstrap:native` and `npm run install:native`.

For the very first checkout, if `git` or `make` is missing, install them with
`sudo apt-get install git make` before cloning/building.

The managed workflow mirrors Fedora: it builds and verifies a fresh,
source-fingerprinted workspace under `build/native/workspaces/`, reuses a
matching verified `.deb` on repeat installation, and journals ready, installed,
previous, and pending transactions in `build/native/state.json`. Only the
`apt-get`/`dpkg` step runs with privileges. `make update-native`, `make status`,
`make rollback`, and `make recover` behave exactly as the Fedora workflow, using
`apt-get` and `dpkg` in place of `dnf` and `rpm`. To build the `.deb` without
installing it, run `make deb` or `npm run package:deb`.

## Easy Fedora installation and updates

On **Fedora 44 x86_64**, clone this repository and run:

```sh
make bootstrap-native
```

This explicitly installs build prerequisites through `sudo dnf`, then builds,
tests, verifies, packages, and installs Factory Desktop. Run it as your normal
user, not with `sudo make`. If Node.js and the build prerequisites are already
installed, use `make install-native`. You can also use
`npm run bootstrap:native` and `npm run install:native`.

For the very first checkout, if `git` or `make` is missing, install them with
`sudo dnf install git make` before cloning/building.

Builds use fresh, source-fingerprinted workspaces under `build/native/workspaces/`.
Earlier portable bundles and RPMs are never overwritten. The workflow reuses a
matching verified managed RPM on repeat installation; it never selects an
artifact by filename or modification time. `make rpm` also reuses and re-verifies
the portable app from `make build-app`, rather than assembling it again.
Only the package-manager step runs
with privileges. No login, model request, global CLI change, or callback
registration is performed.

Update from a clean, trusted checkout:

```sh
make update-native
```

This runs `git pull --ff-only`, reloads the updated workflow, and builds/installs
the versions pinned by that checkout. Dirty or untracked source changes block
the pull; use `make install-native` to build your local changes without pulling.
This is **not** automatic discovery of the newest Factory release. New upstream
Desktop versions still need inspected inputs, compatible patches, and updated
pins in the repository. Desktop, Electron, and Droid are not upgraded separately
behind your back. There is no background update service.

Other commands:

```sh
make build-app       # Build and verify a portable app, without installing
make deb             # Build and verify a .deb, without installing (Ubuntu)
make rpm             # Build and verify an RPM, without installing (Fedora)
make status          # Show exact managed artifacts and the installed RPM
make rollback        # Install the immediately previous managed RPM
make recover         # Reconcile an interrupted or cancelled installation
```

Installation and rollback refuse to replace the app while a Factory Desktop
process owned by your user is running. Close the app, then rerun the command;
the ready RPM is retained. Also ensure other users are not running it.
Successful installation checks the installed build manifest and `rpm -V`.
Same-version recipe changes use `dnf reinstall`; older versions use
`dnf downgrade`. Rollback blocks that exact rejected artifact from being
immediately installed again. A changed recipe must produce a new candidate.

The workflow keeps its ready, installed, previous, and pending transaction
records in `build/native/state.json`. A cancelled or interrupted `dnf` command
requires `make recover` before retrying. Recovery never guesses about an
ambiguous package state or runs a second package transaction. Inspect
`dnf history` and `rpm -V factory-desktop-linux` if it reports ambiguity.
A kernel-owned lock prevents concurrent workflows and releases on process exit.

Rollback becomes available after two successful managed installations.
An RPM installed before this workflow is not automatically imported as a
rollback artifact. Do not delete `build/native/` if you need its rollback or
recovery records. Failed build workspaces are retained for diagnosis and can
consume significant disk space; inspect exact paths before removing them.
The existing lower-level `npm run build`, `verify`, and `package:rpm` commands
remain available.

## Current status

The official Windows installer was extracted as data only. A portable Linux
x64 bundle has been assembled with the pinned Electron 42.11.12 runtime, the
official Droid CLI, and a Linux keytar module. The current source pins CLI
0.238.0 independently of Desktop 0.194.0. Automated
verification passes, including loading keytar under Electron.

### Ubuntu `.deb` support (this branch)

This branch adds Ubuntu `.deb` packaging plus the matching managed workflow
(`make deb`, `make install-native`, `make update-native`, `make rollback`,
`make recover`) on Ubuntu 24.04 or newer x86_64. Debian packaging reuses the
same verified portable bundle and verification-report gate as the RPM path, and
the native workflow selects `apt-get`/`dpkg` on Ubuntu and `dnf`/`rpm` on
Fedora automatically. The Debian layout, control file, dependency resolution,
`md5sums`, and payload validation are covered by unit tests and a synthetic
`dpkg-deb` build that passed on Ubuntu 26.04 x86_64; the full test suite passed
with the Fedora-only synthetic RPM test skipped because `rpmbuild` is absent.
A full end-to-end `npm run package:deb` against the real Factory bundle, a real
`apt-get install`, and a real `.deb` rollback were not exercised here.

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
installed in the manifest-and-lockfile-hash-versioned isolated toolchain by
`npm run clean-install`. Lifecycle scripts are disabled, and the existing root
`node_modules` is not modified. The CLI package is pinned in `package-lock.json`
to the official npm tarball and SHA-512 integrity. The build bundles that
Linux x64 ELF as `resources/bin/droid`; it does not use or modify the host's
global CLI. Electron is fetched separately and checked against the published
SHA-256 in the pinned Electron package before extraction.

## Build prerequisites and commands

The supported build hosts are **Ubuntu 24.04 or newer x86_64** and **Fedora 44
x86_64**. The portable build remains available on both. Fedora 44 is the only
supported RPM packaging host, and the RPM is not claimed to work on other
RPM distributions. Ubuntu 24.04 or newer x86_64 is the supported `.deb`
packaging host, and the `.deb` is not claimed to work on other Debian-based
distributions or to be officially supported by Factory.

The native keytar rebuild requires `libsecret-1-dev` on Ubuntu or
`libsecret-devel` on Fedora. Ubuntu `.deb` packaging uses `dpkg-deb`, `dpkg`,
`dpkg-query`, `readelf`, `ldd`, and `desktop-file-validate`. Fedora RPM
packaging also uses `rpmbuild`, `rpm`, `rpm2cpio`, `cpio`, `readelf`, `ldd`, and
`desktop-file-validate`.
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

On Ubuntu 24.04 or newer, after the portable bundle is freshly verified, build
the Debian package:

```sh
npm run package:deb
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

Debian packaging uses the same verification-report gate, builds under a new
workspace-local `build/.deb-workspace-*` directory, preserves existing outputs,
and refuses to overwrite either output file. Its artifact and SHA-256 sidecar
are:

```text
dist/deb/factory-desktop-linux_0.194.0-7_amd64.deb
dist/deb/factory-desktop-linux_0.194.0-7_amd64.deb.sha256
```

The RPM installs the bundle under `/opt/factory-desktop-linux`, a forwarding
command at `/usr/bin/factory-desktop-linux`, a menu entry, an icon, and a
proprietary/unofficial personal-use notice. It does not set a callback MIME
handler, run the application during installation, change global Droid
configuration, or remove user data during uninstall. The RPM is not to be
published. Building it does not install it on the build host.

The `.deb` installs the same bundle and layout under
`/opt/factory-desktop-linux`, a forwarding command at
`/usr/bin/factory-desktop-linux`, a menu entry, an icon, and the
proprietary/unofficial personal-use notice at
`/usr/share/doc/factory-desktop-linux/copyright`. Both formats install the menu
entry as `/usr/share/applications/factory.desktop` and the bundled icon as the
real Factory artwork at
`/usr/share/icons/hicolor/256x256/apps/factory-desktop-linux.png`. The entry
name matches the application id the app reports on Wayland, so GNOME binds the
running window to the entry instead of showing a generic icon. The `.deb` adds
no maintainer scripts, so it does not run the application, register a callback
MIME handler, change global Droid configuration, or remove user data during
uninstall. Its `Depends` list is derived from the bundle's external shared
libraries (`readelf`/`ldd` plus `dpkg -S`), and `libsecret-1-0` is always
required for the unpacked keytar module. The `.deb` is not to be published.
Building it does not install it on the build host.

The isolated Electron sandbox smoke check runs only when `unshare`,
`dbus-run-session`, `xvfb-run`, and `xauth` are available. Environments that
forbid user namespaces can explicitly skip this non-authenticated check with
`FACTORY_SKIP_SANDBOX_SMOKE=1`; the report then shows the check as skipped
rather than passing.

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

The launcher keeps Chromium sandboxing enabled. Ubuntu `.deb` packages install
only Electron's `chrome-sandbox` helper as root:root with mode 4755, allowing
startup when Ubuntu restricts unprivileged user namespaces. The portable bundle
and Fedora RPM retain mode 0755 and require usable user namespaces. No global
AppArmor policy is changed. Preflight only probes user-namespace availability;
it is not proof that Electron starts successfully. Packaging
runs a non-authenticated, network-isolated startup check when `unshare`,
`dbus-run-session`, `xvfb-run`, and `xauth` are available. If those tools are
absent, the smoke check is reported as skipped. The launcher links the user's
normal and desktop-specific `mimeapps.list` files into its isolated config home
and preserves access to user-installed desktop entries, so sign-in uses the
selected browser. Normal launches use the CLI's Factory home (including an
explicit `FACTORY_HOME_OVERRIDE`) and existing keyring credentials; Electron's
profile and logs remain separate. Desktop and CLI now share login, logout,
settings, and sessions. `launch-test.sh` still uses disposable credentials. Login,
callback delivery, and interactive Wayland behavior remain unverified unless
separately exercised.

After the RPM is built, these are the manual host-installation commands. They
are provided for a separate, explicit approval and are not run by the build:

```sh
sudo dnf install ./dist/rpm/factory-desktop-linux-0.194.0-7.fc44.x86_64.rpm
factory-desktop-linux
sudo dnf remove factory-desktop-linux
```

On Ubuntu, the equivalent manual `.deb` commands are:

```sh
sudo apt-get install ./dist/deb/factory-desktop-linux_0.194.0-7_amd64.deb
factory-desktop-linux
sudo apt-get remove factory-desktop-linux
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
