import { randomUUID } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import {
  ROOT,
  TARGET_FACTORY_VERSION,
  distributionDirectory,
  exists,
  fail,
  hashTreeWithModes,
  moveNoReplace,
  readJson,
  requireSuccess,
  run,
  sha256File,
  walkDirectories,
  walkFiles,
} from './lib.mjs';
import {
  detectBuildHost,
} from './host.mjs';
import {
  RPM_BUNDLE_ROOT,
  RPM_DESKTOP_PATH,
  RPM_LICENSE_PATH,
  RPM_PACKAGE_NAME,
  RPM_RELEASE,
  RPM_WRAPPER_PATH,
  assertNoRpmOutputCollisions,
  createDesktopEntry,
  createSystemWrapper,
  iconInstallPath,
  privateSonameExclusion,
  rpmPayloadLayout,
  rpmOutputPaths,
} from './rpm.mjs';

const SPEC_PATH = path.join(ROOT, 'scripts', 'factory-desktop-linux.spec');
const NOTICE_PATH = path.join(ROOT, 'assets', 'rpm-personal-use-notice.txt');
const RPM_TIMEOUT = 20 * 60 * 1000;

function readPackageVersion(manifest) {
  if (manifest.factoryVersion !== TARGET_FACTORY_VERSION ||
      manifest.architecture !== 'x64' || manifest.platform !== 'linux') {
    fail('Portable build manifest does not match the pinned Factory 0.194.0 Linux x64 target.');
  }
  return manifest.factoryVersion;
}

async function findLatestVerificationReport(buildDirectory) {
  const files = (await walkFiles(buildDirectory))
    .filter((file) => /^verification-report-\d{4}-\d\d-\d\dT.*\.json$/.test(path.basename(file)))
    .sort((left, right) => left.localeCompare(right));
  if (!files.length) fail('No verification report exists. Run npm run verify immediately before npm run package:rpm.');
  const reportPath = files.at(-1);
  return { reportPath, report: await readJson(reportPath, 'latest portable verification report') };
}

async function verifyPortableDistribution(distribution, buildDirectory) {
  const markerPath = path.join(distribution, 'BUILD_COMPLETE');
  const marker = await readFile(markerPath, 'utf8').catch(() => '');
  if (!marker.startsWith(`${TARGET_FACTORY_VERSION} Electron `)) {
    fail(`Portable bundle is incomplete or not Factory ${TARGET_FACTORY_VERSION}: ${distribution}`);
  }
  const manifestPath = path.join(distribution, 'build-manifest.json');
  const manifest = await readJson(manifestPath, 'portable build manifest');
  readPackageVersion(manifest);

  const { reportPath, report } = await findLatestVerificationReport(buildDirectory);
  if (report.distributionDirectory !== path.relative(ROOT, distribution)) {
    fail(`Latest verification report covers ${report.distributionDirectory ?? 'an unknown distribution'}, not ${
      path.relative(ROOT, distribution)
    }. Run npm run verify for the selected bundle.`);
  }
  if (report.factoryVersion !== TARGET_FACTORY_VERSION ||
      report.electronVersion !== manifest.electronVersion ||
      report.buildManifestSha256 !== await sha256File(manifestPath) ||
      report.distributionTreeSha256 !== await hashTreeWithModes(distribution) ||
      !Number.isFinite(Date.parse(report.checkedAt ?? '')) ||
      !Number.isFinite(Date.parse(manifest.builtAt ?? '')) ||
      Date.parse(report.checkedAt) < Date.parse(manifest.builtAt) ||
      !Array.isArray(report.checks) || report.checks.length === 0 ||
      report.failures?.length ||
      report.checks?.some((check) => check.status !== 'pass')) {
    fail(`The latest verification report is stale or failed: ${path.relative(ROOT, reportPath)}. Run npm run verify again.`);
  }
  const files = await walkFiles(distribution);
  if (!files.length) fail('The verified portable distribution contains no files.');
  for (const file of files) {
    const details = await lstat(file);
    if ((details.mode & 0o6000) !== 0) {
      fail(`Setuid/setgid permissions are not allowed in the RPM payload: ${path.relative(distribution, file)}`);
    }
  }
  return { manifest, reportPath, report, treeSha256: await hashTreeWithModes(distribution) };
}

async function readPortableIcon(distribution, manifest) {
  if (!/^factory-desktop\.(?:png|svg)$/.test(manifest.icon ?? '')) {
    fail(`Portable build manifest contains an unexpected app icon name: ${manifest.icon ?? 'missing'}.`);
  }
  const iconPath = path.join(distribution, 'resources', manifest.icon);
  const iconBytes = await readFile(iconPath).catch((error) => {
    fail(`Cannot read the verified app icon ${manifest.icon}: ${error.message}`);
  });
  const icon = iconInstallPath(manifest.icon, iconBytes);
  if (icon.extension === 'svg' && !iconBytes.toString('utf8').includes('<svg')) {
    fail('The bundled SVG application icon does not contain an SVG root element.');
  }
  return { iconPath, iconBytes, ...icon };
}

async function readElfDetails(distribution) {
  const sonames = new Set();
  const externalDependencies = new Set();
  const elfFiles = [];
  const distributionRealPath = await import('node:fs/promises').then(({ realpath }) => realpath(distribution));
  for (const file of await walkFiles(distribution)) {
    const handle = await import('node:fs/promises').then(({ open }) => open(file, 'r'));
    const header = Buffer.alloc(4);
    let bytesRead;
    try {
      ({ bytesRead } = await handle.read(header, 0, header.length, 0));
    } finally {
      await handle.close();
    }
    if (bytesRead !== 4 || header.toString('hex') !== '7f454c46') continue;
    elfFiles.push(file);
    const readelf = run('readelf', ['-d', file]);
    if (readelf.status !== 0 && !readelf.combined.includes('There is no dynamic section')) {
      fail(`Could not inspect ELF dependencies for ${path.relative(distribution, file)}: ${readelf.combined}`);
    }
    const fileSonames = [...readelf.combined.matchAll(/\(SONAME\)\s+Library soname:\s+\[([^\]]+)\]/g)]
      .map((match) => match[1]);
    const neededLibraries = [...readelf.combined.matchAll(/\(NEEDED\)\s+Shared library:\s+\[([^\]]+)\]/g)]
      .map((match) => match[1]);
    const ldd = run('ldd', [file]);
    if (ldd.status !== 0 && !ldd.combined.includes('not a dynamic executable')) {
      fail(`ldd failed for ${path.relative(distribution, file)}: ${ldd.combined}`);
    }
    if (ldd.combined.includes('not found')) {
      fail(`Missing shared library for ${path.relative(distribution, file)}: ${ldd.combined}`);
    }
    const realFile = await import('node:fs/promises').then(({ realpath }) => realpath(file));
    if (realFile.startsWith(`${distributionRealPath}${path.sep}`)) {
      for (const soname of fileSonames) sonames.add(soname);
    }
    const resolvedLibraries = new Map();
    for (const match of ldd.combined.matchAll(/^\s*(\S+)\s+=>\s+(\S+)/gm)) {
      resolvedLibraries.set(match[1], match[2]);
    }
    for (const match of ldd.combined.matchAll(/^\s*(\/\S+)\s+\(0x[0-9a-f]+\)/gim)) {
      resolvedLibraries.set(path.basename(match[1]), match[1]);
    }
    for (const needed of neededLibraries) {
      const resolved = resolvedLibraries.get(needed);
      if (!resolved) {
        fail(`Could not resolve direct ELF dependency ${needed} for ${path.relative(distribution, file)}.`);
      }
      if (resolved.startsWith(`${distributionRealPath}${path.sep}`)) {
        sonames.add(needed);
      } else {
        externalDependencies.add(needed);
      }
    }
  }
  if (!elfFiles.length) fail('No ELF files were found in the portable bundle.');
  const ambiguous = [...sonames].filter((soname) => externalDependencies.has(soname));
  if (ambiguous.length) {
    fail(
      `Bundled library SONAMEs are also required from system paths; refusing ambiguous RPM dependency filtering: ${
        ambiguous.join(', ')
      }`,
    );
  }
  return {
    elfFiles,
    sonames: [...sonames].sort(),
    externalDependencies: [...externalDependencies].sort(),
  };
}

async function normalizePayloadDirectoryModes(payloadDirectory) {
  const directories = [payloadDirectory, ...await walkDirectories(payloadDirectory)];
  for (const directory of directories) {
    const details = await lstat(directory);
    if (!details.isDirectory() || (details.mode & 0o6000) !== 0) {
      fail(`RPM payload directory has an unsafe type or mode: ${directory}`);
    }
    if ((details.mode & 0o7777) !== 0o755) await chmod(directory, 0o755);
  }
}

async function createWorkspace(distribution, icon) {
  const workspace = path.join(ROOT, 'build', `.rpm-workspace-${Date.now()}-${randomUUID()}`);
  const top = path.join(workspace, 'rpmbuild');
  const sources = path.join(top, 'SOURCES');
  const directories = [
    path.join(top, 'BUILD'),
    path.join(top, 'BUILDROOT'),
    path.join(top, 'RPMS'),
    sources,
    path.join(top, 'SPECS'),
    path.join(top, 'SRPMS'),
  ];
  for (const directory of directories) await mkdir(directory, { recursive: true, mode: 0o700 });

  const payloadDirectory = path.join(sources, 'payload');
  await cp(distribution, payloadDirectory, { recursive: true, errorOnExist: true });
  if (await hashTreeWithModes(payloadDirectory) !== await hashTreeWithModes(distribution)) {
    fail('Workspace copy changed bundle contents, permissions, or binary hashes.');
  }
  await normalizePayloadDirectoryModes(payloadDirectory);

  const wrapperPath = path.join(sources, RPM_PACKAGE_NAME);
  const desktopPath = path.join(sources, `${RPM_PACKAGE_NAME}.desktop`);
  const noticePath = path.join(sources, 'PERSONAL-USE-NOTICE.txt');
  await writeFile(wrapperPath, createSystemWrapper(RPM_BUNDLE_ROOT), { flag: 'wx', mode: 0o755 });
  await chmod(wrapperPath, 0o755);
  await writeFile(desktopPath, createDesktopEntry(), { flag: 'wx', mode: 0o644 });
  const stagedIcon = path.join(sources, 'factory-desktop-linux-icon');
  await writeFile(stagedIcon, icon.iconBytes, { flag: 'wx', mode: 0o644 });
  const specPath = path.join(top, 'SPECS', `${RPM_PACKAGE_NAME}.spec`);
  await cp(SPEC_PATH, specPath, { errorOnExist: true });
  await cp(NOTICE_PATH, noticePath, { errorOnExist: true });

  const expectedTreeSha256 = await hashTreeWithModes(payloadDirectory);
  return {
    workspace,
    top,
    sources,
    payloadDirectory,
    wrapperPath,
    desktopPath,
    noticePath,
    stagedIcon,
    specPath,
    iconTargetPath: icon.path,
    iconSize: icon.size,
    iconExtension: icon.extension,
    expectedTreeSha256,
  };
}

async function assertSafeOutputDirectory(outputDirectory, { create = false } = {}) {
  const distDirectory = path.join(ROOT, 'dist');
  const distStat = await lstat(distDirectory).catch((error) => {
    if (error.code === 'ENOENT') fail(`Distribution root is missing: ${distDirectory}`);
    throw error;
  });
  if (!distStat.isDirectory() || distStat.isSymbolicLink()) {
    fail(`RPM output parent is not a regular directory: ${distDirectory}`);
  }
  const realDistDirectory = await realpath(distDirectory);
  if (outputDirectory !== path.join(distDirectory, 'rpm')) {
    fail(`Unexpected RPM output directory: ${outputDirectory}`);
  }

  let outputStat = await lstat(outputDirectory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!outputStat) {
    if (!create) return;
    await mkdir(outputDirectory, { recursive: false, mode: 0o755 });
    outputStat = await lstat(outputDirectory);
  }
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    fail(`RPM output path exists and is not a regular directory: ${outputDirectory}`);
  }
  const realOutputDirectory = await realpath(outputDirectory);
  const relative = path.relative(realDistDirectory, realOutputDirectory);
  if (relative !== 'rpm') {
    fail(`RPM output directory resolves outside dist/rpm: ${outputDirectory}`);
  }
}

async function assertLocalBuildWorkspace() {
  const buildDirectory = path.join(ROOT, 'build');
  const details = await lstat(buildDirectory).catch((error) => {
    if (error.code === 'ENOENT') fail(`Build workspace is missing: ${buildDirectory}`);
    throw error;
  });
  if (!details.isDirectory() || details.isSymbolicLink()) {
    fail(`RPM workspace must be a regular workspace-local build directory: ${buildDirectory}`);
  }
  const rootRealPath = await realpath(ROOT);
  const buildRealPath = await realpath(buildDirectory);
  if (buildRealPath !== path.join(rootRealPath, 'build')) {
    fail(`RPM workspace resolves outside the repository: ${buildDirectory}`);
  }
}

function runRpmbuild(workspace, host, privateSonames) {
  const spec = path.join(workspace.top, 'SPECS', `${RPM_PACKAGE_NAME}.spec`);
  const args = [
    '--define', `_topdir ${workspace.top}`,
    '--define', `app_icon_size ${workspace.iconSize}`,
    '--define', `app_icon_extension ${workspace.iconExtension}`,
  ];
  const exclusion = privateSonameExclusion(privateSonames);
  if (exclusion) {
    args.push('--define', `__provides_exclude ${exclusion}`);
    args.push('--define', `__requires_exclude ${exclusion}`);
  }
  args.push('-bb', spec);
  const result = spawnSync('rpmbuild', args, {
    cwd: workspace.workspace,
    encoding: 'utf8',
    timeout: RPM_TIMEOUT,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`rpmbuild failed on ${host.profile.label} (exit ${result.status}):\n${(result.stdout ?? '') + (result.stderr ?? '')}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function rpmQuery(rpmPath, format) {
  const result = run('rpm', ['-qp', '--queryformat', format, rpmPath]);
  requireSuccess(result, `RPM query of ${path.basename(rpmPath)}`);
  return result.stdout;
}

async function extractRpm(rpmPath, destination) {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const rpm2cpio = spawn('rpm2cpio', [rpmPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const cpio = spawn('cpio', ['-idm', '--quiet', '--no-absolute-filenames'], {
    cwd: destination,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let rpm2cpioError = '';
  let cpioError = '';
  rpm2cpio.stderr.setEncoding('utf8').on('data', (chunk) => { rpm2cpioError += chunk; });
  cpio.stderr.setEncoding('utf8').on('data', (chunk) => { cpioError += chunk; });
  const [rpmExit, cpioExit, pipeResult] = await Promise.all([
    new Promise((resolve, reject) => {
      rpm2cpio.once('error', reject);
      rpm2cpio.once('close', resolve);
    }),
    new Promise((resolve, reject) => {
      cpio.once('error', reject);
      cpio.once('close', resolve);
    }),
    pipeline(rpm2cpio.stdout, cpio.stdin).then(() => null, (error) => error),
  ]);
  if (pipeResult) {
    fail(`Could not extract RPM payload: ${pipeResult.message}; ${rpm2cpioError}${cpioError}`);
  }
  if (rpmExit !== 0 || cpioExit !== 0) {
    fail(`RPM payload extraction failed (rpm2cpio=${rpmExit}, cpio=${cpioExit}): ${rpm2cpioError}${cpioError}`);
  }
}

async function validateRpmMetadata(
  rpmPath,
  expectedPaths,
  expectedFiles,
  privateSonames,
  externalDependencies,
) {
  const metadata = rpmQuery(rpmPath,
    '%{NAME}\\n%{VERSION}\\n%{RELEASE}\\n%{ARCH}\\n%{LICENSE}\\n%{SUMMARY}\\n');
  const [name, version, release, architecture, license, summary] = metadata.trimEnd().split('\n');
  const expectedRelease = `${RPM_RELEASE}${run('rpm', ['--eval', '%{?dist}']).stdout.trim()}`;
  if (
    name !== RPM_PACKAGE_NAME ||
    version !== TARGET_FACTORY_VERSION ||
    release !== expectedRelease ||
    architecture !== 'x86_64' ||
    license !== 'LicenseRef-Proprietary' ||
    !/unofficial|personal.use/i.test(summary)
  ) {
    fail(`RPM metadata does not match the Fedora 44 personal-use target:\n${metadata}`);
  }

  const files = rpmQuery(rpmPath, '[%{FILENAMES}\\n]').trim().split('\n').sort();
  const expectedSet = new Set(expectedPaths);
  const unexpected = files.filter((file) => !expectedSet.has(file));
  const missing = expectedPaths.filter((file) => !files.includes(file));
  if (unexpected.length || missing.length) {
    fail(`RPM file list does not match the expected installed layout.\nMissing:\n${missing.join('\n')}\nUnexpected:\n${unexpected.join('\n')}`);
  }

  const ownership = rpmQuery(rpmPath,
    '[%{FILENAMES}\\t%{FILEMODES:perms}\\t%{FILEUSERNAME}\\t%{FILEGROUPNAME}\\n]');
  for (const line of ownership.trimEnd().split('\n')) {
    const [file, mode, owner, group] = line.split('\t');
    if (owner !== 'root' || group !== 'root') {
      fail(`RPM file ownership is not root:root: ${line}`);
    }
    if (/\.node$|\/factory-desktop$|\/droid$|\/chrome-sandbox$/.test(file) &&
        /[sS]/.test(mode)) {
      fail(`RPM native/runtime payload has unexpected setuid/setgid mode: ${line}`);
    }
  }
  const modeFor = new Map(ownership.trimEnd().split('\n').map((line) => {
    const [file, mode] = line.split('\t');
    return [file, mode];
  }));
  for (const [file, mode] of modeFor) {
    if ((file === RPM_BUNDLE_ROOT || file.startsWith(`${RPM_BUNDLE_ROOT}/`)) &&
        mode.startsWith('d') && mode !== 'drwxr-xr-x') {
      fail(`RPM application directories must be accessible to normal users and not group/world-writable: ${file} (${mode}).`);
    }
  }
  if (modeFor.get(RPM_WRAPPER_PATH) !== '-rwxr-xr-x' ||
      modeFor.get(RPM_DESKTOP_PATH) !== '-rw-r--r--' ||
      modeFor.get(RPM_LICENSE_PATH) !== '-rw-r--r--' ||
      !modeFor.get(expectedFiles.find((item) => item.startsWith('/usr/share/icons/hicolor/')))
        ?.startsWith('-rw-r--r--')) {
    fail(`RPM wrapper, icon, desktop entry, or license notice has unexpected permissions:\n${ownership}`);
  }

  const provides = rpmQuery(rpmPath, '[%{PROVIDENAME}\\n]');
  for (const soname of privateSonames) {
    const escaped = soname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^${escaped}(?:\\([^)]*\\))*$`, 'm').test(provides)) {
      fail(`RPM incorrectly advertises bundled private library ${soname} as a package provide.`);
    }
  }
  const requires = rpmQuery(rpmPath, '[%{REQUIRENAME}\\n]');
  for (const dependency of externalDependencies) {
    if (!requires.includes(dependency)) {
      fail(`RPM metadata is missing a runtime requirement discovered by ldd: ${dependency}.`);
    }
  }
  for (const soname of privateSonames) {
    const escaped = soname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^${escaped}(?:\\([^)]*\\))*$`, 'm').test(requires)) {
      fail(`RPM has an unresolved requirement for bundled private library ${soname}.`);
    }
  }
  if (!requires.includes('libsecret-1.so.0')) {
    fail('RPM metadata does not declare the system libsecret runtime requirement for unpacked keytar.');
  }
  return { files, ownership, provides, requires };
}

async function validateExtractedPayload(rpmPath, workspace, expectedFiles, sourceHash, workspaceFiles) {
  const extraction = path.join(workspace.workspace, 'rpm-extracted');
  await extractRpm(rpmPath, extraction);
  const extractedBundle = path.join(extraction, RPM_BUNDLE_ROOT.slice(1));
  if (await hashTreeWithModes(extractedBundle) !== sourceHash) {
    fail('Extracted RPM application payload differs from the verified portable bundle, including file modes or hashes.');
  }
  const extractedPaths = (await walkFiles(extraction))
    .map((file) => `/${path.relative(extraction, file).split(path.sep).join('/')}`)
    .sort();
  if (JSON.stringify(extractedPaths) !== JSON.stringify([...expectedFiles].sort())) {
    fail(`Extracted RPM payload paths do not match the declared package layout:\n${extractedPaths.join('\n')}`);
  }

  const wrapper = await readFile(path.join(extraction, RPM_WRAPPER_PATH.slice(1)), 'utf8');
  const desktop = await readFile(path.join(extraction, RPM_DESKTOP_PATH.slice(1)), 'utf8');
  const notice = await readFile(path.join(extraction, RPM_LICENSE_PATH.slice(1)), 'utf8');
  if (!wrapper.includes(`exec '${RPM_BUNDLE_ROOT}/launch.sh' "$@"`) ||
      /--no-sandbox|chrome-sandbox.*chmod/i.test(wrapper) ||
      /^(?:MimeType|Actions)=/m.test(desktop) ||
      /(?:x-scheme-handler|factory-[a-z0-9.+-]+:)/i.test(desktop) ||
      !/unofficial/i.test(notice) ||
      !/personal.use/i.test(notice)) {
    fail('RPM wrapper, desktop integration, or proprietary personal-use notice is unsafe or incomplete.');
  }
  const standalonePairs = [
    [workspaceFiles.wrapperPath, path.join(extraction, RPM_WRAPPER_PATH.slice(1))],
    [workspaceFiles.desktopPath, path.join(extraction, RPM_DESKTOP_PATH.slice(1))],
    [workspaceFiles.noticePath, path.join(extraction, RPM_LICENSE_PATH.slice(1))],
    [workspaceFiles.stagedIcon, path.join(extraction, workspaceFiles.iconTargetPath.slice(1))],
  ];
  for (const [source, extracted] of standalonePairs) {
    if (await sha256File(source) !== await sha256File(extracted)) {
      fail(`Extracted RPM standalone payload does not match its staged source: ${path.basename(source)}.`);
    }
  }
  const validateDesktop = run('desktop-file-validate', [path.join(extraction, RPM_DESKTOP_PATH.slice(1))]);
  requireSuccess(validateDesktop, 'Desktop entry validation');
  return extraction;
}

async function runIsolatedSandboxSmoke(extraction, workspace) {
  const requiredTools = ['unshare', 'dbus-run-session', 'xvfb-run', 'xauth'];
  const missing = [];
  for (const command of requiredTools) {
    if (run('sh', ['-c', `command -v '${command}'`]).status !== 0) missing.push(command);
  }
  if (missing.length) {
    console.log(`Non-authenticated Electron smoke check skipped; missing ${missing.join(', ')}.`);
    return { status: 'skipped', missing };
  }

  const bundle = path.join(extraction, RPM_BUNDLE_ROOT.slice(1));
  const launcher = path.join(bundle, 'launch-test.sh');
  const isolatedHome = path.join(workspace.workspace, 'smoke-home');
  const isolatedTmp = path.join(workspace.workspace, 'smoke-tmp');
  await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
  await mkdir(isolatedTmp, { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: isolatedHome, TMPDIR: isolatedTmp };
  for (const key of Object.keys(env)) {
    if (
      /^(?:FACTORY_|DROID_)/.test(key) ||
      /^(?:http|https|all|no)_proxy$/i.test(key) ||
      /^(?:DBUS_SESSION_BUS_ADDRESS|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|SESSION_MANAGER)$/.test(key) ||
      /^(?:ELECTRON_|NODE_OPTIONS|CHROME_DEVEL_SANDBOX)$/.test(key)
    ) delete env[key];
  }
  Object.assign(env, { NO_COLOR: '1' });

  const args = [
    '--user',
    '--map-current-user',
    '--net',
    '--',
    'dbus-run-session',
    '--',
    'xvfb-run',
    '-a',
    launcher,
    '--no-first-run',
  ];
  const child = spawn('unshare', args, {
    cwd: isolatedHome,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let startupTimer;
  const startup = await Promise.race([
    exited.then((result) => ({ result })),
    new Promise((resolve) => {
      startupTimer = setTimeout(() => resolve({ stable: true }), 20_000);
    }),
  ]);
  clearTimeout(startupTimer);
  if (startup.result) {
    fail(
      `Electron exited before the 20-second sandbox smoke window ` +
      `(code=${startup.result.code}, signal=${startup.result.signal}):\n${stdout}${stderr}`,
    );
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  let shutdownTimer;
  const shutdown = await Promise.race([
    exited,
    new Promise((resolve) => {
      shutdownTimer = setTimeout(() => resolve(null), 5_000);
    }),
  ]);
  clearTimeout(shutdownTimer);
  if (!shutdown) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    await exited;
    fail('Electron sandbox smoke process did not stop after SIGTERM.');
  }

  const logPath = path.join(bundle, '.test', 'logs', 'electron.log');
  const log = await readFile(logPath, 'utf8').catch(() => '');
  const diagnostics = `${stdout}${stderr}\n${log}`;
  if (/No usable sandbox|Running as root without --no-sandbox|Failed to move to new namespace/i.test(diagnostics)) {
    fail(`Electron reported a sandbox blocker during the isolated smoke check:\n${diagnostics.slice(-6000)}`);
  }
  console.log('Non-authenticated Electron startup survived 20 seconds inside an isolated user+network namespace with normal sandboxing enabled.');
  return { status: 'pass', stderr: stderr.slice(-1000), stdout: stdout.slice(-1000) };
}

async function validateSystemTools(host) {
  const required = [
    'rpmbuild',
    'rpm',
    'rpm2cpio',
    'cpio',
    'readelf',
    'desktop-file-validate',
    'ldd',
  ];
  const missing = [];
  for (const command of required) {
    const result = run('sh', ['-c', `command -v '${command}'`]);
    if (result.status !== 0) missing.push(command);
  }
  if (missing.length) fail(`Missing Fedora RPM packaging tool(s) on ${host.profile.label}: ${missing.join(', ')}.`);
  const dist = run('rpm', ['--eval', '%{?dist}']).stdout.trim();
  if (dist !== '.fc44') fail(`Expected Fedora 44 RPM dist tag .fc44, found ${dist || 'unset'}.`);
}

async function publishOutputs(rpmSource, rpmPath, checksumPath, rpmSha256) {
  await assertNoRpmOutputCollisions({ rpmPath, checksumPath }, exists);
  await assertSafeOutputDirectory(path.dirname(rpmPath), { create: true });
  let publishedRpm = false;
  let publishedRpmIdentity = null;
  let checksumTemp;
  try {
    moveNoReplace(rpmSource, rpmPath);
    publishedRpm = true;
    publishedRpmIdentity = await lstat(rpmPath);
    checksumTemp = `${checksumPath}.tmp-${randomUUID()}`;
    await writeFile(checksumTemp, `${rpmSha256}  ${path.basename(rpmPath)}\n`, {
      flag: 'wx',
      mode: 0o644,
    });
    moveNoReplace(checksumTemp, checksumPath);
  } catch (error) {
    if (checksumTemp) await unlink(checksumTemp).catch(() => {});
    if (publishedRpm && publishedRpmIdentity) {
      const currentIdentity = await lstat(rpmPath).catch(() => null);
      if (
        currentIdentity &&
        currentIdentity.dev === publishedRpmIdentity.dev &&
        currentIdentity.ino === publishedRpmIdentity.ino &&
        await sha256File(rpmPath).catch(() => '') === rpmSha256
      ) {
        await unlink(rpmPath).catch(() => {});
      }
    }
    throw error;
  }
}

async function main() {
  const host = await detectBuildHost();
  if (!host.supported || host.profile?.id !== 'fedora' || host.profile?.version !== '44' ||
      host.nodeArchitecture !== 'x64') {
    fail('RPM packaging is restricted to Fedora 44 x86_64; other RPM distributions are not supported.');
  }
  await validateSystemTools(host);
  await assertLocalBuildWorkspace();

  const distribution = distributionDirectory();
  const buildDirectory = path.join(ROOT, 'build');
  const verification = await verifyPortableDistribution(distribution, buildDirectory);
  const icon = await readPortableIcon(distribution, verification.manifest);
  const elfDetails = await readElfDetails(distribution);
  const dist = run('rpm', ['--eval', '%{?dist}']).stdout.trim();
  const outputDirectory = path.join(ROOT, 'dist', 'rpm');
  const outputPaths = rpmOutputPaths(outputDirectory, {
    version: verification.manifest.factoryVersion,
    release: RPM_RELEASE,
    dist,
  });
  await assertSafeOutputDirectory(outputDirectory);
  await assertNoRpmOutputCollisions(outputPaths, exists);

  const workspace = await createWorkspace(distribution, icon);
  const layout = rpmPayloadLayout(
    (await walkFiles(distribution)).map((file) => path.relative(distribution, file)),
    icon.path,
    (await walkDirectories(distribution)).map((directory) => path.relative(distribution, directory)),
  );
  const buildOutput = runRpmbuild(workspace, host, elfDetails.sonames);
  const candidates = (await walkFiles(path.join(workspace.top, 'RPMS')))
    .filter((file) => file.endsWith('.rpm'));
  if (candidates.length !== 1) {
    fail(`Expected one RPM artifact from rpmbuild, found ${candidates.length}.\n${buildOutput}`);
  }
  const rpmSource = candidates[0];
  await validateRpmMetadata(
    rpmSource,
    layout.paths,
    layout.files,
    elfDetails.sonames,
    elfDetails.externalDependencies,
  );
  const extraction = await validateExtractedPayload(
    rpmSource,
    workspace,
    layout.files,
    workspace.expectedTreeSha256,
    workspace,
  );
  const smoke = await runIsolatedSandboxSmoke(extraction, workspace);
  const rpmSha256 = await sha256File(rpmSource);
  await publishOutputs(rpmSource, outputPaths.rpmPath, outputPaths.checksumPath, rpmSha256);

  console.log(`Created Fedora 44 x86_64 personal-use RPM: ${path.relative(ROOT, outputPaths.rpmPath)}`);
  console.log(`SHA-256: ${rpmSha256}`);
  console.log(`Verified bundle fingerprint: ${verification.treeSha256}`);
  console.log(`Electron sandbox smoke: ${smoke.status}`);
  console.log(`Build workspace retained at ${path.relative(ROOT, workspace.workspace)}.`);
  console.log('No RPM was installed and no callback association was registered.');
}

main().catch((error) => {
  console.error(`package:rpm: ${error.message}`);
  process.exitCode = 1;
});
