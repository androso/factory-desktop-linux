import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  backoffDelay,
  candidateVersions,
  compareFactoryVersions,
  FACTORY_DOWNLOAD_ORIGIN,
  FactoryUpdater,
  fetchLatestRelease,
  factoryInstallerUrl,
  invokeFlocked,
  parseLatestVersion,
  updaterCommandEnvironment,
} from '../scripts/updater.mjs';
import { RPM_RELEASE } from '../scripts/rpm.mjs';
import { debBackend } from '../scripts/package-backend.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const identity = (version) => ({
  name: 'factory-desktop-linux',
  version: `${version}-${RPM_RELEASE}.fc44`,
  architecture: 'x86_64',
});
const artifact = (version, label = version) => ({
  rpmPath: `/temporary/${label}.rpm`,
  sha256: digest(`${label}-rpm`),
  manifestSha256: digest(`${label}-manifest`),
  sourceSha256: digest(`${label}-source`),
  sourceVersion: version,
  identity: identity(version),
});

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'factory-updater-test-'));
}

function makeHarness(root, {
  latest = '0.195.0',
  installed = '0.194.0',
  appRunning = false,
  installerCode = 0,
  timerEnabled = false,
  now = () => new Date('2026-10-12T12:00:00.000Z'),
  nativeState = {},
} = {}) {
  let current = installed ? identity(installed) : null;
  let running = appRunning;
  let fetchCount = 0;
  let buildCount = 0;
  let installerCount = 0;
  let timerDisableCount = 0;
  let timerEnableCount = 0;
  let nextInstallerCode = installerCode;
  const workflow = {
    state: {
      schema: 2,
      ready: null,
      installed: null,
      previous: null,
      pending: null,
      blocked: null,
      ...nativeState,
    },
    async readState() { return structuredClone(this.state); },
    async saveState(state) { this.state = structuredClone(state); return this.readState(); },
    async checkArtifact(value) {
      assert.match(value.sha256, /^[a-f0-9]{64}$/);
      return value;
    },
    async hasUpdaterArtifact(value) { return value.updater === true; },
    async matchesInstalled(value) { return current?.version === value.identity.version; },
    async matchesBaseline(pending) {
      return (current?.version ?? null) === (pending.baseline?.version ?? null);
    },
    async recover() { return this.readState(); },
  };
  const updater = new FactoryUpdater({
    recipesRoot: root,
    stateDirectory: path.join(root, 'state'),
    cacheDirectory: path.join(root, 'cache'),
    currentIdentity: () => current,
    appClosed: async () => {
      if (running) throw new Error('Close Factory Desktop before installation.');
    },
    workflowFactory: () => workflow,
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(`${latest}\n`, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    },
    buildCandidate: async (version) => {
      buildCount += 1;
      const candidate = artifact(version, `candidate-${version}`);
      workflow.state.ready = candidate;
      return candidate;
    },
    installer: async () => {
      installerCount += 1;
      if (nextInstallerCode !== 0) return { code: nextInstallerCode, stderr: 'authorization cancelled' };
      current = workflow.state.pending.target.identity;
      return { code: 0, stderr: '' };
    },
    backgroundUpdatesEnabled: () => timerEnabled,
    disableBackgroundUpdates: () => { timerDisableCount += 1; timerEnabled = false; },
    enableBackgroundUpdates: () => { timerEnableCount += 1; timerEnabled = true; },
    authAvailable: () => true,
    now,
  });
  return {
    updater,
    workflow,
    setRunning(value) { running = value; },
    setCurrent(value) { current = value ? identity(value) : null; },
    setInstallerCode(value) { nextInstallerCode = value; },
    counts: () => ({ fetchCount, buildCount, installerCount, timerDisableCount, timerEnableCount }),
  };
}

test('official LATEST parsing, redirect validation, and numeric version ordering', async () => {
  assert.equal(parseLatestVersion(' 0.195.0\n'), '0.195.0');
  assert.throws(() => parseLatestVersion('0.195.0-beta.1'), /stable numeric/);
  assert.throws(() => parseLatestVersion('00.195.0'), /stable numeric/);
  assert.throws(() => parseLatestVersion('0.195.0\n0.196.0'), /stable numeric/);
  assert.equal(compareFactoryVersions('0.100.0', '0.99.99'), 1);
  assert.equal(factoryInstallerUrl('0.195.0'),
    `${FACTORY_DOWNLOAD_ORIGIN}/factory-desktop/releases/0.195.0/win32/x64/Factory-0.195.0%20Setup.exe`);
  assert.equal(candidateVersions({ node: '24.19.0' }, '0.195.0').node, '24.19.0');

  const release = await fetchLatestRelease({
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).origin, FACTORY_DOWNLOAD_ORIGIN);
      assert.equal(options.redirect, 'manual');
      return new Response('0.195.0\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    },
  });
  assert.equal(release.version, '0.195.0');
  let redirects = 0;
  let redirectBodyCancelled = false;
  const redirected = await fetchLatestRelease({
    fetchImpl: async (url) => {
      redirects += 1;
      if (redirects === 1) {
        return {
          status: 302,
          headers: new Headers({ location: '/redirected-LATEST' }),
          body: { cancel: async () => { redirectBodyCancelled = true; } },
        };
      }
      assert.equal(new URL(url).pathname, '/redirected-LATEST');
      return new Response('0.195.0\n', { status: 200 });
    },
  });
  assert.equal(redirectBodyCancelled, true);
  assert.equal(redirected.redirects.length, 1);
  await assert.rejects(() => fetchLatestRelease({
    url: 'https://updates.attacker.example/LATEST',
    fetchImpl: async () => { throw new Error('must not fetch an unapproved host'); },
  }), /unapproved URL/);
  await assert.rejects(() => fetchLatestRelease({
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { location: 'https://attacker.example/payload' },
    }),
  }), /unapproved URL/);
  await assert.rejects(() => fetchLatestRelease({
    fetchImpl: async () => new Response('x'.repeat(300), { status: 200 }),
  }), /transfer limit/);
});

test('managed candidate npm commands target the native updater distribution', () => {
  const environment = updaterCommandEnvironment('npm', { PATH: '/usr/bin' });
  assert.equal(environment.PACKAGE_WITH_UPDATER, '1');
  assert.equal(environment.FACTORY_DIST_NAME, 'factory-desktop-linux-native');
  assert.equal(updaterCommandEnvironment('rpm', { PATH: '/usr/bin' }).FACTORY_DIST_NAME, undefined);
});

test('managed updater authorizes and installs the active DEB artifact', async () => {
  const root = await tempDir();
  try {
    const now = () => new Date('2026-10-12T12:00:00.000Z');
    const oldIdentity = {
      name: 'factory-desktop-linux',
      version: '0.194.0-1ubuntu26.04',
      architecture: 'amd64',
    };
    const nextIdentity = {
      name: 'factory-desktop-linux',
      version: '0.195.0-1ubuntu26.04',
      architecture: 'amd64',
    };
    const oldArtifact = {
      packageFormat: 'deb', debPath: path.join(root, 'old.deb'),
      sha256: digest('old-deb'), manifestSha256: digest('old-manifest'),
      identity: oldIdentity, updater: true,
    };
    const candidate = {
      packageFormat: 'deb', debPath: path.join(root, 'candidate.deb'),
      sha256: digest('candidate-deb'), manifestSha256: digest('candidate-manifest'),
      identity: nextIdentity, updater: true,
    };
    let current = oldIdentity;
    const workflow = {
      state: {
        schema: 2, ready: candidate, installed: oldArtifact,
        previous: null, pending: null, blocked: null,
      },
      async readState() { return structuredClone(this.state); },
      async saveState(value) { this.state = structuredClone(value); },
      async checkArtifact(value) { return value; },
      async matchesInstalled(value) { return current.version === value?.identity?.version; },
      async matchesBaseline(pending) { return current.version === pending.baseline?.version; },
    };
    let installedPath;
    let installedFormat;
    const updater = new FactoryUpdater({
      recipesRoot: root,
      stateDirectory: path.join(root, 'state'),
      cacheDirectory: path.join(root, 'cache'),
      packageBackend: debBackend(),
      currentIdentity: () => current,
      compare: (left, right) => left === right ? 0 : left < right ? -1 : 1,
      workflowFactory: () => workflow,
      appClosed: async () => {},
      installer: async (packagePath, _sha, options) => {
        installedPath = packagePath;
        installedFormat = options.format;
        current = nextIdentity;
        return { code: 0, stderr: '' };
      },
      authAvailable: () => true,
      now,
    });
    await updater.setPolicy({
      hostedServicesEnabled: true,
      airgapEnabled: false,
      organizationUpdatesDisabled: false,
    });
    await updater.saveManagerState({ latestVersion: '0.195.0' });
    const result = await updater.installReady();
    assert.deepEqual(result, { installed: true, relaunch: false, source: 'manual' });
    assert.equal(installedPath, candidate.debPath);
    assert.equal(installedFormat, 'deb');
    assert.equal(workflow.state.installed.sha256, candidate.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('successful checks defer the next background network request', async () => {
  const root = await tempDir();
  try {
    const h = makeHarness(root);
    await h.updater.setPolicy({
      hostedServicesEnabled: true,
      airgapEnabled: false,
      organizationUpdatesDisabled: false,
    });
    await h.updater.check({ force: true });
    assert.equal(h.counts().fetchCount, 1);
    const background = await h.updater.check({ background: true });
    assert.equal(h.counts().fetchCount, 1);
    assert.equal(background.ready, true);
    assert.equal(Date.parse(background.nextCheckAt), Date.parse('2026-10-12T18:00:00.000Z'));
    await h.updater.check({ force: true });
    assert.equal(h.counts().fetchCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('backoff is bounded and organization policy prevents network access', async () => {
  assert.equal(backoffDelay(1), 15 * 60 * 1000);
  assert.equal(backoffDelay(2), 30 * 60 * 1000);
  assert.equal(backoffDelay(50), 24 * 60 * 60 * 1000);
  const root = await tempDir();
  try {
    const h = makeHarness(root);
    const policy = await h.updater.setPolicy({
      hostedServicesEnabled: true,
      airgapEnabled: false,
      organizationUpdatesDisabled: true,
    });
    assert.equal(policy.phase, 'Blocked');
    const status = await h.updater.check({ force: true });
    assert.equal(status.phase, 'Blocked');
    assert.equal(h.counts().fetchCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('updater setup remains idempotent and respects a saved background opt-out', async () => {
  const root = await tempDir();
  try {
    const h = makeHarness(root);
    h.updater.migrateLegacyState = async () => ({
      migrated: false,
      reason: 'Updater state already matches the installed package.',
    });
    const first = await h.updater.setup('/unused/native-state.json');
    assert.equal(first.backgroundChecksEnabled, true);
    assert.equal(h.counts().timerEnableCount, 1);
    await h.updater.saveManagerState({ backgroundChecksDisabled: true });
    const second = await h.updater.setup('/unused/native-state.json');
    assert.equal(second.backgroundChecksEnabled, false);
    assert.equal(h.counts().timerDisableCount, 1);
    assert.equal(h.counts().timerEnableCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stale cached policy blocks checks until the app synchronizes it again', async () => {
  const root = await tempDir();
  try {
    let clock = new Date('2026-10-12T12:00:00.000Z');
    const h = makeHarness(root, { now: () => clock });
    const allowed = {
      hostedServicesEnabled: true,
      airgapEnabled: false,
      organizationUpdatesDisabled: false,
    };
    await h.updater.setPolicy(allowed);
    await h.updater.check({ force: true });
    assert.equal(h.counts().fetchCount, 1);
    clock = new Date(clock.getTime() + 5 * 60 * 1000 + 1);
    const stale = await h.updater.check({ force: true });
    assert.equal(stale.phase, 'Blocked');
    assert.equal(h.counts().fetchCount, 1);
    await h.updater.setPolicy(allowed);
    assert.equal((await h.updater.check({ force: true })).phase, 'Ready');
    assert.equal(h.counts().fetchCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('disabled background checks skip startup polling but preserve explicit checks', async () => {
  const root = await tempDir();
  try {
    const h = makeHarness(root);
    await h.updater.setPolicy({
      hostedServicesEnabled: true,
      airgapEnabled: false,
      organizationUpdatesDisabled: false,
    });
    await h.updater.saveManagerState({ backgroundChecksDisabled: true });
    await h.updater.check({ force: true, background: true });
    assert.equal(h.counts().fetchCount, 0);
    await h.updater.check({ force: true });
    assert.equal(h.counts().fetchCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('authorization cancellation retains a verified candidate without retrying it', async () => {
  const root = await tempDir();
  try {
    const h = makeHarness(root, { installerCode: 126 });
    await h.updater.setPolicy({
      hostedServicesEnabled: true,
      airgapEnabled: false,
      organizationUpdatesDisabled: false,
    });
    const available = await h.updater.check({ force: true });
    assert.equal(available.ready, true);
    const result = await h.updater.installReady();
    assert.equal(result.cancelled, true);
    assert.equal((await h.updater.publicStatus()).authorizationDeferred, true);
    await h.updater.check({ force: true, background: true });
    assert.equal(h.counts().installerCount, 1);
    assert.equal(h.workflow.state.pending, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('one-time restart handoff installs only after app exit and requests one relaunch', async () => {
  const root = await tempDir();
  try {
    const h = makeHarness(root);
    await h.updater.setPolicy({
      hostedServicesEnabled: true,
      airgapEnabled: false,
      organizationUpdatesDisabled: false,
    });
    await h.updater.check({ force: true });
    const prepared = await h.updater.prepareHandoff();
    assert.equal(prepared.prepared, true);
    const result = await h.updater.completeAfterAppExit();
    assert.equal(result.installed, true);
    assert.equal(result.relaunch, true);
    assert.equal(h.counts().installerCount, 1);
    assert.equal((await h.updater.completeAfterAppExit()).relaunch, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancelled quit and expired handoff do not install or relaunch', async () => {
  const root = await tempDir();
  try {
    let clock = new Date('2026-10-12T12:00:00.000Z');
    const h = makeHarness(root, { now: () => clock });
    await h.updater.setPolicy({
      hostedServicesEnabled: true,
      airgapEnabled: false,
      organizationUpdatesDisabled: false,
    });
    await h.updater.check({ force: true });
    await h.updater.prepareHandoff();
    assert.equal(await h.updater.cancelHandoff(), true);
    assert.equal((await h.updater.completeAfterAppExit()).relaunch, false);
    assert.equal(h.counts().installerCount, 0);

    await h.updater.prepareHandoff();
    clock = new Date(clock.getTime() + 2 * 60 * 1000 + 1);
    const expired = await h.updater.completeAfterAppExit();
    assert.equal(expired.relaunch, true);
    assert.match(expired.message, /expired/);
    assert.equal(h.counts().installerCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('waiting-for-exit state resumes the verified candidate after app shutdown', async () => {
  const root = await tempDir();
  try {
    const h = makeHarness(root, { appRunning: true });
    await h.updater.setPolicy({
      hostedServicesEnabled: true,
      airgapEnabled: false,
      organizationUpdatesDisabled: false,
    });
    const waiting = await h.updater.check({ force: true });
    assert.equal(waiting.waitingForExit, true);
    h.setRunning(false);
    const result = await h.updater.completeAfterAppExit();
    assert.equal(result.installed, true);
    assert.equal(result.relaunch, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rollback blocks the rejected candidate from automatic reinstallation', async () => {
  const root = await tempDir();
  try {
    const rejected = artifact('0.195.0', 'rejected');
    const previous = artifact('0.194.0', 'previous');
    rejected.updater = true;
    previous.updater = false;
    const h = makeHarness(root, {
      installed: '0.195.0',
      timerEnabled: true,
      nativeState: { ready: rejected, installed: rejected, previous },
    });
    await h.updater.setPolicy({
      hostedServicesEnabled: true,
      airgapEnabled: false,
      organizationUpdatesDisabled: false,
    });
    await h.updater.saveManagerState({ latestVersion: '0.195.0' });
    const result = await h.updater.installReady({ rollback: true });
    assert.equal(result.installed, true);
    assert.equal(h.workflow.state.installed.sha256, previous.sha256);
    assert.equal(h.workflow.state.blocked, rejected.sha256);
    assert.equal(h.counts().timerDisableCount, 1);
    assert.equal(h.counts().timerEnableCount, 0);
    const status = await h.updater.check({ force: true });
    assert.equal(status.phase, 'Blocked');
    assert.equal(h.counts().buildCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancelled rollback authorization restores the previously enabled timer', async () => {
  const root = await tempDir();
  try {
    const rejected = { ...artifact('0.195.0', 'rejected'), updater: true };
    const previous = { ...artifact('0.194.0', 'previous'), updater: false };
    const h = makeHarness(root, {
      installed: '0.195.0',
      installerCode: 126,
      timerEnabled: true,
      nativeState: { ready: rejected, installed: rejected, previous },
    });
    await h.updater.setPolicy({
      hostedServicesEnabled: true,
      airgapEnabled: false,
      organizationUpdatesDisabled: false,
    });
    const result = await h.updater.installReady({ rollback: true });
    assert.equal(result.cancelled, true);
    assert.equal(h.counts().timerDisableCount, 1);
    assert.equal(h.counts().timerEnableCount, 1);
    assert.equal(h.workflow.state.pending, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy managed artifacts migrate by verified copy without deleting the source', async () => {
  const root = await tempDir();
  try {
    const h = makeHarness(root);
    const rpmPath = path.join(root, 'legacy.rpm');
    const contents = 'synthetic managed rpm';
    await writeFile(rpmPath, contents, { mode: 0o600 });
    const legacyArtifact = {
      ...artifact('0.194.0', 'legacy'),
      rpmPath,
      sha256: digest(contents),
    };
    const statePath = path.join(root, 'legacy-state.json');
    await writeFile(statePath, JSON.stringify({
      schema: 1,
      ready: legacyArtifact,
      installed: legacyArtifact,
      previous: null,
      pending: null,
    }), { mode: 0o600 });
    const result = await h.updater.migrateLegacyState(statePath);
    assert.equal(result.migrated, true);
    assert.equal(result.artifactCount, 1);
    assert.equal(await readFile(rpmPath, 'utf8'), contents);
    assert.equal(h.workflow.state.ready.rpmPath.includes('/imported/'), true);
    assert.equal(h.workflow.state.ready.sha256, legacyArtifact.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('flock reports a busy install lock with the expected retry status', async () => {
  const root = await tempDir();
  let holder;
  try {
    const lockPath = path.join(root, 'install.lock');
    const marker = path.join(root, 'locked');
    holder = spawn('/usr/bin/flock', [
      '-x',
      lockPath,
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'locked');setTimeout(()=>{},5000)`,
    ], { stdio: 'ignore' });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await readFile(marker);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.equal(invokeFlocked(process.execPath, ['-e', ''], { lockPath }).status, 75);
  } finally {
    holder?.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  }
});
