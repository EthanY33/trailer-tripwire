/* Resolve a program name to an absolute path by walking PATH.
 *
 * Spawning a bare name leaves the lookup to the OS. Windows tries the
 * current directory before PATH, and a `.` or empty PATH entry does the same
 * on any OS. The pre-commit hook runs in the repository root, so a repository
 * that carries its own git.exe or ffprobe.exe there would get it executed.
 * Callers spawn the absolute path returned here instead of the bare name.
 *
 * Only absolute PATH entries other than the current directory are searched.
 * Returns null when the program is not found.
 */

import fs from 'node:fs';
import path from 'node:path';

const WINDOWS = process.platform === 'win32';

function realDir(dir) {
  try { return fs.realpathSync.native(dir); } catch { return path.resolve(dir); }
}

function key(dir) {
  const resolved = path.resolve(dir);
  return WINDOWS ? resolved.toLowerCase() : resolved;
}

// A file that spawn() could start. Off Windows it must be executable.
function isProgram(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!WINDOWS) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveBin(name, { cwd = process.cwd(), pathVar = process.env.PATH || '' } = {}) {
  // Without a shell, spawn() on Windows can only start .com and .exe files.
  const names = WINDOWS && !path.extname(name) ? [`${name}.com`, `${name}.exe`] : [name];
  const here = new Set();
  for (const dir of [process.cwd(), cwd]) {
    here.add(key(dir));
    here.add(key(realDir(dir)));
  }

  for (const entry of pathVar.split(path.delimiter)) {
    const dir = WINDOWS ? entry.replace(/^"(.*)"$/, '$1') : entry;
    if (!path.isAbsolute(dir)) continue; // '', '.', 'bin': all relative to the current directory
    if (here.has(key(dir))) continue;
    for (const candidate of names) {
      const file = path.join(dir, candidate);
      // The realpath check catches a PATH entry that is the current
      // directory under another spelling (a symlink, an 8.3 short name).
      if (isProgram(file) && !here.has(key(realDir(dir)))) return file;
    }
  }
  return null;
}
