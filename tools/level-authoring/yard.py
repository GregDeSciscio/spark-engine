"""
Authors the destruction slice's level, "yard", inside Blender: a walled yard
with three buildings blocked out as destructible boxes (ADR-008, ADR-011),
the player's insertion point and the bots' spawns. Run headless:

    blender --background --python tools/level-authoring/yard.py -- <out-dir>

Everything gameplay-relevant is a custom property on an object, never a name:

    spark.type=destructible  structure/piece[/cell/density]  a box of a destructible building:
                                                              structure names the building, piece is
                                                              wall|slab|column. No COL_ twin: the
                                                              structure collides with its own chunks.
    spark.type=spawn         team=player|bots                 where the player and the bots start
    spark.type=patrol        index                            a point the bots wander between

The buildings meet face to face (walls on the ground, slabs on the walls,
columns under the slabs), because touching faces are what the engine glues.
"shed" is turned 20 degrees to keep the pipeline honest about rotation.
Each building's material name is an engine surface name (`brick`, `concrete`,
`metal.shed`), so its chunks are finished in that surface.

Engine space is Y-up; Blender is Z-up. The glTF exporter maps Blender
(x, y, z) to glTF (x, z, -y), so an engine position (x, y, z) is authored at
Blender (x, -z, y), and a yaw about the engine's up is a rotation about
Blender's z.
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

STOREY = 3.2
WALL = 0.3
SLAB = 0.25
YARD = 38.0


def out_dir():
    if '--' in sys.argv:
        return os.path.abspath(sys.argv[sys.argv.index('--') + 1])
    return os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'assets', 'source', 'levels'))


def to_blender(x, y, z):
    return Vector((x, -z, y))


def unit_cube(name):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def material(name, rgb, roughness):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
    bsdf.inputs['Roughness'].default_value = roughness
    return mat


class Level:
    def __init__(self):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        scene = bpy.context.scene
        self.render = bpy.data.collections.new('render')
        self.collision = bpy.data.collections.new('collision')
        self.buildings = bpy.data.collections.new('buildings')
        self.gameplay = bpy.data.collections.new('gameplay')
        for c in (self.render, self.collision, self.buildings, self.gameplay):
            scene.collection.children.link(c)
        self.cubes = {}

    def cube_for(self, mat):
        if mat.name not in self.cubes:
            mesh = unit_cube(f'cube_{mat.name}')
            mesh.materials.append(mat)
            self.cubes[mat.name] = mesh
        return self.cubes[mat.name]

    def solid(self, name, x, y, z, hx, hy, hz, mat):
        """Static geometry with a COL_ box twin."""
        obj = bpy.data.objects.new(name, self.cube_for(mat))
        obj.location = to_blender(x, y, z)
        obj.scale = (2 * hx, 2 * hz, 2 * hy)
        self.render.objects.link(obj)
        col = bpy.data.objects.new(f'COL_{name}', self.cube_for(mat))
        col.location = obj.location
        col.scale = obj.scale
        col['spark.collider'] = 'box'
        col.display_type = 'WIRE'
        self.collision.objects.link(col)

    def empty(self, name, x, y, z, props):
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = 'PLAIN_AXES'
        obj.location = to_blender(x, y, z)
        for key, value in props.items():
            obj[f'spark.{key}'] = value
        self.gameplay.objects.link(obj)


class Building:
    """Boxes of one destructible structure, laid out in its own frame (x across, z deep) and placed at (ox, oz) turned by `yaw`."""

    def __init__(self, level, name, mat, ox, oz, yaw=0.0):
        self.level = level
        self.name = name
        self.mat = mat
        self.ox = ox
        self.oz = oz
        self.yaw = yaw
        self.count = 0

    def box(self, piece, x, y, z, hx, hy, hz):
        c, s = math.cos(self.yaw), math.sin(self.yaw)
        # The same turn as the engine's: (x, z) -> (x c + z s, -x s + z c), a yaw about +y.
        wx = self.ox + x * c + z * s
        wz = self.oz - x * s + z * c
        obj = bpy.data.objects.new(f'{self.name}_{piece}_{self.count}', self.level.cube_for(self.mat))
        self.count += 1
        obj.location = to_blender(wx, y, wz)
        obj.scale = (2 * hx, 2 * hz, 2 * hy)
        obj.rotation_euler = (0.0, 0.0, self.yaw)
        obj['spark.type'] = 'destructible'
        obj['spark.structure'] = self.name
        obj['spark.piece'] = piece
        self.level.buildings.objects.link(obj)

    def wall(self, y0, x0, z0, x1, z1, height, door=None, windows=()):
        """A straight wall along x or z from (x0, z0) to (x1, z1), split round a door (a, b) and windows (a, b, sill, top)."""
        along_x = abs(z1 - z0) < 1e-6
        length = abs(x1 - x0) if along_x else abs(z1 - z0)
        openings = []
        if door:
            openings.append((door[0], door[1], 0.0, 2.3))
        openings += list(windows)
        openings.sort()
        cuts = []
        u = 0.0
        for a, b, v0, v1 in openings:
            if a - u > 1e-6:
                cuts.append((u, a, 0.0, height))
            if v0 > 0.05:
                cuts.append((a, b, 0.0, v0))
            if height - v1 > 0.05:
                cuts.append((a, b, v1, height))
            u = b
        if length - u > 1e-6:
            cuts.append((u, length, 0.0, height))
        for a, b, v0, v1 in cuts:
            mid = (a + b) / 2
            hy = (v1 - v0) / 2
            cy = y0 + v0 + hy
            if along_x:
                sx = 1 if x1 > x0 else -1
                self.box('wall', x0 + sx * mid, cy, z0, (b - a) / 2, hy, WALL / 2)
            else:
                sz = 1 if z1 > z0 else -1
                self.box('wall', x0, cy, z0 + sz * mid, WALL / 2, hy, (b - a) / 2)

    def block(self, width, depth, floors, door_at=None, columns=()):
        """A rectangular building: four walls a storey (front at z = -depth/2), a slab on each, columns inside."""
        hw = width / 2
        hd = depth / 2
        wall_h = STOREY - SLAB
        for f in range(floors):
            y0 = f * STOREY
            bay = 3.0
            bays = max(1, round(width / bay))
            step = width / bays
            front_windows = [] if f == 0 else [(i * step + step / 2 - 0.65, i * step + step / 2 + 0.65, 0.9, 2.3) for i in range(bays)]
            door = (door_at - 0.7, door_at + 0.7) if (f == 0 and door_at is not None) else None
            # Front and back run the full width; the sides fit between them.
            self.wall(y0, -hw, -hd + WALL / 2, hw, -hd + WALL / 2, wall_h, door=door, windows=front_windows)
            self.wall(y0, -hw, hd - WALL / 2, hw, hd - WALL / 2, wall_h)
            self.wall(y0, -hw + WALL / 2, -hd + WALL, -hw + WALL / 2, hd - WALL, wall_h)
            self.wall(y0, hw - WALL / 2, -hd + WALL, hw - WALL / 2, hd - WALL, wall_h)
            for cx, cz in columns:
                self.box('column', cx, y0 + wall_h / 2, cz, 0.22, wall_h / 2, 0.22)
            self.box('slab', 0.0, (f + 1) * STOREY - SLAB / 2, 0.0, hw, SLAB / 2, hd)


def build(level):
    ground = material('ground', (0.18, 0.19, 0.17), 0.95)
    boundary = material('boundary', (0.25, 0.24, 0.22), 0.9)
    # The buildings' material names are engine surface names: their chunks wear brick, concrete or painted metal.
    brick = material('brick', (0.29, 0.23, 0.21), 0.8)
    concrete = material('concrete', (0.55, 0.53, 0.5), 0.9)
    sheet = material('metal.shed', (0.23, 0.25, 0.29), 0.55)

    level.solid('ground', 0.0, -0.5, 0.0, YARD + 2, 0.5, YARD + 2, ground)
    for i, (x, z, hx, hz) in enumerate([(0, -YARD, YARD, 0.4), (0, YARD, YARD, 0.4), (-YARD, 0, 0.4, YARD), (YARD, 0, 0.4, YARD)]):
        level.solid(f'boundary_{i}', x, 1.2, z, hx, 1.2, hz, boundary)
    # A low wall across the middle of the yard: cover, and a reason for paths to bend.
    level.solid('cover_0', -4.0, 0.6, -6.0, 5.0, 0.6, 0.3, boundary)

    # The depot: two storeys, 12 x 8 m, its door facing the player.
    Building(level, 'depot', brick, -14.0, 6.0).block(12.0, 8.0, 2, door_at=6.0, columns=[(-2.0, 0.0), (2.0, 0.0)])
    # The tower: four storeys, 8 x 8 m.
    Building(level, 'tower', concrete, 13.0, 10.0).block(8.0, 8.0, 4, door_at=4.0, columns=[(0.0, 0.0)])
    # The shed: one storey, 6 x 5 m, turned 20 degrees.
    Building(level, 'shed', sheet, 2.0, -16.0, yaw=math.radians(20)).block(6.0, 5.0, 1, door_at=3.0)

    level.empty('spawn_player', 0.0, 0.1, -30.0, {'type': 'spawn', 'team': 'player'})
    for i, (x, z) in enumerate([(-14.0, -6.0), (13.0, 0.0), (-24.0, 20.0), (24.0, 24.0), (0.0, 18.0)]):
        level.empty(f'spawn_bot_{i}', x, 0.1, z, {'type': 'spawn', 'team': 'bots'})
    for i, (x, z) in enumerate([(-28.0, -20.0), (-28.0, 26.0), (0.0, 28.0), (28.0, 28.0), (28.0, -10.0), (-14.0, 6.0), (13.0, 10.0), (0.0, 4.0)]):
        level.empty(f'patrol_{i}', x, 0.1, z, {'type': 'patrol', 'index': i})


def export(level, directory):
    os.makedirs(directory, exist_ok=True)
    blend = os.path.join(directory, 'yard.blend')
    glb = os.path.join(directory, 'yard.glb')
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
    print(f'yard: wrote {blend} and {glb} (render {len(level.render.objects)}, collision {len(level.collision.objects)}, destructible boxes {len(level.buildings.objects)}, gameplay {len(level.gameplay.objects)})')


if __name__ == '__main__':
    lvl = Level()
    build(lvl)
    export(lvl, out_dir())
