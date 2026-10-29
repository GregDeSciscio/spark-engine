#!/usr/bin/env node
/**
 * A collapse frame by frame, on a fixed clock (strain inline, so the run is
 * deterministic): a scenario, then `frames` single-frame steps, each timed
 * whole and for Rapier's step alone, with what the physics world holds. Prints
 * the worst frames, totals, and the sandbox's own stats at checkpoints, so a
 * change can be A/B'd on what the collapse does as well as what it costs.
 *
 *   node tools/collapse.mjs [--scenario=A-ground] [--frames=240] [--lead=30] [--json]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../tools/capture/capture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const scenario = arg('scenario', 'A-ground');
const frames = Number(arg('frames', 240));
/** Frames run before the scenario: a different lead is the same collapse from a slightly different start. */
const lead = Number(arg('lead', 30));
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', server: { port: 5397, strictPort: false, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const browser = await launchBrowser(false);
const result = { scenario, frames, checkpoints: [] };
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await page.goto(`${server.resolvedUrls.local[0]}?fixedclock=60&overlay=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__spark && (window.__spark.ready || window.__spark.error), null, { timeout: 180_000 });
  const error = await page.evaluate(() => window.__spark.error);
  if (error) throw new Error(`boot failed: ${error}`);
  await page.evaluate(() => {
    const s = window.__spark;
    s.engine.stop();
    // Rapier's own step, timed (the physics module's world; this is a probe, not engine code).
    const w = s.engine.physics.raw;
    const step = w.step.bind(w);
    s.probe = { rapier: 0 };
    w.step = (...a) => {
      const t = performance.now();
      step(...a);
      s.probe.rapier += performance.now() - t;
    };
  });
  await page.evaluate((n) => window.__spark.stepFrames(n), lead);
  await page.evaluate((sc) => window.__spark.game.scenario(sc), scenario);
  const rows = [];
  const marks = new Set([30, 60, 120, 180, 240, 300, 480, frames]);
  for (let i = 1; i <= frames; i++) {
    rows.push(
      await page.evaluate(() => {
        const s = window.__spark;
        s.probe.rapier = 0;
        const t = performance.now();
        s.stepFrames(1);
        const ms = performance.now() - t;
        const w = s.engine.physics.raw;
        let dyn = 0;
        let awake = 0;
        w.bodies.forEach((b) => {
          if (b.isDynamic()) {
            dyn++;
            if (!b.isSleeping()) awake++;
          }
        });
        return { ms, rapier: s.probe.rapier, dyn, awake, colliders: w.colliders.len(), joints: w.impulseJoints.len() };
      }),
    );
    if (marks.has(i)) {
      const st = await page.evaluate(() => window.__spark.game.stats());
      result.checkpoints.push({ frame: i, standing: st.standing, bodies: st.bodies, sleeping: st.sleeping, settled: st.debris.piled, created: st.debris.created, shattered: st.debris.shattered, cleared: st.debris.cleared, flung: st.debris.flung, links: st.hinges.links, formed: st.hinges.formed, torn: st.hinges.torn, ropes: st.ropes, cascadeSteps: st.cascadeSteps, cascading: st.cascading, maxSpeed: +st.sanity.maxSpeed.toFixed(2), minY: +st.sanity.minY.toFixed(2) });
    }
  }
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const worst = [...rows].map((r, i) => ({ i: i + 1, ...r })).sort((a, b) => b.ms - a.ms);
  result.total = { frameMs: Math.round(sum('ms')), rapierMs: Math.round(sum('rapier')), worstMs: +worst[0].ms.toFixed(1) };
  result.worst = worst.slice(0, 8).map((r) => ({ frame: r.i, ms: +r.ms.toFixed(1), rapier: +r.rapier.toFixed(1), dyn: r.dyn, awake: r.awake, colliders: r.colliders, joints: r.joints }));
} finally {
  await browser.close();
  await server.close();
}
if (process.argv.includes('--json')) console.log(JSON.stringify(result));
else {
  console.log(`${scenario}, ${frames} fixed-clock frames: all frames ${result.total.frameMs} ms, Rapier ${result.total.rapierMs} ms, worst frame ${result.total.worstMs} ms`);
  console.log('worst frames: frame, ms, Rapier ms, dynamic/awake bodies, colliders, joints');
  for (const r of result.worst) console.log(`  ${r.frame}  ${r.ms}  ${r.rapier}  ${r.dyn}/${r.awake}  ${r.colliders}  ${r.joints}`);
  console.log('checkpoints:');
  for (const c of result.checkpoints) console.log(`  ${JSON.stringify(c)}`);
}
