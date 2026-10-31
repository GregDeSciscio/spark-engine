# Destruction slice

The vertical slice from `docs/design/destruction-game-readiness.md`: the destruction subsystem inside something shaped like a game. A yard authored in Blender (`pnpm level:yard`, `tools/level-authoring/yard.py`) whose three buildings are destructible boxes (`spark.type = destructible`), a player on the shoulder camera, and five bots that patrol a navmesh rebuilt where the buildings change. Debris and gas hurt; F5 saves a checkpoint and F9, or dying, goes back to it.

```bash
pnpm dev:slice                         # http://localhost:5187
pnpm level:yard                        # re-author the yard in Blender and run it through the asset pipeline
pnpm --filter @spark/slice probe       # the checks below, headless
pnpm --filter @spark/slice exec node tools/play.mjs   # a session through real input, recorded to captures/play.webm
```

Controls: WASD to move, Space to jump, click to lock the mouse (or right-drag to look), left-click to fire. 1 rocket, 2 rifle, 3 gas grenade. F5 save, F9 load.

The depot is brick, the tower concrete and the shed painted metal: each building's Blender material is an engine surface name, and its chunks wear that surface (broken faces raw concrete). The sounds are the destruction sandbox's ElevenLabs takes (`apps/destruction/public/sfx`), served at `/sfx` and copied into the build by `vite.config.ts` rather than duplicated.

## What it wires together

- **Authored structures.** The level loader returns each building's boxes (`LoadedLevel.destructibles`); `authoredStructure` fractures them; one `Destruction` per building.
- **Shared budgets and worker.** The three buildings draw on one body budget and one link budget (`budgetsOf`) and solve on one worker (`StrainWorkerPool`).
- **Navigation.** `Navigation.tiled` over the level's `COL_` boxes and every structure's `navGeometry`; each structure's `reshape` invalidates tiles; the scene rebuilds one a frame.
- **Damage.** `Destruction.watchHits` on the player and the bots; a `hit` deals momentum ÷ 200. Gas deals 30 a second at full density (`Destruction.densityAt`). A dead bot's entity is destroyed, which frees whatever it was holding up (a kinematic capsule never gives).
- **Checkpoints.** `save()` every structure plus the player and the bots, as plain JSON; loading builds each structure afresh and `restore()`s it.

## The probe (`tools/probe.mjs`)

Fixed clock, strain inline:
- the depot's back wall taken out opens a way in: 28.8 m round by the door, then 5.5 m through the gap once 2 tiles are rebuilt;
- a bot in the tower's ground storey is killed when it goes (one hit);
- a bot in gas: 70 health after 1.5 s, dead by 7.5 s;
- the tower's and the depot's tops come straight down, timed every quarter second against free fall, never back up;
- a checkpoint saved, the shed blown away, the checkpoint loaded: every structure, the dead bots and the player back as saved, and settling after.

Real time also checks that every sound take is served and decodes (27 of 27), and that the collapse is heard: in one run 7 booms, 14 cracks, 28 crumbles, 6 collapse roars and 70 landings. `--throttle=2` slows the CPU (Chromium's emulation) and `--query=preset=low` passes page options.

Real time, strain on the shared worker (headless Chromium, WebGPU, Ryzen 7 3700X and RTX 4070; three runs on 2026-10-30): the tower's ground storey, four rockets into the depot and three into the shed, 1 s apart, with the bots patrolling and the navmesh rebuilding:

| median | 95th percentile | 99th percentile | longest | frames over 33 ms | debris peak (limit 360) | tiles rebuilt |
|---:|---:|---:|---:|---:|---:|---:|
| 12.0–12.2 ms | 12.3–24.3 ms | 18.2–30.3 ms | 24.2–36.3 ms | 0–1 | 258–283 | 389–512 |

## The recorded session (`tools/play.mjs`)

Real keyboard and mouse only, in real time: walk up the yard, rockets into the shed, a right-drag to the depot for rockets and rifle shots, F5, a turn to the tower for rockets and gas, F9, walk away. It checks each input landed, F9 brought back exactly what F5 saved, the collapse was heard and nothing hit the console; `--shots` saves stills. It is a first pass for the playtest, not the playtest.

## What it found

- **A visitor that destroys what it found leaked a collider.** A debris `hit` killed a bot from inside Rapier's overlap callback; the bot's collider stayed in Rapier after the JS side forgot it. Physics visitors now run after the query (`PhysicsQueryCallbacks.test.ts`).
- **Concrete bounced.** A two-storey building's top landed and rose 2.9 m, nearly back where it was built, before falling again. Debris now leaves an impact upward at no more than a tenth of its fall speed.
- **A kinematic character holds up what lands on it.** That is the game's to resolve: here a heavy hit kills.
- **A checkpoint load froze for 3 s**, found only by playing it in real time: every structure made its own 22 particle emitters, regenerated on each load. The structures of a world now share their effects; a load is 117 ms plus one 443 ms frame.
- **A save missed what was waiting to come loose**, so a mid-collapse load stood three chunks back up. The detach queue is saved now.
