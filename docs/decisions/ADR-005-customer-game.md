# ADR-005: Customer game

## Context

An engine without a game that needs it sprawls; the kickoff's own showcase milestone risks being a tech demo nobody ships. The multiplayer question sets the bar for every gameplay system, so it cannot wait. The choice of game can wait until gameplay starts.

## Decision

- **Multiplayer: NO for v1.** Single-player only. No gameplay system may assume a network layer exists. Determinism (seeded RNG, fixed step, no wall-clock reads in simulation) is kept anyway so the door stays open.
- **Game: open.** Must be named before Milestone 5 (gameplay slice). Until then the rainy cyberpunk alley benchmark is treated as a candidate level, not a throwaway. Given ADR-004 and the no-multiplayer decision, the game is single-player and isometric or close third-person.

## Alternatives

- Engine-first with a synthetic showcase: rejected, no forcing function.
- Multiplayer from day one: rejected, doubles gameplay scope for a game that is not yet named.

## Consequences

- Milestone 10 is the named game's vertical slice.
- Feature priority follows that game's needs, not the feature lists in the kickoff doc.
- Milestone 5 is blocked until the game is named.

## Status

Partial: multiplayer ratified by Greg 2026-09-03; game open.
