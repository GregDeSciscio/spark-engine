import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { it } from 'vitest';
import { rng } from '../../packages/engine/src/destruction/core/math';
import { BlockCholesky, kernelModuleSize, type Ordering } from '../../packages/engine/src/destruction/core/sparse';
import { DEFAULT_STRAIN, type StepResult } from '../../packages/engine/src/destruction/core/strain';
import { build, contactDowndateCosts, denseTop, histogram, insides, median, SCENARIOS, SIZES, solver, stats, type Built } from './scenarios';

/**
 * `pnpm bench:solver`: what the strain solver costs as buildings grow, warm, and
 * what real cascades cost against an always-refactor reference run in the
 * same process (so a busy machine slows both alike). Writes tools/benchmarks/solver-results.md
 * and prints it. Not part of `pnpm test`.
 */

const ms = (x: number, digits = 1): string => `${x.toFixed(digits)} ms`;
const M = (x: number): string => `${(x / 1e6).toFixed(1)}M`;

interface StepRecord {
  ms: number;
  refMs: number;
  downdated: number;
  update: StepResult['update'];
  broken: number;
  spared: number;
  removed: number;
  islands: number[];
  same: boolean;
  du: number;
  residual: number;
  refResidual: number;
}

/** One cascade, the solver and the always-refactor reference stepped side by side. */
function cascade(b: Built, doomed: number[]): { steps: StepRecord[]; idleMs: number } {
  const s = solver(b.data);
  const ref = solver(b.data, { factorUpdate: 'refactor' });
  s.remove(doomed);
  ref.remove(doomed);
  const steps: StepRecord[] = [];
  for (let k = 0; k < 400; k++) {
    const r = s.step();
    const q = ref.step();
    let du = 0;
    for (let c = 0; c < b.data.connCount; c++) if (s.connAlive[c]) du = Math.max(du, Math.abs(s.utilization[c]! - ref.utilization[c]!));
    const same = r.broken.join() === q.broken.join() && JSON.stringify(r.detached) === JSON.stringify(q.detached);
    steps.push({
      ms: r.timing.totalMs,
      refMs: q.timing.totalMs,
      downdated: r.downdated,
      update: r.update,
      broken: r.broken.length,
      spared: r.spared,
      removed: r.detached.reduce((n, i) => n + i.length, 0),
      islands: r.detached.map((i) => i.length),
      same,
      du,
      residual: r.residual,
      refResidual: q.residual,
    });
    if (r.stable && q.stable) break;
  }
  return { steps, idleMs: s.idle() };
}

it('strain solver', () => {
  const out: string[] = [];
  const cpu = cpus()[0]?.model.trim() ?? 'unknown CPU';
  out.push('# Strain solver benchmark', '');
  out.push(
    `Node ${process.version}, ${cpu}, ${new Date().toISOString().slice(0, 10)}. Warm timings are medians of repeated runs; cascades run the solver and an always-refactor reference side by side in one process. Solves and downdate rotations run in the WebAssembly kernels (${kernelModuleSize()} bytes); defaults: ${DEFAULT_STRAIN.ordering} ordering, at most ${DEFAULT_STRAIN.maxBreaksPerStep} breaks a step.`,
    '',
  );

  // Warm the JIT on the small building first, both ways.
  const small = build(SIZES[0]!);
  for (const sc of SCENARIOS) cascade(small, sc.doomed(small));

  // ---- 1. orderings: the dense top of the elimination tree ------------------------------------
  out.push('## Orderings', '');
  out.push('How big the dense top of the elimination tree is (the chain of columns from the root down to its first branching), and what a rank-6 downdate of one contact costs, for minimum degree and geometric nested dissection.', '');
  out.push('| building | chunks | contacts | ordering | order | L blocks | factor | dense top: columns / widest column / share of factor | downdate per contact: mean / max |');
  out.push('|---|---:|---:|---|---:|---:|---:|---:|---:|');
  const built = SIZES.map((size) => ({ size, b: build(size) }));
  for (const { size, b } of built) {
    for (const ordering of ['mindegree', 'nested'] as Ordering[]) {
      const chol = BlockCholesky.analyzeGraph(b.data.nodeCount, b.data.connA, b.data.connB, { ordering, coords: b.data.center });
      const top = denseTop(chol);
      const cost = stats(contactDowndateCosts(chol, b.data));
      out.push(
        `| ${size.name} | ${b.data.nodeCount} | ${b.data.connCount} | ${ordering} | ${ms(chol.stats.orderMs, 0)} | ${chol.stats.lBlocks} | ${M(chol.stats.flops)} | ${top.columns} / ${top.maxRows} / ${(top.share * 100).toFixed(0)}% | ${M(cost.mean)} / ${M(cost.max)} |`,
      );
    }
  }
  out.push('', 'Counts are multiply-adds (a rotation entry counts 3).', '');

  // ---- 2. warm per-phase costs ---------------------------------------------------------------
  out.push('## Warm costs', '');
  out.push('| building | chunks | idle refactor | full solve | loads-only step | evaluate | island detection | downdate: 1 / 2 / 16 contacts |');
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  const random = rng(17);
  for (const { size, b } of built) {
    const s = solver(b.data);
    const I = insides(s);
    const chol = I.chol;
    const refactor = median(5, () => {
      I.downdatesSinceRefactor = 1;
      return s.idle();
    });
    const rhs = new Float64Array(b.data.nodeCount * 6);
    for (let v = 0; v < b.data.nodeCount; v++) rhs[v * 6 + 1] = -b.data.mass[v]! * 9.81;
    const x = new Float64Array(rhs.length);
    const solve = median(15, () => {
      const t0 = performance.now();
      chol.solve(rhs, x);
      return performance.now() - t0;
    });
    const node = b.pieces.find((p) => p.kind === 'slab' && p.centroid[1] > 5)?.id ?? b.data.nodeCount >> 1;
    let r = 0;
    const loads = median(15, () => {
      s.setLoad(node, 0, -2000 * (1 + (r++ % 5)), 0);
      return s.step().timing.totalMs;
    });
    const evaluate = median(15, () => {
      const t0 = performance.now();
      I.evaluateAll();
      return performance.now() - t0;
    });
    const islands = median(15, () => {
      I.topologyDirty = true;
      const t0 = performance.now();
      I.detachIslands();
      return performance.now() - t0;
    });
    const vals = chol.vals.slice();
    const diag = chol.diag.slice();
    const downdate = (k: number): number =>
      median(5, () => {
        const picks: number[] = [];
        while (picks.length < k) {
          const c = Math.floor(random() * b.data.connCount);
          if (b.data.connB[c]! >= 0 && !picks.includes(c)) picks.push(c);
        }
        const node0 = new Int32Array(k);
        const node1 = new Int32Array(k);
        const w = new Float64Array(k * 72);
        picks.forEach((c, i) => {
          const e = I.element(c);
          node0[i] = b.data.connA[c]!;
          node1[i] = b.data.connB[c]!;
          w.set(e.wa, i * 72);
          w.set(e.wb, i * 72 + 36);
        });
        chol.vals.set(vals);
        chol.diag.set(diag);
        const t0 = performance.now();
        chol.downdate(k, node0, node1, w);
        return performance.now() - t0;
      });
    const dd = [1, 2, 16].map(downdate);
    chol.vals.set(vals);
    chol.diag.set(diag);
    out.push(
      `| ${size.name} | ${b.data.nodeCount} | ${ms(refactor, 0)} | ${ms(solve, 2)} | ${ms(loads, 2)} | ${ms(evaluate, 2)} | ${ms(islands, 2)} | ${dd.map((t) => t.toFixed(1)).join(' / ')} ms |`,
    );
  }
  out.push('', 'A loads-only step (a standing load changed, nothing broken) re-solves with the kept factor: a forward pass over the changed nodes\' elimination-tree paths and one backward pass. A downdate is timed on its own; a cascade step adds a loads-only step\'s worth of solve and evaluate.', '');

  // ---- 3. cascades --------------------------------------------------------------------------
  out.push('## Cascades against an always-refactor reference', '');
  out.push(SCENARIOS.map((sc) => `**${sc.name}**: ${sc.what}.`).join(' '), '');
  out.push('| building | scenario | steps | same breaks and islands every step | max Δutilization | max residual (reference) | step median / p95 / max | reference step median | whole cascade (reference) | refactors | idle refactor after |');
  out.push('|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|');
  const histograms: string[] = [];
  const byDowndates = new Map<string, number[][]>();
  for (const { size, b } of built) {
    const pooled: number[][] = [[], [], [], [], []];
    byDowndates.set(size.name, pooled);
    for (const sc of SCENARIOS) {
      const { steps, idleMs } = cascade(b, sc.doomed(b));
      const t = stats(steps.map((x) => x.ms));
      const tr = stats(steps.map((x) => x.refMs));
      const same = steps.every((x) => x.same);
      const du = Math.max(...steps.map((x) => x.du));
      const res = Math.max(...steps.map((x) => x.residual));
      const refRes = Math.max(...steps.map((x) => x.refResidual));
      const total = steps.reduce((a, x) => a + x.ms, 0);
      const refTotal = steps.reduce((a, x) => a + x.refMs, 0);
      const refactors = steps.filter((x) => x.update === 'refactor').length;
      out.push(
        `| ${size.name} | ${sc.name} | ${steps.length} | ${same ? 'yes' : '**no**'} | ${du.toExponential(1)} | ${res.toExponential(1)} (${refRes.toExponential(1)}) | ${t.median.toFixed(1)} / ${t.p95.toFixed(1)} / ${t.max.toFixed(0)} ms | ${ms(tr.median, 0)} | ${ms(total, 0)} (${ms(refTotal, 0)}) | ${refactors} | ${ms(idleMs, 0)} |`,
      );
      const islands = steps.flatMap((x) => x.islands);
      histograms.push(
        `- **${size.name}, ${sc.name}** (${steps.length} steps). Breaks a step: ${histogram(
          steps.map((x) => x.broken),
          [0, 1, 3, 9, 16, 17],
        )}; most spared by the cap in one step: ${Math.max(0, ...steps.map((x) => x.spared))}. Downdates a step: ${histogram(
          steps.map((x) => x.downdated),
          [0, 1, 3, 9, 17, 41],
        )}. Chunks cut loose a step: ${histogram(
          steps.map((x) => x.removed),
          [0, 1, 10, 100, 1000],
        )}. Island sizes: ${histogram(islands, [1, 2, 10, 100, 1000])}${islands.length ? ` (largest ${Math.max(...islands)})` : ''}.`,
      );
      for (const x of steps) {
        const bucket = x.downdated === 0 ? 0 : x.downdated <= 2 ? 1 : x.downdated <= 8 ? 2 : x.downdated <= 16 ? 3 : 4;
        if (x.update !== 'refactor') pooled[bucket]!.push(x.ms);
      }
    }
  }
  out.push('', 'Δutilization is the largest difference from the reference over the live contacts, after any step (the break offset is 1). The residual is ‖f − K u‖ / ‖f‖; the reference\'s is in brackets, since a structure about to fail is badly conditioned for any factor.', '');
  out.push('### What each cascade did', '', ...histograms, '');
  out.push('### Step time by downdates in the step', '');
  out.push('Steps from all the cascades above, refactors left out. Median / max (steps).', '');
  out.push('| building | 0 (loads only) | 1–2 | 3–8 | 9–16 | over 16 (removals) |');
  out.push('|---|---:|---:|---:|---:|---:|');
  for (const [name, pooled] of byDowndates) {
    out.push(`| ${name} | ${pooled.map((xs) => (xs.length ? `${stats(xs).median.toFixed(1)} / ${stats(xs).max.toFixed(0)} ms (${xs.length})` : '–')).join(' | ')} |`);
  }
  out.push('');

  const text = out.join('\n');
  writeFileSync(new URL('./solver-results.md', import.meta.url), text);
  process.stdout.write(`\n${text}\n`);
});
