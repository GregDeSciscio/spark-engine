import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { Random } from '../src/core/Random';
import { Transform } from '../src/ecs/components/Transform';
import { EntityWorld } from '../src/ecs/EntityWorld';
import { Destructible } from '../src/destruction/components';
import { buildBuilding } from '../src/destruction/core/building';
import { Destruction, type DestructionEvents } from '../src/destruction/Destruction';
import { GONE, STANDING } from '../src/destruction/Debris';
import { PhysicsWorld, initRapier } from '../src/physics/PhysicsWorld';
import { createPhysicsSystems } from '../src/physics/systems';

/**
 * The subsystem end to end, the way a scene uses it: a small building, its
 * systems registered beside the physics ones, a raycast that names the
 * structure's entity and the chunk, an explosion, and a dispose that leaves
 * nothing behind. No renderer, no audio, strain inline (Node has no Worker).
 */

const DT = 1 / 60;

interface Rig {
  entities: EntityWorld;
  physics: PhysicsWorld;
  ground: number;
  frames(n: number): void;
  dispose(): void;
}

async function rig(): Promise<Rig> {
  const entities = new EntityWorld({ capacity: 2048 });
  const physics = await PhysicsWorld.create({ entities, fixedStepHz: 60 });
  for (const s of createPhysicsSystems(physics)) entities.addSystem(s);
  const ground = entities.create([Transform, { y: -0.5 }]);
  physics.addBody(ground, { type: 'fixed', shape: { kind: 'box', hx: 60, hy: 0.5, hz: 60 }, events: false });
  return {
    entities,
    physics,
    ground,
    frames(n: number): void {
      for (let i = 0; i < n; i++) {
        entities.runStage('fixed', DT);
        entities.runStage('late', DT);
      }
    },
    dispose(): void {
      entities.dispose();
      physics.dispose();
    },
  };
}

/** The default test building: 12 × 8 m, three storeys, x −6..6, z −4..4. */
function make(r: Rig): Destruction {
  const d = new Destruction({ entities: r.entities, physics: r.physics, random: new Random(7) }, { pieces: buildBuilding().pieces });
  for (const s of d.systems()) r.entities.addSystem(s);
  return d;
}

describe('Destruction', () => {
  beforeAll(async () => {
    await initRapier();
  });

  it('is one entity that owns every chunk: a raycast names it and the chunk', async () => {
    const r = await rig();
    const d = make(r);
    expect(d.strainMode).toBe('inline');
    expect(d.ready).toBe(true);
    expect(r.entities.has(d.entity, Destructible)).toBe(true);
    expect(r.entities.store(Destructible).chunks[d.entity]).toBe(d.pieces.length);
    expect(Destruction.of(r.entities, d.entity)).toBe(d);
    // Every chunk stands as a collider of the structure's entity, with its id as the part.
    expect(r.physics.bodies.colliderCount).toBe(d.pieces.length + 1);
    r.frames(1); // colliders join the query structures on the next physics step

    // At the front wall below the windows, from the street.
    const hit = r.physics.raycast({ x: -4.5, y: 0.5, z: -20 }, { x: 0, y: 0, z: 1 }, 50)!;
    expect(hit).not.toBeNull();
    expect(hit.eid).toBe(d.entity);
    expect(hit.part).toBeGreaterThanOrEqual(0);
    const piece = d.pieces[hit.part]!;
    expect(piece.min[2]).toBeLessThan(-3.6); // a chunk of that wall
    expect(hit.point.z).toBeCloseTo(-4, 1);
    expect(Destruction.of(r.entities, hit.eid)).toBe(d);
    r.dispose();
  });

  it('takes an explosion: a crater, a cascade, debris and its events', async () => {
    const r = await rig();
    const d = make(r);
    const seen: Partial<Record<keyof DestructionEvents, number>> = {};
    for (const name of ['blast', 'step', 'land', 'shatter'] as const) d.events.on(name, () => (seen[name] = (seen[name] ?? 0) + 1));
    r.frames(2);
    const hit = r.physics.raycast({ x: -4.5, y: 0.5, z: -20 }, { x: 0, y: 0, z: 1 }, 50)!;
    const taken = d.explode({ x: hit.point.x, y: hit.point.y, z: hit.point.z + 0.2 }, 1.6, hit.normal);
    expect(taken).toBeGreaterThan(3);
    expect(seen.blast).toBe(1);
    r.frames(180);
    const s = d.stats();
    expect(seen.step).toBeGreaterThan(0);
    expect(s.standing).toBeLessThan(s.chunks);
    expect(s.debris.created).toBeGreaterThan(0);
    expect(s.sanity.nonFinite).toBe(0);
    expect(s.cascading).toBe(false);
    // What came loose is debris of the same owner, chunk by chunk.
    const loose = d.pieces.find((p) => d.debris.state[p.id]! >= 0);
    if (loose) {
      const c = d.debris.colliderOf(loose.id)!;
      expect(r.physics.bodies.info(c)).toMatchObject({ owner: d.entity, part: loose.id });
    }
    expect(r.entities.store(Destructible).standing[d.entity]).toBe(s.standing);
    r.dispose();
  });

  it('pops a chunk after three hits, along the shot', async () => {
    const r = await rig();
    const d = make(r);
    r.frames(1);
    const hit = r.physics.raycast({ x: -4.5, y: 0.5, z: -20 }, { x: 0, y: 0, z: 1 }, 50)!;
    expect(d.damage(hit.part, 1, { x: 0, y: 0, z: 1 })).toBe(false);
    expect(d.damage(hit.part, 1, { x: 0, y: 0, z: 1 })).toBe(false);
    expect(d.damage(hit.part, 1, { x: 0, y: 0, z: 1 })).toBe(true);
    expect(d.debris.state[hit.part]).toBeGreaterThanOrEqual(0);
    const v = { x: 0, y: 0, z: 0 };
    r.physics.bodies.velocity(d.debris.bodyOf(hit.part)!, v);
    expect(v.z).toBeCloseTo(4, 3);
    r.dispose();
  });

  it('a building that loses its ground storey falls as linked elements, or loose past `looseIsland`', async () => {
    // Everything above a ground storey cut out but for one corner comes loose as one island (~300 chunks).
    const links = async (looseIsland?: number): Promise<number> => {
      const r = await rig();
      const d = new Destruction({ entities: r.entities, physics: r.physics, random: new Random(7) }, { pieces: buildBuilding().pieces }, looseIsland === undefined ? {} : { looseIsland });
      for (const s of d.systems()) r.entities.addSystem(s);
      const cut = d.pieces.filter((p) => p.max[1] < 3.0 && p.kind !== 'slab' && !(p.centroid[0] < -4.5 && p.centroid[2] < -2.5));
      d.remove(cut.map((p) => p.id));
      // Loose, but not yet landed (three metres take ~0.8 s).
      r.frames(24);
      expect(d.stats().bodies).toBeGreaterThan(10);
      const n = d.hinges.linkCount;
      r.dispose();
      return n;
    };
    const linked = await links();
    const loose = await links(100);
    // Linked, its elements hang together as a net; loose, only what broke at the corner still holds.
    expect(linked).toBeGreaterThan(20);
    expect(loose).toBeLessThan(linked / 3);
  });

  it('a top left on columns that failed under it comes down: the column blocks are crushed', async () => {
    // The sandbox's report: blow out a building's front and sides at street level, and the storeys
    // above, cut loose by Strain, stayed up on the columns and the back wall whose joints had failed.
    const run = async (crush: boolean): Promise<{ up: number; top: number; crushed: number }> => {
      const r = await rig();
      const options = crush ? {} : { crushRatio: Infinity, squeezeRatio: Infinity };
      const d = new Destruction({ entities: r.entities, physics: r.physics, random: new Random(7) }, { pieces: buildBuilding({ columnSpacing: 3 }).pieces }, options);
      for (const s of d.systems()) r.entities.addSystem(s);
      const zBack = Math.max(...d.pieces.map((p) => p.max[2]));
      d.remove(d.pieces.filter((p) => p.max[1] < 3.0 && p.kind === 'wall' && p.min[2] < zBack - 0.6).map((p) => p.id));
      r.frames(480);
      // The upper storeys' chunks still within half a metre of where they were built.
      const m = new THREE.Matrix4();
      const top = d.pieces.filter((p) => p.min[1] > 2.9);
      let up = 0;
      for (const p of top) {
        if (d.debris.state[p.id] === GONE) continue;
        if (new THREE.Vector3(...p.centroid).applyMatrix4(d.debris.restToWorld(p.id, m)).y > p.centroid[1] - 0.5) up++;
      }
      const crushed = d.stats().debris.crushed;
      r.dispose();
      return { up, top: top.length, crushed };
    };
    // Rigid blocks never give: without crushing, the top stands on the blocks of its columns.
    const off = await run(false);
    expect(off.up).toBeGreaterThan(off.top / 2);
    // Crushed under it, they let it down.
    const on = await run(true);
    expect(on.crushed).toBeGreaterThan(0);
    expect(on.up).toBeLessThan(on.top / 10);
  }, 60_000);

  it('a top cut loose over its blown-out ground storey comes straight down instead of standing on what failed', async () => {
    // Greg's report: blow out a tower's ground storey and the top stood there, then ground down in
    // slow motion. Strain had cut it loose, but it stood on the walls that failed under it and, when
    // it dropped, on its own loose walls as a stack of blocks. Five storeys; the front and sides of
    // the ground storey blown out, the back wall and the columns left.
    const r = await rig();
    const d = new Destruction({ entities: r.entities, physics: r.physics, random: new Random(7) }, { pieces: buildBuilding({ floors: 5, columnSpacing: 3 }).pieces });
    for (const s of d.systems()) r.entities.addSystem(s);
    const zBack = Math.max(...d.pieces.map((p) => p.max[2]));
    d.remove(d.pieces.filter((p) => p.max[1] < 3.0 && p.kind === 'wall' && p.min[2] < zBack - 0.6).map((p) => p.id));
    const failed: number[] = [];
    d.events.on('fail', (e) => failed.push(e.pieces.length));
    // How far the storeys above the second have come down, on average.
    const top = d.pieces.filter((p) => p.min[1] > 6);
    const m = new THREE.Matrix4();
    const drop = (): number => {
      let sum = 0;
      let n = 0;
      for (const p of top) {
        if (d.debris.state[p.id] === GONE) continue;
        sum += p.centroid[1] - new THREE.Vector3(...p.centroid).applyMatrix4(d.debris.restToWorld(p.id, m)).y;
        n++;
      }
      return sum / n;
    };
    // Standing on its failed storey and on its own walls, it had come down half a metre by 1.5 s and
    // four and a half by 3 s; it comes down two and a half, then the storeys' worth.
    r.frames(90);
    expect(failed.length).toBeGreaterThan(0);
    expect(drop()).toBeGreaterThan(1.5);
    r.frames(90);
    expect(drop()).toBeGreaterThan(6);
    r.dispose();
  }, 60_000);

  it('runs the same whatever the listener does: the camera never reaches the simulation', async () => {
    // A showcase film's fixed-clock replay with a different camera path came out different. The
    // camera's one way in is the listener (blast shake, sound); the same blasts with the listener
    // still or flying past them must leave every body in the same place, to the bit.
    const poses = async (fly: boolean): Promise<string> => {
      const r = await rig();
      const d = make(r);
      r.frames(2);
      for (let f = 0; f < 150; f++) {
        if (fly) d.listener.set(-20 + f * 0.3, 1 + Math.sin(f * 0.2) * 3, -10);
        if (f === 5) d.explode({ x: -4.5, y: 0.5, z: -3.8 }, 1.6, { x: 0, y: 0, z: -1 });
        if (f === 20) d.explode({ x: 3, y: 4, z: -3.8 }, 2.4, { x: 0, y: 0, z: -1 });
        r.frames(1);
      }
      const rows: number[][] = [];
      r.physics.raw.bodies.forEach((b) => {
        const t = b.translation();
        const q = b.rotation();
        rows.push([b.handle, t.x, t.y, t.z, q.x, q.y, q.z, q.w]);
      });
      const out = JSON.stringify(rows.sort((a, b) => a[0]! - b[0]!)) + JSON.stringify(d.stats().debris);
      r.dispose();
      return out;
    };
    const still = await poses(false);
    expect(still).toContain('['); // some bodies
    expect(await poses(true)).toBe(still);
  }, 60_000);

  it('leaves no body, collider or joint behind when disposed, ropes and hinges included', async () => {
    const r = await rig();
    const before = { bodies: r.physics.bodyCount, colliders: r.physics.bodies.colliderCount, joints: r.physics.joints.count, entities: r.entities.count };
    const d = make(r);
    // Something slung under the first floor slab, and a cascade with hinges in it.
    const slab = d.pieces.find((p) => p.kind === 'slab' && p.min[1] > 2.9 && p.min[1] < 3 && Math.abs(p.centroid[0]) < 1.5)!;
    const crate = r.entities.create([Transform, { x: slab.centroid[0], y: 1.5, z: slab.centroid[2] }]);
    r.physics.addBody(crate, { type: 'dynamic', shape: { kind: 'box', hx: 0.4, hy: 0.4, hz: 0.4 }, mass: 200 });
    d.hang(r.physics.bodyOf(crate)!, slab.id, { x: slab.centroid[0], y: slab.min[1], z: slab.centroid[2] }, { x: 0, y: 0.4, z: 0 }, 1.2);
    expect(d.stats().ropes).toBe(1);
    expect(r.physics.joints.count).toBe(before.joints + 1);
    const supports = d.pieces.filter((p) => p.min[1] < 0.01 && p.kind !== 'slab' && p.centroid[0] > -2);
    expect(d.remove(supports.map((p) => p.id))).toBe(supports.length);
    r.frames(90);
    expect(d.stats().bodies).toBeGreaterThan(0);
    expect(d.debris.state[supports[0]!.id]).not.toBe(STANDING);

    d.dispose();
    r.entities.destroy(crate);
    expect(r.physics.bodyCount).toBe(before.bodies);
    expect(r.physics.bodies.colliderCount).toBe(before.colliders);
    expect(r.physics.joints.count).toBe(before.joints);
    expect(r.entities.count).toBe(before.entities);
    expect(Destruction.of(r.entities, d.entity)).toBeUndefined();
    expect(d.object.children).toHaveLength(0);
    // The systems are inert once it is gone.
    r.frames(2);
    r.dispose();
  });

  it('goes with its entity', async () => {
    const r = await rig();
    const before = { bodies: r.physics.bodyCount, colliders: r.physics.bodies.colliderCount };
    const d = make(r);
    d.explode({ x: 0, y: 1.5, z: -4 }, 1.6);
    r.frames(30);
    r.entities.destroy(d.entity);
    expect(Destruction.of(r.entities, d.entity)).toBeUndefined();
    expect(r.physics.bodyCount).toBe(before.bodies);
    expect(r.physics.bodies.colliderCount).toBe(before.colliders);
    expect(d.explode({ x: 0, y: 1.5, z: -4 }, 1.6)).toBe(0);
    r.frames(2);
    r.dispose();
  });
});
