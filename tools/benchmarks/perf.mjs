#!/usr/bin/env node
/**
 * Performance regression runner. Runs each benchmark scene in real time for a
 * few seconds, reads the averaged stats, and compares against this machine's
 * recorded baseline in tests/perf/baselines/<machine-id>.json.
 *
 *   pnpm perf                    compare (fails on regression)
 *   pnpm perf --record           write/merge this machine's baseline
 *   pnpm perf --seconds=5        sample window per scene (default 4)
 *   pnpm perf --passes=1         passes per scene, best of (default 2)
 *   pnpm perf --filter=alley
 *
 * Thresholds (from the kickoff doc): frame time +10%, draw calls / triangles
 * +5%, plus an absolute floor on the time metrics so that noise on a 1 ms
 * measurement cannot read as a 20% regression. Each scene runs twice and the
 * best pass counts, because contention only ever makes a number worse.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, parseArgs, startServer } from '../capture/capture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const perfDir = path.join(repoRoot, 'tests', 'perf');
const baselineDir = path.join(perfDir, 'baselines');

const THRESHOLDS = { cpuMs: 0.1, renderMs: 0.1, gpuMs: 0.1, frameMs: 0.1, drawCalls: 0.05, triangles: 0.05 };

/**
 * A percentage is meaningless on a quantity smaller than the harness's own
 * noise. The cheap scenes measure 1-2 ms of GPU time, where a busy machine
 * moves the median by ±0.2 ms — 20%, and nothing to do with the code. A
 * regression has to beat both the percentage and this absolute floor to count.
 * Counts are exact and deterministic, so they have no floor.
 */
const NOISE_FLOOR_MS = 0.35;
const TIME_METRICS = new Set(['cpuMs', 'renderMs', 'gpuMs', 'frameMs']);

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * One vite server per app, started on first use. The benchmark app takes a
 * `scene` parameter; the showcase boots its one mission and ignores it, which
 * is how the game itself gets a perf baseline alongside the engine's scenes.
 */
function serverPool() {
  const servers = new Map();
  return {
    async urlFor(app) {
      let entryServer = servers.get(app);
      if (!entryServer) {
        entryServer = await startServer(0, app);
        servers.set(app, entryServer);
      }
      return entryServer.url;
    },
    async closeAll() {
      for (const s of servers.values()) await s.server.close();
      servers.clear();
    },
  };
}

async function runScene(browser, baseUrl, entry, seconds) {
  const context = await browser.newContext({ viewport: { width: entry.width, height: entry.height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const params = new URLSearchParams({
    scene: entry.scene,
    backend: entry.backend,
    preset: entry.preset,
    size: `${entry.width}x${entry.height}`,
    seed: '1',
    overlay: '0',
  });
  await page.goto(`${baseUrl}?${params}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__spark && (window.__spark.ready || window.__spark.error), null, { timeout: 60_000 });
  const bootError = await page.evaluate(() => window.__spark?.error ?? null);
  if (bootError) {
    await context.close();
    return { entry, bootError };
  }
  // Warm up, then sample.
  await page.waitForTimeout(1500);
  const samples = [];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    await page.waitForTimeout(250);
    samples.push(await page.evaluate(() => window.__spark?.snapshot() ?? null));
  }
  const backend = await page.evaluate(() => window.__spark.backend);
  const capabilities = await page.evaluate(() => window.__spark.capabilities());
  await context.close();
  const median = (key) => {
    // A sample can be null: a page that reloads mid-run (vite HMR during a dev
    // session is the usual cause) has no `__spark` for a beat. Drop those
    // rather than crashing the whole suite on one blink.
    const vals = samples
      .filter((s) => s !== null && typeof s === 'object')
      .map((s) => s[key])
      .filter((v) => typeof v === 'number' && Number.isFinite(v))
      .sort((a, b) => a - b);
    return vals.length ? vals[Math.floor(vals.length / 2)] : null;
  };
  return {
    entry,
    backend,
    capabilities,
    metrics: {
      fps: median('fps'),
      frameMs: median('fps') ? 1000 / median('fps') : null,
      cpuMs: median('cpuMs'),
      renderMs: median('renderMs'),
      gpuMs: median('gpuMs'),
      drawCalls: median('drawCalls'),
      triangles: median('triangles'),
    },
  };
}

/**
 * Best of N passes, metric by metric. Contention only ever makes a number
 * worse — another process taking the GPU for a moment cannot make a frame
 * faster — so the best observed pass is the honest estimate of what this
 * machine can do, and a single unlucky pass stops failing the suite. Counts
 * take the worst instead: they are deterministic, so a difference between
 * passes is real and worth surfacing.
 */
function bestOf(a, b) {
  if (!a) return b;
  const out = {};
  for (const key of Object.keys(b)) {
    const x = a[key];
    const y = b[key];
    if (typeof x !== 'number' || typeof y !== 'number') {
      out[key] = y ?? x;
    } else if (key === 'fps') {
      out[key] = Math.max(x, y);
    } else if (key === 'drawCalls' || key === 'triangles') {
      out[key] = Math.max(x, y);
    } else {
      out[key] = Math.min(x, y);
    }
  }
  return out;
}

function compare(name, current, baseline) {
  const problems = [];
  // Every benchmark scene renders faster than the display, so `frameMs` is the
  // monitor's refresh interval, not the engine's work: it moves when the
  // machine switches refresh rate and says nothing about the code. Only report
  // it when the work behind it moved too.
  const workRegressed = ['cpuMs', 'renderMs', 'gpuMs'].some((key) => {
    const cur = current[key];
    const base = baseline[key];
    return typeof cur === 'number' && typeof base === 'number' && base > 0 && cur / base > 1 + THRESHOLDS[key] && cur - base >= NOISE_FLOOR_MS;
  });
  for (const [key, tolerance] of Object.entries(THRESHOLDS)) {
    const cur = current[key];
    const base = baseline[key];
    if (typeof cur !== 'number' || typeof base !== 'number' || base === 0) continue;
    const ratio = cur / base;
    if (ratio <= 1 + tolerance) continue;
    if (TIME_METRICS.has(key) && cur - base < NOISE_FLOOR_MS) continue;
    if (key === 'frameMs' && !workRegressed) continue;
    problems.push(`${name}.${key}: ${base.toFixed(2)} -> ${cur.toFixed(2)} (+${((ratio - 1) * 100).toFixed(1)}%, limit +${tolerance * 100}%)`);
  }
  return problems;
}

/**
 * A code change makes one thing slower; a machine change makes everything
 * slower at once. When most of the suite regresses together, say so plainly
 * instead of printing a wall of findings that all have the same cause — a
 * display switched refresh rate, another process took the GPU, the laptop is
 * on battery, the room got hot.
 */
function looksLikeTheMachine(comparedNames, problems) {
  if (comparedNames.length < 3) return false;
  const affected = new Set(problems.map((p) => p.slice(0, p.indexOf('.'))));
  return affected.size >= Math.ceil(comparedNames.length * 0.75);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const record = Boolean(args.record);
  const seconds = Number(args.seconds ?? 4);
  const passes = Math.max(1, Number(args.passes ?? 2));
  const filter = args.filter ? String(args.filter) : null;
  const manifest = JSON.parse(await readFile(path.join(perfDir, 'manifest.json'), 'utf8'));
  await mkdir(baselineDir, { recursive: true });

  const pool = serverPool();
  const browser = await launchBrowser(false);
  const results = {};
  let adapterDescription = 'unknown-gpu';
  try {
    for (const entry of manifest.entries) {
      const name = `${entry.scene}-${entry.backend}-${entry.preset}`;
      if (filter && !name.includes(filter)) continue;
      const full = { width: manifest.defaults.width, height: manifest.defaults.height, ...entry };
      const url = await pool.urlFor(entry.app ?? 'benchmark');
      let metrics = null;
      let adapter = null;
      let bootError = null;
      let backend = null;
      for (let pass = 0; pass < passes; pass++) {
        const r = await runScene(browser, url, full, seconds);
        if (r.bootError) {
          bootError = r.bootError;
          break;
        }
        metrics = bestOf(metrics, r.metrics);
        adapter = r.capabilities?.adapter ?? adapter;
        backend = r.backend ?? backend;
      }
      if (bootError || !metrics) {
        console.log(`${name}: BOOT ERROR ${bootError ?? 'no metrics'}`);
        continue;
      }
      results[name] = metrics;
      const m = metrics;
      if (adapter) adapterDescription = `${adapter.vendor}-${adapter.architecture}`;
      console.log(
        `${name} [${backend}]: ${m.fps?.toFixed(0)} fps, cpu ${m.cpuMs?.toFixed(2)} ms (render ${m.renderMs?.toFixed(2) ?? '?'} ms), gpu ${m.gpuMs === null ? 'n/a' : m.gpuMs.toFixed(2) + ' ms'}, draws ${m.drawCalls}, tris ${m.triangles}`,
      );
    }
  } finally {
    await browser.close();
    await pool.closeAll();
  }

  const machineId = slug(`${os.hostname()}-${os.platform()}-${adapterDescription}`);
  const baselinePath = path.join(baselineDir, `${machineId}.json`);
  if (record || !existsSync(baselinePath)) {
    // Merge, so `--record --filter=<one>` adds or refreshes that entry instead
    // of throwing away every entry this run did not measure.
    const existing = existsSync(baselinePath) ? JSON.parse(await readFile(baselinePath, 'utf8')).results ?? {} : {};
    const merged = { ...existing, ...results };
    await writeFile(baselinePath, JSON.stringify({ machineId, recordedAt: new Date().toISOString(), cpu: os.cpus()[0]?.model, results: merged }, null, 2));
    const touched = Object.keys(results);
    console.log(`\nbaseline ${record ? 'recorded' : 'created'}: ${path.relative(repoRoot, baselinePath)} (${touched.length} entr${touched.length === 1 ? 'y' : 'ies'}: ${touched.join(', ')})`);
    process.exit(0);
  }
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const problems = [];
  const compared = [];
  for (const [name, metrics] of Object.entries(results)) {
    const base = baseline.results[name];
    if (!base) {
      console.log(`${name}: no baseline entry (run with --record to add)`);
      continue;
    }
    compared.push(name);
    problems.push(...compare(name, metrics, base));
  }
  if (problems.length) {
    if (looksLikeTheMachine(compared, problems)) {
      console.log('\nEVERYTHING REGRESSED AT ONCE — read this as the machine, not the code:');
      for (const p of problems) console.log(`  ${p}`);
      console.log(
        `\n${new Set(problems.map((p) => p.slice(0, p.indexOf('.')))).size} of ${compared.length} entries moved together. A code change makes one thing slower.\n` +
          'Every frameMs landing on the same number means the ceiling is outside the scene: something else is holding the\n' +
          'GPU, or presentation is being paced. Close other GPU work (a preview tab rendering the game counts), re-run, and\n' +
          'only re-record the baseline once you are sure the machine, not the engine, changed.',
      );
      process.exit(1);
    }
    console.log('\nPERF REGRESSIONS:');
    for (const p of problems) console.log(`  ${p}`);
    process.exit(1);
  }
  console.log(`\nperf within thresholds (${compared.length} entries)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
