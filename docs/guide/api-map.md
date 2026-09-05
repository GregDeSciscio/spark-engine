# API map

Everything `@spark/engine` exports, grouped as in `packages/engine/src/index.ts`, one line each. Apps import from the package root and nowhere deeper. Doc comments in the source are the reference; this page is the table of contents.

## Core

| Export | What it is |
| --- | --- |
| `Engine` | Owns the renderer, the entity world and every subsystem; `initialize`, `loadScene`, `start`, `stop`, `step`, `dispose`. |
| `configFromSearch`, `resolveConfig`, `DEFAULT_CONFIG`, `QUALITY_PRESETS` | Engine config from URL parameters and defaults. |
| `Clock`, `GameLoop` | The fixed and frame steps. |
| `EventEmitter`, `Logger`, `Random`, `DisposeBag` | Events, scoped logging, a seeded random stream, release-on-dispose. |

## Scenes and world

| Export | What it is |
| --- | --- |
| `SceneDefinition`, `SceneContext`, `SceneInstance` | The scene contract. |
| `World` | Loads and disposes scenes for the engine. |
| `LevelLoader`, `LoadedLevel` | glTF levels with `spark.*` extras into entities, bodies, lights and a render twin per collider. |
| `Cullable`, `LOD`, `Streamed`, `SpawnPoint`, `TriggerVolume` | World components; frustum and streaming helpers alongside. |

## Entities

| Export | What it is |
| --- | --- |
| `EntityWorld`, `Transform`, `Velocity`, `defineComponentType` | The ECS: entities, typed-array components, system registration. |
| `RenderSync` | Transforms onto three objects each frame. |
| `SideTable` | Engine-side per-entity objects released with the entity. |

## Physics

| Export | What it is |
| --- | --- |
| `PhysicsWorld`, `initRapier` | Rapier world at the fixed step: bodies, joints, raycasts, contact and trigger events. |
| `Character`, `RigidBody`, `BODY_TYPE` | Components. |
| `CharacterController` | Kinematic capsule movement with slopes, steps, snapping, jumping and airborne time. |
| `Layers` | Named collision layers, defined on first use. |
| `RagdollWorld`, `Ragdoll`, `RagdollConfig`, `capsuleVolume` | Skeleton to jointed capsules with mass, activation impulses and contact events. |
| `PhysicsDebugRenderer` | The F3 wireframe. |

## Rendering

| Export | What it is |
| --- | --- |
| `SparkRenderer`, `detectWebGPU` | The WebGPU renderer with the WebGL2 fallback. |
| `RenderPipeline`, `POST_EFFECT_NAMES` | The post stack and its toggles. |
| `QUALITY_SETTINGS`, `getQualitySettings` | What each preset turns on. |
| `LightingSystem`, `Light`, `illuminanceAt`, `litness` | Clustered local lights under a budget; light queries for gameplay. |
| `SurfaceLibrary`, `createSurface`, `surfaceKindOf` | Procedural wet-city materials by name; material name to surface kind. |
| `Decals`, `DecalPool` | Projected decals clipped to a target mesh. |
| `createHeightFog`, `VolumeFogNode`, `VolumeFogSettings` | Height fog and a volumetric fog box with spot cones. |
| `CameraRig`, `ShoulderCamera` | Third-person and isometric rigs; the over-the-shoulder shooter camera with recoil and occlusion. |
| `ColorGradeSettings`, `CYBERPUNK_GRADE` | Live colour grading. |
| `applyRoomEnvironment`, `applySceneEnvironment`, `loadHDREnvironment` | Environment lighting. |
| `DynamicResolutionController` | Render scale against a frame budget. |

## Assets

| Export | What it is |
| --- | --- |
| `AssetManager`, `ModelAsset` | Cached, reference-counted glTF loading; `instantiate()` for scene copies. |

## Animation

| Export | What it is |
| --- | --- |
| `AnimationWorld`, `Animator` | Graph-driven skeletal animation per entity: layers, blend trees, triggers, events, root motion, layer fades. |
| `AnimationGraphDef` and friends | The data shape of a graph. |
| `BoneSocket`, `findBone` | Mount things on bones. |

## Audio

| Export | What it is |
| --- | --- |
| `AudioSystem` | Buses, voice pool, spatial voices, listener, gesture unlock. |
| `SoundDefinition` | A cue: url or variants, bus, gain, variance, cooldown, cap, loop. |
| `SoundBank` | A manifest of cues; missing ones are silent. |
| `EmitterPool`, `Scatter` | Ambience: nearest-N looping emitters, random one-shots. |
| `MusicPlayer` | Stems with intensity crossfades (also used for ambience beds). |
| `bindAnimationEvents`, `bindPhysicsEvents` | Markers and contacts to sounds. |
| `renderPlaceholder`, `renderAllPlaceholders` | Synthesised stand-in cues. |

## Particles, UI, AI, input, debug

| Export | What it is |
| --- | --- |
| `ParticleSystem`, `PARTICLE_PRESETS` | GPU emitters; `burstAt` for one-shots. |
| `UIHost`, `WorldLabels` | DOM panels and world-anchored labels and health bars. |
| `Navigation`, `NavAgent`, `PathFollower`, `findCover`, `peekPoint`, `lineOfSight`, `inViewCone` | Recast/Detour navigation and the perception queries. |
| `Input` | Keys, pointer, pointer lock, per-frame pressed edges. |
| `DebugStats`, `SparkInspector`, `exposeForCapture` | The overlay, the F2 inspector, `window.__spark`. |

Anything not listed here is internal; if you find yourself wanting it, that is a request for the engine, not a reason to reach past the index.
