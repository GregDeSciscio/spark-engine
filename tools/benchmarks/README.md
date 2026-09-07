# tools/benchmarks

Frame-time regression. Runs each entry in `tests/perf/manifest.json` in **real time** (not the fixed clock — GPU timestamps only resolve properly in a running loop), samples the engine's own stats four times a second, and compares medians against this machine's baseline.

```bash
pnpm perf                        # compare, exit 1 on a regression
pnpm perf --record               # write this machine's baseline from a fresh run
pnpm perf --record --filter=mission   # add or refresh one entry, leaving the rest alone
pnpm perf --seconds=8            # longer sample window (default 4)
pnpm perf --passes=1             # one pass per scene instead of the default two
```

## Best of two passes

Each scene runs twice by default and the better pass counts, metric by metric. Contention only ever makes a number worse — another process taking the GPU for a moment cannot make a frame render faster — so the best observed pass is the honest estimate of what the machine can do, and one unlucky pass no longer fails the suite. Draw calls and triangles take the *worst* of the two instead: those are deterministic, so a difference between passes is real.

This matters more than it sounds. Two consecutive runs of the old single-pass suite on a busy machine flagged completely different scenes — bootstrap, entities and physics the first time, streaming and lights the second — while nothing in the engine had changed at all. A suite that cries wolf gets ignored, and then it is worth nothing when it is right.

## Baselines are per machine

Results land in `tests/perf/baselines/<hostname>-<platform>-<gpu>.json`, so two machines never fight over one file, and a run on an unknown machine records rather than fails. `--record` **merges**: recording one entry keeps every other entry that run did not measure.

## What counts as a regression

| Metric | Tolerance |
| --- | --- |
| `cpuMs`, `renderMs`, `gpuMs`, `frameMs` | +10%, **and** at least +0.35 ms |
| `drawCalls`, `triangles` | +5% |

The absolute floor on the time metrics exists because a percentage is meaningless below the harness's own noise. The cheap scenes measure 1–2 ms of GPU time, where a machine that happens to be busy moves the median by ±0.2 ms — 20%, and nothing to do with the code. Draw calls and triangles are exact and deterministic, so they have no floor: if those move, something really changed.

If a run reports a regression you believe is noise, re-run it on an idle machine before touching the baseline. Re-recording to make a red suite green throws away the only signal the suite has.

## The manifest

Each entry is `{ scene, backend, preset }`, plus an optional `app` (default `benchmark`). The showcase carries `{ "app": "showcase", "scene": "mission", ... }` — one vite server per app is started on demand, so the game is measured next to the engine's scenes rather than only being measured by hand.

## When everything regresses at once

A code change makes one thing slower. A machine change makes everything slower together — a display switching refresh rate, another process on the GPU, a laptop on battery, a hot room. When three quarters of the compared entries regress in the same run, the suite says so in as many words instead of printing a wall of findings that share one cause, and tells you to check the machine before touching the baseline.

The tell is `frameMs`. Every benchmark scene finishes its work in 2–6 ms and then waits to present, so `frameMs` measures whatever paces presentation — the compositor, the driver, another process holding the GPU — and not the engine. When every scene in a run lands on the same number (7.9 ms here, against a baseline of 6.1 ms), that number is a ceiling outside the scene: they cannot all have got slower by the same amount for the same reason. Do not assume it is the monitor without checking; a 164 Hz display was still handing out 127 fps to every scene while something else had the GPU.

Because of that, `frameMs` is only reported when `cpuMs`, `renderMs` or `gpuMs` moved as well. The showcase mission is the one entry doing enough work to be measuring itself rather than the ceiling.

## Reading the numbers

`cpuMs` is the whole frame on the CPU and `renderMs` is the part of it spent submitting draws, so `cpuMs - renderMs` is roughly what the game's systems cost. A scene where `renderMs` dominates and `gpuMs` is small is bound by draw submission — more draw calls, not heavier ones. That is the showcase mission today: 1053 draws, 13 ms of submission, 3 ms of GPU.
