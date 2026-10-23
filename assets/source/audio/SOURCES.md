# Audio sources

Every take in `raw/` was generated on 2026-09-05 with ElevenLabs through the ElevenLabs Creative connector, from the prompts in `apps/showcase/audio/manifest.mjs`:

- sound effects: `eleven_text_to_sound_v2` (duration, loop and prompt-influence per cue)
- enemy voice barks: `eleven_v3` text-to-speech, voice "Libra - Deep, intense, masculine, bold" (`J5naoTdVne3DTIdEVUyF`), with inline delivery tags

The canvas that holds the generations, with node ids per cue, is recorded in `apps/showcase/audio/elevenlabs-flow.json`. `pnpm audio:build` masters `raw/` into `apps/showcase/public/audio/` (see `docs/audio/mission-sound-design.md`). Usage rights follow the ElevenLabs plan the account generated them under; the prompts and the design are ours.

The Milestone 10 additions (`explosion`, `debris-fall`, `alarm`, `charge-beep`, `bark-defuse`, `bark-defuse-2`, and the long-missing `ui-lockdown`) were generated on 2026-10-23 the same way, on a second canvas recorded under `later` in the same file. The `ELEVENLABS_API_KEY` in `.env` was rejected (401) that day, so `pnpm audio:generate` cannot run until it is replaced; the connector does not need it.
