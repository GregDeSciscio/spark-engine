# Destruction: what a first game still needs

Written 2026-10-30, at `a7b99f9`, before any game uses the `Destruction` subsystem (ADR-011). The bar is a shipped game, not the sandbox: a level of several structures, a player, bots, checkpoints and the rest of a frame's work on top.

## Where it stands

The subsystem is sound on its own terms:
- **Strain** breaks exactly what an always-refactor solver breaks, step for step, in all 16 bench cascades. A step with 1–2 breaks costs 2–10 ms up to 6,346 chunks.
- **The solve** runs in an engine-owned worker that falls back to the main thread, replaying every request so far, if the worker fails.
- **A game wires it in three lines.** A raycast names the structure's entity and the chunk, and `dispose()` leaves no body, collider or joint behind.
- **Determinism:** randomness is forked from the context's `Random` per structure and per layer, and nothing in the simulation reads the clock.
- **Checks:** typecheck, lint and 532 tests pass. `apps/destruction` has the soak, feel, rest, clip, tower and mid-air probes that caught every regression so far.

What it has not had is a game. Every measurement is one structure in the sandbox with a fly camera. No player, bot or authored level has been in it.

## The gaps

| # | Gap | Against | Status |
| --- | --- | --- | --- |
| 1 | **Buildings are procedural only.** A structure is `Piece`s from `core/building.ts`: walls and slabs cut into 2D Voronoi cells (`fractureRect`) and extruded (`prism`). Nothing fractures a Blender mesh or reads connections from glTF extras, so a level's buildings cannot be authored the way the rest of the level is. The sandbox README lists it as a spike shortcut. | ADR-008 | open |
| 2 | **Never more than one structure in a scene.** The only `new Destruction(` outside tests is `apps/destruction/src/scene.ts`, and the arena's two buildings are one structure. Each `Destruction` makes its own `WorkerStrainHost` and its own `Debris` with `maxBodies: 360`, so ten buildings means ten workers and up to 3,600 loose bodies. The soak proved a budget for one. The budget, and probably the worker, need to be shared across structures. | a level | open |
| 3 | **The navmesh does not change.** `ai/Navigation.ts` bakes once and has no tile rebuild or obstacle API, and destruction emits nothing navigation reads. Bots would walk into rubble, never use a new hole, and route across floors that have gone. | ADR-005 (bots) | open |
| 4 | **No character has stood in it.** `CharacterController` pushes dynamic bodies, but no test puts one on a floor that drops, under falling debris, or behind cover that goes. The events (`land`, `shatter`, `buckle`, `tear`, `fail`, `blast`, `weakening`, `step`) carry positions, masses and speeds, and none names an entity that was hit, so a game cannot deal damage from debris. Gas does no damage. | a player | open |
| 5 | **The floating fix has not been playtested.** Greg reported floating tops four times. `a7b99f9` (Strain's verdict binds the physics) fixed the root cause and every probe passes, but nobody has played it since. Its trade-off is a gameplay question: a building that comes all the way down leaves mostly slabs and grit (26% of a five-storey building gone, 60% of an eight-storey one), which decides what cover and sightlines remain. | playtest | open, needs Greg |
| 6 | **A camera path changed a fixed-clock simulation.** While making the showcase film, a fixed-clock replay with a different camera path gave a different simulation. The obvious causes are clean: the `Random` forks happen once at construction (`Destruction.ts`), `performance.now` feeds only timing stats and the build log, and Strain chooses between a downdate and a refactor by flops, not time. A test should settle it: the same seed and the same events with two camera paths, compared by `census()` and `sanity()` through the cascade and after landing. | ADR-005 (determinism kept regardless) | open |
| 7 | **Performance is measured alone.** On a Ryzen 7 3700X and an idle RTX 4070, the soak's slowest 5% of frames ran at 62–79 fps with a worst main-thread frame of 16–19 ms, and the tower collapse and barrages at `a7b99f9` had no frames over 33 ms. The live heap grew 23–30 MB over a 90 s soak (persistent rubble and hinge records). A game adds characters, AI, audio and UI to the same frame. Destruction needs its own budget in `pnpm perf`, and a run on a weaker machine. | perf suite | open |
| 8 | **No save or restore of destroyed state.** A checkpoint can only rebuild the structure, or replay what broke it. | mission shape (checkpoints) | open |
| 9 | **Smaller items.** The sound takes passed the signature and mix checks but were never signed off by ear. Broken faces are flat (their relief is shading) and soot is one shade per chunk. ADR-011 still reads "Proposed. Built on branch `destruction`", though it is on main. ADR-004 rules out a first-person camera, so a THE FINALS-style first-person game would reopen it. | sandbox README, ADRs | open |

## What to do first

Build a vertical slice before the game: one level with two or three structures, the character controller, a couple of bots, played for real. That exercises gaps 2 to 7 together. Each one turns into a probe the way the sandbox's did, and the slice gives gap 5 its playtest.

Gap 1 depends on the game. The Task Unit sequel (ADR-005) is authored in Blender and has bots, so it needs gaps 1 and 3 closed before its levels can be destructible. A smaller game whose buildings can stay procedural skips gap 1 and can leave gap 3 until it has AI.
