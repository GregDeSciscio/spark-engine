import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { Random } from '../src/core/Random';
import { Transform } from '../src/ecs/components/Transform';
import { EntityWorld } from '../src/ecs/EntityWorld';
import { buildBuilding } from '../src/destruction/core/building';
import { GONE, RUBBLE, STANDING } from '../src/destruction/Debris';
import { Destruction, type DestructionSave } from '../src/destruction/Destruction';
import { PhysicsWorld, initRapier } from '../src/physics/PhysicsWorld';
import { createPhysicsSystems } from '../src/physics/systems';

/**
 * Checkpoints (readiness gap 8): a structure's destroyed state saved as plain
 * data and restored onto the same structure built afresh in a new world.
 */

const DT = 1 / 60;

async function world() {
  const entities = new EntityWorld({ capacity: 4096 });
  const physics = await PhysicsWorld.create({ entities, fixedStepHz: 60 });
  for (const s of createPhysicsSystems(physics)) entities.addSystem(s);
  const ground = entities.create([Transform, { y: -0.5 }]);
  physics.addBody(ground, { type: 'fixed', shape: { kind: 'box', hx: 60, hy: 0.5, hz: 60 }, events: false });
  const d = new Destruction({ entities, physics, random: new Random(7) }, { pieces: buildBuilding().pieces });
  for (const s of d.systems()) entities.addSystem(s);
  return {
    entities,
    physics,
    d,
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

const classes = (d: Destruction) => {
  const out = { standing: [] as number[], gone: [] as number[], rubble: [] as number[], loose: [] as number[] };
  for (let p = 0; p < d.pieces.length; p++) {
    const s = d.debris.state[p]!;
    if (s === STANDING) out.standing.push(p);
    else if (s === GONE) out.gone.push(p);
    else if (s === RUBBLE) out.rubble.push(p);
    else out.loose.push(p);
  }
  return out;
};

const at = (d: Destruction, p: number): THREE.Vector3 => new THREE.Vector3(...d.pieces[p]!.centroid).applyMatrix4(d.debris.restToWorld(p, new THREE.Matrix4()));

/** Restore `save` in a new world and check every chunk is in the class and place it was; returns how many loose chunks it checked. */
async function roundTrip(save: DestructionSave, was: ReturnType<typeof classes>, looseAt: Map<number, THREE.Vector3>): Promise<number> {
  const b = await world();
  b.d.restore(JSON.parse(JSON.stringify(save)));
  expect(classes(b.d)).toEqual(was);
  for (const [p, v] of looseAt) expect(at(b.d, p).distanceTo(v)).toBeLessThan(1e-4);
  // Moving as it was.
  for (const saved of save.debris.bodies) {
    const v = { x: 0, y: 0, z: 0 };
    b.physics.bodies.velocity(b.d.debris.bodyOf(saved.pieces[0]!)!, v);
    expect(Math.hypot(v.x - saved.linvel[0], v.y - saved.linvel[1], v.z - saved.linvel[2])).toBeLessThan(1e-4);
  }
  b.frames(120);
  expect(b.d.stats().sanity.nonFinite).toBe(0);
  b.dispose();
  return looseAt.size;
}

describe('saving and restoring a destroyed structure', () => {
  beforeAll(async () => {
    await initRapier();
  });

  it('comes back as it was saved: gone, rubble where it lay, loose debris where it was, hits and soot', async () => {
    const a = await world();
    a.frames(2);
    // A rocket through the front wall, a corner of the ground storey taken out, three hits on another chunk.
    a.d.explode({ x: -4.5, y: 1, z: -3.8 }, 1.8, { x: 0, y: 0, z: -1 });
    a.d.remove(a.d.pieces.filter((p) => p.max[1] < 3 && p.kind !== 'slab' && p.centroid[0] > 3.5 && p.centroid[2] < 0).map((p) => p.id));
    const shot = a.d.pieces.find((p) => p.kind === 'wall' && p.min[2] < -3.9 && p.centroid[0] > 0 && p.centroid[0] < 2 && p.min[1] > 3.3)!;
    a.d.damage(shot.id, 2);
    // Saved mid-fall (debris in the air) and again once it has settled.
    a.frames(12);
    const falling = await roundTrip(a.d.save(), classes(a.d), new Map(classes(a.d).loose.map((p) => [p, at(a.d, p)])));
    expect(falling).toBeGreaterThan(0);
    a.frames(150);
    const before = classes(a.d);
    expect(before.rubble.length).toBeGreaterThan(0);
    expect(before.gone.length).toBeGreaterThan(0);
    const save: DestructionSave = JSON.parse(JSON.stringify(a.d.save()));
    const rubbleAt = new Map(before.rubble.map((p) => [p, at(a.d, p)]));
    const looseAt = new Map(before.loose.map((p) => [p, at(a.d, p)]));
    a.dispose();

    const b = await world();
    b.d.restore(save);
    const after = classes(b.d);
    expect(after.gone).toEqual(before.gone);
    expect(after.rubble).toEqual(before.rubble);
    expect(after.loose).toEqual(before.loose);
    expect(after.standing).toEqual(before.standing);
    for (const [p, v] of rubbleAt) expect(at(b.d, p).distanceTo(v)).toBeLessThan(1e-4);
    for (const [p, v] of looseAt) expect(at(b.d, p).distanceTo(v)).toBeLessThan(1e-4);
    expect(b.d.save().hits).toEqual(save.hits);
    expect(b.d.save().soot).toEqual(save.soot);
    expect(b.d.save().broken).toEqual(save.broken);
    expect(save.soot.length).toBeGreaterThan(0);

    // It carries on from there: Strain checks what stands, debris lands and settles, nothing goes wild.
    b.frames(240);
    const s = b.d.stats();
    expect(s.sanity.nonFinite).toBe(0);
    expect(s.sanity.maxSpeed).toBeLessThan(32);
    expect(s.cascading).toBe(false);
    expect(classes(b.d).standing.length).toBeGreaterThan(before.standing.length * 0.8);
    // Rubble that was lying still is still lying there.
    let stayed = 0;
    for (const [p, v] of rubbleAt) if (b.d.debris.state[p] === RUBBLE && at(b.d, p).distanceTo(v) < 0.05) stayed++;
    expect(stayed).toBeGreaterThan(rubbleAt.size * 0.8);
    b.dispose();
  }, 60_000);

  it('a save of nothing restores nothing, and only onto a structure built afresh', async () => {
    const a = await world();
    const empty = a.d.save();
    expect(empty.debris.gone).toHaveLength(0);
    expect(empty.debris.piles).toHaveLength(0);
    a.d.restore(empty);
    expect(classes(a.d).standing).toHaveLength(a.d.pieces.length);
    a.d.remove([0]);
    expect(() => a.d.restore(empty)).toThrow(/afresh/);
    expect(() => a.d.restore({ ...empty, chunks: 5 })).toThrow(/5 chunks/);
    a.dispose();
  });
});
