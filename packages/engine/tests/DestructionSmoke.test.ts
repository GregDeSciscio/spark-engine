import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildBuilding } from '../src/destruction/core/building';
import type { P2, V3 } from '../src/destruction/core/math';
import { prism, type Piece } from '../src/destruction/core/pieces';
import { Debris } from '../src/destruction/Debris';
import { SmokeSystem } from '../src/destruction/Smoke';
import { EntityWorld } from '../src/ecs/EntityWorld';
import { PhysicsWorld, initRapier } from '../src/physics/PhysicsWorld';

/** Season 12's dynamic smoke: a cloud floods the open voxels around it and never passes through walls. */

function box(id: number, min: V3, max: V3): Piece {
  const w = max[0] - min[0];
  const h = max[1] - min[1];
  const poly: P2[] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  return prism({ id, element: id, kind: 'wall', poly, frame: { origin: min, u: [1, 0, 0], v: [0, 1, 0] }, thickness: max[2] - min[2], width: w, height: h, minus: 'outer', plus: 'inner', density: 2400 });
}

type CloudView = { order: number[]; center(c: number, out: THREE.Vector3): THREE.Vector3 };
const cloudOf = (smoke: SmokeSystem): CloudView => (smoke as unknown as { clouds: CloudView[] }).clouds[0]!;
const run = (smoke: SmokeSystem, seconds: number): void => {
  for (let i = 0; i < seconds * 60; i++) smoke.update(1 / 60);
};

/** Pieces standing in a physics world (the debris layer is what the smoke asks where chunks are). */
async function standing(pieces: Piece[]): Promise<{ debris: Debris; smoke: SmokeSystem; dispose(): void }> {
  const entities = new EntityWorld({ capacity: 64 });
  const physics = await PhysicsWorld.create({ entities, fixedStepHz: 60 });
  const debris = new Debris(physics, entities.create(), pieces);
  const smoke = new SmokeSystem(debris, pieces);
  return {
    debris,
    smoke,
    dispose(): void {
      smoke.dispose();
      debris.dispose();
      entities.dispose();
      physics.dispose();
    },
  };
}

describe('dynamic smoke', () => {
  beforeAll(async () => {
    await initRapier();
  });

  /** A sealed 4 × 2.7 × 4 m concrete box (walls 0.3 m), standing on the ground. */
  const sealed = (): Promise<{ debris: Debris; smoke: SmokeSystem; dispose(): void }> =>
    standing([
      box(0, [-2.3, 0, -2.3], [2.3, 0.3, 2.3]), // floor
      box(1, [-2.3, 3, -2.3], [2.3, 3.3, 2.3]), // roof
      box(2, [-2.3, 0.3, -2.3], [-2, 3, 2.3]), // west
      box(3, [2, 0.3, -2.3], [2.3, 3, 2.3]), // east
      box(4, [-2, 0.3, -2.3], [2, 3, -2]), // south
      box(5, [-2, 0.3, 2], [2, 3, 2.3]), // north
    ]);

  it('stays inside a sealed room', async () => {
    const w = await sealed();
    w.smoke.spawn('smoke', new THREE.Vector3(0, 1.5, 0));
    run(w.smoke, 2);
    const cloud = cloudOf(w.smoke);
    expect(cloud.order.length).toBeGreaterThan(150);
    const c = new THREE.Vector3();
    for (const v of cloud.order) {
      cloud.center(v, c);
      expect(Math.abs(c.x)).toBeLessThan(2);
      expect(Math.abs(c.z)).toBeLessThan(2);
      expect(c.y).toBeGreaterThan(0.3);
      expect(c.y).toBeLessThan(3);
    }
    w.dispose();
  });

  it('pours out through a wall that was just knocked down', async () => {
    const w = await sealed();
    w.smoke.spawn('smoke', new THREE.Vector3(0, 1.5, 0));
    run(w.smoke, 2);
    w.debris.remove(3); // the east wall goes
    w.smoke.markDirty();
    run(w.smoke, 1.5);
    const cloud = cloudOf(w.smoke);
    const c = new THREE.Vector3();
    const outside = cloud.order.filter((v) => cloud.center(v, c).x > 2.3).length;
    expect(outside).toBeGreaterThan(200);
    w.dispose();
  });

  it("fills the test building's ground floor to its volume in about a second", async () => {
    // 12 × 8 m and 3.2 m high: the room takes most of the cloud, and the rest pours out of its windows and door.
    const { pieces, params } = buildBuilding();
    const w = await standing(pieces);
    w.smoke.spawn('smoke', new THREE.Vector3(params.x + params.width / 2, 1, params.z + params.depth / 2));
    run(w.smoke, 1.5);
    expect(w.smoke.voxels).toBeGreaterThan(2800);
    const cloud = cloudOf(w.smoke);
    const c = new THREE.Vector3();
    const inside = cloud.order.filter((v) => cloud.center(v, c).y < params.storeyHeight && c.x > params.x && c.x < params.x + params.width && c.z > params.z && c.z < params.z + params.depth).length;
    expect(inside / cloud.order.length).toBeGreaterThan(0.5);
    w.dispose();
  });
});
