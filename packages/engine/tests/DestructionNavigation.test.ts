import { beforeAll, describe, expect, it } from 'vitest';
import { Navigation, initNavigation, type NavGeometry, type Vec3Like } from '../src/ai/Navigation';
import { Random } from '../src/core/Random';
import { Transform } from '../src/ecs/components/Transform';
import { EntityWorld } from '../src/ecs/EntityWorld';
import { buildBuilding } from '../src/destruction/core/building';
import { Destruction, type DestructionEvents } from '../src/destruction/Destruction';
import { PhysicsWorld, initRapier } from '../src/physics/PhysicsWorld';
import { createPhysicsSystems } from '../src/physics/systems';

/**
 * Bots' navmesh around a structure that changes (readiness gap 3): a tiled
 * mesh baked from the ground and the structure's `navGeometry`, rebuilt tile
 * by tile where `reshape` says the walkable world changed.
 */

const DT = 1 / 60;
const BOUNDS = { min: { x: -24, y: -1, z: -24 }, max: { x: 24, y: 12, z: 24 } };

async function rig() {
  const entities = new EntityWorld({ capacity: 4096 });
  const physics = await PhysicsWorld.create({ entities, fixedStepHz: 60 });
  for (const s of createPhysicsSystems(physics)) entities.addSystem(s);
  const ground = entities.create([Transform, { y: -0.5 }]);
  physics.addBody(ground, { type: 'fixed', shape: { kind: 'box', hx: 60, hy: 0.5, hz: 60 }, events: false });
  // The test building: 12 × 8 m (x −6..6, z −4..4), a door in the front wall (z = −4) at street level.
  const d = new Destruction({ entities, physics, random: new Random(7) }, { pieces: buildBuilding().pieces });
  for (const s of d.systems()) entities.addSystem(s);
  const geometry: NavGeometry = (soup, min, max) => {
    soup.addBox(0, -0.5, 0, 30, 0.5, 30);
    d.navGeometry(soup, min, max);
  };
  const nav = Navigation.tiled(geometry, BOUNDS);
  const reshapes: Array<DestructionEvents['reshape']> = [];
  d.events.on('reshape', (r) => {
    reshapes.push(r);
    nav.invalidate(r.min, r.max);
  });
  return {
    entities,
    physics,
    d,
    nav,
    reshapes,
    frames(n: number): void {
      for (let i = 0; i < n; i++) {
        entities.runStage('fixed', DT);
        entities.runStage('late', DT);
      }
    },
    dispose(): void {
      nav.dispose();
      entities.dispose();
      physics.dispose();
    },
  };
}

/** Walking length of the path from `a` to `b`, or Infinity if it doesn't get there. */
function walk(nav: Navigation, a: Vec3Like, b: Vec3Like): number {
  const corners: Vec3Like[] = [];
  if (!nav.findPath(a, b, corners)) return Infinity;
  let len = 0;
  let p = a;
  for (const c of corners) {
    len += Math.hypot(c.x - p.x, c.z - p.z);
    p = c;
  }
  return len;
}

describe('a navmesh around a structure that changes', () => {
  beforeAll(async () => {
    await Promise.all([initRapier(), initNavigation()]);
  });

  it('opens a way through a wall that was blown out, once the tiles it reached are rebuilt', async () => {
    const r = await rig();
    // From outside the west wall (x = −6) to just inside it: round by the front door at first.
    const outside = { x: -9, y: 0, z: 0 };
    const inside = { x: -4.2, y: 0, z: 0 };
    const before = walk(r.nav, outside, inside);
    expect(before).toBeGreaterThan(9);
    expect(before).toBeLessThan(Infinity);
    const tiles = r.nav.stats().tiles;

    // The west wall's ground storey taken out over 2.4 m: the slab above still bears on the rest.
    const gap = r.d.pieces.filter((p) => p.kind === 'wall' && p.max[0] < -5.6 && p.max[1] < 3 && Math.abs(p.centroid[2]) < 1.2);
    expect(r.d.remove(gap.map((p) => p.id))).toBe(gap.length);
    r.frames(20);
    expect(r.reshapes.length).toBeGreaterThan(0);
    const box = r.reshapes[0]!;
    expect(box.min.x).toBeLessThan(-5.6);
    expect(box.max.z).toBeGreaterThan(0.5);
    // Only the tiles it reached wait to be rebuilt, not the whole mesh.
    expect(r.nav.pendingTiles).toBeGreaterThan(0);
    expect(r.nav.pendingTiles).toBeLessThan(tiles);
    // Until they are, the way is as it was.
    expect(walk(r.nav, outside, inside)).toBeCloseTo(before, 3);
    while (r.nav.pendingTiles > 0) r.nav.update(1);
    const after = walk(r.nav, outside, inside);
    expect(after).toBeLessThan(5.5);
    r.dispose();
  }, 60_000);

  it('a building that comes down leaves a heap where its rooms were, and the mesh follows it', async () => {
    const r = await rig();
    const room = { x: 0, y: 0, z: -1.5 };
    const near = { x: 0, y: 0, z: 0 };
    expect(r.nav.nearestPoint(room, near)!.y).toBeLessThan(0.1);
    r.d.remove(r.d.pieces.filter((p) => p.max[1] < 3.0 && p.kind !== 'slab').map((p) => p.id));
    for (let i = 0; i < 600; i++) {
      r.frames(1);
      r.nav.update(2);
    }
    while (r.nav.pendingTiles > 0) r.nav.update(4);
    // Rubble settled: the reshapes covered the building, and the room's floor is now the top of the heap (or nothing to stand on).
    const all = r.reshapes.reduce((a, b) => ({ min: a.min.clone().min(b.min), max: a.max.clone().max(b.max) }));
    expect(all.min.x).toBeLessThan(-5);
    expect(all.max.x).toBeGreaterThan(5);
    expect(r.d.stats().debris.piled).toBeGreaterThan(0);
    const top = r.nav.nearestPoint({ x: 0, y: 1, z: -1.5 }, near);
    expect(top === null || top.y > 0.2).toBe(true);
    r.dispose();
  }, 120_000);
});
