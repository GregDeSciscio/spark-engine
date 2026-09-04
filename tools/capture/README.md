# tools/capture

Headless boot + screenshot + stats. This is how agents (and CI) "look at" the engine.

```bash
pnpm capture --scene=bootstrap --backend=both --preset=high
```

Outputs `tools/capture/out/<scene>-<backend>-<preset>.png` and `.json` (stats snapshot, engine log records at warn+, browser console errors/warnings, page errors, machine info).

Flags: `--frames=30` (fixed-clock frames stepped before the screenshot), `--size=1280x720`, `--seed=1`, `--headed` (watch it), `--allow-errors` (do not fail on console noise), `--out=dir`.

The page is loaded with `fixedclock=60&paused=1&overlay=0`, so the engine advances only when the tool calls `window.__spark.stepFrames(n)`. Same scene + same seed + same frame count = same pixels, which is what `pnpm visual` relies on.

## Known gap: GPU time in stepped mode

`gpuMs` is reliably measured only in real-time runs (`pnpm perf`). In paused/stepped capture the WebGPU timestamp resolve does not land before the snapshot even with a 2 s wait, so `gpu=n/a` in capture output is expected on both backends. CPU time, draw calls and triangles are accurate in both modes.

## Headless WebGPU (Chromium)

Verified 2026-09-03 on Windows 11 + NVIDIA, Playwright 1.62.1, Chromium build 1234. Two things matter:

1. **Launch the full Chromium, not the headless shell.** Playwright's default headless target (`chromium_headless_shell`) has no GPU process, so `navigator.gpu.requestAdapter()` returns a fallback and device creation fails ("Device failed at creation"). `chromium.launch({ channel: 'chromium', headless: true })` runs the real browser in its new headless mode, which does have a GPU.
2. **Use the D3D11 ANGLE backend.** Flags in `CHROMIUM_ARGS`:

```
--enable-unsafe-webgpu --ignore-gpu-blocklist --use-angle=d3d11
```

`--use-angle=vulkan` and `--use-webgpu-adapter=swiftshader` both reported "No available adapters" on this machine.

If a capture reports `backend: webgl` when `webgpu` was requested, WebGPU did not initialise in headless mode. Check `pnpm capture --headed` first (headed Chromium almost always has WebGPU); if headed works and headless does not, the channel/flag set needs updating for the current Chromium. Keep this file current when the flags change.
