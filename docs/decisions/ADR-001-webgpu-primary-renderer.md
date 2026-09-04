# ADR-001: WebGPU primary renderer; WebGL2 is a compatibility tier with a fixed ceiling

## Context

The engine targets AAA-adjacent visuals in a browser. Three.js's `WebGPURenderer` exposes one renderer with two backends (WebGPU, and a WebGL2 fallback backend). Compute shaders, storage buffers, indirect draw, GPU culling and clustered lighting exist only on the WebGPU backend. Maintaining feature parity across both backends would double the validation surface for features the compatibility path cannot run anyway.

## Decision

- One renderer class (`SparkRenderer` wrapping `THREE.WebGPURenderer`). The fallback is that renderer's WebGL2 backend, never the legacy `WebGLRenderer`.
- Backend is selectable via config and the `?backend=webgpu|webgl` URL parameter so both paths run in CI.
- The WebGL2 tier promises only: boots, renders PBR + shadows at the Low preset, throws nothing. It is not a quality target.
- WebGPU-only features (compute, GPU particles, GPU culling, indirect draw, HZB, clustered lighting, volumetrics) switch **off** on WebGL2. No emulation path is written.

## Alternatives

- Two renderers (legacy WebGL + WebGPU): rejected, duplicate pipelines.
- WebGPU only, no fallback: viable later; kept the fallback for now because it is cheap given three's built-in backend. Revisit here if audience browser data says the fallback is not worth its test cost.

## Consequences

- Definition of Done requires the WebGL2 tier to still boot at Low, not to match features.
- The capture and visual suites run the `bootstrap` scene on both backends; WebGPU-only scenes are marked as such in the manifests.
- Note from Milestone 0: three's `renderer.init()` does not throw when WebGPU device creation fails; it silently falls back to WebGL2 with a console warning. `SparkRenderer` therefore confirms the active backend from `renderer.backend.isWebGPUBackend` rather than trusting the request.

## Status

Proposed (ratification: Greg). Implemented in Milestone 0.
