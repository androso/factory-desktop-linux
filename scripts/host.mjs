import { readOsRelease, run } from './lib.mjs';

export const SUPPORTED_BUILD_HOSTS = [
  {
    id: 'ubuntu',
    version: '24.04',
    label: 'Ubuntu 24.04',
    packageManager: 'apt-get',
    libsecretPackage: 'libsecret-1-dev',
    rpmPackaging: false,
  },
  {
    id: 'fedora',
    version: '44',
    label: 'Fedora 44',
    packageManager: 'dnf',
    libsecretPackage: 'libsecret-devel',
    rpmPackaging: true,
  },
];

export const COMMON_BUILD_COMMANDS = [
  'node',
  'npm',
  'pkg-config',
  'gcc',
  'g++',
  'make',
  'python3',
  'ldd',
];

export const FEDORA_RPM_COMMANDS = [
  'rpmbuild',
  'rpm',
  'rpm2cpio',
  'cpio',
  'readelf',
  'desktop-file-validate',
];

export const OPTIONAL_BUILD_COMMANDS = [
  'Xvfb',
  'xvfb-run',
  'dbus-run-session',
  'unshare',
  'xauth',
  'xdg-mime',
];

const FEDORA_COMMAND_PACKAGES = {
  node: 'nodejs',
  npm: 'npm',
  'pkg-config': 'pkgconf-pkg-config',
  gcc: 'gcc',
  'g++': 'gcc-c++',
  make: 'make',
  python3: 'python3',
  ldd: 'glibc-common',
  rpmbuild: 'rpm-build',
  rpm: 'rpm',
  rpm2cpio: 'rpm',
  cpio: 'cpio',
  readelf: 'binutils',
  'desktop-file-validate': 'desktop-file-utils',
};

const UBUNTU_COMMAND_PACKAGES = {
  node: 'nodejs',
  npm: 'npm',
  'pkg-config': 'pkg-config',
  gcc: 'build-essential',
  'g++': 'build-essential',
  make: 'build-essential',
  python3: 'python3',
  ldd: 'libc-bin',
};

export function requiredCommandsForHost(host) {
  return [
    ...COMMON_BUILD_COMMANDS,
    ...(host?.rpmPackaging ? FEDORA_RPM_COMMANDS : []),
  ];
}

export function evaluateBuildHost({
  osRelease = {},
  machine = '',
  nodeArchitecture = '',
} = {}) {
  const profile = SUPPORTED_BUILD_HOSTS.find((item) =>
    item.id === osRelease.ID && item.version === osRelease.VERSION_ID) ?? null;
  const architectureSupported = machine === 'x86_64' && nodeArchitecture === 'x64';
  const issues = [];

  if (!profile) {
    issues.push(
      `Expected Ubuntu 24.04 or Fedora 44; found ${osRelease.PRETTY_NAME ??
        `${osRelease.ID ?? 'unknown'} ${osRelease.VERSION_ID ?? ''}`.trim()}.`,
    );
  }
  if (machine !== 'x86_64') issues.push(`Expected x86_64 host, found ${machine || 'unknown'}.`);
  if (nodeArchitecture !== 'x64') {
    issues.push(`Expected x64 Node.js, found ${nodeArchitecture || 'unknown'}.`);
  }

  return {
    supported: Boolean(profile && architectureSupported),
    profile,
    displayName: osRelease.PRETTY_NAME ??
      `${osRelease.ID ?? 'unknown'} ${osRelease.VERSION_ID ?? ''}`.trim(),
    id: osRelease.ID ?? null,
    version: osRelease.VERSION_ID ?? null,
    machine,
    nodeArchitecture,
    architectureSupported,
    issues,
  };
}

export async function detectBuildHost() {
  const osRelease = await readOsRelease();
  const architecture = run('uname', ['-m']);
  return evaluateBuildHost({
    osRelease,
    machine: architecture.status === 0 ? architecture.stdout.trim() : '',
    nodeArchitecture: process.arch,
  });
}

export function packagesForMissingPrerequisites(host, missingCommands = [], missingLibsecret = false) {
  if (!host) return [];
  const commandPackages = host.id === 'fedora' ? FEDORA_COMMAND_PACKAGES : UBUNTU_COMMAND_PACKAGES;
  const packages = missingCommands.map((command) => commandPackages[command]).filter(Boolean);
  if (missingLibsecret) packages.push(host.profile.libsecretPackage);
  return [...new Set(packages)].sort();
}

export function packageInstallCommand(host, packages) {
  if (!host?.profile || packages.length === 0) return null;
  const manager = host.profile.packageManager;
  return manager === 'dnf'
    ? `sudo dnf install ${packages.join(' ')}`
    : `sudo apt-get install ${packages.join(' ')}`;
}
