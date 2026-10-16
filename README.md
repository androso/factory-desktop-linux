# Personal Factory Desktop Linux Port

This is an **unofficial, personal-use packaging project** for Factory Desktop
0.194.0. It packages the official Windows app's bundled JavaScript/UI with a
pinned Linux Electron runtime. It is not built from Factory source or
officially supported by Factory. Portable builds remain manual-only. Managed
Fedora RPM and Ubuntu 26.04 DEB packages include a policy-gated updater that
builds a verified local package candidate and requires user authorization
before installation.

## Ubuntu 26.04 installation and updates

On **Ubuntu 26.04 x86_64**, clone this repository and run:

```sh
make bootstrap-native
```

This explicitly installs build prerequisites through `sudo apt-get`, then
builds, tests, verifies, packages, and installs the managed DEB. Run it as your
normal user, not with `sudo make`. If the prerequisites and pinned Node.js
runtime are already installed, use `make install-native`. The same workflow is
available as `npm run bootstrap:native` and `npm run install:native`.
The Ubuntu archive's Node.js/npm versions may not match the updater pins; if
they do not, preflight stops with the required versions. Use only a verified
Node.js 24.19.0 and npm 11.17.0 runtime before retrying.

Ubuntu 24.04 remains supported for portable builds only. It does not support
the managed DEB workflow. `make deb` builds a DEB without installing it.
Ubuntu package output is written to `dist/deb/` and is never overwritten.

The updater uses `pkexec` and `dpkg` only after validating the candidate. It
does not download dependencies or run package maintainer scripts during an
automatic update. A release that changes the privileged helper or adds
dependencies must be installed through the normal managed workflow after
review.

Preflight reports AppArmor's unprivileged-user-namespace restriction when
present. No system-wide security setting is changed and Electron's sandbox is
never disabled. A successful graphical Electron startup on Ubuntu 26.04 still
needs confirmation in a disposable graphical session; preflight and DEB
metadata tests do not establish that.

## Fedora installation and updates

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
artifact by filename or modification time. The selected manual or managed
build mode is part of the fingerprint, so an updater-enabled RPM uses a separate
verified workspace rather than reusing the manual-only `make build-app` output.
During the initial repository workflow, only package-manager commands run with
privileges. No login, model request,
global CLI change, or callback registration is performed. Installing the
managed RPM migrates existing managed artifacts into private user state and
enables the per-user update timer; use `make updater-disable` to opt out.

Update from a clean, trusted checkout:

```sh
make update-native
```

This runs `git pull --ff-only`, reloads the updated workflow, and builds/installs
the versions pinned by that checkout. Dirty or untracked source changes block
the pull; use `make install-native` to build your local changes without pulling.
The managed RPM can also discover a newer official Desktop release and build it
locally. Each candidate must pass the pinned build, compatibility patches,
verification, and RPM checks before the app offers it. Electron and Droid stay
at their repository pins.

Other commands:

```sh
make build-app       # Build and verify a portable app, without installing
make rpm             # Build and verify an RPM, without installing
make status          # Show exact managed artifacts and the installed RPM
make rollback        # Install the immediately previous managed RPM
make recover         # Reconcile an interrupted or cancelled installation
make updater-status  # Show updater policy and candidate status
make updater-check   # Check the official LATEST endpoint now
make updater-install # Install a verified candidate with authorization
make updater-rollback
make updater-enable  # Enable per-user background checks
make updater-disable # Disable per-user background checks
```

Updater-enabled controls and background checks are available from managed
Fedora RPM and Ubuntu DEB packages. The portable app and packages built without
`PACKAGE_WITH_UPDATER=1` remain manual-only. Background checks run as the
logged-in user, download only from `downloads.factory.ai`, and never install
without `pkexec` authorization. A background install does not launch the app.
The timer does not refresh Factory account policy while the app is closed.
Checks fail closed when the last policy sync is older than five minutes; open
Factory Desktop to refresh it. This is an updater-session policy gate, not a
system-wide administrative restriction. Its per-user policy cache is not
tamper-resistant; deployments needing enforced organization policy must enforce
it outside this user-level updater.
The app's explicit update action closes the app, requests authorization, then
relaunches only after a verified successful install. Closing or cancelling the
quit leaves the candidate staged.

The updater follows Factory's hosted-services, air-gap, and cached organization
update policy. Restricted policy blocks updater release checks and installs.
`make updater-disable` stops the timer and automatic startup checks without
removing a staged candidate. The opt-out survives later managed installs.
`make updater-enable` enables background checks again. If graphical
authorization is unavailable, open Factory Desktop to refresh policy, then use
`make updater-install` in a terminal. Automatic installation fails closed if a
candidate changes the privileged helper or adds package dependencies; review and
install such a release through the normal managed workflow instead.

Installation and rollback refuse to replace the app while a Factory Desktop
process owned by your user is running. Close the app, then rerun the command;
the ready package is retained. Also ensure other users are not running it.
Successful installation checks the installed build manifest and package files.
Same-version recipe changes reinstall; older versions use a package-manager
downgrade. Rollback blocks that exact rejected artifact from being

The repository workflow keeps its ready, installed, previous, and pending
transaction records in `build/native/state.json`. The updater stores its own
state, candidate packages, and build workspaces under the user's XDG state/cache
directories. During migration it copies verified artifacts and preserves the
source state. A cancelled or interrupted package transaction requires `make recover`
before retrying. Recovery never guesses about an
ambiguous package state or runs a second package transaction. Inspect the
package manager's status and package verification output if it reports ambiguity.
A kernel-owned lock prevents concurrent workflows and releases on process exit.

Rollback becomes available after two successful managed installations. An
interrupted legacy transaction must be recovered before its state can be
migrated. Do not delete managed state if you need rollback or recovery records.
Failed build workspaces are retained for diagnosis and can
consume significant disk space; inspect exact paths before removing them.
The existing lower-level `npm run build`, `verify`, `package:rpm`, and
`package:deb` commands remain available.

## Current status

The official Windows installer was extracted as data only. A portable Linux
x64 bundle has been assembled with the pinned Electron 42.11.12 runtime, the
official Droid CLI, and a Linux keytar module. The current source pins CLI
0.240.1 independently of Desktop 0.194.0. Automated
verification passes, including loading keytar under Electron.

### Argon CLI upgrade (RPM release 8, manual-update mode)

The source pins the official Linux x64 Droid CLI 0.240.1, checked on
2026-10-13, including Google's Argon (`gemini-4-argon`). The verified bundle
is `dist/factory-desktop-linux-argon/`; the Fedora package is
`dist/rpm/factory-desktop-linux-0.194.0-8.fc44.x86_64.rpm`.
This package retains manual updates and does not enable the managed updater.
All 69 tests and 12 portable checks passed. The GUI smoke check was skipped
because `xvfb-run` is unavailable; authenticated model selection is unverified.
The installed release-7 package is unchanged until this RPM is installed.

Close Factory Desktop before installing the update:

```sh
sudo dnf install ./dist/rpm/factory-desktop-linux-0.194.0-8.fc44.x86_64.rpm
```

### Ubuntu 26.04 managed DEB support (source only)

The source now targets Ubuntu 26.04 x86_64 for managed DEB packaging,
installation, rollback, recovery, and policy-gated updates. Ubuntu 24.04 remains
portable-build-only. The Ubuntu package backend and archive validator have
regression coverage, but no DEB has yet been built, installed, or exercised in
a Ubuntu 26.04 VM. In particular, graphical Electron startup, AppArmor
user-namespace behavior, `pkexec`, systemd user timers, and a real dpkg
interruption/recovery remain unvalidated. Do not treat source-level tests as
proof of end-to-end Ubuntu support.

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

### Managed updater (source RPM release 8, not yet built)

The checked-in source adds a Linux-only update manager for the managed Fedora
RPM. It checks Factory's HTTPS `LATEST` endpoint, validates same-origin
redirects, rebuilds candidates from the official installer, and stages only
verified RPMs. Installation uses the fixed root-owned helper through `pkexec`;
the helper rejects scripts and triggers, unsafe paths or modes, changed helper
bytes, and new RPM dependencies. A per-user timer is enabled on first managed
installation unless background checks were explicitly disabled. That opt-out
survives later installs. Five-minute policy freshness gates release checks and
installation.

The app's managed update action uses a one-time, expiring handoff and relaunches
only after a verified installation or safe cancellation. Portable builds remain
manual-only. Source RPM release 8 has not been built or installed as part of
this change; the last packaged artifact is release 7 above.

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

The supported build hosts are **Ubuntu 24.04 x86_64**, **Ubuntu 26.04
x86_64**, and **Fedora 44 x86_64**. Portable builds remain available on all
three. Native `.deb` packaging and installation target Ubuntu 26.04 only;
RPM packaging and installation target Fedora 44 only. This project does not
claim compatibility with other Ubuntu or RPM-based distributions or official
Factory support.

The native keytar rebuild requires `libsecret-1-dev` on Ubuntu or
`libsecret-devel` on Fedora. Ubuntu 26.04 DEB packaging uses `dpkg-deb`,
`dpkg-query`, `dpkg-shlibdeps`, `readelf`, and `desktop-file-validate`.
Fedora RPM packaging also uses `rpmbuild`, `rpm`, `rpm2cpio`, `cpio`,
`readelf`, `ldd`, and `desktop-file-validate`.
`npm run preflight` reports missing compilers, libraries, and packaging tools,
checks the exact managed-updater Node.js/npm pins, and prints any privileged
package command for separate approval. The managed package requires Node.js
24.19.0 and npm 11.17.0. No system packages are installed automatically.

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

On Ubuntu 26.04, after the portable bundle is freshly verified, build the DEB:

```sh
npm run package:deb
```

The DEB contains no maintainer scripts. It is built and verified with
`dpkg-deb`, and any runtime dependencies are derived from the staged ELF
payload. The verified `amd64` package and SHA-256 sidecar are written under
`dist/deb/`; existing output files are preserved.

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
Droid CLI 0.240.1 package. Desktop and CLI versions are pinned independently;
this mixed-version combination needs interactive compatibility testing.
The smoke test runs that bundled candidate with an
isolated HOME and records evidence for its exact binary hash. The binary is
copied into the app bundle; no global `droid` command or CLI configuration is
read or changed. The keytar native module is rebuilt against the selected
Electron ABI and unpacked from `app.asar`.

CLI 0.240.1 includes Google's Argon model (`gemini-4-argon`). The GUI reads
available models from its bundled daemon, not the global terminal CLI.
Rebuild and reinstall the desktop bundle to pick up this CLI update, then
restart the app. Models remain subject to account and organization policy.

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

### Official-app parity: profiles and terminal CLI

The desktop uses its pinned bundled `resources/bin/droid` daemon, just like
the official Windows/macOS app. It does not substitute the `droid` found on
your terminal's `PATH`. The official interactive login-shell loader supplies
development-tool paths. Linux preserves the launcher's HOME, XDG directories,
selected Factory profile, and Electron safety overrides when merging that
environment; shell startup files can still add tool paths and other variables.

The older desktop catalog is supplemented with built-in models returned by
the bundled daemon, including Argon when available to the signed-in account.
New-chat, existing-session, and connected automation selectors retain these
models without forcing preview flags or enabling disabled models. Existing
organization, air-gap, and custom-model controls remain in place. Updating
terminal Droid alone does not update the desktop's bundled CLI or renderer.

The default **shared** profile uses the normal user `~/.factory`
configuration, like the official Windows/macOS app. The desktop and terminal
Droid therefore share one host identity (`~/.factory/host.json`), so sessions
started from the terminal are grouped under **Local** instead of
**Unregistered Computer**. To keep using the separate
`~/.local/share/factory-desktop-linux/factory-home/.factory` configuration:

```sh
factory-desktop-linux --factory-profile=isolated
# Or, for a portable build:
./dist/factory-desktop-linux-parity/launch.sh --factory-profile=isolated
```

`FACTORY_LINUX_PROFILE=isolated` selects the same mode. A leading
`--factory-profile=isolated` or `--factory-profile=shared` overrides that
environment default. The application-menu launcher uses shared mode unless
its environment explicitly selects isolated mode.

The isolated profile has its own host identity. A computer registered from
that profile does not match terminal Droid sessions. After switching an
existing install to shared mode, remove the old registration
(`FACTORY_HOME_OVERRIDE=~/.local/share/factory-desktop-linux/factory-home droid computer remove`
or **Settings → Droid Computers**) so the desktop can register this machine
under its host name again.

Shared mode preserves the host XDG environment and uses a separate Electron
user-data directory, so it cannot silently attach to an isolated-profile
window. It reads and can update the existing user `.factory` configuration
through normal app operations. It never copies, merges, or migrates profiles.
Existing isolated sessions and configuration remain where they were; GUI-only
preferences and authentication are not guaranteed to transfer between profiles.

The existing **Install 'droid' Command...** menu keeps the official sign-in,
air-gap, organization-policy, and installation-prompt flow. On Linux it
installs a verified executable copy into the real `~/.local/bin`, regardless
of desktop profile. The terminal command uses normal terminal configuration,
not an implicit desktop-profile override. If that directory is absent from
`PATH`, the menu updates the real Bash, Zsh (`ZDOTDIR` supported), Fish (host
`XDG_CONFIG_HOME` supported), or fallback `.profile` configuration.

Installation refuses to replace an existing file, symlink (including a broken
one), or install record. A private `.factory-desktop-droid.json` sidecar records
the installed executable's checksum and file identity. The uninstall menu only
removes that unchanged, recorded copy; independently installed, replaced, or
auto-updated terminal CLIs are left alone. PATH additions remain after uninstall,
as with the official app. No terminal CLI installation or shell configuration
change happens merely by building or packaging the app.

These changes require a newly built bundle. Existing installed release-8 files
are not patched in place.

Older RPMs contain a root-only `runtime-manifest.json`. If that is the sole
unreadable-checksum result from `rpm -V`, native installation requests sudo
authorization to verify the entire installed package before continuing.
Changed checksums, other verification failures, or cancelled authorization
still block installation. New bundles ship this non-secret metadata as `0644`,
so normal-user RPM verification can read it. Do not change installed file
permissions by hand to work around the guard.

`launch-test.sh` uses isolated workspace-local HOME and XDG directories and
disables keyring access. It also pins CLI-install home/config paths to the test
profile even if the invoking environment selects shared mode. Do not put real
credentials in test data.

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
