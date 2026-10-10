import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  BUILD_STEPS, SOURCE_INPUTS, NativeWorkflow, finishTransaction,
  installOperation, parseIdentity, runningAppProcesses, sourceFingerprint,
} from '../scripts/native.mjs';
import { sha256File } from '../scripts/lib.mjs';

const identity = (version = '0.194.0-7.fc44') => ({
  name: 'factory-desktop-linux', version, architecture: 'x86_64',
});
const artifact = (sha256 = 'a'.repeat(64)) => ({ identity: identity(), sha256, rpmPath: '/fixture.rpm' });

async function temporary(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-native-test-'));
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('native pipeline includes every existing build and verification gate in order', () => {
  assert.deepEqual(BUILD_STEPS, [
    'clean-install', 'check', 'check:native', 'test', 'acquire', 'extract', 'electron:fetch',
    'daemon:check', 'build', 'verify',
  ]);
});

test('source fingerprint changes with recipes and rejects symlinked source', async () => temporary(async (root) => {
  for (const name of SOURCE_INPUTS) await writeFile(path.join(root, name), name);
  const original = await sourceFingerprint(root);
  await writeFile(path.join(root, 'versions.json'), 'changed pins');
  assert.notEqual(await sourceFingerprint(root), original);
  await rm(path.join(root, 'scripts'));
  await symlink('/tmp', path.join(root, 'scripts'));
  await assert.rejects(() => sourceFingerprint(root), /symbolic link/);
}));

test('RPM identity validation rejects other packages, architectures, and macro injection', () => {
  assert.deepEqual(parseIdentity('factory-desktop-linux\t0.194.0-7.fc44\tx86_64'), identity());
  for (const input of [
    'other\t0.194.0-7.fc44\tx86_64',
    'factory-desktop-linux\t0.194.0-7.fc44\taarch64',
    'factory-desktop-linux\t%{lua:print(1)}\tx86_64',
    'factory-desktop-linux\t0.194.0-7.fc44\tx86_64\textra',
  ]) assert.throws(() => parseIdentity(input), /Unexpected RPM/);
});

test('package installation chooses install, reinstall, or downgrade using RPM ordering', () => {
  assert.equal(installOperation(identity(), null, () => { throw new Error('unused'); }), 'install');
  assert.equal(installOperation(identity(), identity(), () => 0), 'reinstall');
  assert.equal(installOperation(identity(), identity(), () => 1), 'install');
  assert.equal(installOperation(identity(), identity(), () => -1), 'downgrade');
});

test('rollback preserves previous package and blocks the rejected candidate', () => {
  const old = artifact('b'.repeat(64));
  const newer = artifact();
  const installed = finishTransaction({
    installed: old, previous: null, pending: { target: newer, kind: 'install' },
  });
  assert.equal(installed.installed, newer);
  assert.equal(installed.previous, old);
  assert.equal(installed.pending, null);
  const rolledBack = finishTransaction({
    ...installed, pending: { target: old, kind: 'rollback' },
  });
  assert.equal(rolledBack.installed, old);
  assert.equal(rolledBack.previous, newer);
  assert.equal(rolledBack.blocked, newer.sha256);
});

test('app guard detects active and deleted installed executables and ignores other programs', async () => temporary(async (root) => {
  for (const [pid, exe] of [
    ['101', '/opt/factory-desktop-linux/factory-desktop'],
    ['102', '/opt/factory-desktop-linux/resources/bin/droid (deleted)'],
    ['103', '/usr/bin/node'],
    ['104', '/home/user/portable/factory-desktop'],
  ]) {
    await mkdir(path.join(root, pid));
    await symlink(exe, path.join(root, pid, 'exe'));
  }
  assert.deepEqual((await runningAppProcesses(root)).sort(), ['101', '102', '104']);
}));

test('managed RPM validates checksum, package identity, and embedded build manifest', async () => temporary(async (root) => {
  const directory = path.join(root, 'build', 'native');
  await mkdir(directory, { recursive: true });
  const rpmPath = path.join(directory, 'candidate.rpm');
  await writeFile(rpmPath, 'verified test RPM');
  const receipt = {
    rpmPath, sha256: await sha256File(rpmPath), identity: identity(),
    manifestSha256: 'c'.repeat(64),
  };
  const runner = (_command, args) => args.includes('--dump')
    ? `/opt/factory-desktop-linux/build-manifest.json 100 0 ${receipt.manifestSha256} 0100644 root root 0 0 0 X`
    : 'factory-desktop-linux\t0.194.0-7.fc44\tx86_64';
  const workflow = new NativeWorkflow(root, runner);
  assert.equal(await workflow.checkArtifact(receipt), receipt);
  await assert.rejects(() => workflow.checkArtifact({ ...receipt, manifestSha256: 'd'.repeat(64) }), /manifest checksum/);
  await assert.rejects(() => workflow.checkArtifact({ ...receipt, rpmPath: '/tmp/outside.rpm' }), /outside/);
  await writeFile(rpmPath, 'tampered');
  await assert.rejects(() => workflow.checkArtifact(receipt), /checksum mismatch/);
}));

test('installation journals before dnf and preserves pending state after a failure', async () => temporary(async (root) => {
  let workflow;
  let calls = 0;
  workflow = new NativeWorkflow(root, () => {
    calls++;
    throw new Error('dnf cancelled');
  }, { currentIdentity: () => null, appClosed: async () => {} });
  const ready = artifact();
  workflow.checkArtifact = async () => {};
  workflow.matchesInstalled = async () => false;
  await workflow.saveState({ schema: 1, ready, installed: null, pending: null });
  await assert.rejects(() => workflow.install(), /dnf cancelled/);
  assert.equal(calls, 1);
  const state = await workflow.readState();
  assert.deepEqual(state.pending.target, ready);
  assert.equal(state.installed, null);
  await assert.rejects(() => workflow.install(), /needs recovery/);
  assert.equal(calls, 1);
}));

test('successful installation verifies the result and retains the previous managed artifact', async () => temporary(async (root) => {
  const old = artifact('b'.repeat(64));
  const ready = artifact();
  let applied = false;
  const workflow = new NativeWorkflow(root, (command, args) => {
    assert.equal(command, 'sudo');
    assert.deepEqual(args, ['dnf', 'install', '-y', ready.rpmPath]);
    applied = true;
  }, { currentIdentity: () => null, appClosed: async () => {} });
  workflow.checkArtifact = async () => {};
  workflow.matchesInstalled = async (candidate) => candidate?.sha256 === (applied ? ready.sha256 : old.sha256);
  await workflow.saveState({ schema: 1, ready, installed: old, pending: null });
  await workflow.install();
  const state = await workflow.readState();
  assert.deepEqual(state.installed, ready);
  assert.deepEqual(state.previous, old);
  assert.equal(state.pending, null);
  workflow.run = () => assert.fail('already installed must be a no-op');
  await workflow.install();
}));

test('packaging reuses a verified portable workspace and completed RPMs without rebuilding', async () => temporary(async (root) => {
  for (const name of SOURCE_INPUTS) await writeFile(path.join(root, name), name);
  let assemblies = 0;
  const calls = [];
  const workflow = new NativeWorkflow(root, (command, args, options) => {
    calls.push([command, args]);
    if (command === 'rpm') return 'factory-desktop-linux\t0.194.0-7.fc44\tx86_64';
    if (args[1] === 'package:rpm') {
      const directory = path.join(options.cwd, 'dist', 'rpm');
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'candidate.rpm'), 'candidate');
      writeFileSync(path.join(directory, 'candidate.rpm.sha256'),
        `${createHash('sha256').update('candidate').digest('hex')}  candidate.rpm\n`);
    }
    return '';
  });
  workflow.assemble = async () => {
    assemblies++;
    const workspace = path.join(workflow.directory, 'workspaces', 'fixture');
    await mkdir(workspace, { recursive: true });
    for (const name of SOURCE_INPUTS) await writeFile(path.join(workspace, name), name);
    const distribution = path.join(workspace, 'dist', 'factory-desktop-linux-native');
    await mkdir(distribution, { recursive: true });
    await writeFile(path.join(distribution, 'build-manifest.json'), '{}');
    return workspace;
  };
  workflow.checkArtifact = async () => {};
  await workflow.build();
  await workflow.build({ packageRpm: true });
  assert.equal(assemblies, 1);
  assert.ok(calls.some(([command, args]) => command === 'npm' && args[1] === 'verify'));
  const totalCalls = calls.length;
  await workflow.build({ packageRpm: true });
  assert.equal(calls.length, totalCalls);
  assert.equal(assemblies, 1);
}));

test('app-running guard and rollback block prevent privileged installation', async () => temporary(async (root) => {
  const workflow = new NativeWorkflow(root, () => assert.fail('must not execute'), {
    currentIdentity: () => null,
    appClosed: async () => { throw new Error('Close Factory Desktop'); },
  });
  workflow.checkArtifact = async () => {};
  workflow.matchesInstalled = async () => false;
  await workflow.saveState({ schema: 1, ready: artifact(), installed: null, pending: null });
  await assert.rejects(() => workflow.install(), /Close Factory Desktop/);
  assert.equal((await workflow.readState()).pending, null);
  await workflow.saveState({ schema: 1, ready: artifact(), blocked: artifact().sha256 });
  await assert.rejects(() => workflow.install(), /was rolled back/);
}));

test('recovery completes verified transactions or permits retry of an unchanged installation', async () => temporary(async (root) => {
  const workflow = new NativeWorkflow(root, () => assert.fail('must not execute'), {
    currentIdentity: () => null, appClosed: async () => {},
  });
  workflow.checkArtifact = async () => {};
  const ready = artifact();
  workflow.matchesInstalled = async (candidate) => candidate === ready || candidate?.sha256 === ready.sha256;
  await workflow.saveState({ schema: 1, installed: null, pending: { target: ready, kind: 'install' } });
  await workflow.recover();
  assert.deepEqual((await workflow.readState()).installed, ready);
  workflow.matchesInstalled = async () => false;
  await workflow.saveState({ schema: 1, installed: null, pending: { target: ready, baseline: null } });
  await workflow.recover();
  assert.equal((await workflow.readState()).pending, null);
  workflow.matchesBaseline = async () => false;
  await workflow.saveState({ schema: 1, installed: null, pending: { target: ready } });
  await assert.rejects(() => workflow.recover(), /ambiguous/);
  assert.ok((await workflow.readState()).pending);
}));

test('checkout updates refuse dirty work and re-execute updated code under the existing lock', async () => {
  const calls = [];
  const workflow = new NativeWorkflow('/repo', (command, args) => {
    calls.push([command, args]);
    return args[0] === 'status' ? ' M user-file' : '';
  });
  await assert.rejects(() => workflow.updateCheckout(), /clean checkout/);
  assert.equal(calls.length, 1);
  calls.length = 0;
  workflow.run = (command, args) => { calls.push([command, args]); return ''; };
  await workflow.updateCheckout();
  assert.deepEqual(calls, [
    ['git', ['status', '--porcelain', '--untracked-files=normal']],
    ['git', ['pull', '--ff-only']],
    [process.execPath, ['/repo/scripts/native-cli.mjs', 'install']],
  ]);
});

test('native entrypoints expose Fedora workflow without enabling background updates', async () => {
  const root = path.resolve(new URL('..', import.meta.url).pathname);
  const shell = await readFile(path.join(root, 'scripts/native.sh'), 'utf8');
  assert.match(shell, /flock -n -E 75/);
  assert.match(shell, /sudo dnf install -y/);
  assert.doesNotMatch(shell, /curl.*\|\s*(sh|bash)|--no-sandbox|systemctl.*enable/);
  const makefile = await readFile(path.join(root, 'Makefile'), 'utf8');
  for (const target of ['bootstrap-native', 'install-native', 'update-native', 'rollback', 'recover']) {
    assert.ok(makefile.includes(target));
  }
});
