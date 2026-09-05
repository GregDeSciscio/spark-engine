#!/usr/bin/env node
/**
 * Generate the launcher menu's scene thumbnails.
 *
 *   pnpm thumbnails [--scene=alley] [--quality=80] [--size=640x360]
 *
 * Reuses the capture harness: each scene boots on the fixed clock, steps the
 * same frame count its visual golden uses (so the pile has settled and the
 * particles have spawned), and the canvas is written as a JPEG into
 * `apps/benchmark/public/thumbs/`. The `showcase` entry is the showcase app
 * itself (served from apps/showcase), shot in free look at its spawn. JPEG rather than PNG because these ship in
 * the bundle — the goldens are 160 KB–1 MB each, which is not menu material.
 *
 * Re-run it whenever a scene's look changes; the images are committed.
 */
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, parseArgs, startServer } from './capture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const OUT_DIR = path.join(repoRoot, 'apps', 'benchmark', 'public', 'thumbs');

/**
 * Frames to step before the shot, mirroring tests/visual/manifest.json so a
 * thumbnail shows the same settled moment its golden does.
 */
const SCENES = [
  { scene: 'showcase', app: 'showcase', preset: 'high', frames: 120, params: { freelook: '1' } },
  { scene: 'alley', preset: 'high', frames: 30 },
  { scene: 'lights', preset: 'high', frames: 60 },
  { scene: 'hud', preset: 'high', frames: 90 },
  { scene: 'streaming', preset: 'high', frames: 240 },
  { scene: 'physics', preset: 'high', frames: 120 },
  { scene: 'vfx', preset: 'high', frames: 90 },
  { scene: 'animation', preset: 'high', frames: 90 },
  { scene: 'entities', preset: 'high', frames: 30 },
  { scene: 'assets', preset: 'high', frames: 30 },
  { scene: 'bootstrap', preset: 'high', frames: 30 },
];

async function shoot(browser, baseUrl, entry, { width, height, quality }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  const params = new URLSearchParams({
    backend: 'webgpu',
    preset: entry.preset,
    fixedclock: '60',
    paused: '1',
    size: `${width}x${height}`,
    seed: '1',
    overlay: '0',
    ...(entry.app ? {} : { scene: entry.scene }),
    ...(entry.params ?? {}),
  });
  await page.goto(`${baseUrl}?${params}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__spark && (window.__spark.ready || window.__spark.error), null, {
    timeout: 120_000,
  });
  const bootError = await page.evaluate(() => window.__spark?.error ?? null);
  if (bootError) {
    await context.close();
    return { scene: entry.scene, ok: false, reason: bootError };
  }

  await page.evaluate((n) => window.__spark.stepFrames(n), entry.frames);

  // Playwright's element screenshot captures the page region, so any DOM sitting
  // over the canvas is baked in. Scenes append their own debug readouts there and
  // several do not honour `overlay=0` (see the note at the bottom of this file),
  // which is menu noise. Hide those, but keep the engine's UI host: in `hud` the
  // panel and world labels are the thing being demonstrated.
  await page.addStyleTag({
    content: '#app > *:not(canvas):not([data-spark-ui]) { display: none !important; }',
  });

  const file = path.join(OUT_DIR, `${entry.scene}.jpg`);
  await page.locator('canvas[data-spark-canvas]').screenshot({
    path: file,
    type: 'jpeg',
    quality,
    animations: 'disabled',
  });
  await context.close();
  const { size } = await stat(file);
  return { scene: entry.scene, ok: true, file, bytes: size, errors };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [width, height] = (args.size ?? '640x360').split('x').map(Number);
  const quality = Number(args.quality ?? 80);
  const only = args.scene;
  const wanted = only ? SCENES.filter((s) => s.scene === only) : SCENES;
  if (wanted.length === 0) throw new Error(`unknown scene "${only}"`);

  await mkdir(OUT_DIR, { recursive: true });
  const servers = new Map();
  const serve = async (app) => {
    if (!servers.has(app)) servers.set(app, await startServer(0, app));
    return servers.get(app).url;
  };
  const browser = await launchBrowser(false);
  const results = [];
  try {
    for (const entry of wanted) {
      const result = await shoot(browser, await serve(entry.app ?? 'benchmark'), entry, { width, height, quality });
      results.push(result);
      if (result.ok) {
        console.log(`${result.scene.padEnd(10)} ${String(Math.round(result.bytes / 1024)).padStart(4)} KB  ${path.relative(repoRoot, result.file)}`);
      } else {
        console.error(`${result.scene.padEnd(10)} FAILED: ${result.reason}`);
      }
    }
  } finally {
    await browser.close();
    for (const { server } of servers.values()) await server.close();
  }

  const files = await readdir(OUT_DIR);
  const total = (
    await Promise.all(files.map(async (f) => (await stat(path.join(OUT_DIR, f))).size))
  ).reduce((a, b) => a + b, 0);
  console.log(`\n${results.filter((r) => r.ok).length}/${wanted.length} thumbnails, ${Math.round(total / 1024)} KB total in ${path.relative(repoRoot, OUT_DIR)}`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/*
 * Known issue this works around: only `streaming.ts` and `lights.ts` gate their
 * DOM readout on `ctx.config.debugOverlay`. `vfx.ts`, `animation.ts` and the
 * audio note in `hud.ts` do not, so their text is composited into every
 * `overlay=0` capture — including the committed visual goldens. The fix is the
 * one-liner those two scenes already use:
 *
 *   if (!ctx.config.debugOverlay) note.style.display = 'none';
 *
 * It changes rendered output, so the affected goldens need `pnpm visual --update`
 * in the same change. Left alone here to keep thumbnails from touching baselines.
 */
