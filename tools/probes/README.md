# tools/probes

Headless **gameplay** regression. `pnpm capture` and `pnpm visual` prove the engine draws; the vitest suite proves the pure logic is right. Neither one plays the game. These probes boot the showcase, drive it through `window.__spark.game`, and assert what the mission actually does with physics, navigation, animation and the AI all running.

```bash
pnpm probe                  # every probe, exits 1 on the first bad assertion
pnpm probe --filter=alert   # only probes whose name contains "alert"
pnpm probe --verbose        # print passing assertions too
pnpm probe --headed         # watch it
pnpm probe --seed=7         # a different seeded run
```

## How it stays deterministic

The page is loaded with `fixedclock=60&paused=1&seed=<n>`, so the engine advances only when the probe calls `stepFrames`. The same seed and the same sequence of probe calls replay the same fight, on any machine, at any speed. Nothing reads a wall clock.

## How assertions are written

**Budgets, not frame counts.** `until('the sector goes alerted', 20, …)` says the mechanic must fire within twenty seconds of simulation; it does not care whether it takes four or fourteen. Retuning `AWARENESS.suspiciousAt` or a patrol speed should never fail this suite — only a mechanic that stopped working should. If you find yourself asserting an exact frame, you are writing a unit test; put it in `apps/showcase/tests/` instead.

Every probe also fails on engine log records at warn or above and on browser console errors, so a probe that "passes" is also a clean run.

## The probes

| Probe | What it holds down |
| --- | --- |
| `mission-boots` | The street loads its garrison of eight, three objectives, a quiet sector, and nobody wakes up on their own |
| `alert-ladder` | A shot is heard, someone investigates, the sector goes Alerted, the level-wide hunt turns on, a reinforcement arrives |
| `lockdown-on-casualties` | Two hostiles down while Alerted takes the sector to Lockdown and queues the second wave |
| `checkpoint-reload` | Dying and pressing Enter undoes the alert, retires the reinforcements, and puts the survivors back on patrol |
| `the-insert-has-a-window` | Nobody is shooting at the spawn inside the first five seconds — the player gets a beat to move before the street notices |
| `stance-is-cover` | Going prone builds a watcher's awareness slower than standing does |
| `objectives-advance` | Walking into the first objective advances the mission by exactly one and moves the checkpoint |

## Test seams, not cheats

Two probes need the game to stop being a game for a moment, and both earn it.

`lockdown-on-casualties` needs two dead hostiles. Killing them with the rifle would make a probe about the alert director also a probe about aim, cover and burst spread, and it would fail for the wrong reason — which it did, the first time it ran. It calls `game.damage(name, amount)`, which routes through the same `Enemy.hit` path a round does, so the barks, the gore and the ragdoll all still happen.

`objectives-advance` needs to cross a street held by eight riflemen. They will kill an operator who walks up the middle, and they should — that is the mission working. So the probe sets `game.invulnerable(true)` for the walk and clears it afterwards, and what it asserts is what it came for: the volume fires once, the next objective is the right one, the checkpoint moved.

The rule: when a probe would fail for a reason it is not about, give it a seam rather than a longer timeout. Both seams live on the probe surface, and `Operator.invulnerable` is never set by the game itself.

## Adding one

Append to `PROBES` in `probe.mjs`: a `name`, a one-line `describe`, and `run(p)`. The `p` handle gives you `step`, `run(seconds)`, `until`, `expect`, `stats`, `alert`, `objective`, `call` (any `window.__spark.game` method) and `key`. Anything a probe needs to see has to be on the game's probe surface — add it to the `qa` object in `apps/showcase/src/scenes/mission.ts` rather than reaching into the scene.

## Cost

Each probe boots its own page, which means its own shader warm-up: about thirty seconds a probe on this machine, most of it compiling pipelines. That is why the suite is a handful of probes covering mechanics rather than dozens covering cases.
