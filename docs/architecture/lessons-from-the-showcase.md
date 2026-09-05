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
| Rigify bone names carry dots (`DEF-spine.001`, `DEF-hand.R`) and three's glTF loader strips them, so every bone name in a config pointed at nothing while the clips still played. | Character builds rename joints to dot-free names (`build-character.mjs`); `RagdollWorld.create` already throws on a missing bone, which is how this surfaced. |

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
- Retargeting between two T-posed rigs needs no add-on: per bone, apply the source's rotation delta from rest to the target's rest in armature space, copy hip travel scaled by hip height, bake, export one NLA track per clip (`tools/level-authoring/character.py`). Reparent IK-style helper bones (the kit's feet lived under the root) under the limb first, or the ragdoll leaves them behind.
