# Spark Engine

A WebGPU-first browser game engine on Three.js. Read `BROWSER_AAA_ENGINE_PROJECT_KICKOFF.md` first; it is the spec. Decisions live in `docs/decisions/`.

## Layout

```
packages/engine     @spark/engine — the reusable engine. No game code.
apps/benchmark      the visual benchmark and perf scenes (?scene=name)
apps/showcase       the customer game's vertical slice (created at Milestone 5)
tools/capture       headless boot + screenshot + stats (the agent verification loop)
tools/benchmarks    perf runner and per-machine baselines
tools/asset-pipeline normalize / compress / validate GLB assets
tests/visual        golden images per scene × backend × preset
tests/perf          recorded baselines
docs/decisions      ADRs
```

## Run

```bash
pnpm install
pnpm dev                     # benchmark app on http://localhost:5173
```

URL parameters: `scene=bootstrap`, `backend=webgpu|webgl|auto`, `preset=low|medium|high|ultra|cinematic`, `scale=0.5..1`, `dpr=1`, `seed=1`, `overlay=0`, `inspector=1` (engine inspector on three's Inspector addon; F2 toggles it at runtime, never shown when `overlay=0`), `fixedclock=60`, `paused=1`, `size=1280x720`, `log=debug`.

## Verify

```bash
pnpm check                                   # typecheck + lint + unit tests + production build
pnpm capture --scene=bootstrap --backend=both # screenshot + stats JSON + clean-console check
pnpm visual                                  # capture every manifest entry, diff against goldens (--update to rewrite)
pnpm perf                                    # real-time benchmark vs this machine's baseline (--record to write)
```

"It works" means `pnpm check` passes and `pnpm capture` produced a screenshot you looked at with a clean console. See `tools/capture/README.md` for the headless WebGPU setup.

## Rules that are enforced

- `three` is pinned exactly (ADR-007). Do not bump it.
- `Math.random()` is a lint error. Use `Random` from the engine.
- `packages/engine` never imports from `apps/*`. Apps import only from `@spark/engine`.
- Only `ecs/` imports bitecs; only `physics/` imports Rapier; only `rendering/` touches the three renderer.
