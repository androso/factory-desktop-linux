import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  distributionDirectory,
  hashTreeWithModes,
  walkDirectories,
  walkFiles,
} from '../scripts/lib.mjs';
import { runIsolatedSandboxSmoke } from '../scripts/portable-payload.mjs';
import {
  DEB_BUNDLE_ROOT,
  DEB_COPYRIGHT_PATH,
  DEB_DESKTOP_PATH,
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
} from '../scripts/deb.mjs';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const canBuildDeb = spawnSync('dpkg-deb', ['--version'], { encoding: 'utf8' }).status === 0;

async function tempDir(prefix = 'factory-deb-test-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function md5(content) {
  return createHash('md5').update(content).digest('hex');
}

test('.deb output name is amd64 and refuses output collisions', async () => {
  const root = await tempDir('deb output collision ');
  try {
    const output = debOutputPaths(root, { version: '0.194.0' });
    assert.equal(DEB_RELEASE, '7');
    assert.equal(output.filename, 'factory-desktop-linux_0.194.0-7_amd64.deb');
    assert.equal(output.debPath, path.join(root, output.filename));
    assert.equal(output.checksumPath, `${output.debPath}.sha256`);
    await assertNoDebOutputCollisions(
      { debPath: output.debPath, checksumPath: output.checksumPath },
      async () => false,
    );
    await writeFile(output.debPath, 'existing deb');
    await assert.rejects(
      () => assertNoDebOutputCollisions(
        { debPath: output.debPath, checksumPath: output.checksumPath },
        async (candidate) => {
          try {
            await readFile(candidate);
            return true;
          } catch (error) {
            if (error.code === 'ENOENT') return false;
            throw error;
          }
        },
      ),
      /Refusing to overwrite existing .deb output/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.throws(() => debOutputPaths('/tmp', {
    version: '0.194.0',
    architecture: 'arm64',
  }), /Only amd64/);
  assert.throws(() => debOutputPaths('/tmp', {
    version: '0.194.0',
    release: 'bad rev',
  }), /unsupported characters/);
});

test('.deb wrapper and desktop entry do not register callback handlers', async () => {
  const wrapper = createSystemWrapper();
  assert.match(wrapper, /^#!\/bin\/sh\nset -eu\nexec '\/opt\/factory-desktop-linux\/launch\.sh' "\$@"\n$/);
  assert.doesNotMatch(wrapper, /--no-sandbox|chrome-sandbox.*chmod|xdg-mime|MimeType=/i);
  const desktop = createDesktopEntry();
  assert.match(desktop, /^Name=Factory Desktop Linux$/m);
  assert.match(desktop, /^Exec=\/usr\/bin\/factory-desktop-linux$/m);
  assert.match(desktop, /^Icon=factory-desktop-linux$/m);
  assert.match(desktop, /unofficial.*personal use/i);
  assert.doesNotMatch(desktop, /^MimeType=|^Actions=|x-scheme-handler|%u|factory-[a-z0-9.+-]+:/im);

  const notice = await readFile(path.join(repoRoot, 'assets/deb-personal-use-notice.txt'), 'utf8');
  assert.match(notice, /proprietary/i);
  assert.match(notice, /unofficial/i);
  assert.match(notice, /personal.use/i);
  assert.match(notice, /Do not publish or redistribute/i);
});

test('Debian control file declares required fields and no maintainer scripts', () => {
  const control = createControlFile({
    version: '0.194.0-7',
    installedSizeKiB: 12345,
    depends: ['zlib1g', 'libc6', 'libsecret-1-0', 'libc6'],
  });
  assert.match(control, /^Package: factory-desktop-linux$/m);
  assert.match(control, /^Version: 0\.194\.0-7$/m);
  assert.match(control, /^Architecture: amd64$/m);
  assert.match(control, /^Maintainer: .+<.+>$/m);
  assert.match(control, /^Installed-Size: 12345$/m);
  assert.match(control, /^Depends: libc6, libsecret-1-0, zlib1g$/m);
  assert.match(control, /^Section: devel$/m);
  assert.match(control, /^Priority: optional$/m);
  assert.match(control, /^Description: Unofficial personal-use Factory Desktop port$/m);
  assert.match(control, /^ \.$/m);
  assert.match(control, /Ubuntu 24\.04/);
  assert.doesNotMatch(control, /^%post|^%preun|^%postun|^Requires:/m);
  assert.doesNotMatch(control, /^Package:.*\n.*\nPackage:/m);
  for (const directive of ['postinst', 'prerm', 'postrm', 'preinst']) {
    assert.doesNotMatch(control, new RegExp(directive, 'i'));
  }

  assert.throws(() => createControlFile({
    version: '0.194.0',
    installedSizeKiB: 1,
    depends: ['libc6'],
  }), /<upstream>-<revision>/);
  assert.throws(() => createControlFile({
    version: '0.194.0-7',
    installedSizeKiB: 0,
    depends: ['libc6'],
  }), /positive integer/);
  assert.throws(() => createControlFile({
    version: '0.194.0-7',
    installedSizeKiB: 1,
    depends: [],
  }), /at least one runtime dependency/);
  assert.throws(() => createControlFile({
    version: '0.194.0-7',
    installedSizeKiB: 1,
    depends: ['bad name'],
  }), /Unexpected Debian package name/);
});

test('Debian payload layout maps bundle and safe desktop integration paths', () => {
  const layout = debPayloadLayout([
    'factory-desktop',
    'launch.sh',
    'resources/bin/droid',
  ], '/usr/share/icons/hicolor/scalable/apps/factory-desktop-linux.svg', [
    'empty-directory',
  ]);
  assert.ok(layout.files.includes(`${DEB_BUNDLE_ROOT}/factory-desktop`));
  assert.ok(layout.files.includes(`${DEB_BUNDLE_ROOT}/resources/bin/droid`));
  assert.ok(layout.files.includes(DEB_WRAPPER_PATH));
  assert.ok(layout.files.includes(DEB_DESKTOP_PATH));
  assert.ok(layout.files.includes(DEB_COPYRIGHT_PATH));
  assert.ok(layout.files.includes('/usr/share/icons/hicolor/scalable/apps/factory-desktop-linux.svg'));
  assert.ok(layout.paths.includes(DEB_BUNDLE_ROOT));
  assert.ok(layout.paths.includes(`${DEB_BUNDLE_ROOT}/empty-directory`));
  assert.ok(!layout.paths.includes('/usr/share/icons/hicolor/scalable/apps'));
  assert.throws(
    () => debPayloadLayout(['../outside'], '/usr/share/icons/hicolor/scalable/apps/icon.svg'),
    /Unsafe Debian bundle path/,
  );
});

test('Debian dependency set is derived from system library ownership', () => {
  const paths = new Map([
    ['libc.so.6', '/lib/x86_64-linux-gnu/libc.so.6'],
    ['libglib-2.0.so.0', '/usr/lib/x86_64-linux-gnu/libglib-2.0.so.0'],
    ['libsecret-1.so.0', '/usr/lib/x86_64-linux-gnu/libsecret-1.so.0'],
  ]);
  const lookup = (resolved) => (resolved.includes('glib') ? 'libglib2.0-0t64:amd64' : null);
  assert.deepEqual(
    debianDependencies(['libc.so.6', 'libglib-2.0.so.0', 'libsecret-1.so.0'], paths, lookup),
    ['libc6', 'libglib2.0-0t64', 'libsecret-1-0'],
  );
  assert.throws(
    () => debianDependencies(
      ['libc.so.6', 'libunknown.so.9'],
      new Map([
        ['libc.so.6', '/lib/x86_64-linux-gnu/libc.so.6'],
        ['libunknown.so.9', '/usr/lib/libunknown.so.9'],
      ]),
      () => null,
    ),
    /Cannot determine the Debian package/,
  );
  assert.throws(
    () => debianDependencies(['libc.so.6'], new Map([['libc.so.6', '/lib/x86_64-linux-gnu/libc.so.6']]), () => 'libc6'),
    /missing libsecret-1-0/,
  );
});

test('Debian md5sums entries are sorted and omit leading slashes', () => {
  const text = formatMd5sums([
    { path: '/opt/factory-desktop-linux/launch.sh', md5: 'b'.repeat(32) },
    { path: '/usr/bin/factory-desktop-linux', md5: 'a'.repeat(32) },
  ]);
  assert.equal(
    text,
    `${'a'.repeat(32)}  usr/bin/factory-desktop-linux\n${'b'.repeat(32)}  opt/factory-desktop-linux/launch.sh\n`,
  );
  assert.throws(() => formatMd5sums([{ path: 'relative', md5: 'a'.repeat(32) }]), /Invalid .deb md5sums entry path/);
  assert.throws(() => formatMd5sums([{ path: '/x', md5: 'nope' }]), /Invalid md5sum/);
});

test('Debian installed size rounds up to whole kibibytes', () => {
  assert.equal(debianInstalledSizeKiB(0), 1);
  assert.equal(debianInstalledSizeKiB(1024), 1);
  assert.equal(debianInstalledSizeKiB(1025), 2);
  assert.throws(() => debianInstalledSizeKiB(-1), /Invalid installed size/);
});

test('Debian packaging is wired to the pinned distribution and npm script', async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const versions = JSON.parse(await readFile(path.join(repoRoot, 'versions.json'), 'utf8'));
  assert.equal(packageJson.scripts['package:deb'], 'node scripts/package-deb.mjs');
  assert.equal(versions.factory, '0.194.0');
  assert.equal(distributionDirectory('factory-desktop-linux-validated'),
    path.join(repoRoot, 'dist', 'factory-desktop-linux-validated'));
});

test('sandbox smoke check honors an explicit opt-out', async () => {
  const previous = process.env.FACTORY_SKIP_SANDBOX_SMOKE;
  process.env.FACTORY_SKIP_SANDBOX_SMOKE = '1';
  try {
    const result = await runIsolatedSandboxSmoke(
      '/nonexistent-extraction',
      { workspace: '/nonexistent-workspace' },
      DEB_BUNDLE_ROOT,
    );
    assert.deepEqual(result, { status: 'skipped', reason: 'explicit-opt-out' });
  } finally {
    if (previous === undefined) delete process.env.FACTORY_SKIP_SANDBOX_SMOKE;
    else process.env.FACTORY_SKIP_SANDBOX_SMOKE = previous;
  }
});

test('synthetic Debian package metadata, payload layout, and hashes', { skip: !canBuildDeb }, async () => {
  const root = await tempDir('factory-deb-build-fixture-');
  try {
    const packageRoot = path.join(root, 'root');
    const controlDirectory = path.join(packageRoot, 'DEBIAN');
    const payload = path.join(packageRoot, DEB_BUNDLE_ROOT.slice(1));
    for (const directory of [
      controlDirectory,
      path.join(payload, 'resources', 'bin'),
      path.join(payload, 'empty', 'nested'),
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o755 });
    }
    await writeFile(path.join(payload, 'factory-desktop'), 'synthetic executable', { mode: 0o755 });
    await chmod(path.join(payload, 'factory-desktop'), 0o755);
    await writeFile(path.join(payload, 'launch.sh'), '#!/bin/sh\nexec "$ROOT/factory-desktop" "$@"\n', { mode: 0o755 });
    await chmod(path.join(payload, 'launch.sh'), 0o755);
    await writeFile(path.join(payload, 'resources', 'bin', 'droid'), 'synthetic bundled cli', { mode: 0o755 });
    await chmod(path.join(payload, 'resources', 'bin', 'droid'), 0o755);
    await writeFile(path.join(payload, 'resources', 'factory-desktop.png'),
      await readFile(path.join(repoRoot, 'assets/factory-desktop.png')), { mode: 0o644 });
    await writeFile(path.join(payload, 'build-manifest.json'), '{"factoryVersion":"0.194.0"}\n', { mode: 0o644 });

    const wrapperPath = path.join(packageRoot, DEB_WRAPPER_PATH.slice(1));
    const desktopPath = path.join(packageRoot, DEB_DESKTOP_PATH.slice(1));
    const copyrightPath = path.join(packageRoot, DEB_COPYRIGHT_PATH.slice(1));
    const iconPath = path.join(packageRoot, 'usr/share/icons/hicolor/256x256/apps/factory-desktop-linux.png');
    await mkdir(path.dirname(wrapperPath), { recursive: true });
    await mkdir(path.dirname(desktopPath), { recursive: true });
    await mkdir(path.dirname(copyrightPath), { recursive: true });
    await mkdir(path.dirname(iconPath), { recursive: true });
    await writeFile(wrapperPath, createSystemWrapper(), { mode: 0o755 });
    await chmod(wrapperPath, 0o755);
    await writeFile(desktopPath, createDesktopEntry(), { mode: 0o644 });
    await writeFile(iconPath, await readFile(path.join(repoRoot, 'assets/factory-desktop.png')), { mode: 0o644 });
    await writeFile(copyrightPath, await readFile(path.join(repoRoot, 'assets/deb-personal-use-notice.txt')), { mode: 0o644 });
    // mkdir modes are filtered through the process umask, and dpkg-deb rejects a
    // control directory that is not group/world readable.
    for (const directory of [packageRoot, ...await walkDirectories(packageRoot)]) {
      await chmod(directory, 0o755);
    }

    const dataFiles = (await walkFiles(packageRoot))
      .filter((file) => !file.startsWith(`${controlDirectory}${path.sep}`));
    const md5Entries = [];
    let totalBytes = 0;
    for (const file of dataFiles) {
      const content = await readFile(file);
      totalBytes += content.length;
      md5Entries.push({ path: `/${path.relative(packageRoot, file).split(path.sep).join('/')}`, md5: md5(content) });
    }
    const installedSizeKiB = debianInstalledSizeKiB(totalBytes);
    await writeFile(path.join(controlDirectory, 'control'), createControlFile({
      version: '0.194.0-7',
      installedSizeKiB,
      depends: ['libc6', 'libsecret-1-0'],
    }));
    await writeFile(path.join(controlDirectory, 'md5sums'), formatMd5sums(md5Entries));

    const expectedHash = await hashTreeWithModes(payload);
    const outputDirectory = path.join(root, 'out');
    await mkdir(outputDirectory);
    const debPath = path.join(outputDirectory, 'factory-desktop-linux_0.194.0-7_amd64.deb');
    const built = spawnSync('dpkg-deb', ['--root-owner-group', '--build', packageRoot, debPath], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(built.status, 0, `${built.stdout ?? ''}${built.stderr ?? ''}`);

    const metadata = spawnSync('dpkg-deb', [
      '-f', debPath, 'Package', 'Version', 'Architecture', 'Depends', 'Installed-Size', 'Section', 'Priority',
    ], { encoding: 'utf8' });
    assert.equal(metadata.status, 0, metadata.stderr);
    assert.deepEqual(metadata.stdout.trimEnd().split('\n'), [
      'Package: factory-desktop-linux',
      'Version: 0.194.0-7',
      'Architecture: amd64',
      'Depends: libc6, libsecret-1-0',
      `Installed-Size: ${installedSizeKiB}`,
      'Section: devel',
      'Priority: optional',
    ]);

    const layout = debPayloadLayout(
      ['build-manifest.json', 'factory-desktop', 'launch.sh', 'resources/bin/droid', 'resources/factory-desktop.png'],
      '/usr/share/icons/hicolor/256x256/apps/factory-desktop-linux.png',
      ['empty', 'empty/nested', 'resources', 'resources/bin'],
    );
    const contents = spawnSync('dpkg-deb', ['-c', debPath], { encoding: 'utf8' });
    assert.equal(contents.status, 0, contents.stderr);
    const listing = contents.stdout.split('\n').filter(Boolean).map((line) => {
      const fields = line.split(/\s+/);
      return { type: fields[0]?.[0], mode: fields[0], owner: fields[1], path: fields.slice(5).join(' ') };
    });
    const listedFiles = listing.filter((entry) => entry.type === '-').map((entry) => entry.path).map((item) => item.replace(/^\./, '')).sort();
    assert.deepEqual(listedFiles, [...layout.files].sort());
    const listedDirectories = new Set(listing
      .filter((entry) => entry.type === 'd')
      .map((entry) => `/${entry.path.replace(/^\.\//, '').replace(/\/+$/, '')}`)
      .map((item) => (item === '/' ? '/' : item.replace(/\/$/, ''))));
    const expectedDirectories = layout.paths.filter((item) => !layout.files.includes(item));
    for (const directory of expectedDirectories) {
      assert.ok(listedDirectories.has(directory), `missing directory in .deb: ${directory}`);
    }
    for (const entry of listing) {
      assert.equal(entry.owner, 'root/root', entry.path);
      if (/factory-desktop$|launch\.sh$|\/droid$/.test(entry.path)) {
        assert.equal(entry.mode, '-rwxr-xr-x', entry.path);
      }
    }

    const extraction = path.join(root, 'extracted');
    const extracted = spawnSync('dpkg-deb', ['-x', debPath, extraction], { encoding: 'utf8' });
    assert.equal(extracted.status, 0, extracted.stderr);
    assert.equal(await hashTreeWithModes(path.join(extraction, DEB_BUNDLE_ROOT.slice(1))), expectedHash);
    const desktopCheck = spawnSync('desktop-file-validate', [
      path.join(extraction, DEB_DESKTOP_PATH.slice(1)),
    ], { encoding: 'utf8' });
    assert.equal(desktopCheck.status, 0, desktopCheck.stderr);

    const controlOut = path.join(root, 'control');
    const controlExtract = spawnSync('dpkg-deb', ['--control', debPath, controlOut], { encoding: 'utf8' });
    assert.equal(controlExtract.status, 0, controlExtract.stderr);
    const controlFiles = (await walkFiles(controlOut)).map((file) => path.basename(file)).sort();
    assert.deepEqual(controlFiles, ['control', 'md5sums']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
