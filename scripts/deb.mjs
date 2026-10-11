// Debian (.deb) packaging primitives, mirroring scripts/rpm.mjs for the
// Fedora RPM path. Pure functions here so the layout, naming, dependency, and
// control-file rules are unit-testable without building a package.
import path from 'node:path';
import { fail } from './lib.mjs';
import {
  BUNDLE_ROOT,
  DESKTOP_PATH,
  PACKAGE_NAME,
  WRAPPER_PATH,
  createDesktopEntry,
  createSystemWrapper,
  iconInstallPath,
  payloadLayout,
} from './packaging-common.mjs';

export const DEB_PACKAGE_NAME = PACKAGE_NAME;
export const DEB_RELEASE = '7';
export const DEB_ARCHITECTURE = 'amd64';
export const DEB_BUNDLE_ROOT = BUNDLE_ROOT;
export const DEB_WRAPPER_PATH = WRAPPER_PATH;
export const DEB_DESKTOP_PATH = DESKTOP_PATH;
export const DEB_COPYRIGHT_PATH = `/usr/share/doc/${DEB_PACKAGE_NAME}/copyright`;
export const DEB_MAINTAINER = 'Factory Desktop Linux Port <noreply@example.invalid>';
export const DEB_SYNOPSIS = 'Unofficial personal-use Factory Desktop port';
export const DEB_DESCRIPTION = [
  'Unofficial personal-use port of Factory Desktop 0.194.0 for Ubuntu 24.04',
  'or newer x86_64. This .deb installs the same portable bundle as the Fedora',
  'RPM.',
  '',
  'This proprietary application is not produced, endorsed, or supported by',
  'Factory. The package is for personal use only and must not be published.',
];

export { createDesktopEntry, createSystemWrapper, iconInstallPath };

export function debOutputPaths(outputDirectory, {
  version,
  release = DEB_RELEASE,
  architecture = DEB_ARCHITECTURE,
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail('Debian version must be a numeric semantic version.');
  if (!/^[A-Za-z0-9.+~]+$/.test(release ?? '')) fail('Debian revision contains unsupported characters.');
  if (architecture !== 'amd64') fail(`Only amd64 .deb output is supported, not ${architecture}.`);
  const filename = `${DEB_PACKAGE_NAME}_${version}-${release}_${architecture}.deb`;
  return {
    debPath: path.join(outputDirectory, filename),
    checksumPath: path.join(outputDirectory, `${filename}.sha256`),
    filename,
  };
}

export async function assertNoDebOutputCollisions(paths, existsFn) {
  const collisions = [];
  for (const candidate of [paths.debPath, paths.checksumPath]) {
    if (await existsFn(candidate)) collisions.push(candidate);
  }
  if (collisions.length) {
    fail(`Refusing to overwrite existing .deb output(s): ${collisions.join(', ')}`);
  }
}

export function debPayloadLayout(bundleRelativeFiles, iconTargetPath, bundleRelativeDirectories = []) {
  return payloadLayout({
    label: 'Debian',
    bundleRoot: DEB_BUNDLE_ROOT,
    bundleRelativeFiles,
    iconTargetPath,
    bundleRelativeDirectories,
    standaloneFiles: [DEB_WRAPPER_PATH, DEB_DESKTOP_PATH, DEB_COPYRIGHT_PATH],
  });
}

// Shared-library SONAMEs whose Debian package name is stable and cannot be
// resolved reliably with dpkg -S alone (or must always be declared).
const SONAME_PACKAGE_MAP = {
  'libc.so.6': 'libc6',
  'libsecret-1.so.0': 'libsecret-1-0',
};

export function normalizeDebianPackageName(name) {
  const base = String(name ?? '').split(':')[0].trim();
  if (!/^[a-z0-9][a-z0-9+.-]*$/.test(base)) fail(`Unexpected Debian package name: ${name}`);
  return base;
}

export function debianPackageForLibrary(soname, resolvedPath, lookup) {
  if (SONAME_PACKAGE_MAP[soname]) return SONAME_PACKAGE_MAP[soname];
  if (!resolvedPath) fail(`No resolved system path for shared library ${soname}.`);
  const owner = lookup(resolvedPath);
  if (!owner) fail(`Cannot determine the Debian package providing ${soname} (${resolvedPath}).`);
  return normalizeDebianPackageName(owner);
}

export function debianDependencies(externalDependencies, externalPaths, lookup) {
  const packages = new Set();
  for (const soname of externalDependencies) {
    packages.add(debianPackageForLibrary(soname, externalPaths.get(soname), lookup));
  }
  if (!packages.has('libsecret-1-0')) {
    fail('Debian dependency set is missing libsecret-1-0 for the unpacked keytar module.');
  }
  return [...packages].sort();
}

export function debianInstalledSizeKiB(totalBytes) {
  if (!Number.isFinite(totalBytes) || totalBytes < 0) fail('Invalid installed size for the .deb payload.');
  return Math.max(1, Math.ceil(totalBytes / 1024));
}

export function createControlFile({
  version,
  architecture = DEB_ARCHITECTURE,
  installedSizeKiB,
  depends,
  synopsis = DEB_SYNOPSIS,
  description = DEB_DESCRIPTION,
}) {
  if (architecture !== 'amd64') fail(`Only amd64 .deb control files are supported, not ${architecture}.`);
  if (!/^\d+\.\d+\.\d+-\d+$/.test(version ?? '')) {
    fail('Debian control version must be <upstream>-<revision>.');
  }
  if (!Number.isInteger(installedSizeKiB) || installedSizeKiB < 1) {
    fail('Debian installed size must be a positive integer number of kibibytes.');
  }
  if (!Array.isArray(depends) || depends.length === 0) {
    fail('The Debian control file needs at least one runtime dependency.');
  }
  const normalizedDepends = [...new Set(depends.map(normalizeDebianPackageName))].sort();
  const lines = [
    `Package: ${DEB_PACKAGE_NAME}`,
    `Version: ${version}`,
    `Architecture: ${architecture}`,
    `Maintainer: ${DEB_MAINTAINER}`,
    `Installed-Size: ${installedSizeKiB}`,
    `Depends: ${normalizedDepends.join(', ')}`,
    'Section: devel',
    'Priority: optional',
    'Homepage: https://factory.ai',
    `Description: ${synopsis}`,
  ];
  for (const line of description) {
    if (/\r|\n/.test(line)) fail('Debian control description lines may not contain newlines.');
    lines.push(line === '' ? ' .' : ` ${line}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatMd5sums(entries) {
  const lines = entries.map(({ path: filePath, md5 }) => {
    if (typeof filePath !== 'string' || !filePath.startsWith('/')) {
      fail(`Invalid .deb md5sums entry path: ${filePath}`);
    }
    if (!/^[a-f0-9]{32}$/.test(md5 ?? '')) fail(`Invalid md5sum for ${filePath}.`);
    return `${md5}  ${filePath.replace(/^\//, '')}`;
  }).sort((left, right) => left.localeCompare(right));
  return lines.length ? `${lines.join('\n')}\n` : '';
}
