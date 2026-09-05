# Spark Engine

A WebGPU-first browser game engine on Three.js: renderer and post stack, ECS, Rapier physics, skeletal animation, GPU particles, world streaming, navigation, audio and UI. It ships with a demo game built on it, a launcher of scenes that each show one system, and a starter app to build your own thing from.

Licence: not decided yet. Until a LICENSE file lands, treat the code as all rights reserved and ask before redistributing. The bundled assets are CC0 (Poly Haven, Quaternius) and the sounds were generated for this repo.

---

## Play it

You need **Node 22+**, **pnpm** (`npm i -g pnpm`) and **Chrome or Edge 113+** for WebGPU. Other browsers fall back to WebGL2 with fewer effects.

```bash
pnpm install
pnpm dev
```

Open **http://localhost:5173**. The featured card is the showcase, a demo built with the engine; it runs as its own app, so start it alongside:

```bash
pnpm dev:showcase
```

The first load of a scene spends a few seconds compiling shaders; that happens once per scene per session. If a machine struggles, pick the `medium` or `low` preset in the menu.

### The scenes

| Scene | What it shows | Controls |
|---|---|---|
| **showcase** (its own app) | A night street in the rain: a retargeted character with an aim layer and ragdolls, hostiles on a navmesh with an awareness ladder and cover, hitscan gunplay with gore, objectives with checkpoints, a generated soundscape. | Click to lock the mouse · **WASD** move · **Shift** sprint · **RMB** aim · **LMB** fire · **R** reload · **C** crouch · **X** prone · **F** interact · **Enter** retry |
| `alley` | Procedural brick and wet asphalt, puddle ripples, decals, volumetric fog and godrays, screen-space reflections, GPU rain, an animated hero. | **WASD** move · **Shift** walk · **Space** attack. Hands off, the hero walks itself. |
| `hud` | HUD, name plates and health bars, damage numbers, footsteps, spatial neon buzz, a rain bed, adaptive music. | **WASD** · **Shift** walk · **Space** attack · **Esc** menu · drag to orbit |
| `streaming` | A 960 m district streamed in 24 m chunks around a flying camera, LOD swaps, frustum culling. | **WASD** steer · **Q/E** altitude · **F3** physics wireframe. Hands off, autopilot. |
| `physics` | 300 rigid bodies in a seeded pile, a ramp, a sensor volume, a character controller, hover highlighting. | **WASD** move · **Space** jump · hover · **F3** wireframe |
| `vfx` | Fire embers, steam vents, spark bursts, a 100k-streak rain volume. | **Space** muzzle flash |
| `animation` | An idle/walk/run blend tree with root motion, an additive attack layer, a crowd of sixty. | **WASD** · **Shift** walk · **Space** attack · **H** hit · **K** die · **R** respawn · drag to orbit |
| `lights` | 256 moving point lights over 1,600 instanced props, clustered on the GPU. `?lights=N`. | — |
| `entities` | Thousands of ECS entities in one instanced draw. | — |
| `assets` | GLB loading through the asset pipeline. | — |
| `bootstrap` | The smoke test: a PBR sphere grid. | — |

The stats readout is always on; **F2** opens the inspector. Every option is also a URL parameter (below).

### URL options

Stack them with `&`, e.g. `?scene=alley&preset=cinematic`.

| Parameter | Values | Notes |
|---|---|---|
| `scene` | any name above | Omit it for the launcher |
| `preset` | `low` `medium` `high` `ultra` `cinematic` | Default `high`; `cinematic` adds depth of field |
| `backend` | `auto` `webgpu` `webgl` | `auto` prefers WebGPU |
| `scale` | `0.5`–`1` | Internal render scale |
| `dpr` | e.g. `1` | Cap on device pixel ratio |
| `seed` | integer | Same seed, same scene |
| `overlay` | `0` `1` | Hide or show the stats readout |
| `inspector` | `0` `1` | Open the inspector at start |
| `size` | e.g. `1280x720` | Fixed canvas size |
| `paused` | `1` | Render one frame and stop |
| `fixedclock` | e.g. `60` | Deterministic clock: every frame advances exactly 1/60 s |
| `warmup` | `0` | Skip shader pre-compilation (see `docs/performance/cold-start.md`) |
| `log` | `debug` `info` `warn` `error` `silent` | Console verbosity |

### Troubleshooting

- **Black screen or "Both WebGPU and WebGL2 backends failed"**: check `chrome://gpu`; hardware acceleration is probably off.
- **No sound**: browsers block audio until you interact with the page. Click once.
- **Choppy**: `&preset=medium` and/or `&scale=0.7`.

---

## Build with it

```bash
pnpm doctor          # what this machine has, and what each missing optional tool would unlock
pnpm dev:starter     # the smallest complete app: one scene file, http://localhost:5175
pnpm create-app my-game && pnpm install && pnpm --filter @spark/my-game dev
```

Then read **[docs/guide/first-scene.md](docs/guide/first-scene.md)**: fifteen minutes from the starter to a scene of your own. The rest of the guide:

- [docs/guide/concepts.md](docs/guide/concepts.md), the engine's shape on one page
- [docs/guide/api-map.md](docs/guide/api-map.md), every module the engine exports
- [docs/guide/recipes.md](docs/guide/recipes.md), levels from Blender, characters, weapons, sound, each pointing into the showcase

If you work with a coding assistant, `CLAUDE.md` at the root is written for it and describes the repo's conventions.

### What you need for what

| Tool | Required for | Notes |
|---|---|---|
| Node 22+, pnpm | everything | |
| Chrome or Edge 113+ | seeing scenes as intended | others fall back to WebGL2 |
| Blender 4.2+ | `pnpm level:street`, `pnpm character:retarget` | levels and characters authored in Blender |
| ffmpeg | `pnpm audio:build` | mastering generated sound |
| Playwright Chromium (`pnpm exec playwright install chromium`) | `pnpm capture`, `pnpm thumbnails`, `pnpm visual`, `pnpm perf` | headless WebGPU; see `tools/capture/README.md` |
| ElevenLabs API key (`.env`) | `pnpm audio:generate` | the showcase already ships its takes |
| KTX-Software `toktx` | compressed textures in the asset pipeline | optional; PNG/JPEG stay as they are without it |

---

## Contribute to it

### Layout

```
packages/engine          @spark/engine, the reusable engine. Public API is src/index.ts. No game code.
apps/starter             the smallest complete app; `pnpm create-app` copies it
apps/showcase            the demo game; `pnpm dev:showcase`
apps/benchmark           the launcher and one scene per engine system; `pnpm dev`
tools/asset-pipeline     glTF → optimised GLB (dedup, meshopt, KTX2, budgets, navmesh bake); character build
tools/level-authoring    Blender scripts: the street level, the character retarget
tools/audio              sound generation (ElevenLabs) and mastering (ffmpeg) from a game's manifest
tools/capture            headless boot, screenshots, thumbnails, visual goldens, perf
assets/source            CC0 props, characters and the showcase's audio takes, with SOURCES.md notes
docs/guide               start here to build; docs/decisions are the ADRs; docs/architecture the lessons
```

`BROWSER_AAA_ENGINE_PROJECT_KICKOFF.md` is the original spec.

### Verify

```bash
pnpm check                                    # typecheck + lint + unit tests + production build
pnpm capture --scene=bootstrap --backend=both # screenshot + stats JSON + clean-console check
pnpm visual                                   # diff every manifest entry against goldens (--update to rewrite)
pnpm perf                                     # real-time benchmark vs this machine's baseline (--record to write)
```

"It works" means `pnpm check` passes and a capture produced a screenshot you looked at with a clean console.

### Rules that are enforced

- `three` is pinned exactly (ADR-007). Do not bump it.
- `Math.random()` is a lint error. Use `Random` from the engine.
- `packages/engine` never imports from `apps/*`. Apps import only from `@spark/engine`.
- Only `ecs/` imports bitecs; only `physics/` imports Rapier; only `rendering/` touches the three renderer.
- Anything a game teaches the engine goes in `docs/architecture/lessons-from-the-showcase.md`, with the change that came of it.
