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

export const RPM_PACKAGE_NAME = PACKAGE_NAME;
export const RPM_RELEASE = '7';
export const RPM_BUNDLE_ROOT = BUNDLE_ROOT;
export const RPM_WRAPPER_PATH = WRAPPER_PATH;
export const RPM_DESKTOP_PATH = DESKTOP_PATH;
export const RPM_LICENSE_PATH =
  `/usr/share/licenses/${RPM_PACKAGE_NAME}/PERSONAL-USE-NOTICE.txt`;

export { createDesktopEntry, createSystemWrapper, iconInstallPath };

export function rpmOutputPaths(outputDirectory, {
  version,
  release = RPM_RELEASE,
  dist,
  architecture = 'x86_64',
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail('RPM version must be a numeric semantic version.');
  if (!/^[A-Za-z0-9._+-]+$/.test(release ?? '')) fail('RPM release contains unsupported characters.');
  if (dist !== '.fc44') fail(`RPM output is restricted to Fedora 44 (.fc44), not ${dist ?? 'an unset dist tag'}.`);
  if (architecture !== 'x86_64') fail(`Only x86_64 RPM output is supported, not ${architecture}.`);
  const filename = `${RPM_PACKAGE_NAME}-${version}-${release}${dist}.${architecture}.rpm`;
  return {
    rpmPath: path.join(outputDirectory, filename),
    checksumPath: path.join(outputDirectory, `${filename}.sha256`),
    filename,
  };
}

export async function assertNoRpmOutputCollisions(paths, existsFn) {
  const collisions = [];
  for (const candidate of [paths.rpmPath, paths.checksumPath]) {
    if (await existsFn(candidate)) collisions.push(candidate);
  }
  if (collisions.length) {
    fail(`Refusing to overwrite existing RPM output(s): ${collisions.join(', ')}`);
  }
}

export function privateSonameExclusion(sonames) {
  const escaped = [...new Set(sonames)].sort().map((soname) => {
    if (!/^[A-Za-z0-9._+-]+$/.test(soname)) {
      fail(`Unexpected private ELF SONAME: ${soname}`);
    }
    return soname.replace(/[.+-]/g, (character) => `[${character}]`);
  });
  if (!escaped.length) return null;
  return `^(${escaped.join('|')})([(][^)]*[)])*[(]64bit[)]$`;
}

export function rpmPayloadLayout(bundleRelativeFiles, iconTargetPath, bundleRelativeDirectories = []) {
  return payloadLayout({
    label: 'RPM',
    bundleRoot: RPM_BUNDLE_ROOT,
    bundleRelativeFiles,
    iconTargetPath,
    bundleRelativeDirectories,
    standaloneFiles: [RPM_WRAPPER_PATH, RPM_DESKTOP_PATH, RPM_LICENSE_PATH],
  });
}
