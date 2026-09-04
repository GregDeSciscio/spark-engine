# ADR-006: v1 non-goals

## Context

Ambiguity about platform and scope costs real effort: a "maybe mobile" engine tunes for hardware it never ships on. Each exclusion below is deliberate.

## Decision

| Area | v1 status | Note |
| --- | --- | --- |
| Mobile | out | Memory and download-size constraints still apply, but no mobile GPU tier is tuned or tested. |
| VR / XR | out | No stereo rendering, no XR input. |
| First-person camera | out | See ADR-004. |
| WebGL2 as a quality tier | out | Compatibility only, Low preset only. See ADR-001. |
| Multiplayer | out | See ADR-005. Determinism kept regardless. |
| Full visual editor | out | Blender is the level editor. See ADR-008. |

## Consequences

Anything that would exist only to serve one of these is out of scope until this ADR is superseded.

## Status

Proposed. Needed before Milestone 0.
