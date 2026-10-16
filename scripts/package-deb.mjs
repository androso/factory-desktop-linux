import { randomUUID } from 'node:crypto';
import {
  chmod, cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ROOT, TARGET_FACTORY_VERSION, distributionDirectory, exists,
  fail, hashTreeWithModes, moveNoReplace, readJson, run, sha256File,
  walkDirectories, walkFiles,
} from './lib.mjs';
import { detectBuildHost } from './host.mjs';
import {
  assertNoDebOutputCollisions, DEB_BUNDLE_ROOT, DEB_DESKTOP_PATH,
  DEB_INSTALL_HELPER_PATH, DEB_LICENSE_PATH, DEB_PACKAGE_NAME,
  DEB_REVISION, DEB_UPDATE_MANAGER_PATH, DEB_WRAPPER_PATH, debOutputPaths,
} from './deb.mjs';
import { createDesktopEntry, iconInstallPath, createSystemWrapper } from './rpm.mjs';
import { stageUpdaterRuntime } from './updater-runtime.mjs';

const NOTICE_PATH = path.join(ROOT, 'assets', 'rpm-personal-use-notice.txt');
const DEB_TIMEOUT = 20 * 60 * 1000;

async function validatePortableBundle(distribution) {
  const marker = await readFile(path.join(distribution, 'BUILD_COMPLETE'), 'utf8').catch(() => '');
  if (!marker.startsWith(`${TARGET_FACTORY_VERSION} Electron `)) {
    fail(`Portable bundle is incomplete or not Factory ${TARGET_FACTORY_VERSION}: ${distribution}`);
  }
  const manifestPath = path.join(distribution, 'build-manifest.json');
  const manifest = await readJson(manifestPath, 'portable build manifest');
  const withUpdater = process.env.PACKAGE_WITH_UPDATER === '1';
  const expectedMode = withUpdater ? 'managed-deb' : 'manual-only';
  if (manifest.factoryVersion !== TARGET_FACTORY_VERSION ||
      manifest.architecture !== 'x64' || manifest.platform !== 'linux' ||
      manifest.updaterMode !== expectedMode) {
    fail(`Portable build manifest does not match the Ubuntu DEB target (${expectedMode}).`);
  }
  const reports = (await walkFiles(path.join(ROOT, 'build')))
    .filter((file) => /^verification-report-\d{4}-\d\d-\d\dT.*\.json$/.test(path.basename(file)))
    .sort();
  if (!reports.length) fail('No portable verification report exists. Run npm run verify immediately before npm run package:deb.');
  const report = await readJson(reports.at(-1), 'latest portable verification report');
  if (report.distributionDirectory !== path.relative(ROOT, distribution) ||
      report.factoryVersion !== TARGET_FACTORY_VERSION ||
      report.buildManifestSha256 !== await sha256File(manifestPath) ||
      report.distributionTreeSha256 !== await hashTreeWithModes(distribution) ||
      !Array.isArray(report.checks) || report.checks.length === 0 ||
      report.failures?.length || report.checks.some((check) => check.status !== 'pass')) {
    fail('The latest portable verification report is stale or failed. Run npm run verify again.');
  }
  for (const file of await walkFiles(distribution)) {
    const details = await lstat(file);
    if (details.mode & 0o6000) fail(`Setuid/setgid mode is not allowed in the DEB payload: ${file}`);
  }
  return { manifest, withUpdater };
}

async function resolveIcon(distribution, manifest) {
  if (!/^factory-desktop\.(?:png|svg)$/.test(manifest.icon ?? '')) {
    fail(`Portable build manifest contains an unexpected app icon name: ${manifest.icon ?? 'missing'}.`);
  }
  const iconPath = path.join(distribution, 'resources', manifest.icon);
  const iconBytes = await readFile(iconPath).catch((error) => {
    fail(`Cannot read verified app icon ${manifest.icon}: ${error.message}`);
  });
  return { iconPath, iconBytes, ...iconInstallPath(manifest.icon, iconBytes) };
}

async function normalizeDirectories(root) {
  for (const directory of [root, ...await walkDirectories(root)]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.mode & 0o6000 || info.mode & 0o022) {
      fail(`DEB payload directory has unsafe type or permissions: ${directory}`);
    }
    if ((info.mode & 0o777) !== 0o755) await chmod(directory, 0o755);
  }
  for (const file of await walkFiles(root)) {
    const info = await lstat(file);
    if (info.mode & (0o6000 | 0o022)) {
      fail(`DEB payload file has unsafe permissions: ${file}`);
    }
  }
}

async function stagePackage(distribution, manifest, icon, withUpdater) {
  const workspace = await mkdtemp(path.join(ROOT, 'build', '.deb-workspace-'));
  console.log(`Staging DEB package in ${workspace}`);
  const packageRoot = path.join(workspace, 'root');
  const controlDirectory = path.join(packageRoot, 'DEBIAN');
  const bundle = path.join(packageRoot, DEB_BUNDLE_ROOT.slice(1));
  await mkdir(bundle, { recursive: true, mode: 0o755 });
  await cp(distribution, bundle, { recursive: true, errorOnExist: true });
  if (withUpdater) await stageUpdaterRuntime(bundle);

  const wrapper = path.join(packageRoot, DEB_WRAPPER_PATH.slice(1));
  const desktop = path.join(packageRoot, DEB_DESKTOP_PATH.slice(1));
  const notice = path.join(packageRoot, DEB_LICENSE_PATH.slice(1));
  const iconPath = path.join(packageRoot, icon.path.slice(1));
  await mkdir(path.dirname(wrapper), { recursive: true });
  await mkdir(path.dirname(desktop), { recursive: true });
  await mkdir(path.dirname(notice), { recursive: true });
  await mkdir(path.dirname(iconPath), { recursive: true });
  await writeFile(wrapper, createSystemWrapper(DEB_BUNDLE_ROOT), { mode: 0o755, flag: 'wx' });
  await writeFile(desktop, createDesktopEntry(), { mode: 0o644, flag: 'wx' });
  await cp(NOTICE_PATH, notice, { errorOnExist: true });
  await cp(icon.iconPath, iconPath, { errorOnExist: true });

  if (withUpdater) {
    const files = [
      [path.join(ROOT, 'scripts/factory-update-manager'), path.join(packageRoot, DEB_UPDATE_MANAGER_PATH.slice(1)), 0o755],
      [path.join(ROOT, 'scripts/install-helper.py'), path.join(packageRoot, DEB_INSTALL_HELPER_PATH.slice(1)), 0o755],
      [path.join(ROOT, 'scripts/factory-update-manager.service'), path.join(packageRoot, 'usr/lib/systemd/user/factory-update-manager.service'), 0o644],
      [path.join(ROOT, 'scripts/factory-update-manager.timer'), path.join(packageRoot, 'usr/lib/systemd/user/factory-update-manager.timer'), 0o644],
    ];
    for (const [source, destination, mode] of files) {
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { errorOnExist: true });
      await chmod(destination, mode);
    }
  }
  const dependencies = await readDependencies(bundle);
  if (withUpdater) {
    for (const command of ['/usr/bin/pkexec', '/usr/bin/systemctl', '/usr/bin/flock', '/usr/bin/python3']) {
      dependencies.push(packageOwningFile(command));
    }
  }
  const uniqueDependencies = [...new Set(dependencies)].sort();
  await normalizeDirectories(packageRoot);
  await mkdir(controlDirectory, { mode: 0o755 });
  const controlFields = [
    `Package: ${DEB_PACKAGE_NAME}`,
    `Version: ${TARGET_FACTORY_VERSION}-${DEB_REVISION}`,
    'Section: devel',
    'Priority: optional',
    'Architecture: amd64',
    `Depends: ${uniqueDependencies.join(', ')}`,
    `X-Factory-Build-Manifest-SHA256: ${await sha256File(path.join(distribution, 'build-manifest.json'))}`,
    `X-Factory-Updater: ${withUpdater ? 'yes' : 'no'}`,
    'Maintainer: Factory Desktop Linux Port <noreply@example.invalid>',
    'Description: Unofficial personal-use Factory Desktop Linux package',
    ' This proprietary application is not produced, endorsed, or supported by Factory.',
    ' This package is for personal use only and must not be published.',
    '',
  ].join('\n');
  await writeFile(path.join(controlDirectory, 'control'), controlFields, { mode: 0o644, flag: 'wx' });
  return {
    workspace, packageRoot, withUpdater,
  };
}

async function readDependencies(distribution, extraElfFiles = []) {
  const elfFiles = [...extraElfFiles];
  for (const file of await walkFiles(distribution)) {
    const handle = await open(file, 'r');
    const header = Buffer.alloc(4);
    let bytesRead;
    try { ({ bytesRead } = await handle.read(header, 0, 4, 0)); } finally { await handle.close(); }
    if (bytesRead === 4 && header.toString('hex') === '7f454c46') {
      assertElfX64Sync(file);
      elfFiles.push(file);
    }
  }
  if (!elfFiles.length) fail('No ELF files were found in the verified portable bundle.');
  const scratch = await mkdtemp(path.join(ROOT, 'build', '.deb-shlibdeps-'));
  try {
    const debianDirectory = path.join(scratch, 'debian');
    await mkdir(debianDirectory, { mode: 0o700 });
    await writeFile(path.join(debianDirectory, 'control'),
      `Source: factory-desktop-linux\nSection: devel\nPriority: optional\nMaintainer: Local build <noreply@example.invalid>\nStandards-Version: 4.6.2\n\nPackage: factory-desktop-linux\nArchitecture: amd64\nDescription: Local dependency analysis\n`, {
        flag: 'wx', mode: 0o600,
      });
    const libraryDirectories = [...new Set(elfFiles.map((file) => path.dirname(file)))];
    const args = [
      '-O', '--ignore-missing-info',
      ...libraryDirectories.map((directory) => `-l${directory}`),
      ...elfFiles.flatMap((file) => ['-e', file]),
    ];
    const result = spawnSync('dpkg-shlibdeps', args, {
      cwd: scratch, encoding: 'utf8', timeout: DEB_TIMEOUT, maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      fail(`dpkg-shlibdeps could not resolve the verified bundle dependencies:\n${result.stderr || result.error?.message}`);
    }
    const match = result.stdout.match(/shlibs:Depends=(.*)/);
    const dependencies = match?.[1]?.split(/,\s*/).filter(Boolean) ?? [];
    if (!dependencies.length) fail('dpkg-shlibdeps returned no runtime dependencies.');
    return [...new Set(dependencies)].sort();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function packageOwningFile(file) {
  const result = run('dpkg-query', ['-S', file]);
  if (result.status !== 0) {
    fail(`Could not map managed updater prerequisite ${file} to an Ubuntu package: ${result.combined}`);
  }
  const owners = result.stdout.split(/\r?\n/)
    .map((line) => line.match(/^([a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?):\s+/)?.[1])
    .filter(Boolean);
  if (!owners.length) fail(`No Ubuntu package owns required updater command ${file}.`);
  return owners[0];
}

function assertElfX64Sync(file) {
  const result = spawnSync('readelf', ['-h', file], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || !/Machine:\s+Advanced Micro Devices X86-64/.test(result.stdout)) {
    fail(`DEB payload contains a non-x86_64 or unreadable ELF: ${file}`);
  }
}

async function verifyDeb(debPath, staged, expectedIdentity) {
  const fields = run('dpkg-deb', ['-f', debPath], { encoding: 'utf8' });
  for (const expected of [
    `Package: ${DEB_PACKAGE_NAME}`,
    `Version: ${expectedIdentity}`,
    'Architecture: amd64',
    `X-Factory-Build-Manifest-SHA256: ${await sha256File(path.join(staged.packageRoot, 'opt/factory-desktop-linux/build-manifest.json'))}`,
    `X-Factory-Updater: ${staged.withUpdater ? 'yes' : 'no'}`,
  ]) {
    if (!fields.stdout.split(/\r?\n/).includes(expected)) fail(`DEB metadata omitted ${expected}.`);
  }
  const extracted = path.join(staged.workspace, 'extracted');
  await mkdir(extracted, { mode: 0o700 });
  const result = spawnSync('dpkg-deb', ['--extract', debPath, extracted], {
    encoding: 'utf8', timeout: DEB_TIMEOUT, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail(`Could not extract built DEB: ${result.stderr || result.error?.message}`);
  const actual = await walkFiles(extracted);
  const expected = await walkFiles(staged.packageRoot);
  const relative = (base, files) => files.map((file) => path.relative(base, file).split(path.sep).join('/')).sort();
  const actualPaths = relative(extracted, actual);
  const expectedPaths = relative(staged.packageRoot, expected)
    .filter((file) => !file.startsWith('DEBIAN/'));
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    fail('Built DEB payload does not match the staged package tree.');
  }
  for (const relativePath of expectedPaths) {
    const expectedFile = path.join(staged.packageRoot, relativePath);
    const actualFile = path.join(extracted, relativePath);
    const [expectedInfo, actualInfo] = await Promise.all([lstat(expectedFile), lstat(actualFile)]);
    if ((expectedInfo.mode & 0o7777) !== (actualInfo.mode & 0o7777) ||
        await sha256File(expectedFile) !== await sha256File(actualFile)) {
      fail(`Built DEB changed staged file bytes or permissions: ${relativePath}`);
    }
  }
  const desktopCheck = run('desktop-file-validate', [path.join(extracted, DEB_DESKTOP_PATH.slice(1))]);
  if (desktopCheck.status !== 0) fail(`DEB desktop entry is invalid: ${desktopCheck.combined}`);
  if (await hashTreeWithModes(path.join(extracted, DEB_BUNDLE_ROOT.slice(1))) !==
      await hashTreeWithModes(path.join(staged.packageRoot, DEB_BUNDLE_ROOT.slice(1)))) {
    fail('Built DEB changed portable application files or permissions.');
  }
}

async function assertOutputDirectory(outputDirectory) {
  const dist = path.join(ROOT, 'dist');
  const info = await lstat(dist).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) fail(`DEB output parent is not a regular directory: ${dist}`);
  if (outputDirectory !== path.join(dist, 'deb')) fail(`Unexpected DEB output directory: ${outputDirectory}`);
  const found = await lstat(outputDirectory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (found && (!found.isDirectory() || found.isSymbolicLink())) {
    fail(`DEB output path exists and is not a regular directory: ${outputDirectory}`);
  }
  if (found && await realpath(outputDirectory) !== path.join(await realpath(dist), 'deb')) {
    fail(`DEB output directory resolves outside dist/deb: ${outputDirectory}`);
  }
}

async function assertBuildDirectory() {
  const buildDirectory = path.join(ROOT, 'build');
  const info = await lstat(buildDirectory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    fail(`DEB build workspace must be a regular repository-local directory: ${buildDirectory}`);
  }
  if (await realpath(buildDirectory) !== path.join(await realpath(ROOT), 'build')) {
    fail(`DEB build workspace resolves outside the repository: ${buildDirectory}`);
  }
}

async function publish(source, outputPaths, sha256) {
  await assertOutputDirectory(path.dirname(outputPaths.debPath));
  await mkdir(path.dirname(outputPaths.debPath), { mode: 0o755 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await assertOutputDirectory(path.dirname(outputPaths.debPath));
  await assertNoDebOutputCollisions(outputPaths, exists);
  const temporary = path.join(path.dirname(outputPaths.debPath), `.publish-${randomUUID()}`);
  const checksumTemporary = `${temporary}.sha256`;
  try {
    await cp(source, temporary, { errorOnExist: true });
    await writeFile(checksumTemporary, `${sha256}  ${path.basename(outputPaths.debPath)}\n`, {
      flag: 'wx', mode: 0o644,
    });
    await moveNoReplace(temporary, outputPaths.debPath);
    await moveNoReplace(checksumTemporary, outputPaths.checksumPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    await rm(checksumTemporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function main() {
  const host = await detectBuildHost();
  if (!host.supported || !host.profile.debPackaging) {
    fail('DEB packaging supports Ubuntu 26.04 x86_64 only.');
  }
  await assertBuildDirectory();
  for (const command of ['dpkg-deb', 'dpkg-shlibdeps', 'desktop-file-validate', 'readelf']) {
    if (run('sh', ['-c', `command -v '${command}'`]).status !== 0) fail(`Missing required DEB packaging command: ${command}`);
  }
  const distribution = distributionDirectory();
  const { manifest, withUpdater } = await validatePortableBundle(distribution);
  const icon = await resolveIcon(distribution, manifest);
  if (withUpdater && manifest.updaterMode !== 'managed-deb') {
    fail('Managed DEB bundle mode is inconsistent.');
  }
  const staged = await stagePackage(distribution, manifest, icon, withUpdater);
  let succeeded = false;
  try {
    const outputDirectory = path.join(ROOT, 'dist', 'deb');
    const outputPaths = debOutputPaths(outputDirectory, {
      version: TARGET_FACTORY_VERSION,
      architecture: 'amd64',
    });
    await assertOutputDirectory(outputDirectory);
    await assertNoDebOutputCollisions(outputPaths, exists);
    const stagedDeb = path.join(staged.workspace, outputPaths.filename);
    const result = spawnSync('dpkg-deb', [
      '--build', '--root-owner-group', staged.packageRoot, stagedDeb,
    ], {
      cwd: staged.workspace,
      encoding: 'utf8',
      timeout: DEB_TIMEOUT,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      fail(`dpkg-deb failed (exit ${result.status}):\n${result.stderr || result.error?.message}`);
    }
    const identity = `${TARGET_FACTORY_VERSION}-${DEB_REVISION}`;
    await verifyDeb(stagedDeb, staged, identity);
    const sha256 = await sha256File(stagedDeb);
    await publish(stagedDeb, outputPaths, sha256);
    console.log(`Created Ubuntu 26.04 x86_64 personal-use DEB: ${path.relative(ROOT, outputPaths.debPath)}`);
    console.log(`SHA-256: ${sha256}`);
    succeeded = true;
  } finally {
    if (succeeded) await rm(staged.workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`package:deb: ${error.message}`);
  process.exitCode = 1;
});
