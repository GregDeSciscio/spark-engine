# ADR-007: three.js version policy: exact pin, upgrades gated by the visual suite

## Context

The three.js WebGPU and TSL APIs still change between releases (for example `PostProcessing` renamed to `RenderPipeline` in r183, `hasFeatureAsync` deprecated in r181, node reorganizations). An agent that bumps the version to fix one bug can break every render pass.

## Decision

- `three` is pinned to an **exact** version: **0.185.1** (r185), with `@types/three` 0.185.0.
- Upgrading is an ADR-level change: its own branch, the full `pnpm visual` and `pnpm perf` suites must pass, and this ADR is amended with what broke.
- Agents must not bump `three` to work around a bug.
- Apps alias bare `three` to `three/webgpu` (see `apps/benchmark/vite.config.ts`) so addons and the engine share one set of classes.

## Consequences

- Bugs in the pinned version are worked around in engine code with a comment naming the upstream issue.

## Status

Proposed. Needed before Milestone 0.
