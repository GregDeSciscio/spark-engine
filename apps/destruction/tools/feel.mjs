#!/usr/bin/env node
/**
 * How it feels, measured: a real-time session (wall clock, strain in the
 * worker) driven only by real mouse and keyboard events, recorded to video.
 *
 * - click → blast: time from a left click to the first frame whose debris
 *   count rose, and to the boom starting (a new audio voice);
 * - drag → look: time from the first right-drag movement to the view turning;
 * - frame pacing: per-frame times from requestAnimationFrame while playing
 *   (median, p95, p99, longest);
 * - the session as a .webm in captures/feel/ for a look at it in motion.
 *
 *   node tools/feel.mjs [--headed] [--profile]
 */
/* global requestAnimationFrame, addEventListener -- in page.evaluate, which runs in the browser */
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../tools/capture/capture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'captures', 'feel');
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', server: { port: 5395, strictPort: false, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
// `--query=&tower=0`: more of the sandbox's URL (without the tower, say).
const query = process.argv.find((a) => a.startsWith('--query='))?.slice('--query='.length) ?? '';
const browser = await launchBrowser(process.argv.includes('--headed'));
const report = {};
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: outDir, size: { width: 1280, height: 720 } } });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(String(e)));
  await page.goto(`${server.resolvedUrls.local[0]}?overlay=0${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__spark?.ready && window.__spark.game.stats().init !== null, null, { timeout: 120_000 });

  // A frame-time recorder and probes that note the first frame something changed, all in page time.
  await page.evaluate(() => {
    const w = window;
    w.__feel = { frames: [], marks: {} };
    let last = performance.now();
    const tick = (t) => {
      w.__feel.frames.push(t - last);
      last = t;
      const g = w.__spark.game.stats();
      const a = w.__spark.engine.audio.stats();
      const m = w.__feel.marks;
      if (m.watch) {
        if (m.firstDebris === undefined && g.debris.created > m.created0) m.firstDebris = t;
        if (m.firstVoice === undefined && a.activeVoices > m.voices0) m.firstVoice = t;
        if (m.firstTurn === undefined && Math.abs(g.view.yaw - m.yaw0) > 1e-4) m.firstTurn = t;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // The real input's timestamp, taken by the page itself.
    addEventListener('pointerdown', (e) => (w.__feel.marks.down = e.timeStamp), true);
    addEventListener('pointermove', (e) => {
      if (e.buttons & 2 && w.__feel.marks.moveAt === undefined) w.__feel.marks.moveAt = e.timeStamp;
    }, true);
  });
  const arm = () =>
    page.evaluate(() => {
      const g = window.__spark.game.stats();
      window.__feel.marks = { watch: true, created0: g.debris.created, voices0: window.__spark.engine.audio.stats().activeVoices, yaw0: g.view.yaw };
    });
  const marks = () => page.evaluate(() => window.__feel.marks);

  // 1. Click → blast, five times at B's piers (the first click also unlocks audio).
  const clicks = [];
  await page.evaluate(() => window.__spark.game.setView(14.4, 2.2, -16, 14.4, 1.8, -5));
  await page.waitForTimeout(600);
  for (let i = 0; i < 5; i++) {
    await arm();
    await page.mouse.click(640 + (i - 2) * 70, 360 + (i % 2) * 40);
    await page.waitForTimeout(700);
    const m = await marks();
    clicks.push({ visual: m.firstDebris !== undefined ? +(m.firstDebris - m.down).toFixed(1) : null, audio: m.firstVoice !== undefined ? +(m.firstVoice - m.down).toFixed(1) : null });
  }
  report.clickToBlastMs = clicks;

  // 2. Right-drag → look.
  const looks = [];
  for (let i = 0; i < 3; i++) {
    await arm();
    await page.mouse.move(640, 360);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(700, 360, { steps: 4 });
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(200);
    const m = await marks();
    looks.push(m.firstTurn !== undefined && m.moveAt !== undefined ? +(m.firstTurn - m.moveAt).toFixed(1) : null);
    await page.evaluate(() => (window.__feel.marks.moveAt = undefined));
  }
  report.dragToLookMs = looks;

  // 3. Frame pacing through a bout of play: bridge cut, rockets, a charge, smoke, a collapse.
  await page.evaluate(() => (window.__feel.frames.length = 0));
  await page.evaluate(() => window.__spark.game.setView(-4, 9, -30, -1, 4, 0));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__spark.game.scenario('bridge-A-end'));
  await page.waitForTimeout(1500);
  for (const [x, y] of [[420, 330], [560, 300], [760, 380], [880, 320]]) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(450);
  }
  await page.keyboard.press('Digit3');
  await page.mouse.click(470, 400);
  await page.waitForTimeout(600);
  await page.keyboard.press('Digit4');
  await page.mouse.click(820, 420);
  await page.waitForTimeout(500);
  // --profile: what the frames right after the collapse spend their time on.
  const cdp = process.argv.includes('--profile') ? await page.context().newCDPSession(page) : null;
  if (cdp) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');
  }
  await page.evaluate(() => window.__spark.game.scenario('A-ground'));
  await page.waitForTimeout(cdp ? 2500 : 6000);
  if (cdp) {
    const { profile: prof } = await cdp.send('Profiler.stop');
    const byId = new Map(prof.nodes.map((n) => [n.id, n]));
    const counts = new Map();
    for (const id of prof.samples) counts.set(id, (counts.get(id) ?? 0) + 1);
    const inclusive = new Map();
    const visit = (id) => {
      const node = byId.get(id);
      let sum = counts.get(id) ?? 0;
      for (const c of node.children ?? []) sum += visit(c);
      const f = node.callFrame;
      if (/destruction\/src|engine\/src/.test(f.url)) {
        const key = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
        inclusive.set(key, (inclusive.get(key) ?? 0) + sum);
      }
      return sum;
    };
    visit(prof.nodes[0].id);
    const total = prof.samples.length;
    report.collapseProfile = [...inclusive.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, n]) => `${((100 * n) / total).toFixed(1)}% ${k}`);
  }
  const frames = await page.evaluate(() => window.__feel.frames.slice(2));
  const sorted = [...frames].sort((a, b) => a - b);
  const pct = (p) => +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1);
  report.framePacing = { frames: frames.length, medianMs: pct(0.5), p95Ms: pct(0.95), p99Ms: pct(0.99), longestMs: +sorted.at(-1).toFixed(1), over33ms: frames.filter((f) => f > 33.4).length };
  report.problems = problems;
  await context.close();
  // Keep the recording under a stable name.
  const [video] = (await readdir(outDir)).filter((f) => f.endsWith('.webm'));
  if (video) await rename(path.join(outDir, video), path.join(outDir, 'session.webm'));
} finally {
  await browser.close();
  await server.close();
}
console.log(JSON.stringify(report, null, 2));
