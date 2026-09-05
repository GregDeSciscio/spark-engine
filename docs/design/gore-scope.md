# Gore scope

Decided 2026-09-04. Greg wants dismemberment and ragdoll wounds if the budget allows. It does on the runtime side; the real cost is animation-system maturity and character authoring, so the scope is tiered and the top tier is gated on Milestone 6.

## Budget read

The measured alley scene on the high preset at 1080p uses about 3.3 ms of the 16.7 ms GPU budget with rain, SSR, AO, TRAA, bloom and volumetrics all on (`docs/rendering/effect-costs.md`), and the frame is CPU-submission-bound, not GPU-bound. Physics is budgeted at 1 to 2 ms per frame and Rapier is already in the engine (ADR-002). There is room for everything below provided each system has a cap.

## Tiers

### Tier 1: blood (committed, Milestones 7 and 8)

- Hit sprays as GPU particles (Milestone 8), direction and volume from the hit and the weapon.
- Blood decals on world surfaces from the Milestone 7 decal system, with a pool decal that grows over a few seconds under a body.
- Wound marks on characters through a per-character wound mask written in UV space on hit (a small render-to-texture, cheap and persists on the corpse). This is the "ragdoll wounds" part: wounds stay where the bullets landed after the body drops.
- Caps: decal budget per level, one growing pool per corpse, wound mask at 256 by 256.
- Status 2026-09-04: sprays (GPU `blood` preset), splatter and drip decals, and growing corpse pools are in the showcase (`apps/showcase/src/combat/gore.ts`). Wound masks wait for character art with a UV layout; the Quaternius mannequin (2026-09-05, `apps/showcase/src/actors/rig.ts`) has UVs but no textures, so it still tints toward blood as health drops.

### Tier 2: ragdoll and hit reactions (committed, Milestone 6)

- Death ragdoll from the animated pose, driven by Rapier articulated bodies, with a short blend from animation to physics so the body carries momentum. This moves "ragdoll blending" from the kickoff's Later list into Milestone 6.
- Additive hit reactions by hit zone (head, torso, legs, matching Task Unit's zones) while alive.
- Caps: at most 6 simulating ragdolls, then the oldest settles into a static corpse pose. Ragdolls sleep aggressively.
- Status 2026-09-04: the engine has physics joints and a `RagdollWorld` (capsules per bone, spherical joints, momentum carried in as velocity plus an impulse at the hit, a 0.12 s blend from the animated pose); enemies ragdoll on death in the showcase, capped at 6 and 12 s. 2026-09-05: the ragdoll follows the Rigify skeleton of the real character (14 capsules, `CHARACTER_RAGDOLL`). Hit reactions use the library's `Hit_Chest` clip on the base layer with the upper-body override dropped for 0.35 s; an additive flinch is still the plan. Parts weigh their capsule volume at 1000 kg/m³ and the kill impulse is capped per part by speed, after a forearm hit on the kit character sent the corpse 48 m.

### Tier 3: dismemberment (stretch, decided after Milestone 6 lands)

- Characters are authored with pre-split limb submeshes and cap geometry at the joints (Blender, ADR-008). Severing hides the attached submesh, shows the cap, and spawns the limb as a detached rigid body with its own wound mask and a blood spray.
- Triggered by hit zone plus weapon class: shotguns and explosives at close range, snipers on limbs, never from pistols.
- Runtime cost is small (one extra rigid body and a material swap). The cost is content: every enemy character needs the split authoring and cap textures, so this is only worth committing once the character pipeline and Milestone 6 exist and the number of enemy character types is known.

## Not in scope

- Soft-body or mesh-cutting dismemberment at arbitrary points.
- Persistent gore across checkpoint reloads.
- Any gore setting below "on": a toggle exists for the visual suite and thumbnails, not as a shipped low-violence mode.
