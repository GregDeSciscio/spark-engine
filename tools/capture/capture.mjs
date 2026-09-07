#!/usr/bin/env node
/**
 * Headless capture: boot a benchmark scene, step a fixed number of frames on a
 * fixed clock, screenshot the canvas, and dump stats + console to JSON.
 *
 *   pnpm capture --scene=bootstrap [--backend=webgpu|webgl|both] [--preset=high]
 *                [--frames=30] [--size=1280x720] [--out=tools/capture/out]
 *                [--headed] [--allow-errors] [--seed=1]
 *
 * Exit code 1 if the scene failed to boot, or if any console error / warning
 * appeared and --allow-errors was not given. This is the agent verification loop.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) args[raw.slice(2)] = true;
    else args[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return args;
}

/**
 * Verified on Windows 11 + NVIDIA with Playwright 1.62 / Chromium 1234:
 * the default "chromium_headless_shell" has no GPU at all, so we launch the
 * full Chromium (`channel: 'chromium'`) in headless mode. D3D11 ANGLE gives a
 * real WebGPU adapter; Vulkan and SwiftShader reported "No available adapters".
 */
export const CHROMIUM_ARGS = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'];
export const CHROMIUM_CHANNEL = 'chromium';

export async function startServer(port = 0, app = 'benchmark') {
  const server = await createServer({
    root: path.join(repoRoot, 'apps', app),
    configFile: path.join(repoRoot, 'apps', app, 'vite.config.ts'),
    logLevel: 'error',
    server: { port: port || 4900 + Math.floor(Math.random() * 100), strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('vite did not report a local URL');
  return { server, url };
}

export async function launchBrowser(headed = false) {
  return chromium.launch({ headless: !headed, channel: CHROMIUM_CHANNEL, args: CHROMIUM_ARGS });
}

/**
 * Capture one scene/backend/preset combination on an already-open browser.
 * Returns the result record; writes PNG + JSON under `outDir`.
 */
export async function captureOne(browser, baseUrl, options) {
  const { scene, backend, preset, frames, width, height, seed, outDir, label } = options;
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning' || type === 'warn') {
      consoleMessages.push({ type, text: msg.text() });
    }
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  const params = new URLSearchParams({
    scene,
    backend,
    preset,
    fixedclock: '60',
    paused: '1',
    size: `${width}x${height}`,
    seed: String(seed),
    overlay: '0',
  });
  const url = `${baseUrl}?${params.toString()}`;
  const started = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__spark && (window.__spark.ready || window.__spark.error), null, {
    timeout: 60_000,
  });
  const bootError = await page.evaluate(() => window.__spark?.error ?? null);
  let snapshot = null;
  let logs = [];
  let actualBackend = null;
  let capabilities = null;
  if (!bootError) {
    capabilities = await page.evaluate(() => window.__spark.capabilities());
    await page.evaluate((n) => window.__spark.stepFrames(n), frames);
    await page.evaluate(() => window.__spark.flushGpuTimers());
    snapshot = await page.evaluate(() => window.__spark.snapshot());
    logs = await page.evaluate(() => window.__spark.logs());
    actualBackend = await page.evaluate(() => window.__spark.backend);
  }

  await mkdir(outDir, { recursive: true });
  const name = label ?? `${scene}-${backend}-${preset}`;
  const pngPath = path.join(outDir, `${name}.png`);
  const jsonPath = path.join(outDir, `${name}.json`);
  if (!bootError) {
    await page.locator('canvas[data-spark-canvas]').screenshot({ path: pngPath, animations: 'disabled' });
  }
  const result = {
    scene,
    requestedBackend: backend,
    backend: actualBackend,
    capabilities,
    preset,
    frames,
    size: { width, height },
    seed,
    bootError,
    snapshot,
    logs,
    console: consoleMessages,
    pageErrors,
    elapsedMs: Date.now() - started,
    machine: machineInfo(snapshot),
    png: bootError ? null : path.relative(repoRoot, pngPath),
    capturedAt: new Date().toISOString(),
  };
  await writeFile(jsonPath, JSON.stringify(result, null, 2));
  await context.close();
  return result;
}

export function machineInfo() {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    cpus: os.cpus()[0]?.model ?? 'unknown',
  };
}

export function isClean(result) {
  return !result.bootError && result.pageErrors.length === 0 && result.console.length === 0 && result.logs.length === 0;
}

export function summarize(result) {
  const s = result.snapshot;
  const head = `${result.scene} [${result.backend ?? 'boot failed'}/${result.preset}]`;
  if (result.bootError) return `${head}: BOOT ERROR ${result.bootError}`;
  const stats = s
    ? `draws=${s.drawCalls} tris=${s.triangles} cpu=${s.cpuMs.toFixed(2)}ms gpu=${s.gpuMs === null ? 'n/a' : s.gpuMs.toFixed(2) + 'ms'} ${s.width}x${s.height}`
    : 'no snapshot';
  const issues = result.pageErrors.length + result.console.length + result.logs.length;
  return `${head}: ${stats}${issues ? ` ISSUES=${issues}` : ' clean'} -> ${result.png}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scene = String(args.scene ?? 'bootstrap');
  const backendArg = String(args.backend ?? 'webgpu');
  const backends = backendArg === 'both' ? ['webgpu', 'webgl'] : [backendArg];
  const preset = String(args.preset ?? 'high');
  const frames = Number(args.frames ?? 30);
  const [width, height] = String(args.size ?? '1280x720')
    .split('x')
    .map(Number);
  const seed = Number(args.seed ?? 1);
  const outDir = path.resolve(repoRoot, String(args.out ?? 'tools/capture/out'));
  const headed = Boolean(args.headed);
  const allowErrors = Boolean(args['allow-errors']);
  // `--app=showcase` captures the game rather than a benchmark scene; the
  // showcase boots its one mission and ignores `--scene`.
  const app = String(args.app ?? 'benchmark');
  const label = args.label ? String(args.label) : undefined;

  const { server, url } = await startServer(0, app);
  const browser = await launchBrowser(headed);
  let failed = false;
  try {
    for (const backend of backends) {
      const result = await captureOne(browser, url, { scene, backend, preset, frames, width, height, seed, outDir, label });
      console.log(summarize(result));
      for (const e of result.pageErrors) console.log(`  pageerror: ${e}`);
      for (const c of result.console) console.log(`  console.${c.type}: ${c.text}`);
      for (const l of result.logs) console.log(`  log.${l.level} [${l.scope}]: ${l.message}`);
      if (!isClean(result) && !allowErrors) failed = true;
      if (result.bootError) failed = true;
    }
  } finally {
    await browser.close();
    await server.close();
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
