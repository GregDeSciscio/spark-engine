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
- Game-specific `spark.type` values (objectives, patrol points, range targets) pass through the loader as `unknown` descriptors and are interpreted by game code, so the engine never learns a game's vocabulary.
- The asset pipeline bakes a navmesh from the `COL_` nodes beside every level (ADR-009).

## The round trip today

`pnpm level:street` runs `tools/level-authoring/street.py` in Blender headless (writes `assets/source/levels/street.blend` and `street.glb` with `spark.*` custom properties), then the asset pipeline into `apps/showcase/public/levels/` with `street.navmesh.bin`. The showcase loads it through `LevelLoader` in `apps/showcase/src/levels/MissionLevel.ts`. A designer opens the `.blend`, edits, exports with "Custom Properties" ticked, and re-runs the pipeline half with `--skip-blender`.

## Status

Ratified in practice 2026-09-04: the showcase's street level is the first Blender-authored level through the pipeline.
