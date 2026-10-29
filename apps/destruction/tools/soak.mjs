#!/usr/bin/env node
/**
 * A long, messy session as a player would play it: real time, strain in the
 * worker, and only real mouse and keyboard events (plus a few structural
 * cuts), at random places for `--seconds` (default 90). Samples the engine
 * and the sandbox every half second and fails on page errors, non-finite
 * bodies, runaway speeds, bodies falling through the world, broken budgets,
 * heap growth, or frames that crawl.
 *
 *   node tools/soak.mjs [--seconds=90] [--seed=3] [--headed]
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../tools/capture/capture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const seconds = Number(arg('seconds', 90));
let seed = Number(arg('seed', 3));
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = (list) => list[Math.floor(random() * list.length)];

const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', server: { port: 5394, strictPort: false, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const browser = await launchBrowser(process.argv.includes('--headed'));
const samples = [];
let liveHeapMb = [0, 0];
let flings = { count: 0, last: [] };
const actions = [];
const problems = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`${m.type()}: ${m.text()}`));
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'load' });
  await page.waitForFunction(() => window.__spark?.ready && window.__spark.game.stats().init !== null, null, { timeout: 120_000 });
  // Heap after a forced collection, so growth means retention rather than garbage not yet swept.
  const heapCdp = await page.context().newCDPSession(page);
  const liveHeap = async () => {
    await heapCdp.send('HeapProfiler.collectGarbage');
    return page.evaluate(() => (performance.memory?.usedJSHeapSize ?? 0) / 1048576);
  };
  const heapStart = await liveHeap();
  const sample = () =>
    page.evaluate(() => {
      const s = window.__spark.snapshot();
      const g = window.__spark.game.stats();
      const heap = performance.memory?.usedJSHeapSize ?? 0;
      const physics = Object.entries(s?.systems ?? {})
        .filter(([k]) => /physics/i.test(k))
        .reduce((a, [, v]) => a + v, 0);
      return { fps: s?.fps ?? 0, cpuMs: s?.cpuMs ?? 0, physics, bodies: g.bodies, links: g.hinges.links, live: g.hinges.live, clouds: g.smoke.clouds, standing: g.standing, settled: g.debris.piled, sanity: g.sanity, heapMb: heap / 1048576 };
    });

  // Viewpoints around the arena; the player wanders between them.
  const views = [
    [-4, 9, -30, -1, 4, 0],
    [-2, 6.5, -15, 1.5, 4, 0],
    [-27, 10, -19, -10, 5, 0],
    [8, 4, -16, 12, 2.5, -5],
    [28, 8, -20, 13, 3, 0],
    [-10, 6, 18, -8, 3, 0],
    [14, 5, 22, 13, 3, 0],
  ];
  const t0 = Date.now();
  let nextSample = 0;
  // --profile: a CPU profile of the main thread over the middle third of the session.
  const profile = process.argv.includes('--profile');
  const cdp = profile ? await page.context().newCDPSession(page) : null;
  let profiling = 'before';
  if (cdp) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  }
  while (Date.now() - t0 < seconds * 1000) {
    const elapsed = (Date.now() - t0) / 1000;
    if (cdp && profiling === 'before' && elapsed > Number(arg('profile-from', seconds / 3))) {
      profiling = 'on';
      await cdp.send('Profiler.start');
    }
    if (cdp && profiling === 'on' && elapsed > Number(arg('profile-to', (2 * seconds) / 3))) {
      profiling = 'done';
      const { profile: prof } = await cdp.send('Profiler.stop');
      const self = new Map();
      const total = prof.samples.length;
      const byId = new Map(prof.nodes.map((n) => [n.id, n]));
      const counts = new Map();
      for (const id of prof.samples) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const [id, n] of counts) {
        const node = byId.get(id);
        const f = node.callFrame;
        const key = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
        self.set(key, (self.get(key) ?? 0) + n);
      }
      const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
      console.log('CPU profile, self time (main thread):');
      for (const [k, n] of top) console.log(`  ${((100 * n) / total).toFixed(1).padStart(5)}%  ${k}`);
      // Inclusive time of our own functions and the engine's step phases (what calls into the physics module).
      const inclusive = new Map();
      const visit = (id) => {
        const node = byId.get(id);
        let sum = counts.get(id) ?? 0;
        for (const c of node.children ?? []) sum += visit(c);
        const f = node.callFrame;
        if (/destruction\/src|engine\/src/.test(f.url) || /^(step|fixedUpdate|update|lateUpdate|renderFrame)$/.test(f.functionName)) {
          const key = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
          inclusive.set(key, Math.max(inclusive.get(key) ?? 0, 0) + sum);
        }
        return sum;
      };
      visit(prof.nodes[0].id);
      console.log('Inclusive (our code and engine phases):');
      for (const [k, n] of [...inclusive.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log(`  ${((100 * n) / total).toFixed(1).padStart(5)}%  ${k}`);
    }
    const r = random();
    if (r < 0.12) {
      const v = pick(views);
      await page.evaluate((x) => window.__spark.game.setView(...x), v);
      actions.push(`${elapsed.toFixed(1)} view ${v.slice(0, 3).join(',')}`);
    } else if (r < 0.24) {
      const key = pick(['Digit1', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5']);
      await page.keyboard.press(key);
      actions.push(`${elapsed.toFixed(1)} key ${key}`);
    } else if (r < 0.3) {
      // Right-drag to look around a bit.
      const x = 300 + random() * 680;
      await page.mouse.move(x, 360);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(x + (random() - 0.5) * 300, 360 + (random() - 0.5) * 120, { steps: 6 });
      await page.mouse.up({ button: 'right' });
      actions.push(`${elapsed.toFixed(1)} look`);
    } else if (r < 0.35) {
      const key = pick(['KeyW', 'KeyA', 'KeyS', 'KeyD']);
      await page.keyboard.down(key);
      await page.waitForTimeout(250 + random() * 400);
      await page.keyboard.up(key);
      actions.push(`${elapsed.toFixed(1)} fly ${key}`);
    } else if (r < 0.37 && elapsed > 20) {
      const name = pick(['bridge-A-end', 'A-top-walls', 'B-corner', 'A-ground']);
      await page.evaluate((n) => window.__spark.game.scenario(n), name);
      actions.push(`${elapsed.toFixed(1)} scenario ${name}`);
    } else {
      // Click somewhere in the middle of the screen, where the buildings mostly are.
      const x = 200 + random() * 880;
      const y = 180 + random() * 380;
      await page.mouse.click(x, y);
      actions.push(`${elapsed.toFixed(1)} click ${x.toFixed(0)},${y.toFixed(0)}`);
    }
    await page.waitForTimeout(120 + random() * 380);
    if (elapsed >= nextSample) {
      nextSample = elapsed + 0.5;
      samples.push({ t: +elapsed.toFixed(1), ...(await sample()) });
    }
  }
  // Let it all settle, then a last look.
  await page.waitForTimeout(6000);
  samples.push({ t: seconds + 6, ...(await sample()) });
  liveHeapMb = [heapStart, await liveHeap()];
  // Every throw the debris guard caught and undid (a body over 32 m/s after a step); one it missed shows as maxSpeed.
  flings = await page.evaluate(() => {
    const g = window.__spark.game.stats();
    return { count: g.debris.flung, last: g.flings, sunk: g.debris.sunk, sinks: g.sinks };
  });
} finally {
  await browser.close();
  await server.close();
}

const after = samples.slice(4);
const failures = [];
const fpsSorted = after.map((s) => s.fps).sort((a, b) => a - b);
const p05 = fpsSorted[Math.floor(fpsSorted.length * 0.05)] ?? 0;
const maxOf = (f) => Math.max(...samples.map(f));
const nonFinite = maxOf((s) => s.sanity.nonFinite);
const maxSpeed = maxOf((s) => s.sanity.maxSpeed);
const minY = Math.min(...samples.map((s) => s.sanity.minY));
const heap0 = samples[2]?.heapMb ?? 0;
const heap1 = samples.at(-1).heapMb;
if (problems.length) failures.push(`${problems.length} console problems: ${problems.slice(0, 3).join(' | ')}`);
if (nonFinite > 0) failures.push(`${nonFinite} bodies with non-finite poses`);
// The step guard undoes anything over 32 m/s (a clamp holds 24 before each step, and a blast can add 7 to that).
if (maxSpeed > 32) failures.push(`a body reached ${maxSpeed.toFixed(1)} m/s past the step guard`);
if (flings.sunk > 0) failures.push(`${flings.sunk} bodies went through the floor`);
if (minY < -2) failures.push(`a body fell through the world (y ${minY.toFixed(1)})`);
if (maxOf((s) => s.bodies) > 700) failures.push(`loose bodies over budget (${maxOf((s) => s.bodies)})`);
if (maxOf((s) => s.links) > 260) failures.push(`hinge links over budget (${maxOf((s) => s.links)})`);
if (maxOf((s) => s.clouds) > 4) failures.push(`smoke clouds over budget (${maxOf((s) => s.clouds)})`);
if (p05 < 40) failures.push(`5th-percentile fps ${p05.toFixed(0)}`);
if (liveHeapMb[1] - liveHeapMb[0] > 60) failures.push(`live JS heap grew ${(liveHeapMb[1] - liveHeapMb[0]).toFixed(0)} MB after collection`);
const summary = {
  seconds,
  actions: actions.length,
  clicks: actions.filter((a) => a.includes('click')).length,
  scenarios: actions.filter((a) => a.includes('scenario')),
  fps: { p05: +p05.toFixed(1), median: +fpsSorted[Math.floor(fpsSorted.length / 2)].toFixed(1), min: +fpsSorted[0].toFixed(1) },
  worstCpuMs: +Math.max(...after.map((s) => s.cpuMs)).toFixed(2),
  worstPhysicsMs: +Math.max(...after.map((s) => s.physics)).toFixed(2),
  maxBodies: maxOf((s) => s.bodies),
  maxLinks: maxOf((s) => s.links),
  maxClouds: maxOf((s) => s.clouds),
  maxSpeed: +maxSpeed.toFixed(1),
  flung: flings.count,
  flings: flings.last,
  sunk: flings.sunk,
  sinks: flings.sinks,
  minY: +minY.toFixed(2),
  heapMb: [+heap0.toFixed(0), +heap1.toFixed(0)],
  liveHeapMb: liveHeapMb.map((v) => +v.toFixed(1)),
  end: samples.at(-1),
  failures,
};
await writeFile(path.join(root, 'captures', 'soak.json'), JSON.stringify({ summary, samples, actions, problems }, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(failures.length ? 1 : 0);
