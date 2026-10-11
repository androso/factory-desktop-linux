// Packaging primitives shared by the Fedora RPM and Ubuntu .deb pipelines.
// Both formats install the same bundle layout, wrapper, menu entry, and icons,
// so the definitions live here once and each format parameterizes them.
import path from 'node:path';
import { fail } from './lib.mjs';

export const PACKAGE_NAME = 'factory-desktop-linux';
export const BUNDLE_ROOT = '/opt/factory-desktop-linux';
export const WRAPPER_PATH = '/usr/bin/factory-desktop-linux';
// The desktop entry must be named after the application id the app reports on
// Wayland ("factory"), otherwise GNOME cannot associate the window with the
// entry and falls back to a generic icon.
export const DESKTOP_PATH = '/usr/share/applications/factory.desktop';

function shellQuote(value) {
  if (value.includes('\n') || value.includes('\r')) {
    fail('Package launcher path cannot contain a newline.');
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function createSystemWrapper(bundleRoot = BUNDLE_ROOT) {
  const launcher = path.join(bundleRoot, 'launch.sh');
  if (!path.isAbsolute(bundleRoot)) fail('Package bundle path must be absolute.');
  return [
    '#!/bin/sh',
    'set -eu',
    `exec ${shellQuote(launcher)} "$@"`,
    '',
  ].join('\n');
}

export function createDesktopEntry({ wrapperPath = WRAPPER_PATH, packageName = PACKAGE_NAME } = {}) {
  return [
    '[Desktop Entry]',
    'Version=1.0',
    'Type=Application',
    'Name=Factory Desktop Linux',
    'Comment=Proprietary, unofficial Factory Desktop port for personal use',
    `Exec=${wrapperPath}`,
    `Icon=${packageName}`,
    'Terminal=false',
    'Categories=Development;',
    'StartupWMClass=factory',
    '',
  ].join('\n');
}

export function iconInstallPath(iconName, iconBytes, packageName = PACKAGE_NAME) {
  const extension = path.extname(iconName).toLowerCase();
  if (extension === '.svg') {
    return {
      path: `/usr/share/icons/hicolor/scalable/apps/${packageName}.svg`,
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
    path: `/usr/share/icons/hicolor/${width}x${height}/apps/${packageName}.png`,
    size: `${width}x${height}`,
    extension: 'png',
  };
}

function normalizeBundlePath(relative, label, kind) {
  const portable = relative.split(path.sep).join('/');
  const segments = portable.split('/');
  if (!portable || path.posix.isAbsolute(portable) || segments.some((segment) =>
    segment === '..' || segment === '.' || segment === '')) {
    fail(`Unsafe ${label} bundle ${kind}: ${relative}`);
  }
  return portable;
}

export function payloadLayout({
  label,
  bundleRoot,
  bundleRelativeFiles,
  iconTargetPath,
  bundleRelativeDirectories = [],
  standaloneFiles = [],
}) {
  if (!path.isAbsolute(bundleRoot)) fail(`${label} bundle root must be absolute.`);
  const normalizedBundleFiles = bundleRelativeFiles.map((relative) => {
    const portable = normalizeBundlePath(relative, label, 'path');
    return `${bundleRoot}/${portable}`;
  });
  if (new Set(normalizedBundleFiles).size !== normalizedBundleFiles.length) {
    fail(`${label} bundle contains duplicate relative file paths.`);
  }
  const normalizedBundleDirectories = bundleRelativeDirectories.map((relative) => {
    const portable = normalizeBundlePath(relative, label, 'directory');
    return `${bundleRoot}/${portable}`;
  });
  if (new Set(normalizedBundleDirectories).size !== normalizedBundleDirectories.length) {
    fail(`${label} bundle contains duplicate relative directory paths.`);
  }

  const files = [...normalizedBundleFiles, ...standaloneFiles, iconTargetPath];
  const directories = new Set([bundleRoot]);
  for (const directory of normalizedBundleDirectories) directories.add(directory);
  for (const file of [...normalizedBundleFiles, ...normalizedBundleDirectories]) {
    let parent = path.posix.dirname(file);
    while (parent !== bundleRoot && parent !== '/' && parent !== '.') {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return {
    files,
    paths: [...directories, ...files].sort(),
  };
}
