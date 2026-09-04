# Spark Engine — Project Kickoff

> **Project name:** `spark-engine`. Use "Spark" / `spark` for package names, namespaces, and docs. "Browser AAA engine" describes the ambition, not the product; do not name code after it.

> **Working goal:** Build a WebGPU-first browser game engine capable of producing visually exceptional, highly polished 3D games. A WebGL2 compatibility tier exists so the engine boots everywhere, but it is not a supported quality target.

---

# 1. Mission

Build a reusable browser-native 3D game engine with a rendering ceiling far above a typical Three.js project.

The engine should prioritize:

1. **Visual quality**
2. **Stable frame pacing**
3. **Scalable rendering**
4. **Fast iteration**
5. **Modular systems**
6. **AI-agent-friendly architecture**
7. **Browser deployment without native installs**

The target is not to reproduce every subsystem of Unreal Engine or Cyberpunk 2077.

The target is to selectively implement the systems that create the **largest perceived jump in quality** for a browser game.

### Visual benchmark

Reference quality targets:

- Cyberpunk 2077 — lighting, materials, neon, atmosphere
- The Ascent — dense environments and readable isometric visuals
- Returnal — particles, materials, VFX density
- Hades II — animation readability, effects, art direction
- modern AAA games generally — post-processing, camera feel, polish

The engine should be designed so that **individual scenes and screenshots can plausibly look AAA-quality**, while carefully controlling world scale, scene density, draw distance, lighting cost, and simulation complexity.

### Customer game

An engine without a game that needs it sprawls. The engine is built **for a named game**, and that game's needs decide feature priority.

Decision is recorded in **ADR-005 (customer game)**, which has two parts with different deadlines:

- **Multiplayer: no for v1.** Ratified. The simulation stays deterministic anyway (see Game Loop), so this closes no doors, but no gameplay system may assume a network layer exists.
- **Which game: the Task Unit sequel.** Named by Greg 2026-09-04. A single-player sequel to Task Unit in a darker, bloody, cyberpunk aesthetic. The rainy alley benchmark scene is a candidate level for it.

Now that it is named:

- the benchmark scene becomes (or is replaced by) a real level from that game
- the Milestone 10 showcase is that game's vertical slice, not a separate tech demo
- blood, gore, and wet-surface rendering are customer features, not nice-to-haves

Task Unit is a SOCOM-style over-the-shoulder tactical shooter; `docs/design/task-unit-reference.md` summarises what the sequel inherits. Task Unit code is a reference, not a dependency: port designs and data, rewrite anything that fights the engine. The single-player mission shape is in `docs/design/mission-shape.md` (lone operator, objective missions, enemy alert model) and the gore scope in `docs/design/gore-scope.md` (blood and ragdoll committed, dismemberment a post-Milestone-6 stretch).

### Camera model

The visual references above span first-person (Cyberpunk 2077), isometric (The Ascent, Hades II), and third-person (Returnal). The camera model prunes the rendering feature list more than any other decision, so it is fixed early.

Decision is recorded in **ADR-004 (camera model)**. Recommended default:

```text
Primary:      close third-person over the shoulder (the customer game)
Supported:    isometric / three-quarter; cinematic cameras for cutscenes and menus
Unsupported:  first-person
```

Consequences of the recommended default:

- draw distance is bounded by level authoring (sightlines under ~120 m, far plane 200 m behind fog), so density matters more than distance culling and LOD
- two shadow cascades on the default preset; the setting is night, so the shadow budget goes to local lights
- screen-space reflections are mostly floors and puddles, which is exactly the benchmark scene
- camera feel (follow, framing, shake, look-ahead) is an engine feature, not game code

### Non-goals (v1)

Recorded in **ADR-006 (non-goals)**. Each is a deliberate exclusion, not an omission:

| Area | v1 status | Note |
| --- | --- | --- |
| Mobile | out | Constraints below still apply to memory and download size, but no mobile GPU tier is tuned or tested. |
| VR / XR | out | No stereo rendering, no XR input. |
| First-person camera | out | See ADR-004. |
| WebGL2 as a quality tier | out | Compatibility only, Low preset only. See Primary Renderer. |
| Multiplayer | out | Ratified in ADR-005. Determinism is kept regardless so the door stays open. |
| Full visual editor | out | Blender is the level editor. See Level Authoring. |

---

# 2. Core Technology

## Language

**TypeScript**

Requirements:

- strict mode enabled
- no implicit `any`
- explicit public interfaces for major systems
- avoid global mutable state
- prefer dependency injection over hidden singleton dependencies

---

## Build Tool

**Vite**

Use Vite for:

- development server
- hot module replacement
- TypeScript build pipeline
- production bundling
- asset processing hooks

---

## Rendering Framework

**Three.js**

Three.js provides:

- scene graph
- cameras
- transforms
- geometry
- materials
- model loading
- animation primitives
- textures
- render targets
- lighting infrastructure
- browser compatibility

Three.js should be treated as the **rendering foundation**, not the game engine itself.

Do not tightly couple gameplay architecture to Three.js classes.

Whenever possible, gameplay systems should communicate through engine abstractions.

### Audit before building

Three.js ships far more of the target pipeline than this document's feature lists imply. **Before writing any render pass, material feature, or tooling, check what three already provides** under `three/addons/tsl/` and `three/addons/`.

Known to exist at time of writing (verify against the pinned version):

| Need | Three.js provides |
| --- | --- |
| Post-processing graph | `RenderPipeline` + `pass()` with MRT (`output`, `normal`, `velocity`, `depth`, `diffuseColor`) |
| Ambient occlusion | `GTAONode`, `SSAONode` |
| Reflections / GI | `SSRNode`, `SSGINode`, `TemporalReprojectNode`, `RecurrentDenoiseNode` |
| Anti-aliasing | `TRAANode`, `SMAANode`, `FXAANode`, MSAA on the scene pass |
| Bloom, DOF, motion blur | `BloomNode`, `DepthOfFieldNode`, `MotionBlurNode` |
| Grading and finish | `Lut3DNode`, `FilmNode`, `SharpenNode`, `ChromaticAberrationNode`, saturation/sepia/grayscale helpers |
| Many-light rendering | `ClusteredLightsNode` (clustered light culling for WebGPU; three r185 addon) |
| Inspection | `Inspector` addon (`renderer.inspector`), with `toInspector()` on any pass and generated parameter panels |
| Environment | `PMREMGenerator`, `RoomEnvironment`, `HDRLoader`, `KTX2Loader` |

The engine's rendering work is therefore **composition, quality tiers, MRT layout, measurement, and integration with debug tooling**, not reimplementation. Write a custom pass only when a built-in node is missing, measurably too slow, or visibly worse, and record why in an ADR.

---

## Primary Renderer

**Three.js WebGPURenderer**

Rendering priority:

1. WebGPU backend
2. WebGL2 backend (compatibility tier)

WebGPU should be considered the engine's primary graphics API.

### One renderer, two backends

The fallback is **not** the legacy `WebGLRenderer`. It is `WebGPURenderer` running its built-in WebGL2 backend. There is exactly one render pipeline in the codebase.

Requirements:

- the active backend is selectable via engine config and via the `?backend=webgpu|webgl` URL parameter, so both paths can be exercised in CI and by agents
- the engine reports which backend is active in the debug overlay and in `renderer.capabilities`

### Compatibility tier ceiling

The WebGL2 backend promises only: **the engine boots, the scene renders with PBR and shadows at the Low preset, and nothing throws.** It is not a quality target and it does not gate features.

WebGPU-only by design (no fallback implementation will be written):

- compute shaders and storage buffers
- GPU particles and GPU-driven simulation
- GPU culling, indirect drawing, hierarchical Z
- tiled / clustered lighting
- any pass that depends on the above

When a WebGPU-only feature is unavailable, the feature is **off**, not emulated, unless a CPU path already exists for other reasons.

Recorded in **ADR-001 (WebGPU primary renderer and fallback ceiling)**. If WebGPU coverage in the target audience's browsers makes the fallback not worth its test cost, ADR-001 is where dropping it is decided.

### Version pinning

The Three.js WebGPU and TSL APIs still change between releases (renames, signature changes, node reorganizations). Therefore:

- `three` is pinned to an **exact** version, never a range
- upgrading `three` is an ADR-level change: it gets its own branch, the full visual regression suite must pass, and the ADR records what broke
- agents must not bump `three` to work around a bug

Recorded in **ADR-007 (three.js version policy)**.

---

## Shader System

Primary:

**Three Shader Language (TSL)**

Use TSL where possible so rendering logic can target both:

- WGSL / WebGPU
- GLSL / WebGL2

Use custom WGSL when TSL cannot reasonably support a required feature or when lower-level optimization is necessary.

Avoid raw shader code when an equivalent reusable TSL implementation is practical.

---

# 3. Physics

Use:

**Rapier 3D**

Preferred browser target:

**WebAssembly**

Physics should operate independently from rendering.

Physics runs **on the main thread at a fixed timestep** to start. Moving it to a worker requires `SharedArrayBuffer`, which requires cross-origin isolation headers on every host that serves the game. That is a hosting decision, not a code decision, and is recorded in **ADR-002 (physics: Rapier, main thread first)**.

Required initial systems:

- rigid bodies
- static colliders
- dynamic colliders
- triggers
- ray casting
- character collision
- collision layers
- physics debug visualization

Later:

- ragdolls
- joints
- vehicle support
- destruction experiments

---

# 4. Asset Pipeline

Primary 3D format:

**glTF / GLB**

Assets will arrive from **mixed sources**: Blender, Substance, marketplaces (Sketchfab, Kenney), and AI generators. They will disagree on scale, up-axis, handedness, unit size, texture packing, and material conventions. The pipeline's first job is to make them agree.

Recommended pipeline:

```text
Source (Blender / Substance / marketplace / AI generator)
   ↓
glTF / GLB
   ↓
Normalize   (gltf-transform: unit scale, Y-up, dedupe, prune, weld, metal/rough packing, naming)
   ↓
Meshopt     (gltf-transform / gltfpack)
   ↓
KTX2 / Basis textures
   ↓
Validate    (budget check, missing-LOD check, material audit)
   ↓
Engine Asset Pipeline
```

The normalize + compress + validate steps live in `tools/asset-pipeline/` and run from one command. No asset enters `apps/*/public/` without passing through it.

Support:

- GLTFLoader
- Meshopt compression (the only mesh compression; Draco is not used)
- KTX2 textures
- Basis Universal
- HDR environment maps

Prefer GPU-compressed textures in production.

---

# 5. High-Level Engine Architecture

```text
Application
│
├── Game
│   ├── Game State
│   ├── Gameplay Systems
│   ├── AI
│   ├── Combat
│   └── World Logic
│
├── Engine
│   ├── Core
│   ├── ECS / Entity Model
│   ├── Rendering
│   ├── Physics
│   ├── Animation
│   ├── Audio
│   ├── Input
│   ├── Assets
│   ├── World
│   ├── VFX
│   ├── UI
│   └── Debug
│
├── Platform
│   ├── Browser
│   ├── WebGPU
│   ├── WebGL2
│   ├── Workers
│   └── WASM
│
└── Tooling
    ├── Inspector
    ├── Profiler
    ├── Scene Debugger
    └── Asset Tools
```

---

# 6. Recommended Repository Structure

The engine is **a package from day one**. Game code and engine code never share a source tree, because "reusable across games" does not survive `src/engine/` and `src/game/` sitting side by side. Use a pnpm workspace.

```text
/
├── packages/
│   └── engine/                     @spark/engine — the reusable engine, no game code
│       ├── src/
│       │   ├── core/
│       │   │   ├── Engine.ts
│       │   │   ├── Clock.ts
│       │   │   ├── Loop.ts
│       │   │   ├── Events.ts
│       │   │   └── Config.ts
│       │   │
│       │   ├── rendering/
│       │   │   ├── Renderer.ts             wraps WebGPURenderer, backend selection, capabilities
│       │   │   ├── RenderPipeline.ts       composes three's RenderPipeline + TSL display nodes
│       │   │   ├── QualityPresets.ts
│       │   │   ├── CameraSystem.ts         follow / framing / shake / cinematic rigs
│       │   │   ├── LightingSystem.ts
│       │   │   ├── ShadowSystem.ts
│       │   │   ├── materials/
│       │   │   ├── shaders/                TSL nodes and any custom WGSL (the only shader dir)
│       │   │   └── passes/                 custom passes only; built-in nodes are imported, not copied
│       │   │
│       │   ├── physics/
│       │   │   ├── PhysicsWorld.ts
│       │   │   ├── RigidBody.ts
│       │   │   ├── Collider.ts
│       │   │   └── CharacterController.ts
│       │   │
│       │   ├── animation/
│       │   │   ├── Animator.ts
│       │   │   ├── AnimationGraph.ts
│       │   │   ├── StateMachine.ts
│       │   │   └── IK/
│       │   │
│       │   ├── assets/
│       │   │   ├── AssetManager.ts
│       │   │   ├── AssetLoader.ts
│       │   │   ├── AssetCache.ts
│       │   │   └── StreamingManager.ts
│       │   │
│       │   ├── world/
│       │   │   ├── World.ts
│       │   │   ├── Scene.ts
│       │   │   ├── LevelLoader.ts          instantiates entities from glTF extras (see Level Authoring)
│       │   │   ├── SpatialIndex.ts
│       │   │   ├── LODSystem.ts
│       │   │   └── CullingSystem.ts
│       │   │
│       │   ├── ecs/
│       │   │   ├── Entity.ts
│       │   │   ├── Component.ts
│       │   │   ├── System.ts
│       │   │   └── Query.ts
│       │   │
│       │   ├── audio/
│       │   ├── input/
│       │   ├── vfx/
│       │   ├── ui/                         DOM overlay host + world-space UI helpers
│       │   ├── debug/
│       │   └── index.ts                    the public API surface
│       │
│       ├── tests/                          unit + integration (vitest)
│       └── package.json
│
├── apps/
│   ├── benchmark/                  the visual benchmark scene(s) and perf scenes
│   │   ├── public/
│   │   │   ├── hdr/
│   │   │   ├── models/
│   │   │   ├── textures/
│   │   │   └── audio/
│   │   ├── src/
│   │   │   ├── scenes/                 one file per named scene, addressable by ?scene=
│   │   │   └── main.ts
│   │   └── vite.config.ts
│   │
│   └── showcase/                   the customer game's vertical slice (ADR-005)
│       ├── public/
│       ├── src/
│       │   ├── actors/
│       │   ├── combat/
│       │   ├── abilities/
│       │   ├── ai/
│       │   ├── levels/
│       │   ├── systems/
│       │   ├── workers/
│       │   │   ├── ai.worker.ts
│       │   │   └── streaming.worker.ts
│       │   └── main.ts
│       └── vite.config.ts
│
├── tools/
│   ├── asset-pipeline/             normalize / compress / validate (gltf-transform)
│   ├── capture/                    headless boot + screenshot + stats (Playwright)
│   └── benchmarks/                 perf runner, baselines, thresholds
│
├── tests/
│   ├── visual/                     golden images per scene × backend × preset
│   └── perf/                       recorded baselines per machine id
│
├── docs/
│   ├── architecture/
│   ├── rendering/
│   ├── performance/
│   └── decisions/                  ADRs
│
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
└── README.md
```

Rules that keep the split honest:

- `packages/engine` has no imports from `apps/*`
- `apps/*` import only from `@spark/engine`'s `index.ts`, never from deep paths
- anything an app needs twice belongs in the engine; anything only one app needs stays in that app

---

# 7. Rendering Pipeline

The renderer should eventually support a pipeline conceptually similar to:

```text
Scene
  ↓
Visibility / Culling
  ↓
Shadow Rendering
  ↓
Opaque Geometry
  ↓
Lighting
  ↓
Transparent Geometry
  ↓
Particles / VFX
  ↓
Atmospherics
  ↓
Post Processing
  ↓
UI
  ↓
Final Composite
```

Target post-processing pipeline:

```text
HDR Scene
   ↓
Depth / Normal / Velocity Data
   ↓
Ambient Occlusion
   ↓
Reflections
   ↓
Volumetric Lighting
   ↓
Fog / Atmosphere
   ↓
Temporal Anti-Aliasing
   ↓
Motion Blur
   ↓
Bloom
   ↓
Depth of Field
   ↓
Tone Mapping
   ↓
Color Grading
   ↓
Sharpening
   ↓
Film Grain
   ↓
Final Composite
```

Not every effect must be enabled simultaneously.

The pipeline must support configurable quality tiers.

Nearly every stage above maps to an existing TSL display node (see *Audit before building*). `RenderPipeline.ts` composes those nodes into a graph driven by the active quality preset, owns the MRT layout so passes share one normal / velocity / depth prepass, and exposes every stage to the debug overlay and inspector. It does not reimplement them.

---

# 8. Rendering Features

Legend: **(three)** = provided by three.js, engine work is integration and tiers. **(build)** = engine-authored. **(WebGPU only)** = no compatibility-tier path will be written.

## Phase 1

Implement first:

- PBR (three)
- HDR rendering (three)
- image-based lighting (three)
- directional lights (three)
- point lights (three)
- spot lights (three)
- shadow maps (three)
- tone mapping (three)
- bloom (three)
- basic fog (three)
- GPU instancing (three)
- frustum culling (three, plus engine-level distance culling)
- LOD (three `LOD`, plus engine LOD policy per asset budget)
- texture compression (three KTX2Loader + pipeline)
- quality presets and dynamic resolution (build)

---

## Phase 2

Add:

- GTAO / SSAO (three)
- cascaded shadow maps (three CSM addon; validate against the camera model, one or two cascades may be enough)
- temporal anti-aliasing (three TRAA)
- motion vectors (three MRT `velocity`)
- motion blur (three)
- depth of field (three)
- screen-space reflections (three SSR + denoise)
- decals (build, or three DecalGeometry for static decals)
- contact shadows (build)
- improved atmospheric fog (build, TSL)

---

## Phase 3

Explore:

- tiled / clustered lighting (three ClusteredLightsNode; WebGPU only)
- volumetric fog (build; WebGPU only)
- volumetric lighting (build; WebGPU only)
- GPU-driven particles (build, compute; WebGPU only)
- compute shader simulations (build; WebGPU only)
- GPU culling (build; WebGPU only)
- indirect drawing (build; WebGPU only)
- hierarchical Z occlusion (build; WebGPU only)
- SSGI (three; evaluate cost)
- GPU skinning improvements (three)
- procedural materials (build, TSL)
- vegetation simulation (build, TSL / compute)

---

# 9. Material System

Create an engine-level material abstraction.

Base material properties:

```text
baseColor
normal
roughness
metalness
ambientOcclusion
emissive
opacity
alphaMode
clearcoat
clearcoatRoughness
transmission
ior
normalScale
uvScale
uvOffset
```

Future material extensions:

- wet surfaces
- snow
- dust
- damage
- holograms
- energy
- dissolve
- animated emissive
- vertex displacement
- terrain blending
- skin
- hair
- foliage

Prefer reusable shader nodes over one-off shader files.

---

# 10. Lighting Strategy

Lighting quality is a top priority.

Target support:

- physically based lighting
- HDR environment lighting
- directional sunlight
- cascaded shadows
- local point lights
- spotlights
- emissive surfaces
- reflection probes
- baked lighting where useful
- dynamic hero lights

Longer-term:

**Tiled / clustered light assignment** (three.js `ClusteredLightsNode` is the starting point; WebGPU only)

This is especially important for environments containing many:

- neon lights
- street lights
- muzzle flashes
- signage
- VFX lights
- interior fixtures

---

# 11. VFX System

The VFX system should be treated as a first-class engine feature.

Support:

- GPU particles
- sprite particles
- mesh particles
- trails
- ribbons
- decals
- impact effects
- distortion
- emissive effects
- dissolve effects
- animated materials
- screen-space effects

Compute shader candidates:

- particle simulation
- flocking
- sparks
- smoke approximation
- rain
- snow
- vegetation movement
- debris fields

Goal:

Thousands to hundreds of thousands of lightweight visual elements when appropriate.

---

# 12. Animation

Required:

- skeletal animation
- animation clips
- blend trees
- state machines
- additive animation
- animation events
- crossfading
- root motion support

Later:

- procedural aim offsets
- foot IK
- hand IK
- look-at constraints
- ragdoll blending
- animation warping
- motion matching experiments

Animation polish is considered as important as rendering quality.

---

# 13. UI

Two layers, chosen by where the UI lives, not by taste:

```text
Screen-space UI  (menus, HUD, inventory, settings, dialogs)
   → DOM + CSS overlay above the canvas

World-space UI   (health bars over enemies, damage numbers, interaction prompts, holographic signage)
   → in-canvas: instanced sprites / meshes, or CSS2D/CSS3D anchored to entities when count is small
```

Why DOM for screen-space:

- iteration speed, accessibility, text rendering, and input handling are all solved
- AI agents are far more reliable in DOM than in custom canvas UI
- it keeps the renderer honest: the render pipeline never grows a UI subsystem

Rules:

- the engine's `ui/` module owns the overlay host, layering, pointer-capture hand-off between DOM and canvas, and an entity-to-screen projection helper
- game UI is built in the app, not the engine
- world-space UI must be pooled and batched; no per-entity DOM nodes at scale

---

# 14. Entity Architecture

Prefer a lightweight ECS-inspired architecture.

Requirements:

- entities should be cheap
- components should primarily contain data
- systems operate on relevant component sets
- renderer objects should not become gameplay objects

Example:

```text
Entity 42
│
├── Transform
├── MeshRenderer
├── RigidBody
├── Health
├── Enemy
└── Animator
```

Avoid deeply nested inheritance chains.

Prefer composition.

### Build vs. adopt

Writing a bespoke ECS is a common way to spend a month before anything renders. **ADR-003 (entity model)** adopts **`bitecs`**, wrapped behind engine interfaces.

Why bitecs:

- tiny, zero dependencies, typed-array (structure-of-arrays) component storage
- components are plain numeric data by construction, which enforces the data/system split above
- fast queries at entity counts well beyond what this engine needs
- widely known, so agents produce correct code for it

Rules that come with it:

- **components hold numbers only.** Resources (Three.js objects, Rapier handles, strings, asset references) live in engine-owned side tables keyed by entity id, never inside components. This is a feature: it keeps renderer objects from becoming gameplay objects.
- **exact version pin.** bitecs 0.4 changed its API from 0.3 (no `defineComponent`, components are plain SoA objects, queries and observers are different). Agents frequently write 0.3-style code from memory. The ADR records the pinned version and a short "what changed" note, and `ecs/` is the only module that imports bitecs directly.
- the `ecs/` wrapper exposes entity lifecycle, component registration, queries, and systems as engine types. Nothing outside `ecs/` touches bitecs APIs, so the library can be swapped (miniplex is the object-based alternative if ergonomics chafe) without touching gameplay code.
- do not build archetype storage, change detection, or serialization on top of it before a game needs them.

---

# 15. Game Loop

Target architecture:

```ts
input()
fixedUpdate()
physics()
update()
lateUpdate()
render()
```

Physics should run using a fixed timestep.

Rendering should use variable timestep interpolation where useful.

Avoid coupling simulation speed to display refresh rate.

### Determinism

The simulation (fixed-step physics + gameplay) must be **deterministic given the same inputs**, regardless of whether the customer game is multiplayer:

- gameplay randomness comes from a seeded RNG owned by the simulation, never `Math.random()`
- simulation never reads wall-clock time, frame delta, or render state
- the fixed step is an integer number of ticks per second and is never scaled by frame rate

This costs almost nothing now and makes netcode, replays, and deterministic visual tests possible later.

---

# 16. Web Workers

Move suitable CPU-heavy systems off the main thread.

Candidates:

- AI planning
- navigation
- procedural generation
- world streaming
- asset preprocessing
- background simulation

Do not move work to workers simply because workers exist.

Only move workloads where serialization / communication overhead is justified.

Physics is explicitly **not** on this list for v1 (see ADR-002). Any worker that needs shared memory with the main thread requires `SharedArrayBuffer`, which requires `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers on the host, which in turn breaks some third-party embeds. Treat that as a hosting-level decision recorded in an ADR before any code depends on it.

---

# 17. Performance Targets

Primary desktop target:

**1920×1080**

Goal:

**60 FPS**

Frame budget:

CPU and GPU run in parallel. Each has its own 16.67 ms, and neither may exceed it. The frame is late if **either** does.

```text
CPU (main thread)          16.67 ms
  Input + events            <0.5 ms
  Physics (fixed step)      1–2 ms
  Gameplay + AI             1–2 ms
  Animation                 1–2 ms
  Scene update + culling    1–2 ms
  Render submission         2–4 ms   (draw call encoding, uniform uploads)
  Browser / GC headroom     remaining

GPU                        16.67 ms
  Shadows                   1–3 ms
  Opaque + lighting         4–6 ms
  Transparent + VFX         1–2 ms
  Post-processing           3–5 ms
  UI / composite            <0.5 ms
```

Measuring GPU time: reliable only on the WebGPU backend via timestamp queries (`renderer.resolveTimestampsAsync`, requires the `timestamp-query` feature). On the WebGL2 backend, treat GPU time as unavailable and report it as such rather than guessing.

Stretch target:

**1440p / 60 FPS on strong desktop GPUs**

Lower-end systems should use quality scaling.

---

# 18. Quality Presets

Implement:

```text
Low
Medium
High
Ultra
Cinematic
```

Adjustable parameters include:

- render resolution
- shadow resolution
- shadow cascade count
- reflection quality
- AO quality
- volumetric quality
- particle density
- LOD distance
- draw distance
- texture resolution
- post-processing
- dynamic light count

---

# 19. Dynamic Resolution

Plan for dynamic resolution scaling.

Example:

```text
Target: 60 FPS

GPU > 16.6 ms
   ↓
reduce internal render scale

GPU < target budget
   ↓
increase render scale
```

Suggested bounds:

```text
0.6x – 1.0x
```

Upscaling and sharpening can hide moderate resolution reductions.

---

# 20. World Optimization

Required eventually:

- frustum culling
- distance culling
- LOD
- instancing
- spatial partitioning
- object pooling
- asset streaming
- texture compression
- asynchronous loading

Later:

- occlusion culling
- HZB
- GPU culling
- indirect rendering
- world chunk streaming

---

# 21. Asset Budgets

Initial guidelines.

These are not immutable limits.

## Hero character

```text
Triangles:      60k–150k
Textures:       2K–4K
Materials:      minimize unique draw calls
LOD levels:     3+
```

## Standard enemy

```text
Triangles:      20k–60k
Textures:       1K–2K
LOD levels:     3+
```

## Environment prop

```text
Triangles:      1k–50k
Texture:        512–2K
LOD levels:     as appropriate
```

Use instancing aggressively for repeated geometry.

---

# 22. Browser Constraints

The engine must respect browser realities.

Important constraints:

- initial download size
- memory pressure
- texture memory
- garbage collection
- tab suspension
- WebGPU availability
- mobile GPU limits (mobile is a v1 non-goal; these still bound memory and download size)
- browser security model

Avoid allocations inside hot frame loops.

Reuse:

- vectors
- matrices
- arrays
- render resources
- particle buffers

---

# 23. Memory Management

Create explicit lifecycle patterns.

Every resource-owning object should implement a clear disposal path.

Examples:

```ts
initialize()
update()
dispose()
```

Dispose:

- textures
- geometry
- render targets
- materials
- GPU buffers
- audio resources
- physics objects

Do not rely exclusively on garbage collection.

---

# 24. Debug Tooling

Build debug tooling early.

Required overlays:

- FPS
- CPU frame time
- GPU frame time
- draw calls
- triangles
- visible objects
- texture memory estimate
- active lights
- shadow casters
- physics bodies
- particle counts

Debug views:

- wireframe
- normals
- depth
- motion vectors
- AO
- shadow cascades
- LOD level
- collider visualization
- bounding boxes
- light volumes

---

# 25. Engine Inspector

Eventually create an in-browser inspector.

Desired capabilities:

- scene hierarchy
- entity selection
- transform editing
- component inspection
- material inspection
- lighting controls
- graphics settings
- profiler
- shader debugging
- render-pass toggles

Do not block engine development on building a full editor.

Start with a developer inspector, and start by **wrapping three.js's own `Inspector` addon** (`renderer.inspector`), which already provides render-pass views via `toInspector()`, generated parameter panels, and renderer stats. Engine-specific panels (entities, components, quality presets, physics) attach to it rather than replacing it.

---

# 26. Level Authoring

There is no in-engine editor, so this section answers "how does a level get made?" before anyone asks.

**Blender is the level editor.** A level is a glTF/GLB exported from Blender, and the engine instantiates gameplay from it.

```text
Blender scene
  ├── static geometry          → meshes, materials, instancing hints
  ├── lights                   → engine lights (three's glTF light extension)
  ├── empties with properties  → entities: spawn points, triggers, props, enemies, cameras
  ├── collision meshes         → colliders (by naming convention or property)
  └── custom properties        → glTF `extras`, read by LevelLoader
```

Conventions:

- an object's gameplay role comes from a `spark.type` custom property (e.g. `spawn`, `trigger`, `enemy`, `prop`, `light_hero`), never from parsing names
- other `spark.*` properties are the entity's initial component data
- collision meshes are prefixed `COL_` and never rendered
- one GLB per level, plus shared prop libraries loaded through the asset pipeline
- the round trip Blender → export → pipeline → `?scene=` in the benchmark app must be **one command** so agents and humans can iterate

`LevelLoader.ts` in `world/` owns the `extras` → entity mapping. It is the only place the glTF-to-gameplay convention is interpreted.

Recorded in **ADR-008 (level authoring via Blender and glTF extras)**.

---

# 27. Testing

Required categories:

## Unit tests

Test:

- math helpers
- ECS
- asset registry
- state machines
- configuration
- serialization

## Integration tests

Test:

- renderer initialization
- model loading
- physics lifecycle
- scene transitions

## Visual regression tests

Capture known scenes and compare renders.

Use these aggressively for renderer development.

Mechanics:

- `tools/capture/` boots a named scene headlessly with Playwright, with a **fixed seed, fixed simulation time, fixed resolution, and DPR 1**, screenshots it, and writes the debug stats as JSON
- golden images live in `tests/visual/` keyed by `scene × backend × preset`
- comparison uses a perceptual diff with a per-scene threshold; TAA and other temporal effects are settled by stepping a fixed number of frames before capture
- headless WebGPU in Chrome needs explicit flags (currently `--enable-unsafe-webgpu` plus a GPU or SwiftShader selection); document the exact working command in `tools/capture/README.md` and keep it current
- the same capture tool is the **agent verification loop** (see AI-Agent Development Rules): an agent cannot "look at" the scene any other way

Tests live next to what they test (`packages/engine/tests/`) for unit and integration, and in `/tests` for cross-package visual and perf suites.

---

# 28. Performance Regression Testing

Create benchmark scenes.

Examples:

### Benchmark A — Geometry

- thousands of meshes
- instanced vs non-instanced

### Benchmark B — Lighting

- many point lights
- shadowed and unshadowed

### Benchmark C — Characters

- many animated skinned meshes

### Benchmark D — Particles

- 10k
- 50k
- 100k+
- GPU simulation

### Benchmark E — Environment

Dense representative game scene.

Record:

```text
FPS
CPU ms
GPU ms
draw calls
triangles
memory
```

Performance regressions are test failures. "Substantial" is defined numerically so it cannot be argued away:

- baselines are recorded **per machine id** (GPU name + driver + OS), since absolute timings are not comparable across machines
- a run fails if CPU or GPU frame time regresses **more than 10%** against that machine's baseline, or draw calls / triangles / memory regress more than 5%, for any benchmark scene
- each benchmark runs a fixed number of warm-up frames and reports the median over a fixed sample window
- a baseline may only be re-recorded by a commit that says why, with the old and new numbers in the message

---

# 29. Code Standards

Every engine subsystem should have:

1. clear responsibility
2. documented public interface
3. minimal hidden state
4. lifecycle methods
5. cleanup path
6. performance considerations
7. debug hooks

Avoid giant classes.

Bad:

```text
GameEngine.ts
5000 lines
```

Good:

```text
Engine
Renderer
RenderPipeline
AssetManager
PhysicsWorld
AnimationSystem
World
InputManager
AudioSystem
```

---

# 30. AI-Agent Development Rules

This project is expected to be developed heavily with AI coding agents.

Every agent should:

1. inspect existing architecture before editing
2. preserve public APIs unless intentionally changing them
3. avoid duplicate systems
4. write strongly typed code
5. add tests where appropriate
6. benchmark performance-sensitive changes
7. document architectural decisions
8. avoid replacing working systems without evidence
9. check browser console for warnings/errors
10. run the project before declaring work complete
11. check the *Audit before building* table and `three/addons/tsl/` before writing any pass, node, or tool
12. never change the pinned `three` version (ADR-007)
13. never add game-specific code to `packages/engine`

For visual tasks, agents should compare output against reference targets.

"Technically works" is not sufficient.

### Verification loop

Agents cannot see the screen, so the project provides commands that make the output inspectable. These exist from Milestone 0 and every agent uses them before declaring work complete:

```text
pnpm check                      typecheck + lint + unit tests + production build
pnpm capture --scene=<name>     headless boot, screenshot to disk, stats JSON, console log
                                  [--backend=webgpu|webgl] [--preset=Low..Cinematic]
pnpm visual                     capture every scene and diff against goldens
pnpm perf                       run benchmark scenes and compare against this machine's baseline
```

"I ran it and it works" means the capture command produced a screenshot the agent looked at, the console log is clean, and `pnpm check` passed.

---

# 31. Architecture Decision Records

Major technical choices should be documented in:

```text
docs/decisions/
```

Each ADR should contain:

```text
Context
Decision
Alternatives
Consequences
Status
```

This prevents future agents from repeatedly revisiting settled decisions.

### Initial ADR set

These are created as files during bootstrap. Ones marked *proposed* carry the recommended decision from this document and need ratification before the milestone that depends on them.

| ADR | Title | Status | Needed before |
| --- | --- | --- | --- |
| ADR-001 | WebGPU primary renderer; WebGL2 is a compatibility tier with a fixed ceiling | proposed | Milestone 0 |
| ADR-002 | Physics: Rapier on the main thread at a fixed step; worker move is a hosting decision | proposed | Milestone 4 |
| ADR-003 | Entity model: adopt bitecs behind engine interfaces; numeric components, side tables for resources | ratified | Milestone 1 |
| ADR-004 | Camera model: isometric / third-person primary, first-person unsupported | proposed | Milestone 2 |
| ADR-005 | Customer game: multiplayer is **no** for v1; the game is the **Task Unit sequel** (single-player, dark bloody cyberpunk) | ratified | Milestone 5 |
| ADR-006 | v1 non-goals: mobile, VR, first-person, WebGL2 quality tier, full editor | proposed | Milestone 0 |
| ADR-007 | three.js version policy: exact pin, upgrades gated by the visual suite | proposed | Milestone 0 |
| ADR-008 | Level authoring: Blender as editor, glTF extras as the entity format | proposed | Milestone 3 |

Stub for the two open decisions, so they are not forgotten:

```text
ADR-004 Camera model
  Context:       references span first-person, isometric, and third-person; the choice
                 decides shadow cascades, LOD budgets, SSR usefulness, draw distance.
  Decision:      isometric / three-quarter and close third-person are primary.
                 First-person is unsupported in v1.
  Alternatives:  support all three (rejected: triples rendering validation surface);
                 first-person primary (rejected: does not match the customer game).
  Consequences:  1–2 shadow cascades, bounded draw distance, camera feel becomes
                 an engine feature (CameraSystem.ts), SSR tuned for floors/puddles.
  Status:        proposed

ADR-005 Customer game
  Context:       an engine without a game that needs it sprawls; the doc's own
                 showcase milestone is at risk of being a tech demo nobody ships.
                 The multiplayer question sets the bar for every gameplay system,
                 so it cannot wait; the choice of game can wait until gameplay starts.
  Decision:      Multiplayer: NO for v1. Single-player only; no gameplay system
                 may assume a network layer. Determinism (Game Loop) is kept anyway.
                 Game: the Task Unit sequel, single-player, darker bloody cyberpunk
                 aesthetic. The rainy alley benchmark is a candidate level. Camera
                 per ADR-004: isometric or close third-person.
  Alternatives:  engine-first with a synthetic showcase (rejected: no forcing function);
                 multiplayer from day one (rejected: doubles gameplay scope for a
                 game that is not yet named).
  Consequences:  Milestone 10 is that game's vertical slice; feature priority
                 follows that game's needs, not the feature lists in this doc.
                 Camera: close third-person over the shoulder, inherited.
                 Mission shape: lone-operator objective missions with an enemy
                 alert model (docs/design/mission-shape.md). Gore: blood and
                 ragdoll committed, dismemberment stretch (docs/design/gore-scope.md).
  Status:        ratified (multiplayer 2026-09-03, game named 2026-09-04)

ADR-003 Entity model
  Context:       a bespoke ECS is a classic month-long detour before anything renders;
                 the doc requires cheap entities, data-only components, composition.
  Decision:      adopt bitecs (exact pin), wrapped in ecs/ behind engine interfaces.
                 Components are numeric SoA data only; Three.js objects, Rapier
                 handles, strings and asset refs live in side tables keyed by entity id.
  Alternatives:  minimal in-house model (rejected: re-derives what bitecs already does);
                 miniplex (kept as the object-based fallback if ergonomics chafe;
                 the ecs/ wrapper makes the swap local).
  Consequences:  only ecs/ imports bitecs; the ADR carries a 0.3 → 0.4 API note
                 because agents write 0.3-style code from memory; no archetype
                 storage, change detection or serialization until a game needs it.
  Status:        ratified
```

---

# 32. Development Philosophy

Prioritize perceived quality.

A technically sophisticated effect should not be implemented merely because it is possible.

Ask:

> Will the player actually notice?

Example:

A high-quality combination of:

- lighting
- shadows
- materials
- fog
- animation
- camera
- particles
- sound

will usually produce a larger perceptual improvement than an exotic rendering feature used poorly.

---

# 33. First Vertical Slice

Before building a large game, create a **visual benchmark scene**.

The benchmark should contain:

- one high-quality environment
- one hero character
- one enemy
- reflective surfaces
- metallic surfaces
- wet surfaces
- neon lighting
- fog
- particles
- animated props
- dynamic shadows
- HDR lighting
- post-processing

Suggested visual concept:

**Rainy cyberpunk alley at night**

Why:

It stresses nearly every system we care about:

- neon
- reflections
- wet materials
- emissives
- fog
- particles
- skin
- metal
- lighting
- transparency
- decals
- shadows

This scene becomes the engine's visual benchmark.

---

# 34. Milestone 0 — Bootstrap

Create:

- Vite
- TypeScript
- Three.js
- WebGPURenderer
- WebGL2 fallback
- basic camera
- resize handling
- animation loop
- debug FPS
- environment configuration

Acceptance criteria:

- runs in Chrome
- WebGPU detected correctly
- fallback renderer functions
- resize works
- no console errors
- stable empty-scene frame loop

---

# 35. Milestone 1 — Engine Core

Implement:

- Engine
- Clock
- main loop
- configuration
- events
- scene lifecycle
- input
- debug logger
- entity model (per ADR-003): entities, components, systems, queries, lifecycle

Acceptance criteria:

```ts
const engine = new Engine(config)

await engine.initialize()

engine.start()
```

Engine should expose clean subsystem interfaces.

The entity model lands here, not after physics, because every later milestone (renderables, bodies, animators) attaches to entities. Building those against ad hoc objects and retrofitting an entity model later is the expensive path.

---

# 36. Milestone 2 — Rendering Foundation

Implement:

- renderer abstraction
- HDR environment
- PBR
- tone mapping
- shadows
- lighting
- post-processing pipeline
- render statistics

Build initial benchmark environment.

---

# 37. Milestone 3 — Assets

Implement:

- AssetManager
- GLB loading
- KTX2
- Meshopt
- texture caching
- loading progress
- asset disposal

Acceptance criteria:

```ts
const model = await assets.loadModel("alley.glb")
```

Repeated requests should reuse cached assets.

---

# 38. Milestone 4 — Physics

Integrate Rapier.

Implement:

- PhysicsWorld
- bodies
- colliders
- triggers
- raycasts
- debug renderer
- simple character controller

---

# 39. Milestone 5 — Gameplay Slice

The entity model already exists (Milestone 1). This milestone proves it under real gameplay and lands the first level through the authoring path.

Implement:

- `LevelLoader` (glTF extras → entities, per ADR-008)
- player controller on top of the physics character controller
- camera rig per ADR-004
- DOM HUD through the engine's UI host

Demonstrate:

- player operator
- one enemy with the full awareness model (`docs/design/mission-shape.md`)
- a Reach and a Plant objective with checkpoint reload
- a level authored in Blender, round-tripped through the asset pipeline with one command, carrying objective and patrol data

---

# 40. Milestone 6 — Animation

Implement:

- skeletal animation
- animation state machine
- blend transitions
- animation events
- additive hit reactions by hit zone
- death ragdoll with animation-to-physics blending (`docs/design/gore-scope.md`)

Stretch, decided after this milestone lands: dismemberment via pre-split limb meshes.

Demo:

```text
Idle
↓
Walk
↓
Run
↓
Attack
↓
Hit
↓
Death
```

---

# 41. Milestone 7 — Advanced Rendering

Add selectively, integrating three's TSL display nodes first and building only what is missing:

- GTAO (three)
- TRAA (three)
- motion vectors (three MRT)
- motion blur (three)
- depth of field (three)
- SSR + denoise (three)
- decals (build; blood decals and growing pools are the first customer)
- per-character wound masks (build; small UV-space render-to-texture)
- volumetric fog (build; WebGPU only)

Every effect must have:

- on/off switch
- quality setting
- measured performance impact

---

# 42. Milestone 8 — GPU VFX

Build GPU particle system.

Demo:

- rain
- sparks
- muzzle effects
- blood sprays
- smoke approximation
- ambient particles

Performance target:

At least tens of thousands of active particles while maintaining acceptable frame time on target hardware.

---

# 43. Milestone 9 — Streaming + Scale

Add:

- chunked world loading
- background asset loading
- LOD
- distance culling
- spatial indexing

Build a larger benchmark environment.

---

# 44. Milestone 10 — Engine Showcase

Create a polished playable demo.

Target:

**5–10 minutes**

One complete mission of the Task Unit sequel: three objectives, 8 to 12 enemies with routes and level alert states, extraction.

Should demonstrate:

- movement
- combat
- enemy AI
- interaction
- high-quality environment
- dynamic lighting
- particles
- animation
- post-processing
- audio

The showcase should exist primarily to prove the engine.

---

# 45. Initial package direction

Exact versions should be selected when the repository is initialized.

Likely dependencies:

```text
three                       exact pin (ADR-007)
@dimforge/rapier3d-compat
vite
typescript
pnpm                        workspace tooling
vitest                      unit + integration tests
playwright                  headless capture, visual + perf suites
@gltf-transform/cli         asset pipeline (normalize / meshopt / ktx2)
```

Possible additional packages:

```text
meshoptimizer               runtime decoder for Meshopt-compressed GLB
bitecs                      entity model (ADR-003), exact pin
pixelmatch or similar       perceptual diff for visual tests
```

Not needed: `stats.js` and `lil-gui` are covered by three's `Inspector` addon and the engine's own overlay.

Avoid unnecessary dependency growth.

Prefer native browser APIs where practical.

---

# 46. Initial Main Loop Concept

```ts
class Engine {
  async initialize(): Promise<void> {
    // initialize platform
    // initialize renderer
    // initialize physics
    // initialize assets
    // initialize world
  }

  start(): void {
    requestAnimationFrame(this.frame)
  }

  private frame = (time: number): void => {
    const delta = this.clock.tick(time)

    this.input.update()

    this.fixedStep.update(delta, () => {
      this.physics.step()
      this.world.fixedUpdate()
    })

    this.world.update(delta)
    this.animation.update(delta)
    this.world.lateUpdate(delta)

    this.renderer.render(this.world)

    requestAnimationFrame(this.frame)
  }
}
```

This is illustrative, not final architecture.

---

# 47. First Task for Coding Agent

Use the following as the initial implementation task.

## Task

Bootstrap the browser AAA engine repository.

### Requirements

Create a pnpm workspace with `packages/engine` (`@spark/engine`) and `apps/benchmark`, using Vite, TypeScript, and an exact-pinned Three.js.

Implement:

1. `Engine`
2. `Renderer`
3. `Clock`
4. `GameLoop`
5. `EngineConfig`
6. `DebugStats`
7. `tools/capture` (headless boot + screenshot + stats JSON)
8. `docs/decisions/ADR-001` through `ADR-008` as files, with the statuses from the ADR table

Renderer requirements:

- attempt WebGPU initialization first
- cleanly detect WebGPU availability
- fall back to `WebGPURenderer`'s WebGL2 backend (not the legacy `WebGLRenderer`)
- allow forcing either backend via config and the `?backend=` URL parameter
- expose renderer capability information, including which backend is active
- handle canvas resizing
- handle device pixel ratio safely (render at an internal scale, treat DPR as the upscale target)
- render a test scene selected by `?scene=`

Test scene:

- perspective camera
- HDR or neutral environment
- directional light
- ground plane
- several PBR objects
- animated object
- visible shadowing

Add a debug overlay showing:

```text
Renderer
FPS
Frame Time
Resolution
Pixel Ratio
Draw Calls
Triangles
```

### Engineering requirements

- strict TypeScript
- modular files
- no giant monolithic classes
- no global mutable state
- graceful renderer initialization failure
- dispose resources correctly
- browser console must be clean
- document how to run the project
- `pnpm check` and `pnpm capture` exist and work

### Completion criteria

The task is complete only when:

- project installs successfully
- dev server runs
- scene renders
- WebGPU path works on supported browser
- WebGL2 backend boots and renders the same scene when forced
- resize works
- no runtime exceptions
- debug statistics update correctly, including active backend
- `pnpm capture --scene=bootstrap` produces a screenshot for both backends and a clean console log
- production build succeeds
- the ADR files exist

---

# 48. First Visual Benchmark

After bootstrap, immediately begin the first visual benchmark.

## Scene

**Rainy Cyberpunk Alley**

Required elements:

- dark urban alley
- wet pavement
- neon signs
- puddles
- dense props
- steam
- rain
- emissive lights
- reflective metal
- one animated character
- strong foreground/background separation

Target emotional response:

> "This does not look like a browser game."

Do not expand the world until this single scene reaches an exceptional quality bar.

---

# 49. Definition of Done

A feature is not done when it merely renders.

It is done when:

- it works
- it is typed
- it is documented
- it can be disabled
- it cleans itself up
- its performance cost is measurable
- it integrates with debug tooling
- the WebGL2 compatibility tier still boots and renders the Low preset (WebGPU-only features simply switch off there; that is expected, not a break)
- it has a golden image in the visual suite if it changes pixels
- visual output meets the intended quality target

---

# 50. Immediate Priority Order

This order matches the milestones above; if they ever disagree, the milestones win and this list gets fixed.

```text
1. Bootstrap + capture tooling + ADR files            (Milestone 0)
2. Engine lifecycle + entity model                     (Milestone 1)
3. WebGPU renderer, lighting, PBR, shadows, post       (Milestone 2)
4. Benchmark environment, first pass                   (Milestone 2)
5. Asset pipeline + level authoring path               (Milestone 3)
6. Physics + character controller                      (Milestone 4)
7. Gameplay slice: player, enemy, prop, Blender level  (Milestone 5)
8. Animation                                           (Milestone 6)
9. Advanced rendering                                  (Milestone 7)
10. GPU VFX                                            (Milestone 8)
11. Streaming + scale                                  (Milestone 9)
12. Showcase = customer game vertical slice            (Milestone 10)
```

Do not spend months building abstract engine systems before producing a visually impressive scene.

The benchmark scene should evolve alongside the engine.

---

# 51. North Star

The purpose of the engine is not to maximize feature count.

The purpose is:

> **Deliver the highest perceived visual and interactive quality that can reasonably be achieved inside a modern web browser.**

Every architectural decision should be evaluated against that goal.
