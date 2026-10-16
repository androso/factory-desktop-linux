import { randomUUID, createHash } from 'node:crypto';
import { cp, lstat, mkdir, open, readFile, readdir, readlink, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, exists, fail, hashTreeWithModes, readJson, sha256File } from './lib.mjs';
import { RPM_PACKAGE_NAME, verifyInstalledRpm } from './rpm.mjs';

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
    const diagnostic = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join('\n');
    throw Object.assign(new Error(`${command} ${args.join(' ')} failed: ${
      result.error?.message || diagnostic || `exit ${result.status}`
    }`), {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    });
  }
  return result.stdout?.trim() ?? '';
}

export async function sourceFingerprint(root = ROOT, { updaterMode = false, packageFormat = 'rpm' } = {}) {
  const digest = createHash('sha256');
  for (const name of SOURCE_INPUTS) {
    digest.update(name).update('\0').update(await hashTreeWithModes(path.join(root, name)));
  }
  digest.update('\0updater-mode\0').update(updaterMode ? `managed-${packageFormat}` : 'manual-only');
  digest.update('\0package-format\0').update(packageFormat);
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

export async function runningAppProcesses(
  procRoot = '/proc',
  uid = process.getuid(),
  { readdir: listProcesses = readdir, lstat: inspectProcess = lstat, readlink: readExecutable = readlink } = {},
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
      executable = (await readExecutable(path.join(directory, 'exe'))).replace(/ \(deleted\)$/, '');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH' ||
          error.code === 'EACCES' || error.code === 'EPERM') continue;
      throw error;
    }
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
    currentIdentity, compare, appClosed = assertAppClosed, packageBackend,
    directory = path.join(root, 'build', 'native'),
  } = {}) {
    this.root = root;
    this.run = run;
    this.directory = directory;
    this.statePath = path.join(this.directory, 'state.json');
    this.backend = packageBackend ?? {
      format: 'rpm',
      extension: '.rpm',
      pathKey: 'rpmPath',
      packageName: RPM_PACKAGE_NAME,
      identity: (file) => packageIdentity(file, this.run),
      installedIdentity,
      compareVersions,
      manifestSha256: (file) => this.run('rpm', ['-qp', '--dump', file], { capture: true })
        .split('\n').find((line) => line.startsWith('/opt/factory-desktop-linux/build-manifest.json '))
        ?.split(/\s+/)[3] ?? null,
      hasUpdater: (file) => this.run('rpm', [
        '-qp', '--queryformat', '[%{FILENAMES}\\n]', file,
      ], { capture: true }).split('\n').includes('/usr/bin/factory-update-manager'),
      verifyInstalled: () => verifyInstalledRpm(this.run),
      installCommand: (operation, file) => ['sudo', ['dnf', operation, '-y', file]],
      operationLabel: (operation) => `sudo dnf ${operation}`,
    };
    this.currentIdentity = currentIdentity ?? this.backend.installedIdentity;
    this.compare = compare ?? this.backend.compareVersions;
    this.appClosed = appClosed;
  }

  async readState() {
    if (!await exists(this.statePath)) {
      return { schema: 2, ready: null, installed: null, previous: null, pending: null, blocked: null };
    }
    const state = await readJson(this.statePath);
    if (state.schema === 1) {
      // Preserve every artifact and transaction field while adding the updater
      // extension fields. The migration is written only by the next mutation.
      return { blocked: null, ...state, schema: 2 };
    }
    if (state.schema !== 2) fail('Unsupported native workflow state. It was preserved.');
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
    const packagePath = artifact?.[this.backend.pathKey] ??
      (this.backend.format === 'rpm' ? artifact?.rpmPath : null);
    const relative = path.relative(this.directory, packagePath ?? '');
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      fail(`Managed ${this.backend.format.toUpperCase()} is outside the managed workspace.`);
    }
    const artifactFormat = artifact.packageFormat ?? (artifact.rpmPath ? 'rpm' : this.backend.format);
    if (artifactFormat !== this.backend.format) {
      fail(`Managed ${artifactFormat.toUpperCase()} artifact cannot be used by the ${this.backend.format.toUpperCase()} workflow.`);
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '') ||
        await sha256File(packagePath) !== artifact.sha256) {
      fail(`Managed ${this.backend.format.toUpperCase()} checksum mismatch.`);
    }
    const identity = this.backend.identity(packagePath, this.run);
    if (JSON.stringify(identity) !== JSON.stringify(artifact.identity)) {
      fail(`Managed ${this.backend.format.toUpperCase()} identity mismatch.`);
    }
    if (this.backend.manifestSha256(packagePath, this.run) !== artifact.manifestSha256) {
      fail(`${this.backend.format.toUpperCase()} build manifest checksum mismatch.`);
    }
    return artifact;
  }

  async hasUpdaterArtifact(artifact) {
    if (!artifact) return false;
    if (typeof artifact.updater === 'boolean') return artifact.updater;
    const packagePath = artifact[this.backend.pathKey] ?? artifact.rpmPath;
    return this.backend.hasUpdater(packagePath, this.run);
  }

  async matchesInstalled(artifact) {
    if (!artifact) return false;
    const current = this.currentIdentity();
    if (!current || JSON.stringify(current) !== JSON.stringify(artifact.identity)) return false;
    if (await sha256File('/opt/factory-desktop-linux/build-manifest.json').catch(() => null) !== artifact.manifestSha256) return false;
    this.backend.verifyInstalled(this.run);
    return true;
  }

  async build({ packageRpm = false, packageDeb = false } = {}) {
    let state = await this.readState();
    if (state.pending) fail('An installation needs recovery. Run make recover first.');
    const updaterMode = process.env.PACKAGE_WITH_UPDATER === '1';
    const packageFormat = this.backend.format;
    const fingerprint = await sourceFingerprint(this.root, { updaterMode, packageFormat });
    if (state.ready?.sourceSha256 === fingerprint) {
      await this.checkArtifact(state.ready);
      console.log(`Reusing verified ${packageFormat.toUpperCase()}: ${
        state.ready[this.backend.pathKey] ?? state.ready.rpmPath
      }`);
      return state.ready;
    }
    let workspace = state.portable?.sourceSha256 === fingerprint ? state.portable.workspace : null;
    if (workspace) {
      const relative = path.relative(path.join(this.directory, 'workspaces'), workspace);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('Portable workspace is outside the managed directory.');
      if (await sourceFingerprint(workspace, { updaterMode, packageFormat }) !== fingerprint) {
        fail('Cached workspace source changed. It was preserved.');
      }
      this.run('npm', ['run', 'verify'], { cwd: workspace });
      console.log(`Reusing verified portable app: ${workspace}`);
    } else {
      workspace = await this.assemble(fingerprint, { updaterMode, packageFormat });
      state = { ...state, portable: { sourceSha256: fingerprint, workspace } };
      await this.saveState(state);
    }
    const packageRequested = packageFormat === 'rpm' ? packageRpm : packageDeb;
    if (!packageRequested) {
      console.log(`Verified portable app: ${path.join(workspace, 'dist', 'factory-desktop-linux-native')}`);
      return null;
    }
    const artifactDirectory = path.join(workspace, 'dist', packageFormat);
    if (!await exists(artifactDirectory)) {
      this.run('npm', ['run', `package:${packageFormat}`], { cwd: workspace });
    }
    const artifacts = (await readdir(artifactDirectory))
      .filter((file) => file.endsWith(this.backend.extension));
    if (artifacts.length !== 1) fail(`Expected exactly one verified ${packageFormat.toUpperCase()}.`);
    const packagePath = path.join(artifactDirectory, artifacts[0]);
    const sha256 = await sha256File(packagePath);
    const checksum = await readFile(`${packagePath}.sha256`, 'utf8');
    if (checksum.trim() !== `${sha256}  ${path.basename(packagePath)}`) {
      fail(`${packageFormat.toUpperCase()} sidecar checksum mismatch.`);
    }
    const artifact = {
      sourceSha256: fingerprint,
      packageFormat,
      [this.backend.pathKey]: packagePath,
      ...(packageFormat === 'rpm' ? { rpmPath: packagePath } : {}),
      sha256,
      identity: this.backend.identity(packagePath, this.run),
      manifestSha256: await sha256File(path.join(workspace, 'dist', 'factory-desktop-linux-native', 'build-manifest.json')),
      updater: await this.hasUpdaterArtifact({
        packageFormat, [this.backend.pathKey]: packagePath,
      }),
      builtAt: new Date().toISOString(),
    };
    await this.checkArtifact(artifact);
    state = { ...state, ready: artifact };
    await this.saveState(state);
    console.log(`Ready: ${packagePath}`);
    return artifact;
  }

  async assemble(fingerprint, { updaterMode = false, packageFormat = this.backend.format } = {}) {
    const workspace = path.join(this.directory, 'workspaces', `${fingerprint.slice(0, 12)}-${randomUUID()}`);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    for (const name of SOURCE_INPUTS) {
      await cp(path.join(this.root, name), path.join(workspace, name), { recursive: true, errorOnExist: true });
    }
    if (await sourceFingerprint(workspace, { updaterMode, packageFormat }) !== fingerprint) {
      fail('Source changed while staging. Retry the build.');
    }
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
    let state = await this.readState();
    if (state.pending) fail('An installation needs recovery. Run make recover first.');
    const target = rollback ? state.previous : state.ready;
    if (!target) {
      fail(rollback
        ? `No previous managed ${this.backend.format.toUpperCase()} is available.`
        : `Build a managed ${this.backend.format.toUpperCase()} first.`);
    }
    await this.checkArtifact(target);
    if (state.installed) await this.checkArtifact(state.installed);
    const targetWithUpdater = { ...target, updater: await this.hasUpdaterArtifact(target) };
    const installedWithUpdater = state.installed
      ? { ...state.installed, updater: await this.hasUpdaterArtifact(state.installed) }
      : null;
    state = {
      ...state,
      ...(rollback ? { previous: targetWithUpdater } : { ready: targetWithUpdater }),
      installed: installedWithUpdater,
    };
    if (!rollback && state.blocked === targetWithUpdater.sha256) fail('This candidate was rolled back. Change the source before updating again.');
    if (await this.matchesInstalled(targetWithUpdater)) {
      console.log('The verified target is already installed.');
      return;
    }
    if (state.installed && !await this.matchesInstalled(state.installed)) {
      fail('Installed package differs from managed state. No installation was attempted.');
    }
    await this.appClosed();
    const current = this.currentIdentity();
    const operation = installOperation(targetWithUpdater.identity, current, this.compare);
    let rollbackTimerWasEnabled = false;
    if (rollback && installedWithUpdater?.updater && !targetWithUpdater.updater) {
      try {
        rollbackTimerWasEnabled = this.run(
          'systemctl',
          ['--user', 'is-enabled', 'factory-update-manager.timer'],
          { cwd: this.root, capture: true },
        ).trim() === 'enabled';
      } catch {
        rollbackTimerWasEnabled = false;
      }
    }
    const baselineManifestSha256 = current
      ? await sha256File('/opt/factory-desktop-linux/build-manifest.json') : null;
    if (current) this.backend.verifyInstalled(this.run);
    const pending = {
      ...state,
      pending: {
        target: targetWithUpdater, kind: rollback ? 'rollback' : 'install',
        baseline: current, baselineManifestSha256,
        rollbackTimerWasEnabled,
        startedAt: new Date().toISOString(),
      },
    };
    await this.saveState(pending);
    if (rollbackTimerWasEnabled) {
      this.run('factory-update-manager', ['disable'], { cwd: this.root });
    }
    const packagePath = targetWithUpdater[this.backend.pathKey] ?? targetWithUpdater.rpmPath;
    const [command, args] = this.backend.installCommand(operation, packagePath);
    console.log(`Installing through ${this.backend.operationLabel(operation)}. If interrupted, run make recover.`);
    this.run(command, args, { cwd: this.root });
    if (!await this.matchesInstalled(targetWithUpdater)) fail('Installed package verification failed. Run make recover.');
    await this.saveState(finishTransaction(pending));
    console.log('Installation verified. User data and callback registration were left unchanged.');
    if (targetWithUpdater.updater === true) await this.setupUpdater();
  }

  async setupUpdater() {
    try {
      this.run('factory-update-manager', ['setup', this.statePath], { cwd: this.root });
      console.log('Managed state migrated and updater setup completed for this user.');
    } catch (error) {
      console.warn(`The package was installed, but updater setup did not complete: ${error.message}`);
      console.warn('Review factory-update-manager status, then run factory-update-manager setup with the managed state path.');
    }
  }

  async recover() {
    const state = await this.readState();
    if (!state.pending) { console.log('No interrupted installation.'); return; }
    await this.appClosed();
    await this.checkArtifact(state.pending.target);
    if (await this.matchesInstalled(state.pending.target)) {
      await this.saveState(finishTransaction(state));
      console.log('Completed installation reconciled.');
      if (state.pending.target.updater === true) await this.setupUpdater();
    } else if (await this.matchesInstalled(state.installed) ||
        (!state.installed && await this.matchesBaseline(state.pending))) {
      await this.saveState({ ...state, pending: null });
      if (state.pending.rollbackTimerWasEnabled && state.installed?.updater) {
        this.run('factory-update-manager', ['enable'], { cwd: this.root });
      }
      console.log('Package unchanged. You can retry installation.');
    } else {
      fail(`Package state is ambiguous. Inspect ${
        this.backend.format === 'rpm' ? 'dnf history and rpm -V' : 'dpkg status and dpkg --verify'
      } for factory-desktop-linux before repairing it. Artifacts were preserved.`);
    }
  }

  async matchesBaseline(pending) {
    const current = this.currentIdentity();
    if (!current && !pending.baseline) return true;
    if (!current || JSON.stringify(current) !== JSON.stringify(pending.baseline)) return false;
    if (await sha256File('/opt/factory-desktop-linux/build-manifest.json').catch(() => null) !== pending.baselineManifestSha256) return false;
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
