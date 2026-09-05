/**
 * Where Blender is: $BLENDER, then PATH, then the usual Windows install folder
 * (newest version first). Shared by the level and character builds.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function findBlender() {
  if (process.env.BLENDER && existsSync(process.env.BLENDER)) return process.env.BLENDER;
  const onPath = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['blender'], { encoding: 'utf8' });
  if (onPath.status === 0) {
    const first = onPath.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (first) return first.trim();
  }
  if (process.platform === 'win32') {
    const base = 'C:\\Program Files\\Blender Foundation';
    if (existsSync(base)) {
      const versions = readdirSync(base)
        .filter((d) => d.startsWith('Blender '))
        .sort()
        .reverse();
      for (const v of versions) {
        const exe = path.join(base, v, 'blender.exe');
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

/** Run a Blender Python script headless; returns the exit status. */
export function runBlender(script, args = []) {
  const blender = findBlender();
  if (!blender) throw new Error('Blender not found: set $BLENDER or put blender on PATH');
  console.log(`blender: ${blender}`);
  const r = spawnSync(blender, ['--background', '--python', script, '--', ...args], { stdio: 'inherit' });
  return r.status ?? 1;
}
