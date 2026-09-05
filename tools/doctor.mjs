#!/usr/bin/env node
/**
 * Check the machine for what the repo needs and say what each missing tool
 * would unlock:
 *
 *   pnpm doctor
 *
 * Required: Node 22+, pnpm, a WebGPU browser (Chrome or Edge 113+) to see
 * the scenes as intended. Optional: Blender (level and character builds),
 * ffmpeg (audio mastering), Playwright's Chromium (captures, thumbnails,
 * visual and perf runs), an ElevenLabs key (sound generation), KTX-Software's
 * toktx (compressed textures).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function run(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
    if (r.status !== 0) return null;
    return (r.stdout || r.stderr || '').trim().split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

function blenderPath() {
  if (process.env.BLENDER && existsSync(process.env.BLENDER)) return process.env.BLENDER;
  const onPath = run(process.platform === 'win32' ? 'where' : 'which', ['blender']);
  if (onPath) return onPath;
  if (process.platform === 'win32') {
    const base = 'C:\\Program Files\\Blender Foundation';
    if (existsSync(base)) {
      const versions = readdirSync(base).filter((d) => d.startsWith('Blender ')).sort().reverse();
      for (const v of versions) {
        const exe = path.join(base, v, 'blender.exe');
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

const rows = [];
const add = (name, ok, detail, unlocks, required = false) => rows.push({ name, ok, detail, unlocks, required });

// Required.
const nodeMajor = Number(process.versions.node.split('.')[0]);
add('Node', nodeMajor >= 22, `v${process.versions.node}`, 'everything', true);
const pnpm = run('pnpm', ['--version']);
add('pnpm', Boolean(pnpm), pnpm ?? 'not found', 'installing and running the workspace (npm i -g pnpm)', true);
const installed = existsSync(path.join(repoRoot, 'node_modules'));
add('dependencies', installed, installed ? 'node_modules present' : 'run pnpm install', 'anything at all', true);

// Optional.
const blender = blenderPath();
add('Blender', Boolean(blender), blender ?? 'not found', 'pnpm level:street, pnpm character:retarget (levels and characters from Blender)');
const ffmpeg = run('ffmpeg', ['-version']);
add('ffmpeg', Boolean(ffmpeg), ffmpeg ? ffmpeg.split(' ').slice(0, 3).join(' ') : 'not found', 'pnpm audio:build (mastering generated takes)');
const toktx = run('toktx', ['--version']);
add('toktx', Boolean(toktx), toktx ?? 'not found', 'KTX2 texture compression in the asset pipeline (otherwise PNG/JPEG stay as they are)');
let playwright = false;
try {
  const cache = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright') : path.join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  playwright = existsSync(cache) && readdirSync(cache).some((d) => d.startsWith('chromium'));
} catch {
  playwright = false;
}
add('Playwright Chromium', playwright, playwright ? 'browser cache present' : 'run pnpm exec playwright install chromium', 'pnpm capture, pnpm thumbnails, pnpm visual, pnpm perf');
let elevenKey = Boolean(process.env.ELEVENLABS_API_KEY);
if (!elevenKey) {
  try {
    elevenKey = /^\s*ELEVENLABS_API_KEY\s*=/m.test(readFileSync(path.join(repoRoot, '.env'), 'utf8'));
  } catch {
    elevenKey = false;
  }
}
add('ElevenLabs key', elevenKey, elevenKey ? 'set' : 'ELEVENLABS_API_KEY in the environment or .env', 'pnpm audio:generate (sound generation; the showcase already ships its takes)');

const width = Math.max(...rows.map((r) => r.name.length));
let missingRequired = 0;
for (const r of rows) {
  const mark = r.ok ? 'ok ' : r.required ? 'MISSING' : '-- ';
  console.log(`${mark.padEnd(8)}${r.name.padEnd(width + 2)}${r.detail}`);
  if (!r.ok) console.log(`${''.padEnd(8 + width + 2)}unlocks: ${r.unlocks}`);
  if (!r.ok && r.required) missingRequired += 1;
}
console.log('');
console.log('WebGPU: open http://localhost:5173 in Chrome or Edge 113+ (Firefox and Safari fall back to WebGL2 with fewer effects).');
if (missingRequired > 0) {
  console.log(`\n${missingRequired} required item(s) missing.`);
  process.exit(1);
}
console.log('\nReady. pnpm dev for the launcher, pnpm dev:starter for the smallest app, docs/guide/first-scene.md to build your own.');
