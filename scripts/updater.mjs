import { randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import {
  chmod, copyFile, cp, lstat, mkdir, open, readFile, rename, unlink, writeFile,
} from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  ROOT, exists, fail, fetchApprovedHttps, readJson, sha256File,
} from './lib.mjs';
import {
  assertAppClosed, compareVersions, finishTransaction, installedIdentity,
  NativeWorkflow, SOURCE_INPUTS,
} from './native.mjs';
import { detectPackageFormat, packageBackend } from './package-backend.mjs';

export const OFFICIAL_LATEST_URL = 'https://downloads.factory.ai/factory-desktop/LATEST';
export const FACTORY_DOWNLOAD_ORIGIN = 'https://downloads.factory.ai';
export const MAX_LATEST_BYTES = 256;
export const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
export const BACKOFF_BASE_MS = 15 * 60 * 1000;
export const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
export const BACKGROUND_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const POLICY_FRESHNESS_MS = 5 * 60 * 1000;
export const APP_INSTALL_LOCK = 'install.lock';
export const ROOT_INSTALL_HELPER = '/usr/libexec/factory-desktop-linux/install-helper';
const ALLOWED_ORIGINS = new Set([FACTORY_DOWNLOAD_ORIGIN]);
const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const verifiedNpmManifests = new Set();

export function parseLatestVersion(text) {
  if (typeof text !== 'string' || text.length > MAX_LATEST_BYTES) {
    fail('Factory LATEST response is missing or too large.');
  }
  const version = text.trim();
  if (!STABLE_VERSION.test(version)) {
    fail('Factory LATEST did not contain one stable numeric semantic version.');
  }
  return version;
}

export function compareFactoryVersions(left, right) {
  const parse = (version) => {
    if (!STABLE_VERSION.test(version ?? '')) fail(`Unsupported Factory release version: ${version ?? '<missing>'}.`);
    return version.split('.').map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function factoryInstallerUrl(version) {
  parseLatestVersion(version);
  return new URL(
    `factory-desktop/releases/${version}/win32/x64/Factory-${version}%20Setup.exe`,
    `${FACTORY_DOWNLOAD_ORIGIN}/`,
  ).toString();
}

export function candidateVersions(base, version) {
  const factory = parseLatestVersion(version);
  return {
    ...base,
    factory,
    installer: {
      filename: `Factory-${factory} Setup.exe`,
      url: factoryInstallerUrl(factory),
    },
  };
}

async function readBoundedBody(response, maximumBytes, label) {
  const announced = Number(response.headers.get('content-length') ?? 0);
  if (announced > maximumBytes) {
    await response.body?.cancel();
    fail(`${label} exceeded its ${maximumBytes}-byte transfer limit.`);
  }
  if (!response.body) fail(`${label} response had no body.`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximumBytes) fail(`${label} exceeded its ${maximumBytes}-byte transfer limit.`);
    chunks.push(Buffer.from(chunk));
  }
  if (announced && announced !== size) {
    fail(`${label} length mismatch: server announced ${announced} bytes, received ${size}.`);
  }
  return Buffer.concat(chunks, size);
}

export async function fetchLatestRelease({
  fetchImpl = globalThis.fetch,
  url = OFFICIAL_LATEST_URL,
  timeoutMs = 30_000,
} = {}) {
  const { response, current, redirects } = await fetchApprovedHttps(url, {
    fetchImpl,
    allowedOrigins: ALLOWED_ORIGINS,
    timeoutMs,
    cache: 'no-store',
    label: 'Factory updater request',
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    fail(`Factory LATEST returned HTTP ${response.status}.`);
  }
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    await response.body?.cancel();
    fail('Factory LATEST returned an HTML response.');
  }
  const bytes = await readBoundedBody(response, MAX_LATEST_BYTES, 'Factory LATEST');
  const version = parseLatestVersion(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  return {
    version,
    url: current.toString(),
    redirects,
    lastModified: response.headers.get('last-modified'),
    checkedAt: new Date().toISOString(),
  };
}

export function backoffDelay(failureCount) {
  const exponent = Math.max(0, Math.min(20, Math.floor(failureCount) - 1));
  return Math.min(BACKOFF_BASE_MS * (2 ** exponent), BACKOFF_MAX_MS);
}

export function defaultUpdaterState() {
  return {
    schema: 1,
    phase: 'Idle',
    policy: null,
    backgroundChecksDisabled: false,
    latestVersion: null,
    latestRecord: null,
    lastCheckAt: null,
    failureCount: 0,
    nextCheckAt: null,
    error: null,
    authorizationDeferredSha256: null,
    pendingAction: null,
    handoff: null,
    updatedAt: null,
  };
}

function directoryFor(env, variable, suffix, home) {
  const explicit = env[variable];
  if (explicit) {
    if (!path.isAbsolute(explicit)) fail(`${variable} must be an absolute path.`);
    return path.resolve(explicit);
  }
  const xdg = env[variable === 'FACTORY_UPDATE_STATE_HOME' ? 'XDG_STATE_HOME' : 'XDG_CACHE_HOME'] ||
    path.join(home, variable === 'FACTORY_UPDATE_STATE_HOME' ? '.local/state' : '.cache');
  return path.join(xdg, 'factory-desktop-linux', suffix);
}

export function updaterStateDirectory(env = process.env, home = os.homedir()) {
  return directoryFor(env, 'FACTORY_UPDATE_STATE_HOME', 'updater', home);
}

export function updaterCacheDirectory(env = process.env, home = os.homedir()) {
  return directoryFor(env, 'FACTORY_UPDATE_CACHE_HOME', 'updater', home);
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) {
    fail(`Updater directory is not a private user-owned directory: ${directory}.`);
  }
  if ((info.mode & 0o077) !== 0) {
    const { chmod } = await import('node:fs/promises');
    await chmod(directory, 0o700);
  }
}

async function atomicJsonWrite(filePath, value) {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.state-${randomUUID()}.json`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  const directoryHandle = await open(directory, 'r');
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
}

export function updaterCommandEnvironment(command, environment = process.env) {
  const next = {
    ...environment,
    PACKAGE_WITH_UPDATER: '1',
    PACKAGE_FORMAT: environment.PACKAGE_FORMAT || detectPackageFormat(),
  };
  if (command === 'npm') next.FACTORY_DIST_NAME = 'factory-desktop-linux-native';
  return next;
}

function quietExecute(command, args, { cwd = ROOT, capture = false } = {}) {
  const npmCli = process.env.FACTORY_UPDATE_NPM_CLI;
  if (command === 'npm' && npmCli) {
    const manifest = process.env.FACTORY_UPDATE_NPM_MANIFEST;
    if (!manifest) fail('The bundled npm integrity manifest is missing.');
    if (!verifiedNpmManifests.has(manifest)) {
      const verification = spawnSync('/usr/bin/sha256sum', [
        '--check', '--status', path.basename(manifest),
      ], {
        cwd: path.dirname(manifest),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 1024 * 1024,
      });
      if (verification.error || verification.status !== 0) {
        fail(`The bundled npm package failed its checksum check: ${
          verification.error?.message || verification.stderr?.trim() || `exit ${verification.status}`
        }`);
      }
      verifiedNpmManifests.add(manifest);
    }
  }
  const actualCommand = command === 'npm' && npmCli ? process.execPath : command;
  const actualArgs = command === 'npm' && npmCli ? [npmCli, ...args] : args;
  const result = spawnSync(actualCommand, actualArgs, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: updaterCommandEnvironment(command),
    timeout: 60 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  }
  return result.stdout?.trim() ?? '';
}

function packageFactoryVersion(identity) {
  const match = identity?.version?.match(/^(\d+\.\d+\.\d+)-/);
  return match?.[1] ?? null;
}

function cleanMessage(error) {
  return String(error?.message ?? error ?? 'Unknown updater failure').replaceAll('\0', '').slice(0, 700);
}

function runInstaller(packagePath, sha256, {
  helper = ROOT_INSTALL_HELPER,
  pkexec = '/usr/bin/pkexec',
  spawnImpl = spawn,
  format = detectPackageFormat(),
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(pkexec, [
      helper,
      format === 'deb' ? '--deb' : '--rpm',
      packagePath,
      '--sha256', sha256,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk) => {
      if (stdout.length < 8000) stdout += chunk.slice(0, 8000 - stdout.length);
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => {
      if (stderr.length < 8000) stderr += chunk.slice(0, 8000 - stderr.length);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export class FactoryUpdater {
  constructor({
    recipesRoot = ROOT,
    stateDirectory = updaterStateDirectory(),
    cacheDirectory = updaterCacheDirectory(),
    fetchImpl = globalThis.fetch,
    currentIdentity = installedIdentity,
    compare = compareVersions,
    packageBackend: selectedBackend,
    appClosed = assertAppClosed,
    execute = quietExecute,
    workflowFactory,
    buildCandidate,
    backgroundInstall,
    installer = runInstaller,
    backgroundUpdatesEnabled,
    disableBackgroundUpdates,
    enableBackgroundUpdates,
    authAvailable = () => Boolean(
      (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) &&
      process.platform === 'linux' &&
      existsSync('/usr/bin/pkexec') &&
      existsSync(ROOT_INSTALL_HELPER),
    ),
    now = () => new Date(),
  } = {}) {
    this.recipesRoot = recipesRoot;
    this.stateDirectory = stateDirectory;
    this.cacheDirectory = cacheDirectory;
    this.fetchImpl = fetchImpl;
    this.backend = selectedBackend ?? packageBackend();
    this.currentIdentity = currentIdentity === installedIdentity && this.backend.format === 'deb'
      ? this.backend.installedIdentity
      : currentIdentity ?? this.backend.installedIdentity;
    this.compare = compare === compareVersions && this.backend.format === 'deb'
      ? this.backend.compareVersions
      : compare ?? this.backend.compareVersions;
    this.appClosed = appClosed;
    this.execute = execute;
    this.workflowFactory = workflowFactory;
    this.buildCandidateOverride = buildCandidate;
    this.backgroundInstall = backgroundInstall;
    this.installer = installer;
    this.backgroundUpdatesEnabled = backgroundUpdatesEnabled;
    this.disableBackgroundUpdates = disableBackgroundUpdates;
    this.enableBackgroundUpdates = enableBackgroundUpdates;
    this.authAvailable = authAvailable;
    this.now = now;
    this.managerStatePath = path.join(stateDirectory, 'updater-state.json');
    this.nativeStateDirectory = path.join(stateDirectory, 'native');
  }

  workflow(root = this.recipesRoot) {
    if (this.workflowFactory) return this.workflowFactory(root, this.nativeStateDirectory);
    return new NativeWorkflow(root, this.execute, {
      currentIdentity: this.currentIdentity,
      compare: this.compare,
      appClosed: this.appClosed,
      packageBackend: this.backend,
      directory: this.nativeStateDirectory,
    });
  }

  async readManagerState() {
    await ensurePrivateDirectory(this.stateDirectory);
    if (!await exists(this.managerStatePath)) return defaultUpdaterState();
    const info = await lstat(this.managerStatePath);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()) {
      fail('Updater state is not a regular user-owned file. It was preserved.');
    }
    const state = await readJson(this.managerStatePath, 'updater state');
    if (state.schema !== 1) fail('Unsupported updater state schema. It was preserved.');
    return { ...defaultUpdaterState(), ...state };
  }

  async saveManagerState(patch) {
    const current = await this.readManagerState();
    const next = { ...current, ...patch, updatedAt: this.now().toISOString() };
    await atomicJsonWrite(this.managerStatePath, next);
    return next;
  }

  async setPolicy({ hostedServicesEnabled, airgapEnabled, organizationUpdatesDisabled }) {
    for (const [name, value] of Object.entries({
      hostedServicesEnabled, airgapEnabled, organizationUpdatesDisabled,
    })) {
      if (typeof value !== 'boolean') fail(`Updater policy field ${name} must be boolean.`);
    }
    const policy = {
      hostedServicesEnabled,
      airgapEnabled,
      organizationUpdatesDisabled,
      synchronizedAt: this.now().toISOString(),
    };
    const blocked = !hostedServicesEnabled || airgapEnabled || organizationUpdatesDisabled;
    const managerState = await this.readManagerState();
    const next = await this.saveManagerState({
      policy,
      ...(blocked ? { phase: 'Blocked', error: 'Updates are restricted by Factory or organization policy.' } : {}),
      ...(!blocked && managerState.phase === 'Blocked' &&
        (managerState.error === 'Updates are restricted by Factory or organization policy.' ||
          managerState.error?.startsWith('Updater policy has not been synchronized') ||
          managerState.error?.startsWith('Updater policy synchronization is stale'))
        ? { phase: 'Idle', error: null } : {}),
    });
    return this.publicStatus(next);
  }

  async assertPolicyAllowed({ requireFresh = true } = {}) {
    const state = await this.readManagerState();
    if (!state.policy) fail('Updater policy has not been synchronized by Factory Desktop. Open the app before checking for updates.');
    if (!state.policy.hostedServicesEnabled || state.policy.airgapEnabled ||
        state.policy.organizationUpdatesDisabled) {
      fail('Updates are restricted by Factory or organization policy.');
    }
    if (requireFresh) {
      const synchronizedAt = Date.parse(state.policy.synchronizedAt ?? '');
      const age = this.now().getTime() - synchronizedAt;
      if (!Number.isFinite(synchronizedAt) || age < 0 || age > POLICY_FRESHNESS_MS) {
        fail('Updater policy synchronization is stale. Open Factory Desktop to refresh policy before checking or installing updates.');
      }
    }
    return state;
  }

  async publicStatus(managerState) {
    managerState ??= await this.readManagerState();
    const nativeState = await this.workflow().readState();
    const current = this.currentIdentity();
    const candidate = nativeState.ready ?? null;
    const version = packageFactoryVersion(candidate?.identity);
    const policyAge = this.now().getTime() - Date.parse(managerState.policy?.synchronizedAt ?? '');
    const policyAllowed = Boolean(managerState.policy?.hostedServicesEnabled &&
      !managerState.policy?.airgapEnabled &&
      !managerState.policy?.organizationUpdatesDisabled &&
      Number.isFinite(policyAge) && policyAge >= 0 && policyAge <= POLICY_FRESHNESS_MS);
    const ready = Boolean(policyAllowed && candidate && version === managerState.latestVersion &&
      nativeState.blocked !== candidate.sha256 &&
      (!current || compareFactoryVersions(version, packageFactoryVersion(current)) > 0));
    const terminalCommand = ready
      ? 'factory-update-manager install-ready'
      : null;
    return {
      phase: managerState.phase,
      currentVersion: packageFactoryVersion(current),
      latestVersion: managerState.latestVersion,
      candidateVersion: version,
      ready,
      waitingForExit: managerState.phase === 'Waiting',
      lastCheckAt: managerState.lastCheckAt,
      nextCheckAt: managerState.nextCheckAt,
      error: managerState.error,
      policy: managerState.policy,
      terminalCommand,
      authorizationDeferred: Boolean(
        candidate && managerState.authorizationDeferredSha256 === candidate.sha256,
      ),
    };
  }

  async latestRelease() {
    return fetchLatestRelease({ fetchImpl: this.fetchImpl, url: OFFICIAL_LATEST_URL });
  }

  async createRecipeSnapshot(version) {
    const base = await readJson(path.join(this.recipesRoot, 'versions.json'), 'packaged updater recipe pins');
    const candidate = candidateVersions(base, version);
    const snapshot = path.join(
      this.cacheDirectory,
      'recipe-snapshots',
      `${version}-${randomUUID()}`,
    );
    await ensurePrivateDirectory(path.dirname(snapshot));
    await mkdir(snapshot, { recursive: false, mode: 0o700 });
    for (const name of SOURCE_INPUTS) {
      await cp(path.join(this.recipesRoot, name), path.join(snapshot, name), {
        recursive: true,
        errorOnExist: true,
      });
    }
    await writeFile(path.join(snapshot, 'versions.json'), `${JSON.stringify(candidate, null, 2)}\n`, {
      flag: 'w',
      mode: 0o600,
    });
    return snapshot;
  }

  async buildCandidate(version) {
    if (this.buildCandidateOverride) return this.buildCandidateOverride(version);
    const snapshot = await this.createRecipeSnapshot(version);
    const workflow = this.workflow(snapshot);
    const original = process.env.PACKAGE_WITH_UPDATER;
    process.env.PACKAGE_WITH_UPDATER = '1';
    try {
      await workflow.build({
        packageRpm: this.backend.format === 'rpm',
        packageDeb: this.backend.format === 'deb',
      });
    } finally {
      if (original === undefined) delete process.env.PACKAGE_WITH_UPDATER;
      else process.env.PACKAGE_WITH_UPDATER = original;
    }
    const state = await workflow.readState();
    if (!state.ready || packageFactoryVersion(state.ready.identity) !== version) {
      fail(`Candidate build did not produce Factory Desktop ${version}.`);
    }
    await workflow.checkArtifact(state.ready);
    return state.ready;
  }

  async appIsRunning() {
    try {
      await this.appClosed();
      return false;
    } catch (error) {
      if (/Close Factory Desktop/.test(error.message)) return true;
      throw error;
    }
  }

  async recordFailure(error) {
    const previous = await this.readManagerState();
    const failureCount = previous.failureCount + 1;
    const delay = backoffDelay(failureCount);
    return this.saveManagerState({
      phase: 'Blocked',
      error: cleanMessage(error),
      failureCount,
      nextCheckAt: new Date(this.now().getTime() + delay).toISOString(),
    });
  }

  async check({ force = false, background = false } = {}) {
    let state = await this.readManagerState();
    if (background && state.backgroundChecksDisabled) return this.publicStatus(state);
    try {
      try {
        state = await this.assertPolicyAllowed();
      } catch (error) {
        if (/Updater policy has not been synchronized|Updater policy synchronization is stale|Updates are restricted/.test(error.message)) {
          const policyState = await this.saveManagerState({
            phase: 'Blocked',
            error: cleanMessage(error),
          });
          return this.publicStatus(policyState);
        }
        throw error;
      }
      if (!force && state.nextCheckAt && Date.parse(state.nextCheckAt) > this.now().getTime()) {
        return this.publicStatus(state);
      }
      state = await this.saveManagerState({ phase: 'Checking', error: null });
      const release = await this.latestRelease();
      state = await this.saveManagerState({
        latestVersion: release.version,
        latestRecord: release,
        lastCheckAt: release.checkedAt,
      });

      const installed = this.currentIdentity();
      const currentVersion = packageFactoryVersion(installed);
      if (currentVersion && compareFactoryVersions(release.version, currentVersion) <= 0) {
        state = await this.saveManagerState({
          phase: 'Idle',
          error: null,
          failureCount: 0,
          nextCheckAt: new Date(this.now().getTime() + BACKGROUND_CHECK_INTERVAL_MS).toISOString(),
          authorizationDeferredSha256: null,
        });
        return this.publicStatus(state);
      }

      const nativeState = await this.workflow().readState();
      let candidate = nativeState.ready;
      if (candidate &&
          packageFactoryVersion(candidate.identity) === release.version &&
          nativeState.blocked === candidate.sha256) {
        const blockedState = await this.saveManagerState({
          phase: 'Blocked',
          error: 'This candidate was rolled back and is blocked.',
          failureCount: 0,
          nextCheckAt: new Date(this.now().getTime() + BACKGROUND_CHECK_INTERVAL_MS).toISOString(),
          candidateSha256: candidate.sha256,
        });
        return this.publicStatus(blockedState);
      }
      if (!candidate || packageFactoryVersion(candidate.identity) !== release.version ||
          nativeState.blocked === candidate.sha256) {
        state = await this.saveManagerState({ phase: 'Building', error: null });
        candidate = await this.buildCandidate(release.version);
        await this.saveManagerState({
          phase: 'Ready',
          authorizationDeferredSha256: null,
          failureCount: 0,
          nextCheckAt: new Date(this.now().getTime() + BACKGROUND_CHECK_INTERVAL_MS).toISOString(),
          candidateSha256: candidate.sha256,
        });
      }

      const running = await this.appIsRunning();
      state = await this.saveManagerState({
        phase: running ? 'Waiting' : 'Ready',
        error: null,
        failureCount: 0,
        nextCheckAt: new Date(this.now().getTime() + BACKGROUND_CHECK_INTERVAL_MS).toISOString(),
        candidateSha256: candidate.sha256,
        pendingAction: running ? { kind: 'install', sha256: candidate.sha256 } : null,
      });
      if (background && !running &&
          state.authorizationDeferredSha256 !== candidate.sha256) {
        if (this.backgroundInstall) {
          const outcome = await this.backgroundInstall();
          if (outcome?.waiting) {
            await this.saveManagerState({ phase: 'Waiting' });
          }
        } else {
          await this.installReady({ restart: false, source: 'background' });
        }
      }
      return this.publicStatus();
    } catch (error) {
      const failure = await this.recordFailure(error);
      return this.publicStatus(failure);
    }
  }

  async prepareHandoff() {
    await this.assertPolicyAllowed();
    const nativeState = await this.workflow().readState();
    const candidate = nativeState.ready;
    const managerState = await this.readManagerState();
    if (!candidate || !managerState.latestVersion ||
        packageFactoryVersion(candidate.identity) !== managerState.latestVersion ||
        nativeState.blocked === candidate.sha256) {
      fail('There is no verified, installable update candidate.');
    }
    await this.workflow().checkArtifact(candidate);
    const handoff = {
      sha256: candidate.sha256,
      version: managerState.latestVersion,
      nonce: randomUUID(),
      createdAt: this.now().toISOString(),
      restart: true,
    };
    await this.saveManagerState({
      handoff,
      phase: 'Waiting',
      authorizationDeferredSha256: null,
      pendingAction: null,
    });
    return { prepared: true, version: handoff.version, nonce: handoff.nonce };
  }

  async cancelHandoff() {
    const state = await this.readManagerState();
    if (!state.handoff) return false;
    await this.saveManagerState({ handoff: null, phase: 'Ready', pendingAction: null });
    return true;
  }

  async completeAfterAppExit() {
    let state = await this.readManagerState();
    const handoff = state.handoff;
    if (handoff) {
      const age = this.now().getTime() - Date.parse(handoff.createdAt);
      const nativeState = await this.workflow().readState();
      if (
        age < 0 || age > 2 * 60 * 1000 ||
        nativeState.ready?.sha256 !== handoff.sha256 ||
        nativeState.blocked === handoff.sha256
      ) {
        await this.saveManagerState({ handoff: null, phase: 'Ready' });
        return {
          relaunch: Boolean(handoff.restart),
          message: 'The update restart request expired; the candidate was retained.',
        };
      }
      // Consume before authorization so cancellation or a crash cannot loop.
      await this.saveManagerState({ handoff: null, phase: 'Auth' });
      let result;
      try {
        result = await this.installReady({ restart: true, source: 'handoff' });
      } catch (error) {
        if (/Updater policy|Updates are restricted/.test(error.message)) {
          await this.saveManagerState({ phase: 'Blocked', error: cleanMessage(error) });
          return { installed: false, relaunch: Boolean(handoff.restart), message: cleanMessage(error) };
        }
        throw error;
      }
      return { ...result, relaunch: Boolean(result.relaunch && handoff.restart) };
    }
    if (state.phase !== 'Waiting') return { relaunch: false, message: 'No update is waiting for app exit.' };
    const pendingAction = state.pendingAction;
    state = await this.saveManagerState({ phase: 'Ready', pendingAction: null });
    if (state.authorizationDeferredSha256) {
      return { relaunch: false, message: 'Installation authorization was previously cancelled.' };
    }
    return this.installReady({
      rollback: pendingAction?.kind === 'rollback',
      restart: false,
      source: pendingAction?.kind === 'rollback' ? 'rollback' : 'background',
    });
  }

  async installReady({ rollback = false, restart = false, source = 'manual' } = {}) {
    await this.assertPolicyAllowed();
    const workflow = this.workflow();
    const state = await workflow.readState();
    const managerState = await this.readManagerState();
    const target = rollback ? state.previous : state.ready;
    if (!target) {
      fail(rollback
        ? `No previous managed ${this.backend.format.toUpperCase()} is available.`
        : 'No verified update candidate is ready.');
    }
    await workflow.checkArtifact(target);
    if (!rollback && state.blocked === target.sha256) fail('This candidate was rolled back and is blocked.');
    if (!rollback && packageFactoryVersion(target.identity) !== managerState.latestVersion) {
      fail(`Ready ${this.backend.format.toUpperCase()} does not match the latest verified Factory release.`);
    }
    if (await this.appIsRunning()) {
      await this.saveManagerState({
        phase: 'Waiting',
        candidateSha256: target.sha256,
        pendingAction: { kind: rollback ? 'rollback' : 'install', sha256: target.sha256 },
      });
      return { installed: false, waiting: true, relaunch: false };
    }

    if (!this.authAvailable()) {
      await this.saveManagerState({
        phase: 'Ready',
        error: `Graphical authorization is unavailable. Run factory-update-manager ${rollback ? 'rollback' : 'install-ready'} in a terminal.`,
        pendingAction: null,
      });
      return {
        installed: false,
        relaunch: restart,
        terminalCommand: `factory-update-manager ${rollback ? 'rollback' : 'install-ready'}`,
      };
    }

    const current = this.currentIdentity();
    if (state.installed && !await workflow.matchesInstalled(state.installed)) {
      fail('Installed package differs from managed state. No update was attempted.');
    }
    if (state.installed) await workflow.checkArtifact(state.installed);
    const baselineManifestSha256 = current
      ? await sha256File('/opt/factory-desktop-linux/build-manifest.json').catch(() => null)
      : null;
    let rollbackTimerWasEnabled = false;
    if (rollback && state.installed?.updater === true && target.updater !== true &&
        this.backgroundUpdatesEnabled) {
      rollbackTimerWasEnabled = await this.backgroundUpdatesEnabled();
    }
    const pending = {
      ...state,
      schema: 2,
      pending: {
        target,
        kind: rollback ? 'rollback' : 'install',
        baseline: current,
        baselineManifestSha256,
        rollbackTimerWasEnabled,
        startedAt: this.now().toISOString(),
      },
    };
    await workflow.saveState(pending);
    if (rollbackTimerWasEnabled && this.disableBackgroundUpdates) {
      await this.disableBackgroundUpdates();
    }
    await this.saveManagerState({
      phase: 'Auth',
      candidateSha256: target.sha256,
      error: null,
      pendingAction: null,
    });
    let outcome;
    try {
      const packagePath = target[this.backend.pathKey] ?? target.rpmPath;
      outcome = await this.installer(packagePath, target.sha256, { format: this.backend.format });
    } catch (error) {
      outcome = { code: 127, stderr: cleanMessage(error) };
    }
    if (outcome.code !== 0) {
      if (await workflow.matchesBaseline(pending.pending)) {
        await workflow.saveState({ ...pending, pending: null });
        const cancelled = outcome.code === 126;
        if (rollbackTimerWasEnabled && this.enableBackgroundUpdates) {
          await this.enableBackgroundUpdates();
        }
        await this.saveManagerState({
          phase: 'Ready',
          error: cancelled
            ? 'Installation authorization was cancelled. The verified candidate was retained.'
            : cleanMessage(outcome.stderr || `Installer exited with status ${outcome.code}.`),
          authorizationDeferredSha256: cancelled ? target.sha256 : null,
          pendingAction: null,
        });
        return { installed: false, cancelled, relaunch: restart };
      }
      await this.saveManagerState({
        phase: 'Recovery',
        error: 'Package state changed during installation. Run factory-update-manager recover.',
      });
      return { installed: false, recoveryRequired: true, relaunch: false };
    }
    if (!await workflow.matchesInstalled(target)) {
      await this.saveManagerState({
        phase: 'Recovery',
        error: 'Installed package verification failed. Run factory-update-manager recover.',
      });
      return { installed: false, recoveryRequired: true, relaunch: false };
    }
    await workflow.saveState(finishTransaction(pending));
    await this.saveManagerState({
      phase: rollback ? 'Blocked' : 'Idle',
      error: rollback ? 'The update was rolled back and the rejected candidate is blocked.' : null,
      failureCount: 0,
      nextCheckAt: new Date(this.now().getTime() + BACKGROUND_CHECK_INTERVAL_MS).toISOString(),
      authorizationDeferredSha256: null,
      pendingAction: null,
    });
    return { installed: true, relaunch: restart, source };
  }

  async migrateLegacyState(sourcePath) {
    if (!path.isAbsolute(sourcePath)) fail('Legacy state path must be absolute.');
    const sourceInfo = await lstat(sourcePath);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.uid !== process.getuid()) {
      fail('Legacy native state must be a regular file owned by this user. It was preserved.');
    }
    const legacy = await readJson(sourcePath, 'legacy native state');
    if (![1, 2].includes(legacy.schema)) fail('Unsupported legacy native state schema. It was preserved.');
    if (legacy.pending) fail('Legacy native state has a pending transaction. Run make recover before migration.');

    const workflow = this.workflow();
    const current = await workflow.readState();
    if (current.pending) {
      fail('Updater state has a pending transaction. Run factory-update-manager recover before migration.');
    }
    const hasCurrentArtifacts = Boolean(current.ready || current.installed || current.previous);
    if (current.installed && await workflow.matchesInstalled(current.installed)) {
      return { migrated: false, reason: 'Updater state already matches the installed package.' };
    }
    const importDirectory = path.join(this.nativeStateDirectory, 'imported');
    await ensurePrivateDirectory(importDirectory);
    const imported = new Map();
    const copyArtifact = async (artifact) => {
      if (!artifact) return null;
      const legacyFormat = artifact.packageFormat ?? (artifact.rpmPath ? 'rpm' : 'deb');
      const legacyPathKey = legacyFormat === 'rpm' ? 'rpmPath' : 'debPath';
      const sourcePackagePath = artifact[legacyPathKey];
      if (legacyFormat !== this.backend.format) {
        fail(`Cannot migrate a ${legacyFormat.toUpperCase()} state artifact into the ${this.backend.format.toUpperCase()} updater. The source was preserved.`);
      }
      if (!/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '') || typeof sourcePackagePath !== 'string') {
        fail('Legacy artifact metadata is incomplete.');
      }
      if (imported.has(artifact.sha256)) return imported.get(artifact.sha256);
      const sourceInfo = await lstat(sourcePackagePath);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() ||
          sourceInfo.uid !== process.getuid() || sourceInfo.mode & 0o022 ||
          sourceInfo.size < 1 || sourceInfo.size > MAX_INSTALLER_BYTES ||
          await sha256File(sourcePackagePath) !== artifact.sha256) {
        fail(`Legacy artifact failed ownership or checksum validation: ${sourcePackagePath}.`);
      }
      const packagePath = path.join(importDirectory, `${artifact.sha256}${this.backend.extension}`);
      if (await exists(packagePath)) {
        const targetInfo = await lstat(packagePath);
        if (!targetInfo.isFile() || targetInfo.isSymbolicLink() ||
            targetInfo.uid !== process.getuid() || await sha256File(packagePath) !== artifact.sha256) {
          fail(`Existing imported artifact is inconsistent and was preserved: ${packagePath}.`);
        }
      } else {
        const temporary = path.join(importDirectory, `.import-${randomUUID()}${this.backend.extension}`);
        try {
          await copyFile(sourcePackagePath, temporary, constants.COPYFILE_EXCL);
          await chmod(temporary, 0o600);
          if (await sha256File(temporary) !== artifact.sha256) {
            fail('Legacy artifact changed during migration. The source was preserved.');
          }
          await rename(temporary, packagePath);
        } catch (error) {
          await unlink(temporary).catch(() => {});
          throw error;
        }
      }
      const migrated = {
        ...artifact,
        packageFormat: this.backend.format,
        [this.backend.pathKey]: packagePath,
        ...(this.backend.format === 'rpm' ? { rpmPath: packagePath } : {}),
      };
      await workflow.checkArtifact(migrated);
      migrated.updater = await workflow.hasUpdaterArtifact(migrated);
      imported.set(artifact.sha256, migrated);
      return migrated;
    };

    const migratedState = {
      ...legacy,
      schema: 2,
      ready: await copyArtifact(legacy.ready),
      installed: await copyArtifact(legacy.installed),
      previous: await copyArtifact(legacy.previous),
      pending: null,
    };
    if (hasCurrentArtifacts &&
        (!migratedState.installed || !await workflow.matchesInstalled(migratedState.installed))) {
      return { migrated: false, reason: 'Legacy installed artifact does not match the currently installed package.' };
    }
    await workflow.saveState(migratedState);
    const managerState = await this.readManagerState();
    await this.saveManagerState({
      phase: migratedState.ready ? 'Ready' : 'Idle',
      error: null,
      candidateSha256: migratedState.ready?.sha256 ?? null,
      migratedLegacyState: true,
      migratedAt: this.now().toISOString(),
      authorizationDeferredSha256: null,
    });
    return { migrated: true, artifactCount: imported.size, previousManagerState: managerState.phase };
  }

  async setup(legacyStatePath) {
    const migration = await this.migrateLegacyState(legacyStatePath);
    if (!migration.migrated &&
        migration.reason !== 'Updater state already matches the installed package.') {
      fail(migration.reason || 'Updater state migration did not complete.');
    }
    const state = await this.readManagerState();
    let enabled = false;
    if (state.backgroundChecksDisabled) {
      await this.disableBackgroundUpdates?.();
    } else if (this.enableBackgroundUpdates) {
      await this.enableBackgroundUpdates();
      enabled = true;
    }
    return { ...migration, backgroundChecksEnabled: enabled };
  }

  async recover() {
    const workflow = this.workflow();
    const pending = (await workflow.readState()).pending;
    await workflow.recover();
    const state = await workflow.readState();
    if (pending?.rollbackTimerWasEnabled && state.pending === null &&
        state.installed?.updater === true && this.enableBackgroundUpdates) {
      await this.enableBackgroundUpdates();
    }
    if (state.installed?.updater === true && await workflow.matchesInstalled(state.installed)) {
      await this.setup(workflow.statePath);
    }
    await this.saveManagerState({
      phase: state.pending ? 'Recovery' :
        (state.blocked && state.ready?.sha256 === state.blocked ? 'Blocked' : (state.ready ? 'Ready' : 'Idle')),
      error: state.pending ? 'Installation state remains ambiguous.' : null,
    });
    return this.publicStatus();
  }
}

export function invokeFlocked(command, args, { lockPath, flock = '/usr/bin/flock' } = {}) {
  const result = spawnSync(flock, ['-n', '-x', '-E', '75', lockPath, command, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
