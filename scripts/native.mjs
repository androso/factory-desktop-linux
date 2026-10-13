import { randomUUID, createHash } from 'node:crypto';
import { cp, lstat, mkdir, open, readFile, readdir, readlink, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, exists, fail, hashTreeWithModes, readJson, sha256File } from './lib.mjs';
import { RPM_BUNDLE_ROOT, RPM_PACKAGE_NAME } from './rpm.mjs';
import { DEB_ARCHITECTURE, DEB_BUNDLE_ROOT, DEB_PACKAGE_NAME } from './deb.mjs';

export const SOURCE_INPUTS = [
  'package.json', 'package-lock.json', 'versions.json', 'Makefile',
  'assets', 'scripts', 'tests',
];
export const BUILD_STEPS = [
  'clean-install', 'check', 'check:native', 'test', 'acquire', 'extract',
  'electron:fetch', 'daemon:check', 'build', 'verify',
];

export function execute(command, args, { cwd = ROOT, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit',
    env: { ...process.env, FACTORY_DIST_NAME: 'factory-desktop-linux-native' },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed: ${result.error?.message ||
      result.stderr?.trim() || `exit ${result.status}`}`);
  }
  return result.stdout?.trim() ?? '';
}

export async function sourceFingerprint(root = ROOT) {
  const digest = createHash('sha256');
  for (const name of SOURCE_INPUTS) {
    digest.update(name).update('\0').update(await hashTreeWithModes(path.join(root, name)));
  }
  return digest.digest('hex');
}

export function parseIdentity(text) {
  const fields = text.trim().split('\t');
  if (fields.length !== 3 || fields[0] !== RPM_PACKAGE_NAME ||
      !/^\d+\.\d+\.\d+-[A-Za-z0-9._+]+$/.test(fields[1]) || fields[2] !== 'x86_64') {
    fail('Unexpected RPM package name, version/release, or architecture.');
  }
  return { name: fields[0], version: fields[1], architecture: fields[2] };
}

const IDENTITY_FORMAT = '%{NAME}\\t%{VERSION}-%{RELEASE}\\t%{ARCH}';
export function packageIdentity(file, run = execute) {
  return parseIdentity(run('rpm', ['-qp', '--qf', IDENTITY_FORMAT, file], { capture: true }));
}

export function installedIdentity() {
  const result = spawnSync('rpm', ['-q', '--qf', IDENTITY_FORMAT, RPM_PACKAGE_NAME], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.status === 1 && result.stdout?.includes('is not installed')) return null;
    fail(`Cannot query installed RPM: ${result.stderr || result.stdout}`);
  }
  return parseIdentity(result.stdout);
}

export function parseDebIdentity(text) {
  const fields = text.trim().split('\t');
  if (fields.length !== 3 || fields[0] !== DEB_PACKAGE_NAME ||
      !/^\d+\.\d+\.\d+-[A-Za-z0-9.+~]+$/.test(fields[1]) || fields[2] !== DEB_ARCHITECTURE) {
    fail('Unexpected Debian package name, version/revision, or architecture.');
  }
  return { name: fields[0], version: fields[1], architecture: fields[2] };
}

export function debPackageIdentity(file, run = execute) {
  // dpkg-deb prints "Field: value" lines when several fields are requested, so
  // query each field separately to get bare values.
  const fields = ['Package', 'Version', 'Architecture'].map((field) =>
    run('dpkg-deb', ['-f', file, field], { capture: true }).trim());
  return parseDebIdentity(fields.join('\t'));
}

export function installedDebIdentity() {
  const result = spawnSync('dpkg-query', [
    '-W', '-f=${Package}\\t${Version}\\t${Architecture}\\n', DEB_PACKAGE_NAME,
  ], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.trim()) {
    if (result.status === 1) return null;
    fail(`Cannot query installed .deb: ${result.stderr || result.stdout}`);
  }
  return parseDebIdentity(result.stdout);
}

export function installOperation(candidate, current, compare) {
  if (!current) return 'install';
  const order = compare(candidate.version, current.version);
  if (order < 0) return 'downgrade';
  if (order === 0) return 'reinstall';
  return 'install';
}

export function compareVersions(a, b) {
  // Identities are validated before being interpolated into RPM's Lua macro.
  parseIdentity(`${RPM_PACKAGE_NAME}\t${a}\tx86_64`);
  parseIdentity(`${RPM_PACKAGE_NAME}\t${b}\tx86_64`);
  const value = execute('rpm', ['--eval', `%{lua:print(rpm.vercmp("${a}", "${b}"))}`], { capture: true });
  if (!/^-?\d+$/.test(value)) fail('RPM version comparison failed.');
  return Number(value);
}

export function compareDebVersions(a, b) {
  parseDebIdentity(`${DEB_PACKAGE_NAME}\t${a}\t${DEB_ARCHITECTURE}`);
  parseDebIdentity(`${DEB_PACKAGE_NAME}\t${b}\t${DEB_ARCHITECTURE}`);
  const probe = (operator) => {
    const result = spawnSync('dpkg', ['--compare-versions', a, operator, b], { encoding: 'utf8' });
    if (result.error) throw result.error;
    return result.status;
  };
  if (probe('eq') === 0) return 0;
  if (probe('lt') === 0) return -1;
  if (probe('gt') === 0) return 1;
  fail('Debian version comparison failed.');
}

function rpmArtifactManifestSha256(file, run) {
  const manifestPath = path.join(RPM_BUNDLE_ROOT, 'build-manifest.json');
  const dump = run('rpm', ['-qp', '--dump', file], { capture: true })
    .split('\n').find((line) => line.startsWith(`${manifestPath} `));
  return dump?.split(/\s+/)[3] ?? null;
}

function debArtifactManifestSha256(file) {
  // Stream the data archive through tar and capture only the small manifest,
  // instead of buffering the whole (uncompressed) payload tar in memory.
  const member = `./${DEB_BUNDLE_ROOT.replace(/^\//, '')}/build-manifest.json`;
  const extracted = spawnSync('sh', [
    '-c', 'dpkg-deb --fsys-tarfile "$1" | tar -xO -- "$2"', 'sh', file, member,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  if (extracted.error) throw extracted.error;
  if (extracted.status !== 0 || !extracted.stdout) {
    fail('Cannot extract the build manifest from the .deb.');
  }
  return createHash('sha256').update(extracted.stdout).digest('hex');
}

export const rpmBackend = {
  id: 'rpm',
  packageName: RPM_PACKAGE_NAME,
  bundleRoot: RPM_BUNDLE_ROOT,
  artifactDirectory: 'rpm',
  artifactExtension: '.rpm',
  packageScript: 'package:rpm',
  installLabel: 'sudo dnf install',
  identityOf(file, run) { return packageIdentity(file, run); },
  installedIdentity() { return installedIdentity(); },
  compare(a, b) { return compareVersions(a, b); },
  manifestSha256FromArtifact(file, run) { return rpmArtifactManifestSha256(file, run); },
  verifyInstalled(run) { run('rpm', ['-V', RPM_PACKAGE_NAME], { capture: true }); },
  installCommand(operation, file) { return ['sudo', ['dnf', operation, '-y', file]]; },
};

export const debBackend = {
  id: 'deb',
  packageName: DEB_PACKAGE_NAME,
  bundleRoot: DEB_BUNDLE_ROOT,
  artifactDirectory: 'deb',
  artifactExtension: '.deb',
  packageScript: 'package:deb',
  installLabel: 'sudo apt-get install',
  identityOf(file, run) { return debPackageIdentity(file, run); },
  installedIdentity() { return installedDebIdentity(); },
  compare(a, b) { return compareDebVersions(a, b); },
  manifestSha256FromArtifact(file) { return debArtifactManifestSha256(file); },
  verifyInstalled(run) { run('dpkg', ['--verify', DEB_PACKAGE_NAME], { capture: true }); },
  installCommand(operation, file) {
    const extra = operation === 'reinstall'
      ? ['--reinstall']
      : operation === 'downgrade' ? ['--allow-downgrades'] : [];
    return ['sudo', ['apt-get', 'install', '-y', ...extra, file]];
  },
};

export function backendForHost(host) {
  if (host?.profile?.rpmPackaging) return rpmBackend;
  if (host?.profile?.debPackaging) return debBackend;
  return null;
}

async function processExecutable(
  directory,
  { readExecutable = readlink, readCommandLine = readFile } = {},
) {
  try {
    return (await readExecutable(path.join(directory, 'exe'))).replace(/ \(deleted\)$/, '');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    // Sandboxed helpers (a snap-confined agent, for example) keep their
    // executable unreadable. Fall back to the command line, which stays
    // readable for the same user, instead of ignoring a process that may
    // well be the app we are about to replace.
    if (error.code !== 'EACCES' && error.code !== 'EPERM' && error.code !== 'EINVAL') throw error;
  }
  let commandLine;
  try {
    commandLine = await readCommandLine(path.join(directory, 'cmdline'));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH' ||
        error.code === 'EACCES' || error.code === 'EPERM') return null;
    throw error;
  }
  const [command] = commandLine.toString('utf8').split('\0').filter(Boolean);
  return command ?? null;
}

export async function runningAppProcesses(
  procRoot = '/proc',
  uid = process.getuid(),
  {
    readdir: listProcesses = readdir,
    lstat: inspectProcess = lstat,
    readlink: readExecutable = readlink,
    readFile: readCommandLine = readFile,
  } = {},
) {
  const found = [];
  for (const entry of await listProcesses(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const directory = path.join(procRoot, entry.name);
    let processUid;
    try {
      processUid = (await inspectProcess(directory)).uid;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      throw error;
    }
    if (processUid !== uid) continue;

    let executable;
    try {
      executable = await processExecutable(directory, { readExecutable, readCommandLine });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      throw error;
    }
    if (!executable) continue;
    if (path.basename(executable) === 'factory-desktop' ||
        executable.startsWith('/opt/factory-desktop-linux/')) found.push(entry.name);
  }
  return found;
}

export async function assertAppClosed() {
  const processes = await runningAppProcesses();
  if (processes.length) fail(`Close Factory Desktop before installation (processes: ${processes.join(', ')}).`);
}

export function finishTransaction(state) {
  const { target, kind } = state.pending;
  return {
    ...state,
    installed: target,
    previous: state.installed && state.installed.sha256 !== target.sha256 ? state.installed : state.previous,
    blocked: kind === 'rollback' ? state.installed?.sha256 ?? null : null,
    pending: null,
  };
}

export class NativeWorkflow {
  constructor(root = ROOT, run = execute, {
    currentIdentity, compare, appClosed = assertAppClosed, backend = rpmBackend,
  } = {}) {
    this.root = root;
    this.run = run;
    this.backend = backend;
    this.directory = path.join(root, 'build', 'native');
    this.statePath = path.join(this.directory, 'state.json');
    this.currentIdentity = currentIdentity ?? (() => this.backend.installedIdentity());
    this.compare = compare ?? ((a, b) => this.backend.compare(a, b));
    this.appClosed = appClosed;
  }

  artifactPath(artifact) {
    return artifact?.packagePath ?? artifact?.rpmPath;
  }

  async readState() {
    if (!await exists(this.statePath)) return { schema: 1, ready: null, installed: null, previous: null, pending: null };
    const state = await readJson(this.statePath);
    if (state.schema !== 1) fail('Unsupported native workflow state. It was preserved.');
    return state;
  }

  async saveState(state) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.state-${randomUUID()}.json`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, this.statePath);
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async checkArtifact(artifact) {
    const packagePath = this.artifactPath(artifact);
    const relative = path.relative(this.directory, packagePath ?? '');
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('Package is outside the managed workspace.');
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '') ||
        await sha256File(packagePath) !== artifact.sha256) fail('Managed package checksum mismatch.');
    const identity = await this.backend.identityOf(packagePath, this.run);
    if (JSON.stringify(identity) !== JSON.stringify(artifact.identity)) fail('Managed package identity mismatch.');
    const manifestSha256 = await this.backend.manifestSha256FromArtifact(packagePath, this.run);
    if (manifestSha256 !== artifact.manifestSha256) fail('Managed package build manifest checksum mismatch.');
    return artifact;
  }

  async matchesInstalled(artifact) {
    if (!artifact) return false;
    const current = this.currentIdentity();
    if (!current || JSON.stringify(current) !== JSON.stringify(artifact.identity)) return false;
    if (await sha256File(path.join(this.backend.bundleRoot, 'build-manifest.json')).catch(() => null) !== artifact.manifestSha256) return false;
    this.backend.verifyInstalled(this.run);
    return true;
  }

  async build({ packageArtifact = false } = {}) {
    let state = await this.readState();
    if (state.pending) fail('An installation needs recovery. Run make recover first.');
    const fingerprint = await sourceFingerprint(this.root);
    if (state.ready?.sourceSha256 === fingerprint) {
      await this.checkArtifact(state.ready);
      console.log(`Reusing verified ${this.backend.id} package: ${this.artifactPath(state.ready)}`);
      return state.ready;
    }
    let workspace = state.portable?.sourceSha256 === fingerprint ? state.portable.workspace : null;
    if (workspace) {
      const relative = path.relative(path.join(this.directory, 'workspaces'), workspace);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('Portable workspace is outside the managed directory.');
      if (await sourceFingerprint(workspace) !== fingerprint) fail('Cached workspace source changed. It was preserved.');
      this.run('npm', ['run', 'verify'], { cwd: workspace });
      console.log(`Reusing verified portable app: ${workspace}`);
    } else {
      workspace = await this.assemble(fingerprint);
      state = { ...state, portable: { sourceSha256: fingerprint, workspace } };
      await this.saveState(state);
    }
    if (!packageArtifact) {
      console.log(`Verified portable app: ${path.join(workspace, 'dist', 'factory-desktop-linux-native')}`);
      return null;
    }
    const artifactDirectory = path.join(workspace, 'dist', this.backend.artifactDirectory);
    if (!await exists(artifactDirectory)) this.run('npm', ['run', this.backend.packageScript], { cwd: workspace });
    const artifacts = (await readdir(artifactDirectory)).filter((file) => file.endsWith(this.backend.artifactExtension));
    if (artifacts.length !== 1) fail('Expected exactly one verified package artifact.');
    const packagePath = path.join(artifactDirectory, artifacts[0]);
    const sha256 = await sha256File(packagePath);
    const checksum = await readFile(`${packagePath}.sha256`, 'utf8');
    if (checksum.trim() !== `${sha256}  ${path.basename(packagePath)}`) fail('Package sidecar checksum mismatch.');
    const artifact = {
      sourceSha256: fingerprint, packagePath, sha256,
      identity: await this.backend.identityOf(packagePath, this.run),
      manifestSha256: await sha256File(path.join(workspace, 'dist', 'factory-desktop-linux-native', 'build-manifest.json')),
      builtAt: new Date().toISOString(),
    };
    await this.checkArtifact(artifact);
    state = { ...state, ready: artifact };
    await this.saveState(state);
    console.log(`Ready: ${packagePath}`);
    return artifact;
  }

  async assemble(fingerprint) {
    const workspace = path.join(this.directory, 'workspaces', `${fingerprint.slice(0, 12)}-${randomUUID()}`);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    for (const name of SOURCE_INPUTS) {
      await cp(path.join(this.root, name), path.join(workspace, name), { recursive: true, errorOnExist: true });
    }
    if (await sourceFingerprint(workspace) !== fingerprint) fail('Source changed while staging. Retry the build.');
    // Reuse only the pinned installer and its provenance, never generated gates.
    const versions = await readJson(path.join(workspace, 'versions.json'));
    const input = path.join(this.root, 'inspection', versions.installer.filename);
    const hasInput = await exists(input);
    if (hasInput) {
      const provenance = await readJson(`${input}.provenance.json`);
      if (provenance.sha256 !== await sha256File(input) ||
          provenance.acquisitionUrl !== versions.installer.url || provenance.requestedVersion !== versions.factory) {
        fail('Cached installer does not match its pinned provenance. It was preserved.');
      }
      await mkdir(path.join(workspace, 'inspection'), { mode: 0o700 });
      await cp(input, path.join(workspace, 'inspection', versions.installer.filename), { errorOnExist: true });
      await cp(`${input}.provenance.json`, path.join(workspace, 'inspection', `${versions.installer.filename}.provenance.json`), { errorOnExist: true });
    }
    console.log(`Building pinned versions in ${workspace}`);
    for (const step of BUILD_STEPS) {
      if (step === 'acquire' && hasInput) continue;
      this.run('npm', ['run', step], { cwd: workspace });
    }
    return workspace;
  }

  async install({ rollback = false } = {}) {
    const state = await this.readState();
    if (state.pending) fail('An installation needs recovery. Run make recover first.');
    const target = rollback ? state.previous : state.ready;
    if (!target) fail(rollback ? 'No previous managed package is available.' : 'Run make rpm or make deb first.');
    await this.checkArtifact(target);
    if (!rollback && state.blocked === target.sha256) fail('This candidate was rolled back. Change the source before updating again.');
    if (await this.matchesInstalled(target)) {
      console.log('The verified target is already installed.');
      return;
    }
    if (state.installed && !await this.matchesInstalled(state.installed)) {
      fail('Installed package differs from managed state. No installation was attempted.');
    }
    if (state.installed) await this.checkArtifact(state.installed);
    await this.appClosed();
    const current = this.currentIdentity();
    const operation = installOperation(target.identity, current, this.compare);
    const baselineManifestSha256 = current
      ? await sha256File(path.join(this.backend.bundleRoot, 'build-manifest.json')) : null;
    if (current) this.backend.verifyInstalled(this.run);
    const pending = {
      ...state,
      pending: {
        target, kind: rollback ? 'rollback' : 'install',
        baseline: current, baselineManifestSha256,
        startedAt: new Date().toISOString(),
      },
    };
    await this.saveState(pending);
    const packagePath = this.artifactPath(target);
    console.log(`Installing through ${this.backend.installLabel} ${operation}. If interrupted, run make recover.`);
    const [command, args] = this.backend.installCommand(operation, packagePath);
    this.run(command, args, { cwd: this.root });
    if (!await this.matchesInstalled(target)) fail('Installed package verification failed. Run make recover.');
    await this.saveState(finishTransaction(pending));
    console.log('Installation verified. User data and callback registration were left unchanged.');
  }

  async recover() {
    const state = await this.readState();
    if (!state.pending) { console.log('No interrupted installation.'); return; }
    await this.appClosed();
    await this.checkArtifact(state.pending.target);
    if (await this.matchesInstalled(state.pending.target)) {
      await this.saveState(finishTransaction(state));
      console.log('Completed installation reconciled.');
    } else if (await this.matchesInstalled(state.installed) ||
        (!state.installed && await this.matchesBaseline(state.pending))) {
      await this.saveState({ ...state, pending: null });
      console.log('Package unchanged. You can retry installation.');
    } else {
      fail(`Package state is ambiguous. Inspect the ${this.backend.id} history and verification before repairing it. Artifacts were preserved.`);
    }
  }

  async matchesBaseline(pending) {
    const current = this.currentIdentity();
    if (!current && !pending.baseline) return true;
    if (!current || JSON.stringify(current) !== JSON.stringify(pending.baseline)) return false;
    if (await sha256File(path.join(this.backend.bundleRoot, 'build-manifest.json')).catch(() => null) !== pending.baselineManifestSha256) return false;
    this.backend.verifyInstalled(this.run);
    return true;
  }

  async updateCheckout() {
    const changes = this.run('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: this.root, capture: true });
    if (changes) fail('Update requires a clean checkout. Commit or preserve your changes, or use make install-native without pulling.');
    this.run('git', ['pull', '--ff-only'], { cwd: this.root });
    // Re-execute the updated entrypoint instead of using code loaded before pull.
    // The parent still owns the flock, so do not acquire a second lock here.
    this.run(process.execPath, [path.join(this.root, 'scripts', 'native-cli.mjs'), 'install'], { cwd: this.root });
  }
}
