import path from 'node:path';
import { fail } from './lib.mjs';

export const RPM_PACKAGE_NAME = 'factory-desktop-linux';
export const RPM_RELEASE = '7';
export const RPM_BUNDLE_ROOT = '/opt/factory-desktop-linux';
export const RPM_WRAPPER_PATH = '/usr/bin/factory-desktop-linux';
export const RPM_DESKTOP_PATH = '/usr/share/applications/factory-desktop-linux.desktop';
export const RPM_LICENSE_PATH =
  `/usr/share/licenses/${RPM_PACKAGE_NAME}/PERSONAL-USE-NOTICE.txt`;

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

function shellQuote(value) {
  if (value.includes('\n') || value.includes('\r')) {
    fail('RPM launcher path cannot contain a newline.');
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function createSystemWrapper(bundleRoot = RPM_BUNDLE_ROOT) {
  const launcher = path.join(bundleRoot, 'launch.sh');
  if (!path.isAbsolute(bundleRoot)) fail('RPM bundle path must be absolute.');
  return [
    '#!/bin/sh',
    'set -eu',
    `exec ${shellQuote(launcher)} "$@"`,
    '',
  ].join('\n');
}

export function createDesktopEntry() {
  return [
    '[Desktop Entry]',
    'Version=1.0',
    'Type=Application',
    'Name=Factory Desktop Linux',
    'Comment=Proprietary, unofficial Factory Desktop port for personal use',
    `Exec=${RPM_WRAPPER_PATH}`,
    `Icon=${RPM_PACKAGE_NAME}`,
    'Terminal=false',
    'Categories=Development;',
    'StartupWMClass=factory-desktop',
    '',
  ].join('\n');
}

export function iconInstallPath(iconName, iconBytes) {
  const extension = path.extname(iconName).toLowerCase();
  if (extension === '.svg') {
    return {
      path: `/usr/share/icons/hicolor/scalable/apps/${RPM_PACKAGE_NAME}.svg`,
      size: 'scalable',
      extension: 'svg',
    };
  }
  if (extension !== '.png') fail(`Unsupported Factory app icon format: ${extension || 'none'}.`);
  if (!Buffer.isBuffer(iconBytes) || iconBytes.length < 24 ||
      iconBytes.toString('hex', 0, 8) !== '89504e470d0a1a0a' ||
      iconBytes.toString('ascii', 12, 16) !== 'IHDR') {
    fail('The bundled PNG application icon has an invalid header.');
  }
  const width = iconBytes.readUInt32BE(16);
  const height = iconBytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width !== height) {
    fail(`The bundled PNG application icon must be square, found ${width}x${height}.`);
  }
  return {
    path: `/usr/share/icons/hicolor/${width}x${height}/apps/${RPM_PACKAGE_NAME}.png`,
    size: `${width}x${height}`,
    extension: 'png',
  };
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
  const normalizedBundleFiles = bundleRelativeFiles.map((relative) => {
    const portable = relative.split(path.sep).join('/');
    const segments = portable.split('/');
    if (!portable || path.posix.isAbsolute(portable) || segments.some((segment) =>
      segment === '..' || segment === '.' || segment === '')) {
      fail(`Unsafe RPM bundle path: ${relative}`);
    }
    return `${RPM_BUNDLE_ROOT}/${portable}`;
  });
  if (new Set(normalizedBundleFiles).size !== normalizedBundleFiles.length) {
    fail('RPM bundle contains duplicate relative file paths.');
  }
  const normalizedBundleDirectories = bundleRelativeDirectories.map((relative) => {
    const portable = relative.split(path.sep).join('/');
    const segments = portable.split('/');
    if (!portable || path.posix.isAbsolute(portable) || segments.some((segment) =>
      segment === '..' || segment === '.' || segment === '')) {
      fail(`Unsafe RPM bundle directory: ${relative}`);
    }
    return `${RPM_BUNDLE_ROOT}/${portable}`;
  });
  if (new Set(normalizedBundleDirectories).size !== normalizedBundleDirectories.length) {
    fail('RPM bundle contains duplicate relative directory paths.');
  }

  const standaloneFiles = [
    RPM_WRAPPER_PATH,
    RPM_DESKTOP_PATH,
    iconTargetPath,
    RPM_LICENSE_PATH,
  ];
  const files = [...normalizedBundleFiles, ...standaloneFiles];
  const directories = new Set([RPM_BUNDLE_ROOT]);
  for (const directory of normalizedBundleDirectories) directories.add(directory);
  for (const file of [...normalizedBundleFiles, ...normalizedBundleDirectories]) {
    let parent = path.posix.dirname(file);
    while (parent !== RPM_BUNDLE_ROOT && parent !== '/' && parent !== '.') {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return {
    files,
    paths: [...directories, ...files].sort(),
  };
}
