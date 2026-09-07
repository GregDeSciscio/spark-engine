# Recipes

Each recipe is something the showcase already does. The steps are short because the real content is the file to read: the showcase is written to be read as much as run. `pnpm dev:showcase` runs it.

## Load a level authored in Blender

1. Author in Blender with the engine's conventions: `spark.type` extras on nodes (spawn points, patrols, objectives, vfx spots, lights), `COL_` meshes for collision, material names from the surface library. `tools/level-authoring/street.py` builds the showcase's street procedurally in Blender and is the reference for every convention.
2. `pnpm level:street` exports, runs the asset pipeline (which bakes the navmesh) and lands the GLB in the app's `public/levels/`.
3. In the scene, `loadStreetLevel` in `apps/showcase/src/levels/MissionLevel.ts` shows the loader call, the surface swap and how spawn points, patrols and objectives come out of the extras.

Read `docs/decisions/ADR-008-level-authoring-blender-gltf.md` for why levels are glTF plus extras and nothing more.

## Put a character in

1. A character config: `assets/source/characters/operator.character.json` names the clip library, the target model, the bone map, the clips to keep and their engine names.
2. `pnpm character:retarget` runs the Blender retarget and the pipeline; `pnpm character:build` rebuilds from the last retarget.
3. `apps/showcase/src/actors/rig.ts` is the game-side description of the skeleton: bone names, the upper-body mask, the ragdoll capsules.
4. `apps/showcase/src/actors/Operator.ts` attaches the model, the animation graph (locomotion blend tree, crouch, air, an upper-body override layer for aiming, an additive flinch layer) and a `CharacterController`.

Any rigged glTF with clips works without the retarget: point the config's `model` at it and skip the `retarget` section.

## Wire a weapon

`apps/showcase/src/combat/`: `weapons.ts` is the data (rate, damage, spread, recoil), `Weapon.ts` the deterministic fixed-step state machine, `Gunplay.ts` the two-ray aim (what the reticle is over, then the shot from the shoulder toward it), impacts, hit zones and damage. The rifle prop rides a `BoneSocket`. Read `docs/architecture/lessons-from-the-showcase.md` on why the reticle carries the recoil and the camera follows a fraction.

## Give an enemy eyes and a path

`apps/showcase/src/actors/Enemy.ts` with `apps/showcase/src/ai/Awareness.ts`: a `NavAgent` on the level's baked navmesh, an awareness ladder driven by `lineOfSight`, `inViewCone`, distance, the player's stance and how lit they are (`lighting.illuminanceAt`), cover from `findCover` and `peekPoint`, bursts with spread. `docs/design/mission-shape.md` is the design it implements.

## Make the level notice

`apps/showcase/src/mission/Alert.ts`: the sector's own state machine, `Quiet -> Alerted -> Lockdown`, over the top of the per-enemy ladder. It reads a handful of numbers each fixed step (who is in contact, who is searching, who is down, how many hostiles are alive) and answers with three things: reinforcements from ingress points authored in the level (`spark.type=reinforce`, wave and patrol route as extras), a level-wide hunt that puts everyone still on patrol into a sweep, and a tier for the HUD and the stingers. It escalates on a second simultaneous contact, on casualties, or on a contact that drags; it settles back one tier per quiet stretch. No three.js and no ECS, so `apps/showcase/tests/Alert.test.ts` covers the whole ladder.

Reinforcements are built dormant at load and deployed with a pose, never instantiated mid-fight (`Enemy.deploy` / `sleep`); a checkpoint reload retires them, because the alert that called them in is being undone.

## Add sound

1. Write cues as data: `apps/showcase/audio/manifest.mjs` (prompt, length, loop, variants, bus, gain, variance, cooldown, spatial role).
2. `pnpm audio:generate --manifest=<yours>` makes the takes with ElevenLabs (an API key in `.env`), `pnpm audio:build --manifest=<yours>` masters them and writes the manifest the game reads. Or drop your own files in and only run the build.
3. `SoundBank.load(audio, '/audio/manifest.json')` in the scene; `apps/showcase/src/audio/MissionAudio.ts` is the game's vocabulary over it (one verb per moment) plus the ambience with `EmitterPool` and `Scatter`.
4. Footsteps are markers in the clips (the character build writes them); `bindAnimationEvents` or a listener on `animation.events` plays them.

`docs/audio/mission-sound-design.md` is the whole design, with mix rules.

## Blood and ragdolls

`apps/showcase/src/combat/gore.ts` (sprays, splatter decals, drips, pools) and the ragdoll path in `Enemy.ts` (`RagdollWorld.create` with the rig's capsule config, activation velocity plus an impulse at the hit, contact events for the body fall). `docs/design/gore-scope.md` sets the tiers.

## Objectives and checkpoints

`apps/showcase/src/mission/Objectives.ts`: reach, plant and eliminate objectives authored in the level, a runner with checkpoints and a retry. `mission.ts` shows how the HUD and audio hang off `status()` and `justCompleted`.

## Probe a running game from the console

`window.__spark.game` in the showcase: `lookAt`, `fire`, `aim`, `move`, `stance`, `hurt`, `anim`, `audio`, `alert`, `objective`, `stats`. `mission.ts` defines them; they are how the repo verifies gameplay without a mouse. Give your own scene a probe object through `exposeForCapture` and `api.game`.

`pnpm probe` is the same surface driven headless as a regression suite: the showcase on a fixed clock and seed, six probes covering the alert ladder, lockdown, checkpoint reload, stealth and objective flow. `tools/probes/README.md` says how to add one.
