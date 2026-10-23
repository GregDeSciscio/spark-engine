# tools/probes

Headless **gameplay** regression. `pnpm capture` and `pnpm visual` prove the engine draws; the vitest suite proves the pure logic is right. Neither one plays the game. These probes boot the showcase, drive it through `window.__spark.game`, and assert what the mission actually does with physics, navigation, animation and the AI all running.

```bash
pnpm probe                  # every probe, exits 1 on the first bad assertion
pnpm probe --filter=alert   # only probes whose name contains "alert"
pnpm probe --verbose        # print passing assertions too
pnpm probe --headed         # watch it
pnpm probe --seed=7         # a different seeded run
pnpm probe --shots=out/m10  # save a 1280x720 frame at each probe's named beats
```

## How it stays deterministic

The page is loaded with `fixedclock=60&paused=1&seed=<n>`, so the engine advances only when the probe calls `stepFrames`. The same seed and the same sequence of probe calls replay the same fight, on any machine, at any speed. Nothing reads a wall clock.

## How assertions are written

**Budgets, not frame counts.** `until('the sector goes alerted', 20, …)` says the mechanic must fire within twenty seconds of simulation; it does not care whether it takes four or fourteen. Retuning `AWARENESS.suspiciousAt` or a patrol speed should never fail this suite — only a mechanic that stopped working should. If you find yourself asserting an exact frame, you are writing a unit test; put it in `apps/showcase/tests/` instead.

Every probe also fails on engine log records at warn or above and on browser console errors, so a probe that "passes" is also a clean run.

## The probes

| Probe | What it holds down |
| --- | --- |
| `mission-boots` | The street loads its garrison of eight riflemen and the broker, three objectives and extraction, a quiet sector, and nobody wakes up on their own |
| `the-opening-frames-compile-nothing` | The shader warm-up ran every particle emitter's update kernel (`renderer.lastWarmUp.kernels` equals the emitter count on WebGPU), and the pipeline cache does not grow in the first three seconds of play. Left to their first dispatch, those kernels froze the mission for 2.3 s just after it was ready |
| `alert-ladder` | A shot is heard, someone investigates, the sector goes Alerted, the level-wide hunt turns on, a reinforcement arrives |
| `lockdown-on-casualties` | Two hostiles down while Alerted takes the sector to Lockdown and queues the second wave |
| `checkpoint-reload` | Dying and pressing Enter undoes the alert, retires the reinforcements, and puts the survivors back on patrol |
| `the-insert-has-a-window` | Nobody is shooting at the spawn inside the first five seconds — the player gets a beat to move before the street notices |
| `stance-is-cover` | Going prone builds a watcher's awareness slower than standing does |
| `objectives-advance` | Walking into the first objective advances the mission by exactly one, moves the checkpoint, and puts the broker up next |
| `the-alley-is-a-way-through` | The service alley joins the square to the depot: the navmesh reaches it, the operator walks square passage, lane and depot passage to the charge with most of the walk beyond the facade line, and the lane reads darker on the visibility meter than open road |
| `the-overwatch-sees-the-broker` | From the catwalk's far end there is a clear line from the operator's eye down onto the broker's chest while he walks his beat; the stair is walked up, and the navmesh climbs it too, so hostiles can follow |
| `mantle-vaults-a-crate` | Space facing a waist-high crate from a standstill vaults it (feet over the top, landing beyond it), and Space in the open is still an ordinary jump that comes down where it left |
| `charge-is-defended` | Arming the charge trips the alarm (sector alerted), sends two hostiles to pull it, and a charge nobody defends is pulled and the mission is back on setting it |
| `the-broker-keeps-his-distance` | Shot at from six metres, the broker backs away instead of closing like a rifleman, and his alert pulls the street in |
| `the-street-calms-down` | Once nobody can find the operator, the sector settles from alerted back to quiet and stands its wave down: the half of the alert model that never ran before the lost-contact fix |
| `start-to-extraction` | The whole mission walked and shot through: the square, the broker killed by gunfire, the charge set and held until it blows, the walk home, the debrief, and Enter playing it again from a clean street. Its `--shots` frames are the slice's captures |

## Test seams, not cheats

Two probes need the game to stop being a game for a moment, and both earn it.

`lockdown-on-casualties` needs two dead hostiles. Killing them with the rifle would make a probe about the alert director also a probe about aim, cover and burst spread, and it would fail for the wrong reason — which it did, the first time it ran. It calls `game.damage(name, amount)`, which routes through the same `Enemy.hit` path a round does, so the barks, the gore and the ragdoll all still happen.

`objectives-advance` needs to cross a street held by eight riflemen. They will kill an operator who walks up the middle, and they should — that is the mission working. So the probe sets `game.invulnerable(true)` for the walk and clears it afterwards, and what it asserts is what it came for: the volume fires once, the next objective is the right one, the checkpoint moved.

`charge-is-defended` and `start-to-extraction` lean on two more. `game.teleport(x, z)` moves the operator without touching health or stance, so the defuse probe can leave the charge unwatched without a minute's walk; `game.interact(on)` holds F. `game.ghost(on)` makes the hostiles perceive nobody, the view they get once the operator is out at extraction: `the-street-calms-down` needs a minute out of every sight line, and nothing on the street guarantees one. `start-to-extraction` walks every metre and kills the broker with the rifle, because that probe's whole claim is that the mission can be played through; only the incoming rounds are switched off.

The lane probes lean on `invulnerable` and `teleport` too, all with rounds passing through. `the-alley-is-a-way-through` starts at the square by teleport and walks everything after; `the-overwatch-sees-the-broker` teleports onto the catwalk to check the sightline before anyone has seen a man on a fire escape (a climb in full view sends the broker off his beat, which the first version of the probe found), then walks the climb from the foot of the stair (`teleport(x, z, y)` takes an optional feet height for the catwalk); `mantle-vaults-a-crate` teleports to a crate it finds through `game.mantleZones()` rather than coordinates the seed chose. `game.navPath(from, to)` says whether the navmesh joins two points, which is the question "can a hostile follow me there".

`walkTo` aims through `lookAt`, which aims from the shoulder pivot, not the feet. Within half a metre of the target the two disagree enough that the operator circles it, so ask for arrival within 0.8 m or more and put the next waypoint further on.

The rule: when a probe would fail for a reason it is not about, give it a seam rather than a longer timeout. Both seams live on the probe surface, and `Operator.invulnerable` is never set by the game itself.

## Adding one

Append to `PROBES` in `probe.mjs`: a `name`, a one-line `describe`, and `run(p)`. The `p` handle gives you `step`, `run(seconds)`, `until`, `expect`, `stats`, `alert`, `objective`, `call` (any `window.__spark.game` method) and `key`. Anything a probe needs to see has to be on the game's probe surface — add it to the `qa` object in `apps/showcase/src/scenes/mission.ts` rather than reaching into the scene.

## Editing while it runs

You can. The vite server these tools start has file watching and HMR turned off (`startServer` in `tools/capture/capture.mjs`), because a save in the editor used to reload the page out from under a probe and fail it with "execution context was destroyed" — a confusing way to be told nothing was wrong. The trade is that a run always tests the files as they were when it started; there is no live reload to wait for.

## Cost

Each probe boots its own page, which means its own shader warm-up: about thirty seconds a probe on this machine, most of it compiling pipelines. That is why the suite is a handful of probes covering mechanics rather than dozens covering cases.
