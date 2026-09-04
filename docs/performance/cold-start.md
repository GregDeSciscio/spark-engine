# Cold start: shader compile

Measured 2026-09-04 on the reference machine (NVIDIA GeForce RTX 4070, AMD Ryzen 7 3700X, Windows 11; headless full Chromium via Playwright, D3D11 ANGLE, Dawn on FXC), WebGPU backend, 1280×720, `overlay=0`. Probes live in `tools/capture/out/` (gitignored): `probe-stall.mjs` (real time: `ready` → frames), `probe-pipelines.mjs` (pipeline / program counts after 5 frames), `probe-inventory.mjs` (per-pipeline label, pass shape, WGSL size, dumps the shaders), `probe-compile-cost.mjs` (compile time per shader kind, sequential vs parallel), `probe-golden-diff.mjs` (pixelmatch a capture against its golden).

## What was found

`?scene=alley&preset=high` reported `ready` at 2.8 s, rendered frames 2–3, then **no rAF for 18 s** (frame 4 at +18.3 s); `preset=low` stalled 12 s, `bootstrap` ~1 s, `streaming` ~2 s. The main thread was free the whole time: the GPU process was compiling pipelines. Three's `WebGPUBackend.createRenderPipeline` uses the synchronous `device.createRenderPipeline`, which Dawn compiles on the GPU process's main thread; every frame queued behind those compiles, so the compositor stopped asking for frames.

Three numbers explain the 18 s:

1. **One pipeline per material × pass variant, and the alley made 124 of them** (45 in the 4-target scene-pass MRT, 31 in the AO prepass, 19 shadow, 12 post, 8 compute, 5 PMREM). A scene-pass `MeshStandardNodeMaterial` fragment shader here is 70–88 KB of WGSL: 13 lights (moon, hemisphere, hero spot, 9 neon points, 2 spill spots) unrolled through the PBR model plus the noise chains. Measured with `createRenderPipelineAsync` on the dumped WGSL: **250 ms for a wet prop, 750 ms for the brick wall**; the prepass copies were 165–510 ms; a shadow depth pipeline 20–35 ms; post quads 50–130 ms; PMREM GGX 45–75 ms. 45 × ~0.3 s + 31 × ~0.2 s is the stall.
2. **Structurally identical graphs never share a program.** `Node.customCacheKey()` is the node's `id`, so a material's program key hashes the node *instances* of its graph. The alley built a fresh graph per material: 15 `wetStandard(hex, roughness, metalness)` props, 6 posters, 4 blob decals, 2 hero skins, each with its constants baked in, so 30 `MeshStandardNodeMaterial` programs per pass where the look needed 9. Three also folds `colorNode.a` into a caster's shadow pass, so the same graphs made 19 shadow variants.
3. **The AO prepass compiled the full lit shader to write a normal.** The prepass renders every opaque material with its own graph (so the mortar and puddle normals feed GTAO), but NodeMaterial still built all 13 lights, shadows and the environment into a shader whose only output was `packNormalToRGB(normalView)`: 31 programs of 64–86 KB, dead code that FXC still had to chew through.

The async API changes the picture: Dawn compiles `createRenderPipelineAsync` pipelines on worker threads, **eight at once in 1.5–2× the time of one** on this CPU, and never blocks the queue. Three already supports it (`Pipelines.getForRender(renderObject, promises)`), but only through `Renderer.compileAsync`, which renders the scene against the renderer's *own* target and MRT rather than the pipeline's pass targets, so it never sees the pass variants and was previously reported to break on the MRT layout. It is not used.

## What was done

- **Shared graphs in the alley** (`apps/benchmark/src/scenes/alley.ts`): one wet-sheen graph reading `materialColor` / `materialRoughness`, one hero-skin graph, one graph per decal family (blob, streak, torn poster) with `edge`, `seed`, `stripes`, `accent`, `streakScale` read from `material.userData` through `materialParam()`. 30 standard-node programs per pass became 9 (three of them the wet family: `receiveShadow` and instancing are program variants in three), and the shadow pass went from 19 pipelines to 6.
- **`materialParam(name, type, fallback)`** (`packages/engine/src/rendering/MaterialParams.ts`, exported): a `MaterialReferenceNode` on `userData.<name>` that falls back to a default when the current material lacks the entry. Needed because a shadow caster's `colorNode` is evaluated against three's `ShadowMaterial`, which has no `userData` entries (a plain `materialReference('userData.x')` threw there).
- **Unlit prepass** (`RenderPipeline.ts`, `UnlitPassNode`): the AO prepass renders with `renderer.lighting.enabled = false`, so NodeMaterial builds no lights, shadows or environment into its materials. The material graphs (and their normals) are unchanged; the prepass programs dropped from 64–86 KB to 3–12 KB. Its render-list key includes the lighting flag, so it neither shares nor invalidates scene-pass programs. Shadow maps are rendered by the scene pass instead, as in any layout without a prepass.
- **Asynchronous, no-draw warm-up before `ready`** (`SparkRenderer.warmUp`, called from `Engine.loadScene`): the whole post graph is rendered twice with `backend.createRenderPipeline` handed a promise list (so three uses `createRenderPipelineAsync` / `KHR_parallel_shader_compile`) and `backend.draw` stubbed out, then the engine awaits every compile and `queue.onSubmittedWorkDone()`. The node frame id is not advanced, so FRAME-gated nodes run again on the first real frame and frame-indexed sequences (GTAO's temporal rotation) are unchanged; afterwards `RenderPipeline.prepareFirstFrame()` puts TRAA back to its never-rendered state (1×1 history, jitter index 0, no camera view offset) so the first real frame restarts it from the real image exactly as a cold first frame does. The second graph pass catches lazily composed stages (godrays wait for the light's shadow map). Progress is published as `engine.events 'loading'` (`{ phase: 'compile', done, total }`, after a `{ phase: 'scene', done: 0, total: 0 }` while the scene builds); `EngineConfig.shaderWarmUp` / URL `warmup=0` turns it off.
- **Ready means presented**: `Engine.whenPresented()` resolves after the next frame's GPU work completes; the benchmark app sets `window.__spark.ready` only then and hides its `#loading` overlay (`apps/benchmark/index.html`, `main.ts`). Capture flow is unchanged apart from the wait: warm-up, the same warm-up frame, `paused` step, then the 30 captured frames.
- **Debug stat**: `RenderFrameStats.pipelines` / `programs` (three's pipeline cache sizes) on the overlay and in capture snapshots; the warm-up logs `warm-up: N pipelines (shadow a, prepass b, scene c, post d) in T s` at info level.

## Before / after

Pipelines are `_pipelines.caches.size` after 5 frames (`probe-pipelines.mjs`); the stall is `probe-stall.mjs`'s time from `ready` to frame 30 (the moment frames flow at the rAF rate), with `ready` itself in parentheses.

| scene / preset | pipelines before → after | `ready` → steady before | after | total load → steady before → after |
| --- | --- | --- | --- | --- |
| alley / high | 119 → 66 (scene-pass MRT 45 → 23, prepass 31 → 8, shadow 19 → 6) | 18.3 s stall, frame 30 at +19.4 s (ready 2.8 s) | frame 30 at +0.8 s, no stall (ready 3.0 s) | 22 s → 3.8 s |
| alley / low | 81 → 46 | 11.6 s stall, frame 30 at +12.4 s (ready 1.7 s) | +0.8 s, no stall (ready 2.4 s) | 14 s → 3.2 s |
| bootstrap / high | 25 → 25 | frame 30 at +1.0 s, ~0.8 s stall (ready 0.7 s) | +0.3 s (ready 0.9 s) | 1.7 s → 1.2 s |
| vfx / high | 47 → 46 | – | – | – |
| streaming / high | 42 → 46 (chunk streaming is frame-dependent) | frame 30 at +2.4 s, ~1.8 s stall (ready 1.0 s) | +0.5 s (ready 1.3 s) | 3.4 s → 1.8 s |

"+0.8 s to frame 30" is the probe's 250 ms polling plus 30 frames at the headless rAF rate; there is no gap in the frame sequence (`0.0s:f4 0.3s:f5 0.5s:f16 0.8s:f45 …` at 117 fps). With `warmup=0` (three's synchronous compile, `ready` now waiting for the frame to present) the alley reaches `ready` at 9.8 s: that is the remaining compile cost after the material sharing and the unlit prepass, serialised; the warm-up runs it in parallel before `ready` instead.

What the warm-up compiled, from its info log (pipelines created by the two graph passes, and the wall time until every one was ready and the queue idle):

| scene / preset | warm-up |
| --- | --- |
| alley / high | 51 pipelines (shadow 6, prepass 8, scene 23, post 14) in 2.0 s |
| alley / low | 31 pipelines (shadow 6, scene 23, post 2) in 1.8 s |
| bootstrap / high | 17 pipelines (shadow 1, prepass 1, scene 2, post 13) in 0.36 s |
| vfx / high | 34 pipelines (shadow 2, prepass 2, scene 17, post 13) in 0.40 s |
| streaming / high | 29 pipelines (shadow 3, prepass 5, scene 8, post 13) in 0.50 s |

The rest of the cache (PMREM, particle compute, and a few pipelines that only appear once the scene animates) is created outside the warm-up.

Captures (`pnpm capture`, `--backend=both` for the alley) are clean on every scene. Against the goldens with the visual suite's pixelmatch settings: alley-webgpu-high 55 of 921 600 pixels (0.006 %; the unmodified code captures at 51, the drift is TSL `time` in the puddle ripples and splash rings), alley-webgl-low 0, bootstrap 0, vfx 0, streaming (240 frames) 0.

## Rules for scene authors

- **Vary by parameter, not by graph.** Build a TSL graph once per *family* and assign the same node objects to every material in it; differences go through `materialColor`, `materialRoughness`, `materialMetalness`, `materialOpacity`, `materialEmissive` or `materialParam('name', type)` on `material.userData`. A graph built inside a per-object helper (`wetStandard(hex, …)` with `color(hex)` baked in) is a new program per call: 0.2–0.8 s of compile per pass on Dawn/D3D, twice on presets with the AO prepass.
- A family still splits on things three keys programs on: `receiveShadow`, instancing (`InstancedMesh` uuid), skinning (bone count), morph targets, geometry attribute layout, `side`, `transparent` / blending. Keep those consistent within a family where the look allows.
- Never read `userData` through a raw `materialReference` in `colorNode` of a shadow caster: three evaluates `colorNode.a` under its `ShadowMaterial`. `materialParam` is safe anywhere.
- `MeshStandardMaterial` (non-node) instances already share programs by property presence, not value; only per-instance *node graphs* fragment the cache.
- Light count is shader size: each light is unrolled into every lit material's fragment shader (~4 KB per light per material here). Prefer fewer, stronger lights, or wait for clustered lighting (`ClusteredLightsNode`, see below).
- Anything that composes lazily (a stage that needs a shadow map, a texture that arrives later) compiles on the frame it first appears. Register it before `loadScene` resolves so the warm-up sees it.

## Known gaps

- Compute pipelines (particle init / update, 8 in the alley) are still created synchronously; three has no async path for `createComputePipeline`. They compile during `create()` and the first fixed step, off the render path, and did not register in the stall probe after the change.
- PMREM (`applySceneEnvironment`) compiles its GGX / blur pipelines synchronously during `create()` (~0.3 s). Small, and it overlaps the mannequin load.
- Scene-pass shaders are still 70–88 KB because of 13 unrolled lights; the compile is now parallel and off the critical path, but `ClusteredLightsNode` would make shader size independent of light count and is the next lever if `ready` on the alley has to get under ~2 s.
- `loadScene` on a *running* engine (scene swap mid-game) does not warm up; the new scene compiles synchronously on its first frame as before.
- The warm-up leaves velocity "previous matrices" from the pre-first-frame pose, so frame 1 carries one frame of motion vectors where a cold start had none; TRAA's restarted history makes this invisible in the goldens.
