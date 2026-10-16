import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { test } from 'node:test';
import cliIntegration from '../scripts/linux-cli.cjs';
import { findUniquePatchFile, patches, patchesForBuild, transformExact } from '../scripts/patches.mjs';
import { ROOT, walkFiles } from '../scripts/lib.mjs';

const { createCliIntegration, mergeShellEnvironment } = cliIntegration;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory parity ü % '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'user home');
  await mkdir(home);
  const env = {
    HOME: home,
    FACTORY_HOME_OVERRIDE: path.join(root, 'isolated profile'),
    FACTORY_LINUX_HOST_HOME: home,
    FACTORY_LINUX_HOST_CONFIG_HOME: path.join(root, 'host config'),
    XDG_CONFIG_HOME: path.join(root, 'isolated config'),
    SHELL: '/bin/bash',
    PATH: '/usr/bin:/bin',
  };
  const source = path.join(root, 'bundled droid');
  await writeFile(source, '#!/bin/sh\nprintf "synthetic-droid\\n"\n', { mode: 0o755 });
  const cli = createCliIntegration({ env });
  const binary = path.join(home, '.local', 'bin', 'droid');
  const record = path.join(path.dirname(binary), '.factory-desktop-droid.json');
  return { root, home, env, source, cli, binary, record };
}

test('CLI setup uses the real user home, records its copy, and uninstalls only that copy', async (t) => {
  const f = await fixture(t);
  assert.equal(f.cli.installDirectory(), path.dirname(f.binary));
  assert.equal(f.cli.installCli(f.source), f.binary);
  assert.equal(f.cli.isCliInstalled(), true);
  assert.equal((await lstat(f.binary)).mode & 0o777, 0o755);
  assert.equal((await lstat(f.record)).mode & 0o777, 0o600);
  const result = spawnSync(f.binary, ['--version'], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'synthetic-droid');
  const installedInode = (await lstat(f.binary)).ino;
  f.cli.installCli(f.source);
  assert.equal((await lstat(f.binary)).ino, installedInode);
  f.cli.uninstallCli();
  await assert.rejects(lstat(f.binary), { code: 'ENOENT' });
  await assert.rejects(lstat(f.record), { code: 'ENOENT' });
  f.cli.uninstallCli();
});

test('CLI installation and uninstall preserve existing files and dangling symlinks', async (t) => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.binary), { recursive: true });
  await writeFile(f.binary, 'independently installed CLI');
  assert.throws(() => f.cli.installCli(f.source), /left unchanged/);
  assert.throws(() => f.cli.uninstallCli(), /Nothing was removed/);
  assert.equal(await readFile(f.binary, 'utf8'), 'independently installed CLI');
  await unlink(f.binary);
  await symlink(path.join(f.root, 'missing user binary'), f.binary);
  assert.throws(() => f.cli.installCli(f.source), /left unchanged/);
  assert.throws(() => f.cli.uninstallCli(), /Nothing was removed/);
  assert.equal((await lstat(f.binary)).isSymbolicLink(), true);
});

test('CLI ownership rejects modified, replaced, or malformed installations', async (t) => {
  const f = await fixture(t);
  f.cli.installCli(f.source);
  const original = await readFile(f.record);
  await writeFile(f.binary, 'user replacement');
  assert.equal(f.cli.isCliInstalled(), false);
  assert.throws(() => f.cli.uninstallCli(), /Nothing was removed/);
  assert.equal(await readFile(f.binary, 'utf8'), 'user replacement');
  await unlink(f.binary);
  await copyFile(f.source, f.binary);
  assert.equal(f.cli.isCliInstalled(), false, 'identical bytes at a new inode are not owned');
  assert.throws(() => f.cli.uninstallCli(), /Nothing was removed/);
  await writeFile(f.record, '{invalid');
  assert.equal(f.cli.isCliInstalled(), false);
  assert.throws(() => f.cli.installCli(f.source), /left unchanged/);
  assert.throws(() => f.cli.uninstallCli(), /Nothing was removed/);
  await writeFile(f.record, original);
});

test('CLI setup rejects a missing bundle and preserves conflicting install metadata', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.cli.installCli(path.join(f.root, 'missing')), /missing/);
  await assert.rejects(lstat(f.binary), { code: 'ENOENT' });
  await mkdir(path.dirname(f.binary), { recursive: true });
  await writeFile(f.record, 'user file');
  assert.throws(() => f.cli.installCli(f.source), /left unchanged/);
  assert.equal(await readFile(f.record, 'utf8'), 'user file');
  await assert.rejects(lstat(f.binary), { code: 'ENOENT' });
});

test('shell PATH setup preserves existing content and ignores commented path mentions', async (t) => {
  const f = await fixture(t);
  const config = path.join(f.home, '.bashrc');
  const contents = '# ~/.local/bin is not configured yet\nexport USER_SETTING=keep\n';
  await writeFile(config, contents);
  assert.equal(f.cli.updatePath(), true);
  const updated = await readFile(config, 'utf8');
  assert.ok(updated.startsWith(contents));
  assert.ok(updated.includes('export PATH="$HOME/.local/bin:$PATH"'));
  assert.equal(f.env.PATH, `${path.dirname(f.binary)}:/usr/bin:/bin`);
  assert.equal(f.cli.updatePath(), false);
  f.env.PATH = '/usr/bin:/bin';
  assert.equal(f.cli.updatePath(), true);
  assert.equal(await readFile(config, 'utf8'), updated);
});

test('shell PATH setup supports ZDOTDIR and the host fish config outside the desktop profile', async (t) => {
  const f = await fixture(t);
  f.env.SHELL = '/usr/bin/zsh';
  f.env.ZDOTDIR = path.join(f.root, 'zsh config');
  assert.equal(f.cli.shellConfigPath(), path.join(f.env.ZDOTDIR, '.zshrc'));
  f.cli.updatePath();
  assert.match(await readFile(f.cli.shellConfigPath(), 'utf8'), /export PATH=/);
  f.env.SHELL = '/usr/bin/fish';
  f.env.PATH = '/usr/bin:/bin';
  assert.equal(f.cli.shellConfigPath(), path.join(f.env.FACTORY_LINUX_HOST_CONFIG_HOME, 'fish', 'config.fish'));
  f.cli.updatePath();
  assert.match(await readFile(f.cli.shellConfigPath(), 'utf8'), /set -gx PATH \$HOME\/\.local\/bin \$PATH/);
  assert.equal(f.cli.updatePath(), false);
  f.env.SHELL = '/bin/sh';
  assert.equal(f.cli.shellConfigPath(), path.join(f.home, '.profile'));
});

test('shell loading imports development tools without replacing launcher-owned environment', () => {
  const parent = {
    HOME: '/user', XDG_CONFIG_HOME: '/desktop/config',
    FACTORY_HOME_OVERRIDE: '/desktop/profile', FACTORY_LINUX_PROFILE: 'isolated',
    FACTORY_LINUX_HOST_HOME: '/user', FACTORY_LINUX_HOST_CONFIG_HOME: '/user/config',
    FACTORY_UPDATE_STATE_HOME: '/desktop/updater', FACTORY_ENV: 'production',
    PATH: '/usr/bin',
  };
  const shell = {
    ...parent,
    HOME: '/different', XDG_CONFIG_HOME: '/different/config',
    FACTORY_HOME_OVERRIDE: '/different/profile', FACTORY_LINUX_PROFILE: 'shared',
    FACTORY_LINUX_HOST_HOME: '/different', FACTORY_LINUX_HOST_CONFIG_HOME: '/different/config',
    FACTORY_UPDATE_STATE_HOME: '/different/updater', FACTORY_ENV: 'development',
    PATH: '/user/toolchain/bin:/usr/bin', VIRTUAL_ENV: '/user/venv',
    NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1',
    FACTORY_DESKTOP_RENDERER_URL: 'http://localhost:5173',
  };
  const merged = mergeShellEnvironment(parent, shell);
  for (const [key, value] of Object.entries(parent)) {
    if (key !== 'PATH') assert.equal(merged[key], value, key);
  }
  assert.equal(merged.PATH, shell.PATH);
  assert.equal(merged.VIRTUAL_ENV, shell.VIRTUAL_ENV);
  assert.equal(merged.NODE_OPTIONS, undefined);
  assert.equal(merged.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(merged.FACTORY_DESKTOP_RENDERER_URL, undefined);
  assert.equal(parent.PATH, '/usr/bin');
});

async function launcherFixture(t) {
  const f = await fixture(t);
  for (const name of ['launch.sh', 'launch-test.sh']) {
    await copyFile(path.join(ROOT, 'scripts', name), path.join(f.root, name));
    await chmod(path.join(f.root, name), 0o755);
  }
  const capture = path.join(f.root, 'capture.json');
  await writeFile(path.join(f.root, 'factory-desktop'), `#!${process.execPath}
require('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify({
  args: process.argv.slice(2),
  env: Object.fromEntries(${JSON.stringify([
    'HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
    'FACTORY_HOME_OVERRIDE', 'FACTORY_LINUX_PROFILE', 'FACTORY_LINUX_HOST_HOME',
    'FACTORY_LINUX_HOST_CONFIG_HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
  ])}.map(key => [key, process.env[key]]))
}));
`, { mode: 0o755 });
  const env = {
    ...process.env, HOME: f.home, CAPTURE: capture,
    XDG_DATA_HOME: path.join(f.root, 'host data'), XDG_CONFIG_HOME: path.join(f.root, 'host config'),
    XDG_CACHE_HOME: path.join(f.root, 'host cache'), XDG_STATE_HOME: path.join(f.root, 'host state'),
    DISPLAY: ':87', WAYLAND_DISPLAY: 'wayland-test', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/synthetic',
  };
  delete env.FACTORY_LINUX_PROFILE;
  return {
    ...f, env,
    async launch(args = [], overrides = {}, name = 'launch.sh') {
      const result = spawnSync(path.join(f.root, name), args, {
        env: { ...env, ...overrides }, encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(await readFile(capture, 'utf8'));
    },
  };
}

test('launcher keeps isolation by default and offers explicit native-like shared configuration', async (t) => {
  const f = await launcherFixture(t);
  await mkdir(path.join(f.home, '.factory'), { mode: 0o750 });
  const settings = path.join(f.home, '.factory', 'settings.json');
  await writeFile(settings, '{"syntheticPreference":"keep"}');
  const arg = 'project path "quoted" $value %';
  const isolated = await f.launch([arg]);
  assert.equal(isolated.env.FACTORY_LINUX_PROFILE, 'isolated');
  assert.equal(isolated.env.FACTORY_HOME_OVERRIDE, path.join(f.env.XDG_DATA_HOME, 'factory-desktop-linux', 'factory-home'));
  assert.equal(isolated.env.FACTORY_LINUX_HOST_HOME, f.home);
  assert.equal(isolated.env.FACTORY_LINUX_HOST_CONFIG_HOME, f.env.XDG_CONFIG_HOME);
  const shared = await f.launch(['--factory-profile=shared', arg]);
  assert.equal(shared.env.FACTORY_LINUX_PROFILE, 'shared');
  assert.equal(shared.env.FACTORY_HOME_OVERRIDE, f.home);
  assert.equal(shared.env.HOME, f.home);
  for (const key of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
    'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS']) {
    assert.equal(shared.env[key], f.env[key], key);
  }
  assert.equal(shared.args.at(-1), arg);
  assert.equal(shared.args.some((value) => value.startsWith('--factory-profile=')), false);
  assert.notEqual(shared.args[0], isolated.args[0], 'different profiles must not attach to the same Electron instance');
  assert.match(shared.args[0], /user-data-shared$/);
  assert.equal(await readFile(settings, 'utf8'), '{"syntheticPreference":"keep"}');
  assert.equal((await lstat(path.join(f.home, '.factory'))).mode & 0o777, 0o750);
});

test('profile selection supports an environment default, rejects invalid profiles, and cannot weaken test isolation', async (t) => {
  const f = await launcherFixture(t);
  assert.equal((await f.launch([], { FACTORY_LINUX_PROFILE: 'shared' })).env.FACTORY_HOME_OVERRIDE, f.home);
  assert.equal((await f.launch(['--factory-profile=isolated'], { FACTORY_LINUX_PROFILE: 'shared' })).env.FACTORY_LINUX_PROFILE, 'isolated');
  for (const value of ['unknown', '', '../shared']) {
    const result = spawnSync(path.join(f.root, 'launch.sh'), [`--factory-profile=${value}`], {
      env: f.env, encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /expected isolated or shared/);
  }
  const isolatedTest = await f.launch([], {
    FACTORY_LINUX_PROFILE: 'shared', FACTORY_LINUX_HOST_HOME: f.home,
  }, 'launch-test.sh');
  assert.equal(isolatedTest.env.FACTORY_LINUX_PROFILE, 'isolated');
  assert.equal(isolatedTest.env.FACTORY_LINUX_HOST_HOME, path.join(f.root, '.test', 'home'));
  assert.equal(isolatedTest.env.FACTORY_LINUX_HOST_CONFIG_HOME, path.join(f.root, '.test', 'config'));
});

test('CLI patches route the existing official menu operations through Linux-only helpers', async () => {
  for (const [id, functionName, method, tail] of [
    ['linux-cli-user-install-directory', 'cs', 'installDirectory', ''],
    ['linux-cli-user-shell-config', 'N8', 'shellConfigPath', 'return "stock"}'],
    ['linux-cli-safe-install', 'sX', 'installCli', 'return "stock"}'],
    ['linux-cli-owned-uninstall', 'aX', 'uninstallCli', 'return "stock"}'],
    ['linux-cli-owned-status', 'qp', 'isCliInstalled', 'return "stock"}'],
    ['linux-cli-shell-path', 'cX', 'updatePath', 'return "stock"}'],
  ]) {
    const patch = patches.find((item) => item.id === id);
    const calls = [];
    const helper = { [method](...args) { calls.push(args); return 'linux'; } };
    const context = vm.createContext({
      process: { platform: 'linux', resourcesPath: '/bundle/resources' },
      require(name) { assert.equal(name, '/bundle/resources/linux-cli.cjs'); return helper; },
      oX: () => '/bundle/resources/bin/droid',
    });
    vm.runInContext(`${patch.after}${tail};globalThis.operation=${functionName}`, context);
    assert.equal(await context.operation(), 'linux', id);
    assert.equal(calls.length, 1);
    if (method === 'installCli') assert.deepEqual(calls[0], ['/bundle/resources/bin/droid']);
  }
});

test('environment integration preserves the Linux profile while leaving other platforms unchanged', () => {
  const patch = patches.find((item) => item.id === 'linux-preserve-launcher-environment');
  for (const platform of ['linux', 'darwin', 'win32']) {
    let calls = 0;
    const context = vm.createContext({
      process: {
        platform, resourcesPath: '/bundle/resources',
        env: { HOME: '/user', FACTORY_HOME_OVERRIDE: '/desktop/profile', PATH: '/usr/bin' },
      },
      t: { FACTORY_HOME_OVERRIDE: '/shell/profile', PATH: '/shell/tools:/usr/bin' },
      i: { mergeShellEnvironment: (parent, shell) => ({ ...parent, ...shell }) },
      require() { calls++; return { mergeShellEnvironment }; },
    });
    vm.runInContext(patch.after, context);
    assert.equal(context.process.env.PATH, '/shell/tools:/usr/bin');
    assert.equal(context.process.env.FACTORY_HOME_OVERRIDE, platform === 'linux' ? '/desktop/profile' : '/shell/profile');
    assert.equal(calls, platform === 'linux' ? 1 : 0);
  }
  const installPath = patches.find((item) => item.id === 'linux-cli-user-install-directory');
  for (const [platform, expected] of [['darwin', '/user/.local/bin'], ['win32', '/user/bin']]) {
    const context = vm.createContext({
      process: { platform }, Xr: platform === 'win32', X: path,
      i: { getDesktopHomeDir: () => '/user' },
      require() { assert.fail('non-Linux CLI setup must not load the Linux helper'); },
    });
    vm.runInContext(`${installPath.after};globalThis.directory=cs()`, context);
    assert.equal(context.directory, expected);
  }
});

async function extractedOfficialBundle(t) {
  const app = path.join(ROOT, 'build', 'extracted', 'application', 'app');
  try {
    assert.ok((await lstat(app)).isDirectory(), 'the extracted official app must be a directory');
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('requires the extracted official app');
      return null;
    }
    throw error;
  }
  return { app, build: path.join(app, '.vite', 'build') };
}

test('all parity patches apply exactly to the official bundle in both update modes', async (t) => {
  const bundle = await extractedOfficialBundle(t);
  if (!bundle) return;
  const { app } = bundle;
  const files = (await walkFiles(path.join(app, '.vite'))).filter((file) => file.endsWith('.js'));
  assert.ok(files.length, 'the extracted official bundle contains no JavaScript');
  for (const withUpdater of [false, true]) {
    const contents = new Map();
    for (const patch of patchesForBuild({ withUpdater })) {
      const file = await findUniquePatchFile(app, patch, { files, contents });
      contents.set(file, transformExact(contents.get(file), patch));
    }
    for (const [file, source] of contents) {
      if (file.includes(`${path.sep}renderer${path.sep}`)) {
        const result = spawnSync(process.execPath, ['--check', '--input-type=module'], {
          input: source, encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
      } else {
        new vm.Script(source, { filename: file });
      }
    }
  }
});

test('the official Unix shell loader discovers shell-only tools without reading real user startup files', async (t) => {
  const bundle = await extractedOfficialBundle(t);
  if (!bundle) return;
  const f = await fixture(t);
  const source = await readFile(path.join(bundle.build, 'index-US6E2OoJ.js'), 'utf8');
  const start = source.indexOf('async function Cye(e){');
  const end = source.indexOf('const Eye=', start);
  assert.ok(start >= 0 && end > start, 'the official shell loader must be inspected again if its selector changes');
  const bin = path.join(f.root, 'shell tools');
  await mkdir(bin);
  const tool = path.join(bin, 'parity-test-tool');
  await writeFile(tool, '#!/bin/sh\nprintf "tool-ready\\n"\n', { mode: 0o755 });
  await writeFile(path.join(f.home, '.bashrc'), `export PATH=${JSON.stringify(bin)}:"$PATH"\nexport PARITY_VALUE='spaces "quotes"\nand a newline'\n`);
  // Retain the official -ilc contract but skip system and real-user startup
  // files. The loader's real export/quoting script runs in interactive Bash.
  const shell = path.join(f.root, 'bash');
  await writeFile(shell, '#!/bin/sh\n[ "$1" = "-ilc" ] || exit 9\nexec /bin/bash --noprofile --rcfile "$HOME/.bashrc" -ic "$2"\n', { mode: 0o755 });
  const environment = { HOME: f.home, PATH: '/usr/bin:/bin', TERM: 'dumb' };
  const context = vm.createContext({
    process: { env: environment }, BA: { randomUUID }, MA: path, Pp: os, Nt: fs, J() {},
    eIe: () => shell,
    async bP(command, args, env) {
      const { stdout } = await promisify(execFile)(command, args, { env, timeout: 10_000, encoding: 'buffer' });
      return stdout;
    },
    Iye(output, marker) {
      const frame = `\0${marker}\0`;
      const first = output.indexOf(frame);
      const last = output.indexOf(frame, first + frame.length);
      assert.ok(first >= 0 && last > first);
      return Object.fromEntries(output.slice(first + frame.length, last).split('\0').filter(Boolean).map((entry) => {
        const equals = entry.indexOf('=');
        return [entry.slice(0, equals), entry.slice(equals + 1)];
      }));
    },
  });
  vm.runInContext(`${source.slice(start, end)};globalThis.load=Cye`, context);
  const loaded = await context.load();
  assert.equal(loaded.PARITY_VALUE, 'spaces "quotes"\nand a newline');
  const merged = mergeShellEnvironment(environment, { ...environment, ...loaded });
  const result = spawnSync('parity-test-tool', [], { env: merged, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'tool-ready');
  const fallbackStart = source.indexOf('async function _ye(e){');
  const fallbackEnd = source.indexOf('function fye(', fallbackStart);
  assert.ok(fallbackStart >= 0 && fallbackEnd > fallbackStart);
  context.he = Error;
  vm.runInContext(`${source.slice(fallbackStart, fallbackEnd)};
    Cye=async()=>{throw new Error("synthetic shell failure")};
    globalThis.loadWithFallback=_ye`, context);
  assert.equal(await context.loadWithFallback(), environment);
});
