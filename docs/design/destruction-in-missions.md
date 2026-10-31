# Destruction in the Task Unit sequel's missions

Accepted 2026-10-31: Greg took the four recommendations below. The engine's destruction subsystem is ready for a game (`docs/design/destruction-game-readiness.md`), and Greg chose the Task Unit sequel (ADR-005) to be that game. Its mission shape (`docs/design/mission-shape.md`) has no structural destruction: its "demolition" is a bomb-plant objective. This says where destruction fits, and what the first mission to use it should prove.

## The idea

**Destruction is how the operator makes his own approach.** The mission shape asks for two or three approaches per objective, and the street has them as authored lanes: the road, the service alley, the overwatch. Destruction adds the approach the player makes himself: a wall breached into the depot, a shed blown open for a line of sight, a catwalk dropped under a guard. It is a tactical tool with a price, not a sandbox: a breach is loud, and loud changes the mission.

## What is destructible

- **Designated soft structures, a few per mission.** Two to four per level: partition walls, sheds and lean-tos, a depot's facade, catwalks and stairs, barricades. Each is authored in Blender as `spark.type = destructible` boxes, so the level designer decides where the player can make a way and where he cannot.
- **Landmark buildings stay solid.** The street's tall facades frame the level and carry its look. Bringing them down would remove the level's readability and cost far more than a mission needs. They stay static geometry.
- **Budget:** at most about 2,000 chunks of destructible structure per mission (the slice's yard is 1,342), and the debris budget follows the quality preset (`debrisBudget`).

## How the player uses it

| Tool | What it does | Task Unit ancestor |
| --- | --- | --- |
| Breach charge | Placed on a wall (hold interact, short fuse): blows a person-sized hole and opens a lane. Bots learn it at once: the navmesh rebuilds where it changed. | Breacher loadout |
| Grenades | Frag and smoke. A frag chips cover; smoke takes the shape of the rooms (`Destruction.smoke`). | Task Unit's grenades |
| Gunfire | Bullets chip chunks (`damage`, three hits pop one): cover wears down in a firefight, on both sides. | — |
| The objective charge | The Plant objective's charge brings down what it is planted on: the depot's facade, not just a fireball. | Demolition bomb plant |

## How the mission answers

- **Noise.** A breach or a collapse is the loudest thing in a mission. It raises awareness around it like gunfire, at a larger radius, and a collapse in Quiet can tip the sector to Alerted. A silent route stays possible; a loud shortcut costs the stealth run.
- **Bots use what changed.** The navmesh follows the damage (`Navigation.tiled`, `reshape`), so a hole the player made is a hole hostiles come through. Searching hostiles check the breach.
- **Debris is dangerous.** What falls on a character hurts it (`hit`, by momentum): a dropped catwalk can take out the guard under it, and a careless breach can take out the player.
- **Checkpoints keep it.** A reload brings back every structure as it was at the checkpoint (`save`, `restore`).

## The first mission to use it: the street

Milestone 10's street mission is the place to prove it, because its objectives and lanes are already tested:
1. **The depot's facade is destructible**, and the Plant objective's charge brings it down instead of only playing a fireball (`combat/demolition.ts`).
2. **One breachable wall** between the service alley and the square: a fourth approach the player makes.
3. **Probes** for each: a breach opens a path bots then take, a breach raises the alert, the planted charge brings the facade down, and a checkpoint reload restores it.

## What the engine still needs

- **Chunks take their building's surfaces: built 2026-10-31.** A box's `spark.surface`, or its Blender material name as the surface library reads it (`brick.facade` is brick), picks what its chunks' painted faces wear: `brick`, `concrete` or `metal` (with the material's colour). The surface is sampled where each face was built, so the courses ride on a falling chunk. Broken faces stay raw concrete. The yard's depot is brick, its tower concrete and its shed painted metal. Each surface is one more draw a pass for its building. Tests: `ChunkFinish.test.ts`.
- **Sight through smoke** (decision below): perception raycasts ignore smoke today. `Destruction.densityAt` can make smoke block a hostile's sight if that is wanted.

## Decisions (Greg, 2026-10-31)

1. **Breach charges: a loadout, or pickups?** The Breacher loadout carries two, and missions can place more.
2. **Bringing down whole buildings: never in v1?** Never; only designated soft structures.
3. **Does smoke block hostiles' sight?** Yes, through `densityAt` on their line of sight: smoke becomes a stealth tool, as it is in Task Unit.
4. **A collapse that kills a hostile: a kill like any other?** Yes, and quiet if nobody sees it fall.
