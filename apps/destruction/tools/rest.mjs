#!/usr/bin/env node
/**
 * What is still moving once the destruction stops: a fixed bout of damage
 * (bridge cut, A's ground storey, rockets into B), then the loose debris
 * counted every few seconds (asleep, hanging, roped, free; moving or still)
 * with the physics cost, in real time.
 *
 *   node tools/rest.mjs [--headed]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../tools/capture/capture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', server: { port: 5396, strictPort: false, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const browser = await launchBrowser(process.argv.includes('--headed'));
const report = { at: [] };
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(String(e)));
  await page.goto(`${server.resolvedUrls.local[0]}?overlay=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__spark?.ready && window.__spark.game.stats().init !== null, null, { timeout: 120_000 });
  const g = (fn, ...args) => page.evaluate(([f, a]) => window.__spark.game[f](...a), [fn, args]);
  await g('setView', -4, 9, -30, -1, 4, 0);
  await g('scenario', 'bridge-A-end');
  await page.waitForTimeout(2500);
  await g('scenario', 'A-ground');
  await page.waitForTimeout(2500);
  for (const [x, y, z] of [[8, 1.5, -5], [12, 1.5, -5], [16, 4.5, -5], [10, 7.5, -5]]) {
    await g('explode', x, y, z, 2.2);
    await page.waitForTimeout(700);
  }
  const t0 = Date.now();
  for (const s of [1, 2, 3, 5, 7, 10, 15, 20, 30]) {
    await page.waitForTimeout(t0 + s * 1000 - Date.now());
    const sample = await page.evaluate(() => {
      const snap = window.__spark.snapshot();
      const physics = Object.entries(snap?.systems ?? {}).filter(([k]) => /physics/i.test(k)).reduce((a, [, v]) => a + v, 0);
      const st = window.__spark.game.stats();
      return { census: window.__spark.game.census(), physicsMs: +physics.toFixed(2), links: st.hinges.links, settled: st.debris.piled, flung: st.debris.flung, sunk: st.debris.sunk, sinks: st.sinks, created: st.debris.created, cascading: st.cascading, standing: st.standing, torn: st.hinges.torn };
    });
    report.at.push({ s, ...sample });
  }
  report.problems = problems;
} finally {
  await browser.close();
  await server.close();
}
console.log(JSON.stringify(report, null, 1));
