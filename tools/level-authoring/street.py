"""
Authors the showcase's first level, "street", inside Blender and exports it
the way a human level designer would: a .blend to open and edit, and a GLB
with spark.* custom properties (ADR-008). Run headless:

    blender --background --python tools/level-authoring/street.py -- <out-dir>

Everything gameplay-relevant is a custom property on an object, never a name:

    spark.type=spawn      team=player                  the operator's insertion point
    spark.type=objective  kind/label/radius/hold/order the mission, in `order`
    spark.type=patrol     route/index                  one point of an enemy loop
    spark.type=reinforce  id/wave/route/index          an alert ingress point (wave: alerted|lockdown)
    spark.type=target     index                        a range dummy
    spark.type=light      color/intensity/range        a neon or lamp point light
    spark.type=vfx        preset/dx/dy/dz              a steam vent
    spark.type=prop       prop/scale                   a prop from the CC0 kit (tools/asset-pipeline/fetch-polyhaven.mjs)

Collision is a COL_<name> twin of each solid, marked spark.collider=box so
the loader builds a box body from its bounds. Big geometry (buildings,
ground, crates) is one object per box sharing a unit cube per material.
Dressing (windows, ledges, awnings, pipes, cables, rooftop clutter, bollards)
is batched: one mesh per material with the geometry baked in world space,
so hundreds of pieces cost a handful of draw calls. Material names are
engine surface names (`SurfaceLibrary`); windows sit on `WINDOW_GRID` so the
lit/dark hash per pane lines up.

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
from mathutils import Matrix, Quaternion, Vector

SEED = 7
STREET_HALF_WIDTH = 9.0
STREET_Z_MIN = -70.0
STREET_Z_MAX = 40.0
SIDEWALK = 2.5
NEON_COLORS = [0xFF2BD6, 0x22E8FF, 0xFF7A1A, 0x4DFF6A, 0xFF3D5A, 0x3D7BFF, 0xFFD23D, 0xB14DFF]
# Must match WINDOW_GRID in packages/engine/src/rendering/Surfaces.ts.
WINDOW_U = 2.4
WINDOW_V = 3.2
AWNING_COLORS = [0x6A2A2A, 0x2A4A6A, 0x5A4A2A, 0x2A5A3A]

# Prop kit: id -> (collider half extents or None, origin y offset). Sizes measured from the fetched GLBs.
PROPS = {
    'fire_hydrant': ((0.2, 0.4, 0.2), 0.0),
    'metal_trash_can': ((0.9, 0.45, 0.3), 0.0),
    'trashbag': (None, 0.0),
    'barrel_03': ((0.32, 0.47, 0.32), 0.0),
    'barrel_stove': ((0.3, 0.43, 0.3), 0.0),
    'concrete_road_barrier': ((0.78, 0.42, 0.32), 0.0),
    'old_tyre': (None, 0.3),
    'street_lamp_01': ((0.12, 1.9, 0.12), 0.0),
    'utility_box_01': ((0.26, 0.56, 0.22), 0.0),
    'water_manhole_cover': (None, 0.0),
    'cardboard_box_01': (None, 0.0),
    'plastic_crate_03': (None, 0.0),
    'power_box_01': (None, 0.25),
    'portable_generator': ((0.41, 0.29, 0.28), 0.0),
}


def out_dir():
    if '--' in sys.argv:
        return os.path.abspath(sys.argv[sys.argv.index('--') + 1])
    return os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'assets', 'source', 'levels'))


def to_blender(x, y, z):
    return Vector((x, -z, y))


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


class Batch:
    """World-space geometry accumulated into one mesh per material."""

    def __init__(self, level, name, mat):
        self.level = level
        self.name = name
        self.mat = mat
        self.bm = bmesh.new()
        self.count = 0

    def box(self, x, y, z, hx, hy, hz):
        m = Matrix.Translation(to_blender(x, y, z)) @ Matrix.Diagonal((2 * hx, 2 * hz, 2 * hy, 1.0))
        bmesh.ops.create_cube(self.bm, size=1.0, matrix=m)
        self.count += 1

    def cylinder(self, x, y, z, radius, height, segments=10):
        """Vertical cylinder (engine Y axis), base at y."""
        m = Matrix.Translation(to_blender(x, y + height / 2, z))
        bmesh.ops.create_cone(self.bm, cap_ends=True, segments=segments, radius1=radius, radius2=radius, depth=height, matrix=m)
        self.count += 1

    def segment(self, a, b, radius, segments=6):
        """Cylinder between two engine-space points."""
        pa = to_blender(*a)
        pb = to_blender(*b)
        d = pb - pa
        length = d.length
        if length < 1e-4:
            return
        rot = Vector((0.0, 0.0, 1.0)).rotation_difference(d.normalized())
        m = Matrix.Translation((pa + pb) / 2) @ rot.to_matrix().to_4x4()
        bmesh.ops.create_cone(self.bm, cap_ends=True, segments=segments, radius1=radius, radius2=radius, depth=length, matrix=m)
        self.count += 1

    def finish(self):
        if self.count == 0:
            self.bm.free()
            return None
        mesh = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        mesh.materials.append(self.mat)
        obj = bpy.data.objects.new(self.name, mesh)
        self.level.render.objects.link(obj)
        return obj


class Level:
    def __init__(self):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.scene = bpy.context.scene
        self.scene.unit_settings.system = 'METRIC'
        self.scene.unit_settings.scale_length = 1.0
        self.render = bpy.data.collections.new('Render')
        self.collision = bpy.data.collections.new('Collision')
        self.gameplay = bpy.data.collections.new('Gameplay')
        self.props = bpy.data.collections.new('Props')
        for c in (self.render, self.collision, self.gameplay, self.props):
            self.scene.collection.children.link(c)
        self.col_mesh = unit_cube('COL_unit_cube')
        self.meshes = {}
        self.prop_counts = {}

    def cube_for(self, mat):
        if mat.name not in self.meshes:
            mesh = unit_cube(f'cube_{mat.name}')
            mesh.materials.append(mat)
            self.meshes[mat.name] = mesh
        return self.meshes[mat.name]

    def collider(self, name, x, y, z, hx, hy, hz):
        col = bpy.data.objects.new(f'COL_{name}', self.col_mesh)
        col.location = to_blender(x, y, z)
        col.scale = (2 * hx, 2 * hz, 2 * hy)
        col['spark.collider'] = 'box'
        col.display_type = 'WIRE'
        self.collision.objects.link(col)
        return col

    def box(self, name, x, y, z, hx, hy, hz, mat, collide=True):
        obj = bpy.data.objects.new(name, self.cube_for(mat))
        obj.location = to_blender(x, y, z)
        obj.scale = (2 * hx, 2 * hz, 2 * hy)
        self.render.objects.link(obj)
        if collide:
            self.collider(name, x, y, z, hx, hy, hz)
        return obj

    def empty(self, name, x, y, z, props, display='PLAIN_AXES', size=0.5, yaw=0.0, collection=None):
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = display
        obj.empty_display_size = size
        obj.location = to_blender(x, y, z)
        obj.rotation_euler = (0.0, 0.0, yaw)
        for key, value in props.items():
            obj[f'spark.{key}'] = value
        (collection or self.gameplay).objects.link(obj)
        return obj

    def prop(self, prop_id, x, z, yaw=0.0, scale=1.0, y=0.0):
        """A kit prop at feet position (x, y, z) facing `yaw`; big ones get a box collider."""
        half, origin_y = PROPS[prop_id]
        n = self.prop_counts.get(prop_id, 0)
        self.prop_counts[prop_id] = n + 1
        name = f'prop_{prop_id}_{n}'
        self.empty(name, x, y + origin_y * scale, z, {'type': 'prop', 'prop': prop_id, 'scale': scale}, display='CUBE', size=0.3, yaw=yaw, collection=self.props)
        if half:
            hx, hy, hz = (h * scale for h in half)
            # Yaw the collider footprint by swapping extents at right angles; boxes stay axis aligned.
            if abs(math.sin(yaw)) > 0.7:
                hx, hz = hz, hx
            self.collider(name, x, y + hy, z, hx, hy, hz)


def build(level: Level):
    rng = random.Random(SEED)
    # Material names are engine surface names (SurfaceLibrary): the loader swaps them for the
    # procedural wet-city surfaces. Colours here only matter for the tinted `metal` surface.
    asphalt = material('asphalt', hex_rgb(0x14161C), 0.32, 0.05)
    sidewalk = material('concrete', hex_rgb(0x232630), 0.6, 0.02)
    facade = material('brick', hex_rgb(0x191C26), 0.72, 0.08)
    crate = material('metal', hex_rgb(0x3A3F4A), 0.55, 0.35)
    barrier = material('metal.barrier', hex_rgb(0x4A3A2A), 0.6, 0.2)
    skyline = material('skyline', hex_rgb(0x05060A), 1.0, 0.0)
    window = material('window', hex_rgb(0x0D1220), 0.2, 0.0)
    ledge = material('concrete.ledge', hex_rgb(0x2A2C33), 0.7, 0.0)
    pipe = material('metal.pipe', hex_rgb(0x2C2F36), 0.5, 0.5)
    cable = material('metal.cable', hex_rgb(0x0C0D10), 0.6, 0.2)
    shutter = material('metal.shutter', hex_rgb(0x15171C), 0.6, 0.3)
    roof = material('metal.roof', hex_rgb(0x30343C), 0.55, 0.4)
    bollard = material('metal.bollard', hex_rgb(0x1A1C22), 0.5, 0.6)
    awnings = [material(f'metal.awning{i}', hex_rgb(c), 0.7, 0.05) for i, c in enumerate(AWNING_COLORS)]
    neon_mats = {c: material(f'neon_{c:06x}', hex_rgb(c), 0.4, 0.0, hex_rgb(c), 2.5) for c in NEON_COLORS}

    windows = Batch(level, 'dressing_windows', window)
    ledges = Batch(level, 'dressing_ledges', ledge)
    pipes = Batch(level, 'dressing_pipes', pipe)
    cables = Batch(level, 'dressing_cables', cable)
    shutters = Batch(level, 'dressing_shutters', shutter)
    roofs = Batch(level, 'dressing_roofs', roof)
    bollards = Batch(level, 'dressing_bollards', bollard)
    awning_batches = [Batch(level, f'dressing_awnings{i}', m) for i, m in enumerate(awnings)]

    length = STREET_Z_MAX - STREET_Z_MIN
    z_mid = (STREET_Z_MAX + STREET_Z_MIN) / 2

    # ---- ground: street and raised sidewalks ---------------------------------
    level.box('ground', 0, -0.5, z_mid, 80, 0.5, 100, asphalt)
    for side in (-1, 1):
        x = side * (STREET_HALF_WIDTH + SIDEWALK / 2)
        level.box(f'sidewalk_{"L" if side < 0 else "R"}', x, 0.075, z_mid, SIDEWALK / 2, 0.075, length / 2, sidewalk)

    # ---- buildings: slabs along both sides, dressed --------------------------------
    neon_index = 0
    building_faces = []
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
            face_x = side * (STREET_HALF_WIDTH + SIDEWALK + setback)
            z0, z1 = z, z + depth
            building_faces.append((side, face_x, z0, z1, height))

            # Windows on the street face, centred on the world grid so the shader's lit/dark hash lines up.
            first_col = math.ceil((z0 + 1.0) / WINDOW_U)
            last_col = math.floor((z1 - 1.0) / WINDOW_U)
            row = 1
            while row * WINDOW_V < height - 1.5:
                wy = row * WINDOW_V
                for col in range(first_col, last_col + 1):
                    windows.box(face_x - side * 0.05, wy, col * WINDOW_U, 0.05, 0.75, 0.55)
                if row % 2 == 0:
                    ledges.box(face_x - side * 0.14, wy - 1.05, (z0 + z1) / 2, 0.14, 0.06, depth / 2 - 0.1)
                row += 1

            # Ground floor: a shuttered doorway with an awning, sometimes a neon sign above.
            door_z = (z0 + z1) / 2 + rng.uniform(-depth * 0.2, depth * 0.2)
            shutters.box(face_x - side * 0.04, 1.3, door_z, 0.04, 1.3, 0.9)
            awning_batches[rng.randrange(len(awning_batches))].box(face_x - side * 0.65, 2.95, door_z, 0.65, 0.05, 1.35)
            if rng.random() < 0.55:
                color = NEON_COLORS[neon_index % len(NEON_COLORS)]
                neon_index += 1
                sign_y = rng.uniform(3.4, min(height - 1, 9))
                sign = level.box(
                    f'neon_{name}', face_x - side * 0.12, sign_y, door_z + rng.uniform(-2, 2),
                    0.1, rng.uniform(0.3, 0.7), rng.uniform(0.8, 1.6), neon_mats[color], collide=False,
                )
                sign['spark.emissive'] = True
                level.empty(
                    f'light_{name}', face_x - side * 0.6, sign_y, sign.location.y * -1,
                    {'type': 'light', 'color': f'#{color:06x}', 'intensity': 22.0, 'range': 8.0}, display='SPHERE', size=0.3,
                )

            # A drainpipe down one corner.
            pipes.cylinder(face_x - side * 0.12, 0, z0 + 0.5, 0.07, height - 0.4)

            # Rooftop: parapet, air-conditioning units, an antenna, sometimes a water tank.
            top = height
            roofs.box(x, top + 0.25, z0 + 0.08, depth / 2, 0.25, 0.08)
            roofs.box(x, top + 0.25, z1 - 0.08, depth / 2, 0.25, 0.08)
            roofs.box(face_x - side * 0.08 + side * 0.0, top + 0.25, (z0 + z1) / 2, 0.08, 0.25, depth / 2)
            for _ in range(rng.randrange(1, 3)):
                roofs.box(x + rng.uniform(-depth * 0.3, depth * 0.3), top + 0.45, (z0 + z1) / 2 + rng.uniform(-depth * 0.3, depth * 0.3), 0.6, 0.45, 0.5)
            pipes.cylinder(x + rng.uniform(-depth * 0.3, depth * 0.3), top, z0 + rng.uniform(1, depth - 1), 0.04, rng.uniform(3, 5), segments=6)
            if rng.random() < 0.4:
                roofs.cylinder(x + rng.uniform(-depth * 0.25, depth * 0.25), top, (z0 + z1) / 2, 1.1, 2.2, segments=12)

            z += depth + rng.uniform(1.5, 4)
            n += 1

    # ---- cables across the street, sagging between facades ------------------------
    for _ in range(7):
        cz = rng.uniform(STREET_Z_MIN + 4, STREET_Z_MAX - 4)
        y_left = rng.uniform(7.5, 10.5)
        y_right = rng.uniform(7.5, 10.5)
        xl = -(STREET_HALF_WIDTH + SIDEWALK)
        xr = STREET_HALF_WIDTH + SIDEWALK
        sag = rng.uniform(0.8, 1.6)
        mid = (0.0, (y_left + y_right) / 2 - sag, cz + rng.uniform(-0.3, 0.3))
        quarter_l = (xl / 2, (y_left + mid[1]) / 2 - sag * 0.3, cz)
        quarter_r = (xr / 2, (y_right + mid[1]) / 2 - sag * 0.3, cz)
        pts = [(xl, y_left, cz), quarter_l, mid, quarter_r, (xr, y_right, cz)]
        for a, b in zip(pts, pts[1:]):
            cables.segment(a, b, 0.025)

    # ---- bollards along the kerb --------------------------------------------------
    for side in (-1, 1):
        bz = STREET_Z_MIN + 6
        while bz < STREET_Z_MAX - 6:
            bollards.cylinder(side * (STREET_HALF_WIDTH - 0.35), 0.15, bz, 0.1, 0.85, segments=8)
            bz += 7.0

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

    # ---- props from the CC0 kit ---------------------------------------------------------
    kerb_l = -(STREET_HALF_WIDTH + 0.9)
    kerb_r = STREET_HALF_WIDTH + 0.9
    for lz in (30, 8, -14, -36, -58):
        level.prop('street_lamp_01', kerb_l, lz, yaw=math.pi / 2)
        level.empty(f'lamp_light_{lz}', kerb_l + 0.6, 3.6, lz, {'type': 'light', 'color': '#ffb070', 'intensity': 26.0, 'range': 11.0}, display='SPHERE', size=0.3)
    for lz in (20, -4, -26, -48):
        level.prop('street_lamp_01', kerb_r, lz, yaw=-math.pi / 2)
        level.empty(f'lamp_light_r{lz}', kerb_r - 0.6, 3.6, lz, {'type': 'light', 'color': '#ffb070', 'intensity': 26.0, 'range': 11.0}, display='SPHERE', size=0.3)
    level.prop('fire_hydrant', kerb_r, 33, yaw=math.pi)
    level.prop('fire_hydrant', kerb_l, -20, yaw=0.0)
    for (px, pz, yaw) in ((kerb_l - 0.2, 24, 0.3), (kerb_r + 0.1, -10, -0.4), (kerb_l - 0.1, -52, 0.8)):
        level.prop('metal_trash_can', px, pz, yaw=yaw)
    for (px, pz) in ((kerb_l - 0.4, 22), (kerb_l + 0.3, 23), (kerb_r + 0.4, -9), (kerb_r - 0.2, -8.2), (kerb_l, -50), (kerb_r + 0.3, 2)):
        level.prop('trashbag', px, pz, yaw=rng.uniform(0, math.tau), scale=rng.uniform(0.9, 1.15))
    for (px, pz) in ((-3.5, 14), (-2.9, 14.4), (5.5, -30), (-6, -46), (6.2, -46.5)):
        level.prop('barrel_03', px, pz, yaw=rng.uniform(0, math.tau))
    level.prop('barrel_stove', 4.0, 26, yaw=0.4)
    level.empty('stove_light', 4.0, 0.9, 26, {'type': 'light', 'color': '#ff7a2a', 'intensity': 14.0, 'range': 6.0}, display='SPHERE', size=0.25)
    for (px, pz, yaw) in ((2.5, -2, 0.0), (-4.5, -18, 0.0), (0.5, -40, math.pi / 2)):
        level.prop('concrete_road_barrier', px, pz, yaw=yaw)
    for (px, pz) in ((kerb_r - 0.6, 16), (-7.5, -33), (kerb_l + 1.0, -63)):
        level.prop('old_tyre', px, pz, yaw=rng.uniform(0, math.tau))
    for (px, pz, yaw) in ((kerb_l - 0.6, 36, math.pi / 2), (kerb_r + 0.6, -60, -math.pi / 2)):
        level.prop('utility_box_01', px, pz, yaw=yaw)
    for (px, pz) in ((-3, 20), (4, -12), (-2, -44)):
        level.prop('water_manhole_cover', px, pz, yaw=rng.uniform(0, math.tau))
    for (px, pz) in ((kerb_l + 0.2, 26.5), (kerb_r - 0.3, -7), (kerb_r, -7.6), (-7.8, -24)):
        level.prop('cardboard_box_01', px, pz, yaw=rng.uniform(0, math.tau))
    for (px, pz) in ((kerb_r - 0.5, 15), (kerb_r - 0.5, 15.4), (7.6, -31)):
        level.prop('plastic_crate_03', px, pz, yaw=rng.uniform(0, math.tau))
    level.prop('power_box_01', -(STREET_HALF_WIDTH + SIDEWALK - 0.25), 4, yaw=math.pi / 2, y=1.1)
    level.prop('power_box_01', STREET_HALF_WIDTH + SIDEWALK - 0.25, -38, yaw=-math.pi / 2, y=1.3)
    level.prop('portable_generator', -6.5, -6, yaw=0.9)

    # ---- the ends: walls so the street reads as enclosed --------------------------
    level.box('wall_far', 0, 6, STREET_Z_MIN - 1, STREET_HALF_WIDTH + SIDEWALK + 2, 6, 1, facade)
    level.box('wall_near', 0, 6, STREET_Z_MAX + 1, STREET_HALF_WIDTH + SIDEWALK + 2, 6, 1, facade)

    # ---- skyline: emissive backdrop cards beyond each end and along the sides, no collision ----
    level.box('skyline_far', 0, 38, STREET_Z_MIN - 45, 120, 38, 0.5, skyline, collide=False)
    level.box('skyline_near', 0, 38, STREET_Z_MAX + 45, 120, 38, 0.5, skyline, collide=False)
    level.box('skyline_left', -70, 34, z_mid, 0.5, 34, 130, skyline, collide=False)
    level.box('skyline_right', 70, 34, z_mid, 0.5, 34, 130, skyline, collide=False)

    # ---- steam vents at the base of a few facades, read by the game as spark.type=vfx ----
    for index, (x, z, dx) in enumerate([(-STREET_HALF_WIDTH - 0.4, -6, 0.55), (STREET_HALF_WIDTH + 0.4, -22, -0.5), (-STREET_HALF_WIDTH - 0.4, -44, 0.5), (STREET_HALF_WIDTH + 0.4, 12, -0.5)]):
        level.empty(f'steam_{index}', x, 0.6, z, {'type': 'vfx', 'preset': 'steam', 'dx': dx, 'dy': 0.8, 'dz': 0.1}, display='SINGLE_ARROW', size=0.6)

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
    # Where the sector sends hostiles in from once the alert model escalates
    # (docs/design/mission-shape.md, apps/showcase/src/mission/Alert.ts). The
    # alerted wave comes from the depot end the player is heading into; the
    # lockdown wave adds the flanks and one behind, on the extraction leg, so
    # a loud run has to fight its way back out.
    reinforcements = [
        ('depot_north', 'alerted', 0, 0, -66, 'Rifleman 3'),
        ('side_west', 'alerted', -7.5, 0, -30, 'Rifleman 2'),
        ('depot_east', 'lockdown', 7.5, 0, -60, 'Rifleman 3'),
        ('square_east', 'lockdown', 7.5, 0, -14, 'Rifleman 1'),
        ('extract_south', 'lockdown', -6, 0, 22, None),
    ]
    for index, (rid, wave, x, y, z, route) in enumerate(reinforcements):
        props = {'type': 'reinforce', 'id': rid, 'wave': wave, 'index': index}
        if route is not None:
            props['route'] = route
        level.empty(f'reinforce_{rid}', x, y, z, props, display='SPHERE', size=0.8)
    for index, (x, y, z) in enumerate([(9.5, 0.15, 24), (9.5, 0.15, 16)]):
        level.empty(f'target_{index}', x, y, z, {'type': 'target', 'index': index}, display='CUBE', size=0.4)

    for batch in (windows, ledges, pipes, cables, shutters, roofs, bollards, *awning_batches):
        batch.finish()
    return {'faces': len(building_faces), 'windows': windows.count, 'props': sum(level.prop_counts.values())}


def export(level: Level, directory, summary):
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
        'props': len(level.props.objects),
        **summary,
    }
    print(f'street: wrote {blend} and {glb} ({counts})')


if __name__ == '__main__':
    lvl = Level()
    summary = build(lvl)
    export(lvl, out_dir(), summary)
