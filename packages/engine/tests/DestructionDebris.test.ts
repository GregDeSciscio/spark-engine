import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { findConnections } from '../src/destruction/core/connections';
import type { P2, V3 } from '../src/destruction/core/math';
import { prism, type Piece } from '../src/destruction/core/pieces';
import { Debris, RUBBLE, STANDING } from '../src/destruction/Debris';
import { Hinges } from '../src/destruction/Hinges';
import { Transform } from '../src/ecs/components/Transform';
import { EntityWorld } from '../src/ecs/EntityWorld';
import type { Entity } from '../src/ecs/EntityWorld';
import { PhysicsWorld, initRapier } from '../src/physics/PhysicsWorld';

/**
 * The debris and hinge layers on real Rapier, through the handle layer
 * (ADR-010): hanging, tiring, the step guard, sleeping, landing, shattering
 * into clusters, taking one chunk out of a body, and the link budget.
 */

/** An axis-aligned box as a piece. */
function box(id: number, min: V3, max: V3): Piece {
  const w = max[0] - min[0];
  const h = max[1] - min[1];
  const poly: P2[] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  return prism({ id, element: id, kind: 'slab', poly, frame: { origin: min, u: [1, 0, 0], v: [0, 1, 0] }, thickness: max[2] - min[2], width: w, height: h, minus: 'outer', plus: 'inner', density: 2400 });
}

interface World {
  entities: EntityWorld;
  physics: PhysicsWorld;
  owner: Entity;
  debris: Debris;
  pieces: Piece[];
  dispose(): void;
}

/** A physics world at 60 Hz with a 40 m ground slab, and a structure entity owning `pieces`. */
async function world(pieces: Piece[], solverIterations?: number): Promise<World> {
  const entities = new EntityWorld({ capacity: 1024 });
  const physics = await PhysicsWorld.create({ entities, fixedStepHz: 60, solverIterations });
  const ground = entities.create([Transform, { y: -0.5 }]);
  physics.addBody(ground, { type: 'fixed', shape: { kind: 'box', hx: 20, hy: 0.5, hz: 20 }, events: false });
  const owner = entities.create();
  const debris = new Debris(physics, owner, pieces);
  return {
    entities,
    physics,
    owner,
    debris,
    pieces,
    dispose(): void {
      debris.dispose();
      entities.dispose();
      physics.dispose();
    },
  };
}

/**
 * A 2 m post on the ground with a 1 m slab chunk glued to its top side, 3 m
 * up. The glue breaks (as Strain would) and the slab chunk comes loose.
 */
async function rig(strength?: number): Promise<World & { hinges: Hinges; step: (n: number) => void }> {
  const pieces = [box(0, [0, 0, 0], [0.4, 3, 0.4]), box(1, [0.4, 2.75, 0], [1.4, 3, 0.4])];
  const w = await world(pieces, 6); // as Destruction runs it: hinges want the stiffer solve
  const connections = findConnections(pieces);
  const hinges = new Hinges(w.debris, connections, pieces, strength === undefined ? {} : { strength });
  // As Destruction wires it: nothing a hinge holds settles into rubble.
  w.debris.canPile = (id) => !hinges.holds(w.debris.body(id)!.body);
  const side = connections.find((c) => c.a === 0 && c.b === 1)!;
  hinges.add([side.id]);
  w.debris.detach([1]);
  const step = (n: number): void => {
    for (let i = 0; i < n; i++) {
      w.debris.fixedUpdate();
      hinges.fixedUpdate(1 / 60, 9.81);
      w.physics.step();
    }
  };
  return { ...w, hinges, step };
}

function pieceCenter(w: World, p: number): THREE.Vector3 {
  return new THREE.Vector3(...w.pieces[p]!.centroid).applyMatrix4(w.debris.restToWorld(p, new THREE.Matrix4()));
}

function steps(w: World, n: number): void {
  for (let i = 0; i < n; i++) {
    w.debris.fixedUpdate();
    w.physics.step();
  }
}

describe('gradual destruction (hinges)', () => {
  beforeAll(async () => {
    await initRapier();
  });

  it('a chunk that came loose hangs from the edge it broke at instead of falling', async () => {
    const r = await rig();
    r.step(180);
    expect(r.debris.state[0]).toBe(STANDING);
    expect(r.hinges.linkCount).toBe(1);
    const y = pieceCenter(r, 1).y;
    // It swung down to hang below the post's top edge (≈ 3 m), not onto the ground.
    expect(y).toBeGreaterThan(1.9);
    expect(y).toBeLessThan(2.9);
    r.dispose();
  });

  it('rubble left on something that is then destroyed falls instead of floating', async () => {
    const w = await world([box(0, [0, 0, 0], [1, 2, 1]), box(1, [0, 2, 0], [1, 2.5, 1])]);
    w.debris.detach([1]); // came loose, but it sits on the post
    steps(w, 90);
    expect(w.debris.state[1]).toBe(RUBBLE);
    w.debris.remove(0); // the post is blown away
    steps(w, 150);
    // It woke, fell and settled again: on the ground now, not two metres up.
    expect(pieceCenter(w, 1).y).toBeLessThan(0.6);
    w.dispose();
  });

  it('a hinge too weak for what hangs from it tires and lets go', async () => {
    const r = await rig(2_000);
    r.step(240);
    expect(r.hinges.counters.torn).toBe(1);
    expect(r.hinges.linkCount).toBe(0);
    // Fallen to the ground (loose or settled into rubble there): where its centroid is now.
    expect(pieceCenter(r, 1).y).toBeLessThan(0.6);
    r.dispose();
  });

  it('a step that throws a chunk is undone, and one thrown again and again is let go', async () => {
    const r = await rig();
    r.debris.onTrapped = (body) => r.hinges.release(body);
    r.step(60);
    const before = pieceCenter(r, 1);
    // A hinge fighting a contact, as the solver sometimes does: 200 m/s out of nowhere, three steps running
    // (sideways, which the ball joint allows; straight up it would mostly soak up).
    for (let i = 0; i < 3; i++) {
      r.physics.bodies.setVelocity(r.debris.bodyOf(1)!, { x: 0, y: 0, z: 200 });
      r.physics.step();
      r.debris.fixedUpdate();
      r.hinges.fixedUpdate(1 / 60, 9.81);
      expect(pieceCenter(r, 1).distanceTo(before)).toBeLessThan(0.1);
    }
    expect(r.debris.counters.flung).toBe(3);
    // Trapped: the hinge let go, and the chunk falls like anything else.
    expect(r.hinges.linkCount).toBe(0);
    expect(r.hinges.counters.torn).toBe(1);
    r.step(240);
    expect(pieceCenter(r, 1).y).toBeLessThan(0.6);
    r.dispose();
  });

  it('a chunk asleep on something wakes and falls when that is destroyed', async () => {
    const w = await world([box(0, [0, 0, 0], [1, 2, 1]), box(1, [0, 2, 0], [1, 2.5, 1])]);
    w.debris.canPile = () => false; // held, as if a hinge had it: Rapier sleeps it as a body instead of it turning to rubble
    w.debris.detach([1]);
    steps(w, 150);
    expect(w.physics.bodies.isSleeping(w.debris.bodyOf(1)!)).toBe(true);
    w.debris.remove(0);
    steps(w, 120);
    expect(pieceCenter(w, 1).y).toBeLessThan(0.6);
    w.dispose();
  });

  it('a chunk that drops onto the ground is heard landing once, as hard as it fell', async () => {
    const w = await world([box(0, [0, 3, 0], [1, 3.5, 1])]);
    const lands: Array<{ y: number; mass: number; speed: number }> = [];
    w.debris.onLand = (at, mass, speed) => lands.push({ y: at.y, mass, speed });
    w.debris.detach([0]);
    steps(w, 180);
    // 3 m down: about 7.7 m/s at the ground. A bounce may count again, but softer, and resting is silent.
    expect(lands.length).toBeGreaterThanOrEqual(1);
    expect(lands.length).toBeLessThanOrEqual(2);
    expect(lands[0]!.speed).toBeGreaterThan(6.5);
    expect(lands[0]!.speed).toBeLessThan(8.5);
    expect(lands[0]!.y).toBeLessThan(0.6);
    expect(lands[0]!.mass).toBeGreaterThan(1000);
    w.dispose();
  });

  it('a slab that lands hard shatters into clusters over a few steps, every chunk still accounted for', async () => {
    // A 6 m × 6 m slab of 1 m chunks, 5 m up.
    const pieces: Piece[] = [];
    for (let i = 0; i < 6; i++) for (let k = 0; k < 6; k++) pieces.push(box(pieces.length, [i, 5, k], [i + 1, 5.3, k + 1]));
    const w = await world(pieces);
    const { debris } = w;
    debris.detach(pieces.map((p) => p.id));
    const step = (): void => steps(w, 1);
    for (let i = 0; i < 120 && debris.counters.shattered === 0; i++) step();
    expect(debris.counters.shattered).toBe(1);
    // The break-out finishes within a couple of steps (36 colliders, a budget of 64 a step).
    step();
    step();
    // 2 m cells: clusters of up to four chunks, not 36 single-chunk bodies.
    const bodies = new Set(pieces.map((p) => debris.state[p.id]!));
    expect(bodies.size).toBeGreaterThan(2);
    expect(bodies.size).toBeLessThan(18);
    // Every chunk is in exactly one place, now and once it has all settled: rubble, or a body that lists it.
    const accounted = (): void => {
      for (const p of pieces) {
        const s = debris.state[p.id]!;
        if (s === RUBBLE) continue;
        expect(s).toBeGreaterThanOrEqual(0);
        expect(debris.body(s)!.pieces).toContain(p.id);
      }
    };
    accounted();
    for (let i = 0; i < 120; i++) step();
    accounted();
    // And every chunk has exactly one collider, owned by the structure and naming the chunk.
    for (const p of pieces) {
      const c = debris.colliderOf(p.id)!;
      expect(w.physics.bodies.info(c)).toMatchObject({ owner: w.owner, part: p.id });
    }
    w.dispose();
  });

  it('a chunk taken out of a body leaves the rest of that body as it was', async () => {
    const w = await world([0, 1, 2, 3].map((i) => box(i, [i, 3, 0], [i + 1, 3.3, 1])));
    const id = w.debris.detach([0, 1, 2, 3]);
    const handle = w.debris.body(id)!.body;
    w.debris.remove(1);
    expect(w.debris.body(id)!.body).toBe(handle);
    expect([...w.debris.body(id)!.pieces].sort()).toEqual([0, 2, 3]);
    expect(w.physics.bodies.colliders(handle)).toHaveLength(3);
    w.dispose();
  });

  it('a link dropped over budget is dropped once, so its bodies still count as held by the rest', async () => {
    // A post, a chunk on it, and two chunks side by side off that chunk's end.
    const pieces = [box(0, [0, 0, 0], [0.4, 3, 0.4]), box(1, [0.4, 2.75, 0], [1.4, 3, 0.4]), box(2, [1.4, 2.75, 0], [2.4, 3, 0.2]), box(3, [1.4, 2.75, 0.2], [2.4, 3, 0.4])];
    const connections = findConnections(pieces);
    const conn = (a: number, b: number): number => connections.find((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a))!.id;
    const w = await world(pieces);
    const hinges = new Hinges(w.debris, connections, pieces);
    w.debris.detach([1]);
    w.debris.detach([2, 3]);
    hinges.add([conn(0, 1), conn(1, 2)]);
    hinges.fixedUpdate(1 / 60, 9.81);
    expect(hinges.linkCount).toBe(2);
    // The budget shrinks to one link, and the outer pair gains a hinge: its link must be remade, and can't be.
    hinges.options.maxLinks = 1;
    hinges.add([conn(1, 3)]);
    hinges.fixedUpdate(1 / 60, 9.81);
    expect(hinges.linkCount).toBe(1);
    expect(hinges.holds(w.debris.bodyOf(1)!)).toBe(true);
    expect(hinges.audit()).toMatchObject({ untracked: 0, deadLinks: 0, badCounts: 0 });
    w.dispose();
  });
});
