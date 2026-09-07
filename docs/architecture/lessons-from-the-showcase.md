# Lessons from the showcase

What building the customer game's first slice (ADR-005, `apps/showcase`) taught us about the engine, and what was done about each lesson. Kept as a running record: add to it whenever game work pushes on the engine.

## Engine changes that came out of game work

| Lesson | Change |
| --- | --- |
| Synthetic frame stepping while the loop runs freezes the game: the stepped timestamps run ahead of the wall clock, then every real frame measures zero fixed steps until it catches up. Cost an hour of false accuracy measurements. | `stepFrames` pauses a running loop, continues from the clock's last timestamp, and `Clock.resync()` forgets it afterwards. Probes should also use `?fixedclock=60`. |
| Physics layer names had to be declared before any body mentioned them, so scenes grew a "define every layer first" line whose order nobody should have to think about. | `Layers.bit` defines a name on first use. |
| Changing a character's stance meant destroying the body and re-attaching the character controller. | `PhysicsWorld.setCapsule` resizes a capsule in place. |
| Decals and hit effects need the render mesh a collider stands in for, and the game rebuilt that link by name after loading. | `LoadedLevel.renderTwin(collider)` returns it. |
| Aiming a particle burst meant writing seven transform fields by hand in three places. | `ParticleSystem.burstAt(position, direction, count)`. |
| Scripted probes that scraped the HUD misread the game; ones that read real state found the truth (the "misses" were hits on a dead dummy). | `CaptureAPI.game`: a slot for the app's own probe surface (the showcase exposes aim-at-point, fire-N, raw rays and state). |
| The browser pane in the desktop app refuses pointer lock, so mouse look silently never engaged and the whole feel read as broken. | `Input` records and warns about refused lock requests and exposes `pointerLockUnavailable`; the game falls back to free look. Feel checks happen in a real browser tab. |
| Unknown `spark.type` values are the game's vocabulary, not a loader problem. | The loader reports them at debug level and passes them through as `unknown` descriptors. |
| Over-the-shoulder aiming needs two rays: what the reticle is over, then the shot from the shoulder toward it, or cover the camera sees past eats the round with no feedback. | `ShoulderCamera.directionFor` and the screen-projection helpers; the two-ray scheme itself stays game code. |
| Recoil that kicks and returns the whole view fights the player's own correction. | The reticle carries most of the kick on screen and bullets follow it; the camera follows a fraction. Recoil offsets on `ShoulderCamera` support this split. |
| A weapon-ready or aim pose has to sit on the upper body over any locomotion. Additive layers cannot do it (a pose minus its own first frame is nothing), and three's mixer averages normal-blend actions by weight, so a masked pose at weight 1 only got half the arms. | Override layers: `additive: false` on a masked layer makes its clips replace the base on those bones by the layer weight (`overrideBoost` maps the share to a mixer weight; a full override leaves 0.1 percent of the base). |
| Every actor hand-rolled the same lerp to fade an animation layer's weight. | `AnimationWorld.setLayerWeight(eid, layer, target, seconds)` fades the `Animator` component weight each step. |
| The controller's grounded flag flickers on flat ground; each actor timed "airborne" itself. | `Character.air` accumulates seconds since last grounded; `CharacterController.airborneSeconds(eid)`. |
| Lights driven by entities sat at the origin until the lighting system's first run. | `LightingSystem.attachEntity` copies the transform at attach. |
| The game's audio layer grew a manifest loader, a nearest-N emitter pool and random scatter timers that every game would rewrite. | `SoundBank`, `EmitterPool`, `Scatter` in the audio module; the manifest schema is the engine's. |
| The rifle followed a hand bone for position and the aim for orientation with bespoke code. | `BoneSocket` (position from a bone, offset in the parent frame, rotation left to the caller) plus `findBone`. |
| Impact sounds classified surfaces by regex in the game, while the engine already names its surfaces. | `surfaceKindOf(materialName)` next to the surface library: concrete, asphalt, brick, metal, glass or unknown. |
| Ragdolls emitted no contacts, so the body fall was timed. | `RagdollConfig.contactEvents` enables events on the root part; `Ragdoll.hasPart` / `rootEid` route them. |
| `spatialVoices` counted only entity-attached voices. | It counts every voice with a panner. |
| Rigify bone names carry dots (`DEF-spine.001`, `DEF-hand.R`) and three's glTF loader strips them, so every bone name in a config pointed at nothing while the clips still played. | Character builds rename joints to dot-free names (`build-character.mjs`); `RagdollWorld.create` already throws on a missing bone, which is how this surfaced. |
| PowerShell's `>` redirect writes UTF-16 with a byte-order mark, so a `.env` created with `echo KEY=... > .env` read as UTF-8 matched nothing and the audio tools reported the key unset. | `tools/audio/generate.mjs` decodes a UTF-16 `.env` by its BOM and strips a UTF-8 one. |
| A second game (Late Edition, a printed Sunday-comics look) needed a non-photographic display-space pass: halftone, ink outlines, plate misregistration. The post stack composed a fixed effect set and a look like that had nowhere to go except forking the pipeline. | `RenderPipeline.setStylize(stage)`: a scene-supplied TSL stage between the grade and FXAA, given the display image plus depth and normal samplers where the layout has them. Toggleable as `stylize` like every other effect. |

## Game code that turned out to be engine material

Promoted into `packages/engine/src/ai/`:

- **NavAgent**: a path request with repath cadence, arrival test and steering direction, which the enemy had carried as five private methods around `PathFollower`.
- **Cover**: sample navmesh points near an agent and keep the closest one a threat's eye cannot see into; a sideways peek point off a cover point.
- **Perception queries**: line of sight from an eye to a body point against the world, and a view-cone test, next to the illuminance query (ADR-005).

Kept as game code on purpose: the awareness ladder and its tuning, weapons and damage, hit zones, objectives, the HUD, the two-ray aiming rules. They are the customer game's vocabulary.

## Patterns worth repeating

- Read pressed-edge input in the frame update and apply it in the fixed step. The operator does; the first enemy did not and lost inputs.
- Fork the seeded random once per subsystem. One stream for everything means a change anywhere reorders everything.
- When a ragdoll takes over a skeleton, detach the animator. Two writers on the same bones snap the moment the ragdoll is retired.
- A camera pivot can sit inside geometry; rays from it want Rapier's `solid: false`.
- Detour's random-point-around samples whole polygons the circle touches, so the radius is a search size, not a bound.
- Levels bake their navmesh offline; the blockout bakes at load only because it is procedural.
- A held weapon follows the hand bone for position and the aim for orientation. Inheriting the bone's twist needs two-hand IK to look right; the view direction is what the player expects the barrel to follow anyway.
- Drop an override layer's weight for a beat when a base-layer reaction (the chest flinch) has to show through, and while sprinting so the arms pump.
- Rapier's `computedGrounded` is per step and flickers on flat ground while moving. Anything that reacts to "airborne" (the jump state) needs a short timer, or the legs glide in a falling pose.
- Hit reactions belong on an additive layer over everything, not as a base-layer state: a base-layer flinch pulled a crouched body upright and then re-entered crouch through a crossfade.
- Blender 5.1's glTF exporter flattens actions baked from Python to one key per channel in NLA_TRACKS and ACTIONS modes (slotted actions); SCENE mode with the action active exports them intact. `character.py` writes one GLB per clip and the build merges them. `build-character.mjs` refuses any clip with a single key so this cannot ship silently again.
- A sound design wants round-robin takes for everything that repeats (steps, shots, impacts); doing that in every game is the same five lines. `SoundDefinition.urls` now takes the variants and the engine never repeats the last one.
- Footstep timing belongs to the clip, not the game: the retarget bakes `footstep` markers from the frames each foot comes down, so any clip set carries its own steps.
- Drive audio from a built manifest the game reads at load, with every missing cue a logged no-op: the design (prompts, gains, spatial roles) lives in one data file, and the game runs the same before and after the takes exist.
- Entity-driven scene objects (the level's lights) sit at the origin until the render sync has run once; anything that reads their positions at scene setup reads zeros. Read them a frame later, or from the ECS transform.
- Voice caps are mix decisions: two stereo beds plus the nearest eight emitters filled the ambience bus and starved every drip. The default ambience cap is 16 now; a bus that loops must leave room for its one-shots.
- A mid-fight spawn should cost a pose, not a load. The reinforcements the alert model calls in are built with the level and held dormant (body removed, label detached, `fixedUpdate` returns early); deploying one sets a transform and adds a capsule back. Instantiating a character model on the frame a wave lands is a visible hitch, and the fixed step makes it a gameplay one.
- A director that owns escalation should read numbers and call back out, not reach into the actors. `mission/Alert.ts` takes a count of contacts, searchers, casualties and live hostiles each step and answers with `deploy`, `hunt` and `onTier`; no three.js, no ECS, so the whole ladder is a unit test. The same shape would work for a wave director, a difficulty governor or a music director.
- Anything an alert turns on, a checkpoint reload has to turn off. Reinforcements, the sector tier and each hostile's posture all reset with the operator, or a reload leaves the player facing a level that remembers a fight that no longer happened.
- Retargeting between two T-posed rigs needs no add-on: per bone, apply the source's rotation delta from rest to the target's rest in armature space, copy hip travel scaled by hip height, bake, export one NLA track per clip (`tools/level-authoring/character.py`). Reparent IK-style helper bones (the kit's feet lived under the root) under the limb first, or the ragdoll leaves them behind.
