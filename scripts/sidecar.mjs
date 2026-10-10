import { copyFile, lstat, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fail, exists, sha256File, walkFiles } from './lib.mjs';

export async function mergeSidecar(source, destination) {
  if (!(await stat(source).catch(() => null))) return 0;
  let copied = 0;
  for (const sourceFile of await walkFiles(source)) {
    const relative = path.relative(source, sourceFile);
    const target = path.join(destination, relative);
    if (await exists(target)) {
      if ((await sha256File(sourceFile)) !== (await sha256File(target))) {
        fail(`Conflicting app.asar and app.asar.unpacked content at ${relative}.`);
      }
      continue;
    }
    let current = path.dirname(target);
    while (current.startsWith(destination)) {
      const info = await lstat(current).catch(() => null);
      if (info?.isSymbolicLink()) fail(`Refusing to write through a symlink at ${current}.`);
      if (current === destination) break;
      current = path.dirname(current);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(sourceFile, target, 0);
    copied += 1;
  }
  return copied;
}
