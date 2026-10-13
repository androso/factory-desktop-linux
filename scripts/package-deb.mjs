import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ROOT,
  TARGET_FACTORY_VERSION,
  distributionDirectory,
  exists,
  fail,
  hashTreeWithModes,
  requireSuccess,
  run,
  sha256File,
  walkDirectories,
  walkFiles,
} from './lib.mjs';
import { detectBuildHost } from './host.mjs';
import {
  assertLocalBuildWorkspace,
  assertSafeOutputDirectory,
  normalizePayloadModes,
  publishOutputs,
  readElfDetails,
  readPortableIcon,
  runIsolatedSandboxSmoke,
  verifyPortableDistribution,
} from './portable-payload.mjs';
import {
  DEB_BUNDLE_ROOT,
  DEB_COPYRIGHT_PATH,
  DEB_DESKTOP_PATH,
  DEB_MAINTAINER,
  DEB_PACKAGE_NAME,
  DEB_RELEASE,
  DEB_WRAPPER_PATH,
  assertNoDebOutputCollisions,
  createControlFile,
  createDesktopEntry,
  createSystemWrapper,
  debOutputPaths,
  debPayloadLayout,
  debianDependencies,
  debianInstalledSizeKiB,
  formatMd5sums,
} from './deb.mjs';

const NOTICE_PATH = path.join(ROOT, 'assets', 'deb-personal-use-notice.txt');
const DEB_TIMEOUT = 20 * 60 * 1000;

function md5File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function debianPackageOwner(resolvedPath) {
  // Symlinked system libraries (for example /lib64/ld-linux-x86-64.so.2) are
  // reported by dpkg -S as a diversion notice rather than an owner match, so
  // also query the canonical path and accept only real ownership lines.
  const candidates = [resolvedPath];
  try {
    const real = realpathSync(resolvedPath);
    if (real !== resolvedPath) candidates.push(real);
  } catch {
    // Fall back to the path exactly as ldd reported it.
  }
  for (const candidate of candidates) {
    const result = run('dpkg', ['-S', candidate]);
    for (const line of result.stdout.split('\n')) {
      const match = line.trim().match(/^([a-z0-9][a-z0-9+.-]*(?::[a-z0-9-]+)?):\s+\S/);
      if (match) return match[1];
    }
  }
  return null;
}

async function createWorkspace(distribution, icon, { version, depends }) {
  const workspace = path.join(ROOT, 'build', `.deb-workspace-${Date.now()}-${randomUUID()}`);
  const rootDirectory = path.join(workspace, 'root');
  const controlDirectory = path.join(rootDirectory, 'DEBIAN');
  const payloadDirectory = path.join(rootDirectory, DEB_BUNDLE_ROOT.slice(1));
  // dpkg-deb requires the control directory to be group/world readable
  // (0755..0775); create the package root and control directory accordingly.
  await mkdir(rootDirectory, { recursive: true, mode: 0o755 });
  await chmod(rootDirectory, 0o755);
  await mkdir(controlDirectory, { mode: 0o755 });
  await chmod(controlDirectory, 0o755);
  await mkdir(path.dirname(payloadDirectory), { recursive: true, mode: 0o755 });
  await cp(distribution, payloadDirectory, { recursive: true, errorOnExist: true });
  if (await hashTreeWithModes(payloadDirectory) !== await hashTreeWithModes(distribution)) {
    fail('Workspace copy changed bundle contents, permissions, or binary hashes.');
  }
  await normalizePayloadModes(payloadDirectory);
  await chmod(path.join(payloadDirectory, 'chrome-sandbox'), 0o4755);

  const wrapperPath = path.join(rootDirectory, DEB_WRAPPER_PATH.slice(1));
  const desktopPath = path.join(rootDirectory, DEB_DESKTOP_PATH.slice(1));
  const copyrightPath = path.join(rootDirectory, DEB_COPYRIGHT_PATH.slice(1));
  const stagedIcon = path.join(rootDirectory, icon.path.slice(1));
  for (const directory of [
    path.dirname(wrapperPath),
    path.dirname(desktopPath),
    path.dirname(copyrightPath),
    path.dirname(stagedIcon),
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o755 });
  }
  await writeFile(wrapperPath, createSystemWrapper(DEB_BUNDLE_ROOT), { flag: 'wx', mode: 0o755 });
  await chmod(wrapperPath, 0o755);
  await writeFile(desktopPath, createDesktopEntry(), { flag: 'wx', mode: 0o644 });
  await writeFile(stagedIcon, icon.iconBytes, { flag: 'wx', mode: 0o644 });
  await chmod(desktopPath, 0o644);
  await chmod(stagedIcon, 0o644);
  await cp(NOTICE_PATH, copyrightPath, { errorOnExist: true });
  await chmod(copyrightPath, 0o644);

  // mkdir modes are filtered through the caller's umask, so re-apply the
  // staging modes explicitly. dpkg-deb rejects a control directory that is not
  // group/world readable, and the delivered directories must stay 0755 even
  // when the build runs under a restrictive umask such as 0077.
  for (const directory of [rootDirectory, ...await walkDirectories(rootDirectory)]) {
    await chmod(directory, 0o755);
  }

  const dataFiles = (await walkFiles(rootDirectory))
    .filter((file) => !file.startsWith(`${controlDirectory}${path.sep}`));
  const md5Entries = [];
  let totalBytes = 0;
  for (const file of dataFiles) {
    totalBytes += (await lstat(file)).size;
    md5Entries.push({
      path: `/${path.relative(rootDirectory, file).split(path.sep).join('/')}`,
      md5: await md5File(file),
    });
  }
  const installedSizeKiB = debianInstalledSizeKiB(totalBytes);
  await writeFile(path.join(controlDirectory, 'control'), createControlFile({
    version: `${version}-${DEB_RELEASE}`,
    installedSizeKiB,
    depends,
  }), { flag: 'wx', mode: 0o644 });
  await writeFile(path.join(controlDirectory, 'md5sums'), formatMd5sums(md5Entries), { flag: 'wx', mode: 0o644 });
  await chmod(path.join(controlDirectory, 'control'), 0o644);
  await chmod(path.join(controlDirectory, 'md5sums'), 0o644);

  return {
    workspace,
    rootDirectory,
    controlDirectory,
    payloadDirectory,
    wrapperPath,
    desktopPath,
    copyrightPath,
    stagedIcon,
    iconTargetPath: icon.path,
    iconSize: icon.size,
    iconExtension: icon.extension,
    installedSizeKiB,
    expectedTreeSha256: await hashTreeWithModes(payloadDirectory),
  };
}

function runDpkgDeb(rootDirectory, outputPath) {
  const result = spawnSync('dpkg-deb', ['--threads-max=2', '--root-owner-group', '--build', rootDirectory, outputPath], {
    cwd: path.dirname(rootDirectory),
    encoding: 'utf8',
    timeout: DEB_TIMEOUT,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`dpkg-deb failed (exit ${result.status}):\n${(result.stdout ?? '') + (result.stderr ?? '')}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function debField(debPath, field) {
  const result = run('dpkg-deb', ['-f', debPath, field]);
  requireSuccess(result, `dpkg-deb field query of ${path.basename(debPath)}`);
  return result.stdout.trim();
}

function parseDebContents(debPath) {
  const result = run('dpkg-deb', ['-c', debPath]);
  requireSuccess(result, `dpkg-deb content listing of ${path.basename(debPath)}`);
  return result.stdout.split('\n').filter(Boolean).map((line) => {
    const fields = line.split(/\s+/);
    const size = Number.parseInt(fields[2], 10);
    const rawPath = fields.slice(5).join(' ');
    const portable = rawPath.replace(/^\.\//, '').replace(/\/+$/, '').replace(/^\.$/, '');
    return {
      type: fields[0]?.[0] ?? '',
      mode: fields[0] ?? '',
      owner: fields[1] ?? '',
      size: Number.isInteger(size) ? size : 0,
      path: portable ? `/${portable}` : '/',
    };
  });
}

async function extractDeb(debPath, destination, mode) {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const flag = mode === 'control' ? '--control' : '--extract';
  const result = run('dpkg-deb', [flag, debPath, destination]);
  requireSuccess(result, `dpkg-deb ${mode} extraction of ${path.basename(debPath)}`);
}

async function validateDebMetadata(debPath, expected) {
  const fields = {
    Package: DEB_PACKAGE_NAME,
    Version: `${expected.version}-${DEB_RELEASE}`,
    Architecture: 'amd64',
    Maintainer: DEB_MAINTAINER,
    'Installed-Size': String(expected.installedSizeKiB),
    Depends: expected.depends.join(', '),
    Section: 'devel',
    Priority: 'optional',
  };
  for (const [field, value] of Object.entries(fields)) {
    const observed = debField(debPath, field);
    if (observed !== value) {
      fail(`.deb ${field} is ${observed || '<empty>'}, expected ${value}.`);
    }
  }

  const entries = parseDebContents(debPath);
  if (!entries.length) fail('The .deb payload is empty.');
  if (entries.some((entry) => entry.type === 'l' || entry.type === 'c' || entry.type === 'b' || entry.type === 'p')) {
    fail('The .deb payload contains a symlink or special file.');
  }
  const files = entries.filter((entry) => entry.type === '-');
  const directories = entries.filter((entry) => entry.type === 'd');
  const expectedSet = new Set(expected.layout.files);
  const unexpected = files.map((entry) => entry.path).filter((file) => !expectedSet.has(file));
  const missing = expected.layout.files.filter((file) => !files.some((entry) => entry.path === file));
  if (unexpected.length || missing.length) {
    fail(
      `.deb file list does not match the expected installed layout.\nMissing:\n${missing.join('\n')}` +
      `\nUnexpected:\n${unexpected.join('\n')}`,
    );
  }
  const expectedDirectories = expected.layout.paths.filter((entry) => !expectedSet.has(entry));
  const observedDirectorySet = new Set(directories.map((entry) => entry.path));
  const missingDirectories = expectedDirectories.filter((directory) => !observedDirectorySet.has(directory));
  if (missingDirectories.length) {
    fail(`.deb is missing expected bundle directories:\n${missingDirectories.join('\n')}`);
  }

  for (const entry of entries) {
    if (entry.owner !== 'root/root') fail(`.deb entry is not owned by root:root: ${entry.path} (${entry.owner}).`);
    const underBundle = entry.path === DEB_BUNDLE_ROOT || entry.path.startsWith(`${DEB_BUNDLE_ROOT}/`);
    if (underBundle && entry.type === 'd' && entry.mode !== 'drwxr-xr-x') {
      fail(`.deb application directories must be normal-user accessible and not group/world writable: ${entry.path} (${entry.mode}).`);
    }
    if (underBundle && entry.type === '-' && entry.path !== `${DEB_BUNDLE_ROOT}/chrome-sandbox` &&
        !['-rw-r--r--', '-rwxr-xr-x'].includes(entry.mode)) {
      fail(`.deb application files must be readable by normal users with mode 0644 or 0755: ${entry.path} (${entry.mode}).`);
    }
    if (entry.path === `${DEB_BUNDLE_ROOT}/chrome-sandbox`) {
      if (entry.type !== '-' || entry.mode !== '-rwsr-xr-x') {
        fail(`.deb chrome-sandbox must have mode 4755: ${entry.mode}.`);
      }
    } else if (/[sS]/.test(entry.mode)) {
      fail(`.deb payload has unexpected setuid/setgid mode: ${entry.path} (${entry.mode}).`);
    }
  }
  const modeFor = new Map(entries.map((entry) => [entry.path, entry.mode]));
  if (modeFor.get(DEB_WRAPPER_PATH) !== '-rwxr-xr-x' ||
      modeFor.get(DEB_DESKTOP_PATH) !== '-rw-r--r--' ||
      modeFor.get(DEB_COPYRIGHT_PATH) !== '-rw-r--r--' ||
      !modeFor.get(expected.iconTargetPath)?.startsWith('-rw-r--r--')) {
    fail('.deb wrapper, icon, desktop entry, or copyright notice has unexpected permissions.');
  }

  const controlDirectory = path.join(expected.workspace.workspace, 'deb-control');
  await extractDeb(debPath, controlDirectory, 'control');
  const controlFiles = (await walkFiles(controlDirectory)).map((file) => path.basename(file)).sort();
  if (JSON.stringify(controlFiles) !== JSON.stringify(['control', 'md5sums'])) {
    fail(`.deb control section must contain only control and md5sums (no maintainer scripts): ${controlFiles.join(', ')}.`);
  }
  const control = await readFile(path.join(controlDirectory, 'control'), 'utf8');
  if (/^%post|^%preun|^%postun|^Requires:/m.test(control)) {
    fail('.deb control file contains unexpected RPM-style directives.');
  }
  return { entries, controlDirectory };
}

async function validateExtractedPayload(debPath, workspace, expectedFiles, sourceHash, controlDirectory) {
  const extraction = path.join(workspace.workspace, 'deb-extracted');
  await extractDeb(debPath, extraction, 'data');
  const extractedBundle = path.join(extraction, DEB_BUNDLE_ROOT.slice(1));
  if (await hashTreeWithModes(extractedBundle) !== sourceHash) {
    fail('Extracted .deb application payload differs from the verified portable bundle, including file modes or hashes.');
  }
  const wrapper = await readFile(path.join(extraction, DEB_WRAPPER_PATH.slice(1)), 'utf8');
  const desktop = await readFile(path.join(extraction, DEB_DESKTOP_PATH.slice(1)), 'utf8');
  const notice = await readFile(path.join(extraction, DEB_COPYRIGHT_PATH.slice(1)), 'utf8');
  if (!wrapper.includes(`exec '${DEB_BUNDLE_ROOT}/launch.sh' "$@"`) ||
      /--no-sandbox|chrome-sandbox.*chmod/i.test(wrapper) ||
      /^(?:MimeType|Actions)=/m.test(desktop) ||
      /(?:x-scheme-handler|factory-[a-z0-9.+-]+:)/i.test(desktop) ||
      !/unofficial/i.test(notice) ||
      !/personal.use/i.test(notice)) {
    fail('.deb wrapper, desktop integration, or proprietary personal-use notice is unsafe or incomplete.');
  }
  const standalonePairs = [
    [workspace.wrapperPath, path.join(extraction, DEB_WRAPPER_PATH.slice(1))],
    [workspace.desktopPath, path.join(extraction, DEB_DESKTOP_PATH.slice(1))],
    [workspace.copyrightPath, path.join(extraction, DEB_COPYRIGHT_PATH.slice(1))],
    [workspace.stagedIcon, path.join(extraction, workspace.iconTargetPath.slice(1))],
  ];
  for (const [source, extracted] of standalonePairs) {
    if (await sha256File(source) !== await sha256File(extracted)) {
      fail(`Extracted .deb standalone payload does not match its staged source: ${path.basename(source)}.`);
    }
  }

  const recorded = new Map();
  for (const line of (await readFile(path.join(controlDirectory, 'md5sums'), 'utf8')).split('\n').filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{32})  (.+)$/);
    if (!match) fail(`Malformed .deb md5sums line: ${line}`);
    recorded.set(`/${match[2]}`, match[1]);
  }
  if (recorded.size !== expectedFiles.length) {
    fail('.deb md5sums entry count does not match the installed payload.');
  }
  for (const file of expectedFiles) {
    const observed = recorded.get(file);
    if (!observed) fail(`.deb md5sums is missing ${file}.`);
    if (await md5File(path.join(extraction, file.slice(1))) !== observed) {
      fail(`.deb md5sums does not match the extracted payload for ${file}.`);
    }
  }
  const validateDesktop = run('desktop-file-validate', [path.join(extraction, DEB_DESKTOP_PATH.slice(1))]);
  requireSuccess(validateDesktop, 'Desktop entry validation');
  return extraction;
}

async function validateSystemTools(host) {
  const required = ['dpkg-deb', 'dpkg', 'dpkg-query', 'readelf', 'desktop-file-validate', 'ldd'];
  const missing = [];
  for (const command of required) {
    if (run('sh', ['-c', `command -v '${command}'`]).status !== 0) missing.push(command);
  }
  if (missing.length) fail(`Missing .deb packaging tool(s) on ${host.profile.label}: ${missing.join(', ')}.`);
}

async function main() {
  const host = await detectBuildHost();
  if (!host.supported || host.profile?.id !== 'ubuntu' || !host.profile?.debPackaging ||
      host.nodeArchitecture !== 'x64') {
    fail('Debian packaging is restricted to Ubuntu 24.04 or newer x86_64.');
  }
  await validateSystemTools(host);
  await assertLocalBuildWorkspace();

  const distribution = distributionDirectory();
  const buildDirectory = path.join(ROOT, 'build');
  const verification = await verifyPortableDistribution(distribution, buildDirectory);
  const version = verification.manifest.factoryVersion;
  if (version !== TARGET_FACTORY_VERSION) fail('Portable build manifest version changed unexpectedly.');
  const icon = await readPortableIcon(distribution, verification.manifest);
  const elfDetails = await readElfDetails(distribution);
  const depends = debianDependencies(
    elfDetails.externalDependencies,
    elfDetails.externalPaths,
    debianPackageOwner,
  );
  if (!depends.includes('libsecret-1-0')) {
    fail('Debian dependency set is missing libsecret-1-0 for the unpacked keytar module.');
  }

  const outputDirectory = path.join(ROOT, 'dist', 'deb');
  const outputPaths = debOutputPaths(outputDirectory, { version, release: DEB_RELEASE });
  await assertSafeOutputDirectory(outputDirectory, 'deb');
  await assertNoDebOutputCollisions(outputPaths, exists);

  const workspace = await createWorkspace(distribution, icon, { version, depends });
  const layout = debPayloadLayout(
    (await walkFiles(distribution)).map((file) => path.relative(distribution, file)),
    icon.path,
    (await walkDirectories(distribution)).map((directory) => path.relative(distribution, directory)),
  );

  const debSource = path.join(workspace.workspace, outputPaths.filename);
  const buildOutput = runDpkgDeb(workspace.rootDirectory, debSource);
  if (!await exists(debSource)) fail(`dpkg-deb did not produce an artifact.\n${buildOutput}`);
  const { controlDirectory } = await validateDebMetadata(debSource, {
    version,
    installedSizeKiB: workspace.installedSizeKiB,
    depends,
    layout,
    iconTargetPath: icon.path,
    workspace,
  });
  const extraction = await validateExtractedPayload(
    debSource,
    workspace,
    layout.files,
    workspace.expectedTreeSha256,
    controlDirectory,
  );
  const smoke = await runIsolatedSandboxSmoke(extraction, workspace, DEB_BUNDLE_ROOT);
  const debSha256 = await sha256File(debSource);
  await publishOutputs(debSource, outputPaths.debPath, outputPaths.checksumPath, debSha256);

  console.log(`Created Ubuntu x86_64 personal-use .deb: ${path.relative(ROOT, outputPaths.debPath)}`);
  console.log(`SHA-256: ${debSha256}`);
  console.log(`Verified bundle fingerprint: ${verification.treeSha256}`);
  console.log(`Runtime dependencies: ${depends.join(', ')}`);
  console.log(`Electron sandbox smoke: ${smoke.status}`);
  console.log(`Build workspace retained at ${path.relative(ROOT, workspace.workspace)}.`);
  console.log('No .deb was installed and no callback association was registered.');
}

main().catch((error) => {
  console.error(`package:deb: ${error.message}`);
  process.exitCode = 1;
});
