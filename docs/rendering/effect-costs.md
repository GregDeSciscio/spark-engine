# Post-effect costs (Milestone 7)

Measured 2026-09-04 with the real-time probe (headless Chromium via Playwright, D3D11 ANGLE, WebGPU backend, `timestamp-query` on), scene **alley** (v2), preset **high**, seed 1, dynamic resolution pinned off at render scale 1.0. Each row toggles one effect relative to the preset baseline (`RenderPipeline.setEffectEnabled`), waits for the recompose's shader compile to clear, then averages two `window.__spark.snapshot()` reads 3–4 s apart.

Machine: NVIDIA GeForce RTX 4070 (Ada), AMD Ryzen 7 3700X, Windows 11. Frame rate is capped by headless Chromium's rAF at ~126 Hz, so `fps` only shows that the budget holds; `gpuMs` (three's `RENDER` timestamp query, render passes only, compute excluded) is the number to compare. GPU timestamps jitter by about ±0.15 ms between reads; deltas under 0.2 ms are noise.

## 1920×1080, alley, high

Baseline graph: `ao traa ssr volumetrics bloom` (SSR from the preset; the alley opts into `volumetrics` on high, see below). Rain (20k GPU streaks), steam, splash rings, decals, height fog all on.

| state | fps | cpuMs | renderMs | gpuMs | Δ gpuMs | note |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | 126.5 | 5.2 | 5.1 | 3.25 | – | rain + SSR + AO + TRAA + bloom + volume: **≥ 60 fps gate passes** (3.3 ms of the 16.7 ms GPU budget) |
| ao off | 126.7 | 5.3 | 5.2 | 2.73 | **0.52** | GTAO 16 samples at 0.5 scale + prepass |
| traa off | 125.8 | 5.6 | 5.5 | 2.81 | ~0.2 | reprojection resolve at full res |
| fsr1 | – | – | – | – | 0 | not in the graph at scale 1.0 (appears with dynamic resolution; ~0.15 ms when it does) |
| ssr off | 126.6 | 4.9 | 4.9 | 1.49 | **1.76** | mirror trace at 0.5 scale, quality 0.6, 5 blur mips; the most expensive stage |
| volumetrics off | 126.3 | 5.2 | 5.1 | 2.86 | **0.39** | 24-step raymarch at 0.5 scale, one spot cone; under the 1.5 ms opt-in bar |
| godrays on | 126.0 | 5.7 | 5.6 | 3.42 | **0.17** | 32 steps at 0.5 scale through the moon's shadow map |
| motionBlur on | 126.1 | 5.7 | 5.6 | 3.41 | **0.16** | 8 taps + one RTT copy |
| bloom off | 126.7 | 6.4 | 6.2 | 3.04 | ~0.2 | mip chain |
| dof on | 126.4 | 5.7 | 5.6 | 3.81 | **0.56** | CoC + 64/16-tap bokeh at half res + composite |
| fxaa on | 126.7 | 5.9 | 5.8 | 3.43 | ~0.2 | post-tonemap |

## 1280×720, alley, high

| state | fps | cpuMs | renderMs | gpuMs | Δ gpuMs |
| --- | --- | --- | --- | --- | --- |
| baseline | 126.4 | 5.7 | 5.5 | 1.39–2.30 (median 1.5) | – |
| ao off | 125.7 | 5.4 | 5.3 | 1.42 | ~0.1 |
| traa off | 126.5 | 5.4 | 5.3 | 1.57 | ~0 |
| ssr off | 125.7 | 5.2 | 5.1 | 1.07 | **0.45** |
| volumetrics off | 125.8 | 5.6 | 5.5 | 1.21 | **0.3** |
| godrays on | 126.6 | 5.3 | 5.2 | 1.46 | ~0.05 |
| motionBlur on | 126.5 | 5.7 | 5.6 | 1.51 | ~0.05 |
| bloom off | 126.1 | 5.0 | 4.9 | 1.57 | ~0 |
| dof on | 126.3 | 6.1 | 6.0 | 1.59 | ~0.1 |
| fxaa on | 126.3 | 6.4 | 6.2 | 1.53 | ~0.05 |

At 720p the whole frame is 1.5 ms of GPU and the loop is rAF-bound at 126 fps; the **≥ 100 fps gate passes** with a large margin. CPU time (5–6 ms, of which ~5 ms is render submission: ~480 draw calls) is the same at both sizes, so the alley is CPU/submission-bound long before it is GPU-bound on this machine.

## How the numbers were taken

`tools/capture/out/probe.mjs` (gitignored) imports `launchBrowser`/`startServer` from `tools/capture/capture.mjs`, opens `?scene=alley&backend=webgpu&preset=high&size=WxH&overlay=0`, waits for `window.__spark.ready`, pins the scale (`renderer.setDynamicResolutionEnabled(false)`, `setRenderScale(1)`), waits ≥ 6 s and until the 60-frame CPU average is below 30 ms (a recompose compiles shaders synchronously and stalls the loop for a second or two), samples twice, then for each available effect flips it, waits for stability, samples twice, and restores it. The page can be reloaded by vite mid-run when another process edits engine sources; the probe re-pins and re-asserts the toggle when that happens.

## Preset defaults

| effect | low | medium | high | ultra | cinematic | quality knob (`QualitySettings`) |
| --- | --- | --- | --- | --- | --- | --- |
| ssr | – | – | on (0.5 scale, q 0.6, 40 m) | on (1.0, 0.8, 48 m) | on (1.0, 1.0, 56 m) | `ssrResolutionScale`, `ssrQuality`, `ssrMaxDistance` (layout-level: needs the normal+material MRT) |
| volumetrics | – | – | off (alley opts in) | on (32 steps) | on (48 steps, 0.75 scale) | `volumetricSteps`, `volumetricResolutionScale`; needs a `VolumeFogSettings` registered |
| godrays | – | – | off | on (48 steps) | on (64 steps) | `godraysSteps`; needs a shadow-casting light registered |
| motionBlur | – | – | off | on (12 taps) | on (16 taps, 0.8 shutter) | `motionBlurSamples`, `motionBlurStrength` |
| dof | – | – | off | off | on (bokeh 2.0) | `dofBokehScale`; focus from `setFocus` / `CameraRig.bindFocus` |

All five are WebGPU-only and unavailable on the WebGL2 compat tier (`getEffects()` reports `available: false`), and none of them is a shader variant of the scene materials: the SSR MRT attachments are part of the scene-pass layout for presets with `screenSpaceReflections`, everything else is quad-level and toggles by recomposing the cheap end of the graph.

## Clustered lighting

Measured 2026-09-04 with `tools/capture/out/probe-lights.mjs` (same machine and method as above; `gpuMs` is three's `RENDER` timestamp, `compute` its `COMPUTE` timestamp from `LightingStats.computeMs`), scene **lights** (kickoff Benchmark B: 1,600 instanced props, one shadowed sun, N moving coloured point lights on seeded orbits, `?lights=N`), preset **high**, WebGPU. Every point light takes the clustered path (`LightingSystem`; see "Clustered lighting" in `docs/performance/cold-start.md`); the scene sets the light budget to N.

| lights | 1280×720 fps / cpuMs / gpuMs | 1920×1080 fps / cpuMs / gpuMs | compute (cluster assignment) |
| --- | --- | --- | --- |
| 13 | 165 / 1.7 / 1.17–1.23 | 165 / 1.7 / 1.67 | ~0.03 ms |
| 64 | 165 / 1.8 / 1.21–1.27 | 165 / 1.9 / 1.74 | ~0.04 ms |
| 256 | 165 / 2.1 / 1.32 | 165 / 2.1 / 2.20 | 0.05 ms |

Going from 13 to 256 lights costs **0.5 ms of GPU at 1080p** (0.15 ms at 720p) and 0.4 ms of CPU (the per-frame view-z sort and texture upload of 256 lights), with the lit shaders unchanged (4 lit programs, 33.5 KB fragment WGSL at most, whatever N is; pipelines 32 / programs 49 at every N). The frame stays rAF-bound at 165 fps at both sizes: the **256-light gate (60 fps or better at 1280×720) passes** with a wide margin, and 1080p holds it too. The alley (63 lights, 60 clustered) at 1080p went from 5.9 ms to 4.0 ms of GPU against its 13-light unrolled version, see the cold-start doc.

Where the cost is: the fragment loop is bounded by the lights in the fragment's cluster (two to four in these scenes), so it scales with light density on screen rather than light count; the compute pass is one thread per cluster (48 960 on high) looping over the lights whose view-z range overlaps the cluster's slice. The WebGL2 tier runs none of this (budget capped at 8 unrolled local lights).
