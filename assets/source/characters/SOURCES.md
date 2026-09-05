# Character sources

| file | what | licence | from |
| --- | --- | --- | --- |
| `ual/AnimationLibrary_Godot_Standard.gltf` + `.bin` | Quaternius, Universal Animation Library (standard / free tier): one 1.83 m mannequin on a Rigify DEF- skeleton, 46 clips | CC0 1.0 | https://github.com/J-Ponzo/gltf-universal-animation-library (glTF mirror of https://quaternius.itch.io/universal-animation-library) |
| `operator.glb` | built by `pnpm character:build` from the above: 16 clips renamed to the engine's conventions, dot-free bone names, `spark.*` extras | CC0 1.0 | `tools/asset-pipeline/build-character.mjs` |

Attribution is optional under CC0; listed anyway. The showcase serves the pipeline output as `apps/showcase/public/models/operator.glb`.

Later: Quaternius' Cyberpunk Game Kit character (`SK_Character`, CC0, USD mirror at https://github.com/weftspun/quaternius-stage) is the intended look for the operator and enemies. It ships without animations on a different skeleton, so it needs a Blender retarget from this library's clips (`tools/level-authoring/probe_usd.py` inspects the USD files).
