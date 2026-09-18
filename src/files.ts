import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MAX_FILE = 128 * 1024;
export const MAX_FILES = 80;
export function slug(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(value)) throw new Error('Use a lowercase slug (letters, digits and hyphens, max 80).');
  return value;
}
export function inside(root: string, path: string): string {
  if (typeof path !== 'string' || path.includes('\0')) throw new Error('Invalid path');
  const base = realpathSync(root);
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path escapes workspace');
  let cursor = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    let st;
    try { st = lstatSync(cursor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1)) throw new Error('Links are not allowed');
    if (!st.isFile() && !st.isDirectory()) throw new Error('Only ordinary files and directories are allowed');
  }
  return target;
}
export function localDir(root: string, path: string): string {
  const full = inside(root, path);
  mkdirSync(full, { recursive: true, mode: 0o700 });
  return full;
}
export function put(root: string, path: string, text: string): void {
  const full = inside(root, path);
  if (Buffer.byteLength(text) > MAX_FILE) throw new Error('File exceeds 128 KiB limit');
  localDir(root, relative(root, dirname(full)));
  writeFileSync(inside(root, path), text, { mode: 0o600 });
}
export function readText(root: string, path: string): string {
  const full = inside(root, path);
  const st = lstatSync(full);
  if (!st.isFile() || st.size > MAX_FILE) throw new Error('Expected a text file of at most 128 KiB');
  return readFileSync(full, 'utf8');
}
export function files(root: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let size = 0, entries = 0;
  function visit(dir: string, depth = 0) {
    if (depth > 16) throw new Error('Workspace nesting exceeds 16 directories');
    for (const name of readdirSync(inside(root, dir)).sort()) {
      if (++entries > 400) throw new Error('Workspace contains too many entries (max 400)');
      const rel = join(dir, name);
      const full = inside(root, rel);
      if (lstatSync(full).isDirectory()) visit(rel, depth + 1);
      else {
        if (Object.keys(result).length >= MAX_FILES) throw new Error('Too many fixture files (max 80)');
        const text = readText(root, rel);
        size += Buffer.byteLength(text);
        if (size > 512 * 1024) throw new Error('Fixture tree exceeds 512 KiB');
        result[rel] = text;
      }
    }
  }
  visit('.');
  return result;
}
export function atomicJson(root: string, path: string, data: unknown): void {
  const full = inside(root, path);
  localDir(root, relative(root, dirname(full)));
  const temp = inside(root, `${path}.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, inside(root, path));
}
export function hash(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
export function clean(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
