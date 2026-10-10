import { cp, copyFile, mkdir, readFile, stat, unlink, writeFile, chmod, lstat, realpath, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  ROOT,
  TARGET_DROID_CLI_VERSION,
  TARGET_ELECTRON_VERSION,
  TARGET_FACTORY_VERSION,
  TOOLCHAIN_ROOT,
  assertElfX64,
  distributionDirectory,
  exists,
  fail,
  hashFilesInTree,
  readJson,
  readOsRelease,
  requireSuccess,
  run,
  sha256File,
  semverFromOutput,
  toolRequire,
  walkFiles,
  moveNoReplace,
} from './lib.mjs';
import { patches, transformExact } from './patches.mjs';
import { mergeSidecar } from './sidecar.mjs';
import { inspectPinnedDroid } from './droid.mjs';

const require = toolRequire(import.meta.url);
const asar = require('@electron/asar');

async function applyPatches(appDirectory, appVersion) {
  const records = [];
  for (const patch of patches) {
    if (patch.factoryVersion !== appVersion) {
      fail(`Patch ${patch.id} targets ${patch.factoryVersion}, not ${appVersion}.`);
    }
    const filePath = path.join(appDirectory, patch.file);
    const content = transformExact(await readFile(filePath, 'utf8'), patch);
    await writeFile(filePath, content);
    records.push({
      id: patch.id,
      file: patch.file,
      factoryVersion: patch.factoryVersion,
    });
  }
  for (const record of records) {
    record.fileSha256 = await sha256File(path.join(appDirectory, record.file));
  }
  return records;
}

async function detectProtocolScheme(appDirectory) {
  const jsFiles = (await walkFiles(appDirectory))
    .filter((file) => /\.(?:js|cjs|mjs|html)$/i.test(file) && !file.includes(`${path.sep}node_modules${path.sep}`));
  const candidates = new Set();
  let rendererScheme = null;
  for (const file of jsFiles) {
    const content = await readFile(file, 'utf8');
    const callbackSelector = content.match(
      /\bconst\s+([A-Za-z_$][\w$]*)="([a-z][a-z0-9+.-]{1,62})",\s*([A-Za-z_$][\w$]*)="([a-z][a-z0-9+.-]{1,62})";\s*function\s+gc\([^)]*\)\{return[^?]*\?([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*)\}/,
    );
    if (callbackSelector && content.includes('setAsDefaultProtocolClient(e)')) {
      const productionConstant = callbackSelector[5];
      const productionValue = productionConstant === callbackSelector[1]
        ? callbackSelector[2]
        : productionConstant === callbackSelector[3]
          ? callbackSelector[4]
          : null;
      if (productionValue) candidates.add(productionValue);
    }
    for (const registration of content.matchAll(
      /registerSchemesAsPrivileged\(\[\{scheme:([A-Za-z_$][\w$]*)/g,
    )) {
      const schemeVariable = registration[1];
      const escapedVariable = schemeVariable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const declaration = content.match(new RegExp(
        `(?:^|[,;])\\s*${escapedVariable}\\s*=\\s*["']([a-z][a-z0-9+.-]{1,62})["']`,
      ));
      if (declaration) {
        const discoveredScheme = declaration[1].toLowerCase();
        if (rendererScheme && rendererScheme !== discoveredScheme) {
          fail(`App bundle registers multiple renderer protocols: ${rendererScheme} and ${discoveredScheme}.`);
        }
        rendererScheme = discoveredScheme;
      }
    }
    for (const match of content.matchAll(/\bsetAsDefaultProtocolClient\s*\(\s*['"]([a-z][a-z0-9+.-]{1,62})['"]/gi)) {
      candidates.add(match[1].toLowerCase());
    }
  }
  const requested = process.env.FACTORY_PROTOCOL_SCHEME?.toLowerCase();
  if (requested) {
    if (!/^[a-z][a-z0-9+.-]{1,62}$/.test(requested)) {
      fail('FACTORY_PROTOCOL_SCHEME is not a valid URI scheme.');
    }
    if (!candidates.has(requested)) {
      fail(`Requested callback scheme ${requested} was not found in the app bundle.`);
    }
    return requested;
  }
  if (candidates.size !== 1) {
    fail(`Could not determine one external callback scheme from the app's production protocol selector. Found: ${[...candidates].sort().join(', ') || 'none'}. Do not substitute the renderer protocol.`);
  }
  const externalCallbackScheme = [...candidates][0];
  if (!rendererScheme) fail('Could not identify the renderer protocol registered by the app bundle.');
  if (externalCallbackScheme === rendererScheme) fail('External callback and renderer protocols unexpectedly resolve to the same scheme.');
  return { externalCallbackScheme, rendererScheme };
}

async function inspectSecurityAndRuntime(appDirectory) {
  const jsFiles = (await walkFiles(appDirectory))
    .filter((file) => /\.(?:js|cjs|mjs|html)$/i.test(file))
    .filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`));
  const findings = [];
  for (const file of jsFiles) {
    const content = await readFile(file, 'utf8');
    if (/\bsetAsDefaultProtocolClient\s*\(/.test(content)) {
      findings.push({
        kind: 'protocol-registration-call',
        file: path.relative(appDirectory, file),
        matches: [...content.matchAll(/\bsetAsDefaultProtocolClient\s*\(/g)].length,
        linuxPackagedGuard: content.includes('process.platform==="linux"?void 0:I.app.setAsDefaultProtocolClient(e)'),
      });
    }
    if (/\bautoUpdater\b|\bcheckForUpdates(?:AndNotify)?\s*\(/.test(content)) {
      findings.push({
        kind: 'update-related-code',
        file: path.relative(appDirectory, file),
      });
    }
  }
  const unguardedRegistration = findings.find((item) =>
    item.kind === 'protocol-registration-call' && !item.linuxPackagedGuard);
  if (unguardedRegistration) {
    fail(`App source contains unguarded protocol registration code: ${JSON.stringify(unguardedRegistration)}`);
  }
  const packageJson = await readJson(path.join(appDirectory, 'package.json'), 'Factory app package manifest');
  const electronRange = packageJson.devDependencies?.electron ??
    packageJson.dependencies?.electron ??
    packageJson.optionalDependencies?.electron ??
    null;
  const electronMajor = semverFromOutput(TARGET_ELECTRON_VERSION)?.split('.')[0];
  const appElectronVersion = electronRange?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  if (appElectronVersion && appElectronVersion.split('.')[0] !== electronMajor) {
    fail(`App declares Electron ${electronRange}; selected runtime ${TARGET_ELECTRON_VERSION} crosses a major-version boundary.`);
  }
  return {
    electronDependency: electronRange,
    electronDeclaredVersion: appElectronVersion,
    electronSelectedVersion: TARGET_ELECTRON_VERSION,
    electronSameMajor: !appElectronVersion || appElectronVersion.split('.')[0] === electronMajor,
    callbackRegistration: findings.filter((item) => item.kind === 'protocol-registration-call'),
    updateRelatedFiles: findings.filter((item) => item.kind === 'update-related-code'),
  };
}

async function requirePreAssemblyGates(droid) {
  const gatesDirectory = path.join(ROOT, 'build', 'gates');
  const packageHash = await sha256File(path.join(ROOT, 'package.json'));
  const lockHash = await sha256File(path.join(ROOT, 'package-lock.json'));
  const cleanInstallPath = path.join(
    gatesDirectory,
    `clean-install-${packageHash.slice(0, 16)}-${lockHash.slice(0, 16)}.json`,
  );
  const cleanInstall = await readJson(cleanInstallPath, 'clean npm install gate');
  const syntheticSourceHash = await hashTestInputs();
  const syntheticPath = path.join(gatesDirectory, `synthetic-tests-${syntheticSourceHash}.json`);
  const synthetic = await readJson(syntheticPath, 'synthetic test gate');
  const droidHash = await sha256File(droid.path);
  const daemonPath = path.join(
    gatesDirectory,
    `daemon-compatibility-${droidHash}-${lockHash.slice(0, 12)}.json`,
  );
  const daemon = await readJson(daemonPath, 'Droid daemon compatibility gate');
  const toolchainManifest = await readJson(
    path.join(TOOLCHAIN_ROOT, 'factory-toolchain-manifest.json'),
    'isolated toolchain manifest',
  );
  const toolchainHash = await hashFilesInTree(path.join(TOOLCHAIN_ROOT, 'node_modules'));
  if (
    toolchainManifest.packageJsonSha256 !== packageHash ||
    toolchainManifest.packageLockSha256 !== lockHash ||
    toolchainManifest.electronVersion !== TARGET_ELECTRON_VERSION ||
    toolchainManifest.droidCliVersion !== TARGET_DROID_CLI_VERSION ||
    toolchainManifest.droid?.version !== TARGET_DROID_CLI_VERSION ||
    toolchainManifest.droid?.sha256 !== droid.sha256 ||
    toolchainManifest.droid?.packageIntegrity !== droid.packageIntegrity ||
    toolchainManifest.lifecycleScripts !== 'disabled' ||
    toolchainManifest.nodeModulesFilesSha256 !== toolchainHash
  ) {
    fail('Isolated build toolchain is missing, stale, modified, or does not match the package lock. Run npm run clean-install.');
  }
  if (
    cleanInstall.status !== 'pass' ||
    cleanInstall.electronVersion !== TARGET_ELECTRON_VERSION ||
    cleanInstall.droidCliVersion !== TARGET_DROID_CLI_VERSION ||
    cleanInstall.packageJsonSha256 !== packageHash ||
    cleanInstall.packageLockSha256 !== lockHash
  ) {
    fail('Clean locked installation evidence is missing, stale, or for a different Electron target. Run npm run clean-install.');
  }
  if (
    synthetic.status !== 'pass' ||
    synthetic.electronVersion !== TARGET_ELECTRON_VERSION ||
    synthetic.sourceSha256 !== syntheticSourceHash
  ) {
    fail('Synthetic regression evidence is missing, stale, or for a different Electron target. Run npm test.');
  }
  if (
    daemon.status !== 'pass' ||
    daemon.droidSha256 !== droidHash ||
    daemon.droidVersion !== droid.version ||
    daemon.droidVersion !== TARGET_DROID_CLI_VERSION ||
    daemon.droidPackageIntegrity !== droid.packageIntegrity ||
    daemon.packageLockSha256 !== lockHash ||
    daemon.requestedHost !== '127.0.0.1' ||
    daemon.transport !== 'WebSocket upgrade handshake, no RPC/auth/model request sent' ||
    daemon.shutdown !== 'exit 0'
  ) {
    fail('Pinned Droid daemon startup/loopback/WebSocket/liveness evidence is missing or stale. Run npm run daemon:check.');
  }
  return { cleanInstall, synthetic, daemon, toolchainManifest };
}

async function hashTestInputs() {
  const files = [
    'package.json',
    'package-lock.json',
    'versions.json',
    ...await walkFiles(path.join(ROOT, 'scripts')),
    ...await walkFiles(path.join(ROOT, 'tests')),
  ].filter((file) => !file.includes(`${path.sep}node_modules${path.sep}`))
    .map((file) => path.relative(ROOT, file))
    .sort();
  const digest = createHash('sha256');
  for (const relative of files) digest.update(relative).update('\0').update(await readFile(path.join(ROOT, relative))).update('\0');
  return digest.digest('hex');
}

async function checkSafeOutputTree(directory) {
  const base = await realpath(directory);
  for (const file of await walkFiles(directory)) {
    const real = await realpath(file);
    const relative = path.relative(base, real);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      fail(`Assembly path escapes the staging root: ${path.relative(directory, file)}.`);
    }
    if ((await lstat(file)).isSymbolicLink()) fail(`Assembly contains a symbolic link: ${file}.`);
  }
}

async function findIcon(appDirectory) {
  const icons = (await walkFiles(appDirectory))
    .filter((file) => /\.(?:png|svg)$/i.test(file))
    .filter((file) => /(?:icon|logo|app)/i.test(path.basename(file)))
    .sort((a, b) => {
      const score = (file) => {
        const base = path.basename(file).toLowerCase();
        return (base === 'icon.png' || base === 'icon.svg' ? 0 : 1) +
          (file.endsWith('.png') ? 0 : 1);
      };
      return score(a) - score(b) || a.localeCompare(b);
    });
  return icons[0] ?? path.join(ROOT, 'assets', 'factory-desktop.svg');
}

async function verifyElectronArtifact() {
  const filename = `electron-v${TARGET_ELECTRON_VERSION}-linux-x64.zip`;
  const electronDirectory = path.join(TOOLCHAIN_ROOT, 'node_modules', 'electron');
  const checksums = await readJson(path.join(electronDirectory, 'checksums.json'), 'Electron published checksums');
  const expected = checksums[filename];
  if (!/^[a-f0-9]{64}$/i.test(expected ?? '')) {
    fail(`Pinned Electron package has no published SHA-256 entry for ${filename}.`);
  }
  const cacheRoot = path.join(ROOT, 'build', 'electron-cache');
  const cachedArchives = (await walkFiles(cacheRoot)).filter((file) => path.basename(file) === filename);
  if (cachedArchives.length === 0) {
    fail(`Could not find the downloaded ${filename} under the Electron cache ${cacheRoot}. Run npm run electron:fetch to download and checksum-verify Electron.`);
  }
  for (const archive of cachedArchives) {
    const actual = await sha256File(archive);
    if (actual !== expected) {
      fail(`Electron archive checksum mismatch for ${filename}: expected ${expected}, got ${actual}.`);
    }
  }
  return { filename, sha256: expected, checkedCopies: cachedArchives.length };
}

async function verifyExtractedInputs(extractionManifest) {
  for (const input of extractionManifest.inputFiles ?? []) {
    const inputPath = path.resolve(ROOT, extractionManifest.inspectionDirectory, input.name);
    if (await sha256File(inputPath) !== input.sha256) {
      fail(`Source archive hash changed after extraction: ${input.name}.`);
    }
  }
  const rawRoot = path.resolve(ROOT, 'build', 'extracted', 'inputs');
  for (const nested of extractionManifest.nestedPackages ?? []) {
    const nestedPath = path.resolve(rawRoot, nested.source);
    const relative = path.relative(rawRoot, nestedPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      fail(`Nested archive path escapes the extraction directory: ${nested.source}.`);
    }
    if (await sha256File(nestedPath) !== nested.sha256) {
      fail(`Nested archive hash changed after extraction: ${nested.source}.`);
    }
  }
}

async function runNativeRebuild(appDirectory) {
  const keytarPath = path.join(appDirectory, 'node_modules', 'keytar');
  const keytarPackage = await readJson(path.join(keytarPath, 'package.json'), 'embedded keytar package');
  if (keytarPackage.name !== 'keytar' || !/^7\.9\./.test(keytarPackage.version ?? '')) {
    fail(`Expected embedded keytar 7.9.x, found ${keytarPackage.version ?? 'unknown'}.`);
  }
  const pkgConfig = run('pkg-config', ['--exists', 'libsecret-1']);
  if (pkgConfig.status !== 0) {
    fail('libsecret development files are missing. On Fedora, install libsecret-devel only after separate approval; this script never invokes sudo or a package manager.');
  }
  const isolatedBuildRoot = path.join(ROOT, 'build', `.native-keytar-${Date.now()}-${randomUUID()}`);
  await mkdir(isolatedBuildRoot, { mode: 0o700 });
  const isolatedNodeModules = path.join(isolatedBuildRoot, 'node_modules');
  await cp(path.join(appDirectory, 'node_modules'), isolatedNodeModules, { recursive: true, errorOnExist: true });
  const isolatedKeytarPath = path.join(isolatedNodeModules, 'keytar');
  const addonApiPackage = await readJson(
    path.join(TOOLCHAIN_ROOT, 'node_modules', 'node-addon-api', 'package.json'),
    'pinned node-addon-api package',
  );
  const expectedAddonApiVersion = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
    .devDependencies?.['node-addon-api'];
  if (addonApiPackage.version !== expectedAddonApiVersion || expectedAddonApiVersion !== '4.3.0') {
    fail(`Keytar build requires pinned node-addon-api 4.3.0, found ${addonApiPackage.version}.`);
  }
  await cp(
    path.join(TOOLCHAIN_ROOT, 'node_modules', 'node-addon-api'),
    path.join(isolatedNodeModules, 'node-addon-api'),
    { recursive: true, errorOnExist: true },
  );
  await writeFile(path.join(isolatedBuildRoot, 'package.json'), `${JSON.stringify({
    name: 'factory-desktop-keytar-native-build',
    version: '0.0.0',
    private: true,
    dependencies: {
      keytar: keytarPackage.version,
      'node-addon-api': addonApiPackage.version,
    },
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const oldNativeFiles = (await walkFiles(isolatedKeytarPath)).filter((file) => file.endsWith('.node'));
  for (const nativeFile of oldNativeFiles) await unlink(nativeFile);
  const { rebuild } = require('@electron/rebuild');
  await rebuild({
    buildPath: isolatedBuildRoot,
    electronVersion: TARGET_ELECTRON_VERSION,
    arch: 'x64',
    force: true,
    onlyModules: ['keytar'],
    mode: 'sequential',
  });
  const nativeFiles = (await walkFiles(isolatedKeytarPath))
    .filter((file) => file.endsWith('.node'))
    .filter((file) => path.relative(isolatedKeytarPath, file) === path.join('build', 'Release', 'keytar.node'));
  if (nativeFiles.length !== 1) fail(`Expected exactly one Linux keytar module after rebuilding, found ${nativeFiles.length}.`);
  for (const nativeFile of nativeFiles) await assertElfX64(nativeFile, 'Rebuilt keytar module');
  const staleAppModules = (await walkFiles(keytarPath)).filter((file) => file.endsWith('.node'));
  for (const staleModule of staleAppModules) await unlink(staleModule);
  for (const nativeFile of nativeFiles) {
    const relativePath = path.relative(isolatedKeytarPath, nativeFile);
    const destination = path.join(keytarPath, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(nativeFile, destination);
    await chmod(destination, 0o755);
  }
  const bundledModules = (await walkFiles(keytarPath)).filter((file) => file.endsWith('.node'));
  if (bundledModules.length !== 1) fail(`Expected exactly one Linux keytar module in the app bundle, found ${bundledModules.length}.`);
  for (const nativeFile of bundledModules) await assertElfX64(nativeFile, 'Bundled keytar module');
  return {
    version: keytarPackage.version,
    buildHeaders: {
      nodeAddonApiVersion: addonApiPackage.version,
      nodeAddonApiPackageJsonSha256: await sha256File(
        path.join(TOOLCHAIN_ROOT, 'node_modules', 'node-addon-api', 'package.json'),
      ),
    },
    buildEnvironment: path.relative(ROOT, isolatedBuildRoot),
    nativeFiles: await Promise.all(bundledModules.map(async (file) => ({
      path: path.relative(appDirectory, file),
      sha256: await sha256File(file),
    }))),
  };
}

async function main() {
  const osRelease = await readOsRelease();
  if (osRelease.ID !== 'ubuntu' || osRelease.VERSION_ID !== '24.04' || process.arch !== 'x64') {
    fail(`Target packaging is Ubuntu 24.04 x64; current host is ${osRelease.PRETTY_NAME ?? osRelease.ID ?? 'unknown'} (${process.arch}).`);
  }
  if (run('pkg-config', ['--exists', 'libsecret-1']).status !== 0) {
    fail('libsecret-1-dev is missing. Request and obtain separate approval for the exact privileged installation; this script never invokes sudo or apt.');
  }
  const extractionRoot = path.join(ROOT, 'build', 'extracted');
  const completion = await readFile(path.join(extractionRoot, 'EXTRACTION_COMPLETE'), 'utf8').catch(() => '');
  if (completion.trim() !== TARGET_FACTORY_VERSION) {
    fail(`Missing or invalid extraction completion marker for Factory ${TARGET_FACTORY_VERSION}.`);
  }
  const extractionManifest = await readJson(path.join(extractionRoot, 'input-manifest.json'), 'extraction manifest');
  if (extractionManifest.factoryVersion !== TARGET_FACTORY_VERSION) {
    fail(`Extraction manifest targets ${extractionManifest.factoryVersion}, expected ${TARGET_FACTORY_VERSION}.`);
  }
  await verifyExtractedInputs(extractionManifest);
  const installerRecord = extractionManifest.inputFiles?.find((item) => item.name === 'Factory-0.194.0 Setup.exe');
  if (!installerRecord) fail('Extraction was not based on the pinned Factory-0.194.0 Setup.exe installer.');
  const provenancePath = path.join(ROOT, 'inspection', `${installerRecord.name}.provenance.json`);
  const provenance = await readJson(provenancePath, 'pinned installer acquisition provenance');
  if (
    provenance.requestedVersion !== TARGET_FACTORY_VERSION ||
    provenance.filename !== installerRecord.name ||
    provenance.status !== 200 ||
    provenance.sha256 !== installerRecord.sha256 ||
    provenance.acquisitionUrl !== 'https://downloads.factory.ai/factory-desktop/releases/0.194.0/win32/x64/Factory-0.194.0%20Setup.exe'
  ) {
    fail('Pinned installer provenance does not match the official URL, successful transfer, and extracted input hash.');
  }
  const sourceApplication = path.join(extractionRoot, 'application');
  const sourceApp = path.join(sourceApplication, 'app');
  const sourceAppar = path.join(sourceApplication, 'resources', 'app.asar');
  const sourcePackage = await readJson(path.join(sourceApp, 'package.json'), 'extracted Factory app package manifest');
  if (sourcePackage.version !== TARGET_FACTORY_VERSION) {
    fail(`Expected extracted Factory Desktop ${TARGET_FACTORY_VERSION}, found ${sourcePackage.version ?? 'unknown'}.`);
  }

  const electronDirectory = path.join(TOOLCHAIN_ROOT, 'node_modules', 'electron');
  const electronPackage = await readJson(path.join(electronDirectory, 'package.json'), 'pinned Electron package');
  if (electronPackage.version !== TARGET_ELECTRON_VERSION) {
    fail(`Expected Electron ${TARGET_ELECTRON_VERSION}, found ${electronPackage.version}.`);
  }
  const electronDist = path.join(ROOT, 'build', 'electron-runtime');
  const electronExecutable = path.join(electronDist, 'electron');
  await assertElfX64(electronExecutable, 'Electron runtime');
  const runtimeManifest = await readJson(path.join(electronDist, 'runtime-manifest.json'), 'Electron runtime manifest');
  const releaseArchive = `electron-v${TARGET_ELECTRON_VERSION}-linux-x64.zip`;
  const checksums = await readJson(path.join(electronDirectory, 'checksums.json'), 'pinned Electron release checksums');
  const expectedElectronHash = checksums[releaseArchive];
  if (
    runtimeManifest.version !== TARGET_ELECTRON_VERSION ||
    runtimeManifest.archive !== releaseArchive ||
    runtimeManifest.archiveSha256 !== expectedElectronHash ||
    runtimeManifest.publishedSha256 !== expectedElectronHash ||
    runtimeManifest.executableSha256 !== await sha256File(electronExecutable)
  ) {
    fail('Downloaded Electron runtime does not match its checksum-verified official release archive.');
  }
  const electronVersionResult = run(electronExecutable, ['--version']);
  requireSuccess(electronVersionResult, 'Electron version check');
  if (!electronVersionResult.combined.includes(TARGET_ELECTRON_VERSION)) {
    fail(`Electron runtime reports ${electronVersionResult.combined.trim()}, expected ${TARGET_ELECTRON_VERSION}.`);
  }
  const electronArtifact = await verifyElectronArtifact();

  const droid = await inspectPinnedDroid();
  if (droid.version !== TARGET_DROID_CLI_VERSION) {
    fail(`Pinned Droid CLI ${droid.version} differs from the target ${TARGET_DROID_CLI_VERSION}.`);
  }
  const gates = await requirePreAssemblyGates(droid);

  const workDirectory = path.join(ROOT, 'build', `.assembly-${Date.now()}-${randomUUID()}`);
  const finalDirectory = distributionDirectory();
  if (await exists(finalDirectory)) fail(`Refusing to overwrite existing distribution directory: ${finalDirectory}`);
  await mkdir(workDirectory, { mode: 0o700 });
  const appWork = path.join(workDirectory, 'app');
  await cp(sourceApp, appWork, { recursive: true, errorOnExist: true });
  const sidecarFilesAdded = await mergeSidecar(`${sourceAppar}.unpacked`, appWork);

  const patchRecords = await applyPatches(appWork, TARGET_FACTORY_VERSION);
  const keytar = await runNativeRebuild(appWork);
  const securityInspection = await inspectSecurityAndRuntime(appWork);
  const { externalCallbackScheme: callbackScheme, rendererScheme } = await detectProtocolScheme(appWork);
  const iconSource = await findIcon(appWork);
  if (!iconSource) fail('No PNG or SVG application icon could be identified in the extracted app bundle.');

  const assembled = path.join(workDirectory, 'output');
  await mkdir(assembled, { recursive: true });
  await cp(electronDist, assembled, { recursive: true, errorOnExist: true });
  const copiedElectron = path.join(assembled, 'electron');
  const packagedElectron = path.join(assembled, 'factory-desktop');
  await rename(copiedElectron, packagedElectron);
  await chmod(packagedElectron, 0o755);

  const resources = path.join(assembled, 'resources');
  await mkdir(resources, { recursive: true });
  const appAsarPath = path.join(resources, 'app.asar');
  await asar.createPackageWithOptions(appWork, appAsarPath, {
    unpackDir: 'node_modules/keytar',
  });
  await mkdir(path.join(resources, 'bin'), { recursive: true });
  await copyFile(droid.path, path.join(resources, 'bin', 'droid'));
  await chmod(path.join(resources, 'bin', 'droid'), 0o755);
  await copyFile(iconSource, path.join(resources, `factory-desktop${path.extname(iconSource).toLowerCase()}`));
  await writeFile(path.join(resources, 'protocol-scheme'), `${callbackScheme}\n`, { mode: 0o644 });
  const iconPath = path.join(resources, `factory-desktop${path.extname(iconSource).toLowerCase()}`);

  const shellScripts = ['launch.sh', 'launch-test.sh'];
  for (const name of shellScripts) {
    await copyFile(path.join(ROOT, 'scripts', name), path.join(assembled, name));
    await chmod(path.join(assembled, name), 0o755);
  }
  const integrationDirectory = path.join(assembled, 'scripts');
  await mkdir(integrationDirectory);
  for (const name of [
    'install-desktop.sh',
    'rollback-desktop.sh',
    'desktop-integration.py',
    'keytar-secret-service-test.cjs',
  ]) {
    await copyFile(path.join(ROOT, 'scripts', name), path.join(integrationDirectory, name));
    await chmod(path.join(integrationDirectory, name), 0o755);
  }

  const inputFiles = [];
  for (const item of extractionManifest.inputFiles) {
    inputFiles.push({ name: item.name, sha256: item.sha256, size: item.size });
  }
  const buildManifest = {
    factoryVersion: TARGET_FACTORY_VERSION,
    electronVersion: TARGET_ELECTRON_VERSION,
    droidCliVersion: TARGET_DROID_CLI_VERSION,
    droidBundleMode: 'pinned-official-linux-package',
    toolchain: {
      packageJsonSha256: gates.toolchainManifest.packageJsonSha256,
      packageLockSha256: gates.toolchainManifest.packageLockSha256,
      nodeModulesFilesSha256: gates.toolchainManifest.nodeModulesFilesSha256,
    },
    electronArtifact,
    electronRuntime: {
      archive: runtimeManifest.archive,
      archiveSha256: runtimeManifest.archiveSha256,
      executableSha256: runtimeManifest.executableSha256,
      fileCount: runtimeManifest.runtimeFileCount,
    },
    architecture: 'x64',
    platform: 'linux',
    callbackScheme,
    rendererScheme,
    sourceFiles: inputFiles,
    installerProvenance: {
      path: path.relative(ROOT, provenancePath),
      sha256: provenance.sha256,
      size: provenance.size,
      contentType: provenance.responseHeaders?.['content-type'] ?? null,
      redirects: provenance.redirects ?? [],
      publisherSignature: provenance.publisherSignature ?? { status: 'unavailable' },
    },
    sourceAppAsarSha256: extractionManifest.appAsar.sha256,
    electronExecutableSha256: runtimeManifest.executableSha256,
    droid: {
      version: droid.version,
      sha256: droid.sha256,
      packageName: droid.packageName,
      packageResolved: droid.packageResolved,
      packageIntegrity: droid.packageIntegrity,
      supportedOptions: droid.supportedOptions,
    },
    keytar,
    keytarSidecarFileCount: sidecarFilesAdded,
    securityInspection,
    patches: patchRecords,
    icon: path.basename(iconPath),
    builtAt: new Date().toISOString(),
  };
  await writeFile(path.join(assembled, 'build-manifest.json'), `${JSON.stringify(buildManifest, null, 2)}\n`, { mode: 0o644 });
  await writeFile(path.join(assembled, 'BUILD_COMPLETE'), `${TARGET_FACTORY_VERSION} Electron ${TARGET_ELECTRON_VERSION}\n`, {
    flag: 'wx',
    mode: 0o644,
  });
  await checkSafeOutputTree(assembled);

  const currentDist = path.join(ROOT, 'dist');
  await mkdir(currentDist, { recursive: true });
  moveNoReplace(assembled, finalDirectory);
  await writeFile(path.join(workDirectory, 'assembly-manifest.json'), `${JSON.stringify({
    assembledAt: new Date().toISOString(),
    publishedTo: path.relative(ROOT, finalDirectory),
    gates: {
      cleanInstall: gates.cleanInstall.status,
      syntheticTests: gates.synthetic.status,
    },
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`Assembled portable app at ${path.relative(ROOT, finalDirectory)}.`);
  console.log(`Factory ${TARGET_FACTORY_VERSION}; Electron ${TARGET_ELECTRON_VERSION}; Droid ${droid.version}; callback ${callbackScheme}.`);
  console.log('No updater, installer, or desktop association was registered.');
}

main().catch((error) => {
  console.error(`build: ${error.message}`);
  process.exitCode = 1;
});
