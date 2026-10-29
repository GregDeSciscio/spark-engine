# ADR-010: Physics: a handle layer under the entity API, where every collider has an owner

## Context

`PhysicsWorld` was entity-centric: one body and one collider per entity, five shapes, three joint kinds. That fits a character, a crate or a level collider, and it does not fit destruction. The THE FINALS-style sandbox (the `destruction` repo, moving into the engine as a subsystem) needs:

- a building as one fixed body of about 1,800 convex hulls, removed one at a time as chunks come loose, and a rubble body that gains a collider every time something settles;
- hundreds of dynamic debris bodies a second, each with several convex colliders at offsets, continuous collision, damping, impulses with torque, and sleep checks;
- spherical joints between arbitrary bodies with contacts off, rope joints, and the joints on a body enumerated;
- a raycast that names the chunk it hit, and a shape query that excludes the collider being tested.

None of that existed, so the sandbox drove Rapier through `physics.raw`. That broke ADR-002's rule that only `physics/` touches Rapier, and it broke the game: the raycast, `sphereOverlap` and the contact events looked each collider up in a collider-to-entity map, and the sandbox's colliders had no entity. A game's bullets and an AI's line of sight passed straight through a building.

Two Rapier 0.20 behaviours shaped the design:

- **Changing a body's colliders costs the whole body.** Adding or removing one collider makes Rapier, on the next step, re-place every collider on that body in the broad phase and recompute its mass from all of them. Measured in node: removing one hull from a 1,800-hull fixed body and stepping costs 1.8 ms, against 0.16 ms at 200 hulls. Zero mass properties cut it to 0.31 ms; disabling the collider instead of removing it still costs 0.15 ms at 1,800. Splitting the colliders across fixed bodies of 64 brings it to 0.04 ms at any size.
- **The per-body joint walk is not trusted.** `forEachJointHandleAttachedToRigidBody` disagreed with the joints themselves on dozens of bodies in the sandbox's busy scenes. Rapier's own `removeRigidBody` uses that walk to forget the joints it drops.

## Decision

**A handle layer, `physics.bodies` and `physics.joints`, sits under the entity API. Every collider made through either API has an owner entity and an optional part id.**

- **Handles are integers, never reused.** `BodyHandle`, `ColliderHandle` and `JointHandle` fit typed arrays and numbers-only components (ADR-003), and a stale handle is simply unknown. Rapier's own handles are bit-cast floats that a `Float32Array` would flush to zero, so they never leave `physics/`.
- **Bodies hold any number of colliders.** `bodies.create({ type, position, rotation, velocities, ccd, damping })`, then `addCollider(body, { shape, owner, part, position, rotation, density, mass, friction, restitution, layer, collidesWith, isSensor, events })`. `ShapeDesc` gains `convexHull { points }` and `convexMesh { vertices, indices }`; a convex shape with no volume is refused with a clear error, since Rapier 0.20 builds the hull late and fails obscurely. Bodies also have `destroy`, `pose`/`setPose`, `velocity`/`setVelocity`, `applyImpulse(b, impulse, torque?)`, `mass`, `isSleeping`/`wake`, `colliders`, `removeCollider(c, wake = false)`, `info(c) → { body, owner, part }` and `colliderPose`.
- **Fixed bodies made here are sharded and massless.** Their colliders are spread over internal Rapier bodies of `SHARD_CAPACITY` (64), all at one pose, so adding or removing a collider costs the same at ten or two thousand. A fixed body's mass is never used, so its colliders get zero mass properties. Queries and `info` see one body, and since Rapier never pairs two fixed bodies, the shards never touch each other (a sensor on the body does not see its other shards either; a test holds that). One consequence is documented on the API: a joint to a sharded body attaches to its first shard, so `contacts: false` only covers that shard's colliders. Entity bodies are never sharded.
- **Ownership is lifetime.** The owner must exist when the collider is made. Destroying an entity removes every collider it owns, on any body, and ends its contacts at once. A collider never outlives its owner, so a recycled entity id never inherits someone else's colliders.
- **Joints between any two bodies.** `joints.create(a, b, desc & { contacts? })`, with `JointDesc` gaining `rope { anchorA, anchorB, length }`. The engine keeps its own per-body joint index. `of(body)` answers from it, and destroying a body removes its joints through it first, holding Rapier's joint objects, so nothing depends on Rapier's walk or its handle maps. `remove`, `exists`, `anchors(j)` and `countOf` complete it.
- **Queries name the owner and part.** `RaycastHit` gains `part`, `collider` and `body`, beside `eid` (now the owner). Raycasts take `excludeBody` and `excludeCollider`, and `excludeEid` also skips colliders the entity owns on other bodies. The new `overlapShape(shape | collider, pose, visit, { layers, includeSensors, excludeCollider, excludeBody, excludeEid })` visits `(collider, owner, part)`. Single exclusions use Rapier's native filters; combinations fall back to a predicate.
- **Contacts are counted per owner pair.** Rapier reports collider pairs. The engine counts them per pair of owners and emits `collisionStart` (or `triggerEnter`) when the count leaves zero and `collisionEnd` (or `triggerExit`) when it returns. A building of a thousand hulls landing on the ground is one start. Pairs within one owner are skipped. Each drain counts starts before stops, so a collider swapped for another in one tick never blips.
- **Removed colliders stay readable until the next event drain.** Rapier names a removed collider in the stop events of the next step, so its record (and `info`) survives until those events are counted, and is purged after the drain. Entity paths (destroying an entity, `removeBody`) end contacts at once, as `addBody` always has. They then mark the colliders so their late stop events are ignored, even when the entity id comes straight back.
- **Contact forces on request.** A collider made with `forceEvents: newtons` reports each touching pair pressed harder than that, read through `contactForces(visit)` between steps as the force `a` pushes `b` with. Rapier sums its stabilization pass into the solver's impulses, so the force is scaled by n / (n + 1) to read a resting load as its weight. Unread events are dropped before the next step, and a sleeping body reports nothing. Destruction uses it to put weight resting on a building into Strain.
- **Events are off by default on `addCollider`.** Bulk debris adds no event traffic; Rapier still reports a pair when the other collider has events on. `addBody` keeps its default of on.
- **No scans.** Bodies keep their colliders and joints in sets, owners keep their colliders and contact pairs in sets, and removing anything touches only its own entries.
- **The entity API is rebuilt on the layer, unchanged.** `addBody` is `create` plus `addCollider({ owner: eid })`, and `bodyOf(eid)` hands its handle to handle-layer code. `PhysicsWorldOptions.solverIterations` and a `solverIterations` setting expose Rapier's iteration count.
- **Enforced.** An ESLint `no-restricted-imports` rule bans `@dimforge/*` outside `packages/engine/src/physics/`. `physics.raw` stays as an escape hatch for physics-internal tools (the debug renderer, the character controller), and engine code outside `physics/` should not use it.

## Alternatives

- **Keep exposing `physics.raw`.** Rejected: every game would re-solve ownership, and the colliders would stay invisible to the engine's own queries and events.
- **One entity per chunk.** Rejected: thousands of entities for one building, a Transform and a side-table entry each, and a chunk that moves between bodies (standing, loose, rubble) would need its entity rebuilt. An owner plus a part id carries the same information as two numbers.
- **Colliders without owners, skipped by queries.** Rejected: that is the bug this fixes.
- **Disable colliders instead of removing them, and compact later.** Rejected after measuring: on one big body it still costs 0.15 ms per change, and sharding gets to 0.04 ms with plain removals.
- **Let the destruction runtime split its building per element.** Rejected: every game with a large changing static collider set would rediscover the cost. Sharding in the engine fixes it once, behind one handle.
- **Rapier physics hooks to filter same-owner contacts.** Rejected: a JS callback per candidate pair per step. Skipping same-owner pairs in the event count is enough for events, and the contacts themselves are real (chunks resting on chunks).

## Consequences

- Destruction can move into the engine using only `physics.bodies`, `physics.joints` and the queries. A game's raycast against a building returns the building entity and the chunk.
- Measured in the test suite (`PhysicsBodies.test.ts`, which asserts the scaling):
  - removing one convex collider from a fixed body and stepping: 0.02 ms at 200 colliders, 0.05 ms at 1,800;
  - destroying a jointed body: 0.004 ms among 100 and among 2,000;
  - 600 three-hull debris bodies made and destroyed across 60 steps: about 50 ms in all.
- `bodyCount` and `jointCount` count everything, whichever API made it (the inspector shows debris now).
- `isTouching(a, b)` stays true until the step that delivers a deferred stop. Removing colliders through the handle layer ends contacts on the next step, not synchronously, so listeners never run in the middle of a bulk removal.
- Removed colliders' records wait for the next step to be purged. A world that never steps (or stays paused) holds them until it does.

## Status

Proposed. Built on branch `destruction` ahead of the destruction subsystem moving into `packages/engine/src/destruction/`.
