# Audio cue sheet

The engine ships **procedurally synthesised placeholder SFX** so the audio path
(buses, voice pool, spatial panning, music stems, event bindings) can be
exercised end to end. They are generated at runtime by
`packages/engine/src/audio/placeholders.ts` through an `OfflineAudioContext`,
every name carries the `placeholder-` prefix, and none of them is a score or a
sound design. This sheet is the hand-off: what each cue is for, and how to drop
real assets in.

## Template

| Scene | Cue name | Bus | Mood / character | Length | Loop point | Trigger | Notes |
| ----- | -------- | --- | ---------------- | ------ | ---------- | ------- | ----- |
| `scene` | `cue-name` | music / sfx / ui / ambience | one line of intent | s | seamless / `loopStart`–`loopEnd` / n/a | what fires it (code path) | variance, cooldown, spatial settings |

## `mission` scene (the customer game)

The showcase's cues are designed and generated as data: see
[mission-sound-design.md](mission-sound-design.md) and `apps/showcase/audio/manifest.mjs`.
The game reads the built `apps/showcase/public/audio/manifest.json`; cues without
takes are silent and listed once in the console.

## `hud` scene (Milestone 10 demo)

| Scene | Cue name | Bus | Mood / character | Length | Loop point | Trigger | Notes |
| ----- | -------- | --- | ---------------- | ------ | ---------- | ------- | ----- |
| hud | `placeholder-footstep` | sfx | dry heel tap on concrete; should read as "wet street" once real | 0.18 s | n/a | `footstep` animation marker on every mannequin (`audio.bindAnimationEvents`) | spatial at the entity, ±2 st pitch, ±25 % volume, 90 ms cooldown, max 6 at once |
| hud | `placeholder-impact` | sfx | blunt body hit, low thump + crack | 0.45 s | n/a | player attack `hit` marker landing on a unit; debris `collisionStart` (`bindPhysicsEvents`, min 1.5 m/s) | spatial, ±1.5 st, 40 ms cooldown, max 4; volume scales with contact speed |
| hud | `placeholder-ui-click` | ui | short, clean interface tick | 0.08 s | n/a | Escape menu open / close, menu item click | flat (non-spatial) |
| hud | `placeholder-neon-buzz` | ambience | 120 Hz tube hum with flicker | 2.0 s | seamless (LFO is an integer number of cycles) | started at scene load, attached to the lamp entity (`playAt`) | spatial: inverse, ref 2 m, rolloff 1.4, max 30 m; queued until the context unlocks |
| hud | `placeholder-rain` | ambience | steady rain bed, no drips | 4.0 s | seamless (0.25 s head/tail crossfade) | `audio.ambience.play` at scene load, 2 s fade-in | flat bed; real asset should be stereo and 20–30 s |
| hud | `placeholder-music-base` | music | soft two-chord pad, low-passed | 8.0 s | seamless at 8.0 s (two 4 s chords) | `audio.music.play({ base, layer })` at scene load, 1.5 s fade-in | base stem, always on |
| hud | `placeholder-music-layer` | music | 16th-note arpeggio over the same chords | 8.0 s | seamless at 8.0 s; **must equal the base length** | same call; `music.setIntensity(speed / RUN_SPEED)` every frame | intensity stem, equal-power blend 0..1 |

Bus defaults in the demo: master 1.0, music 0.7, sfx / ui / ambience 1.0. A
limiter (`DynamicsCompressor`, −6 dB threshold, 12:1) sits after master.

## How to replace the placeholders

1. **Drop files in `apps/benchmark/public/audio/`** (or the game app's
   `public/audio/`). Use `.ogg` (Vorbis/Opus) for loops and beds and `.wav` or
   `.ogg` for short one-shots; 48 kHz mono for spatial SFX, stereo for beds
   and music. Keep loops trimmed to the loop length so `loop: true` is
   seamless; if a file has a lead-in, pass `loopStart` / `loopEnd`.
2. **Register in a manifest.** Sounds are declared with `defineSound`; the
   scene keeps its cue list in one array. Replace the `buffer` entry with a
   `url` and keep the name (or rename it and update the binding maps):

   ```ts
   const CUES: SoundDefinition[] = [
     { name: 'footstep', url: '/audio/footstep-wet-01.ogg', bus: 'sfx', volume: 0.5, pitchVariance: 2, volumeVariance: 0.25, cooldownMs: 90, maxInstances: 6 },
     { name: 'rain', url: '/audio/rain-bed.ogg', bus: 'ambience', loop: true },
     { name: 'music-base', url: '/audio/music-explore-base.ogg', bus: 'music', loop: true },
     { name: 'music-layer', url: '/audio/music-explore-layer.ogg', bus: 'music', loop: true },
   ];
   for (const cue of CUES) audio.defineSound(cue);
   audio.bindAnimationEvents(animation, { footstep: 'footstep' });
   audio.music.play({ base: 'music-base', layer: 'music-layer' }, { fadeIn: 1.5 });
   ```

   `url` sounds decode immediately (before the user gesture, through an
   offline decoder) and are cached + reference counted per URL;
   `audio.undefineSound(name)` in the scene's `dispose()` releases them.
3. **Delete the `renderAllPlaceholders()` call** from the scene once every cue
   has a file, and remove the `placeholder-` names from the bindings. Nothing
   else changes: buses, the voice pool, spatial settings and the intensity
   blend are all per-definition, not per-placeholder.
4. **Round-robin variants:** define `footstep-01`, `footstep-02`, … and pick
   with the scene's seeded `random.pick([...])` in the binding `filter` /
   a custom listener; the engine does not auto-roll variants.
5. **Verify** with `pnpm capture --scene=hud --backend=webgpu` (console must be
   clean) and a Playwright probe that clicks the page and reads
   `window.__spark.engine.audio.stats()`: `state === 'running'`,
   `loadedBuffers === <cue count>`, `activeVoices > 0`.

## Adding a cue

Add a row to the scene's table above, declare it with `defineSound`, and wire
its trigger through one of: `audio.play` (flat), `audio.playAt` (spatial),
`audio.bindAnimationEvents` (animation markers), `audio.bindPhysicsEvents`
(contacts / triggers), `audio.music` / `audio.ambience` (beds). Keep cooldowns
on anything a crowd can fire; the voice pool steals oldest per bus but a
cooldown is cheaper than a steal.
