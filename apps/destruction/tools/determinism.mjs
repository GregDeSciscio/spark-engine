#!/usr/bin/env node
/**
 * Is a fixed-clock run the same whatever the camera does? The sandbox runs the
 * same events (rockets at fixed world points, then a scenario) three times on
 * a fixed clock, strain inline: twice with one camera path and once with
 * another. At checkpoints every rigid body's pose is hashed, exactly (the
 * float bits), with the sandbox's own counters. The two runs on the same path
 * show the run-to-run baseline; the third shows whether the camera reaches the
 * simulation. Exits 1 on any difference.
 *
 *   node tools/determinism.mjs [--frames=300] [--scenario=A-ground]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../tools/capture/capture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const frames = Number(arg('frames', 300));
const scenario = arg('scenario', 'A-ground');
const marks = [30, 60, 120, 180, frames].filter((m, i, a) => m <= frames && a.indexOf(m) === i);

/** Two camera paths: a slow orbit of the arena, and a fly-through close past the blasts. */
const PATHS = {
  orbit: (f) => {
    const a = f * 0.01;
    return [Math.sin(a) * 40, 14, -Math.cos(a) * 40, 0, 4, 0];
  },
  close: (f) => {
    const t = f / frames;
    return [-30 + 50 * t, 2 + 6 * Math.sin(t * 9), -12 + 4 * Math.cos(t * 7), -10 + 20 * t, 3, 0];
  },
};

const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', server: { port: 5399, strictPort: false, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const browser = await launchBrowser(false);

async function run(pathName) {
  const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
  await page.goto(`${server.resolvedUrls.local[0]}?fixedclock=60&seed=11&overlay=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__spark && (window.__spark.ready || window.__spark.error), null, { timeout: 180_000 });
  const error = await page.evaluate(() => window.__spark.error);
  if (error) throw new Error(`boot failed: ${error}`);
  await page.evaluate(() => window.__spark.engine.stop());
  const checkpoints = [];
  for (let f = 1; f <= frames; f++) {
    const view = PATHS[pathName](f);
    const mark = await page.evaluate(
      ({ f, view, scenario, marks }) => {
        const s = window.__spark;
        const g = s.game;
        g.setView(...view);
        // The same events on the same frames, at world points: nothing aimed through the camera.
        if (f === 20) g.explode(-14, 1.5, -3.8, 1.6, 0, 0, -1);
        if (f === 26) g.explode(18, 1.2, -4.8, 2.6, 0, 0, -1);
        if (f === 40) g.scenario(scenario);
        s.stepFrames(1);
        if (!marks.includes(f)) return null;
        // Every rigid body's pose, by handle, as exact float bits.
        const w = s.engine.physics.raw;
        const rows = [];
        w.bodies.forEach((b) => {
          const t = b.translation();
          const r = b.rotation();
          rows.push([b.handle, t.x, t.y, t.z, r.x, r.y, r.z, r.w]);
        });
        rows.sort((a, b) => a[0] - b[0]);
        const f64 = new Float64Array(1);
        const u32 = new Uint32Array(f64.buffer);
        let h = 2166136261;
        for (const row of rows)
          for (const x of row) {
            f64[0] = x;
            for (const word of u32) h = Math.imul(h ^ word, 16777619) >>> 0;
          }
        const st = g.stats();
        return {
          frame: f,
          hash: h.toString(16),
          bodies: rows.length,
          standing: st.standing,
          loose: st.bodies,
          settled: st.debris.piled,
          shattered: st.debris.shattered,
          crushed: st.debris.crushed,
          links: st.hinges.links,
          torn: st.hinges.torn,
          cascadeSteps: st.cascadeSteps,
        };
      },
      { f, view, scenario, marks },
    );
    if (mark) checkpoints.push(mark);
  }
  await page.close();
  return checkpoints;
}

const runs = {};
try {
  runs['orbit (1)'] = await run('orbit');
  runs['orbit (2)'] = await run('orbit');
  runs['close'] = await run('close');
} finally {
  await browser.close();
  await server.close();
}

const names = Object.keys(runs);
let differ = 0;
for (let i = 0; i < marks.length; i++) {
  const row = names.map((n) => runs[n][i]);
  const same = row.every((c) => c.hash === row[0].hash);
  if (!same) differ++;
  console.log(`frame ${marks[i]}: ${same ? 'same' : 'DIFFERENT'}`);
  for (const [k, c] of row.map((c, j) => [names[j], c])) console.log(`  ${k.padEnd(10)} ${c.hash.padStart(8)}  ${JSON.stringify({ ...c, frame: undefined, hash: undefined })}`);
}
console.log(differ === 0 ? 'Deterministic: the camera path does not reach the simulation.' : `${differ} of ${marks.length} checkpoints differ.`);
process.exit(differ === 0 ? 0 : 1);
