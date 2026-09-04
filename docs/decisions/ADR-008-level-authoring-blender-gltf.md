# ADR-008: Level authoring: Blender as editor, glTF extras as the entity format

## Context

There is no in-engine editor and building one is a non-goal (ADR-006). Levels still have to be made by humans and round-tripped by agents.

## Decision

- A level is a glTF/GLB exported from Blender.
- An object's gameplay role comes from a `spark.type` custom property (glTF `extras`), never from parsing names. Other `spark.*` properties are the entity's initial component data.
- Collision meshes are prefixed `COL_` and never rendered.
- Lights export through the glTF lights extension.
- `world/LevelLoader.ts` is the only place the `extras` → entity convention is interpreted.
- Blender → export → asset pipeline → `?scene=` in the benchmark app is one command.

## Alternatives

- Custom JSON level format: rejected, needs its own tooling.
- Runtime editor: rejected (ADR-006).

## Consequences

- Prop libraries are separate GLBs loaded through the asset pipeline and referenced by name from level extras.

## Status

Proposed. Needed before Milestone 3.
