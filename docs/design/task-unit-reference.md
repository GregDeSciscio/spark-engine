# Task Unit: what the sequel inherits

Source: `E:\Working Files\AI Projects\task-unit` (read 2026-09-04). Task Unit is Greg's browser-based multiplayer tactical third-person shooter, built on Three.js r161, Rapier, Express, and Socket.IO, with an Electron shell and a Steam Early Access packaging path. Its maps are SOCOM 2 recreations (Crossroads, Vigilance, Frostfire) plus Compound and The Crossing. Spark Engine's customer game is its single-player sequel in a darker, bloody, cyberpunk setting (ADR-005).

## Rule for using it

Task Unit is a **design and data reference, not a code dependency.** Port the designs, schemas, tuning numbers, and lessons. Rewrite any code that is bad or fights the engine rather than forcing reuse. In practice that means most of it: it is a Three.js r161 codebase with a server-authoritative split and an HTML-overlay HUD, and none of those shapes match the engine (WebGPU renderer, bitecs entities, local deterministic simulation).

Worth porting as data or design:

- The weapon identity framework in `docs/weapon-system-design.md`: three strengths and one defining weakness per gun, identity through cadence, recoil shape, effective range, handling, and presentation. The `shared/weapons.js` schema (fire mode, rpm, mag, reload, damage bands with falloff, stance and movement accuracy) is a good starting shape.
- Map bundle format: `config.json`, `gameplay.json` (spawns, objectives, strategic positions, mantle zones, patrol waypoints), `collision.json`, `render.glb`, authored in Blender. This aligns with ADR-008, and the validation tools (`validate-map`, spawn and sightline gates) are worth re-deriving.
- Tuning constants: move 5 u/s, sprint 1.6x, player 0.4 radius by 1.8 tall, gravity -20, rifle 25 dmg at 600 rpm to 100 units, 20 Hz sim tick.
- Lighting lessons from the 2026-07-13 visual pass: keep environment intensity below the sun, keep map albedos in the same band as characters, size the shadow camera to the map.

## Core loop

- **Mode:** Demolition is the headline. Attackers carry and plant a bomb at one of two sites, defenders stop them. Suppression (team elimination) and FFA exist as secondary modes; escort was stubbed.
- **Factions:** SEALs versus Terrorists, small teams, bots fill empty slots.
- **Match flow:** lobby and rooms, warmup, rounds with respawn timers, kill feed, ranks as lightweight identity.
- **Loadouts:** Assault, Marksman, Breacher, Battle Rifle, Burst, Sniper. Weapon classes: two assault rifles, battle rifle, DMR, SMG, shotgun, sniper rifle, and the MK23 SD pistol as the shared sidearm. Equipment: frag, smoke, claymore. Hit zones: head, torso, legs.
- **Bots:** finite state machine (patrol, detect, engage, search, dead) over a baked nav graph with authored patrol waypoints. Bots understand weapon role, burst length, and range preference.

## Movement and camera

- Stances: stand, crouch, prone, plus a prone dive. Sprint, jump, mantle over authored mantle zones, ladders with push-off.
- Aim-down-sights with per-weapon FOV and a scope overlay. Aim obstruction indicator when the barrel is blocked by cover the camera can see over.
- Camera: **close third-person over the shoulder.** Focus point at shoulder height (72 percent of player height, scales with stance), orbit yaw and pitch clamped to -80 to +60 degrees, collision pull-in against geometry, ADS pulls the camera in and lowers sensitivity. Death cam fly-over and a 2.6 s spawn fly-in crane shot.

## Presentation

- Current look: bright, clean, "sunlit toy diorama". Warm high sun, cool sky, exposure lifted, stylized procedural surface treatment (tonal noise patches, grime band, sun bleach). The sequel goes the other way: dark, wet, neon, bloody.
- Effects already in the game: muzzle flash, tracers, hit sparks, shell casings, instanced GPU impact decals, breakable windows, damage vignette, screen shake, radial blur, speed lines, slow motion, outlines for teammates, wind foliage and bush rustle, bird flocks, emissive pulse, SSAO, bloom, KTX2 compressed textures.
- Audio: impulse-response reverb, normalized asset pipeline, rate-limited clustered impact sounds.

## What single-player changes

- Bots stop being filler and become the entire opposition. AI quality (perception, cover use, squad behavior, weapon role play) is the game's biggest system and needs an engine-level nav and behavior layer, not a 20 Hz server FSM.
- The server-authoritative loop collapses into the engine's local fixed-step simulation. Keep determinism (ADR-005) but drop reconciliation, snapshots, and lobbies.
- Demolition as a symmetric PvP mode does not survive unchanged. The sequel needs an objective structure that works with one player and AI squadmates or none. That is the main open design question.
- The over-the-shoulder camera means longer sightlines than isometric: rifle range 100 units, fog far plane around 120. ADR-004's "bounded draw distance" assumption should be re-checked against that.
