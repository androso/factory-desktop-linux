import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  distributionDirectory,
  hashTreeWithModes,
  normalizePublicModes,
  publicMode,
  TARGET_FACTORY_VERSION,
  walkDirectories,
} from '../scripts/lib.mjs';
import {
  COMMON_BUILD_COMMANDS,
  FEDORA_RPM_COMMANDS,
  UBUNTU_DEB_COMMANDS,
  SUPPORTED_BUILD_HOSTS,
  evaluateBuildHost,
  packageInstallCommand,
  packagesForMissingPrerequisites,
  requiredCommandsForHost,
} from '../scripts/host.mjs';
import {
  RPM_BUNDLE_ROOT,
  RPM_DESKTOP_PATH,
  RPM_LICENSE_PATH,
  RPM_RELEASE,
  RPM_WRAPPER_PATH,
  assertNoRpmOutputCollisions,
  createDesktopEntry,
  createSystemWrapper,
  iconInstallPath,
  privateSonameExclusion,
  rpmOutputPaths,
  rpmPayloadLayout,
} from '../scripts/rpm.mjs';
import {
  compareDebVersions, debOutputPaths, DEB_REVISION, parseDebIdentity,
} from '../scripts/deb.mjs';
import { debBackend, detectPackageFormat } from '../scripts/package-backend.mjs';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const canBuildFedoraRpm = spawnSync('rpmbuild', ['--version'], { encoding: 'utf8' }).status === 0 &&
  spawnSync('rpm', ['--eval', '%{?dist}'], { encoding: 'utf8' }).stdout?.trim() === '.fc44' &&
  ['rpm2cpio', 'cpio', 'desktop-file-validate', 'gcc'].every((command) =>
    spawnSync('sh', ['-c', `command -v '${command}'`]).status === 0);

async function tempDir(prefix = 'factory-rpm-test-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test('build hosts support Ubuntu 24.04 portable, Ubuntu 26.04 DEB, and Fedora 44 RPM', () => {
  const fedora = evaluateBuildHost({
    osRelease: { ID: 'fedora', VERSION_ID: '44', PRETTY_NAME: 'Fedora Linux 44' },
    machine: 'x86_64',
    nodeArchitecture: 'x64',
  });
  const ubuntu = evaluateBuildHost({
    osRelease: { ID: 'ubuntu', VERSION_ID: '24.04', PRETTY_NAME: 'Ubuntu 24.04' },
    machine: 'x86_64',
    nodeArchitecture: 'x64',
  });
  const ubuntuLts = evaluateBuildHost({
    osRelease: { ID: 'ubuntu', VERSION_ID: '26.04', PRETTY_NAME: 'Ubuntu 26.04' },
    machine: 'x86_64',
    nodeArchitecture: 'x64',
  });
  assert.equal(fedora.supported, true);
  assert.equal(fedora.profile.rpmPackaging, true);
  assert.equal(ubuntu.supported, true);
  assert.equal(ubuntu.profile.rpmPackaging, false);
  assert.equal(ubuntu.profile.nativeInstallation, false);
  assert.equal(ubuntuLts.supported, true);
  assert.equal(ubuntuLts.profile.debPackaging, true);
  assert.equal(ubuntuLts.profile.nativeInstallation, true);
  assert.equal(SUPPORTED_BUILD_HOSTS.length, 3);
  assert.deepEqual(requiredCommandsForHost(fedora.profile), [
    ...COMMON_BUILD_COMMANDS,
    ...FEDORA_RPM_COMMANDS,
  ]);
  assert.deepEqual(requiredCommandsForHost(ubuntu.profile), COMMON_BUILD_COMMANDS);
  assert.deepEqual(requiredCommandsForHost(ubuntuLts.profile), [
    ...COMMON_BUILD_COMMANDS,
    ...UBUNTU_DEB_COMMANDS,
  ]);
  assert.equal(evaluateBuildHost({
    osRelease: { ID: 'fedora', VERSION_ID: '43' },
    machine: 'x86_64',
    nodeArchitecture: 'x64',
  }).supported, false);
  assert.equal(evaluateBuildHost({
    osRelease: { ID: 'fedora', VERSION_ID: '44' },
    machine: 'aarch64',
    nodeArchitecture: 'arm64',
  }).supported, false);

  const prereqHost = { profile: fedora.profile, id: 'fedora' };
  const packages = packagesForMissingPrerequisites(
    prereqHost,
    ['rpmbuild', 'cpio'],
    true,
  );
  assert.ok(packages.includes('rpm-build'));
  assert.ok(packages.includes('cpio'));
  assert.ok(packages.includes('libsecret-devel'));
  assert.equal(
    packageInstallCommand(prereqHost, ['libsecret-devel']),
    'sudo dnf install libsecret-devel',
  );
  const ubuntuPackages = packagesForMissingPrerequisites(
    { profile: ubuntuLts.profile, id: 'ubuntu' },
    ['dpkg-deb', 'dpkg-shlibdeps', 'desktop-file-validate'],
    true,
  );
  assert.deepEqual(ubuntuPackages, [
    'desktop-file-utils', 'dpkg-dev', 'libsecret-1-dev',
  ]);
  assert.equal(
    packageInstallCommand({ profile: ubuntuLts.profile, id: 'ubuntu' }, ['dpkg-dev']),
    'sudo apt-get install dpkg-dev',
  );
});

test('DEB output identity is pinned to Ubuntu 26.04 amd64 and compares Debian versions', () => {
  const paths = debOutputPaths('/tmp/deb', { version: TARGET_FACTORY_VERSION });
  assert.equal(paths.filename,
    `factory-desktop-linux_${TARGET_FACTORY_VERSION}-${DEB_REVISION}_amd64.deb`);
  assert.deepEqual(parseDebIdentity(
    `factory-desktop-linux\n${TARGET_FACTORY_VERSION}-${DEB_REVISION}\namd64`,
  ), {
    name: 'factory-desktop-linux',
    version: `${TARGET_FACTORY_VERSION}-${DEB_REVISION}`,
    architecture: 'amd64',
  });
  assert.equal(compareDebVersions('0.194.0-1ubuntu26.04', '0.195.0-1ubuntu26.04'), -1);
  assert.equal(compareDebVersions('0.194.0-1ubuntu26.04', '0.194.0-1ubuntu26.04'), 0);
  assert.throws(() => parseDebIdentity('factory-desktop-linux\t0.194.0-1ubuntu24.04\tamd64'), /Unexpected DEB/);
  assert.throws(() => debOutputPaths('/tmp', {
    version: TARGET_FACTORY_VERSION, revision: '1ubuntu24.04',
  }), /restricted to Ubuntu 26.04/);
  assert.throws(() => debOutputPaths('/tmp', {
    version: TARGET_FACTORY_VERSION, architecture: 'arm64',
  }), /Only amd64/);
  assert.equal(detectPackageFormat('ID=ubuntu\nVERSION_ID="26.04"\n'), 'deb');
  assert.equal(detectPackageFormat('ID=ubuntu\nVERSION_ID="24.04"\n'), 'rpm');
  assert.deepEqual(debBackend().installCommand('downgrade', '/tmp/candidate.deb'), [
    'sudo',
    ['apt-get', 'install', '-y', '--allow-downgrades', '/tmp/candidate.deb'],
  ]);
});

test('RPM output name is Fedora 44 x86_64 and refuses output collisions', async () => {
  const root = await tempDir('rpm output collision ');
  try {
    const output = rpmOutputPaths(root, {
      version: TARGET_FACTORY_VERSION,
      dist: '.fc44',
    });
    assert.equal(RPM_RELEASE, '8');
    assert.equal(output.filename, `factory-desktop-linux-${TARGET_FACTORY_VERSION}-${RPM_RELEASE}.fc44.x86_64.rpm`);
    assert.equal(output.rpmPath, path.join(root, output.filename));
    assert.equal(output.checksumPath, `${output.rpmPath}.sha256`);
    await assertNoRpmOutputCollisions(
      { rpmPath: output.rpmPath, checksumPath: output.checksumPath },
      async () => false,
    );
    await writeFile(output.rpmPath, 'existing rpm');
    await assert.rejects(
      () => assertNoRpmOutputCollisions(
        { rpmPath: output.rpmPath, checksumPath: output.checksumPath },
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
      /Refusing to overwrite existing RPM output/,
    );
    await rm(output.rpmPath);
    await writeFile(output.checksumPath, 'existing checksum');
    await assert.rejects(
      () => assertNoRpmOutputCollisions(
        { rpmPath: output.rpmPath, checksumPath: output.checksumPath },
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
      /Refusing to overwrite existing RPM output/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.throws(() => rpmOutputPaths('/tmp', {
    version: TARGET_FACTORY_VERSION,
    dist: '.el9',
  }), /restricted to Fedora 44/);
  assert.throws(() => rpmOutputPaths('/tmp', {
    version: TARGET_FACTORY_VERSION,
    dist: '.fc44',
    architecture: 'aarch64',
  }), /Only x86_64/);
});

test('RPM wrapper and desktop entry do not register callback handlers', async () => {
  const wrapper = createSystemWrapper();
  assert.match(wrapper, /^#!\/bin\/sh\nset -eu\nexec '\/opt\/factory-desktop-linux\/launch\.sh' "\$@"\n$/);
  assert.doesNotMatch(wrapper, /--no-sandbox|chrome-sandbox.*chmod|xdg-mime|MimeType=/i);
  const desktop = createDesktopEntry();
  assert.match(desktop, /^Name=Factory Desktop Linux$/m);
  assert.match(desktop, /^Exec=\/usr\/bin\/factory-desktop-linux$/m);
  assert.match(desktop, /^Icon=factory-desktop-linux$/m);
  assert.match(desktop, /unofficial.*personal use/i);
  assert.doesNotMatch(desktop, /^MimeType=|^Actions=|x-scheme-handler|%u|factory-[a-z0-9.+-]+:/im);

  const notice = await readFile(path.join(repoRoot, 'assets/rpm-personal-use-notice.txt'), 'utf8');
  assert.match(notice, /proprietary/i);
  assert.match(notice, /unofficial/i);
  assert.match(notice, /personal.use/i);
  assert.match(notice, /Do not publish or redistribute/i);
  const spec = await readFile(path.join(repoRoot, 'scripts/factory-desktop-linux.spec'), 'utf8');
  assert.match(spec, /^Name:\s+factory-desktop-linux$/m);
  assert.match(spec, /^Version:\s+%\{factory_version\}$/m);
  assert.match(spec, /^Release:\s+%\{rpm_release\}%\{\?dist\}$/m);
  assert.match(spec, /-type d -exec chmod 0755 \{\} \+/);
  assert.match(spec, /^BuildArch:\s+x86_64$/m);
  assert.match(spec, /^\/opt\/factory-desktop-linux\/$/m);
  assert.match(spec, /^\/usr\/bin\/factory-desktop-linux$/m);
  assert.match(spec, /^\/usr\/share\/applications\/factory-desktop-linux\.desktop$/m);
  assert.match(spec, /%license/);
  assert.doesNotMatch(spec, /^%post|^%preun|^%postun/m);
  assert.match(spec, /^Requires:\s+python3$/m);
  assert.match(spec, /^Requires:\s+util-linux-core$/m);
});

test('RPM wrapper forwards all arguments with shell-safe quoting', async () => {
  const root = await tempDir('rpm wrapper % quoted ');
  try {
    const bundle = path.join(root, `bundle 'quoted'`);
    await mkdir(bundle, { recursive: true });
    const capture = path.join(root, 'args.json');
    const launcher = path.join(bundle, 'launch.sh');
    await writeFile(launcher, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));
`);
    await chmod(launcher, 0o755);
    const wrapper = path.join(root, 'factory-desktop-linux');
    await writeFile(wrapper, createSystemWrapper(bundle));
    await chmod(wrapper, 0o755);
    const args = ['space "quotes"', "$dollar `tick` %u", '--open', 'ümlaut'];
    const result = spawnSync(wrapper, args, {
      env: { ...process.env, CAPTURE: capture },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), args);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RPM payload layout maps bundle and safe desktop integration paths', () => {
  const layout = rpmPayloadLayout([
    'factory-desktop',
    'launch.sh',
    'resources/bin/droid',
  ], '/usr/share/icons/hicolor/scalable/apps/factory-desktop-linux.svg', [
    'empty-directory',
  ]);
  assert.ok(layout.files.includes(`${RPM_BUNDLE_ROOT}/factory-desktop`));
  assert.ok(layout.files.includes(`${RPM_BUNDLE_ROOT}/resources/bin/droid`));
  assert.ok(layout.files.includes(RPM_WRAPPER_PATH));
  assert.ok(layout.files.includes(RPM_DESKTOP_PATH));
  assert.ok(layout.files.includes(RPM_LICENSE_PATH));
  assert.ok(layout.files.includes('/usr/share/icons/hicolor/scalable/apps/factory-desktop-linux.svg'));
  assert.ok(layout.paths.includes(RPM_BUNDLE_ROOT));
  assert.ok(layout.paths.includes(`${RPM_BUNDLE_ROOT}/empty-directory`));
  assert.ok(!layout.paths.includes('/usr/share/icons/hicolor/scalable/apps'));
  assert.throws(
    () => rpmPayloadLayout(['../outside'], '/usr/share/icons/hicolor/scalable/apps/icon.svg'),
    /Unsafe RPM bundle path/,
  );
});

test('RPM application icons use the right freedesktop icon theme location', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.deepEqual(iconInstallPath('factory-desktop.svg', svg), {
    path: '/usr/share/icons/hicolor/scalable/apps/factory-desktop-linux.svg',
    size: 'scalable',
    extension: 'svg',
  });
  const png = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(256, 16);
  png.writeUInt32BE(256, 20);
  assert.deepEqual(iconInstallPath('factory-desktop.png', png), {
    path: '/usr/share/icons/hicolor/256x256/apps/factory-desktop-linux.png',
    size: '256x256',
    extension: 'png',
  });
  assert.throws(() => iconInstallPath('factory-desktop.png', Buffer.from('invalid')), /invalid header/);
});

test('RPM filters private bundled library Provides and Requires', () => {
  const pattern = privateSonameExclusion(['libEGL.so.1', 'libGLESv2.so.2']);
  assert.match(pattern, /libEGL\[.\]so\[.\]1/);
  assert.match(pattern, /libGLESv2\[.\]so\[.\]2/);
  assert.equal(privateSonameExclusion([]), null);
  assert.throws(
    () => privateSonameExclusion(['libfoo.so; touch /tmp/x']),
    /Unexpected private ELF SONAME/,
  );
});

test('portable payload fingerprint detects changed bytes and permissions', async () => {
  const root = await tempDir('rpm mode fingerprint ');
  try {
    const file = path.join(root, 'payload');
    await writeFile(file, 'bundle content');
    await chmod(file, 0o644);
    const first = await hashTreeWithModes(root);
    await chmod(file, 0o755);
    assert.notEqual(await hashTreeWithModes(root), first);
    await chmod(file, 0o644);
    await writeFile(file, 'changed content');
    assert.notEqual(await hashTreeWithModes(root), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('updater recipes copied from a umask-077 tree become publicly readable', async () => {
  const root = await tempDir('rpm public recipe modes ');
  try {
    assert.equal(publicMode(0o600), 0o644);
    assert.equal(publicMode(0o700), 0o755);
    assert.equal(publicMode(0o4755), 0o755);
    assert.equal(publicMode(0o666), 0o644);
    assert.equal(publicMode(0o700, { directory: true }), 0o755);
    const source = path.join(root, 'source');
    const staged = path.join(root, 'staged');
    await mkdir(path.join(source, 'scripts'), { recursive: true });
    await writeFile(path.join(source, 'scripts', 'native.mjs'), 'recipe');
    await writeFile(path.join(source, 'scripts', 'launch.sh'), '#!/bin/sh\n');
    await chmod(path.join(source, 'scripts', 'native.mjs'), 0o600);
    await chmod(path.join(source, 'scripts', 'launch.sh'), 0o700);
    await chmod(path.join(source, 'scripts'), 0o700);
    await cp(source, staged, { recursive: true });
    assert.equal(await hashTreeWithModes(staged), await hashTreeWithModes(source));
    await normalizePublicModes(staged);
    assert.equal((await stat(path.join(staged, 'scripts'))).mode & 0o7777, 0o755);
    assert.equal((await stat(path.join(staged, 'scripts', 'native.mjs'))).mode & 0o7777, 0o644);
    assert.equal((await stat(path.join(staged, 'scripts', 'launch.sh'))).mode & 0o7777, 0o755);
    assert.notEqual(await hashTreeWithModes(staged), await hashTreeWithModes(source));
    assert.equal(
      await hashTreeWithModes(staged),
      await hashTreeWithModes(source, { expectPublicModes: true }),
    );
    await writeFile(path.join(staged, 'scripts', 'native.mjs'), 'changed recipe');
    assert.notEqual(
      await hashTreeWithModes(staged),
      await hashTreeWithModes(source, { expectPublicModes: true }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RPM payload layout preserves empty bundle directories', async () => {
  const root = await tempDir('rpm empty directory ');
  try {
    const empty = path.join(root, 'empty', 'nested');
    await mkdir(empty, { recursive: true });
    const directories = (await walkDirectories(root)).map((directory) => path.relative(root, directory));
    const layout = rpmPayloadLayout(
      [],
      '/usr/share/icons/hicolor/scalable/apps/factory-desktop-linux.svg',
      directories,
    );
    assert.ok(layout.paths.includes(`${RPM_BUNDLE_ROOT}/empty`));
    assert.ok(layout.paths.includes(`${RPM_BUNDLE_ROOT}/empty/nested`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop entry and RPM spec remain Fedora 44 only with no install actions', async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const versions = JSON.parse(await readFile(path.join(repoRoot, 'versions.json'), 'utf8'));
  const spec = await readFile(path.join(repoRoot, 'scripts/factory-desktop-linux.spec'), 'utf8');
  assert.equal(packageJson.scripts['package:rpm'], 'node scripts/package-rpm.mjs');
  assert.equal(versions.factory, TARGET_FACTORY_VERSION);
  assert.equal(distributionDirectory('factory-desktop-linux-validated'),
    path.join(repoRoot, 'dist', 'factory-desktop-linux-validated'));
  assert.match(spec, /Fedora 44 x86_64/);
  assert.doesNotMatch(spec, /^%post|^%preun|^%postun/m);
  assert.match(spec, /^Requires:\s+python3$/m);
  assert.match(spec, /^Requires:\s+util-linux-core$/m);
});

test('synthetic Fedora RPM metadata, payload layout, and hashes', { skip: !canBuildFedoraRpm }, async () => {
  const root = await tempDir('factory-rpm-build-fixture-');
  try {
    const top = path.join(root, 'rpmbuild');
    const sources = path.join(top, 'SOURCES');
    const payload = path.join(sources, 'payload');
    for (const directory of [
      path.join(top, 'BUILD'),
      path.join(top, 'BUILDROOT'),
      path.join(top, 'RPMS'),
      sources,
      path.join(top, 'SPECS'),
      path.join(top, 'SRPMS'),
      path.join(payload, 'resources', 'bin'),
      path.join(payload, 'empty', 'nested'),
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    const privateSource = path.join(root, 'private.c');
    const appSource = path.join(root, 'app.c');
    await writeFile(privateSource, 'int private_value(void) { return 42; }\n');
    await writeFile(appSource, 'extern int private_value(void); int main(void) { return private_value() == 42 ? 0 : 1; }\n');
    const privateLibrary = spawnSync('gcc', [
      '-shared',
      '-fPIC',
      '-Wl,-soname,libfactory-private.so.1',
      '-o',
      path.join(payload, 'libfactory-private.so.1'),
      privateSource,
    ], { encoding: 'utf8' });
    assert.equal(privateLibrary.status, 0, `${privateLibrary.stdout ?? ''}${privateLibrary.stderr ?? ''}`);
    const application = spawnSync('gcc', [
      `-L${payload}`,
      '-Wl,-rpath,$ORIGIN',
      '-o',
      path.join(payload, 'factory-desktop'),
      appSource,
      '-l:libfactory-private.so.1',
    ], { encoding: 'utf8' });
    assert.equal(application.status, 0, `${application.stdout ?? ''}${application.stderr ?? ''}`);
    await chmod(path.join(payload, 'factory-desktop'), 0o755);
    await chmod(path.join(payload, 'libfactory-private.so.1'), 0o755);
    await writeFile(path.join(payload, 'launch.sh'), '#!/bin/sh\nexec "$ROOT/factory-desktop" "$@"\n', { mode: 0o755 });
    await writeFile(path.join(payload, 'resources', 'bin', 'droid'), 'synthetic bundled cli', { mode: 0o755 });
    await writeFile(path.join(payload, 'resources', 'factory-desktop.svg'),
      await readFile(path.join(repoRoot, 'assets/factory-desktop.svg')), { mode: 0o644 });
    await writeFile(path.join(payload, 'build-manifest.json'),
      `${JSON.stringify({ factoryVersion: TARGET_FACTORY_VERSION })}\n`, { mode: 0o644 });
    await writeFile(path.join(sources, 'PERSONAL-USE-NOTICE.txt'),
      await readFile(path.join(repoRoot, 'assets/rpm-personal-use-notice.txt')), { mode: 0o644 });
    await writeFile(path.join(sources, 'factory-desktop-linux.desktop'), createDesktopEntry(), { mode: 0o644 });
    await writeFile(path.join(sources, 'factory-desktop-linux'), createSystemWrapper(), { mode: 0o755 });
    await writeFile(path.join(sources, 'factory-desktop-linux-icon'),
      await readFile(path.join(repoRoot, 'assets/factory-desktop.svg')), { mode: 0o644 });
    await writeFile(path.join(top, 'SPECS', 'factory-desktop-linux.spec'),
      await readFile(path.join(repoRoot, 'scripts/factory-desktop-linux.spec')));

    const expectedPayload = path.join(root, 'expected-payload');
    await cp(payload, expectedPayload, { recursive: true });
    for (const directory of [expectedPayload, ...await walkDirectories(expectedPayload)]) {
      await chmod(directory, 0o755);
    }
    const expectedPayloadHash = await hashTreeWithModes(expectedPayload);

    const exclusion = privateSonameExclusion(['libfactory-private.so.1']);
    const built = spawnSync('rpmbuild', [
      '--define', `_topdir ${top}`,
      '--define', `factory_version ${TARGET_FACTORY_VERSION}`,
      '--define', `rpm_release ${RPM_RELEASE}`,
      '--define', 'with_updater 0',
      '--define', 'app_icon_size scalable',
      '--define', 'app_icon_extension svg',
      '--define', `__provides_exclude ${exclusion}`,
      '--define', `__requires_exclude ${exclusion}`,
      '-bb',
      path.join(top, 'SPECS', 'factory-desktop-linux.spec'),
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(built.status, 0, `${built.stdout ?? ''}${built.stderr ?? ''}`);
    const rpmDirectory = path.join(top, 'RPMS');
    const rpmFiles = [];
    for (const directoryEntry of await (await import('node:fs/promises')).readdir(rpmDirectory, { withFileTypes: true })) {
      if (directoryEntry.isDirectory()) {
        for (const filename of await (await import('node:fs/promises')).readdir(path.join(rpmDirectory, directoryEntry.name))) {
          if (filename.endsWith('.rpm')) rpmFiles.push(path.join(rpmDirectory, directoryEntry.name, filename));
        }
      } else if (directoryEntry.name.endsWith('.rpm')) rpmFiles.push(path.join(rpmDirectory, directoryEntry.name));
    }
    assert.equal(rpmFiles.length, 1);
    const rpmPath = rpmFiles[0];
    const metadata = spawnSync('rpm', [
      '-qp',
      '--queryformat',
      '%{NAME}\\n%{VERSION}\\n%{RELEASE}\\n%{ARCH}\\n%{LICENSE}\\n',
      rpmPath,
    ], { encoding: 'utf8' });
    assert.equal(metadata.status, 0, metadata.stderr);
    assert.deepEqual(metadata.stdout.trimEnd().split('\n'), [
      'factory-desktop-linux',
      TARGET_FACTORY_VERSION,
      `${RPM_RELEASE}.fc44`,
      'x86_64',
      'LicenseRef-Proprietary',
    ]);
    const safetyMetadata = spawnSync('rpm', [
      '-qp',
      '--queryformat',
      '[%{FILENAMES}\\t%{FILECAPS}\\t%{FILELINKTOS}\\n]',
      rpmPath,
    ], { encoding: 'utf8' });
    assert.equal(safetyMetadata.status, 0, safetyMetadata.stderr);
    for (const line of safetyMetadata.stdout.replace(/\n$/, '').split('\n')) {
      const fields = line.split('\t');
      assert.equal(fields.length, 3, line);
      assert.ok(['', 'none', '(none)'].includes(fields[1]), line);
      assert.ok(['', 'none', '(none)'].includes(fields[2]), line);
    }
    const fileList = spawnSync('rpm', ['-qp', '--queryformat', '[%{FILENAMES}\\n]', rpmPath], {
      encoding: 'utf8',
    });
    assert.equal(fileList.status, 0, fileList.stderr);
    const layout = rpmPayloadLayout([
      'build-manifest.json',
      'factory-desktop',
      'launch.sh',
      'libfactory-private.so.1',
      'resources/bin/droid',
      'resources/factory-desktop.svg',
    ], '/usr/share/icons/hicolor/scalable/apps/factory-desktop-linux.svg', [
      'empty',
      'empty/nested',
      'resources',
      'resources/bin',
    ]);
    assert.deepEqual(fileList.stdout.trim().split('\n').sort(), layout.paths);
    const ownership = spawnSync('rpm', [
      '-qp',
      '--queryformat',
      '[%{FILENAMES}\\t%{FILEMODES:perms}\\t%{FILEUSERNAME}\\t%{FILEGROUPNAME}\\n]',
      rpmPath,
    ], { encoding: 'utf8' });
    assert.equal(ownership.status, 0, ownership.stderr);
    for (const line of ownership.stdout.trimEnd().split('\n')) {
      const [filename, mode, owner, group] = line.split('\t');
      assert.equal(owner, 'root', line);
      assert.equal(group, 'root', line);
      if ((filename === RPM_BUNDLE_ROOT || filename.startsWith(`${RPM_BUNDLE_ROOT}/`)) && mode.startsWith('d')) {
        assert.equal(mode, 'drwxr-xr-x', line);
      }
      if (/factory-desktop$|libfactory-private\.so\.1$/.test(filename)) {
        assert.equal(mode, '-rwxr-xr-x', line);
        assert.doesNotMatch(mode, /[sS]/);
      }
    }
    const requires = spawnSync('rpm', ['-qp', '--requires', rpmPath], { encoding: 'utf8' });
    assert.equal(requires.status, 0, requires.stderr);
    assert.match(requires.stdout, /libc\.so\.6/);
    assert.doesNotMatch(requires.stdout, /libfactory-private/);
    const provides = spawnSync('rpm', ['-qp', '--provides', rpmPath], { encoding: 'utf8' });
    assert.equal(provides.status, 0, provides.stderr);
    assert.doesNotMatch(provides.stdout, /libfactory-private/);

    const extracted = path.join(root, 'extracted');
    await mkdir(extracted);
    const cpio = spawnSync('sh', [
      '-c',
      'rpm2cpio "$1" | cpio -idm --quiet --no-absolute-filenames',
      'rpm-extract',
      rpmPath,
    ], { cwd: extracted, encoding: 'utf8' });
    assert.equal(cpio.status, 0, cpio.stderr);
    assert.equal(
      await hashTreeWithModes(path.join(extracted, RPM_BUNDLE_ROOT.slice(1))),
      expectedPayloadHash,
    );
    const desktopCheck = spawnSync('desktop-file-validate', [
      path.join(extracted, RPM_DESKTOP_PATH.slice(1)),
    ], { encoding: 'utf8' });
    assert.equal(desktopCheck.status, 0, desktopCheck.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
