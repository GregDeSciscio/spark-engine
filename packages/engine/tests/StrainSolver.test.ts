import { describe, expect, it } from 'vitest';
import { buildBuilding } from '../src/destruction/core/building';
import { findConnections, GROUND } from '../src/destruction/core/connections';
import { fractureRect } from '../src/destruction/core/fracture';
import { polygonArea, rng, type P2, type V3 } from '../src/destruction/core/math';
import { prism, type Piece } from '../src/destruction/core/pieces';
import { BlockCholesky, BlockMatrix } from '../src/destruction/core/sparse';
import { StrainSolver } from '../src/destruction/core/strain';
import { buildStructure } from '../src/destruction/core/structure';

const G = 9.81;

/** An axis-aligned box as a piece. */
function box(id: number, min: V3, max: V3, density = 1000): Piece {
  const w = max[0] - min[0];
  const h = max[1] - min[1];
  const poly: P2[] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  return prism({ id, element: id, kind: 'wall', poly, frame: { origin: min, u: [1, 0, 0], v: [0, 1, 0] }, thickness: max[2] - min[2], width: w, height: h, minus: 'outer', plus: 'inner', density });
}

/** Run the cascade to rest; returns the steps it took. */
function settle(solver: StrainSolver, maxSteps = 80): number {
  for (let i = 1; i <= maxSteps; i++) if (solver.step().stable) return i;
  throw new Error('cascade did not settle');
}

describe('fracture', () => {
  it('partitions the rectangle into convex counter-clockwise cells', () => {
    const cells = fractureRect(3, 2.6, 0.7, rng(3));
    expect(cells.length).toBeGreaterThan(10);
    const total = cells.reduce((s, c) => s + polygonArea(c), 0);
    expect(total).toBeCloseTo(3 * 2.6, 6);
    for (const cell of cells) {
      expect(polygonArea(cell)).toBeGreaterThan(0);
      for (let i = 0; i < cell.length; i++) {
        const a = cell[i]!;
        const b = cell[(i + 1) % cell.length]!;
        const c = cell[(i + 2) % cell.length]!;
        const turn = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        expect(turn).toBeGreaterThan(-1e-9);
      }
    }
  });

  it('is deterministic for a seed', () => {
    expect(fractureRect(2, 2, 0.5, rng(9))).toEqual(fractureRect(2, 2, 0.5, rng(9)));
  });
});

describe('connections', () => {
  it('glues stacked boxes face to face and anchors the bottom one', () => {
    const pieces = [box(0, [0, 0, 0], [1, 1, 1]), box(1, [0, 1, 0], [1, 2, 1]), box(2, [0.5, 2, 0], [1.5, 3, 1])];
    const conns = findConnections(pieces);
    const pairs = conns.map((c) => [c.a, c.b, Number(c.area.toFixed(4))]);
    expect(pairs).toContainEqual([0, 1, 1]);
    expect(pairs).toContainEqual([1, 2, 0.5]);
    expect(pairs).toContainEqual([0, GROUND, 1]);
    expect(conns).toHaveLength(3);
  });

  it('connects every chunk of the test building and grounds the ground floor', () => {
    const { pieces } = buildBuilding();
    const conns = findConnections(pieces);
    const touched = new Set<number>();
    for (const c of conns) {
      touched.add(c.a);
      if (c.b >= 0) touched.add(c.b);
    }
    expect(touched.size).toBe(pieces.length);
    for (const c of conns.filter((k) => k.b === GROUND)) expect(pieces[c.a]!.min[1]).toBeCloseTo(0, 6);
  });
});

describe('sparse Cholesky', () => {
  it('solves a random SPD block system to a tiny residual', () => {
    const n = 60;
    const random = rng(5);
    const K = new BlockMatrix(n);
    const spd = (): Float64Array => {
      // MᵀM + 6I is symmetric positive definite.
      const m = Array.from({ length: 36 }, () => random() - 0.5);
      const out = new Float64Array(36);
      for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
        let s = i === j ? 6 : 0;
        for (let k = 0; k < 6; k++) s += m[k * 6 + i]! * m[k * 6 + j]!;
        out[i * 6 + j] = s;
      }
      return out;
    };
    // Each edge adds a PSD 12×12 term [S −S; −S S], so K stays SPD with the diagonal shift.
    const edge = (i: number, j: number): void => {
      const s = spd();
      K.addDiag(i, s);
      K.addDiag(j, s);
      K.addOff(i, j, s.map((v) => -v));
    };
    for (let i = 0; i < n; i++) K.addDiag(i, spd());
    for (let i = 1; i < n; i++) edge(i - 1, i);
    for (let k = 0; k < 80; k++) {
      const i = Math.floor(random() * n);
      const j = Math.floor(random() * n);
      if (i !== j) edge(i, j);
    }
    const chol = BlockCholesky.analyze(K);
    expect(chol.factor(K)).toBe(-1);
    const b = Float64Array.from({ length: n * 6 }, () => random() - 0.5);
    const x = chol.solve(b);
    const r = K.multiply(x);
    let err = 0;
    for (let i = 0; i < b.length; i++) err = Math.max(err, Math.abs(r[i]! - b[i]!));
    expect(err).toBeLessThan(1e-9);
  });
});

describe('strain statics', () => {
  it('carries a column stack’s whole weight in compression at the ground', () => {
    const pieces = [box(0, [0, 0, 0], [1, 1, 1]), box(1, [0, 1, 0], [1, 2, 1]), box(2, [0, 2, 0], [1, 3, 1])];
    const conns = findConnections(pieces);
    const solver = new StrainSolver(buildStructure(pieces, conns));
    solver.init();
    const ground = conns.find((c) => c.b === GROUND)!;
    const loads = solver.loads(ground.id);
    expect(loads.axial).toBeCloseTo(-3 * 1000 * G, 3);
    expect(loads.shear).toBeLessThan(1e-6);
    expect(loads.bending).toBeLessThan(1e-6);
  });

  it('puts the textbook shear and moment through a cantilever root', () => {
    // A 2 m column with three 1 m cubes sticking out sideways from its top half.
    const pieces = [
      box(0, [0, 0, 0], [1, 2, 1]),
      box(1, [1, 1, 0], [2, 2, 1]),
      box(2, [2, 1, 0], [3, 2, 1]),
      box(3, [3, 1, 0], [4, 2, 1]),
    ];
    const conns = findConnections(pieces);
    const solver = new StrainSolver(buildStructure(pieces, conns));
    solver.init();
    const root = conns.find((c) => c.a === 0 && c.b === 1)!;
    const W = 1000 * G;
    const loads = solver.loads(root.id);
    expect(loads.shear).toBeCloseTo(3 * W, 2);
    expect(loads.bending).toBeCloseTo(W * (0.5 + 1.5 + 2.5), 1);
    // σ = M c / I for a 1×1 patch: c = 0.5, I = 1/12.
    expect(loads.bendingStress).toBeCloseTo((4.5 * W * 0.5) / (1 / 12), 0);
    const tip = conns.find((c) => c.a === 2 && c.b === 3)!;
    expect(solver.loads(tip.id).bending).toBeCloseTo(0.5 * W, 1);
  });

  it('drops a chunk whose only connection is cut', () => {
    const pieces = [box(0, [0, 0, 0], [1, 1, 1]), box(1, [0, 1, 0], [1, 2, 1])];
    const solver = new StrainSolver(buildStructure(pieces, findConnections(pieces)));
    solver.init();
    solver.remove([0]);
    const r = solver.step();
    expect(r.detached.flat()).toContain(1);
  });
});

describe('the test building', () => {
  const setup = (): { solver: StrainSolver; pieces: Piece[] } => {
    const { pieces } = buildBuilding();
    const solver = new StrainSolver(buildStructure(pieces, findConnections(pieces)));
    solver.init();
    return { solver, pieces };
  };
  const blast = (pieces: Piece[], center: V3, radius: number): number[] =>
    pieces.filter((p) => Math.hypot(p.centroid[0] - center[0], p.centroid[1] - center[1], p.centroid[2] - center[2]) < radius).map((p) => p.id);

  it('stands at rest: nothing is over its baseline', () => {
    const { solver } = setup();
    const r = solver.step();
    expect(r.broken).toEqual([]);
    expect(r.detached).toEqual([]);
  });

  it('survives one rocket to a ground-floor wall', () => {
    const { solver, pieces } = setup();
    const hole = blast(pieces, [-2, 1.4, -4], 1.6);
    expect(hole.length).toBeGreaterThan(3);
    solver.remove(hole);
    settle(solver);
    expect(solver.liveNodes / pieces.length).toBeGreaterThan(0.85);
  });

  it('comes down once the ground-floor supports are shot out', () => {
    const { solver, pieces } = setup();
    const supports = pieces.filter((p) => p.min[1] < 0.01 && p.kind !== 'slab');
    // Leave a corner standing: the building must fail, not just lose its legs.
    const keep = new Set(supports.filter((p) => p.centroid[0] < -5 && p.centroid[2] < -3).map((p) => p.id));
    solver.remove(supports.filter((p) => !keep.has(p.id)).map((p) => p.id));
    settle(solver);
    expect(solver.liveNodes / pieces.length).toBeLessThan(0.25);
  });
});

describe('local solves on a big building', () => {
  const medium = { floors: 5, width: 20, depth: 12, x: -10, z: -6 } as const;
  const setup = (localThreshold: number): { solver: StrainSolver; pieces: Piece[] } => {
    const { pieces } = buildBuilding(medium);
    const solver = new StrainSolver(buildStructure(pieces, findConnections(pieces)), { localThreshold });
    solver.init();
    return { solver, pieces };
  };
  const near = (pieces: Piece[], c: V3, r: number): number[] =>
    pieces.filter((p) => Math.hypot(p.centroid[0] - c[0], p.centroid[1] - c[1], p.centroid[2] - c[2]) < r).map((p) => p.id);

  it('agrees with the full solve around the damage', () => {
    const local = setup(1200);
    const full = setup(Infinity);
    const hole = near(local.pieces, [-4, 1.4, -6], 1.2);
    local.solver.remove(hole);
    full.solver.remove(hole);
    const a = local.solver.step();
    const b = full.solver.step();
    expect(a.mode).toBe('local');
    expect(b.mode).toBe('global');
    expect(a.region).toBeLessThan(local.pieces.length / 3);
    // Compare utilization over the connections touching chunks within 2.5 m of the hole.
    const around = new Set(near(local.pieces, [-4, 1.4, -6], 2.5));
    const data = local.solver.data;
    // What decides a break is utilization against the break offset (1), so compare absolute excess.
    let worst = 0;
    let worstExcess = 0;
    for (let c = 0; c < data.connCount; c++) {
      if (!around.has(data.connA[c]!) || !local.solver.connAlive[c]) continue;
      worst = Math.max(worst, Math.abs(local.solver.utilization[c]! - full.solver.utilization[c]!));
      worstExcess = Math.max(worstExcess, full.solver.utilization[c]! - full.solver.baseline[c]!);
    }
    expect(worstExcess).toBeGreaterThan(0.1); // the hole really did load its surroundings
    expect(worst).toBeLessThan(0.1); // 8 m region: max 0.08 of the break offset; the closing full solve is exact
  });

  it('ends every cascade with a full solve', () => {
    const { solver, pieces } = setup(1200);
    solver.remove(near(pieces, [2, 1.4, -6], 1.6));
    const modes: string[] = [];
    for (let i = 0; i < 60; i++) {
      const r = solver.step();
      modes.push(r.mode);
      if (r.stable) break;
    }
    expect(modes[0]).toBe('local');
    expect(modes.filter((m) => m !== 'idle').at(-1)).toBe('global');
  });
});

describe('loads', () => {
  it('a blast load breaks connections a static solve would not', () => {
    const { pieces } = buildBuilding();
    const solver = new StrainSolver(buildStructure(pieces, findConnections(pieces)));
    solver.init();
    const target = pieces.filter((p) => p.kind === 'wall' && Math.hypot(p.centroid[0] + 2, p.centroid[1] - 1.4, p.centroid[2] + 3.85) < 1.2);
    expect(solver.step().broken).toEqual([]);
    const blast = target.map((p) => ({ node: p.id, fx: 0, fy: 0, fz: 400_000 }));
    const r = solver.step(blast);
    expect(r.broken.length).toBeGreaterThan(0);
  });

  it('a standing load (something hanging off a chunk) can start a cascade', () => {
    const pieces = [box(0, [0, 0, 0], [1, 2, 1]), box(1, [1, 1, 0], [2, 2, 1])];
    const solver = new StrainSolver(buildStructure(pieces, findConnections(pieces)));
    solver.init();
    expect(solver.step().stable).toBe(true);
    solver.setLoad(1, 0, -2_000_000, 0);
    const r = solver.step();
    expect(r.detached.flat()).toContain(1);
  });
});
