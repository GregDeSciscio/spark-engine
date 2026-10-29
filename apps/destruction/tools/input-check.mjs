#!/usr/bin/env node
/**
 * The sandbox as a player gets it: real time, strain in the worker, and real
 * keyboard and mouse events from Playwright (no game API for the inputs
 * themselves). Checks weapon keys, flying, right-drag look, a left click on
 * a wall blowing a hole in it, that the click unlocks audio and the blast is
 * heard, and that every sound take decodes. Exit 1 on any failure.
 *
 *   node tools/input-check.mjs [--headed]
 */
/* global OfflineAudioContext -- in page.evaluate, which runs in the browser */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../tools/capture/capture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const headed = process.argv.includes('--headed');
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', server: { port: 5393, strictPort: false, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const browser = await launchBrowser(headed);
const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'load' });
  await page.waitForFunction(() => window.__spark?.ready && window.__spark.game.stats().init !== null, null, { timeout: 120_000 });
  // The sound takes decode in the background; the blast below should find its takes ready.
  await page.waitForFunction(() => window.__spark.engine.audio.stats().loadedBuffers >= 18, null, { timeout: 30_000 });
  const stats = () => page.evaluate(() => window.__spark.game.stats());
  const audio = () => page.evaluate(() => window.__spark.engine.audio.stats());
  const wait = (ms) => page.waitForTimeout(ms);

  await page.mouse.move(640, 360);
  await page.keyboard.press('Digit3');
  await wait(150);
  check((await stats()).weapon === 'charge', 'key 3 selects the breach charge');
  await page.keyboard.press('Digit1');
  await wait(150);
  check((await stats()).weapon === 'rocket', 'key 1 selects the rocket');

  const before = (await stats()).view;
  await page.keyboard.down('KeyW');
  await wait(500);
  await page.keyboard.up('KeyW');
  const after = (await stats()).view;
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  check(moved > 2 && moved < 7, `holding W for half a second flies forward (${moved.toFixed(2)} m)`);

  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 10; i++) await page.mouse.move(640 + i * 12, 360, { steps: 2 });
  await page.mouse.up({ button: 'right' });
  await wait(100);
  const turned = (await stats()).view.yaw - after.yaw;
  check(turned < -0.15, `right-drag turns the view (${turned.toFixed(2)} rad)`);

  // Face a pier of B's front wall (between two windows), then click it.
  await page.evaluate(() => window.__spark.game.setView(14.4, 2, -14, 14.4, 1.7, -5));
  await wait(200);
  const s0 = await stats();
  const a0 = await audio();
  await page.mouse.click(640, 360);
  await wait(120);
  const a1 = await audio();
  await wait(900);
  const s1 = await stats();
  check(s1.standing < s0.standing || s1.bodies > s0.bodies, `a left click at the cursor blows a hole (${s0.standing} → ${s1.standing} standing, ${s1.bodies} loose)`);
  check(a1.unlocked && a1.state === 'running', `the click unlocks audio (state ${a1.state})`);
  check(a1.sounds >= 8, `the destruction sounds are defined (${a1.sounds})`);
  check(a1.ambience.current === 'destruction-air', `the air starts with the first click (${a1.ambience.current})`);
  check(a1.activeVoices > a0.activeVoices, `the blast is playing (${a0.activeVoices} → ${a1.activeVoices} voices, ${a1.spatialVoices} spatial)`);

  // Presses must not be dropped on frames without a fixed step: ten quick weapon swaps,
  // 30 ms apart (two frames; faster than anyone types).
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press(i % 2 === 0 ? 'Digit2' : 'Digit1');
    await wait(30);
  }
  await wait(100);
  check((await stats()).weapon === 'rocket', 'ten quick key presses all land');

  // Every take of every sound loads and decodes, at a real level and unclipped.
  const takes = await page.evaluate(async () => {
    const { TAKES, soundUrls } = await import('/src/sounds.ts');
    const ctx = new OfflineAudioContext(1, 1, 48000);
    const out = [];
    for (const name of Object.keys(TAKES)) {
      for (const url of soundUrls(name)) {
        const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
        let peak = 0;
        let sum = 0;
        for (let c = 0; c < buf.numberOfChannels; c++) {
          for (const v of buf.getChannelData(c)) {
            peak = Math.max(peak, Math.abs(v));
            sum += v * v;
          }
        }
        out.push({ url, seconds: buf.duration, peak, rms: Math.sqrt(sum / (buf.length * buf.numberOfChannels)) });
      }
    }
    return out;
  });
  check(takes.length >= 18, `${takes.length} sound takes decode`);
  for (const s of takes) {
    check(s.peak > 0.2 && s.peak <= 1 && s.rms > 0.01 && s.seconds > 0.3, `${s.url.split('/').pop()}: ${s.seconds.toFixed(2)} s, peak ${s.peak.toFixed(2)}, rms ${s.rms.toFixed(3)}`);
  }

  check(problems.length === 0, `no page errors (${problems.slice(0, 3).join(' | ')})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.log(`${failures.length} failed`);
  process.exit(1);
}
console.log('input check passed');
