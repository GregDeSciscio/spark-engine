# Audio sources

Every take in `raw/` was generated on 2026-09-05 with ElevenLabs through the ElevenLabs Creative connector, from the prompts in `apps/showcase/audio/manifest.mjs`:

- sound effects: `eleven_text_to_sound_v2` (duration, loop and prompt-influence per cue)
- enemy voice barks: `eleven_v3` text-to-speech, voice "Libra - Deep, intense, masculine, bold" (`J5naoTdVne3DTIdEVUyF`), with inline delivery tags

The canvas that holds the generations, with node ids per cue, is recorded in `apps/showcase/audio/elevenlabs-flow.json`. `pnpm audio:build` masters `raw/` into `apps/showcase/public/audio/` (see `docs/audio/mission-sound-design.md`). Usage rights follow the ElevenLabs plan the account generated them under; the prompts and the design are ours.
