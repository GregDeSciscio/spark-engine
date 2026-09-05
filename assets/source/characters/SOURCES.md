# Character sources

| file | what | licence | from |
| --- | --- | --- | --- |
| `ual/AnimationLibrary_Godot_Standard.gltf` + `.bin` | Quaternius, Universal Animation Library (standard / free tier): one 1.83 m mannequin on a Rigify DEF- skeleton, 46 clips | CC0 1.0 | https://github.com/J-Ponzo/gltf-universal-animation-library (glTF mirror of https://quaternius.itch.io/universal-animation-library) |
| `cyberpunk/SK_Character.usda` | Quaternius, Cyberpunk Game Kit: the player character, 1.37 m, 34 bones, no animations | CC0 1.0 | https://github.com/weftspun/quaternius-stage (USD mirror of https://quaternius.com) |
| `cyberpunk/retargeted/<Clip>.glb` | the kit character scaled to 1.8 m with one library clip per file, retargeted onto its skeleton by `tools/level-authoring/character.py` (Blender, headless; one file per clip because Blender 5.1's multi-action export modes flatten baked actions); the kit's sword mesh dropped | CC0 1.0 | `pnpm character:retarget` |
| `operator.glb` | the retargeted character with clips renamed to the engine's conventions and `spark.*` extras; the showcase serves the pipeline output as `apps/showcase/public/models/operator.glb` | CC0 1.0 | `pnpm character:build` |
| `operator.character.json` | the build config: clip renames, `spark.*` extras, and the retarget section (library, target, bone map, hips, foot reparenting, footstep clips) that `character.py` runs from | n/a | ours |

Attribution is optional under CC0; listed anyway.
