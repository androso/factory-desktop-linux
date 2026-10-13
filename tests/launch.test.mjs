import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runIsolatedSandboxSmoke } from '../scripts/portable-payload.mjs';

test('normal launch reuses CLI credentials and browser associations without disabling the sandbox', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory launch '));
  try {
    const home = path.join(root, 'home');
    const config = path.join(root, 'config');
    const data = path.join(root, 'data');
    await mkdir(home);
    await mkdir(config);
    await mkdir(data);
    for (const name of ['mimeapps.list', 'gnome-mimeapps.list']) {
      await writeFile(path.join(config, name), '[Default Applications]\nx-scheme-handler/https=google-chrome.desktop;\n');
    }
    const launcher = path.join(root, 'launch.sh');
    await writeFile(launcher, await readFile(new URL('../scripts/launch.sh', import.meta.url)), { mode: 0o755 });
    const app = path.join(root, 'factory-desktop');
    await writeFile(app, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  home: process.env.FACTORY_HOME_OVERRIDE,
  config: process.env.XDG_CONFIG_HOME,
  dataDirs: process.env.XDG_DATA_DIRS,
  keyringDisabled: process.env.FACTORY_DISABLE_KEYRING,
}));
`, { mode: 0o755 });
    await chmod(launcher, 0o755);
    await chmod(app, 0o755);
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_STATE_HOME: path.join(root, 'state'),
      XDG_DATA_DIRS: '/usr/share',
      FACTORY_DISABLE_KEYRING: '1',
    };
    delete env.FACTORY_HOME_OVERRIDE;
    const first = spawnSync(launcher, ['argument with spaces'], { env, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout);
    assert.equal(result.home, home);
    assert.equal(result.keyringDisabled, undefined);
    assert.equal(result.args.at(-1), 'argument with spaces');
    assert.ok(!result.args.includes('--no-sandbox'));
    assert.ok(result.args.includes(`--user-data-dir=${data}/factory-desktop-linux/user-data`));
    assert.equal(result.dataDirs, `${data}:/usr/share`);
    for (const name of ['mimeapps.list', 'gnome-mimeapps.list']) {
      assert.equal(await readlink(path.join(result.config, name)), path.join(config, name));
    }
    const override = path.join(root, 'custom cli home');
    const second = spawnSync(launcher, [], {
      env: { ...env, FACTORY_HOME_OVERRIDE: override },
      encoding: 'utf8',
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).home, override);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sandbox smoke uses a short private temporary path and cleans it after a failed launch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory smoke '));
  const previousPath = process.env.PATH;
  const previousSkip = process.env.FACTORY_SKIP_SANDBOX_SMOKE;
  try {
    const bin = path.join(root, 'bin');
    const workspace = path.join(root, 'nested-workspace-'.repeat(10));
    const capture = path.join(root, 'tmpdir');
    await mkdir(bin);
    await mkdir(workspace);
    await writeFile(path.join(bin, 'unshare'), `#!/bin/sh
printf '%s' "$TMPDIR" > '${capture.replaceAll("'", "'\"'\"'")}'
exit 42
`, { mode: 0o755 });
    for (const command of ['dbus-run-session', 'xvfb-run', 'xauth']) {
      await writeFile(path.join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    process.env.PATH = `${bin}:${previousPath}`;
    delete process.env.FACTORY_SKIP_SANDBOX_SMOKE;
    await assert.rejects(
      runIsolatedSandboxSmoke(root, { workspace }, '/opt/factory-desktop-linux'),
      /code=42/,
    );
    const temporary = await readFile(capture, 'utf8');
    assert.ok(temporary.length < 60);
    assert.match(temporary, /^\/tmp\/factory-smoke-/);
    await assert.rejects(access(temporary), { code: 'ENOENT' });
  } finally {
    process.env.PATH = previousPath;
    if (previousSkip === undefined) delete process.env.FACTORY_SKIP_SANDBOX_SMOKE;
    else process.env.FACTORY_SKIP_SANDBOX_SMOKE = previousSkip;
    await rm(root, { recursive: true, force: true });
  }
});
