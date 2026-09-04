# ADR-002: Physics: Rapier on the main thread at a fixed step; worker move is a hosting decision

## Context

Rapier 3D (WASM) is the physics engine. Moving physics to a Web Worker with shared memory requires `SharedArrayBuffer`, which requires `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers on every host serving the game, which breaks some third-party embeds. Message-passing without shared memory adds a frame of latency and serialization cost.

## Decision

- `@dimforge/rapier3d-compat` runs on the main thread inside the engine's fixed step (`fixedStepHz`, default 60).
- The physics module exposes bodies, colliders, triggers, raycasts, a character controller and a debug renderer behind engine interfaces; nothing outside `physics/` imports Rapier.
- Moving physics to a worker is a separate ADR that must also settle the hosting headers.

## Alternatives

- Worker + SharedArrayBuffer from day one: rejected, couples the engine to hosting config before there is a host.
- ammo.js / cannon-es / Jolt: rejected, Rapier has the best maintained WASM build and a built-in character controller.

## Consequences

- Physics cost lands on the main-thread CPU budget (1–2 ms target).
- Determinism is easier: one thread, fixed step, seeded RNG.

## Status

Proposed. Needed before Milestone 4.
