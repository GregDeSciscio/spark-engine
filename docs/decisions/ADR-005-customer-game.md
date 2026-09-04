# ADR-005: Customer game

## Context

An engine without a game that needs it sprawls; the kickoff's own showcase milestone risks being a tech demo nobody ships. The multiplayer question sets the bar for every gameplay system, so it cannot wait. The choice of game could wait until gameplay starts, and has now been made.

## Decision

- **Multiplayer: NO for v1.** Single-player only. No gameplay system may assume a network layer exists. Determinism (seeded RNG, fixed step, no wall-clock reads in simulation) is kept anyway so the door stays open.
- **Game: the Task Unit sequel.** A single-player sequel to Task Unit, set in a darker, bloody, cyberpunk aesthetic. The rainy cyberpunk alley benchmark is now a candidate level for this game, not a throwaway.

Task Unit is a SOCOM-style over-the-shoulder tactical shooter (Demolition, small squads, stance-driven gunplay, bots). The sequel inherits its gunfeel, movement set, and map pipeline; see `docs/design/task-unit-reference.md` for the full summary.

- **Camera:** close third-person over the shoulder, inherited from Task Unit. This is the primary ADR-004 mode; draw-distance consequences are recorded there.
- **Code reuse:** Task Unit is a design and data reference, not a code dependency. Port designs, schemas, and tuning. Rewrite anything that is bad or fights the engine rather than forcing reuse (Greg, 2026-09-04).
- **Mission shape:** handcrafted objective missions played as a lone operator, with a stealth-to-combat enemy alert model replacing PvP tension. Three objective types for v1 (Reach, Plant, Eliminate), checkpoints per objective. Squadmates are deferred but the AI is written faction-agnostic. See `docs/design/mission-shape.md`.
- **Gore:** blood decals, sprays, and persistent wound masks are committed (Milestones 7 and 8); death ragdoll with animation blending and hit reactions are committed (Milestone 6); dismemberment via pre-split limb meshes is a stretch goal decided after Milestone 6 lands, because its cost is character authoring rather than runtime. See `docs/design/gore-scope.md`.

## Alternatives

- Engine-first with a synthetic showcase: rejected, no forcing function.
- Multiplayer from day one: rejected, doubles gameplay scope for a game that is not yet named.
- Squad-command single-player from the start: rejected for v1, doubles the AI scope before the enemy AI exists.

## Consequences

- Milestone 10 is the Task Unit sequel's vertical slice: one mission, three objectives, 8 to 12 enemies, extraction.
- Milestone 5 demonstrates the operator, one enemy with the full awareness model, a Reach and a Plant objective, and a checkpoint reload.
- Feature priority follows that game's needs, not the feature lists in the kickoff doc.
- Enemy AI (perception, awareness, nav, cover, weapon-role behaviour) becomes the biggest gameplay system, since enemies are the entire opposition. Lighting becomes a gameplay input, so the lighting system needs a cheap "how lit is this point" query.
- The dark, bloody cyberpunk direction confirms the lighting and wet-surface work already on the roadmap (clustered lights, SSR for floors and puddles) and adds blood, ragdoll, and wound rendering as first-class features.

## Status

Ratified: multiplayer decided by Greg 2026-09-03; game named 2026-09-04; camera, mission shape, gore scope, and draw distance decided 2026-09-04 on Greg's delegation.
