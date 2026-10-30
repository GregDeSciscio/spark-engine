#!/usr/bin/env node
/**
 * The destruction slice, driven headless (docs/design/destruction-game-readiness.md):
 *
 * Fixed clock (strain inline, deterministic):
 * - a wall blown out of the depot opens a shorter way in on the navmesh, once its tiles are rebuilt;
 * - a bot standing in the tower's ground storey is killed by the storeys above when it goes;
 * - a bot in gas takes damage until it dies;
 * - a checkpoint saved after all that, then the shed blown up, then the checkpoint loaded: every
 *   structure, the dead bots and the player come back as saved.
 *
 * - each of the tower's and the depot's tops, timed as it comes down against free fall: never back up
 *   (a top that landed on the storey under it used to rebound almost to where it was built).
 *
 * Real time (strain on the shared worker): three structures on one worker, then the tower's ground
 * storey, a rocket barrage on the depot and the shed while the bots patrol and the navmesh rebuilds:
 * frame pacing, the debris peak against the shared budget, tiles rebuilt, console errors.
 *
 *   node tools/probe.mjs [--realtime-only] [--fixed-only] [--throttle=4] [--json]
 * Exits 1 if a check fails.
 */
/* global requestAnimationFrame, OfflineAudioContext -- in page.evaluate, which runs in the browser */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../tools/capture/capture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = (k) => process.argv.includes(`--${k}`);
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', server: { port: 5402, strictPort: false, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const browser = await launchBrowser(false);
const checks = [];
/** `open`: a known issue being measured (docs/design/destruction-game-readiness.md); it prints OPEN instead of failing the run. */
const check = (name, ok, detail, open = false) => {
  checks.push({ name, ok: ok || open, open: open && !ok, detail });
  console.log(`${ok ? 'ok  ' : open ? 'OPEN' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};
const report = {};

/** `--throttle=4` slows the page's CPU fourfold (Chromium's own emulation): a stand-in for a slower machine's CPU, not its GPU. */
const throttle = Number(process.argv.find((a) => a.startsWith('--throttle='))?.split('=')[1] ?? 1);
/** `--query=maxBodies=180&navTiles=0`: extra page options for the real-time run (the slice's tuning knobs). */
const extra = process.argv.find((a) => a.startsWith('--query='))?.slice('--query='.length) ?? '';

async function boot(query) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  if (throttle > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && !m.text().includes('[vite]'))) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${server.resolvedUrls.local[0]}?overlay=0${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__spark && (window.__spark.ready || window.__spark.error), null, { timeout: 180_000 });
  const error = await page.evaluate(() => window.__spark.error);
  if (error) throw new Error(`boot failed: ${error}`);
  const game = (fn, ...a) => page.evaluate(([f, x]) => window.__spark.game[f](...x), [fn, a]);
  return { page, errors, game };
}

try {
  // ---- fixed clock --------------------------------------------------------------------------
  if (!only('realtime-only')) {
    const { page, errors, game } = await boot('&fixedclock=60&seed=3');
    await page.evaluate(() => window.__spark.engine.stop());
    const step = (n) => page.evaluate((k) => window.__spark.stepFrames(k), n);
    await step(10);
    const s0 = await game('stats');
    check('three structures from the Blender level, all standing', s0.structures.length === 3 && s0.structures.every((s) => s.standing === s.chunks), s0.structures.map((s) => `${s.name} ${s.chunks}`).join(', '));

    // The depot: 12 x 8 m at (-14, 6), its back wall at z = 10. Outside the back to just inside it.
    const way = [-14, 0, 13.5, -14, 0, 8];
    const before = await game('pathLength', ...way);
    // Bots keep away from it meanwhile.
    for (let i = 0; i < 5; i++) await game('placeBot', i, -30 + i * 2, 0.9, -30, true);
    const tiles0 = (await game('stats')).nav.rebuilt;
    const gone = await game('removeBox', 'depot', [-15.6, 0, 9.4], [-12.4, 2.6, 10.6]);
    // The scene rebuilds a tile a frame once the structure reports the change (four times a second).
    await step(30);
    await game('flushNav');
    const after = await game('pathLength', ...way);
    const rebuilt = (await game('stats')).nav.rebuilt - tiles0;
    report.wall = { before: +before.toFixed(1), after: +after.toFixed(1), chunks: gone, tilesRebuilt: rebuilt };
    check('a wall blown out of the depot opens a shorter way in, once its tiles are rebuilt', before > 15 && after > 0 && after < 7 && rebuilt > 0 && rebuilt < 20, report.wall);

    // How a top comes down: its drop every quarter second against free fall (a float shows as a plateau).
    const fall = async (name, aboveY, frames = 150) => {
      const rows = [];
      for (let f = 15; f <= frames; f += 15) {
        await step(15);
        const d = await game('drop', name, aboveY);
        rows.push({ t: f / 60, drop: +d.drop.toFixed(2), inPlace: d.inPlace, of: d.count, freeFall: +(4.905 * (f / 60) ** 2).toFixed(2) });
      }
      return rows;
    };
    const firm = (rows) => {
      // Down a metre by one second, and never back up (beyond a heap settling) at any look.
      const at1 = rows.find((r) => r.t >= 1);
      return at1 !== undefined && at1.drop > 1 && rows.every((r, i) => i === 0 || r.drop >= rows[i - 1].drop - 0.15);
    };

    // A bot in the tower's ground storey (8 x 8 m at (13, 10)) when it goes; the top storey's fall timed.
    await game('placeBot', 1, 14.5, 0.9, 8.5, true);
    await step(5);
    await game('removeBox', 'tower', [8.5, 0, 5.5], [17.5, 2.8, 14.5]);
    report.towerFall = await fall('tower', 9.5);
    check("the tower's top comes straight down when its ground storey goes, no stall", firm(report.towerFall), report.towerFall.map((r) => `${r.t}s ${r.drop}m (${r.inPlace}/${r.of} up)`).join(', '));
    await step(90);
    const s1 = await game('stats');
    report.tower = { standing: s1.structures.find((s) => s.name === 'tower').standing, bot: s1.bots[1], hits: s1.hits };
    check('a bot in the tower when its ground storey goes is killed by what comes down', !s1.bots[1].alive && s1.hits > 0, { alive: s1.bots[1].alive, hits: s1.hits });

    // Gas on a bot in the open.
    await game('placeBot', 2, 0, 0.9, 4, true);
    await game('gas', 0, 1, 4);
    await step(90);
    const hurt = (await game('stats')).bots[2];
    await step(360);
    const dead = (await game('stats')).bots[2];
    report.gas = { after1_5s: Math.round(hurt.health), after7_5s: Math.round(dead.health), alive: dead.alive };
    check('a bot in gas takes damage until it dies', hurt.health < 100 && !dead.alive, report.gas);

    // A checkpoint after all that; then the shed blown away; then the checkpoint.
    await step(60);
    const saved = await game('stats');
    await game('save');
    await game('setPlayer', 2, 0.9, -24);
    for (const [x, z] of [
      [0, -18.4],
      [2.5, -18],
      [4, -17],
    ])
      await game('explode', x, 1.4, z, 2.4);
    await step(120);
    const wrecked = await game('stats');
    const loaded = await game('load');
    await step(2);
    const back = await game('stats');
    const standing = (s) => Object.fromEntries(s.structures.map((x) => [x.name, x.standing]));
    report.checkpoint = { saved: standing(saved), wrecked: standing(wrecked), loaded: standing(back), bots: back.bots.map((b) => b.alive), savedBots: saved.bots.map((b) => b.alive), player: [+back.player.x.toFixed(2), +back.player.z.toFixed(2)] };
    check(
      'a checkpoint brings back every structure, the dead bots and the player as saved',
      loaded && wrecked.structures.find((s) => s.name === 'shed').standing < saved.structures.find((s) => s.name === 'shed').standing && JSON.stringify(standing(back)) === JSON.stringify(standing(saved)) && JSON.stringify(report.checkpoint.bots) === JSON.stringify(report.checkpoint.savedBots) && Math.abs(back.player.z - saved.player.z) < 0.01,
      report.checkpoint,
    );
    // And it carries on from there.
    await step(180);
    const later = await game('stats');
    check('after the load the structures settle and nothing cascades for ever', later.structures.every((s) => !s.cascading), standing(later));
    // The depot's ground storey, the rest of it: its upper storey timed.
    await game('removeBox', 'depot', [-21, 0, 1], [-7, 2.8, 11]);
    report.depotFall = await fall('depot', 3.1);
    check("the depot's top comes straight down when its ground storey goes, no stall", firm(report.depotFall), report.depotFall.map((r) => `${r.t}s ${r.drop}m (${r.inPlace}/${r.of} up)`).join(', '));
    check('no console errors on the fixed clock', errors.length === 0, errors.slice(0, 5));
    await page.close();
  }

  // ---- real time ------------------------------------------------------------------------------
  if (!only('fixed-only')) {
    const { page, errors, game } = await boot(extra ? `&${extra}` : '');
    await page.waitForFunction(() => window.__spark.game.stats().structures.every((s) => s.strainMode === 'worker'), null, { timeout: 60_000 });
    // Past the renderer's warm-up, then the bots patrol a while.
    await page.waitForTimeout(7000);
    const s0 = await game('stats');
    check('three structures solve on one shared worker', s0.worker.structures === 3 && s0.worker.running && s0.structures.every((s) => s.strainMode === 'worker'), s0.worker);
    // The sandbox's sound takes, served from its folder: every one fetched and decoded.
    const decoded = await page.evaluate(async () => {
      const names = { boom: 4, collapse: 4, crumble: 4, crack: 3, creak: 4, thud: 4, clang: 3 };
      const urls = [...Object.entries(names).flatMap(([n, k]) => Array.from({ length: k }, (_, i) => `/sfx/${n}-${i + 1}.mp3`)), '/sfx/air.wav'];
      const ctx = new OfflineAudioContext(1, 1, 44100);
      let ok = 0;
      for (const url of urls) {
        const r = await fetch(url);
        if (!r.ok) continue;
        try {
          await ctx.decodeAudioData(await r.arrayBuffer());
          ok++;
        } catch {
          // counted as missing
        }
      }
      return { ok, of: urls.length };
    });
    check('every sound take is served and decodes', decoded.ok === decoded.of, decoded);
    await game('listen', true);
    const pacing = await page.evaluate(async () => {
      const g = window.__spark.game;
      const frames = [];
      const standing = [];
      let peak = 0;
      let last = performance.now();
      const start = last;
      let phase = 0;
      await new Promise((resolve) => {
        const tick = (now) => {
          const t = (now - start) / 1000;
          // Before the barrage: the yard standing, for comparison.
          if (phase === 0) standing.push(now - last);
          else frames.push(now - last);
          last = now;
          peak = Math.max(peak, g.stats().budgets.bodies);
          if (phase === 0 && t > 1) {
            phase = 1;
            g.removeBox('tower', [8.5, 0, 5.5], [17.5, 2.8, 14.5]);
          }
          if (phase === 1 && t > 3) {
            phase = 2;
            for (const [x, y, z] of [
              [-17, 1.4, 2.2],
              [-11, 1.4, 2.2],
              [-14, 4.6, 2.2],
              [-19.8, 1.4, 6],
            ])
              g.explode(x, y, z, 1.8);
          }
          if (phase === 2 && t > 5) {
            phase = 3;
            for (const [x, z] of [
              [0, -18.4],
              [2.5, -18],
              [4, -17],
            ])
              g.explode(x, 1.4, z, 2.4);
          }
          if (t < 14) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      const sorted = [...frames].sort((a, b) => a - b);
      const q = (p) => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1);
      const s = g.stats();
      const still = [...standing].sort((a, b) => a - b);
      return { standingMedian: +(still[Math.floor(still.length / 2)] ?? 0).toFixed(1), frames: frames.length, median: q(0.5), p95: q(0.95), p99: q(0.99), longest: +sorted[sorted.length - 1].toFixed(1), over33: frames.filter((f) => f > 33.4).length, peakBodies: peak, limit: s.budgets.bodyLimit, rebuilt: s.nav.rebuilt, pending: s.nav.pendingTiles, standing: Object.fromEntries(s.structures.map((x) => [x.name, `${x.standing}/${x.chunks}`])), botsAlive: s.bots.filter((b) => b.alive).length };
    });
    report.realtime = pacing;
    const heard = await game('heard');
    report.heard = heard;
    check('the collapse is heard: booms, debris coming down, landings', (heard.boom ?? 0) > 0 && (heard.crumble ?? 0) + (heard.collapse ?? 0) > 0 && (heard.thud ?? 0) > 0, heard);
    console.log(`real time: ${JSON.stringify(pacing)}`);
    check('three buildings coming down at once stay within the shared debris budget', pacing.peakBodies <= pacing.limit * 1.5, { peak: pacing.peakBodies, limit: pacing.limit });
    check('the navmesh rebuilt where they came down', pacing.rebuilt > 0, { rebuilt: pacing.rebuilt, pending: pacing.pending });
    check('no console errors in real time', errors.length === 0, errors.slice(0, 5));
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (only('json')) console.log(JSON.stringify({ checks, report }));
const failed = checks.filter((c) => !c.ok);
const open = checks.filter((c) => c.open).length;
console.log(failed.length === 0 ? `all ${checks.length - open} checks passed${open ? `, ${open} open` : ''}` : `${failed.length} of ${checks.length} checks failed`);
process.exit(failed.length === 0 ? 0 : 1);
