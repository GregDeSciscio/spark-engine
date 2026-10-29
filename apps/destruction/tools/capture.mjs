#!/usr/bin/env node
/**
 * Headless captures and a real-time perf run of the destruction sandbox.
 *
 *   pnpm capture                 fixed-clock stills + real-time perf, into captures/
 *   pnpm capture --out=captures/x --size=1600x900 --headed
 *   pnpm capture --no-perf       stills only
 *
 * Stills: `fixedclock=60` and `strain=inline` with the engine loop stopped, so
 * the script advances the simulation itself and every run is the same.
 * Perf: the real thing (worker strain, wall clock) sampled through
 * `window.__spark.snapshot()` while the ground floor is blown out. Numbers
 * are only as good as the machine is quiet; the script records GPU load.
 *
 * Browser and Chromium flags come from the engine's capture tools
 * (tools/capture/capture.mjs, which also brings Playwright).
 */
import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../tools/capture/capture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const outDir = path.resolve(root, args.out ?? 'captures');
const [width, height] = (args.size ?? '1600x900').split('x').map(Number);

function gpuLoad() {
  try {
    return execSync('nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function startServer() {
  const server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    logLevel: 'error',
    server: { port: 5391, strictPort: false, host: '127.0.0.1', hmr: false, watch: null },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('vite did not report a local URL');
  return { server, url };
}

async function open(browser, url) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__spark && (window.__spark.ready || window.__spark.error), null, { timeout: 180_000 });
  const error = await page.evaluate(() => window.__spark.error);
  if (error) throw new Error(`boot failed: ${error}`);
  return { context, page, problems };
}

const step = (page, n) => page.evaluate((k) => window.__spark.stepFrames(k), n);
const stats = (page) => page.evaluate(() => window.__spark.game.stats());

async function stills(browser, base) {
  const { context, page, problems } = await open(browser, `${base}?fixedclock=60&strain=inline&overlay=0`);
  await page.evaluate(() => window.__spark.engine.stop());
  const shots = [];
  const shot = async (name, note) => {
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    const s = await stats(page);
    shots.push({ name, note, file: path.relative(root, file), standing: s.standing, bodies: s.bodies, hinges: s.hinges, ropes: s.ropes, settled: s.debris.piled, cascadeSteps: s.cascadeSteps, cascadeMs: Math.round(s.cascadeMs), lastStep: s.last ? { mode: s.last.mode, region: s.last.region, ms: Math.round(s.last.timing.totalMs) } : null });
    console.log(`  ${name}: ${s.standing}/${s.chunks} standing, ${s.bodies} loose, ${s.debris.piled} settled, hinges ${s.hinges.links} holding/${s.hinges.torn} torn, ropes ${s.ropes}, smoke ${s.smoke.voxels}, cascade ${s.cascadeSteps} steps`);
  };
  const game = (fn, ...a) => page.evaluate(([f, x]) => window.__spark.game[f](...x), [fn, a]);
  const seconds = (s) => step(page, Math.round(s * 60));

  await game('setView', -4, 9, -30, -1, 4, 0);
  await seconds(0.5);
  await shot('01-arena', 'two buildings, the footbridge, the slung container');

  // A blast under the bridge swings the container on its ropes.
  await game('setView', -3, 4.5, -13, 1, 3.5, 0);
  await game('explode', 1, 0.4, -3.6, 1.6);
  await seconds(0.6);
  await shot('01b-swing-0.6s', 'a blast beside the container: it swings on its ropes, 0.6 s');
  await seconds(0.7);
  await shot('01c-swing-1.3s', '1.3 s: the back swing');
  await seconds(3);

  // Cut the bridge where it meets building A: it should hinge down from B, the container swinging under it.
  await game('setView', -2, 6.5, -15, 1.5, 4, 0);
  await game('scenario', 'bridge-A-end');
  await seconds(0.4);
  await shot('02-bridge-0.4s', 'bridge cut at A: 0.4 s');
  await seconds(0.8);
  await shot('03-bridge-1.2s', '1.2 s');
  await seconds(2);
  await shot('04-bridge-3.2s', '3.2 s');
  await seconds(4);
  await shot('05-bridge-7s', '7 s');

  // Take building A's top-storey walls out under the right half: the roof should droop from what still holds it.
  await game('setView', -19, 14, -13, -8, 8, -0.5);
  await game('scenario', 'A-top-walls');
  await seconds(0.5);
  await shot('06-sag-0.5s', "A: top storey's walls gone under the right half, 0.5 s");
  await seconds(1.5);
  await shot('07-sag-2s', '2 s');
  await seconds(4);
  await shot('08-sag-6s', '6 s');

  // A rocket into B's front wall: the crater, plus the blast wave cracking what is around it.
  await game('setView', 8, 4, -16, 12, 2.5, -5);
  await game('explode', 12, 1.6, -4.85, 1.6, 0, 0, -1);
  await seconds(0.25);
  await shot('09-rocket-B', 'rocket into B, 0.25 s');
  await game('setHeat', true);
  await seconds(1.5);
  await shot('10-rocket-B-heat', 'stress over baseline after the blast');
  await game('setHeat', false);

  // The player's path: aim at B's front wall and fire a rocket through the same code the mouse uses.
  await game('setView', 18.5, 2.2, -13, 18.5, 1.6, -5);
  await game('setWeapon', 'rocket');
  await game('fire');
  await seconds(0.8);
  await shot('10a-fire', 'a rocket fired down the crosshair (the input path)');

  // Smoke in B's ground floor: it fills the rooms and pours out of the door and windows, not through walls.
  await game('setView', 4, 3.5, -14, 13, 1.5, -2);
  await game('grenade', 'smoke', 13, 1, -1);
  await seconds(1.6);
  await shot('10b-smoke-room', "smoke grenade inside B's ground floor, 1.6 s");
  await game('explode', 15.6, 1.4, -4.85, 1.6, 0, 0, -1);
  await seconds(0.35);
  await shot('10c-smoke-blast', 'a rocket blows a pocket of it clear (and opens a new way out)');
  await seconds(2.5);
  await shot('10d-smoke-refill', '2.5 s later: it has refilled and is flowing out of the new hole');
  await game('setView', -30, 2.5, -10, -18, 1.5, -1);
  await game('grenade', 'gas', -17, 0.6, -5);
  await seconds(2);
  await shot('10e-gas-wall', 'gas against the outside of A: it hugs the wall');

  // A's ground storey goes: the whole building comes down, hinged elements and all.
  await game('setView', -30, 9, -22, -10, 3, 0);
  await game('scenario', 'A-ground');
  await seconds(0.6);
  await shot('11-A-down-0.6s', "A's ground storey gone: 0.6 s");
  await seconds(1.4);
  await shot('12-A-down-2s', '2 s');
  await seconds(6);
  await shot('13-A-down-8s', '8 s');
  await game('setView', -8, 2.4, -12, -11, 1, -1);
  await step(page, 1);
  await shot('14-rubble-close', 'the rubble, close');

  const logs = await page.evaluate(() => window.__spark.logs());
  await context.close();
  return { shots, problems, logs };
}

async function perf(browser, base) {
  const { context, page, problems } = await open(browser, `${base}?overlay=0`);
  await page.evaluate(() => window.__spark.game.setView(-4, 9, -30, -1, 4, 0));
  await page.waitForFunction(() => window.__spark.game.stats().init !== null, null, { timeout: 60_000 });
  await page.waitForTimeout(2500);
  const sample = () =>
    page.evaluate(() => {
      const s = window.__spark.snapshot();
      const g = window.__spark.game.stats();
      return { fps: s?.fps ?? 0, cpuMs: s?.cpuMs ?? 0, renderMs: s?.renderMs ?? 0, systems: s?.systems ?? {}, gpuMs: s?.gpuMs ?? null, drawCalls: s?.drawCalls ?? 0, bodies: g.bodies, sleeping: g.sleeping, standing: g.standing, cascading: g.cascading, links: g.hinges.links };
    });
  const idle = await sample();
  await page.evaluate(() => {
    window.__spark.game.scenario('bridge-A-end');
    window.__spark.game.scenario('A-ground');
  });
  const samples = [];
  for (let i = 0; i < 32; i++) {
    await page.waitForTimeout(250);
    samples.push(await sample());
  }
  const physics = (s) => Object.entries(s.systems).filter(([k]) => /physics/i.test(k)).reduce((a, [, v]) => a + v, 0);
  const worst = samples.reduce((w, s) => (s.cpuMs > w.cpuMs ? s : w), samples[0]);
  const result = {
    idle: { fps: idle.fps, cpuMs: idle.cpuMs, physicsMs: physics(idle), drawCalls: idle.drawCalls },
    collapse: {
      minFps: Math.min(...samples.map((s) => s.fps)),
      maxCpuMs: worst.cpuMs,
      maxPhysicsMs: Math.max(...samples.map(physics)),
      maxBodies: Math.max(...samples.map((s) => s.bodies)),
      bodiesAtWorst: worst.bodies,
      end: samples[samples.length - 1],
    },
    samples: samples.map((s) => ({ fps: s.fps, cpuMs: +s.cpuMs.toFixed(2), physicsMs: +physics(s).toFixed(2), bodies: s.bodies, sleeping: s.sleeping, links: s.links, cascading: s.cascading })),
    strain: await page.evaluate(() => {
      const g = window.__spark.game.stats();
      return { mode: g.strainMode, init: g.init, cascadeSteps: g.cascadeSteps, cascadeMs: g.cascadeMs, last: g.last?.timing ?? null };
    }),
  };
  await context.close();
  return { ...result, problems };
}

const { server, url } = await startServer();
const browser = await launchBrowser(args.headed === 'true');
await mkdir(outDir, { recursive: true });
const report = { capturedAt: new Date().toISOString(), size: { width, height }, gpuLoadBefore: gpuLoad() };
try {
  console.log('stills (fixed clock, inline strain)…');
  report.stills = await stills(browser, url);
  if (args['no-perf'] !== 'true') {
    console.log('perf (wall clock, worker strain)…');
    report.gpuLoadBeforePerf = gpuLoad();
    report.perf = await perf(browser, url);
    const p = report.perf;
    console.log(`  idle ${p.idle.fps} fps, cpu ${p.idle.cpuMs.toFixed(2)} ms, physics ${p.idle.physicsMs.toFixed(2)} ms, ${p.idle.drawCalls} draws`);
    console.log(`  collapse: min ${p.collapse.minFps} fps, max cpu ${p.collapse.maxCpuMs.toFixed(2)} ms, max physics ${p.collapse.maxPhysicsMs.toFixed(2)} ms, up to ${p.collapse.maxBodies} bodies`);
    console.log(`  strain (${p.strain.mode}): ${p.strain.cascadeSteps} steps, ${p.strain.cascadeMs.toFixed(0)} ms solving`);
  }
} finally {
  await browser.close();
  await server.close();
}
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
const problems = [...(report.stills?.problems ?? []), ...(report.perf?.problems ?? [])];
if (problems.length) console.log(`console problems:\n  ${problems.slice(0, 12).join('\n  ')}`);
console.log(`wrote ${path.relative(root, outDir)}/`);
