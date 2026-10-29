import { beforeAll, describe, expect, it } from 'vitest';
import { Transform } from '../src/ecs/components/Transform';
import { EntityWorld } from '../src/ecs/EntityWorld';
import { SHARD_CAPACITY } from '../src/physics/Bodies';
import { PhysicsWorld, initRapier, type PhysicsPair } from '../src/physics/PhysicsWorld';
import { createPhysicsSystems } from '../src/physics/systems';
import { NO_PART, type BodyHandle, type ColliderHandle, type JointHandle } from '../src/physics/types';

const HZ = 60;
const DT = 1 / HZ;

interface Fixture {
  entities: EntityWorld;
  physics: PhysicsWorld;
  tick(n?: number): void;
  dispose(): void;
}

async function fixture(gravity = -9.81): Promise<Fixture> {
  const entities = new EntityWorld({ capacity: 4096 });
  const physics = await PhysicsWorld.create({ entities, fixedStepHz: HZ, gravity: { x: 0, y: gravity, z: 0 } });
  physics.layers.define('world', 'debris');
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

function addGround(f: Fixture, events = true): number {
  const eid = f.entities.create([Transform, { y: -0.5 }]);
  f.physics.addBody(eid, { type: 'fixed', shape: { kind: 'box', hx: 50, hy: 0.5, hz: 50 }, layer: 'world', events });
  return eid;
}

/** An axis-aligned cube as a convex mesh: 8 corners, 12 outward-wound triangles. */
function cubeMesh(cx: number, cy: number, cz: number, h: number): { vertices: Float32Array; indices: Uint32Array } {
  const vertices = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    vertices[i * 3] = cx + (i & 1 ? h : -h);
    vertices[i * 3 + 1] = cy + (i & 2 ? h : -h);
    vertices[i * 3 + 2] = cz + (i & 4 ? h : -h);
  }
  const indices = new Uint32Array([0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6]);
  return { vertices, indices };
}

/** The same cube as a bare point cloud, for a hull. */
function cubePoints(cx: number, cy: number, cz: number, h: number): Float32Array {
  return cubeMesh(cx, cy, cz, h).vertices;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
}

function events(f: Fixture): string[] {
  const log: string[] = [];
  f.physics.events.on('collisionStart', (p: PhysicsPair) => log.push(`start ${p.a}:${p.b}`));
  f.physics.events.on('collisionEnd', (p: PhysicsPair) => log.push(`end ${p.a}:${p.b}`));
  f.physics.events.on('triggerEnter', (p: PhysicsPair) => log.push(`enter ${p.a}:${p.b}`));
  f.physics.events.on('triggerExit', (p: PhysicsPair) => log.push(`exit ${p.a}:${p.b}`));
  return log;
}

beforeAll(async () => {
  await initRapier();
});

describe('Bodies: compound bodies and convex shapes', () => {
  it('a dynamic body with offset colliders falls as one and rests on both', async () => {
    const f = await fixture();
    addGround(f);
    const owner = f.entities.create();
    const b = f.physics.bodies.create({ type: 'dynamic', position: { x: 0, y: 3, z: 0 }, ccd: true, linearDamping: 0.1, angularDamping: 0.1 });
    // A dumbbell: two half-metre cubes a metre either side of the origin.
    const left = f.physics.bodies.addCollider(b, { shape: { kind: 'box', hx: 0.25, hy: 0.25, hz: 0.25 }, owner, part: 0, position: { x: -1, y: 0, z: 0 }, density: 2 });
    const right = f.physics.bodies.addCollider(b, { shape: { kind: 'box', hx: 0.25, hy: 0.25, hz: 0.25 }, owner, part: 1, position: { x: 1, y: 0, z: 0 }, density: 2 });
    expect(f.physics.bodies.colliders(b)).toEqual([left, right]);
    // Two 0.125 m³ cubes at density 2.
    expect(f.physics.bodies.mass(b)).toBeCloseTo(0.5, 5);
    f.tick(240);
    const p = { x: 0, y: 0, z: 0 };
    const q = { x: 0, y: 0, z: 0, w: 1 };
    expect(f.physics.bodies.pose(b, p, q)).toBe(true);
    expect(p.y).toBeCloseTo(0.25, 1);
    expect(Math.abs(q.x) + Math.abs(q.z)).toBeLessThan(0.02); // level: both ends down
    const lp = { x: 0, y: 0, z: 0 };
    f.physics.bodies.colliderPose(left, lp);
    expect(lp.x).toBeCloseTo(p.x - 1, 1);
    expect(lp.y).toBeCloseTo(0.25, 1);
    expect(f.physics.bodies.info(right)).toMatchObject({ body: b, owner, part: 1 });
    f.dispose();
  });

  it('a fixed compound places colliders at their offsets and rotations (rubble)', async () => {
    const f = await fixture();
    const owner = f.entities.create();
    const rubble = f.physics.bodies.create({ type: 'fixed' });
    const s = Math.sin(Math.PI / 8);
    const c = Math.cos(Math.PI / 8);
    // A cube turned 45° about y: its corner faces down the x axis at 0.5·√2.
    f.physics.bodies.addCollider(rubble, { shape: { kind: 'convexMesh', ...cubeMesh(0, 0, 0, 0.5) }, owner, part: 7, position: { x: 4, y: 1, z: 0 }, rotation: { x: 0, y: s, z: 0, w: c } });
    f.tick(1);
    const hit = f.physics.raycast({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 10);
    expect(hit).toMatchObject({ eid: owner, part: 7, body: rubble });
    expect(hit?.distance).toBeCloseTo(4 - 0.5 * Math.SQRT2, 3);
    // Fixed bodies made here hold no mass.
    expect(f.physics.bodies.mass(rubble)).toBe(0);
    f.dispose();
  });

  it('builds convex hulls and convex meshes, and refuses a flat hull', async () => {
    const f = await fixture();
    addGround(f);
    const owner = f.entities.create();
    const hull = f.physics.bodies.create({ type: 'dynamic', position: { x: -2, y: 2, z: 0 } });
    f.physics.bodies.addCollider(hull, { shape: { kind: 'convexHull', points: cubePoints(0, 0, 0, 0.5) }, owner, part: 1 });
    const mesh = f.physics.bodies.create({ type: 'dynamic', position: { x: 2, y: 2, z: 0 } });
    f.physics.bodies.addCollider(mesh, { shape: { kind: 'convexMesh', ...cubeMesh(0, 0, 0, 0.5) }, owner, part: 2 });
    // A unit cube either way: density 1, mass 1.
    expect(f.physics.bodies.mass(hull)).toBeCloseTo(1, 4);
    expect(f.physics.bodies.mass(mesh)).toBeCloseTo(1, 4);
    f.tick(180);
    const p = { x: 0, y: 0, z: 0 };
    f.physics.bodies.pose(hull, p);
    expect(p.y).toBeCloseTo(0.5, 1);
    f.physics.bodies.pose(mesh, p);
    expect(p.y).toBeCloseTo(0.5, 1);
    expect(f.physics.raycast({ x: 2, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 10)).toMatchObject({ eid: owner, part: 2, body: mesh });
    const flat = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1]);
    expect(() => f.physics.bodies.addCollider(hull, { shape: { kind: 'convexHull', points: flat }, owner })).toThrow(/no volume/);
    const line = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    expect(() => f.physics.bodies.addCollider(hull, { shape: { kind: 'convexHull', points: line }, owner })).toThrow(/no volume/);
    expect(f.physics.bodies.colliders(hull).length).toBe(1);
    expect(f.physics.bodies.mass(hull)).toBeCloseTo(1, 4);
    // The entity API takes the new shapes too.
    const crate = f.entities.create([Transform, { x: 6, y: 2 }]);
    f.physics.addBody(crate, { type: 'dynamic', shape: { kind: 'convexHull', points: cubePoints(0, 0, 0, 0.5) } });
    f.tick(120);
    expect(f.entities.store(Transform).y[crate]).toBeCloseTo(0.5, 1);
    f.dispose();
  });

  it('removing a collider from a fixed body leaves bodies elsewhere asleep and drops what it held', async () => {
    const f = await fixture();
    addGround(f);
    const building = f.entities.create();
    const slab = f.physics.bodies.create({ type: 'fixed' });
    const under: ColliderHandle[] = [];
    for (let i = 0; i < 8; i++) {
      under.push(f.physics.bodies.addCollider(slab, { shape: { kind: 'box', hx: 0.5, hy: 0.5, hz: 0.5 }, owner: building, part: i, position: { x: i * 3, y: 0.5, z: 0 } }));
    }
    const crates = [0, 7].map((i) => {
      const c = f.physics.bodies.create({ type: 'dynamic', position: { x: i * 3, y: 1.5, z: 0 } });
      f.physics.bodies.addCollider(c, { shape: { kind: 'box', hx: 0.4, hy: 0.4, hz: 0.4 }, owner: building, part: 100 + i });
      return c;
    });
    f.tick(300);
    expect(crates.map((c) => f.physics.bodies.isSleeping(c))).toEqual([true, true]);
    f.physics.bodies.removeCollider(under[0] as ColliderHandle); // wake = false
    f.tick(60);
    const p = { x: 0, y: 0, z: 0 };
    f.physics.bodies.pose(crates[0] as BodyHandle, p);
    expect(p.y).toBeCloseTo(0.4, 1); // its support went: it fell to the ground
    expect(f.physics.bodies.isSleeping(crates[1] as BodyHandle)).toBe(true); // the far one never woke
    f.dispose();
  });
});

describe('Joints', () => {
  it('a rope is slack below its length and holds at it', async () => {
    const f = await fixture();
    const owner = f.entities.create();
    const hook = f.physics.bodies.create({ type: 'fixed', position: { x: 0, y: 5, z: 0 } });
    const weight = f.physics.bodies.create({ type: 'dynamic', position: { x: 0, y: 4.5, z: 0 } });
    f.physics.bodies.addCollider(weight, { shape: { kind: 'sphere', radius: 0.25 }, owner });
    const rope = f.physics.joints.create(hook, weight, { kind: 'rope', anchorA: { x: 0, y: 0, z: 0 }, anchorB: { x: 0, y: 0, z: 0 }, length: 2 });
    expect(f.physics.joints.kind(rope)).toBe('rope');
    const p = { x: 0, y: 0, z: 0 };
    f.tick(10);
    f.physics.bodies.pose(weight, p);
    // Free fall for 1/6 s: a spherical joint would have held it at 4.5.
    expect(p.y).toBeCloseTo(4.5 - 0.5 * 9.81 * (10 / 60) ** 2, 1);
    let lowest = Infinity;
    for (let i = 0; i < 240; i++) {
      f.tick(1);
      f.physics.bodies.pose(weight, p);
      lowest = Math.min(lowest, p.y);
    }
    expect(p.y).toBeCloseTo(3, 1);
    expect(lowest).toBeGreaterThan(3 - 0.1);
    f.physics.joints.remove(rope);
    f.tick(30);
    f.physics.bodies.pose(weight, p);
    expect(p.y).toBeLessThan(2.5);
    f.dispose();
  });

  it('contacts: false lets joined bodies overlap; the default keeps them apart', async () => {
    const separation = async (contacts: boolean | undefined): Promise<number> => {
      const f = await fixture(0);
      const owner = f.entities.create();
      const a = f.physics.bodies.create({ type: 'dynamic', position: { x: 0, y: 2, z: 0 } });
      const b = f.physics.bodies.create({ type: 'dynamic', position: { x: 0.6, y: 2, z: 0 } });
      f.physics.bodies.addCollider(a, { shape: { kind: 'box', hx: 0.5, hy: 0.5, hz: 0.5 }, owner, part: 0 });
      f.physics.bodies.addCollider(b, { shape: { kind: 'box', hx: 0.5, hy: 0.5, hz: 0.5 }, owner, part: 1 });
      // A slack rope: it only matters through its contacts flag.
      const opts = contacts === undefined ? {} : { contacts };
      f.physics.joints.create(a, b, { kind: 'rope', anchorA: { x: 0, y: 0, z: 0 }, anchorB: { x: 0, y: 0, z: 0 }, length: 5, ...opts });
      f.tick(60);
      const pa = { x: 0, y: 0, z: 0 };
      const pb = { x: 0, y: 0, z: 0 };
      f.physics.bodies.pose(a, pa);
      f.physics.bodies.pose(b, pb);
      f.dispose();
      return Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
    };
    expect(await separation(false)).toBeCloseTo(0.6, 3);
    expect(await separation(undefined)).toBeGreaterThan(0.95);
    expect(await separation(true)).toBeGreaterThan(0.95);
  });

  it("keeps its own per-body index exact through heavy churn, and a body's joints go with it", async () => {
    const f = await fixture(0);
    const owner = f.entities.create();
    let seed = 12345;
    const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const bodies: BodyHandle[] = [];
    const make = (): void => {
      const b = f.physics.bodies.create({ type: 'dynamic', position: { x: rnd() * 40, y: rnd() * 40, z: rnd() * 40 } });
      f.physics.bodies.addCollider(b, { shape: { kind: 'sphere', radius: 0.2 }, owner });
      bodies.push(b);
    };
    const hub = f.physics.bodies.create({ type: 'fixed' });
    for (let i = 0; i < 120; i++) make();
    // The truth, kept beside the engine: joint → its two bodies.
    const truth = new Map<JointHandle, [BodyHandle, BodyHandle]>();
    const pick = (): BodyHandle => bodies[Math.floor(rnd() * bodies.length)] as BodyHandle;
    for (let round = 0; round < 200; round++) {
      for (let k = 0; k < 6; k++) {
        const a = rnd() < 0.3 ? hub : pick();
        const b = pick();
        if (a === b) continue;
        const kind = rnd() < 0.5 ? 'spherical' : 'rope';
        const j =
          kind === 'rope'
            ? f.physics.joints.create(a, b, { kind, anchorA: { x: 0, y: 0, z: 0 }, anchorB: { x: 0, y: 0.1, z: 0 }, length: 1, contacts: rnd() < 0.5 })
            : f.physics.joints.create(a, b, { kind, anchorA: { x: 0, y: 0, z: 0 }, anchorB: { x: 0, y: 0.1, z: 0 } });
        truth.set(j, [a, b]);
      }
      for (let k = 0; k < 2 && truth.size > 0; k++) {
        const j = [...truth.keys()][Math.floor(rnd() * truth.size)] as JointHandle;
        expect(f.physics.joints.remove(j)).toBe(true);
        truth.delete(j);
      }
      // A body goes, taking its joints; another takes its place.
      const i = Math.floor(rnd() * bodies.length);
      const gone = bodies[i] as BodyHandle;
      bodies.splice(i, 1);
      expect(f.physics.bodies.destroy(gone)).toBe(true);
      for (const [j, [a, b]] of truth) if (a === gone || b === gone) truth.delete(j);
      make();
      f.tick(1);
    }
    const expected = new Map<BodyHandle, JointHandle[]>();
    for (const [j, [a, b]] of truth) {
      for (const body of [a, b]) expected.set(body, [...(expected.get(body) ?? []), j]);
    }
    for (const body of [hub, ...bodies]) {
      expect(f.physics.joints.of(body).sort((x, y) => x - y)).toEqual((expected.get(body) ?? []).sort((x, y) => x - y));
      expect(f.physics.joints.countOf(body)).toBe(expected.get(body)?.length ?? 0);
    }
    expect(f.physics.joints.count).toBe(truth.size);
    expect(f.physics.jointCount).toBe(truth.size);
    expect(f.physics.raw.impulseJoints.len()).toBe(truth.size);
    for (const [j, [a, b]] of truth) expect(f.physics.joints.anchors(j)).toMatchObject({ bodyA: a, bodyB: b, anchorB: { x: 0, y: 0.1, z: 0 } });
    expect(truth.size).toBeGreaterThan(100);
    f.dispose();
  });
});

describe('Queries name the owner and the part', () => {
  /** A wall of eight chunks along x, all owned by one building, on one fixed body; and a loose chunk body. */
  async function wall(): Promise<Fixture & { building: number; body: BodyHandle; chunks: ColliderHandle[]; loose: BodyHandle; looseChunk: ColliderHandle }> {
    const f = await fixture(0);
    const building = f.entities.create();
    const body = f.physics.bodies.create({ type: 'fixed' });
    const chunks: ColliderHandle[] = [];
    for (let i = 0; i < 8; i++) {
      chunks.push(f.physics.bodies.addCollider(body, { shape: { kind: 'convexMesh', ...cubeMesh(0, 0, 0, 0.5) }, owner: building, part: i, position: { x: i + 0.5, y: 0.5, z: 0 }, layer: 'world' }));
    }
    const loose = f.physics.bodies.create({ type: 'dynamic', position: { x: 4.5, y: 3, z: 0 } });
    const looseChunk = f.physics.bodies.addCollider(loose, { shape: { kind: 'convexMesh', ...cubeMesh(0, 0, 0, 0.5) }, owner: building, part: 99, layer: 'debris' });
    f.tick(1);
    return { ...f, building, body, chunks, loose, looseChunk };
  }

  it('a raycast hits the chunk, and after it goes, the chunk behind it', async () => {
    const f = await wall();
    const along = (opts = {}) => f.physics.raycast({ x: -5, y: 0.5, z: 0 }, { x: 1, y: 0, z: 0 }, 50, opts);
    expect(along()).toMatchObject({ eid: f.building, part: 0, body: f.body, collider: f.chunks[0] });
    expect(along()?.distance).toBeCloseTo(5, 4);
    f.physics.bodies.removeCollider(f.chunks[0] as ColliderHandle);
    f.tick(1);
    expect(along()).toMatchObject({ part: 1, distance: expect.closeTo(6, 4) });
    // Exclusions: one collider, a whole body, an owner on bodies that are not its own.
    expect(along({ excludeCollider: f.chunks[1] })?.part).toBe(2);
    expect(along({ excludeBody: f.body })).toBeNull();
    const down = (opts = {}) => f.physics.raycast({ x: 4.5, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 50, opts);
    expect(down()).toMatchObject({ eid: f.building, part: 99, body: f.loose });
    expect(down({ excludeBody: f.loose })?.part).toBe(4);
    expect(down({ excludeEid: f.building })).toBeNull();
    expect(down({ layers: 'world' })?.part).toBe(4);
    f.dispose();
  });

  it('overlapShape reports owner and part and honours every exclusion', async () => {
    const f = await wall();
    const seen = (shape: Parameters<PhysicsWorld['overlapShape']>[0], position: { x: number; y: number; z: number }, opts = {}) => {
      const parts: number[] = [];
      f.physics.overlapShape(shape, { position }, (_c, owner, part) => {
        expect(owner).toBe(f.building);
        parts.push(part);
      }, opts);
      return parts.sort((a, b) => a - b);
    };
    // A box over chunks 2..4.
    const box = { kind: 'box' as const, hx: 1.4, hy: 0.2, hz: 0.2 };
    expect(seen(box, { x: 3.5, y: 0.5, z: 0 })).toEqual([2, 3, 4]);
    expect(seen(box, { x: 3.5, y: 0.5, z: 0 }, { excludeCollider: f.chunks[3] })).toEqual([2, 4]);
    expect(seen(box, { x: 3.5, y: 0.5, z: 0 }, { excludeBody: f.body })).toEqual([]);
    expect(seen(box, { x: 3.5, y: 0.5, z: 0 }, { layers: 'debris' })).toEqual([]);
    // The loose chunk, then everything at its height but it.
    expect(seen(box, { x: 4.5, y: 3, z: 0 })).toEqual([99]);
    expect(seen(box, { x: 4.5, y: 3, z: 0 }, { excludeEid: f.building })).toEqual([]);
    // A collider's own shape a little lower, without itself: is something holding chunk 5 up? Its neighbours.
    const c5 = f.chunks[5] as ColliderHandle;
    expect(seen(c5, { x: 5.5, y: 0.45, z: 0 }, { excludeCollider: c5 })).toEqual([4, 6]);
    // A visitor can stop the query.
    let calls = 0;
    const visited = f.physics.overlapShape(box, { position: { x: 3.5, y: 0.5, z: 0 } }, () => {
      calls += 1;
      return false;
    });
    expect([calls, visited]).toEqual([1, 1]);
    f.dispose();
  });

  it('a sharded fixed body is one body to every query, and its own sensors ignore it', async () => {
    const f = await fixture(0);
    const building = f.entities.create();
    const body = f.physics.bodies.create({ type: 'fixed' });
    const n = SHARD_CAPACITY * 3 + 5;
    const chunks: ColliderHandle[] = [];
    for (let i = 0; i < n; i++) chunks.push(f.physics.bodies.addCollider(body, { shape: { kind: 'box', hx: 0.5, hy: 0.5, hz: 0.5 }, owner: building, part: i, position: { x: i, y: 0, z: 0 } }));
    expect(f.physics.raw.bodies.len()).toBe(4); // four Rapier bodies under one handle
    expect(f.physics.bodies.colliders(body).length).toBe(n);
    // Holes are refilled before a new shard is grown.
    for (let i = 0; i < 10; i++) f.physics.bodies.removeCollider(chunks[i] as ColliderHandle);
    for (let i = 0; i < 10; i++) f.physics.bodies.addCollider(body, { shape: { kind: 'box', hx: 0.5, hy: 0.5, hz: 0.5 }, owner: building, position: { x: -10 - i, y: 0, z: 0 } });
    expect(f.physics.raw.bodies.len()).toBe(4);
    f.tick(1);
    const along = (opts = {}) => f.physics.raycast({ x: -100, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 1000, opts);
    expect(along()?.body).toBe(body);
    expect(along({ excludeBody: body })).toBeNull();
    // A joint to it, from a body hanging below the far end.
    const owner = f.entities.create();
    const weight = f.physics.bodies.create({ type: 'dynamic', position: { x: n - 1, y: -2, z: 0 } });
    f.physics.bodies.addCollider(weight, { shape: { kind: 'sphere', radius: 0.2 }, owner });
    f.physics.joints.create(body, weight, { kind: 'spherical', anchorA: { x: n - 1, y: -1, z: 0 }, anchorB: { x: 0, y: 1, z: 0 } });
    f.physics.gravity = { x: 0, y: -9.81, z: 0 };
    f.tick(60);
    const p = { x: 0, y: 0, z: 0 };
    f.physics.bodies.pose(weight, p);
    expect(p.y).toBeCloseTo(-2, 1);
    // A sensor added now lands on the last shard, over chunks 17..23 on the first. It must not see
    // its own body's colliders on other shards (Rapier never pairs two fixed bodies), only what comes in.
    const log = events(f);
    const sensorOwner = f.entities.create();
    f.physics.bodies.addCollider(body, { shape: { kind: 'box', hx: 3, hy: 1, hz: 1 }, owner: sensorOwner, position: { x: 20, y: 0, z: 0 }, isSensor: true, events: true });
    f.physics.gravity = { x: 0, y: 0, z: 0 };
    f.tick(5);
    expect(log).toEqual([]);
    const other = f.entities.create();
    const visitor = f.physics.bodies.create({ type: 'dynamic', position: { x: 20, y: 0.8, z: 0 } });
    f.physics.bodies.addCollider(visitor, { shape: { kind: 'sphere', radius: 0.2 }, owner: other });
    f.tick(5);
    expect(log).toEqual([`enter ${sensorOwner}:${other}`]);
    f.dispose();
  });
});

describe('Contact events count per owner pair', () => {
  /** A three-chunk plank owned by `owner`, resting flat on the ground. */
  async function plank(f: Fixture, owner: number, x = 0): Promise<{ body: BodyHandle; chunks: ColliderHandle[] }> {
    const body = f.physics.bodies.create({ type: 'dynamic', position: { x, y: 0.3, z: 0 } });
    const chunks = [-1, 0, 1].map((dx, i) =>
      f.physics.bodies.addCollider(body, { shape: { kind: 'box', hx: 0.45, hy: 0.25, hz: 0.45 }, owner, part: i, position: { x: dx, y: 0, z: 0 } }),
    );
    return { body, chunks };
  }

  it('three chunks landing make one start; the last one removed makes one end, a step later, through the info it kept', async () => {
    const f = await fixture();
    const ground = addGround(f);
    const building = f.entities.create();
    const log = events(f);
    const { chunks } = await plank(f, building);
    f.tick(60);
    const pair = `${Math.min(ground, building)}:${Math.max(ground, building)}`;
    expect(log).toEqual([`start ${pair}`]);
    expect(f.physics.isTouching(ground, building)).toBe(true);
    // Two of the three go: the plank still lies on the ground.
    f.physics.bodies.removeCollider(chunks[0] as ColliderHandle);
    f.physics.bodies.removeCollider(chunks[2] as ColliderHandle);
    f.tick(5);
    expect(log).toEqual([`start ${pair}`]);
    // The last: nothing is said until the step that reports it stopping.
    const last = chunks[1] as ColliderHandle;
    f.physics.bodies.removeCollider(last);
    expect(f.physics.bodies.hasCollider(last)).toBe(false);
    expect(f.physics.bodies.info(last)).toMatchObject({ owner: building, part: 1 }); // kept for that step's events
    expect(f.physics.isTouching(ground, building)).toBe(true);
    f.tick(1);
    expect(log).toEqual([`start ${pair}`, `end ${pair}`]);
    expect(f.physics.isTouching(ground, building)).toBe(false);
    expect(f.physics.bodies.info(last)).toBeUndefined(); // forgotten once its stop was counted
    f.tick(5);
    expect(log.length).toBe(2);
    f.dispose();
  });

  it("skips contacts between one owner's colliders", async () => {
    const f = await fixture();
    const building = f.entities.create();
    const log = events(f);
    const slab = f.physics.bodies.create({ type: 'fixed' });
    f.physics.bodies.addCollider(slab, { shape: { kind: 'box', hx: 5, hy: 0.25, hz: 5 }, owner: building, events: true });
    const chunk = f.physics.bodies.create({ type: 'dynamic', position: { x: 0, y: 1, z: 0 } });
    f.physics.bodies.addCollider(chunk, { shape: { kind: 'box', hx: 0.3, hy: 0.3, hz: 0.3 }, owner: building, events: true });
    f.tick(60);
    expect(log).toEqual([]);
    const crate = f.entities.create();
    const body = f.physics.bodies.create({ type: 'dynamic', position: { x: 2, y: 1, z: 0 } });
    f.physics.bodies.addCollider(body, { shape: { kind: 'box', hx: 0.3, hy: 0.3, hz: 0.3 }, owner: crate });
    f.tick(60);
    expect(log).toEqual([`start ${Math.min(building, crate)}:${Math.max(building, crate)}`]);
    f.dispose();
  });

  it('a collider swapped for another in one tick never stops the owners touching', async () => {
    const f = await fixture();
    const ground = addGround(f);
    const building = f.entities.create();
    const log = events(f);
    const { body, chunks } = await plank(f, building);
    f.tick(60);
    expect(log.length).toBe(1);
    for (const c of chunks) f.physics.bodies.removeCollider(c);
    f.physics.bodies.addCollider(body, { shape: { kind: 'box', hx: 1.4, hy: 0.25, hz: 0.45 }, owner: building, part: 9 });
    f.tick(10);
    expect(log.length).toBe(1);
    expect(f.physics.isTouching(ground, building)).toBe(true);
    f.dispose();
  });

  it('destroying the owner ends its contacts at once and takes its colliders from bodies it does not own', async () => {
    const f = await fixture();
    const ground = addGround(f);
    const building = f.entities.create();
    const log = events(f);
    const { body } = await plank(f, building);
    f.tick(60);
    const pair = `${Math.min(ground, building)}:${Math.max(ground, building)}`;
    f.entities.destroy(building);
    expect(log).toEqual([`start ${pair}`, `end ${pair}`]); // synchronously
    expect(f.physics.bodies.exists(body)).toBe(true);
    expect(f.physics.bodies.colliders(body)).toEqual([]);
    expect(f.physics.isTouching(ground, building)).toBe(false);
    expect(() => f.physics.bodies.addCollider(body, { shape: { kind: 'sphere', radius: 1 }, owner: building })).toThrow(/does not exist/);
    // Rapier's late stop events for those colliders are not counted again, even when the id comes back at once.
    const reborn = f.entities.create();
    expect(reborn).toBeGreaterThan(0);
    f.tick(5);
    expect(log.length).toBe(2);
    f.dispose();
  });

  it('an owner destroyed after its colliders were removed leaves no late stop for whoever takes its id', async () => {
    const f = await fixture();
    const ground = addGround(f);
    const building = f.entities.create();
    const log = events(f);
    const { chunks } = await plank(f, building);
    f.tick(60);
    // The chunks go through the handle layer (their stops are due next step), then the owner itself.
    for (const c of chunks) f.physics.bodies.removeCollider(c);
    f.entities.destroy(building);
    const pair = (e: number): string => `${Math.min(ground, e)}:${Math.max(ground, e)}`;
    expect(log).toEqual([`start ${pair(building)}`, `end ${pair(building)}`]);
    // A new entity, very likely on the same id, already lying on the ground: its start and the
    // old chunks' stops arrive in the same step.
    const reborn = f.entities.create();
    const b = f.physics.bodies.create({ type: 'dynamic', position: { x: 10, y: 0.25, z: 0 } });
    f.physics.bodies.addCollider(b, { shape: { kind: 'box', hx: 0.45, hy: 0.25, hz: 0.45 }, owner: reborn });
    f.tick(1);
    f.tick(10);
    expect(log).toEqual([`start ${pair(building)}`, `end ${pair(building)}`, `start ${pair(reborn)}`]);
    expect(f.physics.isTouching(ground, reborn)).toBe(true);
    f.dispose();
  });

  it('collider events are off by default: bulk debris on a quiet floor says nothing', async () => {
    const f = await fixture();
    addGround(f, false);
    const building = f.entities.create();
    const log = events(f);
    await plank(f, building);
    f.tick(60);
    expect(log).toEqual([]);
    // With events on for the debris itself, the same landing is reported.
    const other = f.entities.create();
    const body = f.physics.bodies.create({ type: 'dynamic', position: { x: 5, y: 1, z: 0 } });
    f.physics.bodies.addCollider(body, { shape: { kind: 'sphere', radius: 0.3 }, owner: other, events: true });
    f.tick(60);
    expect(log.length).toBe(1);
    f.dispose();
  });
});

describe('The entity API sits on the handle layer, unchanged', () => {
  it('an entity body is a one-collider body owned by its entity', async () => {
    const f = await fixture();
    const ground = addGround(f);
    const box = f.entities.create([Transform, { y: 2 }]);
    f.physics.addBody(box, { type: 'dynamic', shape: { kind: 'box', hx: 0.5, hy: 0.5, hz: 0.5 } });
    const handle = f.physics.bodyOf(box) as BodyHandle;
    expect(f.physics.bodies.exists(handle)).toBe(true);
    const [collider] = f.physics.bodies.colliders(handle);
    expect(f.physics.bodies.info(collider as ColliderHandle)).toMatchObject({ body: handle, owner: box, part: NO_PART });
    expect(() => f.physics.bodies.destroy(handle)).toThrow(/removeBody/);
    expect(() => f.physics.bodies.removeCollider(collider as ColliderHandle)).toThrow(/removeBody/);
    f.tick(120);
    expect(f.physics.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 10)).toMatchObject({ eid: box, part: NO_PART, body: handle, collider });
    // Handle-layer calls work on it; the entity API reads the same body.
    f.physics.bodies.applyImpulse(handle, { x: 0, y: 5, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(f.physics.getVelocity(box).y).toBeGreaterThan(1);
    const w = { x: 0, y: 0, z: 0 };
    f.physics.bodies.velocity(handle, { x: 0, y: 0, z: 0 }, w);
    expect(w.y).toBeGreaterThan(0.5);
    // Entity joints are handle-layer joints.
    const other = f.entities.create([Transform, { x: 3, y: 2 }]);
    f.physics.addBody(other, { type: 'dynamic', shape: { kind: 'sphere', radius: 0.3 } });
    const j = f.physics.addJoint(box, other, { kind: 'spherical', anchorA: { x: 0, y: 0, z: 0 }, anchorB: { x: 0, y: 0, z: 0 } });
    expect(f.physics.joints.of(handle)).toEqual([j]);
    expect(f.physics.removeJoint(j)).toBe(true);
    expect(f.physics.joints.of(handle)).toEqual([]);
    f.physics.removeBody(box);
    expect(f.physics.bodies.exists(handle)).toBe(false);
    expect(f.physics.bodyOf(box)).toBeUndefined();
    expect(f.physics.bodyCount).toBe(2); // the ground and `other`
    void ground;
    f.dispose();
  });

  it('takes solver iterations as an option and a setting', async () => {
    const entities = new EntityWorld({ capacity: 16 });
    const physics = await PhysicsWorld.create({ entities, fixedStepHz: HZ, solverIterations: 6 });
    expect(physics.solverIterations).toBe(6);
    expect(physics.raw.numSolverIterations).toBe(6);
    physics.solverIterations = 8;
    expect(physics.raw.numSolverIterations).toBe(8);
    expect(() => (physics.solverIterations = 0)).toThrow(/positive integer/);
    physics.dispose();
    entities.dispose();
  });
});

describe('Removal cost does not grow with the world', () => {
  /** Median ms for removing one collider from a fixed body of `n` and stepping once. */
  async function colliderRemoval(n: number): Promise<number> {
    const f = await fixture(0);
    const building = f.entities.create();
    const body = f.physics.bodies.create({ type: 'fixed' });
    const side = Math.ceil(Math.cbrt(n));
    const chunks: ColliderHandle[] = [];
    for (let i = 0; i < n; i++) {
      const x = i % side;
      const y = Math.floor(i / side) % side;
      const z = Math.floor(i / side / side);
      chunks.push(f.physics.bodies.addCollider(body, { shape: { kind: 'convexMesh', ...cubeMesh(x * 1.01, y * 1.01, z * 1.01, 0.5) }, owner: building, part: i, density: 2400 }));
    }
    f.physics.step();
    f.physics.step();
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const c = chunks.pop() as ColliderHandle;
      const t0 = performance.now();
      f.physics.bodies.removeCollider(c);
      f.physics.step();
      samples.push(performance.now() - t0);
    }
    f.dispose();
    return median(samples);
  }

  /** Median ms to destroy one jointed body among `n`. */
  async function bodyRemoval(n: number): Promise<number> {
    const f = await fixture(0);
    const owner = f.entities.create();
    const bodies: BodyHandle[] = [];
    for (let i = 0; i < n; i++) {
      const b = f.physics.bodies.create({ type: 'dynamic', position: { x: (i % 50) * 2, y: Math.floor(i / 50) * 2, z: 0 } });
      f.physics.bodies.addCollider(b, { shape: { kind: 'convexHull', points: cubePoints(0, 0, 0, 0.4) }, owner, events: true });
      if (i > 0) f.physics.joints.create(bodies[i - 1] as BodyHandle, b, { kind: 'spherical', anchorA: { x: 1, y: 0, z: 0 }, anchorB: { x: -1, y: 0, z: 0 } });
      bodies.push(b);
    }
    f.physics.step();
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const b = bodies[Math.floor(n / 2) + i] as BodyHandle;
      const t0 = performance.now();
      f.physics.bodies.destroy(b);
      samples.push(performance.now() - t0);
    }
    f.dispose();
    return median(samples);
  }

  it('one collider off a fixed body of 1,800 costs what it does off a body of 200', async () => {
    // Interleaved and best of three: this machine's clock is shared with whatever else runs.
    const small: number[] = [];
    const big: number[] = [];
    for (let r = 0; r < 3; r++) {
      small.push(await colliderRemoval(200));
      big.push(await colliderRemoval(1800));
    }
    const s = Math.min(...small);
    const b = Math.min(...big);
    // Unsharded, Rapier re-places and re-weighs every collider on the body: 1.8 ms against 0.16.
    expect(b).toBeLessThan(s * 3 + 0.1);
  });

  it('destroying a jointed body among 2,000 costs what it does among 100', async () => {
    const small: number[] = [];
    const big: number[] = [];
    for (let r = 0; r < 3; r++) {
      small.push(await bodyRemoval(100));
      big.push(await bodyRemoval(2000));
    }
    const s = Math.min(...small);
    const b = Math.min(...big);
    expect(b).toBeLessThan(s * 3 + 0.05);
  });

  it('makes and drops hundreds of convex debris bodies a second with time to spare', async () => {
    const f = await fixture();
    addGround(f, false);
    const building = f.entities.create();
    const t0 = performance.now();
    let made = 0;
    for (let tick = 0; tick < 60; tick++) {
      const batch: BodyHandle[] = [];
      for (let k = 0; k < 10; k++) {
        const b = f.physics.bodies.create({ type: 'dynamic', position: { x: k * 2, y: 3, z: tick % 7 }, ccd: true });
        for (let c = 0; c < 3; c++) f.physics.bodies.addCollider(b, { shape: { kind: 'convexMesh', ...cubeMesh(c * 0.5, 0, 0, 0.25) }, owner: building, part: made * 3 + c, density: 2400 });
        batch.push(b);
        made += 1;
      }
      f.physics.step();
      for (const b of batch) f.physics.bodies.destroy(b);
    }
    const ms = performance.now() - t0;
    expect(made).toBe(600);
    expect(f.physics.bodies.count).toBe(1);
    // 600 bodies and 1,800 hulls in and out over one simulated second; generous for a busy machine.
    expect(ms).toBeLessThan(1000);
    f.dispose();
  });
});
