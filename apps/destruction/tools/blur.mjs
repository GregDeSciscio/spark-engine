#!/usr/bin/env node
/**
 * Motion blur against no motion blur, on a fixed clock at `preset=ultra`,
 * with the camera held still: the tower mid-collapse, the rubble once it has
 * settled, and a smoke cloud. With the camera still, blur should only soften
 * what is moving fast, so the two renders must nearly match. Anything that
 * places its own vertices (the chunks from their matrix texture, particles
 * from their buffers, smoke sprites) and gives the velocity pass no previous
 * position is smeared from its rest pose or the origin into translucent
 * ghosts, and the renders part by a fifth of their pixels.
 *
 *   node tools/blur.mjs   → captures/blur-*.png (and blur-*-diff.png on a failure); exit 1 on a failure
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { createServer } from 'vite';
import { launchBrowser } from '../../../tools/capture/capture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'captures');
await mkdir(out, { recursive: true });
/** Most pixels allowed to differ, per moment. Measured: ghosting 19%, 19% and 2.6%; correct blur 0.6%, 0.01% and 0.1%. */
const LIMITS = { falling: 0.03, settled: 0.005, smoke: 0.01 };

const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', server: { port: 5399, strictPort: false, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const browser = await launchBrowser(false);
/** blur on / off → moment → PNG */
const shots = { on: {}, off: {} };
try {
  for (const blur of ['on', 'off']) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })).newPage();
    await page.goto(`${server.resolvedUrls.local[0]}?fixedclock=60&overlay=0&preset=ultra`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__spark && (window.__spark.ready || window.__spark.error), null, { timeout: 180_000 });
    await page.evaluate((on) => {
      window.__spark.engine.stop();
      document.querySelectorAll('pre').forEach((p) => (p.parentElement.style.display = 'none'));
      window.__spark.engine.renderer.pipeline.setEffectEnabled('motionBlur', on);
    }, blur === 'on');
    const game = (fn, ...a) => page.evaluate(([f, x]) => window.__spark.game[f](...x), [fn, a]);
    const step = (n) => page.evaluate((k) => window.__spark.stepFrames(k), n);
    const shot = async (name) => {
      shots[blur][name] = PNG.sync.read(await page.screenshot());
      await writeFile(path.join(out, `blur-${name}-${blur}.png`), PNG.sync.write(shots[blur][name]));
    };
    // The tower, from the east, low: its base charges, then its ground storey taken out.
    await game('setView', 21, 2, 24.5, 1, 8, 15);
    await step(30);
    await game('explode', 4.5, 1.5, 11.9, 2.6, 0, 0, -1);
    await game('explode', 0.5, 1.5, 11.9, 2.6, 0, 0, -1);
    await game('explode', 6.1, 1.5, 17, 2.6, 1, 0, 0);
    await game('scenario', 'T-ground');
    await step(210);
    await shot('falling');
    await step(600);
    await shot('settled');
    // Smoke out in the street, where the cloud is round and all of it shows.
    await game('setView', -2, 3, -16, -2, 2, -9);
    await game('grenade', 'smoke', -2, 0.5, -9);
    await step(150);
    await shot('smoke');
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

let failed = false;
for (const [name, limit] of Object.entries(LIMITS)) {
  const a = shots.on[name];
  const b = shots.off[name];
  const diff = new PNG({ width: a.width, height: a.height });
  const share = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.12, includeAA: false }) / (a.width * a.height);
  const ok = share <= limit;
  if (!ok) {
    failed = true;
    await writeFile(path.join(out, `blur-${name}-diff.png`), PNG.sync.write(diff));
  }
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(8)} ${(share * 100).toFixed(2)}% of pixels differ with motion blur (limit ${(limit * 100).toFixed(1)}%)`);
}
if (failed) {
  console.log('motion blur smears something that is not moving that fast: a material moving its own vertices without a previous position (see rendering/Velocity.ts)');
  process.exit(1);
}
