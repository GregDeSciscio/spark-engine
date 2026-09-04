# ADR-009: Navigation: Recast/Detour navmesh baked from level collision

## Context

The customer game is single-player (ADR-005), so enemies are the whole opposition and the enemy AI is the biggest gameplay system. Its mission shape (`docs/design/mission-shape.md`) needs enemies that patrol authored routes, reroute when the level alert state changes, flank, take cover, and search a last-known position. All of that sits on one question: how does an agent get from A to B through a level?

Task Unit answered it with a bespoke grid graph: a 0.75 m flood fill over walkable space seeded from spawns, using raycasts and capsule tests against the collision world, with A* over cells and hand-authored mantle and ladder links. It worked for bots that fill lobby slots, but paths zig-zag on the grid, bakes cost seconds of raycasts, and every capability (funnelling, agent radius, dynamic obstacles) would have to be built from scratch. Per ADR-005's reuse rule it is a design reference, not code to port.

Levels are Blender-authored glTF (ADR-008) and the engine's character controller already fixes the agent shape: 0.4 m radius, 1.8 m tall, 0.4 m step, 50° slope.

## Decision

**Recast/Detour, through `recast-navigation` (the `@recast-navigation/*` WASM port), with the navmesh baked from level collision geometry at authoring time.**

- **Bake offline.** The asset pipeline gains a `navmesh` step that reads a level's collision geometry, runs the Recast solo generator with the agent parameters above, and writes a binary navmesh beside the level. The bake is deterministic given the same input, so the output is a build artefact, not something the runtime recomputes. Procedural or blockout scenes may bake at load in the browser (the generator takes a few hundred milliseconds for a level this size); shipped levels do not.
- **Query at runtime through the engine.** A `Navigation` module in `packages/engine/src/ai/` loads a navmesh and exposes: nearest point on mesh, path find with string-pulling (straight path), mesh raycast, and random point in a radius. Game code never touches Detour objects directly.
- **Steering is ours, not DetourCrowd.** With a handful of enemies per mission, per-agent steering along the straight path in the fixed step is simpler, deterministic by construction, and keeps avoidance rules where the gameplay is. Crowd can be revisited if enemy counts grow.
- **Off-mesh links carry the traversal verbs.** Mantle zones, ladders, and drops are authored in Blender as glTF extras (ADR-008) and baked as off-mesh connections, so a path can say "mantle here" and the animation system can play it.
- **Agent parameters are shared.** The bake reads the same radius, height, step height and slope the character controller uses, so a place the player can stand is a place an enemy can walk.
- **Determinism.** Detour queries are pure functions of the mesh and their inputs. Any randomness (random points, wander) draws from the engine's seeded `Random`.

## Alternatives

- **Task Unit's grid graph, rewritten.** Rejected: it would be a second navigation implementation in the world with fewer capabilities than the first; the bake cost and path quality were its known weaknesses.
- **`three-pathfinding` over a hand-modelled navmesh.** Rejected: no generation, so every level change means re-modelling the mesh in Blender; no agent radius; paths are triangle-centroid A* with a funnel. Kept in mind as a fallback if the WASM proves a problem.
- **Yuka.** Rejected: a full steering and behaviour framework with its own entity model, which would fight the engine's ECS (ADR-003).
- **Bake in the browser at level load.** Rejected for shipped levels: it spends seconds of the cold start (`docs/performance/cold-start.md`) on work whose result never changes.

## Consequences

- The engine takes a dependency on `@recast-navigation/core` and `@recast-navigation/generators` (pinned exactly, ADR-007 style), about 2 MB of WASM unpacked. It loads lazily, only when a scene asks for navigation.
- The asset pipeline needs a collision export from Blender levels that is separate from render geometry; the map bundle format from Task Unit already made that split.
- The AI layer gets a home: `packages/engine/src/ai/` for navigation, perception queries, and behaviour primitives; behaviours themselves are game code in the showcase.
- Enemy movement reuses the character controller, so enemies collide, step and fall the same way the player does.

## Status

Proposed. Needed before the first enemy in Milestone 5.
