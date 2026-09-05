import { beforeAll, describe, expect, it } from 'vitest';
import { Transform } from '../src/ecs/components/Transform';
import { EntityWorld } from '../src/ecs/EntityWorld';
import { CharacterController } from '../src/physics/CharacterController';
import { Character, RigidBody } from '../src/physics/components';
import { Layers } from '../src/physics/Layers';
import { PhysicsWorld, initRapier, type PhysicsPair } from '../src/physics/PhysicsWorld';
import { createPhysicsSystems } from '../src/physics/systems';

const HZ = 60;
const DT = 1 / HZ;

interface Fixture {
  entities: EntityWorld;
  physics: PhysicsWorld;
  tick(n?: number): void;
  dispose(): void;
}

async function fixture(): Promise<Fixture> {
  const entities = new EntityWorld({ capacity: 256 });
  const physics = await PhysicsWorld.create({ entities, fixedStepHz: HZ });
  physics.layers.define('world', 'player', 'debris', 'trigger');
  for (const s of createPhysicsSystems(physics)) entities.addSystem(s);
  return {
    entities,
    physics,
    tick(n = 1): void {
      for (let i = 0; i < n; i++) entities.runStage('fixed', DT);
    },
    dispose(): void {
      entities.dispose();
      physics.dispose();
    },
  };
}

function addGround(f: Fixture, size = 20): number {
  const eid = f.entities.create([Transform, { y: -0.5 }]);
  f.physics.addBody(eid, { type: 'fixed', shape: { kind: 'box', hx: size, hy: 0.5, hz: size }, layer: 'world' });
  return eid;
}

beforeAll(async () => {
  await initRapier();
});

describe('Layers', () => {
  it('packs membership and filter into Rapier interaction groups', () => {
    const layers = new Layers();
    layers.define('a', 'b', 'c');
    layers.define('a'); // idempotent
    expect(layers.bit('default')).toBe(1);
    expect(layers.bit('a')).toBe(2);
    expect(layers.mask(['a', 'c'])).toBe(2 | 8);
    expect(layers.groups('a', ['b', 'c'])).toBe((2 << 16) | 12);
    expect(layers.groups('a', 'all')).toBe(((2 << 16) | 0xffff) >>> 0);
    expect(layers.queryGroups('b')).toBe(((0xffff << 16) | 4) >>> 0);
    // Unknown names define themselves on first use, so declaration order never matters.
    expect(layers.bit('nope')).toBe(16);
    expect(layers.has('nope')).toBe(true);
    for (let i = 0; i < 11; i++) layers.define(`l${i}`);
    expect(() => layers.define('overflow')).toThrow(/at most 16/);
  });
});

describe('PhysicsWorld', () => {
  it('creates a world at the fixed step and rejects a mismatched dt', async () => {
    const f = await fixture();
    expect(f.physics.fixedStep).toBeCloseTo(DT);
    expect(f.physics.raw.timestep).toBeCloseTo(DT);
    expect(f.physics.gravity.y).toBeCloseTo(-9.81);
    expect(() => f.physics.step(1 / 30)).toThrow(/fixed step/);
    f.physics.gravity = { x: 0, y: -5, z: 0 };
    expect(f.physics.raw.gravity.y).toBe(-5);
    await expect(PhysicsWorld.create({ entities: f.entities, fixedStepHz: 0 })).rejects.toThrow(/positive integer/);
    f.dispose();
  });

  it('drops a dynamic box onto fixed ground and lets it rest at the expected height', async () => {
    const f = await fixture();
    addGround(f);
    const box = f.entities.create([Transform, { y: 4 }]);
    f.physics.addBody(box, { type: 'dynamic', shape: { kind: 'box', hx: 0.5, hy: 0.5, hz: 0.5 }, layer: 'debris' });
    const rb = f.entities.store(RigidBody);
    expect(rb.type[box]).toBe(0);
    f.tick(240);
    const t = f.entities.store(Transform);
    expect(t.y[box]).toBeCloseTo(0.5, 1);
    expect(Math.abs(t.x[box] ?? 0)).toBeLessThan(0.05);
    expect(f.physics.getVelocity(box).y).toBeCloseTo(0, 2);
    f.tick(600);
    expect(rb.sleeping[box]).toBe(1);
    expect(f.physics.isSleeping(box)).toBe(true);
    f.physics.applyImpulse(box, { x: 0, y: 5, z: 0 });
    expect(f.physics.isSleeping(box)).toBe(false);
    f.dispose();
  });

  it('raycasts against the box with the right distance and normal', async () => {
    const f = await fixture();
    addGround(f);
    const box = f.entities.create([Transform, { y: 0.5 }]);
    f.physics.addBody(box, { type: 'fixed', shape: { kind: 'box', hx: 0.5, hy: 0.5, hz: 0.5 }, layer: 'debris' });
    f.tick(1);
    const hit = f.physics.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -2, z: 0 }, 100);
    expect(hit).not.toBeNull();
    expect(hit?.eid).toBe(box);
    expect(hit?.distance).toBeCloseTo(4, 4);
    expect(hit?.point.y).toBeCloseTo(1, 4);
    expect(hit?.normal.y).toBeCloseTo(1, 4);
    // Layer filter skips the box and reaches the ground.
    const ground = f.physics.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 100, { layers: 'world' });
    expect(ground?.distance).toBeCloseTo(5, 4);
    // Exclusion by entity.
    const excluded = f.physics.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 100, { excludeEid: box });
    expect(excluded?.eid).not.toBe(box);
    expect(f.physics.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 2)).toBeNull();
    expect(f.physics.sphereOverlap({ x: 0, y: 0.5, z: 0 }, 0.2)).toEqual([box]);
    expect(f.physics.sphereOverlap({ x: 0, y: 0.5, z: 0 }, 0.2, 'world')).toEqual([]);
    f.dispose();
  });

  it('emits triggerEnter then triggerExit as a body falls through a sensor', async () => {
    const f = await fixture();
    addGround(f);
    const sensor = f.entities.create([Transform, { y: 3 }]);
    f.physics.addBody(sensor, {
      type: 'fixed',
      shape: { kind: 'box', hx: 1, hy: 0.5, hz: 1 },
      layer: 'trigger',
      collidesWith: ['debris', 'player'],
      isSensor: true,
    });
    const ball = f.entities.create([Transform, { y: 8 }]);
    f.physics.addBody(ball, { type: 'dynamic', shape: { kind: 'sphere', radius: 0.25 }, layer: 'debris', events: false });
    const log: string[] = [];
    f.physics.events.on('triggerEnter', (p: PhysicsPair) => log.push(`enter ${p.a}:${p.b}`));
    f.physics.events.on('triggerExit', (p: PhysicsPair) => log.push(`exit ${p.a}:${p.b}`));
    f.physics.events.on('collisionStart', () => log.push('collision'));
    f.tick(180);
    // Enter, exit, then the ball lands on the ground (a real contact, reported because the ground has events on).
    expect(log).toEqual([`enter ${sensor}:${ball}`, `exit ${sensor}:${ball}`, 'collision']);
    expect(f.entities.store(Transform).y[ball]).toBeCloseTo(0.25, 1);
    f.dispose();
  });

  it('reports contacts between solid bodies and ends them on destroy', async () => {
    const f = await fixture();
    const ground = addGround(f);
    const box = f.entities.create([Transform, { y: 0.6 }]);
    f.physics.addBody(box, { type: 'dynamic', shape: { kind: 'box', hx: 0.5, hy: 0.5, hz: 0.5 } });
    const starts: PhysicsPair[] = [];
    const ends: PhysicsPair[] = [];
    f.physics.events.on('collisionStart', (p) => starts.push(p));
    f.physics.events.on('collisionEnd', (p) => ends.push(p));
    f.tick(30);
    expect(starts).toEqual([{ a: Math.min(ground, box), b: Math.max(ground, box) }]);
    expect(f.physics.isTouching(ground, box)).toBe(true);
    f.entities.destroy(box);
    expect(ends).toEqual(starts);
    expect(f.physics.isTouching(ground, box)).toBe(false);
    f.tick(2);
    expect(ends.length).toBe(1);
    f.dispose();
  });

  it('a kinematic body sweeping through a sensor triggers it', async () => {
    const f = await fixture();
    const sensor = f.entities.create([Transform, { x: 3, y: 1 }]);
    f.physics.addBody(sensor, { type: 'fixed', shape: { kind: 'box', hx: 0.5, hy: 1, hz: 0.5 }, layer: 'trigger', isSensor: true });
    const mover = f.entities.create([Transform, { y: 1 }]);
    f.physics.addBody(mover, { type: 'kinematicPosition', shape: { kind: 'capsule', halfHeight: 0.5, radius: 0.3 }, layer: 'player' });
    const log: string[] = [];
    f.physics.events.on('triggerEnter', () => log.push('enter'));
    f.physics.events.on('triggerExit', () => log.push('exit'));
    const t = f.entities.store(Transform);
    for (let i = 0; i < 120; i++) {
      t.x[mover] = (t.x[mover] ?? 0) + 0.05; // 3 m/s via Transform → kinematic push
      f.tick(1);
    }
    expect(log).toEqual(['enter', 'exit']);
    expect(t.x[mover]).toBeCloseTo(6, 3);
    f.dispose();
  });

  it('is deterministic: identical ops give identical positions after 120 steps', async () => {
    const run = async (): Promise<number[]> => {
      const f = await fixture();
      addGround(f);
      const ramp = f.entities.create([Transform, { x: 2, y: 0.5, qz: Math.sin(0.15), qw: Math.cos(0.15) }]);
      f.physics.addBody(ramp, { type: 'fixed', shape: { kind: 'box', hx: 3, hy: 0.2, hz: 3 }, layer: 'world' });
      const ids: number[] = [];
      for (let i = 0; i < 40; i++) {
        const eid = f.entities.create([Transform, { x: (i % 5) * 0.9 - 1.8, y: 3 + Math.floor(i / 5) * 1.1, z: ((i * 7) % 5) * 0.8 - 1.6 }]);
        f.physics.addBody(eid, {
          type: 'dynamic',
          shape: i % 2 ? { kind: 'sphere', radius: 0.35 } : { kind: 'box', hx: 0.35, hy: 0.35, hz: 0.35 },
          layer: 'debris',
          restitution: 0.2,
        });
        ids.push(eid);
      }
      f.tick(120);
      const t = f.entities.store(Transform);
      const out = ids.flatMap((eid) => [t.x[eid] ?? 0, t.y[eid] ?? 0, t.z[eid] ?? 0, t.qx[eid] ?? 0, t.qw[eid] ?? 0]);
      f.dispose();
      return out;
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    expect(a.some((v) => v !== 0)).toBe(true);
  });

  it('destroying an entity removes its body from the Rapier world', async () => {
    const f = await fixture();
    addGround(f);
    const box = f.entities.create([Transform, { y: 2 }]);
    f.physics.addBody(box, { type: 'dynamic', shape: { kind: 'box', hx: 0.5, hy: 0.5, hz: 0.5 } });
    expect(f.physics.raw.bodies.len()).toBe(2);
    expect(f.physics.bodyCount).toBe(2);
    expect(() => f.physics.addBody(box, { type: 'dynamic', shape: { kind: 'sphere', radius: 1 } })).toThrow(/already has a body/);
    f.entities.destroy(box);
    expect(f.physics.raw.bodies.len()).toBe(1);
    expect(f.physics.hasBody(box)).toBe(false);
    f.tick(1);
    // removeBody keeps the entity but drops the component and the body.
    const other = f.entities.create([Transform, { y: 2 }]);
    f.physics.addBody(other, { type: 'dynamic', shape: { kind: 'sphere', radius: 0.5 } });
    f.physics.removeBody(other);
    expect(f.physics.raw.bodies.len()).toBe(1);
    expect(f.entities.exists(other)).toBe(true);
    expect(f.entities.has(other, RigidBody)).toBe(false);
    f.dispose();
  });

  it('kinematic targets move the body and dynamic bodies rest on it', async () => {
    const f = await fixture();
    const platform = f.entities.create([Transform, { y: 0 }]);
    f.physics.addBody(platform, { type: 'kinematicPosition', shape: { kind: 'box', hx: 2, hy: 0.25, hz: 2 } });
    const box = f.entities.create([Transform, { y: 1 }]);
    f.physics.addBody(box, { type: 'dynamic', shape: { kind: 'box', hx: 0.25, hy: 0.25, hz: 0.25 } });
    f.tick(60);
    const t = f.entities.store(Transform);
    expect(t.y[box]).toBeCloseTo(0.5, 1);
    for (let i = 1; i <= 60; i++) {
      f.physics.setKinematicTarget(platform, { x: 0, y: i * 0.02, z: 0 });
      f.tick(1);
    }
    expect(t.y[platform]).toBeCloseTo(1.2, 3);
    expect(t.y[box]).toBeGreaterThan(1.5);
    f.dispose();
  });
});

describe('CharacterController', () => {
  async function playerFixture(): Promise<Fixture & { player: number; controller: CharacterController }> {
    const f = await fixture();
    addGround(f);
    const player = f.entities.create([Transform, { x: 0, y: 1.0, z: 0 }]);
    f.physics.addBody(player, {
      type: 'kinematicPosition',
      shape: { kind: 'capsule', halfHeight: 0.5, radius: 0.3 },
      layer: 'player',
      collidesWith: ['world', 'debris'],
    });
    const controller = new CharacterController(f.physics, { stepHeight: 0.35, snapToGround: 0.3 });
    controller.attach(player);
    return { ...f, player, controller };
  }

  it('walks up a low step and stays grounded', async () => {
    const f = await playerFixture();
    const step = f.entities.create([Transform, { x: 3, y: 0.125 }]);
    f.physics.addBody(step, { type: 'fixed', shape: { kind: 'box', hx: 1, hy: 0.125, hz: 2 }, layer: 'world' });
    const t = f.entities.store(Transform);
    // Fall the small gap onto the ground first.
    for (let i = 0; i < 30; i++) {
      f.controller.move(f.player, { x: 0, y: 0, z: 0 }, DT);
      f.tick(1);
    }
    expect(f.controller.isGrounded(f.player)).toBe(true);
    expect(t.y[f.player]).toBeCloseTo(0.8, 1);
    // 3 m/s for 1 s: the capsule (radius 0.3) ends up standing on the step (x in [2, 4]),
    // a little short of x=3 because the autostep costs some horizontal travel.
    for (let i = 0; i < 60; i++) {
      f.controller.move(f.player, { x: 3 * DT, y: 0, z: 0 }, DT);
      f.tick(1);
    }
    expect(t.x[f.player]).toBeGreaterThan(2.3);
    expect(t.x[f.player]).toBeLessThan(3.5);
    expect(t.y[f.player]).toBeCloseTo(0.8 + 0.25, 1);
    expect(f.controller.isGrounded(f.player)).toBe(true);
    expect(f.entities.store(Character).grounded[f.player]).toBe(1);
    // The kinematic body followed the Transform through the push system.
    expect(f.physics.rawBody(f.player)?.translation().y).toBeCloseTo(t.y[f.player] ?? 0, 5);
    f.dispose();
  });

  it('stops at a wall', async () => {
    const f = await playerFixture();
    const wall = f.entities.create([Transform, { x: 3, y: 1.5 }]);
    f.physics.addBody(wall, { type: 'fixed', shape: { kind: 'box', hx: 0.25, hy: 1.5, hz: 3 }, layer: 'world' });
    const t = f.entities.store(Transform);
    for (let i = 0; i < 180; i++) {
      f.controller.move(f.player, { x: 4 * DT, y: 0, z: 0 }, DT);
      f.tick(1);
    }
    // Capsule radius 0.3 + wall half-thickness 0.25 + offset: front face at x=2.75.
    expect(t.x[f.player]).toBeLessThan(2.75 - 0.3 + 0.01);
    expect(t.x[f.player]).toBeGreaterThan(2.75 - 0.3 - 0.1);
    expect(f.controller.isGrounded(f.player)).toBe(true);
    f.dispose();
  });

  it('jumps only when grounded and lands again', async () => {
    const f = await playerFixture();
    const t = f.entities.store(Transform);
    for (let i = 0; i < 30; i++) {
      f.controller.move(f.player, { x: 0, y: 0, z: 0 }, DT);
      f.tick(1);
    }
    const restY = t.y[f.player] ?? 0;
    expect(f.controller.jump(f.player, 8)).toBe(true);
    expect(f.controller.jump(f.player, 8)).toBe(false);
    let peak = restY;
    for (let i = 0; i < 120; i++) {
      f.controller.move(f.player, { x: 0, y: 0, z: 0 }, DT);
      f.tick(1);
      peak = Math.max(peak, t.y[f.player] ?? 0);
    }
    expect(peak).toBeGreaterThan(restY + 1);
    expect(t.y[f.player]).toBeCloseTo(restY, 2);
    expect(f.controller.isGrounded(f.player)).toBe(true);
    f.controller.dispose();
    expect(f.entities.has(f.player, Character)).toBe(false);
    f.dispose();
  });
});

describe('PhysicsWorld.setCapsule', () => {
  it('resizes a capsule in place so a ray from above meets the new top', async () => {
    const f = await fixture();
    const eid = f.entities.create([Transform, { y: 0.9 }]);
    f.physics.addBody(eid, { type: 'kinematicPosition', shape: { kind: 'capsule', halfHeight: 0.5, radius: 0.4 }, layer: 'player' });
    f.tick(1);
    const before = f.physics.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 10, { layers: 'player' });
    expect(before?.point.y).toBeCloseTo(1.8, 1);
    f.physics.setCapsule(eid, 0.05, 0.25);
    f.tick(1);
    const after = f.physics.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 10, { layers: 'player' });
    expect(after?.point.y).toBeCloseTo(0.9 + 0.3, 1);
    const box = f.entities.create([Transform, { x: 5 }]);
    f.physics.addBody(box, { type: 'fixed', shape: { kind: 'box', hx: 1, hy: 1, hz: 1 }, layer: 'world' });
    expect(() => f.physics.setCapsule(box, 1, 1)).toThrow(/not a capsule/);
    f.dispose();
  });
});
