# Destruction sandbox

A THE FINALS-style structural destruction system, Season 12 edition, as a Spark Engine app.
- **The subsystem** (`packages/engine/src/destruction`, ADR-011): the strain solver in engine-agnostic TypeScript (`core/`), and the runtime on top of it: debris on the physics handle layer (ADR-010), the Season 12 layers (gradual destruction, swinging structures, blast waves, debris piles, dynamic smoke), rebar, soot and sound. A scene uses it through `Destruction`.
- **The sandbox** (this app): the arena, weapons, a fly camera, the HUD, the sound files and every tool that measured it.

It grew up in its own repo (`destruction`, which keeps its history) and moved into the engine on 2026-10-29. Paths below are this app's or the engine's.

Built from Embark's GDC 2024 talk *Engineering Mayhem* (Måns Isaksson) and the Season 12 "PRIME TIME" patch notes. No Embark code.

## Run it

```bash
pnpm install                # at the repo root
pnpm dev:destruction        # (root) or `pnpm dev` here: http://localhost:5186   (?tower=0 leaves out the eight-storey tower behind the street; ?strain=inline puts the solve on the main thread; ?fixedclock does too)
pnpm test                   # (root) the engine's StrainSolver, StrainFactor, DestructionDebris, Rebar, DestructionSmoke and Destruction suites, and this app's arena and sound tests
pnpm bench:solver           # (root) solver costs by building size (3–12 storeys) and cascades against an always-refactor reference → tools/benchmarks/solver-results.md
pnpm capture      # headless stills (fixed clock) + a real-time perf run → captures/
pnpm check:input  # real keyboard and mouse events against the live sandbox, audio unlock, the air bed, every sound take decoding
pnpm soak         # 90 s of randomized real-mouse play: NaNs, runaway speeds, throws caught, budgets, live-heap growth, frame-rate floor (--profile for a CPU profile)
pnpm feel         # real-time responsiveness: click → blast (visual and audio), drag → look, frame pacing in play, recorded to captures/feel/session.webm (--profile: where the collapse frames go)
pnpm rest         # after a heavy bout, what the loose debris does for 30 s: asleep, hanging, roped or free, moving or still; physics cost; a hinge bookkeeping audit
pnpm sfx          # rebuild public/sfx from the ElevenLabs takes in assets/sfx (recipe: takes.json): layer, trim, level, limit (needs ffmpeg, numpy, scipy)
pnpm check:sounds # each sound take against the acoustic signature it should have (needs ffmpeg, numpy, scipy)
pnpm clip         # a 20 s MP4 of the bridge, the smoke and a collapse, with the game's sound mixed in on the same clock → captures/clip.mp4 + clip.wav + clip-sounds.json (what played when; needs ffmpeg)
pnpm collapse     # a collapse frame by frame on a fixed clock: frame and Rapier time, the worst frames, the sandbox's stats at checkpoints (--scenario, --frames, --lead)
pnpm tower        # the eight-storey tower brought down: stills on a fixed clock (captures/tower-*.png), the loose debris census, and real-time frame pacing with the solve in the worker
pnpm blur         # motion blur on against off at preset=ultra, camera still (a falling tower, settled rubble, smoke): fails if blur ghosts anything, i.e. a material placing its own vertices with no previous position for the velocity pass
```

The commands without a "(root)" run in `apps/destruction`.

Controls: WASD to fly, Space/C up/down, Shift to hurry.
- **Left-click** fires at the cursor.
- **Right-drag** looks around.
- **F** switches to mouse look with a crosshair; left-click then fires at the crosshair.

| Key | Action |
|---|---|
| **1** | Rocket |
| **2** | Rifle (three hits pop a chunk) |
| **3** | Breach charge |
| **4** | Smoke grenade |
| **5** | Gas grenade |
| **H** | Stress view: white at baseline, yellow a quarter of the way to breaking, red at the break |
| **F** | Mouse look on/off |
| **R** | Rebuild |

The arena (`src/arena.ts`) is two buildings (3 and 4 storeys, 1,795 chunks in all) with a fractured footbridge between their second floors and a container slung under it on two ropes. It is one `Destruction` structure: one entity owning every chunk's collider, so the weapons fire the engine's own raycast and get the building and the chunk back.

## How it works

| Layer | THE FINALS | Here |
|---|---|---|
| Authoring | Houdini-fractured modules and generated connections | `core/building.ts` and this app's `arena.ts` build walls, slabs, columns and the bridge, with 2D Voronoi cells extruded through each slab (`fracture.ts`). `core/connections.ts` finds the glued faces and the ground contacts. |
| **Strain** (structure) | Embark's own sparse direct Cholesky solver, updated incrementally | `core/strain.ts` + `core/sparse.ts`: each chunk is a 6-DOF node and each contact a six-axis spring; one block-Cholesky solve (nested-dissection ordering) covers gravity plus any extra loads. The factor is kept: a step that only changes loads re-solves with it, and each broken contact comes out of it by an exact rank-6 downdate. A fallen piece stays in the factor, hung off the standing structure by one contact. The solve and the downdate rotations run in small WebAssembly SIMD kernels. |
| Breaking | Constraint impulse split into tension/compression, shear and bending; breaks when it exceeds `Baseline + BreakOffset` | The same split, as stresses over the contact patch. Failure is sequential: each step breaks only contacts within 60% of the worst overload, then the load redistributes. |
| **Gradual destruction** (S12) | "A loose attachment between the detached pieces" | `Hinges.ts`. Every contact Strain breaks becomes a hinge: ball joints at the edge of the old contact, on the side the hanging mass is and toward gravity. A small detached piece (up to 120 chunks, such as a bridge deck or part of a roof) comes apart as a hinged net of single chunks, so it bends and sags instead of hanging rigid. Details below. |
| Swinging structures (S12) | Suspended structures hang from physics ropes | The container hangs from two rope joints (`Destruction.hang`). They follow their deck chunk wherever it goes, and are cut if the chunk is destroyed. |
| Blast waves (S12) | Explosions push debris and the environment | Loose debris and rubble get impulses, the container gets shoved, and standing chunks around the crater get a one-step load in Strain (pressure falling off with distance squared, mostly along the incoming direction). Contacts around a hole crack and hinge outward. |
| Debris | Simulated rigid bodies, persistent piles (S12) | Rapier, through the engine's handle layer (`Debris.ts`). A big island falls as one body per authored element, hinged to the others, and shatters into clusters of chunks on a hard impact (those break up again on the next one). **Strain's verdict is binding**: when it cuts a big island loose, the walls and columns that failed under it (standing below it, upright where they stood, or its own walls whose footing broke) are crushed at once, so it drops instead of standing on them; and a loose wall or column that is still a member (upright as built, most of its element in one body) buckles to grit when it stops a fall or is pressed by more than `crushRatio` times its weight, instead of standing as a block, so a tower pancakes rather than stacking. A building that comes all the way down leaves mostly slabs, grit and dust, as a real pancake collapse does. A body still for 25 steps (by its own speed test, because heaps rarely meet Rapier's sleep thresholds) with nothing hinged to it, lying on the ground, standing structure or rubble, settles into **rubble**: a collider on a fixed body, so piles cost nothing and stay. Over budget, the stillest bodies that lie on something settle rather than vanish; a quarter over, hinges let go of what they have held longest. Rubble keeps a **support graph**: as it settles, each chunk records what it rests on (the ground, standing structure, lower rubble or loose debris), and rubble stays only while a path of those links leads down to the ground. When a link goes (a chunk destroyed, crushed or cleared, or loose debris moving 10 cm off), everything above it with no other path falls in the same step, each settling as the one body it came to rest as. A whole floating top comes down at once instead of peeling away from below. Behind it, rubble round anything that lost support still re-checks with a shape query, and a slow sweep re-checks the rest. Pieces hanging from hinges never count as holding rubble up. Blasts shake rubble loose again. A **step guard** undoes any step that throws a body faster than a collapse can (over 32 m/s): the body goes back where it was. One thrown three steps running is trapped: its hinges let go, and if that isn't enough it settles where it is. Gravel (`Gravel.ts`) is thrown off by blasts and breakages: thousands of small instanced stones flying ballistically and landing on the surface below. |
| Smoke and gas (S12) | Clouds take the shape of the space and explosions disperse them | `Smoke.ts`. Details below. |
| Weakening tells (S12) | Dust and creaking from failing structure | Chunks over 45% of the way to breaking shed dust trickles and groan (`DestructionFx.ts`), and so does a deck hanging off its last hinges. Sounds are ElevenLabs takes, a few per sound (the game's files: this app's `public/sfx`, built by `pnpm sfx`, handed to `Destruction` as `options.sounds`): boom, crumble, crack, creak, thud, the container's clang, and a collapse roar that follows how much debris landed in the last half second, over a looped bed of wind and far-off city. Rebar snaps when a loaded hinge tears. |
| Rendering | GPU transform pool | One mesh for every chunk, one draw a pass: each vertex carries its chunk's id, and the vertex stage reads that chunk's matrix and tint from two float textures (a `BatchedMesh` was a draw per chunk on WebGPU). Broken faces are shaded as rough concrete (a bump from noise and the cells of the aggregate, with the stones a shade off the cement); nothing extra is modelled. **Rebar** (`Rebar.ts`): short bars stick out of every broken contact, riding on their chunks, and every live hinge is drawn as bars through its pivot, so a hanging slab shows what it hangs by. Blasts leave **soot** on the chunks round the crater and on what they throw. Ropes are lines. |
| Networking | Server-side, with quantized, delta-compressed transforms | Not in the sandbox. The core is plain typed arrays, so it could run on a server. |

**Gradual destruction (`Hinges.ts`):**
- **Lifecycle:** a hinge is dormant while both chunks stand. It wakes when they end up on different bodies, so a floor that lost a support swings down and hangs off what's left, and a cut bridge hangs off one building.
- **Load:** loose bodies hinged to each other count as one assembly, and its weight is shared by its links to fixed structure.
- **Failure:** hinges tire when that load is past their endurance, and wear from swinging and jolts. They tear if their anchors stretch, which is the only force readout Rapier gives.
- **Feedback:** what hangs off a standing chunk pulls on it in Strain, so a sagging floor can peel the wall it hangs from.
- **Nets:** glue inside a slab that breaks on impact becomes a weak net that drapes. Nets let go once the heap is still.

**Smoke and gas (`Smoke.ts`):**
- **Fill:** each cloud floods a 0.5 m voxel grid outward from the grenade, nearest voxels first. That makes it round in the open; it pours through doors and holes and never passes through walls. Season 12 sizes: 4.5 m radius, 13 s for smoke and 8 s for gas.
- **Change:** clouds re-check their space when the structure changes, so smoke flows into a newly opened hole. A blast clears a pocket that refills a moment later.
- **Rendering:** one instanced sprite set, drifting in the shader. Each sprite is shaded by its height and by whether a slab is overhead, so smoke indoors reads as grey depth rather than a white fill. Debris crashing through a cloud pushes it aside.

## In the engine (2026-10-29)

What moving into the engine was checked against (the subsystem's design is ADR-011; what it taught is in `docs/architecture/lessons-from-destruction.md`):

- **Tests:** the destruction repo's suites moved into the engine (`StrainSolver`, `StrainFactor`, `DestructionDebris` on real Rapier through the handle layer, `Rebar`, `DestructionSmoke`) and a new `Destruction` suite: a raycast that names the structure's entity and the chunk, an explosion, a chunk popped by three hits, and a dispose that leaves no body, collider or joint. This app keeps the arena tests (the always-refactor cascade check on the arena, smoke filling B's ground floor) and the sound-file test.
- **Dev and production:** both boot and play. The production build emits the strain worker as its own 44.5 KB chunk (the solver and nothing else) and solves in it: the arena's first factor and solve take 44 ms there, and `A-ground` cascades in 6 steps and 22 ms of solving, all off the main thread, with the main thread at an 8.3 ms median frame. With the worker file blocked, the host logs one warning and the same collapse plays out inline.
- **Same behaviour:** `pnpm collapse` (`A-ground`, 240 fixed-clock frames, strain inline) against the destruction repo's sandbox on the same solver: the strain cascade is identical (1,096 then 1,092 chunks standing, 100 bodies made, 5 steps, the same hinge counts at 0.5 s and 1 s), and everything after the debris lands is Rapier's chaos. Starting the collapse one frame later moves the shatter count at 4 s by as much as the port does:

  | at 4 s (frame 240) | standing | loose bodies | settled | shattered | hinges torn |
  |---|---:|---:|---:|---:|---:|
  | destruction repo, lead 30 / 31 | 1,092 / 1,092 | 176 / 223 | 31 / 27 | 134 / 245 | 55 / 129 |
  | engine, lead 30 / 31 | 1,092 / 1,092 | 233 / 214 | 20 / 24 | 249 / 152 | 114 / 53 |

  The old solver (the `hitch` branch, region solves) breaks the same building into the same 1,092 standing chunks over 6 steps.
- **`pnpm check:input`:** passes (keys, flying, right-drag look, a click blows a hole, audio unlocks, the air bed starts, the blast plays, ten quick presses land, all 26 takes decode).
- **`pnpm soak`** (90 s, real time, strain in the worker): no failures on either seed.

  | | seed 3 | seed 11 |
  |---|---:|---:|
  | fps, 5th percentile | 62 | 79 |
  | fps, median | 121 | 120 |
  | fps, minimum | 51 | 60 |
  | worst main-thread frame | 19.0 ms | 16.0 ms |
  | throws the guard caught | 0 | 1 |
  | through the floor | 0 | 0 |
  | live heap after collection | 74 → 104 MB | 74 → 97 MB |
- **`pnpm clip`:** renders the 20 s film with its soundtrack (H.264 and AAC, 20.2 s): 46 thuds, 27 crumbles, 9 cracks, 5 creaks, 4 collapse roars, 2 clangs and the boom, peaking at −0.7 dBFS with the loudest 0.4 s at −12.5 dBFS RMS.
- **`pnpm feel`:** click to blast in 0–10 ms (one click in five shows its blast 30–35 ms later, as it did in the destruction repo's sandbox the same afternoon), right-drag look in 2–7 ms. Frame pacing on the day was slower than the source README's for both builds alike, so it was A/B'd with the same tool on an idle machine:

  | `pnpm feel` frame pacing, 2026-10-29 | median | 95th percentile | 99th percentile | longest | frames over 33 ms |
  |---|---:|---:|---:|---:|---:|
  | this app | 15.1 ms | 23.7 ms | 31.4 ms | 36.9 ms | 1 of 779 |
  | the destruction repo's sandbox | 15.4 ms | 23.5 ms | 31.5 ms | 39.4 ms | 3 of 735 |

  (An earlier run of this app, right after the clip, read 15.6 / 31.4 / 39 / 46.5 ms with 15 frames over 33 ms.)

## Results in the destruction repo (2026-10-29)

**Tests** (the destruction repo's `pnpm test`, 44 passing):
- **Statics:** a column's ground contact carries exactly its weight, and a cantilever root carries the textbook shear and moment.
- **The test building:** it is at rest at its baseline, survives a rocket, and collapses without its supports.
- **The kept factor:** cascades on the test building and the arena (standing loads too) break exactly what an always-refactor solver breaks, step for step, with no downdate needing a rescue. Rank-6 downdates match a fresh factor, in WebAssembly and in JS; an indefinite one is refused. Loads-only steps reuse the factor, and the break cap spares the rest for later.
- **Local solves** (now opt-in): they match the full solve to within 0.1 of the break offset, and every cascade ends with a full solve.
- **Loads:** blast and standing loads both break things.
- **Hinges (real Rapier):** a loose chunk hangs from its broken edge, and a weak hinge tires and drops it. A link dropped over the link budget is dropped once, so the bodies it shared still count as held.
- **Step guard (real Rapier):** a chunk a bad step throws at 200 m/s is put back where it was. Thrown three steps running, its hinge lets go and it falls like anything else.
- **Sleeping debris (real Rapier):** a chunk asleep on something wakes and falls when that is destroyed.
- **Landing debris (real Rapier):** a chunk dropped 3 m is heard landing once, at the speed it fell, and is silent at rest.
- **Shattering (real Rapier):** a 36-chunk slab dropped 5 m breaks into clusters (not 36 bodies), and every chunk stays in exactly one place. Taking one chunk out of a body leaves the same body holding the rest.
- **Smoke:** it stays inside a sealed room, pours out once a wall is knocked down, and fills B's ground floor in about a second.
- **Rebar:** a broken contact grows stubs both ways out of its patch, inside the wall's thickness, once; they ride on their chunk and go with it.
- **Sounds:** every take the sandbox plays is in `public/sfx`, and nothing else is.

**Solver** (`pnpm bench`, Node 22, Ryzen 7 3700X; medians of three runs, full tables in `tools/benchmarks/solver-results.md`). Before → now is the old solver (region steps, closing full solve) against this one in the same process:

| building | chunks | full factor | loads-only step | step with 1–2 breaks | step at the cap (16 breaks) | worst cascade step | whole cascade |
|---|---:|---:|---:|---:|---:|---:|---:|
| 5 storeys 20×12 m | 2,028 | 107 → 52 ms | 7.6 → 1.1 ms | 2.4 ms | 12 ms | 178 → 37 ms | 1.9 → 0.2 s |
| 8 storeys 24×16 m | 4,230 | 630 → 197 ms | 9.6 → 3.4 ms | 8.3 ms (worst 21) | 31 ms (worst 51) | 755 → 76 ms | 6.6 → 0.56 s |
| 12 storeys 24×16 m | 6,346 | 1,095 → 425 ms | 6.4 → 5.5 ms | 10 ms (worst 20) | 31 ms (worst 53) | 1,289 → 58 ms | 20.7 → 0.52 s |

The cascade is the bench's "wall" (most of one long wall's ground storey taken out). The old loads-only and cascade steps were region solves, approximate until the closing full solve; every step now is exact.
- **Exact:** in all 16 bench cascades (four scenarios, four buildings), the solver breaks the same contacts and drops the same islands, step for step, as one that refactors whenever the matrix changes. Utilization stays within 1e-4 of it (the break offset is 1), and the relative residual stays under 1e-6, the reference's own level on a building about to fall.
- **Where the time goes:** one contact's rank-6 downdate costs about 10M multiply-adds at 4,230 chunks (2.2 ms), so a step at the cap stays well inside the 83 ms cascade cadence. A rocket's removal downdates its cut contacts (24 ms at 4,230 chunks, 39–53 ms at 6,346), unless a refactor would be cheaper.
- **The worst small steps** (18–21 ms) come right after the reference's 200 ms refactor in the interleaved bench, with the factor out of cache; run alone they take 6–13 ms. The first two downdates of a session run about 1.5× slower while V8 compiles the kernels.
- **Rebuilding:** `StrainSolver.idle()` rebuilds the factor from scratch (197 ms at 4,230 chunks, 25 ms once most of the building is down), for a host with nothing queued. Without it, the residual check refines or refactors if rounding ever builds up.

**Sandbox, real time** (`pnpm capture`, headless Chromium, WebGPU, RTX 4070 idle; the arena with all layers on, the bridge cut and building A's ground storey taken out at once):

| moment | fps | main-thread frame | physics |
|---|---:|---:|---:|
| idle | 129 | 4.1 ms | — |
| worst of the collapse (360 bodies) | ≥ 98 | ≤ 9.4 ms | ≤ 7.1 ms |

Strain runs in a worker, off the main thread: about 3–12 ms for a region step and 50–70 ms for a full solve of the arena.

**Feel** (`pnpm feel`, real time, real input only):
- **Click to blast:** the explosion's visuals and its boom start on the next frame after a left click (0–7 ms).
- **Right-drag look:** responds within a frame.
- **Frame pacing:** measured through a bout of play (bridge cut, four rockets, a charge, smoke, a full building collapse).

| median | 95th percentile | 99th percentile | frames over 33 ms | longest |
|---:|---:|---:|---:|---:|
| 8.0 ms | 16.1–16.4 ms | 23–24 ms | 1–2 of about 1,000 | 38–40 ms (the moment the building comes down) |

The collapse used to cost a 54 ms frame. A profile of the 2.5 s after it showed Rapier's step at 43% and the hinge bookkeeping at 8%. Three changes brought the worst frame to about 38 ms, as ranges over three runs each:
- **Detach queue:** what Strain cuts loose becomes bodies at up to 90 chunks a step instead of all at once. With it off, the worst frames were 38–55 ms.
- **Regroup only on change:** hinges regroup only when a chunk changes body, not every step.
- **Fewer Rapier reads:** the wear pass reads each body's pose and mass once per step and caches body type on the link.

The hinge share is now 4%, and what remains is Rapier's own step. Runs on a busy machine are worse for every build alike: a few were thrown out after an interleaved A/B showed the same spikes with and without a change.

A second pass timed each frame of the collapse section by section (a fixed-clock probe stepping `A-ground` one frame at a time). The worst frames were not Rapier: they were a slab hitting the ground and shattering into 190 single-chunk bodies in one step (8 ms making bodies and colliders, then 360 awake bodies for Rapier to step), and the hinge regroup walking every hinge on every change. Four changes:
- **Shatter into clusters:** a body that lands hard breaks into the chunks sharing a 2 m cell of its rest pose, not every chunk on its own. The biggest cluster stays in the body; the others break out over the next steps, 64 colliders a step at most. Only the leaving chunks' colliders move: the body keeps the rest instead of being rebuilt (that also stops a rifle pop rebuilding a 90-chunk body).
- **Massless fixed colliders:** Rapier re-sums a body's mass over all its colliders whenever one comes or goes. On the building (1,800 hulls) that added about 2 ms to the next step every time chunks came off it. The building and rubble colliders now have density 0.
- **Incremental regroup:** the debris world reports which chunks changed body, and only their hinges and the links they touched are redone.
- **Centres of mass, not frames:** a body that lost chunks keeps its frame, whose origin can be metres from what is left of it. Sink checks, blasts, landing sounds and hinge anchoring now read the centre of mass (`worldCom()` then, `physics.bodies.centerOfMass` now); a cluster gets its own frame at its centre of mass.

| `A-ground`, 240 fixed-clock frames, interleaved runs | worst frame | all frames | Rapier |
|---|---:|---:|---:|
| before | 34–42 ms | 2,440–2,610 ms | 1,035–1,170 ms |
| after | 20–21 ms | 2,190–2,250 ms | 760–820 ms |

**The tower** (`pnpm tower`; `?tower=0` leaves it out): eight storeys, 1,574 chunks, 3,369 in the scene. Taking its ground storey out (`T-ground`, all but a corner) brings the whole tower down within half a second of solving. In real time, with the solve in the worker: median frame 12.1 ms, p95 18.2, p99 30.3, longest 42.5, five frames over 33 ms. It has been in the scene by default since the chunks became one draw: as a `BatchedMesh`, every chunk was a draw call of its own on WebGPU, and the tower took the sandbox from 5,400 draws a frame to 10,100 (now 43 either way): 14 frames over 33 ms while the left building came down, where there had been 0–2. Standing, it now costs nothing measurable; a collapse elsewhere costs a little more with it in (the solve is twice the size), less than this machine's run-to-run noise. It first stood back up as a writhing jointed frame: its elements, hinged to each other like any big island's, made a net of hundreds of bodies whose links each count only a neighbour's weight, and that net fought its own contacts where the tower had been. Islands over `looseIsland` (1,000 chunks) now fall as loose elements, a body that shatters lets go of its links (the impact snaps the steel too), and rubble is held only by chunks that are really lower than it, not by a body's frame.

The collapse heaps differently: walls fold down in large panels instead of hanging as chunk nets that spray single chunks forward.

**Soak** (`pnpm soak`): 90 s of real-mouse play (about 170 shots at random spots, weapon swaps, camera moves, four structural cuts), two seeds.

| | seed 3 | seed 11 |
|---|---:|---:|
| fps, 5th percentile | 54 | 69 |
| fps, median | 113 | 116 |
| fps, minimum | 37 | 33 |
| worst main-thread frame | 26.2 ms | 29.7 ms |
| throws the guard caught | 16 | 54 |

- **Spread:** these are wall-clock runs on a shared machine. Seed 3's 5th percentile ranged from 46 to 89 fps over six runs in one day. Seed 11's ranged from 36 to 69 over three runs of the final build; the 36, under the soak's floor of 40, came with the machine busy, and a capture right after it was normal.
- **Correctness:** no non-finite bodies, no sampled speed past the guard, nothing through the floor (every body that goes below it is now recorded), and every budget held (360 loose bodies, 260 hinge links, 4 clouds).
- **Memory:** the live heap after forced collection grows 24–28 MB over a session, which is the persistent rubble and hinge records.
- **At rest:** 6 s after the shooting stops, 51–68 bodies are still loose (nets and hanging pieces, which are meant to keep swaying) and physics takes 1.4–1.9 ms.
- **Thrown chunks:** the soak now counts every throw, not only the ones a half-second sample happened to see. That turned up chunks thrown 30–270 m/s:
  - one trapped chunk thrown on 2,109 steps in a row;
  - newly shattered chunks fighting the hinge nets that held them;
  - one chunk through the ground.

  The commit before the guard had the same fault (one soak caught a chunk at 88 m/s). The step guard fixed it. The soak fails on any sampled speed over the guard's 32 m/s, and on any body through the floor.
- **Before the fix:** the first soak ran at a 5th percentile of 30 fps, because heaps and hinge nets never met Rapier's sleep thresholds and stayed simulated. Debris now settles on its own stillness test, and over budget the stillest bodies are settled, not deleted.
- **Later:** after hinged nets, gravel and richer effects went in, a busy collapse made one Rapier step cost about 16 ms. The loop then ran up to five catch-up steps per frame and dropped to 13 fps. Three changes fixed it:
  - at most two physics steps per frame, so overload shows as a brief slow-down instead of a frame-rate collapse;
  - a 360-body budget;
  - a bounded rubble re-check.

  Cutting the solver to Rapier's default 4 iterations made joints unstable (a 269 ms step), and turning CCD off for single chunks let blasted chunks reach 42 m/s. Both were tried and reverted.
- These are deliberately brutal sessions (a shot every half second for a minute and a half). The median stays over 100 fps.

## What this round settled

- **Gradual destruction needs assembly-level loads.** Sharing each body's weight among all of its links let a building hang from one corner, frozen in mid-air. Loading only the links to fixed structure fixed that, and the weakest link now gives first.
- **Hinges pivot on an edge.** Anchoring at the edge of the contact, toward the hanging mass and down, stops a swinging deck from grinding into the wall it came from. Shrinking loose chunks' collision hulls by 3% stops broken neighbours from starting out pressed together. Together they took out the energy explosions (chunks flung 20 m up).
- **Region solves make big buildings practical** for local damage (12–15 ms a step). The closing full solve keeps them honest. (Since replaced by exact downdates; see below.)
- **A fallen piece should hang by one contact, not float on ghost springs.** Exact downdates need every piece cut loose to stay positive definite once its last link comes out. The plan was a ghost spring to the ground on every node (1e-9 of the median stiffness), and it caused two problems:
  - It moved a cantilever root's shear by 3e-7 of itself.
  - Each piece that fell drove a pivot down to about √ε, and the rotation there scaled rounding up about 30,000×. The residual climbed from 1e-12 to 8e-9 in 20 steps. A ghost 1,000× stiffer slowed the climb 30× but moved utilization by 4e-3.

  The fix: a free body hanging off a single contact adds no stiffness to what it hangs from. So each fallen piece now keeps exactly one link, or none if it still touches the ground. The standing structure solves exactly, no pivot gets small, and a piece's last link costs no downdate at all. The residual growth left over belonged to the structure: a fresh factor shows the same on a building about to fall. So refinement is triggered by the scale-free backward error, not the residual.
- **A clamp before the step is not a safety net.** Velocities were clamped to 24 m/s before each step, but a step that threw a chunk at 120 m/s still moved it 2 m before the clamp saw it, and a trapped chunk was thrown again on every step. The guard undoes the step for that body, both before the next step and before drawing.
- **Don't trust Rapier 0.20's per-body joint walk.** `forEachJointHandleAttachedToRigidBody` disagreed with a direct count of the joints on 30–100 bodies at a time in a busy scene, which made bodies look roped when they weren't. Joints are now counted from the joints themselves, and the guard no longer asks whether a trapped body has joints: it always has its hinges let go first.
- **Hanging pieces never sleep, and making them sleep was worse.** Pressed against the wall it broke from, a hanging chunk hums at a few cm/s in place: the hinge pulls it in and the contact pushes it out, so Rapier's velocity test never passes. Putting hanging bodies to sleep once they stopped moving brought physics at rest from about 3 ms to 1.2 ms in one probe. But it tripled hinge tears in the capture (285 against 82–85): a body asleep is frozen, and the nets it was part of tore against it. Reverted. Putting free bodies to sleep the same way also let rubble settle into them unanswered (one went through the floor).
- **Test rigs must run the scene's solver settings.** At Rapier's default 4 iterations the test rig's hanging chunk shook several cm a second and never settled. At the scene's 6 it went still, which changed whether it could settle into rubble. The rig now uses 6 and the scene's rule that nothing a hinge holds settles.
- **Count every event, not a sample.** The soak sampled speeds every half second and saw one 88 m/s chunk in one run. Counting every throw found thousands in a bad run, and the details on each (where the body came from, how old it was, its joints) pointed straight at hinge nets on fresh shards. The same details showed bodies with joints reporting no hinges. The cause was a link over the budget being dropped twice, so its bodies' link counts went to zero while their other links still held.
- **Spark's `burstAt` moves the emitter**, so all of a frame's bursts on one emitter spawn at its last position. Effects use small round-robin emitter pools.
- **An independent visual review earned its keep.** A fresh reviewer, given only the frames and the Season 12 list, found:
  - chunks floating in mid-air: rubble that settled on a roof stayed put after the roof fell;
  - loose chunks drawn larger than their collision hulls, so neighbours looked sunk into each other;
  - hinge "rebar" lines that read as rendering artifacts;
  - structures holding rigid and then dropping all at once;
  - a container that never visibly swung;
  - bubbly dust, paper-white smoke in windows, and no small rubble.

  Each one was fixed, and the floating rubble got a regression test.
- **Read input per rendered frame, not per fixed step.** Spark's presses and mouse deltas last one frame, and at 120+ fps half the frames have no fixed step. `pnpm check:input` presses keys two frames apart and checks every press lands.
- **Measure synthesized sounds.** The layered boom and crack summed past full scale (peaks of 1.46 and 1.41) and the creak came out nearly silent (peak 0.14). Every take is now normalized to a 0.85 peak, and loudness is set per sound.
- **Check each sound against the signature of what it's meant to be** (`pnpm check:sounds`):
  - the boom: a fast attack, a long rolling decay, low-heavy, darkening as it fades;
  - the crack: a sharp, bright, short attack;
  - the crumble: many separate impacts;
  - the creak: a pitched, stuttering groan around 60 Hz;
  - the thud: short and dull.

  The check found the boom ending in a rising hiss rather than a rumble: one 12 dB-per-octave filter leaked too much high noise at a low cutoff. It also showed the boom was really a short pop, 45 dB down by 0.6 s. Two low-pass stages in series, a held roar and a low rolling rumble fixed both.
- **Measure the mix, not just the sounds.** Each sound was right on its own, but `pnpm clip` now mixes what the game played from the camera's path (`soundtrack.ts`: the engine's panning, falloff, voice caps and limiter). The first mix peaked at −25.5 dBFS. The engine's point-source falloff is full volume at 1 m, which put a blast 20 m away at −26 dB. Each sound now has a reach that matches its size: 14 m for the boom, 6–7 m for the rest. The mix also showed that a building coming down played one crumble and one thud: only shattering made a sound. Landings are heard now, sized by all the mass that came down in the step. That gives 94 thuds and 22 crumbles over the collapse, and the film peaks at −2.8 dBFS (the limiter holds the rocket).
- **Synthesized sounds did not survive a listen.** Greg heard that clip and called the sound horrible (the picture good). The sounds are now ElevenLabs takes, and the takes needed as much checking as the synthesis did:
  - Prompts miss. The first thuds had under 7% of their energy below 200 Hz (a tick, not a thud), the crumbles were hiss above 6 kHz, and the creaks were sub-bass a laptop can't play. The rewritten thud prompt then went all sub (94% below 80 Hz). So a thud is a sub hit plus a mid knock, a creak is a metal creak over a low groan, and a boom gets a crack on its front and debris behind it. `takes.json` holds the layers.
  - Level by loudness, then limit. Capped at a peak, the sharp sounds (boom, crack, thud) came out 5–12 dB under the rest. A 400 ms loudness window also hears a 50 ms impact as quieter than it sounds; the takes are leveled on 100 ms and limited (up to 8 dB) to −1 dBFS.
  - Start a crack at its snap. The loudest snap in a crack take came up to 134 ms after a faint crackle, late against the glue breaking on screen.
  - Read the film's sound log (`clip-sounds.json`), not just its level. It showed a creak exactly every second for ten seconds (a chunk stays near its limit; the gap is now 2–4.5 s and random), a thud every 70 ms through the collapse (a patter of four takes; the collapse now roars with the mass landed in the last half second), rubble nets snapping every 0.25 s (only tears over 20 kN snap now), a container that never clanged (it lands at 3 m/s, spread over two steps), and dead air between events (the air bed).

## Spike shortcuts still standing

- ~~`debris.ts` and `hinges.ts` drive Rapier directly (`physics.raw`).~~ Gone: the engine's handle layer (ADR-010) has convex shapes, compound bodies, ropes and shape queries, and the runtime is an engine subsystem (ADR-011).
- The buildings are procedural; the Blender pipeline (glTF extras for connections) replaces them when there are real assets.
- The sound takes are checked for signature and in-game mix but not yet heard by a person (the synthesized set they replace was). Gas does no damage, since there is no player.
- Broken faces are flat: their relief is shading, not geometry, and soot is one shade per chunk rather than a decal.
