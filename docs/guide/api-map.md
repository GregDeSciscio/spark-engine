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
| `PhysicsWorld`, `initRapier` | Rapier world at the fixed step: entity bodies (`addBody`), joints, raycasts and `overlapShape`, contact and trigger events, `contactForces` (the last step's, for colliders made with `forceEvents`), `bodyOf(eid)`, `solverIterations`. Hits name the owner entity, the part, the collider and the body. |
| `Bodies` (`physics.bodies`) | The handle layer under the entity API (ADR-010): `create` a body, then `addCollider(body, { shape, owner, part, position, rotation, density, events })` as many times as it takes; `destroy`, `pose`/`setPose`, `velocity`/`setVelocity`, `applyImpulse(b, impulse, torque?)`, `mass`, `isSleeping`/`wake`, `removeCollider(c, wake?)`, `info(c)`, `colliderPose`. |
| `Joints` (`physics.joints`) | Joints between any two bodies, with the engine's own per-body index: `create(a, b, { kind, ..., contacts? })`, `remove`, `exists`, `of(body)`, `anchors(j)`. |
| `BodyHandle`, `ColliderHandle`, `JointHandle`, `NO_PART`, `SHARD_CAPACITY` | Integer handles, never reused; the part id of a collider given none; colliders per internal shard of a fixed body. |
| `ShapeDesc`, `JointDesc`, `JointOptions`, `BodyInit`, `ColliderInit`, `ColliderInfo`, `JointAnchors`, `OverlapOptions`, `OverlapVisitor`, `Pose` | The value types; shapes include `convexHull` and `convexMesh`, joints include `rope`. |
| `Character`, `RigidBody`, `BODY_TYPE` | Components. |
| `CharacterController` | Kinematic capsule movement with slopes, steps, snapping, jumping and airborne time. |
| `Layers` | Named collision layers, defined on first use. |
| `RagdollWorld`, `Ragdoll`, `RagdollConfig`, `capsuleVolume` | Skeleton to jointed capsules with mass, activation impulses and contact events. |
| `PhysicsDebugRenderer` | The F3 wireframe. |

## Destruction

| Export | What it is |
| --- | --- |
| `Destruction` | One destructible structure (ADR-011): `new Destruction(ctx, { pieces, connections? }, options)`, add `object` to the scene, register `systems()`. `explode(point, radius, normal?)`, `damage(part, hits?, direction?)`, `remove(parts)`, `smoke(kind, point)`, `heatView(on)`, `hang(body, piece, anchorRest, hook, length)`, `events` (shatter, land, tear, weakening, step, blast), `stats()`, `census()`, `sanity()`, `listener`/`shakeOffset`, `dispose()`. `Destruction.of(entities, eid)` finds it from a raycast's `eid`; the hit's `part` is the chunk. |
| `Destructible` | The structure entity's component: `chunks`, `standing`, `loose`. |
| `DestructionOptions`, `DestructionDeps`, `DestructionStructure`, `DestructionEvents`, `DestructionStats`, `DestructionCensus`, `DESTRUCTION_ORDER` | Its value types and system orders (fixed 80, before physics; late 990, before RenderSync). |
| `DESTRUCTION_SOUND_NAMES`, `DESTRUCTION_VOICES`, `DestructionSounds` | The sounds it plays and their mix; the game supplies the takes' URLs (the engine ships no audio). |
| `Debris`, `Hinges`, `Rebar`, `ChunkMesh`, `DestructionFx`, `GravelField`, `SmokeSystem`, `STANDING`, `RUBBLE`, `GONE` | The layers `Destruction` wires, for games that assemble their own (and for tools and tests). |
| `StrainSolver`, `StrainRunner`, `InlineStrainHost`, `WorkerStrainHost`, `StrainStep`, `NodeLoad` | The structural solve (a kept sparse Cholesky factor with exact downdates and WebAssembly kernels), its message runner, and where it runs. |
| `prism`, `Piece`, `findConnections`, `Connection`, `GROUND`, `buildStructure`, `fractureRect`, `buildBuilding`, `rng` | Authoring: pre-fractured chunks, their glued contacts, the solver's arrays, Voronoi cells, a procedural test building. |

## Rendering

| Export | What it is |
| --- | --- |
| `SparkRenderer`, `detectWebGPU` | The WebGPU renderer with the WebGL2 fallback. |
| `RenderPipeline`, `POST_EFFECT_NAMES` | The post stack and its toggles. |
| `StylizeStage`, `StylizeInputs` | A scene-supplied display-space stage (`pipeline.setStylize`) for toon, print and sketch looks; gets depth and normal samplers where the layout has them. |
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
