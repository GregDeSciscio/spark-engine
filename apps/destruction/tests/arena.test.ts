import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  Debris,
  EntityWorld,
  GROUND,
  PhysicsWorld,
  SmokeSystem,
  StrainSolver,
  buildStructure,
  findConnections,
  initRapier,
  type StepResult,
  type StrainOptions,
  type StructureData,
} from '@spark/engine';
import { buildArena } from '../src/arena';

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

describe('the arena', () => {
  const arena = buildArena();
  const conns = findConnections(arena.pieces);

  it('numbers pieces 0..n−1 and keeps elements unique per structure', () => {
    arena.pieces.forEach((p, i) => expect(p.id).toBe(i));
    const owners = new Map<number, string>();
    for (const g of arena.groups) {
      for (let i = g.first; i < g.first + g.count; i++) {
        const e = arena.pieces[i]!.element;
        expect(owners.get(e) ?? g.name).toBe(g.name);
        owners.set(e, g.name);
      }
    }
  });

  it('glues the bridge deck into both buildings', () => {
    const bridge = arena.groups.find((g) => g.name === 'bridge')!;
    const inBridge = (p: number): boolean => p >= bridge.first && p < bridge.first + bridge.count;
    const groupOf = (p: number): string => arena.groups.find((g) => p >= g.first && p < g.first + g.count)!.name;
    const ends = new Set<string>();
    for (const c of conns) {
      if (c.b === GROUND) continue;
      if (inBridge(c.a) !== inBridge(c.b)) ends.add(groupOf(inBridge(c.a) ? c.b : c.a));
    }
    expect([...ends].sort()).toEqual(['A', 'B']);
    for (const r of arena.ropes) expect(arena.pieces[r.piece]!.kind).toBe('slab');
  });

  it('stands at rest under its own weight', () => {
    const solver = new StrainSolver(buildStructure(arena.pieces, conns));
    solver.init();
    expect(arena.pieces.length).toBeGreaterThan(1200);
    const r = solver.step();
    expect(r.broken).toEqual([]);
    expect(r.detached).toEqual([]);
  });

  it('breaks exactly what an always-refactor solver breaks on the arena, standing loads and all', () => {
    const arena = buildArena();
    const data = buildStructure(arena.pieces, findConnections(arena.pieces));
    const bridge = arena.groups.find((g) => g.name === 'bridge')!;
    const a = arena.groups.find((g) => g.name === 'A')!;
    const deck = arena.ropes[0]!.piece;
    // Hanging loads on the bridge while it is cut, then building A's ground storey goes.
    const cut = arena.pieces.filter((p) => p.id >= bridge.first && p.id < bridge.first + bridge.count && Math.abs(p.centroid[0] - (arena.pieces[deck]!.centroid[0] + 1.5)) < 0.6).map((p) => p.id);
    const r1 = expectSameCascade(data, cut, {}, [
      [deck, -40_000],
      [deck, -90_000],
    ]);
    const supports = arena.pieces.filter((p) => p.id >= a.first && p.id < a.first + a.count && p.min[1] < 0.01 && p.kind !== 'slab').map((p) => p.id);
    const r2 = expectSameCascade(data, supports.filter((_, i) => i % 3 !== 0));
    for (const r of [r1, r2]) {
      expect(r.maxDu).toBeLessThan(1e-3);
      expect(r.maxResidual).toBeLessThan(1e-6);
    }
    expect(r2.steps.some((s) => s.update === 'downdate')).toBe(true);
  });

  it("fills B's ground floor with smoke to its volume in about a second", async () => {
    await initRapier();
    const entities = new EntityWorld({ capacity: 64 });
    const physics = await PhysicsWorld.create({ entities, fixedStepHz: 60 });
    const debris = new Debris(physics, entities.create(), arena.pieces);
    const smoke = new SmokeSystem(debris, arena.pieces);
    smoke.spawn('smoke', new THREE.Vector3(13, 1, -1));
    for (let i = 0; i < 90; i++) smoke.update(1 / 60);
    expect(smoke.voxels).toBeGreaterThan(2800);
    smoke.dispose();
    debris.dispose();
    entities.dispose();
    physics.dispose();
  });
});
