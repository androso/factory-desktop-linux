import { randomUUID } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  readFile,
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
  await normalizePayloadModes(payloadDirectory);

  const wrapperPath = path.join(sources, RPM_PACKAGE_NAME);
  const desktopPath = path.join(sources, path.basename(RPM_DESKTOP_PATH));
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

async function assertSafeRpmOutputDirectory(outputDirectory, options) {
  return assertSafeOutputDirectory(outputDirectory, 'rpm', options);
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
    if (file.startsWith(`${RPM_BUNDLE_ROOT}/`) && mode.startsWith('-') &&
        !['-rw-r--r--', '-rwxr-xr-x'].includes(mode)) {
      fail(`RPM application files must be readable by normal users with mode 0644 or 0755: ${file} (${mode}).`);
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
  await assertSafeRpmOutputDirectory(outputDirectory);
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
  const smoke = await runIsolatedSandboxSmoke(extraction, workspace, RPM_BUNDLE_ROOT);
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
