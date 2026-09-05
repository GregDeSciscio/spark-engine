# Mission sound design

The customer game's soundscape (ADR-005): a lone operator on a wet neon
street at night. The brief is that the audio carries as much detail as the
picture. Every cue below is data in `tools/audio/manifest.mjs`; the game reads
the built manifest at scene load (`apps/showcase/src/audio/MissionAudio.ts`)
and plays one verb per moment. Missing takes are silent no-ops that the
console lists once, so the game runs identically before and after the assets
exist.

## Pipeline

```
tools/audio/manifest.mjs      the design: prompts, lengths, loops, variants, buses, gains, spatial roles
pnpm audio:generate           ElevenLabs text-to-sound-effects (and text-to-speech for barks) → assets/source/audio/raw/<cue>-NN.mp3
pnpm audio:build              ffmpeg: trim, mono/stereo, LUFS normalise, loop seams, comms filter → apps/showcase/public/audio/<cue>-NN.ogg + manifest.json
```

- **Credentials.** `ELEVENLABS_API_KEY` in the environment or in `.env` at the
  repo root (git-ignored). Optional `ELEVENLABS_VOICE_ID` pins the bark voice;
  otherwise the account's voices are searched for a deep, rough male.
- **Cost.** `pnpm audio:generate --dry-run` prints the plan and a credit
  estimate before anything is spent. The full set is 113 takes, roughly
  19k credits at the published sound-effects rate. `--only=<cue>` and
  `--kind=voice` narrow a run; existing takes are never regenerated without
  `--force`.
- **Round robin.** Variants are separate takes of the same prompt; the engine
  now takes `urls: [...]` on a sound definition and never plays the same
  variant twice in a row.
- **Loudness.** Takes are normalised to a LUFS target per bus (sfx −18, ui
  −20, ambience −26, voice −19), so the manifest's `volume` values are mix
  decisions rather than corrections for how loud a take came out.
- **Loops.** Requested with the API's loop flag and still given a 0.35 s
  crossfaded seam in the build, because "seamless" from a generator is a hope.

## Mix rules

- The rifle is the loudest thing in the game. Nothing on the sfx bus sits
  above `rifle-shot` at 0.9; interface cues stay under 0.7.
- Everything spatial is mono and dry. The engine's panner and distance model
  are the room; a baked reverb tail would follow the listener around.
- Beds are wide stereo and quiet (−26 LUFS, 0.45 to 0.7). The level should be
  heard through them, not under them.
- Two ambient layers at most are ever competing with a gunfight: rain and
  city. Neon and steam emitters are capped at six voices, the nearest six.
- Voice lines go through a helmet-comms band-pass (300 Hz to 3.4 kHz, light
  compression) so they read as radio chatter from the gang, not narration.

## Cues

Spatial roles (`MissionAudio.ts`): **gun** ref 4 m / max 90 m, **gunFar** ref
20 m / max 200 m, **body** ref 2.5 m / max 45 m, **foot** ref 2 m / max 30 m,
**voice** ref 4 m / max 60 m, **emitter** ref 1.8 m / max 24 m.

### Weapons

| Cue | Takes | Trigger | Role | Notes |
| --- | --- | --- | --- | --- |
| `rifle-shot` | 4 | every operator shot, at the operator; enemy shots by distance | gun | suppressed crack with the action click; ±1.2 st |
| `rifle-tail` | 3 | with every operator shot, flat stereo | n/a | the street's slapback, 0.5 under the shot |
| `rifle-distant` | 3 | enemy shots, gain rising from 8 m to 40 m as `rifle-shot` fades from 14 m to 55 m | gunFar | the far layer of the same gun |
| `rifle-reload` | 2 | reload start, operator (1.0) and enemies (0.7) | body | 2.5 s to match `reloadTime` |
| `rifle-empty` | 2 | trigger pulled with nothing to load | flat | |
| `aim-in` | 3 | aim raised (1.0) / lowered (0.7, pitch 0.9) | flat | gear rustle, stock tap |
| `casing` | 4 | 0.22–0.34 s after each operator shot, at the feet | foot | brass on wet concrete |

### Impacts and bodies

| Cue | Takes | Trigger | Role | Notes |
| --- | --- | --- | --- | --- |
| `impact-concrete` `impact-metal` `impact-glass` `impact-water` | 4/4/3/3 | a round striking level geometry; the surface comes from the material name (metal, pipe, shutter, bollard → metal; window, neon → glass; ground hits under 8 cm → water) | body | |
| `impact-flesh` / `impact-head` | 4/3 | a round hitting a body, by hit zone | body | followed 50 ms later by `blood-splatter` |
| `blood-splatter` | 3 | with every body hit | body | 0.7, 1.0 on a headshot |
| `whiz` | 3 | an enemy round passing within 2 m of the operator's head | ref 1 m / max 6 m | placed at the point of closest approach |
| `body-fall` | 3 | 0.55 s after a kill, at the corpse | body | the ragdoll reaches the ground about then |

### Movement

Footsteps are animation markers baked into the character clips by the
retarget (`character.py` records the frame each foot comes down; the build
writes them as `spark.events`). `MissionAudio.bindFootsteps` routes every
marker in the level by clip.

| Cue | Takes | Trigger | Role | Notes |
| --- | --- | --- | --- | --- |
| `footstep-walk` | 6 | `walk` markers (1.0), `crouch_walk` markers (0.5, pitch 0.95) | foot | enemies at 0.85 |
| `footstep-run` | 6 | `run` markers (1.0), `sprint` markers (1.2, pitch 1.05) | foot | |
| `land` | 3 | the operator grounding after 0.12 s or more of air | foot | |
| `gear-rustle` | 4 | stance changes | foot | |

### The operator

| Cue | Takes | Trigger | Notes |
| --- | --- | --- | --- |
| `hurt` | 4 | damage taken | 250 ms cooldown, one at a time |
| `death-player` | 1 | health reaches zero | `ui-failed` follows 0.9 s later |
| `heartbeat` | loop | health under 35 percent | gain and pitch follow how far under; stops on respawn |

### Enemies (voice)

Text-to-speech through the comms filter. Groups pick a random line among
their siblings; cooldowns keep three alert gangers from talking over each
other.

| Group | Lines | Trigger |
| --- | --- | --- |
| suspicious | "Huh? ... Who's there?", "Did you hear that?" | unaware → suspicious |
| alert | "Contact! Contact!", "There! Light him up!", "We got a runner! Take him down!" | going alert |
| search | "Lost him. Spread out.", "Where did he go? Check the alley." | alert → searching |
| reload | "Reloading! Cover me!" | reload start (with `rifle-reload` at 0.7) |
| hit | "Argh!" ×2 | damage taken |
| death | "Aaagh... no..." ×2 | the killing shot |

### Ambience

| Cue | Takes | Trigger | Notes |
| --- | --- | --- | --- |
| `rain-bed` | 22 s loop | scene start, 2.5 s fade | wide stereo, −24 LUFS |
| `city-bed` | 22 s loop | scene start | traffic, sirens, hover drone; −28 LUFS |
| `neon-buzz` | 2 loops | one voice per neon light, nearest six | emitter; pitch 0.94–1.06 per light |
| `steam-hiss` | 2 loops | one voice per authored steam vent | emitter |
| `drip` | 5 | every 0.7–2.4 s, 2–9 m from the listener at ground level | ref 2 m / max 18 m |
| `thunder` | 3 | every 28–70 s, flat | −22 LUFS |
| `drone-pass` | 2 | every 45–110 s, flat stereo pass | |

### Interface and objectives

| Cue | Trigger |
| --- | --- |
| `ui-hitmarker` / `ui-headshot` | a round lands on a body |
| `ui-alert` | the first hostile going alert (4 s cooldown) |
| `ui-plant-loop` | held while setting the charge; pitch rises with progress |
| `ui-plant-done` | the charge set |
| `ui-objective` | any objective complete (0.6 s after `ui-plant-done`) |
| `ui-checkpoint` | 1.1 s after an objective, the save |
| `ui-complete` | the last objective, 1.6 s later |
| `ui-failed` | operator death |

## Not done yet

- **Music.** ElevenLabs has a music endpoint; the engine's `MusicPlayer` takes
  a base and an intensity stem. An explore / combat pair driven by the
  awareness ladder is the next step once the SFX are heard.
- **Occlusion.** Enemy fire behind cover should be duller. A one-ray
  line-of-sight check to the listener with a low-pass on the voice is the
  cheap version; it needs a per-voice filter on the engine's `LiveVoice`.
- **Bark variety.** Two to three lines per group is enough for a slice, not a
  campaign; the generate script takes more lines as more manifest rows.
- **Ragdoll contacts.** Ragdoll bodies do not emit contact events; the fall
  is timed. Enabling events on the hips part would make it physical.
