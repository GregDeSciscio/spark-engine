# Mission shape for the Task Unit sequel

Decided 2026-09-04 (Greg delegated the recommendation). This replaces Task Unit's symmetric Demolition with a single-player structure and sets the scope of the Milestone 5 gameplay slice and the Milestone 10 vertical slice.

## The shape

**Handcrafted objective missions, played as a lone operator.** Each mission is a compact level with a short chain of objectives, hand-placed enemies with patrol routes, and a stealth-to-combat alert model. Failure is a mission fail and a checkpoint reload, not a respawn. This is the SOCOM campaign structure with the asymmetry Task Unit already has in Demolition: the player attacks, the AI defends.

```text
Mission
  Insert  ->  Objective 1  ->  Objective 2  ->  Objective 3  ->  Extract
  checkpoint at each completed objective
  10-20 minutes, 8-16 enemies, one contiguous level
```

## Why this shape

- It keeps Task Unit's plant-the-charge mechanic and gunfeel intact while dropping everything that needs a second human.
- Hand-placed enemies with routes are what the map bundle format already carries (spawns, patrol waypoints, strategic positions). The level data is a superset, not a rewrite.
- A lone operator halves the AI scope. Squadmate AI is the single biggest risk in a SOCOM-style single-player game and does not need to exist for the engine to be proven.
- It fits Milestone 10's 5 to 10 minute showcase exactly: one mission, three objectives.
- A lone operator in a hostile neon city is the right fiction for the darker tone.

## Objective types

Three for v1. Each is a small state machine driven by level data, not custom code per mission.

| Type | Trigger | Task Unit ancestor |
| --- | --- | --- |
| Reach | enter a volume, optionally undetected | spawn-to-site routing |
| Plant | hold interact at a site, then defend a timer | Demolition bomb plant |
| Eliminate | kill a tagged entity or clear a volume | Suppression |

Deferred, designed for but not built: defuse, hold position, rescue and escort, hack (the cyberpunk reskin of plant). Escort is the one that reintroduces friendly AI; it stays out until squadmates exist.

## Enemy alert model

This is what replaces PvP tension, and it is the core of the gameplay slice. Task Unit's bot state machine (patrol, detect, engage, search) becomes a per-enemy awareness model with a level-wide alert level.

```text
Per enemy:    Unaware -> Suspicious -> Alert -> Searching -> Unaware
Level-wide:   Quiet -> Alerted (reinforcements, changed routes) -> Lockdown
```

- Awareness accumulates from sight (distance, lighting, stance, movement) and sound (weapon loudness, footsteps, breaking glass). Task Unit's "information footprint" weapon concern becomes a real stat.
- Suppressed weapons and the dark aesthetic are not just flavour: lighting is a gameplay input, so the clustered lighting system needs a cheap "how lit is this point" query.
- Level alert states change patrol routes and spawn reinforcements from authored points, which is how the same level supports both a stealth run and a loud run.

## Squadmates

Out of scope for v1 as a feature, in scope as a design constraint: the enemy AI (perception, nav, cover, weapon-role behaviour) is written faction-agnostic so that a friendly squad with simple commands (follow, hold, fire at will, breach) can be added after the vertical slice without a second AI system.

## Level structure

- One contiguous level per mission, streamed if needed (Milestone 9), no hub or open world.
- Two or three approaches per objective, the way Task Unit's maps have lanes. Verticality through mantle zones and ladders is kept.
- Objectives and enemy placements are level data in the glTF extras path (ADR-008): objective volumes, interact points, patrol routes, alert reinforcement spawns, cover points.

## What the milestones now demonstrate

- **Milestone 5 (gameplay slice):** player operator, one enemy with the full awareness model, one Reach and one Plant objective, checkpoint reload, a level round-tripped from Blender with the objective data.
- **Milestone 10 (vertical slice):** one complete mission, three objectives, 8 to 12 enemies with routes and level alert states, extraction, blood and ragdoll per `docs/design/gore-scope.md`.

## Open after this

- Mission select and persistence between missions (unlocks, loadout choice) are not engine features and wait until several missions exist.
- Whether the "plant" verb becomes "hack" in fiction. Same mechanic either way.
