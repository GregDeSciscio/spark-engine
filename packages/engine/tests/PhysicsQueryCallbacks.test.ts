import { beforeAll, describe, expect, it } from 'vitest';
import { Transform } from '../src/ecs/components/Transform';
import { EntityWorld } from '../src/ecs/EntityWorld';
import { PhysicsWorld, initRapier } from '../src/physics/PhysicsWorld';

/**
 * Game code that changes the world from a query's visitor (the destruction
 * slice killed a bot from a debris `hit`, which an overlap query reported).
 * Run inside Rapier's own callback, the bot's body was removed but its
 * collider stayed in Rapier's set after the JS side had forgotten it: an
 * invisible capsule that debris still hit and raycasts found as a hit with no
 * collider. Visitors now run after Rapier's query has finished.
 */
describe('a visitor that changes the world', () => {
  beforeAll(async () => {
    await initRapier();
  });

  const world = async () => {
    const entities = new EntityWorld({ capacity: 64 });
    const physics = await PhysicsWorld.create({ entities, fixedStepHz: 60 });
    const capsule = (x: number) => {
      const e = entities.create([Transform, { x, y: 1, z: 0 }]);
      physics.addBody(e, { type: 'kinematicPosition', shape: { kind: 'capsule', halfHeight: 0.5, radius: 0.35 } });
      return e;
    };
    return { entities, physics, capsule };
  };
  /** Rapier holds exactly the colliders the engine knows. */
  const consistent = (physics: PhysicsWorld): boolean => physics.raw.colliders.len() === physics.bodies.colliderCount;

  it('may destroy what an overlap query found, and nothing is left behind in Rapier', async () => {
    const { entities, physics, capsule } = await world();
    const a = capsule(0);
    const b = capsule(0.5);
    physics.step();
    let visited = 0;
    physics.overlapShape({ kind: 'sphere', radius: 2 }, { position: { x: 0, y: 1, z: 0 } }, (_c, owner) => {
      visited++;
      // The first one found kills both.
      if (entities.exists(a)) entities.destroy(a);
      if (entities.exists(b)) entities.destroy(b);
      void owner;
    });
    // The second was gone by its turn: not visited.
    expect(visited).toBe(1);
    expect(consistent(physics)).toBe(true);
    physics.step();
    // Nothing there to hit, not even a ghost.
    expect(physics.raycast({ x: -5, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 20, { solid: false })).toBeNull();
    entities.dispose();
    physics.dispose();
  });

  it('may destroy a body a contact force named', async () => {
    const { entities, physics } = await world();
    const ground = entities.create([Transform, { y: -0.5 }]);
    physics.addBody(ground, { type: 'fixed', shape: { kind: 'box', hx: 5, hy: 0.5, hz: 5 }, events: false });
    // A crate on the handle layer, reporting its contact forces, as debris does.
    const crate = entities.create([Transform, {}]);
    const body = physics.bodies.create({ type: 'dynamic', position: { x: 0, y: 0.5, z: 0 } });
    physics.bodies.addCollider(body, { owner: crate, shape: { kind: 'box', hx: 0.5, hy: 0.5, hz: 0.5 }, density: 800, forceEvents: 1 });
    for (let i = 0; i < 3; i++) physics.step(); // resting, before it sleeps (asleep, its contacts report nothing)
    let pairs = 0;
    physics.contactForces(() => {
      pairs++;
      if (entities.exists(crate)) entities.destroy(crate);
    });
    expect(pairs).toBe(1);
    expect(consistent(physics)).toBe(true);
    entities.dispose();
    physics.dispose();
  });
});
