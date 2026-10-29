import { describe, expect, it } from 'vitest';
import { buildBuilding } from '../src/destruction/core/building';
import { findConnections } from '../src/destruction/core/connections';
import { rng } from '../src/destruction/core/math';
import type { Piece } from '../src/destruction/core/pieces';
import { BlockCholesky, BlockMatrix, kernelModuleSize } from '../src/destruction/core/sparse';
import { StrainSolver, type StepResult, type StrainOptions } from '../src/destruction/core/strain';
import { buildStructure, type StructureData } from '../src/destruction/core/structure';

/**
 * The kept factor: exact downdates, loads-only reuse, the break cap and the
 * fallen-piece bookkeeping, each checked against a solver that refactors
 * whenever the matrix changes. (The same check on the sandbox arena lives
 * with the arena, in apps/destruction/tests.)
 */

const near = (pieces: readonly Piece[], c: readonly number[], r: number): number[] =>
  pieces.filter((p) => Math.hypot(p.centroid[0] - c[0]!, p.centroid[1] - c[1]!, p.centroid[2] - c[2]!) < r).map((p) => p.id);

interface Run {
  steps: StepResult[];
  solver: StrainSolver;
}

/** Remove `doomed`, then step to rest, with `loads` (node, fy) set before the step of the same index. */
function cascade(data: StructureData, doomed: number[], options: Partial<StrainOptions> = {}, loads: Array<[number, number]> = []): Run {
  const solver = new StrainSolver(data, options);
  solver.init();
  solver.remove(doomed);
  const steps: StepResult[] = [];
  for (let i = 0; i < 300; i++) {
    const l = loads[i];
    if (l && solver.nodeAlive[l[0]]) solver.setLoad(l[0], 0, l[1], 0);
    const r = solver.step();
    steps.push(r);
    if (r.stable && i >= loads.length) return { steps, solver };
  }
  throw new Error('cascade did not settle');
}

/** Run the downdating solver and the always-refactor reference side by side; both must break the same contacts, step for step. */
function expectSameCascade(data: StructureData, doomed: number[], options: Partial<StrainOptions> = {}, loads: Array<[number, number]> = []): { steps: StepResult[]; maxDu: number; maxResidual: number } {
  const a = new StrainSolver(data, options);
  const b = new StrainSolver(data, { ...options, factorUpdate: 'refactor' });
  a.init();
  b.init();
  a.remove(doomed);
  b.remove(doomed);
  const steps: StepResult[] = [];
  let maxDu = 0;
  let maxResidual = 0;
  for (let i = 0; i < 300; i++) {
    const l = loads[i];
    if (l && a.nodeAlive[l[0]]) {
      a.setLoad(l[0], 0, l[1], 0);
      b.setLoad(l[0], 0, l[1], 0);
    }
    const ra = a.step();
    const rb = b.step();
    expect(ra.broken).toEqual(rb.broken);
    expect(ra.detached).toEqual(rb.detached);
    // A downdate the residual check had to rescue with a refactor would hide a wrong downdate.
    expect(ra.update === 'refactor' && ra.downdated > 0).toBe(false);
    for (let c = 0; c < data.connCount; c++) if (a.connAlive[c]) maxDu = Math.max(maxDu, Math.abs(a.utilization[c]! - b.utilization[c]!));
    maxResidual = Math.max(maxResidual, ra.residual);
    steps.push(ra);
    if (ra.stable && rb.stable && i >= loads.length) return { steps, maxDu, maxResidual };
  }
  throw new Error('cascade did not settle');
}

describe('sparse downdates', () => {
  /** A random SPD block system built from rank-6 "springs" between node pairs, as the strain matrix is. */
  function springs(n: number, seed: number): { K: BlockMatrix; terms: Array<{ i: number; j: number; w: Float64Array }> } {
    const random = rng(seed);
    const K = new BlockMatrix(n);
    const terms: Array<{ i: number; j: number; w: Float64Array }> = [];
    const add = (i: number, j: number): void => {
      // W (12×6): rows 0–5 at node i, 6–11 at node j. K += W Wᵀ.
      const w = Float64Array.from({ length: 72 }, () => random() - 0.5);
      const blk = (ro: number, co: number): Float64Array => {
        const out = new Float64Array(36);
        for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) for (let q = 0; q < 6; q++) out[r * 6 + c]! += w[ro + r * 6 + q]! * w[co + c * 6 + q]!;
        return out;
      };
      K.addDiag(i, blk(0, 0));
      if (j >= 0) {
        K.addDiag(j, blk(36, 36));
        K.addOff(i, j, blk(0, 36));
      }
      terms.push({ i, j, w });
    };
    for (let i = 0; i < n; i++) add(i, -1); // a ground spring on every node keeps K SPD with any edges taken out
    for (let i = 1; i < n; i++) add(i - 1, i);
    for (let k = 0; k < 3 * n; k++) {
      const i = Math.floor(random() * n);
      const j = Math.floor(random() * n);
      if (i !== j) add(i, j);
    }
    return { K, terms };
  }

  for (const kernels of [true, false]) {
    it(`takes rank-6 terms out exactly (${kernels ? 'WebAssembly' : 'JS'})`, () => {
      const n = 80;
      const { K, terms } = springs(n, 11);
      const chol = BlockCholesky.analyze(K, { kernels });
      expect(chol.usesKernels).toBe(kernels);
      expect(chol.factor(K)).toBe(-1);
      // Take out every fifth edge spring, in two batches.
      const out = terms.filter((t, k) => t.j >= 0 && k % 5 === 0);
      const reduced = springs(n, 11).K; // same terms, then subtract the removed ones
      for (const t of out) {
        const neg = new Float64Array(72);
        for (let e = 0; e < 72; e++) neg[e] = t.w[e]!;
        for (let r = 0; r < 6; r++)
          for (let c = 0; c < 6; c++) {
            let aa = 0;
            let bb = 0;
            let ab = 0;
            for (let q = 0; q < 6; q++) {
              aa += neg[r * 6 + q]! * neg[c * 6 + q]!;
              bb += neg[36 + r * 6 + q]! * neg[36 + c * 6 + q]!;
              ab += neg[r * 6 + q]! * neg[36 + c * 6 + q]!;
            }
            reduced.diag[t.i * 36 + r * 6 + c]! -= aa;
            reduced.diag[t.j * 36 + r * 6 + c]! -= bb;
            const key = Math.min(t.i, t.j) * n + Math.max(t.i, t.j);
            const blk = reduced.off.get(key)!;
            if (t.i < t.j) blk[r * 6 + c]! -= ab;
            else blk[c * 6 + r]! -= ab;
          }
      }
      for (const batch of [out.slice(0, 7), out.slice(7)]) {
        const w = new Float64Array(batch.length * 72);
        batch.forEach((t, k) => w.set(t.w, k * 72));
        expect(chol.downdate(batch.length, Int32Array.from(batch, (t) => t.i), Int32Array.from(batch, (t) => t.j), w)).toBe(true);
      }
      const random = rng(4);
      const b = Float64Array.from({ length: n * 6 }, () => random() - 0.5);
      const x = chol.solve(b);
      const r = reduced.multiply(x);
      let err = 0;
      let scale = 0;
      for (let i = 0; i < b.length; i++) {
        err = Math.max(err, Math.abs(r[i]! - b[i]!));
        scale = Math.max(scale, Math.abs(b[i]!));
      }
      expect(err / scale).toBeLessThan(1e-10);
      // And a solve that only touches a few rows agrees with the full one.
      const sparse = new Float64Array(n * 6);
      sparse.set([1, 2, 3, 4, 5, 6], 7 * 6);
      const full = chol.solve(sparse);
      const part = chol.solveSparse(sparse.slice(), [7], 1);
      const top = Math.max(...full.map(Math.abs));
      for (let i = 0; i < full.length; i++) expect(Math.abs(part[i]! - full[i]!)).toBeLessThan(1e-12 * top);
    });
  }

  it('refuses a downdate that would leave the matrix indefinite', () => {
    const { K, terms } = springs(20, 3);
    const chol = BlockCholesky.analyze(K);
    chol.factor(K);
    // A ground spring ten times stiffer than the one there: a hundred times its stiffness out.
    const t = terms[0]!;
    const w = new Float64Array(72);
    for (let e = 0; e < 36; e++) w[e] = 10 * t.w[e]!;
    expect(chol.downdate(1, [t.i], [-1], w)).toBe(false);
  });

  it('keeps the WebAssembly kernels under the 4 KB a browser compiles on its main thread', () => {
    expect(kernelModuleSize()).toBeLessThan(4096);
  });
});

describe('the kept factor', () => {
  const test = buildBuilding();
  const testData = buildStructure(test.pieces, findConnections(test.pieces));

  it('builds each element from its rank-6 factors', () => {
    const solver = new StrainSolver(testData);
    for (let c = 0; c < testData.connCount; c += 7) {
      const e = solver.element(c);
      const ground = testData.connB[c]! < 0;
      for (let i = 0; i < 6; i++)
        for (let j = 0; j < 6; j++) {
          let aa = 0;
          let ab = 0;
          let bb = 0;
          for (let q = 0; q < 6; q++) {
            aa += e.wa[i * 6 + q]! * e.wa[j * 6 + q]!;
            ab += e.wa[i * 6 + q]! * e.wb[j * 6 + q]!;
            bb += e.wb[i * 6 + q]! * e.wb[j * 6 + q]!;
          }
          const scale = Math.abs(e.kaa[i * 7]!) + Math.abs(e.kaa[j * 7]!);
          expect(Math.abs(aa - e.kaa[i * 6 + j]!) / scale).toBeLessThan(1e-12);
          if (!ground) {
            expect(Math.abs(ab - e.kab[i * 6 + j]!) / scale).toBeLessThan(1e-12);
            expect(Math.abs(bb - e.kbb[i * 6 + j]!) / scale).toBeLessThan(1e-12);
          }
        }
    }
  });

  it('re-solves a loads-only step with the kept factor', () => {
    const solver = new StrainSolver(testData);
    const ref = new StrainSolver(testData, { factorUpdate: 'refactor' });
    solver.init();
    ref.init();
    const slab = test.pieces.find((p) => p.kind === 'slab' && p.centroid[1] > 3)!.id;
    for (const fy of [-50_000, -120_000, 0]) {
      solver.setLoad(slab, 0, fy, 0);
      ref.setLoad(slab, 0, fy, 0);
      const r = solver.step();
      ref.step();
      expect(r.update).toBe('reuse');
      expect(r.timing.factorMs).toBe(0);
      for (let c = 0; c < testData.connCount; c++) expect(Math.abs(solver.utilization[c]! - ref.utilization[c]!)).toBeLessThan(1e-9);
    }
  });

  it('breaks exactly what an always-refactor solver breaks on the test building', () => {
    const scenarios = [
      near(test.pieces, [-2, 1.4, -4], 1.6), // a rocket into a ground-floor wall
      near(test.pieces, [0, 4.6, -4], 1.4), // and into the first floor
      test.pieces.filter((p) => p.min[1] < 0.01 && p.kind !== 'slab' && !(p.centroid[0] < -5 && p.centroid[2] < -3)).map((p) => p.id), // supports out
      test.pieces.filter((p) => p.min[1] < 0.01 && p.kind !== 'slab' && p.centroid[0] < -1).map((p) => p.id), // half the supports
    ];
    let downdates = 0;
    for (const doomed of scenarios) {
      const { steps, maxDu, maxResidual } = expectSameCascade(testData, doomed);
      downdates += steps.reduce((n, s) => n + s.downdated, 0);
      expect(maxDu).toBeLessThan(1e-3);
      expect(maxResidual).toBeLessThan(1e-6);
    }
    expect(downdates).toBeGreaterThan(20); // the downdates really ran
  });

  it('agrees with a fresh factor after a long run of downdates', () => {
    const { pieces, params } = buildBuilding({ floors: 5, width: 20, depth: 12, x: -10, z: -6 });
    const data = buildStructure(pieces, findConnections(pieces));
    // Most of one long wall's ground storey: a cascade of twenty-odd steps.
    const wall = pieces.filter((p) => p.min[1] < 0.01 && p.kind === 'wall' && p.centroid[2] < params.z + 0.5 && p.centroid[0] > params.x + 2).map((p) => p.id);
    const { solver, steps } = cascade(data, wall);
    const downdated = steps.reduce((n, s) => n + s.downdated, 0);
    expect(downdated).toBeGreaterThan(30);
    expect(solver.downdatesPending).toBeGreaterThan(0);
    const before = solver.utilization.slice();
    expect(solver.idle()).toBeGreaterThan(0); // rebuilt from scratch
    expect(solver.idle()).toBe(0); // and nothing owed after
    const fresh = solver.solveFull();
    expect(fresh.update).toBe('reuse');
    let du = 0;
    for (let c = 0; c < data.connCount; c++) if (solver.connAlive[c]) du = Math.max(du, Math.abs(solver.utilization[c]! - before[c]!));
    expect(du).toBeLessThan(1e-3);
    expect(fresh.residual).toBeLessThan(1e-6);
  });

  it('caps the breaks in a step and breaks the rest later, the same as the reference', () => {
    const doomed = test.pieces.filter((p) => p.min[1] < 0.01 && p.kind !== 'slab' && p.centroid[0] < -1).map((p) => p.id);
    const { steps } = expectSameCascade(testData, doomed, { maxBreaksPerStep: 3 });
    expect(Math.max(...steps.map((s) => s.broken.length))).toBeLessThanOrEqual(3);
    expect(steps.some((s) => s.spared > 0)).toBe(true);
  });

  it('gives the same answers without the WebAssembly kernels', () => {
    const doomed = near(test.pieces, [-2, 1.4, -4], 1.6);
    const wasm = cascade(testData, doomed);
    const js = cascade(testData, doomed, { kernels: false });
    expect(js.steps.map((s) => s.broken)).toEqual(wasm.steps.map((s) => s.broken));
    for (let c = 0; c < testData.connCount; c++) expect(Math.abs(js.solver.utilization[c]! - wasm.solver.utilization[c]!)).toBeLessThan(1e-9);
  });
});
