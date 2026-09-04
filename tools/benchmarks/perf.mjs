#!/usr/bin/env node
/**
 * Performance regression runner. Runs each benchmark scene in real time for a
 * few seconds, reads the averaged stats, and compares against this machine's
 * recorded baseline in tests/perf/baselines/<machine-id>.json.
 *
 *   pnpm perf                    compare (fails on regression)
 *   pnpm perf --record           write/overwrite this machine's baseline
 *   pnpm perf --seconds=5        sample window per scene (default 4)
 *   pnpm perf --filter=alley
 *
 * Thresholds (from the kickoff doc): frame time +10%, draw calls / triangles +5%.
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

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
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
    samples.push(await page.evaluate(() => window.__spark.snapshot()));
  }
  const backend = await page.evaluate(() => window.__spark.backend);
  const capabilities = await page.evaluate(() => window.__spark.capabilities());
  await context.close();
  const median = (key) => {
    const vals = samples.map((s) => s[key]).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
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

function compare(name, current, baseline) {
  const problems = [];
  for (const [key, tolerance] of Object.entries(THRESHOLDS)) {
    const cur = current[key];
    const base = baseline[key];
    if (typeof cur !== 'number' || typeof base !== 'number' || base === 0) continue;
    const ratio = cur / base;
    if (ratio > 1 + tolerance) {
      problems.push(`${name}.${key}: ${base.toFixed(2)} -> ${cur.toFixed(2)} (+${((ratio - 1) * 100).toFixed(1)}%, limit +${tolerance * 100}%)`);
    }
  }
  return problems;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const record = Boolean(args.record);
  const seconds = Number(args.seconds ?? 4);
  const filter = args.filter ? String(args.filter) : null;
  const manifest = JSON.parse(await readFile(path.join(perfDir, 'manifest.json'), 'utf8'));
  await mkdir(baselineDir, { recursive: true });

  const { server, url } = await startServer();
  const browser = await launchBrowser(false);
  const results = {};
  let adapterDescription = 'unknown-gpu';
  try {
    for (const entry of manifest.entries) {
      const name = `${entry.scene}-${entry.backend}-${entry.preset}`;
      if (filter && !name.includes(filter)) continue;
      const full = { width: manifest.defaults.width, height: manifest.defaults.height, ...entry };
      const r = await runScene(browser, url, full, seconds);
      if (r.bootError) {
        console.log(`${name}: BOOT ERROR ${r.bootError}`);
        continue;
      }
      results[name] = r.metrics;
      const m = r.metrics;
      const adapter = r.capabilities?.adapter;
      if (adapter) adapterDescription = `${adapter.vendor}-${adapter.architecture}`;
      console.log(
        `${name} [${r.backend}]: ${m.fps?.toFixed(0)} fps, cpu ${m.cpuMs?.toFixed(2)} ms (render ${m.renderMs?.toFixed(2) ?? '?'} ms), gpu ${m.gpuMs === null ? 'n/a' : m.gpuMs.toFixed(2) + ' ms'}, draws ${m.drawCalls}, tris ${m.triangles}`,
      );
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const machineId = slug(`${os.hostname()}-${os.platform()}-${adapterDescription}`);
  const baselinePath = path.join(baselineDir, `${machineId}.json`);
  if (record || !existsSync(baselinePath)) {
    await writeFile(baselinePath, JSON.stringify({ machineId, recordedAt: new Date().toISOString(), cpu: os.cpus()[0]?.model, results }, null, 2));
    console.log(`\nbaseline ${record ? 'recorded' : 'created'}: ${path.relative(repoRoot, baselinePath)}`);
    process.exit(0);
  }
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const problems = [];
  for (const [name, metrics] of Object.entries(results)) {
    const base = baseline.results[name];
    if (!base) {
      console.log(`${name}: no baseline entry (run with --record to add)`);
      continue;
    }
    problems.push(...compare(name, metrics, base));
  }
  if (problems.length) {
    console.log('\nPERF REGRESSIONS:');
    for (const p of problems) console.log(`  ${p}`);
    process.exit(1);
  }
  console.log('\nperf within thresholds');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
