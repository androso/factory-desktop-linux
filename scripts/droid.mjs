import { constants } from 'node:fs';
import { access, chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  DROID_CLI_PACKAGE_NAME,
  ROOT,
  TARGET_DROID_CLI_VERSION,
  TOOLCHAIN_ROOT,
  assertElfX64,
  fail,
  readJson,
  requireSuccess,
  run,
  semverFromOutput,
  sha256File,
} from './lib.mjs';

export async function ensurePinnedDroidExecutable({
  nodeModules = path.join(TOOLCHAIN_ROOT, 'node_modules'),
  fixMode = false,
} = {}) {
  const packageRoot = path.join(nodeModules, DROID_CLI_PACKAGE_NAME);
  const packageManifest = await readJson(path.join(packageRoot, 'package.json'), 'pinned Droid CLI package');
  if (
    packageManifest.name !== DROID_CLI_PACKAGE_NAME ||
    packageManifest.version !== TARGET_DROID_CLI_VERSION
  ) {
    fail(`Expected ${DROID_CLI_PACKAGE_NAME}@${TARGET_DROID_CLI_VERSION}, found ${packageManifest.name}@${packageManifest.version}.`);
  }

  const lock = await readJson(path.join(ROOT, 'package-lock.json'), 'packaging lockfile');
  const lockedPackage = lock.packages?.[`node_modules/${DROID_CLI_PACKAGE_NAME}`];
  const expectedTarball = `https://registry.npmjs.org/${DROID_CLI_PACKAGE_NAME}/-/${DROID_CLI_PACKAGE_NAME.split('/')[1]}-${TARGET_DROID_CLI_VERSION}.tgz`;
  if (
    lock.packages?.['']?.devDependencies?.[DROID_CLI_PACKAGE_NAME] !== TARGET_DROID_CLI_VERSION ||
    lockedPackage?.version !== TARGET_DROID_CLI_VERSION ||
    lockedPackage?.resolved !== expectedTarball ||
    !/^sha512-[A-Za-z0-9+/]+=*$/.test(lockedPackage?.integrity ?? '')
  ) {
    fail('Pinned Droid CLI lock entry does not match the exact official npm package, version, tarball URL, and SHA-512 integrity.');
  }

  const executable = path.join(packageRoot, 'bin', 'droid');
  const details = await lstat(executable).catch((error) => {
    fail(`Pinned Droid CLI executable is missing or unreadable: ${error.message}`);
  });
  if (!details.isFile()) fail('Pinned Droid CLI executable is not a regular file.');
  await assertElfX64(executable, 'Pinned Droid CLI');
  try {
    await access(executable, constants.X_OK);
  } catch {
    if (!fixMode) fail('Pinned Droid CLI is not executable; refusing to modify the existing toolchain.');
    await chmod(executable, 0o755);
  }
  return {
    path: executable,
    version: packageManifest.version,
    sha256: await sha256File(executable),
    packageName: DROID_CLI_PACKAGE_NAME,
    packageVersion: packageManifest.version,
    packageResolved: lockedPackage.resolved,
    packageIntegrity: lockedPackage.integrity,
  };
}

export async function inspectPinnedDroid() {
  const droid = await ensurePinnedDroidExecutable();
  const versionResult = run(droid.path, ['--version']);
  requireSuccess(versionResult, 'Pinned Droid --version');
  const version = semverFromOutput(versionResult.combined);
  if (version !== TARGET_DROID_CLI_VERSION) {
    fail(`Pinned Droid package reports ${version ?? 'an unknown version'}, expected ${TARGET_DROID_CLI_VERSION}.`);
  }
  const helpResult = run(droid.path, ['daemon', '--help']);
  requireSuccess(helpResult, 'Pinned Droid daemon --help');
  const help = helpResult.combined;
  const required = ['websocket', 'ipc', '--host', '--port', '--parent-pid', '--liveness-fd', '--droid-path', '--remote-access'];
  const missing = required.filter((option) => !help.includes(option));
  if (missing.length) fail(`Pinned Droid daemon is missing required option(s): ${missing.join(', ')}.`);
  if (!/127\.0\.0\.1/.test(help) || !/--remote-access[\s\S]{0,160}default:\s*false/i.test(help)) {
    fail('Pinned Droid daemon does not document loopback binding and remote access disabled by default.');
  }
  return {
    ...droid,
    version,
    supportedOptions: required,
  };
}
