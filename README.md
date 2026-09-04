# Spark Engine

A WebGPU-first browser game engine built on Three.js — renderer, ECS, physics, skeletal animation, GPU particles, world streaming, audio and UI, with a benchmark app of nine scenes that exercise all of it.

Everything you see is procedural or built from four small placeholder GLBs. There are no purchased assets.

---

## Try it

You need **Node 22+**, **pnpm**, and a browser with WebGPU (**Chrome or Edge 113+** — Chrome is the tested one). A discrete GPU helps but is not required; the engine falls back to WebGL2 automatically if WebGPU is unavailable, with some effects disabled.

```bash
pnpm install
pnpm dev
```

Then open **http://localhost:5173** and pick a scene from the menu. Start with **Rainy Alley** — that's the showpiece.

The first load of a scene spends a few seconds on "Compiling shaders"; that's expected and only happens once per scene per session. If your machine struggles, drop the quality preset in the menu to `medium` or `low`. If it flies, try `cinematic`.

## The scenes

The menu at the root URL launches any of these. You can also go straight to one with `?scene=<name>`, e.g. `http://localhost:5173/?scene=physics`.

| Scene | What it is | Controls |
|---|---|---|
| **`alley`** | **Start here.** A rainy cyberpunk alley: procedural brick and wet asphalt with puddle ripples, projected decals, volumetric fog and godrays, screen-space reflections, GPU rain, and an animated hero. | **WASD** move (camera-relative) · **Shift** walk · **Space** attack. Leave it alone and the hero walks itself. |
| `hud` | Audio and UI on top of the animation scene — health/stamina HUD, floating name plates and health bars, damage numbers, footsteps, spatial neon buzz, a rain bed, and adaptive music. | **WASD** move · **Shift** walk · **Space** attack · **Esc** menu · **drag** to orbit |
| `streaming` | A 960 m procedural district streamed in 24 m chunks around a flying camera, with LOD swaps, frustum culling, and a loaded level at the origin plaza. | **WASD**/arrows steer (A/D turn, W/S throttle) · **Q/E** altitude · **F3** physics wireframe. Hands off = autopilot. |
| `physics` | A Rapier arena: 300 dynamic boxes and spheres in a seeded pile, a ramp, a sensor volume, a character controller, and pointer hover highlighting. | **WASD**/arrows move · **Space** jump · **hover** to highlight · **F3** physics wireframe |
| `vfx` | GPU particles in a dark yard — fire embers, steam vents, spark bursts, and a 100k-streak rain volume. Live particle counts on screen. | **Space** muzzle flash |
| `animation` | Skeletal animation: an idle/walk/run blend tree with root motion, plus an additive upper-body attack layered over locomotion, and a crowd of 60 mannequins. | **WASD** move · **Shift** walk · **Space** attack · **H** take a hit · **K** die · **R** respawn · **drag** to orbit |
| `entities` | A few thousand ECS entities orbiting on fixed-step systems, drawn as a single instanced call. | — |
| `assets` | GLB loading through the asset pipeline: 200 crates instantiated from one cached template. | — |
| `bootstrap` | The smoke test — a PBR sphere grid sweeping roughness × metalness under one shadowed light. Default scene. | — |

The stats readout in the corner (FPS, CPU/GPU ms, draw calls, triangles, active post effects) is always on. **F2** opens the engine inspector.

## URL options

Stack them with `&`, e.g. `?scene=alley&preset=cinematic&backend=webgpu`.

| Parameter | Values | Notes |
|---|---|---|
| `scene` | any name above | Omit it entirely to get the launcher menu |
| `preset` | `low` `medium` `high` `ultra` `cinematic` | Defaults to `high`. `cinematic` adds depth of field |
| `backend` | `auto` `webgpu` `webgl` | `auto` prefers WebGPU, falls back to WebGL2 |
| `scale` | `0.5`–`1` | Internal render scale |
| `dpr` | e.g. `1` | Cap on device pixel ratio |
| `seed` | integer | Same seed = same scene, every time |
| `overlay` | `0` `1` | Hide/show the stats readout |
| `inspector` | `0` `1` | Open the inspector at start (F2 toggles it anyway) |
| `size` | e.g. `1280x720` | Fixed canvas size instead of filling the window |
| `paused` | `1` | Render one frame and stop |
| `fixedclock` | e.g. `60` | Deterministic clock — every frame advances exactly 1/60 s |
| `warmup` | `0` | Skip shader pre-compilation and eat the stall instead (see `docs/performance/cold-start.md`) |
| `log` | `debug` `info` `warn` `error` `silent` | Console verbosity |

## Troubleshooting

- **Black screen or "Both WebGPU and WebGL2 backends failed"** — check `chrome://gpu`; hardware acceleration is probably off.
- **Long "Compiling shaders" on first load** — normal, especially for `alley` and `streaming`. Subsequent loads are cached.
- **No sound in `hud`** — browsers block audio until you interact with the page. Click once.
- **Choppy** — drop to `&preset=medium` and/or `&scale=0.7`.

---

## For contributors

### Layout

```
packages/engine     @spark/engine — the reusable engine. No game code.
apps/benchmark      the benchmark app and perf scenes (?scene=name)
apps/showcase       the customer game's vertical slice (ADR-005); `pnpm dev:showcase`
tools/capture       headless boot + screenshot + stats (the agent verification loop)
tools/benchmarks    perf runner and per-machine baselines
tools/asset-pipeline normalize / compress / validate GLB assets
tests/visual        golden images per scene × backend × preset
tests/perf          recorded baselines
docs/decisions      ADRs
```

`BROWSER_AAA_ENGINE_PROJECT_KICKOFF.md` is the spec. Design decisions live in `docs/decisions/`.

### Verify

```bash
pnpm check                                    # typecheck + lint + unit tests + production build
pnpm capture --scene=bootstrap --backend=both # screenshot + stats JSON + clean-console check
pnpm visual                                   # capture every manifest entry, diff against goldens (--update to rewrite)
pnpm perf                                     # real-time benchmark vs this machine's baseline (--record to write)
```

"It works" means `pnpm check` passes and `pnpm capture` produced a screenshot you looked at with a clean console. See `tools/capture/README.md` for the headless WebGPU setup.

### Rules that are enforced

- `three` is pinned exactly (ADR-007). Do not bump it.
- `Math.random()` is a lint error. Use `Random` from the engine.
- `packages/engine` never imports from `apps/*`. Apps import only from `@spark/engine`.
- Only `ecs/` imports bitecs; only `physics/` imports Rapier; only `rendering/` touches the three renderer.
