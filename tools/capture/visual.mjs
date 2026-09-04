#!/usr/bin/env node
/**
 * Visual regression suite. Captures every entry in tests/visual/manifest.json
 * and diffs against the golden PNGs in tests/visual/golden/.
 *
 *   pnpm visual                 compare against goldens (fails on mismatch)
 *   pnpm visual --update        rewrite goldens from fresh captures
 *   pnpm visual --filter=alley  only entries whose name contains "alley"
 *   pnpm visual --backend=webgl only that backend
 */
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { captureOne, launchBrowser, parseArgs, startServer, summarize } from './capture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const visualDir = path.join(repoRoot, 'tests', 'visual');
const goldenDir = path.join(visualDir, 'golden');
const outDir = path.join(visualDir, 'out');

async function readPng(file) {
  return PNG.sync.read(await readFile(file));
}

async function diffImages(actualPath, goldenPath, diffPath, threshold) {
  const a = await readPng(actualPath);
  const b = await readPng(goldenPath);
  if (a.width !== b.width || a.height !== b.height) {
    return { mismatch: 1, reason: `size ${a.width}x${a.height} vs golden ${b.width}x${b.height}` };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const differing = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.12, includeAA: false });
  const mismatch = differing / (a.width * a.height);
  if (mismatch > threshold) await writeFile(diffPath, PNG.sync.write(diff));
  return { mismatch, reason: null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const update = Boolean(args.update);
  const filter = args.filter ? String(args.filter) : null;
  const backendFilter = args.backend ? String(args.backend) : null;
  const manifest = JSON.parse(await readFile(path.join(visualDir, 'manifest.json'), 'utf8'));
  await mkdir(goldenDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const { server, url } = await startServer();
  const browser = await launchBrowser(false);
  let failures = 0;
  try {
    for (const entry of manifest.entries) {
      const name = `${entry.scene}-${entry.backend}-${entry.preset}`;
      if (filter && !name.includes(filter)) continue;
      if (backendFilter && entry.backend !== backendFilter) continue;
      const result = await captureOne(browser, url, {
        scene: entry.scene,
        backend: entry.backend,
        preset: entry.preset,
        frames: entry.frames ?? manifest.defaults.frames,
        width: entry.width ?? manifest.defaults.width,
        height: entry.height ?? manifest.defaults.height,
        seed: entry.seed ?? manifest.defaults.seed,
        outDir,
        label: name,
      });
      console.log(summarize(result));
      if (result.bootError) {
        failures++;
        continue;
      }
      if (result.backend !== entry.backend) {
        console.log(`  SKIP: requested ${entry.backend} but got ${result.backend} (backend unavailable here)`);
        continue;
      }
      const actual = path.join(outDir, `${name}.png`);
      const golden = path.join(goldenDir, `${name}.png`);
      if (update || !existsSync(golden)) {
        await copyFile(actual, golden);
        console.log(`  golden ${update ? 'updated' : 'created'}: ${path.relative(repoRoot, golden)}`);
        continue;
      }
      const threshold = entry.threshold ?? manifest.defaults.threshold;
      const { mismatch, reason } = await diffImages(actual, golden, path.join(outDir, `${name}.diff.png`), threshold);
      const pct = (mismatch * 100).toFixed(3);
      if (mismatch > threshold) {
        failures++;
        console.log(`  FAIL: ${pct}% pixels differ (threshold ${(threshold * 100).toFixed(2)}%)${reason ? ' ' + reason : ''}`);
      } else {
        console.log(`  ok: ${pct}% pixels differ`);
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(failures ? `\n${failures} visual failure(s)` : '\nvisual suite passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
