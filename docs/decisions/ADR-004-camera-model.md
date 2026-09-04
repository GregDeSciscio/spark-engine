# ADR-004: Camera model: isometric / third-person primary, first-person unsupported

## Context

The kickoff's visual references span first-person (Cyberpunk 2077), isometric (The Ascent, Hades II) and third-person (Returnal). The camera model decides shadow cascade count, LOD budgets, whether SSR is worth its cost, and draw distance. Supporting all three triples the rendering validation surface.

## Decision

```
Primary:      isometric / three-quarter and close third-person
Supported:    cinematic cameras for cutscenes and menus
Unsupported:  first-person
```

Camera feel (follow, framing, shake, look-ahead) is an engine feature in `rendering/CameraSystem.ts`, not game code.

## Alternatives

- Support all three: rejected (validation cost).
- First-person primary: rejected (does not match the customer game direction; see ADR-005).

## Consequences

- One or two shadow cascades usually suffice.
- Draw distance is bounded; distance culling and LOD matter less than scene density.
- SSR is tuned for floors and puddles, which is exactly the benchmark scene.

## Status

Proposed. Needed before Milestone 2.
