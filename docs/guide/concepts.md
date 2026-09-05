# Concepts

The engine in one page. Each heading names the module you would import from `@spark/engine`.

## The engine and the loop

`new Engine({ container, ...configFromSearch(location.search) })`, then `initialize()`, `loadScene(definition)`, `start()`. The engine owns the renderer, the entity world and every subsystem, and hands them to the scene through `SceneContext`.

The loop runs a **fixed step** (60 Hz by default) for simulation and a **frame step** for everything visual. Physics, character movement and gameplay logic go in `fixedUpdate`; camera, animation weights and presentation in `update` / `lateUpdate`. With `?fixedclock=60` the fixed step ignores wall time, and with `?seed=` every random stream is reproducible, which is how the tests and captures work.

## Scenes

`SceneDefinition` is `{ name, create(ctx) }`. `create` returns a `SceneInstance`: a three `scene`, a `camera`, optional `fixedUpdate` / `update` / `lateUpdate` / `resize`, and `dispose`. The engine drives the lifecycle; the scene owns what it makes and releases it in `dispose`. `DisposeBag` collects the release calls.

## Entities

bitecs under the hood: components are typed arrays, entities are integers. `Transform` is the one component everything shares. Systems are registered on the world with a stage (`fixed`, `update`, `late`) and an order. `RenderSync` is the system that copies transforms onto three objects; `entities.destroy(eid)` releases everything attached to an entity, bodies and render bindings included.

## Physics

Rapier on the main thread at the fixed step. `physics.addBody(eid, { type, shape, layer, collidesWith })` with named layers defined on first use. `physics.raycast` and the contact events (`physics.events`) are the query surface. `CharacterController` moves a kinematic capsule with slopes, steps, ground snapping, jumping and airborne time. `RagdollWorld` turns a skeleton into jointed capsules with real mass.

## Rendering

Three's WebGPU renderer with TSL node materials, a WebGL2 fallback with fewer effects. `RenderPipeline` is the post stack (ambient occlusion, temporal anti-aliasing, upscaling, reflections, volumetrics, godrays, motion blur, bloom, depth of field, colour grade); `QualitySettings` from the preset decides what is on. `LightingSystem` clusters local lights on the GPU under a budget and answers `illuminanceAt` for gameplay. `SurfaceLibrary` is a set of procedural wet-city materials assigned by material name. `Decals`, `HeightFog`, `VolumeFog`, `CameraRig` and `ShoulderCamera` are the other rendering tools a game reaches for.

## Assets and levels

`assets.loadModel(url)` returns a cached, reference-counted template; `instantiate()` gives a scene object with its own skinned instances. Files reach `public/` through `tools/asset-pipeline` (dedup, weld, meshopt compression, KTX2 when available, budget checks). Levels are authored in Blender and exported as glTF with `spark.*` extras and `COL_` collision meshes; `LevelLoader` turns them into entities, bodies and lights, and the pipeline bakes a navmesh beside them.

## Animation

`AnimationWorld.attach(eid, instance, clips, graph)` binds a data-defined graph: layers of states, 1D blend trees on parameters, triggers, crossfades. Layers above the base are additive by default or override a masked set of bones (`additive: false`). `setLayerWeight` fades a layer. Clip extras carry loop flags and event markers (footsteps), and `events` fires them to whoever listens.

## Audio

Buses (music, sfx, ui, ambience), a capped voice pool, spatial voices that follow entities, a listener on the camera. Sounds are defined by name with variants (`urls`), variance, cooldowns and caps. `SoundBank` reads a built manifest and makes missing cues silent no-ops; `EmitterPool` and `Scatter` build an ambience; `MusicPlayer` crossfades stems by intensity. Placeholder cues are synthesised so audio works before any file exists. `tools/audio` generates and masters real takes from a manifest.

## Particles, UI, navigation

`ParticleSystem` runs GPU emitters from presets (rain, sparks, steam, blood) with `burstAt`. `UIHost` mounts DOM panels and world-anchored labels. The `ai` module wraps Recast/Detour: `Navigation` loads a baked navmesh, `NavAgent` follows paths, `findCover` and `lineOfSight` are the queries a shooter needs.

## Debugging

The stats overlay, the F2 inspector, `?overlay=0`, `?preset=`, `?backend=`, and `window.__spark` for scripted probes. `pnpm capture` boots a scene headless and screenshots it; `pnpm visual` compares against goldens; `pnpm perf` measures.
