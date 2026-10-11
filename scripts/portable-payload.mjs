// Shared portable-bundle verification and payload helpers used by both the
// Fedora RPM and Ubuntu .deb packaging pipelines. Keeping one implementation
// means both artifacts are gated by the exact same distribution checks.
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ROOT,
  TARGET_FACTORY_VERSION,
  fail,
  hashTreeWithModes,
  moveNoReplace,
  readJson,
  run,
  sha256File,
  walkDirectories,
  walkFiles,
} from './lib.mjs';
import { iconInstallPath } from './packaging-common.mjs';

export function readPackageVersion(manifest) {
  if (manifest.factoryVersion !== TARGET_FACTORY_VERSION ||
      manifest.architecture !== 'x64' || manifest.platform !== 'linux') {
    fail('Portable build manifest does not match the pinned Factory 0.194.0 Linux x64 target.');
  }
  return manifest.factoryVersion;
}

export async function findLatestVerificationReport(buildDirectory) {
  const files = (await walkFiles(buildDirectory))
    .filter((file) => /^verification-report-\d{4}-\d\d-\d\dT.*\.json$/.test(path.basename(file)))
    .sort((left, right) => left.localeCompare(right));
  if (!files.length) fail('No verification report exists. Run npm run verify immediately before packaging.');
  const reportPath = files.at(-1);
  return { reportPath, report: await readJson(reportPath, 'latest portable verification report') };
}

export async function verifyPortableDistribution(distribution, buildDirectory) {
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
      fail(`Setuid/setgid permissions are not allowed in the package payload: ${path.relative(distribution, file)}`);
    }
  }
  return { manifest, reportPath, report, treeSha256: await hashTreeWithModes(distribution) };
}

export async function readPortableIcon(distribution, manifest) {
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

export async function readElfDetails(distribution) {
  const sonames = new Set();
  const externalDependencies = new Set();
  const externalPaths = new Map();
  const elfFiles = [];
  const distributionRealPath = await realpath(distribution);
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
    const realFile = await realpath(file);
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
        if (!externalPaths.has(needed)) externalPaths.set(needed, resolved);
      }
    }
  }
  if (!elfFiles.length) fail('No ELF files were found in the portable bundle.');
  const ambiguous = [...sonames].filter((soname) => externalDependencies.has(soname));
  if (ambiguous.length) {
    fail(
      `Bundled library SONAMEs are also required from system paths; refusing ambiguous dependency filtering: ${
        ambiguous.join(', ')
      }`,
    );
  }
  return {
    elfFiles,
    sonames: [...sonames].sort(),
    externalDependencies: [...externalDependencies].sort(),
    externalPaths,
  };
}

export async function normalizePayloadDirectoryModes(payloadDirectory) {
  const directories = [payloadDirectory, ...await walkDirectories(payloadDirectory)];
  for (const directory of directories) {
    const details = await lstat(directory);
    if (!details.isDirectory() || (details.mode & 0o6000) !== 0) {
      fail(`Package payload directory has an unsafe type or mode: ${directory}`);
    }
    if ((details.mode & 0o7777) !== 0o755) await chmod(directory, 0o755);
  }
}

export async function assertLocalBuildWorkspace() {
  const buildDirectory = path.join(ROOT, 'build');
  const details = await lstat(buildDirectory).catch((error) => {
    if (error.code === 'ENOENT') fail(`Build workspace is missing: ${buildDirectory}`);
    throw error;
  });
  if (!details.isDirectory() || details.isSymbolicLink()) {
    fail(`Package workspace must be a regular workspace-local build directory: ${buildDirectory}`);
  }
  const rootRealPath = await realpath(ROOT);
  const buildRealPath = await realpath(buildDirectory);
  if (buildRealPath !== path.join(rootRealPath, 'build')) {
    fail(`Package workspace resolves outside the repository: ${buildDirectory}`);
  }
}

export async function assertSafeOutputDirectory(outputDirectory, expectedSubdirectory, { create = false } = {}) {
  const distDirectory = path.join(ROOT, 'dist');
  const distStat = await lstat(distDirectory).catch((error) => {
    if (error.code === 'ENOENT') fail(`Distribution root is missing: ${distDirectory}`);
    throw error;
  });
  if (!distStat.isDirectory() || distStat.isSymbolicLink()) {
    fail(`Package output parent is not a regular directory: ${distDirectory}`);
  }
  const realDistDirectory = await realpath(distDirectory);
  if (outputDirectory !== path.join(distDirectory, expectedSubdirectory)) {
    fail(`Unexpected package output directory: ${outputDirectory}`);
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
    fail(`Package output path exists and is not a regular directory: ${outputDirectory}`);
  }
  const realOutputDirectory = await realpath(outputDirectory);
  const relative = path.relative(realDistDirectory, realOutputDirectory);
  if (relative !== expectedSubdirectory) {
    fail(`Package output directory resolves outside dist/${expectedSubdirectory}: ${outputDirectory}`);
  }
}

export async function runIsolatedSandboxSmoke(extraction, workspace, bundleRoot) {
  if (process.env.FACTORY_SKIP_SANDBOX_SMOKE === '1') {
    console.log('Electron sandbox smoke check explicitly skipped through FACTORY_SKIP_SANDBOX_SMOKE=1.');
    return { status: 'skipped', reason: 'explicit-opt-out' };
  }
  const requiredTools = ['unshare', 'dbus-run-session', 'xvfb-run', 'xauth'];
  const missing = [];
  for (const command of requiredTools) {
    if (run('sh', ['-c', `command -v '${command}'`]).status !== 0) missing.push(command);
  }
  if (missing.length) {
    console.log(`Non-authenticated Electron smoke check skipped; missing ${missing.join(', ')}.`);
    return { status: 'skipped', missing };
  }

  const bundle = path.join(extraction, bundleRoot.slice(1));
  const launcher = path.join(bundle, 'launch-test.sh');
  const isolatedHome = path.join(workspace.workspace, 'smoke-home');
  await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
  const isolatedTmp = await mkdtemp('/tmp/factory-smoke-');
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
  try {
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
  } finally {
    clearTimeout(startupTimer);
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await rm(isolatedTmp, { recursive: true, force: true });
  }
}

export async function publishOutputs(packageSource, packagePath, checksumPath, packageSha256) {
  await assertSafeOutputDirectory(path.dirname(packagePath), path.basename(path.dirname(packagePath)), { create: true });
  let publishedPackage = false;
  let publishedIdentity = null;
  let checksumTemp;
  try {
    moveNoReplace(packageSource, packagePath);
    publishedPackage = true;
    publishedIdentity = await lstat(packagePath);
    checksumTemp = `${checksumPath}.tmp-${randomUUID()}`;
    await writeFile(checksumTemp, `${packageSha256}  ${path.basename(packagePath)}\n`, {
      flag: 'wx',
      mode: 0o644,
    });
    moveNoReplace(checksumTemp, checksumPath);
  } catch (error) {
    if (checksumTemp) await unlink(checksumTemp).catch(() => {});
    if (publishedPackage && publishedIdentity) {
      const currentIdentity = await lstat(packagePath).catch(() => null);
      if (
        currentIdentity &&
        currentIdentity.dev === publishedIdentity.dev &&
        currentIdentity.ino === publishedIdentity.ino &&
        await sha256File(packagePath).catch(() => '') === packageSha256
      ) {
        await unlink(packagePath).catch(() => {});
      }
    }
    throw error;
  }
}
