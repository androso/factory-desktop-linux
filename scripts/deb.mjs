import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fail } from './lib.mjs';

export const DEB_PACKAGE_NAME = 'factory-desktop-linux';
export const DEB_REVISION = '1ubuntu26.04';
export const DEB_BUNDLE_ROOT = '/opt/factory-desktop-linux';
export const DEB_WRAPPER_PATH = '/usr/bin/factory-desktop-linux';
export const DEB_UPDATE_MANAGER_PATH = '/usr/bin/factory-update-manager';
export const DEB_INSTALL_HELPER_PATH = '/usr/libexec/factory-desktop-linux/install-helper';
export const DEB_DESKTOP_PATH = '/usr/share/applications/factory-desktop-linux.desktop';
export const DEB_LICENSE_PATH = `/usr/share/doc/${DEB_PACKAGE_NAME}/PERSONAL-USE-NOTICE.txt`;

const VERSION = /^(\d+)\.(\d+)\.(\d+)-1ubuntu26\.04$/;

export function parseDebIdentity(text) {
  const fields = text.trim().split(/\t|\r?\n/);
  if (fields.length !== 3 || fields[0] !== DEB_PACKAGE_NAME ||
      !VERSION.test(fields[1]) || fields[2] !== 'amd64') {
    fail('Unexpected DEB package name, version/revision, or architecture.');
  }
  return { name: fields[0], version: fields[1], architecture: fields[2] };
}

export function debOutputPaths(outputDirectory, {
  version,
  revision = DEB_REVISION,
  architecture = 'amd64',
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail('DEB version must be a numeric semantic version.');
  if (revision !== DEB_REVISION) fail(`DEB output is restricted to Ubuntu 26.04 (${DEB_REVISION}).`);
  if (architecture !== 'amd64') fail(`Only amd64 DEB output is supported, not ${architecture}.`);
  const filename = `${DEB_PACKAGE_NAME}_${version}-${revision}_${architecture}.deb`;
  const debPath = path.join(outputDirectory, filename);
  return { debPath, packagePath: debPath, checksumPath: `${debPath}.sha256`, filename };
}

export async function assertNoDebOutputCollisions(paths, existsFn) {
  const collisions = [];
  for (const candidate of [paths.debPath, paths.checksumPath]) {
    if (await existsFn(candidate)) collisions.push(candidate);
  }
  if (collisions.length) fail(`Refusing to overwrite existing DEB output(s): ${collisions.join(', ')}`);
}

export function compareDebVersions(left, right) {
  const a = VERSION.exec(left ?? '');
  const b = VERSION.exec(right ?? '');
  if (!a || !b) fail('Cannot compare an invalid Ubuntu DEB version.');
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function debPackageIdentity(file, run = defaultRun) {
  return parseDebIdentity(run('dpkg-deb', ['-f', file, 'Package', 'Version', 'Architecture'], { capture: true }));
}

export function installedDebIdentity() {
  const query = spawnSync('/usr/bin/dpkg-query', [
    '-W', '-f=${Package}\\t${Version}\\t${Architecture}\\n', DEB_PACKAGE_NAME,
  ], { encoding: 'utf8' });
  if (query.error) throw query.error;
  if (query.status === 1 && /no packages found matching/i.test(query.stderr ?? '')) return null;
  if (query.status !== 0) fail(`Cannot query installed DEB: ${query.stderr || query.stdout}`);
  const status = spawnSync('/usr/bin/dpkg-query', [
    '-W', '-f=${db:Status-Status}', DEB_PACKAGE_NAME,
  ], { encoding: 'utf8' });
  if (status.error) throw status.error;
  if (status.status !== 0 || status.stdout.trim() !== 'installed') {
    fail('Factory Desktop DEB is not fully configured. Run make recover and inspect dpkg status.');
  }
  return parseDebIdentity(query.stdout);
}

export function compareDebVersionsOnHost(left, right) {
  const args = ['/usr/bin/dpkg', '--compare-versions', left, 'lt', right];
  const lower = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
  if (lower.error) throw lower.error;
  if (lower.status === 0) return -1;
  const greater = spawnSync('/usr/bin/dpkg', ['--compare-versions', left, 'gt', right], { encoding: 'utf8' });
  if (greater.error) throw greater.error;
  if (greater.status === 0) return 1;
  if (greater.status === 1) return 0;
  fail(`dpkg could not compare package versions: ${greater.stderr || greater.status}`);
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.status}`);
  }
  return result.stdout.trim();
}
