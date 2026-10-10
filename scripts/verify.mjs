import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ROOT,
  DROID_CLI_PACKAGE_NAME,
  TARGET_DROID_CLI_VERSION,
  TARGET_ELECTRON_VERSION,
  TARGET_FACTORY_VERSION,
  TOOLCHAIN_ROOT,
  assertElfX64,
  distributionDirectory,
  exists,
  fail,
  hashFilesInTree,
  hashTreeWithModes,
  readJson,
  requireSuccess,
  run,
  semverFromOutput,
  sha256File,
  toolRequire,
  walkFiles,
} from './lib.mjs';

const require = toolRequire(import.meta.url);
const asar = require('@electron/asar');
const distribution = distributionDirectory();
const failures = [];
const checks = [];
const report = {
  checkedAt: new Date().toISOString(),
  factoryVersion: TARGET_FACTORY_VERSION,
  electronVersion: TARGET_ELECTRON_VERSION,
  distributionDirectory: path.relative(ROOT, distribution),
  buildManifestSha256: null,
  distributionTreeSha256: null,
  checks,
  failures,
  interactiveChecks: {
    login: 'pending: requires user authentication',
    callbackDelivery: 'pending: requires authenticated login',
    localSession: 'pending: requires explicit user-approved task in a disposable Git project',
    waylandLifecycle: 'pending: requires interactive desktop session',
  },
};

function record(name, status, detail = '') {
  checks.push({ name, status, detail });
}

function failCheck(name, error) {
  failures.push({ name, error: error.message ?? String(error) });
  record(name, 'fail', error.message ?? String(error));
}

async function check(name, callback) {
  try {
    const detail = await callback();
    if (detail && typeof detail === 'object' && detail.status) {
      record(name, detail.status, detail.detail ?? '');
    } else {
      record(name, 'pass', detail ?? '');
    }
  } catch (error) {
    failCheck(name, error);
  }
}

async function writeReport() {
  const reportPath = path.join(ROOT, 'build', 'verification-report.json');
  await mkdir(path.dirname(reportPath), { recursive: true });
  const reportName = `verification-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const timestampedReport = path.join(path.dirname(reportPath), reportName);
  await writeFile(timestampedReport, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const manifestPath = path.join(distribution, 'build-manifest.json');
  if (!(await exists(manifestPath))) {
    failures.push({
      name: 'distribution',
      error: 'Portable distribution has not been assembled; source inputs or target build prerequisites are missing.',
    });
    record('distribution', 'fail', failures.at(-1).error);
    for (const name of [
      'packaged-files',
      'versions',
      'ELF-architecture',
      'native-module-packaging',
      'patch-preconditions',
      'source-hashes',
      'electron-runtime',
      'droid-daemon-options',
      'shared-libraries',
      'keytar-electron-load',
    ]) {
      record(name, 'skipped', 'requires a completed portable distribution');
    }
    await check('electron-published-checksum', async () => {
      const filename = `electron-v${TARGET_ELECTRON_VERSION}-linux-x64.zip`;
      const checksums = await readJson(
        path.join(TOOLCHAIN_ROOT, 'node_modules', 'electron', 'checksums.json'),
        'Electron published checksums',
      );
      const expected = checksums[filename];
      if (!/^[a-f0-9]{64}$/i.test(expected ?? '')) fail(`No published SHA-256 entry for ${filename}.`);
      const cacheRoot = path.join(ROOT, 'build', 'electron-cache');
      const archives = (await walkFiles(cacheRoot)).filter((file) => path.basename(file) === filename);
      if (archives.length === 0) fail(`Downloaded Electron archive ${filename} is missing from cache.`);
      for (const archive of archives) {
        if (await sha256File(archive) !== expected) fail(`Published SHA-256 does not match cached ${filename}.`);
      }
      return `${filename} SHA-256 verified (${archives.length} cached copy/copies)`;
    });
    await writeReport();
    process.exitCode = 1;
    return;
  }

  await check('packaged-files', async () => {
    for (const relativePath of [
      'factory-desktop',
      'chrome-sandbox',
      'chrome_crashpad_handler',
      'libEGL.so',
      'libGLESv2.so',
      'libffmpeg.so',
      'libvk_swiftshader.so',
      'libvulkan.so.1',
      'launch.sh',
      'launch-test.sh',
      'resources/app.asar',
      'resources/bin/droid',
      'resources/protocol-scheme',
      'build-manifest.json',
      'scripts/install-desktop.sh',
      'scripts/rollback-desktop.sh',
      'scripts/keytar-secret-service-test.cjs',
    ]) {
      const fullPath = path.join(distribution, relativePath);
      const fileStat = await import('node:fs/promises').then(({ stat }) => stat(fullPath).catch(() => null));
      if (!fileStat) {
        fail(`Missing packaged file ${relativePath}.`);
      }
      if (['factory-desktop', 'launch.sh', 'launch-test.sh', 'scripts/install-desktop.sh', 'scripts/rollback-desktop.sh']
        .includes(relativePath) && (fileStat.mode & 0o111) === 0) {
        fail(`Packaged launcher is not executable: ${relativePath}.`);
      }
    }
    const iconPng = await exists(path.join(distribution, 'resources', 'factory-desktop.png'));
    const iconSvg = await exists(path.join(distribution, 'resources', 'factory-desktop.svg'));
    if (!iconPng && !iconSvg) fail('The packaged application icon is missing.');
    const sandboxPath = path.join(distribution, 'chrome-sandbox');
    const sandboxMode = (await import('node:fs/promises').then(({ stat }) => stat(sandboxPath))).mode & 0o7777;
    if (sandboxMode !== 0o755) {
      fail(`Electron chrome-sandbox must remain executable without setuid/setgid permissions, found mode 0${sandboxMode.toString(8)}.`);
    }
    return 'required packaged paths exist';
  });

  const buildManifest = await readJson(path.join(distribution, 'build-manifest.json'), 'build manifest').catch((error) => {
    failures.push({ name: 'build-manifest', error: error.message });
    record('build-manifest', 'fail', error.message);
    return null;
  });
  if (buildManifest) {
    await check('versions', async () => {
      if (buildManifest.factoryVersion !== TARGET_FACTORY_VERSION ||
          buildManifest.electronVersion !== TARGET_ELECTRON_VERSION ||
          buildManifest.droidCliVersion !== TARGET_DROID_CLI_VERSION ||
          buildManifest.droidBundleMode !== 'pinned-official-linux-package' ||
          buildManifest.architecture !== 'x64' ||
          buildManifest.platform !== 'linux' ||
          buildManifest.electronRuntime?.sandboxMode !== 'user-namespace; chrome-sandbox mode 0755') {
        fail('Build manifest version/platform does not match the requested target.');
      }
      const scheme = (await import('node:fs/promises')).readFile(
        path.join(distribution, 'resources', 'protocol-scheme'),
        'utf8',
      ).then((value) => value.trim());
      if ((await scheme) !== buildManifest.callbackScheme) {
        fail('Packaged callback scheme differs from the build manifest.');
      }
      const integrationHash = await hashFilesInTree(path.join(distribution, 'scripts'));
      if (integrationHash !== buildManifest.desktopIntegrationSha256) {
        fail('Packaged desktop integration scripts do not match the build manifest; rebuild the portable bundle.');
      }
      return `${buildManifest.factoryVersion}, Electron ${buildManifest.electronVersion}, Linux x64`;
    });
  }

  await check('ELF-architecture', async () => {
    const electronHelpers = [
      'factory-desktop',
      'chrome-sandbox',
      'chrome_crashpad_handler',
      'libEGL.so',
      'libGLESv2.so',
      'libffmpeg.so',
      'libvk_swiftshader.so',
      'libvulkan.so.1',
    ];
    const runtimeFiles = [
      ...electronHelpers.map((name) => path.join(distribution, name)),
      path.join(distribution, 'resources', 'bin', 'droid'),
    ];
    for (const runtimeFile of runtimeFiles) {
      if (await exists(runtimeFile)) await assertElfX64(runtimeFile, 'Packaged Linux runtime');
    }
    const unpacked = path.join(distribution, 'resources', 'app.asar.unpacked');
    const nativeFiles = (await walkFiles(unpacked)).filter((file) => file.endsWith('.node'));
    if (nativeFiles.length === 0) fail('No unpacked native module was found.');
    for (const nativeFile of nativeFiles) await assertElfX64(nativeFile, 'Unpacked native module');
    const windowsBinaries = (await walkFiles(distribution))
      .filter((file) => /\.(?:dll|exe)$/i.test(file));
    if (windowsBinaries.length) {
      fail(`Windows binaries remain in the Linux distribution: ${windowsBinaries.map((file) => path.relative(distribution, file)).join(', ')}`);
    }
    return `Electron, Droid, and ${nativeFiles.length} native module(s) are x86_64 ELF`;
  });

  await check('native-module-packaging', async () => {
    const appAsar = path.join(distribution, 'resources', 'app.asar');
    const archiveEntries = (await asar.listPackage(appAsar)).map((entry) => entry.replace(/^\/+/, ''));
    const nativeEntries = archiveEntries.filter((entry) => entry.endsWith('.node'));
    const unexpected = nativeEntries.filter((entry) => !entry.startsWith('node_modules/keytar/'));
    if (unexpected.length) fail(`Unexpected native module(s) remain in app.asar: ${unexpected.join(', ')}.`);
    const windowsEntries = archiveEntries.filter((entry) => /\.(?:dll|exe)$/i.test(entry));
    if (windowsEntries.length) fail(`Windows binary entries remain in app.asar: ${windowsEntries.join(', ')}.`);
    const unpacked = (await walkFiles(path.join(distribution, 'resources', 'app.asar.unpacked')))
      .filter((file) => file.endsWith('.node'));
    if (nativeEntries.length !== 1 || unpacked.length !== 1) {
      fail(`Expected one keytar .node entry and one unpacked module; found ${nativeEntries.length} and ${unpacked.length}.`);
    }
    const unpackedRelativePath = path.relative(
      path.join(distribution, 'resources', 'app.asar.unpacked'),
      unpacked[0],
    );
    const expectedNative = buildManifest?.keytar?.nativeFiles?.find((item) => item.path === unpackedRelativePath);
    if (!expectedNative || await sha256File(unpacked[0]) !== expectedNative.sha256) {
      fail('Unpacked keytar module does not match the native-build manifest.');
    }
    return `one keytar native entry, unpacked to ${path.relative(distribution, unpacked[0])}`;
  });

  await check('patch-preconditions', async () => {
    const appAsar = path.join(distribution, 'resources', 'app.asar');
    const patches = buildManifest?.patches ?? [];
    const archiveEntries = (await asar.listPackage(appAsar)).map((entry) => entry.replace(/^\/+/, ''));
    for (const patch of patches) {
      if (patch.factoryVersion !== TARGET_FACTORY_VERSION || !patch.fileSha256) {
        fail(`Patch ${patch.id ?? '<unknown>'} has incomplete version/result metadata.`);
      }
      const entry = patch.file.replace(/^\/+/, '');
      if (!archiveEntries.includes(entry)) fail(`Patched file ${entry} is missing from app.asar.`);
      const fileContents = await asar.extractFile(appAsar, entry);
      const digest = await import('node:crypto').then(({ createHash }) =>
        createHash('sha256').update(fileContents).digest('hex'));
      if (digest !== patch.fileSha256) fail(`Patched file hash mismatch for ${entry}.`);
    }
    return `${patches.length} version-specific patch(es) recorded`;
  });

  await check('source-hashes', async () => {
    const extractionManifest = await readJson(path.join(ROOT, 'build', 'extracted', 'input-manifest.json'), 'extraction manifest');
    if (extractionManifest.factoryVersion !== TARGET_FACTORY_VERSION) {
      fail(`Source extraction is version ${extractionManifest.factoryVersion}, expected ${TARGET_FACTORY_VERSION}.`);
    }
    for (const source of extractionManifest.inputFiles) {
      const sourcePath = path.resolve(ROOT, extractionManifest.inspectionDirectory, source.name);
      if (await sha256File(sourcePath) !== source.sha256) {
        fail(`Source archive hash changed since extraction: ${source.name}.`);
      }
    }
    for (const nested of extractionManifest.nestedPackages ?? []) {
      const sourcePath = path.resolve(ROOT, 'build', 'extracted', 'inputs', nested.source);
      if (await sha256File(sourcePath) !== nested.sha256) {
        fail(`Nested package hash changed since extraction: ${nested.source}.`);
      }
    }
    if (buildManifest?.sourceAppAsarSha256 !== extractionManifest.appAsar.sha256) {
      fail('Packaged source app.asar hash does not match the extraction manifest.');
    }
    return `verified ${extractionManifest.inputFiles.length} original archive hash(es)`;
  });

  await check('electron-published-checksum', async () => {
    const filename = `electron-v${TARGET_ELECTRON_VERSION}-linux-x64.zip`;
    const checksums = await readJson(
      path.join(TOOLCHAIN_ROOT, 'node_modules', 'electron', 'checksums.json'),
      'Electron published checksums',
    );
    const expected = checksums[filename];
    if (!/^[a-f0-9]{64}$/i.test(expected ?? '')) fail(`No published SHA-256 entry for ${filename}.`);
    const cacheRoot = path.join(ROOT, 'build', 'electron-cache');
    const archives = (await walkFiles(cacheRoot)).filter((file) => path.basename(file) === filename);
    if (archives.length === 0) fail(`Downloaded Electron archive ${filename} is missing from cache.`);
    for (const archive of archives) {
      if (await sha256File(archive) !== expected) fail(`Published SHA-256 does not match cached ${filename}.`);
    }
    if (buildManifest?.electronArtifact?.sha256 !== expected) fail('Build manifest Electron artifact checksum differs from the published checksum.');
    return `${filename} SHA-256 verified (${archives.length} cached copy/copies)`;
  });

  await check('electron-runtime', async () => {
    const executable = path.join(distribution, 'factory-desktop');
    const result = run(executable, ['-p', 'process.versions.electron'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    requireSuccess(result, 'Packaged Electron runtime probe');
    if (!result.stdout.trim().includes(TARGET_ELECTRON_VERSION)) {
      fail(`Packaged executable reports Electron ${result.stdout.trim()}.`);
    }
    if (await sha256File(executable) !== buildManifest?.electronExecutableSha256) {
      fail('Packaged Electron executable hash differs from the build manifest.');
    }
    return `Electron ${result.stdout.trim()}`;
  });

  await check('droid-daemon-options', async () => {
    const executable = path.join(distribution, 'resources', 'bin', 'droid');
    const versionResult = run(executable, ['--version']);
    requireSuccess(versionResult, 'Packaged Droid --version');
    const helpResult = run(executable, ['daemon', '--help']);
    requireSuccess(helpResult, 'Packaged Droid daemon --help');
    const required = ['websocket', 'ipc', '--parent-pid', '--liveness-fd', '--droid-path', '--remote-access'];
    const missing = required.filter((option) => !helpResult.combined.includes(option));
    if (missing.length) fail(`Missing daemon option(s): ${missing.join(', ')}.`);
    const version = semverFromOutput(versionResult.combined);
    if (!version) fail('Could not determine the packaged Droid version.');
    if (version !== buildManifest?.droid?.version) {
      fail('Packaged Droid version differs from the build manifest.');
    }
    if (version !== TARGET_DROID_CLI_VERSION) {
      fail(`Packaged Droid ${version} differs from pinned version ${TARGET_DROID_CLI_VERSION}.`);
    }
    const lock = await readJson(path.join(ROOT, 'package-lock.json'), 'packaging lockfile');
    const lockedPackage = lock.packages?.[`node_modules/${DROID_CLI_PACKAGE_NAME}`];
    if (
      buildManifest.droid?.packageName !== DROID_CLI_PACKAGE_NAME ||
      buildManifest.droid?.packageResolved !== lockedPackage?.resolved ||
      buildManifest.droid?.packageIntegrity !== lockedPackage?.integrity
    ) {
      fail('Packaged Droid provenance differs from the pinned official npm package lock entry.');
    }
    if (await sha256File(executable) !== buildManifest?.droid?.sha256) {
      fail('Packaged Droid hash differs from the build manifest.');
    }
    return `Droid ${version}; WebSocket, IPC, and lifecycle options present`;
  });

  await check('shared-libraries', async () => {
    const electronHelpers = [
      'factory-desktop',
      'chrome-sandbox',
      'chrome_crashpad_handler',
      'libEGL.so',
      'libGLESv2.so',
      'libffmpeg.so',
      'libvk_swiftshader.so',
      'libvulkan.so.1',
    ];
    const targets = [
      ...(await Promise.all(electronHelpers.map(async (name) => {
        const target = path.join(distribution, name);
        return await exists(target) ? target : null;
      }))).filter(Boolean),
      path.join(distribution, 'resources', 'bin', 'droid'),
      ...(await walkFiles(path.join(distribution, 'resources', 'app.asar.unpacked'))).filter((file) => file.endsWith('.node')),
    ];
    const details = [];
    for (const target of targets) {
      const result = run('ldd', [target]);
      if (result.status !== 0 && !result.combined.includes('not a dynamic executable')) {
        fail(`ldd failed for ${path.basename(target)}: ${result.combined}`);
      }
      if (result.combined.includes('not found')) fail(`Missing shared library for ${path.basename(target)}.`);
      details.push(path.basename(target));
    }
    return `no missing shared libraries for ${details.length} ELF object(s)`;
  });

  await check('keytar-electron-load', async () => {
    const keytarCheck = path.join(ROOT, 'scripts', 'keytar-electron-check.cjs');
    const keytarModule = path.join(distribution, 'resources', 'app.asar.unpacked', 'node_modules', 'keytar');
    const electron = path.join(distribution, 'factory-desktop');
    const environment = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      FACTORY_KEYTAR_MODULE_PATH: keytarModule,
    };
    const result = run(electron, [keytarCheck], { env: environment });
    requireSuccess(result, 'Electron keytar load test');
    if (!result.combined.includes('KEYTAR_LOAD_OK')) fail('Electron keytar test did not report success.');
    return result.combined.trim();
  });

  await check('distribution-fingerprint', async () => {
    report.buildManifestSha256 = await sha256File(manifestPath);
    report.distributionTreeSha256 = await hashTreeWithModes(distribution);
    return `build manifest and ${report.distributionDirectory} tree fingerprinted`;
  });

  await writeReport();
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`verify: ${error.message}`);
  process.exitCode = 1;
});
