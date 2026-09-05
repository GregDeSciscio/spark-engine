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
