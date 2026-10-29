#!/usr/bin/env node
/**
 * A short video of the sandbox, rendered headless on a fixed clock (so it is
 * smooth however slow the machine is): the bridge cut and swinging down, a
 * rocket into a smoke-filled room, and building A coming down. With sound:
 * every sound the sandbox played is logged on the same clock and mixed
 * offline from the camera's path (src/soundtrack.ts), at the level
 * the game plays it.
 *
 *   node tools/clip.mjs                  → captures/clip.mp4 (1280×720, 30 fps)
 *   node tools/clip.mjs --size=1920x1080 --fps=30
 *
 * Needs ffmpeg on PATH.
 */
/* global btoa -- in page.evaluate, which runs in the browser */
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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
const [width, height] = (args.size ?? '1280x720').split('x').map(Number);
const fps = Number(args.fps ?? 30);
const outDir = path.resolve(root, 'captures');
const frames = path.join(outDir, 'clip-frames');

const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', server: { port: 5392, strictPort: false, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const url = server.resolvedUrls?.local[0];
const browser = await launchBrowser(false);
await rm(frames, { recursive: true, force: true });
await mkdir(frames, { recursive: true });
try {
  const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })).newPage();
  await page.goto(`${url}?fixedclock=60&strain=inline&overlay=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__spark && (window.__spark.ready || window.__spark.error), null, { timeout: 180_000 });
  await page.evaluate(() => {
    window.__spark.engine.stop();
    document.querySelectorAll('pre').forEach((p) => (p.parentElement.style.display = 'none')); // no HUD in the film
  });
  const game = (fn, ...a) => page.evaluate(([f, x]) => window.__spark.game[f](...x), [fn, a]);
  let n = 0;
  const stepPerFrame = Math.round(60 / fps);
  /** Where the listener was each frame, for the soundtrack. */
  const ears = [];
  /** Film `seconds`, optionally moving the camera from one view to another. */
  const film = async (seconds, from, to) => {
    const count = Math.round(seconds * fps);
    for (let i = 0; i < count; i++) {
      if (from) {
        const t = to ? i / Math.max(1, count - 1) : 0;
        const e = t * t * (3 - 2 * t);
        const v = from.map((a, k) => a + ((to ?? from)[k] - a) * e);
        await game('setView', ...v);
        ears.push({ t: n / fps, x: v[0], y: v[1], z: v[2], tx: v[3], ty: v[4], tz: v[5] });
      }
      await page.evaluate((k) => window.__spark.stepFrames(k), stepPerFrame);
      await page.screenshot({ path: path.join(frames, `${String(n++).padStart(5, '0')}.png`) });
    }
  };

  // 1. The bridge: cut at A, it hangs off B, the container swings and is dragged down.
  const bridgeView = [-3, 6.8, -16, 1.5, 4.2, 0];
  await game('setView', ...bridgeView);
  await page.evaluate(() => window.__spark.stepFrames(20));
  await game('listen', true); // the film's clock starts here: frame n shows t = n / fps
  await film(0.8, bridgeView);
  await game('scenario', 'bridge-A-end');
  await film(6, bridgeView, [-6, 5.5, -14, 2, 3, 0]);

  // 2. Smoke in B's ground floor, then a rocket through the wall beside it.
  const smokeView = [5, 3.6, -14, 13, 1.6, -2];
  await game('setView', ...smokeView);
  await game('grenade', 'smoke', 13, 1, -1);
  await film(2.4, smokeView);
  await game('explode', 15.6, 1.4, -4.85, 1.6, 0, 0, -1);
  await film(3.4, smokeView, [6, 3.2, -12, 14, 1.6, -3]);

  // 3. Building A loses its ground storey.
  const downView = [-31, 9, -24, -10, 3.5, 0];
  await game('setView', ...downView);
  await film(0.6, downView);
  await game('scenario', 'A-ground');
  await film(7, downView, [-26, 6, -17, -10, 2, 0]);

  const heard = await game('heard');
  const mix = await page.evaluate(
    async ([h, e, seconds]) => {
      const { mixSoundtrack } = await import('/src/soundtrack.ts');
      const buf = await mixSoundtrack(h, e, seconds);
      const [left, right] = [buf.getChannelData(0), buf.getChannelData(1)];
      let peak = 0;
      let loudest = 0;
      const win = Math.round(buf.sampleRate * 0.4);
      let sum = 0;
      const pcm = new Int16Array(left.length * 2);
      for (let i = 0; i < left.length; i++) {
        const a = left[i];
        const b = right[i];
        peak = Math.max(peak, Math.abs(a), Math.abs(b));
        sum += a * a + b * b;
        if (i >= win) sum -= left[i - win] ** 2 + right[i - win] ** 2;
        loudest = Math.max(loudest, sum);
        pcm[i * 2] = Math.max(-32768, Math.min(32767, Math.round(a * 32767)));
        pcm[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(b * 32767)));
      }
      let bin = '';
      const bytes = new Uint8Array(pcm.buffer);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { rate: buf.sampleRate, peak, loudest: Math.sqrt(loudest / (2 * win)), pcm: btoa(bin) };
    },
    [heard, ears, n / fps],
  );
  const db = (v) => (20 * Math.log10(Math.max(v, 1e-9))).toFixed(1);
  const counts = {};
  for (const h of heard) counts[h.name] = (counts[h.name] ?? 0) + 1;
  console.log(`sounds heard: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  console.log(`soundtrack: peak ${db(mix.peak)} dBFS, loudest 0.4 s ${db(mix.loudest)} dBFS RMS`);
  await writeFile(path.join(outDir, 'clip.wav'), wav(Buffer.from(mix.pcm, 'base64'), mix.rate));
  // What played when, where and how loud, beside the camera's path: for reading the mix against the picture.
  await writeFile(path.join(outDir, 'clip-sounds.json'), JSON.stringify({ heard, ears }));
} finally {
  await browser.close();
  await server.close();
}
const out = path.join(outDir, 'clip.mp4');
// prettier-ignore
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frames, '%05d.png'), '-i', path.join(outDir, 'clip.wav'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out]);
await rm(frames, { recursive: true, force: true });
console.log(`wrote ${path.relative(root, out)}`);

/** 16-bit stereo PCM as a WAV file. */
function wav(pcm, rate) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(2, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}
