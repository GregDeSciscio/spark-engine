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

## The current baseline's provenance

`desktop-pn02eil-win32-nvidia-lovelace.json` was recorded on a quiet machine on 2026-09-07. Later that day it read red on `cpuMs` for **every** entry, including scenes nothing had touched (bootstrap +23% on CPU with its `gpuMs` and its 165 fps back at baseline exactly): a machine with forty-six Chrome processes and seven gigabytes resident, not an engine that got slower.

**2026-10-23, after six weeks idle:** with the GPU at 10% and nothing else running, the unchanged baseline compared **green across all nine entries**. September's red was the machine, and the baseline needed no re-recording for that.

The mission's row was then updated, **counters only**. It had been recorded before a day of draw-call work, at 1053 draws against the 721 the scene actually made, so a regression of up to 330 draws would have passed unnoticed. Milestone 10 added the broker and a demolition rig (six emitters, three lights, a satchel) and taught the particle system to skip idle emitters, leaving the mission at **718 draws and 1,244,595 triangles**, the values now in the file. Its timing metrics were deliberately left at the September quiet recording. That day another session was driving the same GPU (Unreal, often at 90%+ with the CPU at 40–60%), so re-recording timings would have baked contention in. Instead, the change was proven against HEAD with alternating A/B runs, each taken only in a quiet window and kept only if the GPU stayed quiet throughout (`cpuMs`, median of the run):

| Run | HEAD (b9f9730) | Milestone 10 |
| --- | --- | --- |
| 1 | 16.89 ms, 721 draws | 16.07 ms, 718 draws |
| 2 | 16.42 ms | 16.28 ms |
| 3 | 16.23 ms | 16.52 ms |

Both columns sit about 3.5 ms above that morning's quiet 12.9 ms, which is the CPU load, not the code. Re-record the timings on an idle machine before trusting an absolute comparison against them.

**Later the same day, the second lanes:** the level pass added a west service alley with back blocks, plus a stair and catwalk overwatch: 32 more draws and 462,307 more triangles, past the counter tolerance by design. So the mission row was re-recorded, timings included, from one `--record --filter=mission` run. The GPU stayed under 35% throughout. The row read 15.23 ms CPU, 13.45 ms render, 750 draws and 1,706,902 triangles, until the freeze fix below re-recorded it. Before recording, the change was A/B'd against HEAD (7213218) with the GPU at 0–9%:

| | CPU (median) | Render | Draws | Render per draw |
| --- | --- | --- | --- | --- |
| HEAD, two runs | 15.35, 15.46 ms | 13.71 ms | 716–718 | 19.1 µs |
| Second lanes, two runs | 16.36, 17.17 ms | 14.44 ms | 748–750 | 19.3 µs |

The cost per draw is the same, so the difference is the alley's content plus about 0.3 ms of new gameplay (mantle, the broker's retreat, the moon-shadow ray), not the engine. The other eight entries keep the September recording (the file's `recordedAt` is the last record of any entry). Run on both trees in the same window that afternoon, they agreed to within 0.1 ms, while both read 15–30% over September. Other apps were busy on the machine then (Chrome, Edge, ChatGPT, Docker), so `pnpm perf` read red on code that had not changed.

**The mission entry used to measure a freeze.** For 2–3 s just after `ready` the mission froze, on an idle GPU as well as a loaded one, and HEAD did too: one long animation frame with no long task inside. The harness settles for only 1.5 s, and the snapshot's `fps` and `cpuMs` are 60-frame rolling averages. When the freeze landed in the sampling window, the mission read 7–15 fps and 23–77 ms on code that runs at 60 fps once settled. When it landed beside the window, the run read clean, and samples taken during the freeze carried stale GPU times. So every earlier mission row, September's included, was read through it to some degree.

The freeze was the GPU process compiling the particle emitters' update kernels on their first dispatch (gap 17 in `docs/design/milestone-10-gaps.md`). Once it was fixed, the row was recorded again from one clean run: 61.7 fps, 15.16 ms CPU, 13.46 ms render, 3.80 ms GPU, 746 draws and 1,702,278 triangles. The draws are now steady at 746 rather than 746–750, because idle emitters stay hidden from the first frame. GPU time is the number that moved: 3.3–3.4 ms on the unfixed tree, 3.8–4.2 ms with the fix, in alternating harness runs. Measured 8 s after `ready`, both trees spend the same on the GPU (4.60–4.70 ms, particle compute 0.07 ms), so the harness now sees frames that render instead of a freeze. If the mission reads below 50 fps again, look for a long animation frame after `ready` before believing it.

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

The tell is `frameMs`. Every benchmark scene finishes its work in 2–6 ms and then waits to present, so `frameMs` measures whatever paces presentation, not the engine. **Headless Chromium paces rAF at about 126 Hz** (`docs/rendering/effect-costs.md` records the same ceiling), which is why every scene in a run lands on the same 7.9 ms. A baseline holding 6.1 ms across the board was recorded under a pacing that no longer applies — it is not evidence that the engine got slower, and re-recording is the fix for it, not investigation.

Because of that, `frameMs` is only reported when `cpuMs`, `renderMs` or `gpuMs` moved as well. The showcase mission, at 14 ms of CPU, is the one entry doing enough work to be measuring itself rather than the ceiling.

## What is worth trusting on a busy machine

`drawCalls` and `triangles` are exact — trust them completely. `cpuMs`, `renderMs` and `gpuMs` are medians of a few seconds and move with whatever else the machine is doing: over one session the showcase mission measured 66, 64, 71 and 57 fps on identical code. If a change matters at the couple-of-millisecond level, alternate A/B/A/B runs rather than believing one reading, and prefer a deterministic counter as the headline number when you have one.

## Reading the numbers

`cpuMs` is the whole frame on the CPU and `renderMs` is the part of it spent submitting draws, so `cpuMs - renderMs` is roughly what the game's systems cost. A scene where `renderMs` dominates and `gpuMs` is small is bound by draw submission — more draw calls, not heavier ones. That is the showcase mission: about 720 draws, 11–14 ms of submission and 2–3 ms of GPU (2026-10-23).
