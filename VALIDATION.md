# Validation report

**Checked:** 2026-10-10
**Result:** The portable Linux x64 bundle was assembled and its automated
verification passed. Interactive app behavior is not yet validated.

## Passed

- Acquired the pinned Factory Desktop 0.194.0 Windows installer over HTTPS:
  HTTP 200, 282,948,832 bytes, SHA-256
  `0a69c32a5dad0f15ad8058bea3da4085dca3f0c7128a492b8a29a54a87169228`.
  The installer executable was not run.
- Extracted the installer as archive data only. The manifest records 545
  `app.asar` entries, one unpacked sidecar file, and 77 preserved Windows app
  files. Unsafe paths, links, special files, and conflicting app archives are
  rejected.
- Installed the locked toolchain with lifecycle scripts disabled into the
  lockfile-hash-versioned `build/toolchain-*` directory. It includes Electron
  42.11.12, the official `@factory/cli-linux-x64@0.194.0` package, and
  `node-addon-api@4.3.0`. Root `node_modules` was not modified.
- Fetched Electron 42.11.12 Linux x64 and matched its archive SHA-256 against
  the checksum published in the pinned Electron package:
  `1f17c115389c6395ce4b19b29ee2ec4be2208257514d61e269f1c0a7323bd45d`.
  The executable SHA-256 is
  `2cee1949cc7f949abe973a9d1cae0210b5a525d1b3666f61787bca01d75552e3`.
- `npm run preflight` passes on Ubuntu 24.04.4 x86_64 with `libsecret-1-dev`
  available.
- `npm run check` passes; `npm test` passes all 13 regression tests.
- `npm audit --audit-level=high` reports zero vulnerabilities.
- All five exact Factory 0.194.0 patch preconditions matched: callback
  registration opt-in, minimum-version prompt bypass, updater install/check
  no-ops, and update-menu removal.
- The pinned Droid 0.194.0 daemon smoke test passes with an isolated HOME. It
  starts with the app's WebSocket/liveness arguments, binds only to IPv4
  loopback, completes a WebSocket upgrade, and exits cleanly when the
  liveness pipe closes. No authentication, JSON-RPC, or model request was
  sent. This does not prove full app/CLI protocol compatibility.
- Built the verified distribution at
  `dist/factory-desktop-linux-validated/` with Factory 0.194.0, Electron
  42.11.12, and Droid 0.194.0. Its manifest records source/runtime hashes and
  the official CLI package integrity.
- `FACTORY_DIST_NAME=factory-desktop-linux-validated npm run verify` passes all
  11 checks, including x86_64 ELF checks, patched-file hashes, shared-library
  resolution, pinned Droid options/provenance, and Electron runtime version.
- Keytar 7.9.0 was rebuilt against Electron's ABI and is unpacked from
  `app.asar`. The Electron Node-mode check passes:
  `KEYTAR_LOAD_OK electron=42.11.12 modules=146`.
- No desktop callback association was registered. Automatic updater actions
  remain disabled in this port.
- `libsecret-1-dev` was installed after explicit approval. Apt also upgraded
  10 existing packages and installed 22 new packages while resolving
  dependencies; no packages were removed.

## Pending or not verified

- The installer publisher signature was not verified because `osslsigncode`
  was unavailable. The local SHA-256 proves byte identity only, not publisher
  authenticity.
- No interactive login or callback delivery was tested. Login requires user
  authentication and is intentionally not started by these checks.
- Renderer/daemon interaction, local sessions, persistence across restart,
  Wayland lifecycle, clipboard, external links, and second-instance routing
  still need interactive validation.
- The isolated Secret Service dummy-value test was not run. It requires a
  dedicated disposable D-Bus/keyring session.
- No model task was run, and no user project was accessed.

An earlier failed-verification bundle is preserved at `dist/factory-desktop-linux/`;
the verified bundle is the separate `dist/factory-desktop-linux-validated/`
directory. Build and verification do not overwrite existing outputs.
