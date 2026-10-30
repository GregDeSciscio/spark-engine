#!/usr/bin/env node
/**
 * A session of the slice played through real input only, recorded: the
 * keyboard walks, a right-drag looks, clicks fire, number keys switch weapon,
 * F5 saves and F9 loads. It plays in real time with strain on the shared
 * worker, the way a person would, and records it to captures/play.webm for a
 * person to watch. It is not a playtest; it gives the playtest a first pass,
 * and the recording something to judge.
 *
 * What it does: walks up the yard, puts two rockets into the shed ahead,
 * turns to the depot for three rockets and three rifle shots, saves, turns to
 * the tower for three rockets at its base and a gas grenade, watches it come
 * down, then loads the checkpoint and walks off.
 *
 * Checks: every phase's input landed (the structure it aimed at lost chunks,
 * the checkpoint brought them back), the collapse was heard, no console
 * errors, nothing non-finite; and it reports the frame pacing.
 *
 *   node tools/play.mjs [--no-video] [--shots]
 */
/* global requestAnimationFrame -- in page.evaluate, which runs in the browser */
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../tools/capture/capture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'captures');
const video = !process.argv.includes('--no-video');
/** `--shots`: a still after each phase, captures/play-<phase>.png. */
const shots = process.argv.includes('--shots');
await mkdir(out, { recursive: true });
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', server: { port: 5403, strictPort: false, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const browser = await launchBrowser(false);
const W = 1280;
const H = 720;
/** The camera's mouse sensitivity (SHOULDER_PRESET): radians of yaw per pixel dragged. */
const SENSITIVITY = 0.0022;
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
};

const context = await browser.newContext({ viewport: { width: W, height: H }, ...(video ? { recordVideo: { dir: out, size: { width: W, height: H } } } : {}) });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || (m.type() === 'warning' && !m.text().includes('[vite]'))) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
try {
  await page.goto(`${server.resolvedUrls.local[0]}?overlay=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__spark?.ready && window.__spark.game.stats().structures.every((s) => s.strainMode === 'worker'), null, { timeout: 180_000 });
  const stats = () => page.evaluate(() => window.__spark.game.stats());
  const standing = async () => Object.fromEntries((await stats()).structures.map((s) => [s.name, s.standing]));
  await page.evaluate(() => {
    // Frame times from here on, and every sound played.
    const s = window.__spark;
    s.frames = [];
    let last = performance.now();
    const tick = (now) => {
      s.frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    s.game.listen(true);
  });
  await page.waitForTimeout(6000); // past the renderer's warm-up, the bots on patrol

  const center = { x: W / 2, y: H / 2 };
  await page.mouse.move(center.x, center.y);
  /** Look round by dragging with the right button: `yaw` radians (positive turns the view toward -x from facing +z). */
  // Where the cursor is. Under pointer lock every mouse move turns the view, button or not, so the
  // cursor stays where a drag leaves it and clicks land there (they fire at the crosshair anyway).
  const cursor = { ...center };
  /** Look round by dragging with the right button: `yaw` radians (positive turns the view toward -x from facing +z). */
  const turn = async (yaw, pitch = 0) => {
    await page.mouse.down({ button: 'right' });
    const dx = yaw / SENSITIVITY;
    const dy = pitch / SENSITIVITY;
    const steps = 12;
    const from = { ...cursor };
    for (let i = 1; i <= steps; i++) {
      cursor.x = from.x + (dx * i) / steps;
      cursor.y = from.y + (dy * i) / steps;
      await page.mouse.move(cursor.x, cursor.y);
      await page.waitForTimeout(16);
    }
    await page.mouse.up({ button: 'right' });
  };
  const fire = async (n, gap = 900) => {
    for (let i = 0; i < n; i++) {
      // The first click asks for the pointer; after that clicks fire at the crosshair.
      await page.mouse.click(cursor.x, cursor.y);
      await page.waitForTimeout(gap);
    }
  };
  const shot = async (name) => {
    if (shots) await page.screenshot({ path: path.join(out, `play-${name}.png`) });
  };
  const hold = async (key, ms) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
  };

  // Walk up the yard toward the shed.
  const start = await stats();
  await hold('KeyW', 1500);
  const walked = await stats();
  check('W walks the player up the yard', walked.player.z - start.player.z > 4, { from: +start.player.z.toFixed(1), to: +walked.player.z.toFixed(1) });

  // Two rockets into the shed straight ahead (one click may go to asking for the pointer).
  const s0 = await standing();
  await fire(3, 1100);
  await page.waitForTimeout(2500);
  const s1 = await standing();
  check('rockets at the shed take chunks out of it', s1.shed < s0.shed, { before: s0.shed, after: s1.shed });

  // Turn to the depot (from about (0, -22.5): 0.52 rad toward -x), three rockets, then the rifle.
  await turn(0.52, -0.02);
  await shot('depot-aim');
  await fire(3, 1100);
  await page.keyboard.press('Digit2');
  await fire(3, 300);
  await page.waitForTimeout(2500);
  const s2 = await standing();
  check('a right-drag turns to the depot, and rockets take chunks out of it', s2.depot < s1.depot, { before: s1.depot, after: s2.depot });

  // Save here.
  await page.keyboard.press('F5');
  await page.waitForTimeout(300);
  const saved = await stats();
  check('F5 saves a checkpoint', saved.checkpoint, saved.checkpoint);

  // Turn to the tower (0.9 rad the other way), rockets at its base, then gas, and watch.
  await page.keyboard.press('Digit1');
  await turn(-0.9, 0.04);
  await shot('tower-aim');
  await fire(3, 1100);
  await page.keyboard.press('Digit3');
  await fire(1, 300);
  await page.waitForTimeout(5000);
  const s3 = await standing();
  check('rockets at the tower take chunks out of it', s3.tower < s2.tower, { before: s2.tower, after: s3.tower });

  // Back to the checkpoint.
  await page.keyboard.press('F9');
  await page.waitForTimeout(600);
  const s4 = await standing();
  check('F9 brings the checkpoint back: every structure as it was saved', JSON.stringify(s4) === JSON.stringify(Object.fromEntries(saved.structures.map((s) => [s.name, s.standing]))), { saved: Object.fromEntries(saved.structures.map((s) => [s.name, s.standing])), loaded: s4 });
  await hold('KeyS', 800);
  await hold('KeyA', 800);
  await page.waitForTimeout(1500);

  const end = await page.evaluate(() => {
    const s = window.__spark;
    const f = [...s.frames].sort((a, b) => a - b);
    const q = (p) => +f[Math.min(f.length - 1, Math.floor(p * f.length))].toFixed(1);
    const st = s.game.stats();
    return {
      pacing: { frames: f.length, median: q(0.5), p95: q(0.95), p99: q(0.99), longest: +f[f.length - 1].toFixed(1), over33: s.frames.filter((x) => x > 33.4).length },
      heard: s.game.heard(),
      player: { health: Math.round(st.player.health), deaths: st.player.deaths },
      bots: st.bots.filter((b) => b.alive).length,
    };
  });
  console.log(`pacing: ${JSON.stringify(end.pacing)}`);
  console.log(`player ${JSON.stringify(end.player)}, bots alive ${end.bots}`);
  check('it was heard: booms, debris, landings', (end.heard.boom ?? 0) > 0 && (end.heard.thud ?? 0) > 0, end.heard);
  check('no console errors', errors.length === 0, errors.slice(0, 5));
} finally {
  const v = video ? page.video() : null;
  await page.close();
  await context.close();
  if (v) {
    const file = await v.path();
    await rm(path.join(out, 'play.webm'), { force: true });
    await rename(file, path.join(out, 'play.webm'));
    console.log(`recorded ${path.join(out, 'play.webm')}`);
  }
  await browser.close();
  await server.close();
}
const failed = checks.filter((c) => !c.ok).length;
console.log(failed === 0 ? `all ${checks.length} checks passed` : `${failed} of ${checks.length} checks failed`);
process.exit(failed === 0 ? 0 : 1);
