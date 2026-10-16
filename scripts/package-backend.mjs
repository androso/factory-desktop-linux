import { RPM_PACKAGE_NAME, verifyInstalledRpm } from './rpm.mjs';
import {
  compareDebVersionsOnHost, debPackageIdentity, DEB_PACKAGE_NAME, parseDebIdentity,
  installedDebIdentity,
} from './deb.mjs';
import {
  compareVersions, installedIdentity, packageIdentity, parseIdentity,
} from './native.mjs';
import { readFileSync } from 'node:fs';

export function rpmBackend() {
  return {
    format: 'rpm',
    extension: '.rpm',
    pathKey: 'rpmPath',
    packageName: RPM_PACKAGE_NAME,
    identity: packageIdentity,
    installedIdentity,
    compareVersions,
    manifestSha256(file, run) {
      return run('rpm', ['-qp', '--dump', file], { capture: true })
        .split('\n').find((line) => line.startsWith('/opt/factory-desktop-linux/build-manifest.json '))
        ?.split(/\s+/)[3] ?? null;
    },
    hasUpdater(file, run) {
      const files = run('rpm', ['-qp', '--queryformat', '[%{FILENAMES}\\n]', file], { capture: true });
      return files.split('\n').includes('/usr/bin/factory-update-manager');
    },
    verifyInstalled: verifyInstalledRpm,
    installCommand(operation, file) { return ['sudo', ['dnf', operation, '-y', file]]; },
    operationLabel(operation) { return `sudo dnf ${operation}`; },
    parseIdentity,
    packageFactoryVersion(identity) {
      return identity?.version?.match(/^(\d+\.\d+\.\d+)-/)?.[1] ?? null;
    },
  };
}

export function debBackend() {
  return {
    format: 'deb',
    extension: '.deb',
    pathKey: 'debPath',
    packageName: DEB_PACKAGE_NAME,
    identity: debPackageIdentity,
    installedIdentity: installedDebIdentity,
    compareVersions: compareDebVersionsOnHost,
    manifestSha256(file, run) {
      const value = run('dpkg-deb', ['-f', file, 'X-Factory-Build-Manifest-SHA256'], { capture: true });
      return /^[a-f0-9]{64}$/.test(value) ? value : null;
    },
    hasUpdater(file, run) {
      return run('dpkg-deb', ['-f', file, 'X-Factory-Updater'], { capture: true }).trim() === 'yes';
    },
    verifyInstalled(run) {
      const result = run('dpkg', ['--verify', DEB_PACKAGE_NAME], { capture: true });
      if (result.trim()) throw new Error(`Installed DEB file verification failed: ${result}`);
    },
    installCommand(operation, file) {
      return ['sudo', [
        'apt-get', 'install', '-y',
        ...(operation === 'reinstall' ? ['--reinstall'] : []),
        ...(operation === 'downgrade' ? ['--allow-downgrades'] : []),
        file,
      ]];
    },
    operationLabel() { return 'sudo apt-get install'; },
    parseIdentity: parseDebIdentity,
    packageFactoryVersion(identity) {
      return identity?.version?.match(/^(\d+\.\d+\.\d+)-/)?.[1] ?? null;
    },
  };
}

export function detectPackageFormat(osReleaseText = readOsReleaseText()) {
  const values = Object.fromEntries(osReleaseText.split(/\r?\n/)
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => {
      const split = line.indexOf('=');
      return [line.slice(0, split), line.slice(split + 1).replace(/^["']|["']$/g, '')];
    }));
  if (values.ID === 'ubuntu' && values.VERSION_ID === '26.04') return 'deb';
  return 'rpm';
}

function readOsReleaseText() {
  try { return readFileSync('/etc/os-release', 'utf8'); } catch { return ''; }
}

export function packageBackend(format = process.env.PACKAGE_FORMAT || detectPackageFormat()) {
  if (format === 'rpm') return rpmBackend();
  if (format === 'deb') return debBackend();
  throw new Error(`Unsupported native package format: ${format}`);
}
