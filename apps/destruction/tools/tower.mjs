#!/usr/bin/env node
/**
 * The eight-storey tower (`?tower=1`) coming down, twice:
 * - fixed clock (strain inline, deterministic): stills of the collapse and the solver's numbers;
 * - real time (strain in the worker): frame pacing through the collapse.
 *
 *   node tools/tower.mjs   → captures/tower-*.png and a report on stdout
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../tools/capture/capture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'captures');
await mkdir(out, { recursive: true });
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', server: { port: 5398, strictPort: false, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const browser = await launchBrowser(false);
const view = [-24, 14, -10, 1, 9, 16];
try {
  // ---- fixed clock --------------------------------------------------------------------------
  {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await page.goto(`${server.resolvedUrls.local[0]}?tower=1&fixedclock=60&overlay=0`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__spark && (window.__spark.ready || window.__spark.error), null, { timeout: 180_000 });
    await page.evaluate(() => window.__spark.engine.stop());
    const game = (fn, ...a) => page.evaluate(([f, x]) => window.__spark.game[f](...x), [fn, a]);
    const step = (n) => page.evaluate((k) => window.__spark.stepFrames(k), n);
    await game('setView', ...view);
    await step(20);
    const s0 = await game('stats');
    console.log(`tower: ${s0.chunks ?? s0.standing} chunks in all, ${s0.standing} standing`);
    const cut = await game('scenario', 'T-ground');
    console.log(`T-ground: ${cut} chunks taken out`);
    for (const [frames, name] of [
      [30, '0.5s'],
      [60, '1.5s'],
      [120, '3.5s'],
      [240, '7.5s'],
    ]) {
      await step(frames);
      await page.screenshot({ path: path.join(out, `tower-${name}.png`) });
      const s = await game('stats');
      console.log(`  ${name}: ${s.standing} standing, ${s.bodies} loose, ${s.settled} settled, cascade ${s.cascading ? 'running' : 'over'}`);
    }
    const census = await game('census');
    console.log(`  census at 7.5 s: ${JSON.stringify({ bodies: census.bodies, asleep: census.asleep, held: census.held, jointed: census.jointed, free: census.free, hinges: census.hinges })}`);
    console.log(`  liveliest: ${JSON.stringify(census.movers.slice(0, 6))}`);
    await page.close();
  }
  // ---- real time ------------------------------------------------------------------------------
  {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await page.goto(`${server.resolvedUrls.local[0]}?tower=1&overlay=0`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__spark?.ready && window.__spark.game.stats().init !== null, null, { timeout: 180_000 });
    const game = (fn, ...a) => page.evaluate(([f, x]) => window.__spark.game[f](...x), [fn, a]);
    await game('setView', ...view);
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const w = window;
      w.__frames = [];
      let last = performance.now();
      const tick = (t) => {
        w.__frames.push(t - last);
        last = t;
        if (w.__frames.length < 900) w.requestAnimationFrame(tick);
      };
      w.requestAnimationFrame(tick);
    });
    await game('scenario', 'T-ground');
    await page.waitForTimeout(8000);
    const frames = await page.evaluate(() => window.__frames.slice(1));
    const sorted = [...frames].sort((a, b) => a - b);
    const pct = (q) => +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(1);
    const s = await game('stats');
    console.log(`real time (worker): ${frames.length} frames, median ${pct(0.5)} ms, p95 ${pct(0.95)}, p99 ${pct(0.99)}, longest ${pct(1)}, over 33 ms: ${frames.filter((f) => f > 33.4).length}`);
    console.log(`  after 8 s: ${s.standing} standing, ${s.bodies} loose, ${s.settled} settled, strain ${s.strainMode ?? ''}`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
