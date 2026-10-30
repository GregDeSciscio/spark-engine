import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { Random } from '../src/core/Random';
import { Transform } from '../src/ecs/components/Transform';
import { EntityWorld, type Entity } from '../src/ecs/EntityWorld';
import { buildBuilding } from '../src/destruction/core/building';
import { Destruction, type DestructionEvents } from '../src/destruction/Destruction';
import { CharacterController } from '../src/physics/CharacterController';
import { PhysicsWorld, initRapier } from '../src/physics/PhysicsWorld';
import { createPhysicsSystems } from '../src/physics/systems';

/**
 * Characters in a structure that comes down (readiness gap 4): the engine's
 * own character controller on a floor that drops and under one that falls,
 * debris that strikes a character reported as a `hit`, and gas a game can
 * read at a character's head.
 */

const DT = 1 / 60;
/** The test building: 12 × 8 m (x −6..6, z −4..4), storeys of 3.2 m, columns at (±2, 0). */
const CAPSULE = { kind: 'capsule' as const, halfHeight: 0.5, radius: 0.3 };

interface Rig {
  entities: EntityWorld;
  physics: PhysicsWorld;
  controller: CharacterController;
  d: Destruction;
  character(x: number, y: number, z: number): Entity;
  frames(n: number): void;
  y(eid: Entity): number;
  dispose(): void;
}

async function rig(): Promise<Rig> {
  const entities = new EntityWorld({ capacity: 4096 });
  const physics = await PhysicsWorld.create({ entities, fixedStepHz: 60 });
  for (const s of createPhysicsSystems(physics)) entities.addSystem(s);
  const ground = entities.create([Transform, { y: -0.5 }]);
  physics.addBody(ground, { type: 'fixed', shape: { kind: 'box', hx: 60, hy: 0.5, hz: 60 }, events: false });
  const controller = new CharacterController(physics);
  const people: Entity[] = [];
  // The characters stand still: each fixed step asks the controller to move them nowhere, so only gravity and the floor move them.
  entities.addSystem({ name: 'Stand', stage: 'fixed', order: 50, run: (_w, dt) => people.forEach((e) => controller.move(e, { x: 0, y: 0, z: 0 }, dt)) });
  const d = new Destruction({ entities, physics, random: new Random(7) }, { pieces: buildBuilding().pieces });
  for (const s of d.systems()) entities.addSystem(s);
  return {
    entities,
    physics,
    controller,
    d,
    character(x, y, z) {
      const e = entities.create([Transform, { x, y, z }]);
      physics.addBody(e, { type: 'kinematicPosition', shape: CAPSULE, layer: 'player' });
      controller.attach(e);
      people.push(e);
      return e;
    },
    frames(n) {
      for (let i = 0; i < n; i++) {
        entities.runStage('fixed', DT);
        entities.runStage('late', DT);
      }
    },
    y: (eid) => entities.store(Transform).y[eid]!,
    dispose() {
      controller.dispose();
      entities.dispose();
      physics.dispose();
    },
  };
}

/** Everything holding up the first floor: the ground storey's walls and columns. */
function groundStorey(d: Destruction): number[] {
  return d.pieces.filter((p) => p.max[1] < 3.0 && p.kind !== 'slab').map((p) => p.id);
}

describe('characters in a structure that comes down', () => {
  beforeAll(async () => {
    await initRapier();
  });

  it('a character on a floor that loses its supports rides it down', async () => {
    const r = await rig();
    // On the first floor: its slab's top is at 3.2 m.
    const above = r.character(0, 3.2 + 0.8 + 0.05, -1.5);
    r.frames(30);
    expect(r.y(above)).toBeGreaterThan(3.9);
    expect(r.controller.isGrounded(above)).toBe(true);
    r.d.remove(groundStorey(r.d));
    let lowest = Infinity;
    for (let i = 0; i < 240; i++) {
      r.frames(1);
      lowest = Math.min(lowest, r.y(above));
    }
    // The floor came down a storey, and the character on it with it: not left standing in the air
    // where the floor was, nor driven through the ground.
    expect(lowest).toBeLessThan(2.4);
    expect(r.y(above)).toBeGreaterThan(0.5);
    r.dispose();
  }, 60_000);

  it('debris that falls on a character is a hit, once a body; a kinematic character holds it up until the game takes it away', async () => {
    const r = await rig();
    // On the ground floor, under the first floor's slab.
    const below = r.character(0, 0.8 + 0.05, -1.5);
    const hits: Array<DestructionEvents['hit']> = [];
    r.d.events.on('hit', (h) => hits.push(h));
    const stop = Destruction.watchHits(r.physics, below, { ...CAPSULE, radius: CAPSULE.radius + 0.05 });
    r.frames(30);
    r.d.remove(groundStorey(r.d));
    r.frames(120);
    // The game's to turn into damage: who, what, how heavy and how fast.
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.eid).toBe(below);
      expect(h.speed).toBeGreaterThanOrEqual(2);
      expect(h.momentum).toBeCloseTo(h.mass * h.speed, 3);
      expect(r.d.pieces[h.part]).toBeDefined();
    }
    const heaviest = Math.max(...hits.map((h) => h.momentum));
    expect(heaviest).toBeGreaterThan(50_000); // the storeys above, a few metres a second
    const parts = hits.map((h) => h.part);
    expect(new Set(parts).size).toBe(parts.length);
    // A kinematic body never gives: the storeys above rest on the character's head.
    // The first floor's slab chunk right over the character.
    const over = r.d.pieces.find((p) => p.kind === 'slab' && p.min[1] > 2.9 && p.min[1] < 3 && p.min[0] < 0 && p.max[0] > 0 && p.min[2] < -1.5 && p.max[2] > -1.5)!;
    const m = new THREE.Matrix4();
    const lowestSlab = (): number => new THREE.Vector3(...over.centroid).applyMatrix4(r.d.debris.restToWorld(over.id, m)).y;
    const held = lowestSlab();
    expect(held).toBeGreaterThan(1.5);
    // The game takes it away (killed, ragdolled): the floor comes the rest of the way down.
    stop();
    r.entities.destroy(below);
    r.frames(120);
    expect(lowestSlab()).toBeLessThan(held - 0.5);
    r.dispose();
  }, 60_000);

  it('nothing is reported for a character nothing falls on', async () => {
    const r = await rig();
    const away = r.character(20, 0.85, 0);
    const hits: Array<DestructionEvents['hit']> = [];
    r.d.events.on('hit', (h) => hits.push(h));
    Destruction.watchHits(r.physics, away);
    r.d.remove(groundStorey(r.d));
    r.frames(180);
    expect(hits).toHaveLength(0);
    r.dispose();
  }, 60_000);

  it('gas can be read where a character breathes, over every structure, until it clears', async () => {
    const r = await rig();
    const head = { x: 0, y: 1.6, z: -1.5 };
    expect(Destruction.densityAt(r.entities, 'gas', head)).toBe(0);
    r.d.smoke('gas', { x: 0, y: 1, z: -1.5 });
    r.frames(120);
    expect(Destruction.densityAt(r.entities, 'gas', head)).toBeGreaterThan(0.5);
    expect(Destruction.densityAt(r.entities, 'smoke', head)).toBe(0);
    // Well outside the 4.5 m cloud.
    expect(Destruction.densityAt(r.entities, 'gas', { x: 0, y: 1.6, z: -12 })).toBe(0);
    // Gas lasts 8 s.
    r.frames(60 * 8);
    expect(Destruction.densityAt(r.entities, 'gas', head)).toBe(0);
    r.dispose();
  }, 60_000);

  it('a grenade belongs to the structure it lands by', async () => {
    const r = await rig();
    const other = new Destruction({ entities: r.entities, physics: r.physics, random: new Random(9) }, { pieces: buildBuilding({ x: 30 }).pieces });
    expect(Destruction.all(r.entities)).toHaveLength(2);
    expect(Destruction.nearest(r.entities, { x: 0, y: 1, z: -6 })).toBe(r.d);
    expect(Destruction.nearest(r.entities, { x: 33, y: 1, z: 0 })).toBe(other);
    expect(Destruction.nearest(r.entities, { x: 50, y: 1, z: 0 })).toBe(other);
    other.dispose();
    expect(Destruction.all(r.entities)).toHaveLength(1);
    r.dispose();
  });
});
