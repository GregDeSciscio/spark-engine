# Spark Engine, for coding agents

This repo is built to be worked on with an AI assistant; most of it was. If you are an agent helping someone build with the engine, this file is your map. People: read `README.md` and `docs/guide/` instead.

## What this is

A WebGPU-first browser game engine on Three.js (`three/webgpu`, TSL node materials). pnpm monorepo, TypeScript, strict. Node 22+.

- `packages/engine` — `@spark/engine`, the reusable engine. Public API is `packages/engine/src/index.ts` and nothing deeper. No game code lives here.
- `apps/starter` — the smallest complete app: one scene file. Copy it with `pnpm create-app <name>`.
- `apps/showcase` — a full demo built with the engine (a night street, a character, hostiles, gunplay, sound). The best worked example of every system.
- `apps/benchmark` — the launcher menu plus one demo scene per engine system.
- `tools/` — asset pipeline (glTF → optimised GLB), Blender level and character builds, audio generation and mastering, capture/thumbnail/visual/perf harnesses, `doctor`, `create-app`.
- `docs/` — `guide/` (start here), `decisions/` (ADRs: why things are the way they are), `architecture/lessons-from-the-showcase.md` (what building a game taught the engine), design and audio notes.

## How a scene works

A `SceneDefinition` is `{ name, create(ctx) }`; `create` returns a `SceneInstance` with a three `scene`, a `camera`, optional `fixedUpdate(dt)` / `update(dt)` / `lateUpdate(dt)` / `resize(w, h)`, and `dispose()`. `ctx` hands over the engine: `entities` (bitecs ECS with `Transform`), `physics` (Rapier, fixed step), `input`, `audio`, `assets`, `animation`, `vfx`, `lighting`, `ui`, `random` (seeded), `logger`, `quality`, `renderer`. `apps/starter/src/scene.ts` shows all of it in 150 lines.

## Conventions that are enforced or expected

- Read input in `update`, apply motion in `fixedUpdate`. The fixed step is deterministic; `?fixedclock=60` and `?seed=` reproduce a run.
- Everything a scene creates it releases in `dispose()`: a `DisposeBag` for three objects and subscriptions, `entities.destroy` for entities (which drops bodies and render bindings).
- Apps import from `@spark/engine` only. Engine code never imports from apps.
- Physics layers are named strings, defined on first use.
- Assets go through `tools/asset-pipeline` into an app's `public/`; levels and characters are authored in Blender and built with the tools, not hand-edited GLBs.
- Audio cues are data (a manifest module); the engine's `SoundBank` reads the built manifest and missing cues are silent no-ops.
- `pnpm lint`, `pnpm typecheck` and `pnpm test` (vitest, engine package) must pass. Add a test for engine behaviour you add.
- Verify in a browser. `window.__spark` exposes the engine, `stepFrames(n)`, stats, and in the showcase `window.__spark.game` for scripted probes. The desktop app's browser pane refuses pointer lock; feel checks need a real Chrome tab.
- `pnpm probe` runs the gameplay suite: the showcase headless on a fixed clock and seed, driven through that probe surface, asserting mechanics end to end (`tools/probes/`). Add a probe for gameplay you add; assert budgets, not frame counts.
- Commit messages explain the why; the lessons doc records anything the game taught the engine.

## Where to look

| Want to... | Read |
| --- | --- |
| Make a first scene | `docs/guide/first-scene.md`, `apps/starter/src/scene.ts` |
| Understand the engine's shape | `docs/guide/concepts.md`, `docs/guide/api-map.md` |
| Do a specific thing (level, character, weapon, sound) | `docs/guide/recipes.md` (each points into the showcase) |
| Know why a decision was made | `docs/decisions/ADR-*.md` |
| Avoid a known pitfall | `docs/architecture/lessons-from-the-showcase.md` |
| Check the machine | `pnpm doctor` |
