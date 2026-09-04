# ADR-004: Camera model: isometric / third-person primary, first-person unsupported

## Context

The kickoff's visual references span first-person (Cyberpunk 2077), isometric (The Ascent, Hades II) and third-person (Returnal). The camera model decides shadow cascade count, LOD budgets, whether SSR is worth its cost, and draw distance. Supporting all three triples the rendering validation surface.

## Decision

```
Primary:      close third-person over the shoulder (the customer game, ADR-005)
Supported:    isometric / three-quarter; cinematic cameras for cutscenes and menus
Unsupported:  first-person
```

Camera feel (follow, framing, shake, look-ahead) is an engine feature in `rendering/CameraSystem.ts`, not game code.

## Draw distance (added 2026-09-04)

The customer game is over the shoulder with a 100 m rifle range inherited from Task Unit, so "bounded draw distance" means bounded by level design and atmosphere, not by the camera:

- Levels keep sightlines under about 120 m. Dense city streets, rain, and height fog do this naturally, and the far plane sits at 200 m with fog hiding the cutoff. Anything beyond is a skyline backdrop, not geometry.
- Distance culling at the far plane; two LOD levels for props, no impostors.
- The setting is night. Directional shadows come from a moon or sky light and matter far less than in Task Unit's daylight maps: two cascades on high (0 to 20 m, 20 to 80 m), three on ultra, none past 80 m. Shadow budget shifts to a small number of shadowed local lights through the clustered lighting system.
- SSR keeps its floors-and-puddles tuning; the 40 to 56 m max distance is enough for street-level reflections.

## Alternatives

- Support all three: rejected (validation cost).
- First-person primary: rejected (does not match the customer game; see ADR-005).

## Consequences

- Two shadow cascades on the default preset, with the budget spent on local light shadows.
- Draw distance is bounded by level authoring, so scene density still matters more than distance culling and LOD.
- SSR is tuned for floors and puddles, which is exactly the benchmark scene.
- The ADR-008 level pipeline needs a sightline check (Task Unit's map gates already do this for spawns).

## Status

Proposed. Needed before Milestone 2. Camera primary and draw distance set by the customer game 2026-09-04.
