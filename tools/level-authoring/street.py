"""
Authors the showcase's first level, "street", inside Blender and exports it
the way a human level designer would: a .blend to open and edit, and a GLB
with spark.* custom properties (ADR-008). Run headless:

    blender --background --python tools/level-authoring/street.py -- <out-dir>

Everything gameplay-relevant is a custom property on an object, never a name:

    spark.type=spawn      team=player                  the operator's insertion point
    spark.type=objective  kind/label/radius/hold/order the mission, in `order`
    spark.type=patrol     route/index                  one point of an enemy loop
    spark.type=target     index                        a range dummy
    spark.type=light      color/intensity/range        a neon point light

Collision is a COL_<name> twin of each solid, marked spark.collider=box so
the loader builds a box body from its bounds. Render meshes share one unit
cube per material; the object transform carries the size, so the GLB stays
tiny and the loader's half extents come out of scale.

Engine space is Y-up; Blender is Z-up. The glTF exporter maps Blender
(x, y, z) to glTF (x, z, -y), so an engine position (x, y, z) is authored at
Blender (x, -z, y). Deterministic: the same seed writes the same file.
"""

import math
import os
import random
import sys

import bmesh
import bpy

SEED = 7
STREET_HALF_WIDTH = 9.0
STREET_Z_MIN = -70.0
STREET_Z_MAX = 40.0
SIDEWALK = 2.5
NEON_COLORS = [0xFF2BD6, 0x22E8FF, 0xFF7A1A, 0x4DFF6A, 0xFF3D5A, 0x3D7BFF, 0xFFD23D, 0xB14DFF]


def out_dir():
    if '--' in sys.argv:
        return os.path.abspath(sys.argv[sys.argv.index('--') + 1])
    return os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'assets', 'source', 'levels'))


def to_blender(x, y, z):
    return (x, -z, y)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(value):
    return tuple(srgb_to_linear(((value >> shift) & 0xFF) / 255.0) for shift in (16, 8, 0))


def unit_cube(name):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def material(name, rgb, roughness, metallic=0.0, emission=None, emission_strength=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    if emission is not None:
        bsdf.inputs['Emission Color'].default_value = (*emission, 1.0)
        bsdf.inputs['Emission Strength'].default_value = emission_strength
    return mat


class Level:
    def __init__(self):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.scene = bpy.context.scene
        self.scene.unit_settings.system = 'METRIC'
        self.scene.unit_settings.scale_length = 1.0
        self.render = bpy.data.collections.new('Render')
        self.collision = bpy.data.collections.new('Collision')
        self.gameplay = bpy.data.collections.new('Gameplay')
        for c in (self.render, self.collision, self.gameplay):
            self.scene.collection.children.link(c)
        self.col_mesh = unit_cube('COL_unit_cube')
        self.meshes = {}

    def cube_for(self, mat):
        if mat.name not in self.meshes:
            mesh = unit_cube(f'cube_{mat.name}')
            mesh.materials.append(mat)
            self.meshes[mat.name] = mesh
        return self.meshes[mat.name]

    def box(self, name, x, y, z, hx, hy, hz, mat, collide=True):
        obj = bpy.data.objects.new(name, self.cube_for(mat))
        obj.location = to_blender(x, y, z)
        obj.scale = (2 * hx, 2 * hz, 2 * hy)
        self.render.objects.link(obj)
        if collide:
            col = bpy.data.objects.new(f'COL_{name}', self.col_mesh)
            col.location = obj.location
            col.scale = obj.scale
            col['spark.collider'] = 'box'
            col.display_type = 'WIRE'
            self.collision.objects.link(col)
        return obj

    def empty(self, name, x, y, z, props, display='PLAIN_AXES', size=0.5):
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = display
        obj.empty_display_size = size
        obj.location = to_blender(x, y, z)
        for key, value in props.items():
            obj[f'spark.{key}'] = value
        self.gameplay.objects.link(obj)
        return obj


def build(level: Level):
    rng = random.Random(SEED)
    asphalt = material('asphalt', hex_rgb(0x14161C), 0.32, 0.05)
    sidewalk = material('sidewalk', hex_rgb(0x232630), 0.6, 0.02)
    facade = material('facade', hex_rgb(0x191C26), 0.72, 0.08)
    crate = material('crate', hex_rgb(0x3A3F4A), 0.65, 0.1)
    barrier = material('barrier', hex_rgb(0x4A3A2A), 0.7, 0.05)
    neon_mats = {c: material(f'neon_{c:06x}', hex_rgb(c), 0.4, 0.0, hex_rgb(c), 2.5) for c in NEON_COLORS}

    length = STREET_Z_MAX - STREET_Z_MIN
    z_mid = (STREET_Z_MAX + STREET_Z_MIN) / 2

    # ---- ground: street and raised sidewalks ---------------------------------
    level.box('ground', 0, -0.5, z_mid, 80, 0.5, 100, asphalt)
    for side in (-1, 1):
        x = side * (STREET_HALF_WIDTH + SIDEWALK / 2)
        level.box(f'sidewalk_{"L" if side < 0 else "R"}', x, 0.075, z_mid, SIDEWALK / 2, 0.075, length / 2, sidewalk)

    # ---- buildings: slabs along both sides, gaps for alleys, neon on most faces ----
    neon_index = 0
    for side in (-1, 1):
        z = STREET_Z_MIN
        n = 0
        while z < STREET_Z_MAX:
            depth = rng.uniform(8, 16)
            height = rng.uniform(9, 24)
            setback = rng.uniform(0, 1.5)
            x = side * (STREET_HALF_WIDTH + SIDEWALK + depth / 2 + setback)
            name = f'building_{"L" if side < 0 else "R"}{n}'
            level.box(name, x, height / 2, z + depth / 2, depth / 2, height / 2, depth / 2, facade)
            if rng.random() < 0.55:
                color = NEON_COLORS[neon_index % len(NEON_COLORS)]
                neon_index += 1
                sign_y = rng.uniform(3, min(height - 1, 9))
                face_x = side * (STREET_HALF_WIDTH + SIDEWALK + setback)
                sign = level.box(
                    f'neon_{name}', face_x - side * 0.12, sign_y, z + depth / 2,
                    0.1, rng.uniform(0.3, 0.7), rng.uniform(0.8, 1.6), neon_mats[color], collide=False,
                )
                sign['spark.emissive'] = True
                level.empty(
                    f'light_{name}', face_x - side * 0.6, sign_y, z + depth / 2,
                    {'type': 'light', 'color': f'#{color:06x}', 'intensity': 22.0, 'range': 8.0}, display='SPHERE', size=0.3,
                )
            z += depth + rng.uniform(1.5, 4)
            n += 1

    # ---- cover: crates and low barriers in the street ---------------------------
    for i in range(22):
        big = rng.random() < 0.4
        hx = 1.0 if big else 0.5
        hy = 0.5
        hz = 0.5
        x = rng.uniform(-STREET_HALF_WIDTH + 1.5, STREET_HALF_WIDTH - 1.5)
        z = rng.uniform(STREET_Z_MIN + 6, STREET_Z_MAX - 12)
        level.box(f'crate_{i}', x, hy, z, hx, hy, hz, crate)
        if big and rng.random() < 0.5:
            level.box(f'crate_{i}_top', x, 3 * hy, z, 0.5, hy, 0.5, crate)
    for i in range(6):
        x = rng.uniform(-STREET_HALF_WIDTH + 2, STREET_HALF_WIDTH - 2)
        z = rng.uniform(STREET_Z_MIN + 10, STREET_Z_MAX - 16)
        level.box(f'barrier_{i}', x, 0.4, z, 1.6, 0.4, 0.18, barrier)

    # ---- the ends: walls so the street reads as enclosed --------------------------
    level.box('wall_far', 0, 6, STREET_Z_MIN - 1, STREET_HALF_WIDTH + SIDEWALK + 2, 6, 1, facade)
    level.box('wall_near', 0, 6, STREET_Z_MAX + 1, STREET_HALF_WIDTH + SIDEWALK + 2, 6, 1, facade)

    # ---- gameplay ---------------------------------------------------------------------
    spawn_z = STREET_Z_MAX - 6
    level.empty('spawn_operator', 0, 0, spawn_z, {'type': 'spawn', 'team': 'player', 'yaw': 0.0}, display='ARROWS', size=1.0)
    objectives = [
        ('square', 'reach', 'Reach the square', 0, 0, -8, 3.0, 0.0),
        ('charge', 'plant', 'Set the charge on the depot wall', 0, 0, STREET_Z_MIN + 4, 2.2, 3.0),
        ('extract', 'reach', 'Return to extraction', 0, 0, spawn_z, 3.0, 0.0),
    ]
    for order, (oid, kind, label, x, y, z, radius, hold) in enumerate(objectives):
        level.empty(
            f'objective_{oid}', x, y, z,
            {'type': 'objective', 'id': oid, 'kind': kind, 'label': label, 'radius': radius, 'hold': hold, 'order': order},
            display='CIRCLE', size=radius,
        )
    patrols = {
        'Rifleman 1': [(5, 0, -4), (-2, 0, -12), (-4, 0, 6)],
        'Rifleman 2': [(4, 0, -24), (-5, 0, -34)],
        'Rifleman 3': [(0, 0, -52), (6, 0, -42), (-6, 0, -44)],
    }
    for route, points in patrols.items():
        for index, (x, y, z) in enumerate(points):
            level.empty(f'patrol_{route.replace(" ", "_")}_{index}', x, y, z, {'type': 'patrol', 'route': route, 'index': index}, display='CONE', size=0.6)
    for index, (x, y, z) in enumerate([(9.5, 0.15, 24), (9.5, 0.15, 16)]):
        level.empty(f'target_{index}', x, y, z, {'type': 'target', 'index': index}, display='CUBE', size=0.4)


def export(level: Level, directory):
    os.makedirs(directory, exist_ok=True)
    blend = os.path.join(directory, 'street.blend')
    glb = os.path.join(directory, 'street.glb')
    bpy.ops.wm.save_as_mainfile(filepath=blend, compress=True)
    bpy.ops.export_scene.gltf(
        filepath=glb,
        export_format='GLB',
        export_extras=True,
        export_apply=True,
        export_yup=True,
        export_lights=False,
        export_materials='EXPORT',
        export_animations=False,
        export_normals=True,
        export_tangents=False,
        use_selection=False,
    )
    counts = {
        'render': len(level.render.objects),
        'collision': len(level.collision.objects),
        'gameplay': len(level.gameplay.objects),
    }
    print(f'street: wrote {blend} and {glb} ({counts})')


if __name__ == '__main__':
    lvl = Level()
    build(lvl)
    export(lvl, out_dir())
