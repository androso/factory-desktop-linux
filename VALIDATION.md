# Validation report

**Checked:** 2026-10-10
**Result:** The release-7 personal-use RPM and CLI-upgrade portable bundle were
built and verified with Desktop 0.194.0, Droid CLI 0.238.0, and Electron
42.11.12. Release 7 was not installed. Authenticated desktop/CLI compatibility
is still unverified.

## Fedora native installation/update workflow

- Added Make and npm entrypoints for prerequisite bootstrap, verified local
  build/package/install, clean-checkout fast-forward update, status, rollback,
  and interrupted-installation recovery.
- `npm run clean-install`, `npm run check`, `npm run check:native`, and
  `npm test` passed on Fedora 44 x86_64. All 41 regression tests passed.
  New tests cover artifact tampering, RPM identity validation, app-running
  guards, managed rollback, rejected-candidate blocking, interrupted and
  successful simulated installations, recovery, and build reuse.
- `make rpm` passed end to end with the final source, including all 12 portable
  checks and RPM metadata/payload/checksum validation. A second `make rpm`
  reused the exact verified artifact without rebuilding. `make status` reports
  it as ready, not installed by the workflow.
- The final artifact is
  `build/native/workspaces/7ab0499b51f9-18c6bc26-917d-4623-ae2a-6ea72ec5f6f9/dist/rpm/factory-desktop-linux-0.194.0-7.fc44.x86_64.rpm`.
  Its SHA-256 is
  `45253ca0f06562d7cede7c42508b42fa57f8e5c72ffd68a46df11344e72924fc`.
- An earlier full-build attempt exceeded the four-minute execution limit
  during RPM packaging. The final run completed with a longer limit. Earlier
  workspaces and existing artifacts were preserved.
- Toolchain paths now fingerprint both `package.json` and `package-lock.json`,
  so npm command additions do not conflict with earlier isolated toolchains.
  The final root clean-install created
  `build/toolchain-0.238.0-95b46668bff3/`; earlier toolchains remain untouched.
- The isolated GUI smoke check was skipped because `xvfb-run` is unavailable.
  Authentication, interactive compatibility, real privileged installation,
  bootstrap dependency installation, and real package rollback were not run.
  Installation/recovery tests use simulated package-manager calls.
- No existing RPM was replaced, user data changed, callback registered, or
  model request sent. Native updates use pinned recipes from a trusted checkout;
  no background service or automatic upstream-version discovery was enabled.

## Release-7 CLI upgrade

- The latest official npm CLI version checked on 2026-10-10 was 0.238.0.
  `versions.json`, `package.json`, and `package-lock.json` now pin it exactly.
  Desktop remains 0.194.0 and the 11 integrated-header patches are unchanged.
- `npm run clean-install` created
  `build/toolchain-0.238.0-c435bbe8a282/` with lifecycle scripts disabled.
  The root `node_modules`, global CLI, and prior toolchains were not changed.
- `npm run check` and `git diff --check` passed.
- The initial test run failed two obsolete assertions: CLI/Desktop version
  equality and release-6 synthetic RPM metadata. These were updated for the
  independent CLI pin and release 7. The final `npm test` passed all 26 tests,
  including exact CLI pin checks and the synthetic RPM payload test.
- `npm run daemon:check` passed with Droid 0.238.0, isolated HOME, loopback-only
  binding, WebSocket upgrade, and clean liveness-pipe shutdown. This test sent
  no authentication, RPC, or model request.
- `FACTORY_DIST_NAME=factory-desktop-linux-cli-upgrade npm run build` produced
  a fresh portable bundle, and the matching `npm run verify` passed all 12
  checks, including keytar loading under Electron and Droid daemon options.
- The build/verify/package command was cancelled after portable verification.
  No release-7 RPM had been published. Packaging was resumed against that
  verified bundle, preserving earlier outputs.
- `FACTORY_DIST_NAME=factory-desktop-linux-cli-upgrade npm run package:rpm`
  passed bundle fingerprint, metadata, dependency, payload hash, ownership,
  permission, and desktop-entry checks.
- `sha256sum -c` passed. RPM metadata reports
  `factory-desktop-linux 0.194.0-7.fc44 x86_64`. The packaged CLI reports
  `0.238.0`; its binary contains both `gpt-6.1-sol` and `gpt-6-luna` IDs.
  ID presence is not proof of a successful model request.
- The isolated Electron GUI smoke check was skipped because `xvfb-run` is
  unavailable. No sandbox workaround or package installation was applied.
  Login, renderer/daemon RPC, authenticated chat/tools, and Sol/Luna requests
  have not been tested in the new bundle.
- No RPM was installed, callback association changed, or model request sent.

Artifacts:

```text
dist/factory-desktop-linux-cli-upgrade/
dist/rpm/factory-desktop-linux-0.194.0-7.fc44.x86_64.rpm
dist/rpm/factory-desktop-linux-0.194.0-7.fc44.x86_64.rpm.sha256
```

RPM SHA-256:
`3bbe02799aa9fae8558d7cdb8f66179034fd0b4545d37bd25f271ba988e97738`.

Verification report:
`build/verification-report-2026-10-10T12-49-33-594Z.json`.
RPM workspace:
`build/.rpm-workspace-1791644220699-b65d03c4-c67b-407a-8bc6-fdc6cf21544e/`.

## Earlier build results

The Fedora 44 x86_64 portable bundle and release-5 personal-use RPM
were built and verified. The integrated-header portable bundle was also built
and verified, then packaged as the verified release-6 personal-use RPM.
Release 6 was not installed.

## Integrated-header changes

The current source enables the existing Electron title-bar overlay and
renderer header on Linux, including inline menus, overlay space reservation,
app-theme synchronization, and zoom alignment. Bare Alt and F10 open the
application menu; Alt shortcuts do not open it.

This change is not included in the historical release-5 artifacts below.
The user initially requested that the test suite be skipped for this change. The
existing build gate still requires passing regression evidence for the
current source; older test evidence cannot validate these patches.
`npm run check` passed, and every exact patch applied in memory to the pinned
extracted app. Both resulting JavaScript files passed `node --check`; the
extracted app was not modified. `git diff --check` also passed.

The attempted build,
`FACTORY_DIST_NAME=factory-desktop-linux-integrated-header npm run build`,
stopped before assembly because the current-source synthetic test gate was
missing.

The user then approved running the required tests and building. `npm test`
passed all 25 regression tests. The same build command succeeded and produced
`dist/factory-desktop-linux-integrated-header/`.
`FACTORY_DIST_NAME=factory-desktop-linux-integrated-header npm run verify`
passed all 12 checks, recording 11 exact-version patches and successfully
loading keytar under Electron 42.11.12. No callback handler was registered.

The user subsequently confirmed the better integrated-header appearance.
Theme switching, dragging, maximizing, resizing, and Wayland/X11 lifecycle
behavior have not been fully exercised.

## Release-6 integrated-header RPM

- Updated the RPM release and spec to `6.fc44`.
- `node --check scripts/rpm.mjs` passed.
- `node --test tests/rpm.test.mjs` passed all 11 RPM tests, including the
  synthetic metadata and payload test.
- The first packaging attempt exceeded the 240-second command timeout
  without publishing an artifact. A retry with a longer timeout succeeded:
  `FACTORY_DIST_NAME=factory-desktop-linux-integrated-header npm run package:rpm`.
- Packaging verified the portable bundle fingerprint, RPM metadata,
  dependencies, payload hashes, ownership, and permissions.
- `sha256sum -c` passed, and RPM queries confirmed
  `factory-desktop-linux 0.194.0-6.fc44 x86_64`.
- The isolated Electron GUI smoke check was skipped because `xvfb-run`
  is unavailable. No workaround was applied.
- No RPM was installed and no callback association was registered.

Artifacts:

```text
dist/rpm/factory-desktop-linux-0.194.0-6.fc44.x86_64.rpm
dist/rpm/factory-desktop-linux-0.194.0-6.fc44.x86_64.rpm.sha256
```

RPM SHA-256:
`ca4f3c97d1ce3d2dfd087a85b4d922cfbfaa8df6a8b6d3b2b5bd47e435fb5bb6`.

## Fedora 44 build

- `npm run preflight` passes the required-host and dependency checks after
  `libsecret-devel` was installed by the user. `Xvfb` and `xvfb-run` are
  optional and missing.
- `npm run clean-install` reused the lockfile-pinned isolated toolchain with
  lifecycle scripts disabled. No root `node_modules` was used or modified.
- `npm run check` passes. `npm test` passes all 25 regression tests, including
  a synthetic RPM build that checks metadata, dependencies, layout, ownership,
  permissions, desktop validation, payload hashes, and callback registration
  with existing application state.
- Acquired Factory Desktop 0.194.0 over HTTPS: HTTP 200, 282,948,832 bytes,
  SHA-256
  `0a69c32a5dad0f15ad8058bea3da4085dca3f0c7128a492b8a29a54a87169228`.
  The installer executable was not run. Publisher signature verification is
  unavailable; the hash establishes byte identity only.
- Extracted the installer as data. The extraction manifest records 545
  `app.asar` entries, one unpacked sidecar file, and 77 preserved Windows app
  files.
- Fetched Electron 42.11.12 Linux x64 and matched its archive SHA-256 against
  the pinned package checksum:
  `1f17c115389c6395ce4b19b29ee2ec4be2208257514d61e269f1c0a7323bd45d`.
  The executable SHA-256 is
  `2cee1949cc7f949abe973a9d1cae0210b5a525d1b3666f61787bca01d75552e3`.
- The Droid 0.194.0 daemon smoke test passed in an isolated HOME. It bound
  only to IPv4 loopback, completed a WebSocket upgrade, and shut down cleanly.
  No authentication, JSON-RPC, or model request was sent.
- Built `dist/factory-desktop-linux-native-titlebar/` with Factory 0.194.0,
  Electron 42.11.12, and Droid 0.194.0. `npm run verify` passed all 12 checks,
  including ELF architecture, native keytar packaging, source and runtime
  hashes, shared-library resolution, daemon options, and Electron keytar load.
  Keytar reported `KEYTAR_LOAD_OK electron=42.11.12 modules=146`.
- The sixth exact-version patch sets Linux to use the native window title bar,
  while preserving the Windows title-bar overlay branch. Source regression
  tests assert the Linux-specific patch and existing Windows overlay.

## Callback diagnosis and fix

The installed release-1 package had `/opt/factory-desktop-linux/resources` and
`locales` at mode `0700`, owned by root. The normal user could not read
`resources/app.asar`; Electron logged `FILE_ERROR_ACCESS_DENIED`. The new RPM
normalizes installed bundle directories to `0755` and verifies those modes.

The callback scheme is `factory-desktop`. It had no registered user-level
handler. The existing installer also failed if the app had already created
`~/.local/state/factory-desktop-linux/`; it attempted to create that directory
without allowing it to exist. The installer now preserves existing app state,
and a regression test verifies registration and rollback without changing
pre-existing data.
KDE's real `xdg-mime` was also exercised in isolated temporary XDG
directories: release-4 helper registration selected the personal app entry,
and rollback restored the prior empty association and removed the temporary
desktop entry.
The user then confirmed the browser-to-desktop sign-in handoff worked after
installing release 4 and registering the handler.

## Release-5 RPM artifact (historical)

Created the Fedora 44 x86_64 artifact:

```text
dist/rpm/factory-desktop-linux-0.194.0-5.fc44.x86_64.rpm
dist/rpm/factory-desktop-linux-0.194.0-5.fc44.x86_64.rpm.sha256
```

RPM SHA-256:
`0f8d5bdcc0f853c122c2c83054b2bba8e721ec83eca2c25bb3785f5835e54101`.
The sidecar checksum passes `sha256sum -c`.

RPM queries confirm name `factory-desktop-linux`, version `0.194.0`,
release `5.fc44`, architecture `x86_64`, and `LicenseRef-Proprietary`. Runtime
requirements include `libsecret-1.so.0` and the observed system ELF
dependencies. Bundled private library requirements and provides are filtered.
The extracted `/opt` payload hashes match the staged payload, and its
directories are `0755`.
Package files are root-owned, the sandbox helper and unpacked keytar module
have mode `0755` without setuid/setgid bits, and the wrapper, desktop entry,
icon, and notice have the expected paths and permissions. The RPM has no
install or uninstall scriptlets. The current host has release `4.fc44`
installed; release 5 is only built in this workspace.

The host-level `unshare -Ur true` probe passed. The isolated Electron GUI smoke
check was skipped because `xvfb-run` is unavailable, so normal Electron
user-namespace sandbox startup is not confirmed. No workaround was applied.

## Not tested

- Login, callback delivery, renderer/daemon interaction, local sessions,
  persistence across restart, and interactive Wayland behavior.
- The isolated Secret Service dummy-value test.
- Any model task or access to user projects.

Release 2 fixed bundle permissions and support for a pre-existing app-state
directory. Release 3 attempted to accept KDE's effective-handler query result,
but was assembled from a portable bundle built before that helper fix. Release
4 rebuilds from the current source and records a hash of the packaged desktop
integration scripts in the build manifest; `npm run verify` checks the
installed helper copy against that hash.

The user-level callback handler remains registered from release 4. The release
5 RPM was not installed or published, and its title-bar behavior has not been
tested in a live window. The RPM package is only for personal use on Fedora 44
x86_64; compatibility with other RPM distributions is not claimed.

To apply the integrated-header changes, install release 6 and launch the app:

```sh
sudo dnf install ./dist/rpm/factory-desktop-linux-0.194.0-6.fc44.x86_64.rpm
factory-desktop-linux
```

To undo only the user-level callback registration:

```sh
/opt/factory-desktop-linux/scripts/rollback-desktop.sh
```
