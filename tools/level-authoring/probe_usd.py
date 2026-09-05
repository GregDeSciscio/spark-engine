"""
Inspect USD character files headless: armature bones, actions and their
frame ranges, meshes and materials. Used to plan the Quaternius character
import (tools/level-authoring/character.py).

    blender --background --python tools/level-authoring/probe_usd.py -- <file.usda> [<file.usda> ...]
"""

import sys

import bpy


def probe(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.wm.usd_import(filepath=path, import_skeletons=True, import_blendshapes=True)
    print(f'=== {path}')
    for obj in bpy.data.objects:
        if obj.type == 'ARMATURE':
            bones = [b.name for b in obj.data.bones]
            print(f'armature {obj.name}: {len(bones)} bones')
            roots = [b for b in obj.data.bones if b.parent is None]
            def walk(b, depth):
                if depth < 4:
                    print('  ' * depth + f'- {b.name}  head={tuple(round(v, 3) for v in b.head_local)} len={b.length:.3f}')
                for c in b.children:
                    walk(c, depth + 1)
            for r in roots:
                walk(r, 0)
            print('  all bones:', ', '.join(bones))
        elif obj.type == 'MESH':
            mats = [m.name if m else None for m in obj.data.materials]
            print(f'mesh {obj.name}: {len(obj.data.vertices)} verts, {len(obj.data.polygons)} faces, materials={mats}, vgroups={len(obj.vertex_groups)}, parent={obj.parent.name if obj.parent else None}')
            print(f'  uv layers={[u.name for u in obj.data.uv_layers]} color attrs={[c.name for c in obj.data.color_attributes]} dims={tuple(round(v, 3) for v in obj.dimensions)}')
    print(f'actions: {len(bpy.data.actions)}')
    for a in bpy.data.actions:
        print(f'  action {a.name}: frames {a.frame_range[0]:.0f}-{a.frame_range[1]:.0f} fcurves={len(a.fcurves)}')
    for m in bpy.data.materials:
        tex = []
        if m.use_nodes:
            for n in m.node_tree.nodes:
                if n.type == 'TEX_IMAGE' and n.image:
                    tex.append(n.image.name)
        print(f'  material {m.name}: textures={tex}')
    print(f'scene fps={bpy.context.scene.render.fps} frame_end={bpy.context.scene.frame_end}')


if __name__ == '__main__':
    files = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    for f in files:
        probe(f)
