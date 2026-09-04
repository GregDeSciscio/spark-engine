# ADR-003: Entity model: adopt bitecs behind engine interfaces

## Context

The kickoff requires cheap entities, data-only components, composition over inheritance, and renderer objects that never become gameplay objects. A bespoke ECS is a classic month-long detour before anything renders.

## Decision

- Adopt `bitecs` **0.4.0**, exact pin.
- Only `packages/engine/src/ecs/` imports bitecs. Everything else uses the engine's `EntityWorld` API (entities, component registration, queries, systems, lifecycle).
- Components hold **numbers only** (typed-array structure-of-arrays). Three.js objects, Rapier handles, strings and asset references live in engine-owned side tables keyed by entity id.
- No archetype storage, change detection or serialization layers are built until a game needs them.

### bitecs 0.3 → 0.4 API note (agents: read this)

Agents frequently produce 0.3-style code from memory. In 0.4:

- `defineComponent` is gone. A component is a plain object of typed arrays (or any object). Pass it to `addComponent(world, eid, Component)`.
- `defineQuery` is gone. Use `query(world, [A, B])` directly; it returns an array of entity ids.
- `createWorld()` still exists; so do `addEntity(world)`, `removeEntity(world, eid)`, `hasComponent(world, eid, C)`, `removeComponent(world, eid, C)`.
- Enter/exit queries are replaced by observers: `observe(world, onAdd(A), (eid) => ...)` and `onRemove`.
- `Types`, `defineSystem` and `pipe` are gone; a system is any function.

## Alternatives

- Minimal in-house model: rejected, re-derives what bitecs already does.
- miniplex (object-based): kept as the fallback if ergonomics chafe. The `ecs/` wrapper makes the swap local.

## Consequences

- Systems iterate `Float32Array` fields, which pairs naturally with instanced rendering uploads.
- Side tables are a feature: they enforce the data/resource split.

## Status

Ratified by Greg, 2026-09-03. Implemented in Milestone 1.
