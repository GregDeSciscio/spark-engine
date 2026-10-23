"""
Authors the showcase's first level, "street", inside Blender and exports it
the way a human level designer would: a .blend to open and edit, and a GLB
with spark.* custom properties (ADR-008). Run headless:

    blender --background --python tools/level-authoring/street.py -- <out-dir>

Everything gameplay-relevant is a custom property on an object, never a name:

    spark.type=spawn      team=player                  the operator's insertion point
    spark.type=objective  kind/label/radius/order      the mission, in `order` (kind: reach|plant|eliminate|extract)
                          hold/fuse/defuse (plant)     seconds to set it, to burn, for a hostile to pull it
                          target (eliminate)           the patrol route whose hostile must die
    spark.type=patrol     route/index[/role]           one point of an enemy loop (role=hvt: a target)
    spark.type=reinforce  id/wave/route/index          an alert ingress point (wave: alerted|lockdown)
    spark.type=target     index                        a range dummy
    spark.type=light      color/intensity/range        a neon or lamp point light
    spark.type=vfx        preset/dx/dy/dz              a steam vent
    spark.type=prop       prop/scale                   a prop from the CC0 kit (tools/asset-pipeline/fetch-polyhaven.mjs)
    spark.type=mantle     hx/hz/top                    a low obstacle the operator vaults: an axis-aligned
                                                       footprint round the empty, from its height up to `top`

The street has three lanes (docs/design/milestone-10-gaps.md, gap 10): the
road itself; a service alley behind the west row, reached through three
passages between buildings; and a fire escape up the east facades to a
catwalk over the square and the broker's beat. Every other gap between
buildings is walled off, so those are the only ways round.

Collision is a COL_<name> twin of each solid, marked spark.collider=box so
the loader builds a box body from its bounds (and its rotation: the fire
escape's stair is a tilted box). Big geometry (buildings,
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

# ---- the lanes ------------------------------------------------------------------
# The alley: the west row stops at ALLEY_IN, a 3.6 m lane runs behind it, and
# a second row of blocks stands beyond. Tall enough (9 m and up) that the moon
# never reaches its floor, which is what makes it the dark way round.
ALLEY_IN = 20.0
ALLEY_WIDTH = 3.6
ALLEY_OUT = ALLEY_IN + ALLEY_WIDTH
ALLEY_X = -(ALLEY_IN + ALLEY_WIDTH / 2)
ALLEY_Z_MAX = 2.0
# Passages from the street into the alley: the gap between west buildings
# nearest each z is kept open, widened to at least `width`. One by the square,
# one at the broker's beat, one at the depot end.
PASSAGES = [('square', -17.0, 3.0), ('broker', -32.0, 2.4), ('depot', -58.0, 2.6)]
# One more gap is closed by a wall low enough to vault: a way in the operator
# has and the garrison does not (hostiles do not mantle).
VAULT_GAP_Z = -46.0
# A gap counts as the one nearest a target z inside this distance.
GAP_WINDOW = 6.0
# The overwatch: a stair up the east facade from the square to a catwalk at
# 4.5 m that runs past the square and over the broker's beat.
OVERWATCH_X = (10.7, 12.6)
OVERWATCH_Y = 4.5
OVERWATCH_Z = (-40.5, -13.5)
STAIR_X = (10.8, 12.4)
STAIR_FOOT_Z = -5.0
STAIR_STEPS = 18


def stair_height(z):
    """Top of the fire escape's stair at z: 0 at its foot, the catwalk at the top."""
    t = (STAIR_FOOT_Z - z) / (STAIR_FOOT_Z - OVERWATCH_Z[1])
    return OVERWATCH_Y * min(1.0, max(0.0, t))


def in_overwatch(x, y, z, hx, hy, hz):
    """Whether a box of dressing would sit in the fire escape's headroom (an awning over the stair, a sign across the catwalk)."""
    if x + hx < 10.4 or x - hx > 12.7:
        return False
    z0, z1 = z - hz, z + hz
    if z1 > OVERWATCH_Z[0] and z0 < OVERWATCH_Z[1]:
        if y + hy > OVERWATCH_Y - 0.2 and y - hy < OVERWATCH_Y + 2.1:
            return True
    if z1 > OVERWATCH_Z[1] and z0 < STAIR_FOOT_Z:
        # Highest stair under the box (it climbs toward -z), plus a standing operator's headroom.
        if y - hy < stair_height(max(z0, OVERWATCH_Z[1])) + 2.1:
            return True
    return False

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

    def ramp(self, name, x, hx, low, high, thickness=0.3):
        """
        A walkable slope: a tilted box collider whose top face runs from `low`
        to `high`, each a (z, y) point, climbing along engine z. The loader
        and the navmesh bake both take the node's rotation, so the character
        controller walks up it and the navmesh covers it.
        """
        (z_low, y_low), (z_high, y_high) = low, high
        dz = z_high - z_low
        dy = y_high - y_low
        length = math.hypot(dz, dy)
        # Up-normal of the top face in the (z, y) plane; the box centre sits half its thickness under the face.
        sign = 1.0 if dz > 0 else -1.0
        nz, ny = -dy / length * sign, dz / length * sign
        cz = (z_low + z_high) / 2 - nz * thickness / 2
        cy = (y_low + y_high) / 2 - ny * thickness / 2
        col = bpy.data.objects.new(f'COL_{name}', self.col_mesh)
        col.location = to_blender(x, cy, cz)
        # Blender's +Y is engine -Z, so the tilt about X that lifts the box's length axis is atan2(dy, -dz).
        col.rotation_euler = (math.atan2(dy, -dz), 0.0, 0.0)
        col.scale = (2 * hx, length, thickness)
        col['spark.collider'] = 'box'
        col.display_type = 'WIRE'
        self.collision.objects.link(col)
        return col

    def mantle(self, name, x, y, z, hx, hz, top):
        """A vaultable obstacle's footprint for the operator: x/z half extents round (x, z), from y up to `top`."""
        return self.empty(f'mantle_{name}', x, y, z, {'type': 'mantle', 'hx': hx, 'hz': hz, 'top': top}, display='CUBE', size=0.25)

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

    def prop(self, prop_id, x, z, yaw=0.0, scale=1.0, y=0.0, mantle=False):
        """A kit prop at feet position (x, y, z) facing `yaw`; big ones get a box collider, and `mantle` makes that box vaultable."""
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
            if mantle:
                self.mantle(name, x, y, z, hx, hz, y + 2 * hy)


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
    dumpster = material('metal.dumpster', hex_rgb(0x1E3328), 0.62, 0.3)
    catwalk = material('metal.catwalk', hex_rgb(0x5C4535), 0.55, 0.55)
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
    # The lanes' own geometry is batched like the dressing, one mesh per material (colliders
    # stay one box each): every mesh here costs three draws (main, shadow, prepass), so the
    # alley and the fire escape cost a few of those rather than one per piece. The price is
    # bullet decals, which only land on a collider's own render twin.
    lane_brick = Batch(level, 'lanes_brick', facade)
    alley_metal = Batch(level, 'alley_metal', dumpster)
    fire_escape = Batch(level, 'dressing_fire_escape', catwalk)
    # Bulbs and door lights the eye can find in the dark without lighting anybody:
    # emissive only, no point light, so the visibility meter never sees them.
    lamp_glow = Batch(level, 'dressing_lamp_glow', neon_mats[0xFFD23D])

    length = STREET_Z_MAX - STREET_Z_MIN
    z_mid = (STREET_Z_MAX + STREET_Z_MIN) / 2

    # ---- ground: street and raised sidewalks ---------------------------------
    level.box('ground', 0, -0.5, z_mid, 80, 0.5, 100, asphalt)
    for side in (-1, 1):
        x = side * (STREET_HALF_WIDTH + SIDEWALK / 2)
        level.box(f'sidewalk_{"L" if side < 0 else "R"}', x, 0.075, z_mid, SIDEWALK / 2, 0.075, length / 2, sidewalk)

    # ---- buildings: slabs along both sides, dressed --------------------------------
    # Every draw from `rng` happens in the order it always has, whatever the lanes
    # change about a building's shape, so the rest of the street (the east row, the
    # cables, the crates in the road) keeps the layout its seed gave it.
    neon_index = 0
    building_faces = []
    west_row = []
    gaps = {-1: [], 1: []}
    for side in (-1, 1):
        z = STREET_Z_MIN
        n = 0
        prev_z1 = None
        while z < STREET_Z_MAX:
            depth = rng.uniform(8, 16)
            height = rng.uniform(9, 24)
            setback = rng.uniform(0, 1.5)
            z0, z1 = z, z + depth
            if side < 0 and prev_z1 is not None:
                # A gap that is a passage is opened to its width by pulling this building's near end back.
                for _, target, width in PASSAGES:
                    if abs((prev_z1 + z0) / 2 - target) < GAP_WINDOW and z0 - prev_z1 < width:
                        z0 = prev_z1 + width
            if prev_z1 is not None:
                gaps[side].append((prev_z1, z0))
            prev_z1 = z1
            front = STREET_HALF_WIDTH + SIDEWALK + setback
            # The west row stops at the alley, so its buildings are shallower than the east's.
            back = min(front + depth, ALLEY_IN) if side < 0 else front + depth
            half_x = (back - front) / 2
            half_z = (z1 - z0) / 2
            zc = (z0 + z1) / 2
            x = side * (front + half_x)
            name = f'building_{"L" if side < 0 else "R"}{n}'
            level.box(name, x, height / 2, zc, half_x, height / 2, half_z, facade)
            face_x = side * front
            building_faces.append((side, face_x, z0, z1, height))
            if side < 0:
                west_row.append((z0, z1, height))

            # Windows on the street face, centred on the world grid so the shader's lit/dark hash lines up.
            first_col = math.ceil((z0 + 1.0) / WINDOW_U)
            last_col = math.floor((z1 - 1.0) / WINDOW_U)
            row = 1
            while row * WINDOW_V < height - 1.5:
                wy = row * WINDOW_V
                for col in range(first_col, last_col + 1):
                    windows.box(face_x - side * 0.05, wy, col * WINDOW_U, 0.05, 0.75, 0.55)
                if row % 2 == 0:
                    ledges.box(face_x - side * 0.14, wy - 1.05, zc, 0.14, 0.06, half_z - 0.1)
                row += 1

            # Ground floor: a shuttered doorway with an awning, sometimes a neon sign above.
            # Dressing in the fire escape's way is left off, but its draws still happen.
            door_z = zc + rng.uniform(-half_z * 0.4, half_z * 0.4)
            shutters.box(face_x - side * 0.04, 1.3, door_z, 0.04, 1.3, 0.9)
            awning_batch = awning_batches[rng.randrange(len(awning_batches))]
            awning = (face_x - side * 0.65, 2.95, door_z, 0.65, 0.05, 1.35)
            if not in_overwatch(*awning):
                awning_batch.box(*awning)
            if rng.random() < 0.55:
                color = NEON_COLORS[neon_index % len(NEON_COLORS)]
                neon_index += 1
                sign_y = rng.uniform(3.4, min(height - 1, 9))
                sign_z = door_z + rng.uniform(-2, 2)
                sign_hy = rng.uniform(0.3, 0.7)
                sign_hz = rng.uniform(0.8, 1.6)
                if not in_overwatch(face_x - side * 0.12, sign_y, sign_z, 0.1, sign_hy, sign_hz):
                    sign = level.box(f'neon_{name}', face_x - side * 0.12, sign_y, sign_z, 0.1, sign_hy, sign_hz, neon_mats[color], collide=False)
                    sign['spark.emissive'] = True
                    level.empty(
                        f'light_{name}', face_x - side * 0.6, sign_y, sign_z,
                        {'type': 'light', 'color': f'#{color:06x}', 'intensity': 22.0, 'range': 8.0}, display='SPHERE', size=0.3,
                    )

            # A drainpipe down one corner.
            pipes.cylinder(face_x - side * 0.12, 0, z0 + 0.5, 0.07, height - 0.4)

            # Rooftop: parapet, air-conditioning units, an antenna, sometimes a water tank.
            top = height
            roofs.box(x, top + 0.25, z0 + 0.08, half_x, 0.25, 0.08)
            roofs.box(x, top + 0.25, z1 - 0.08, half_x, 0.25, 0.08)
            roofs.box(face_x - side * 0.08, top + 0.25, zc, 0.08, 0.25, half_z)
            if side < 0:
                # The alley looks up at the west row's back parapet.
                roofs.box(-(back - 0.08), top + 0.25, zc, 0.08, 0.25, half_z)
            for _ in range(rng.randrange(1, 3)):
                roofs.box(x + rng.uniform(-half_x * 0.6, half_x * 0.6), top + 0.45, zc + rng.uniform(-half_z * 0.6, half_z * 0.6), 0.6, 0.45, 0.5)
            pipes.cylinder(x + rng.uniform(-half_x * 0.6, half_x * 0.6), top, z0 + rng.uniform(1, z1 - z0 - 1), 0.04, rng.uniform(3, 5), segments=6)
            if rng.random() < 0.4:
                roofs.cylinder(x + rng.uniform(-half_x * 0.5, half_x * 0.5), top, zc, 1.1, 2.2, segments=12)

            z += depth + rng.uniform(1.5, 4)
            n += 1
        if prev_z1 is not None and prev_z1 < STREET_Z_MAX:
            gaps[side].append((prev_z1, STREET_Z_MAX))

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
    # A single crate and a barrier are waist high: mantle zones. A stacked crate is two metres and is not.
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
        else:
            level.mantle(f'crate_{i}', x, 0, z, hx, hz, 2 * hy)
    for i in range(6):
        x = rng.uniform(-STREET_HALF_WIDTH + 2, STREET_HALF_WIDTH - 2)
        z = rng.uniform(STREET_Z_MIN + 10, STREET_Z_MAX - 16)
        level.box(f'barrier_{i}', x, 0.4, z, 1.6, 0.4, 0.18, barrier)
        level.mantle(f'barrier_{i}', x, 0, z, 1.6, 0.18, 0.8)

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
        level.prop('concrete_road_barrier', px, pz, yaw=yaw, mantle=True)
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

    # ---- the lanes: which gaps between buildings are ways through -------------------
    # Three gaps on the west are the alley's passages and one is walled low enough
    # to vault. Every other gap, on both sides, gets a yard wall too tall to climb,
    # set behind the deepest facade so it never stands proud of one; before the
    # lanes these gaps opened onto the empty ground behind the street.
    def nearest_gap(target):
        best = min(gaps[-1], key=lambda g: abs((g[0] + g[1]) / 2 - target))
        if abs((best[0] + best[1]) / 2 - target) >= GAP_WINDOW:
            raise RuntimeError(f'street: no gap in the west row near z={target}; the seed moved the row, so move the lane')
        return best

    passages = {pid: nearest_gap(target) for pid, target, _ in PASSAGES}
    vault_gap = nearest_gap(VAULT_GAP_Z)
    if vault_gap in passages.values():
        raise RuntimeError('street: the vault gap is also a passage')
    yard_x = STREET_HALF_WIDTH + SIDEWALK + 1.9
    for side in (-1, 1):
        for k, (g0, g1) in enumerate(gaps[side]):
            if side < 0 and ((g0, g1) in passages.values() or (g0, g1) == vault_gap):
                continue
            wz, whz = (g0 + g1) / 2, (g1 - g0) / 2 + 0.3
            lane_brick.box(side * yard_x, 1.8, wz, 0.2, 1.8, whz)
            level.collider(f'yard_wall_{"L" if side < 0 else "R"}{k}', side * yard_x, 1.8, wz, 0.2, 1.8, whz)
            ledges.box(side * yard_x, 3.64, wz, 0.26, 0.05, whz)
            if g1 - g0 > 1.6:
                # A padlocked gate, so a closed gap reads as a yard rather than a missing building.
                shutters.box(side * (yard_x - 0.24), 1.25, wz, 0.04, 1.25, min(1.1, (g1 - g0) / 2 - 0.3))
                level.prop('trashbag', side * (yard_x - 0.6), wz - 0.5, yaw=wz * 1.7)
    # The vault gap: a knee wall at the same line, the operator's own way into the alley.
    v0, v1 = vault_gap
    vz, vhz = (v0 + v1) / 2, (v1 - v0) / 2 + 0.3
    lane_brick.box(-yard_x, 0.55, vz, 0.15, 0.55, vhz)
    level.collider('vault_wall', -yard_x, 0.55, vz, 0.15, 0.55, vhz)
    ledges.box(-yard_x, 1.12, vz, 0.2, 0.03, vhz)
    level.mantle('vault_wall', -yard_x, 0, vz, 0.15, (v1 - v0) / 2, 1.1)

    # ---- the alley: a service lane behind the west row ---------------------------
    # Dark by construction (the far blocks shade its floor from the moon and it has
    # five small lights to the street's two dozen), tight, with cover and a watcher
    # of its own. Its dressing draws from its own stream, so the street's seed
    # keeps its layout.
    arng = random.Random(SEED * 7919 + 1)
    az0, az1 = STREET_Z_MIN, ALLEY_Z_MAX

    def dress_back(face_x, out, z0, z1, h):
        """A wall onto the alley (`out` is the side it faces): sparse upper windows, a steel door, a drainpipe, a conduit, AC units."""
        first_col = math.ceil((z0 + 1.0) / WINDOW_U)
        last_col = math.floor((z1 - 1.0) / WINDOW_U)
        row = 2
        while row * WINDOW_V < h - 1.5:
            for col in range(first_col, last_col + 1):
                if arng.random() < 0.5:
                    windows.box(face_x + out * 0.05, row * WINDOW_V, col * WINDOW_U, 0.05, 0.75, 0.55)
            row += 1
        if z1 - z0 > 3.0:
            dz = arng.uniform(z0 + 1.2, z1 - 1.2)
            shutters.box(face_x + out * 0.04, 1.1, dz, 0.04, 1.1, 0.55)
            if arng.random() < 0.6:
                lamp_glow.box(face_x + out * 0.06, 2.42, dz, 0.04, 0.035, 0.22)
        pipes.cylinder(face_x + out * 0.12, 0, arng.uniform(z0 + 0.4, z1 - 0.4), 0.07, h - 0.4)
        pipes.segment((face_x + out * 0.1, 3.0, z0 + 0.2), (face_x + out * 0.1, 3.0, z1 - 0.2), 0.045)
        for _ in range(arng.randrange(0, 3)):
            roofs.box(face_x + out * 0.3, arng.uniform(2.8, 4.6), arng.uniform(z0 + 0.8, z1 - 0.8), 0.3, 0.3, 0.42)

    # The far side: back blocks shoulder to shoulder, one collider each.
    bz = az0 - 2.0
    k = 0
    while bz < az1 + 2.0:
        b0, b1 = bz, min(bz + arng.uniform(10, 18), az1 + 2.0)
        bh = arng.uniform(9, 19)
        bx = -(ALLEY_OUT + 5.0)
        lane_brick.box(bx, bh / 2, (b0 + b1) / 2, 5.0, bh / 2, (b1 - b0) / 2)
        level.collider(f'alley_block_{k}', bx, bh / 2, (b0 + b1) / 2, 5.0, bh / 2, (b1 - b0) / 2)
        roofs.box(-(ALLEY_OUT + 0.08), bh + 0.25, (b0 + b1) / 2, 0.08, 0.25, (b1 - b0) / 2)
        c0, c1 = max(b0, az0), min(b1, az1)
        if c1 - c0 > 2.0:
            dress_back(-ALLEY_OUT, 1, c0, c1, bh)
            if bh > 11 and arng.random() < 0.6:
                # A fire-escape landing high on the far wall, with its drop ladder pulled up.
                lz = arng.uniform(c0 + 2, c1 - 2)
                for ly in (6.4, 9.6):
                    roofs.box(-ALLEY_OUT + 0.55, ly - 0.04, lz, 0.55, 0.04, 1.4)
                    pipes.segment((-ALLEY_OUT + 1.08, ly + 0.95, lz - 1.4), (-ALLEY_OUT + 1.08, ly + 0.95, lz + 1.4), 0.025)
                for lx in (-ALLEY_OUT + 0.8, -ALLEY_OUT + 1.0):
                    pipes.segment((lx, 3.6, lz + 1.0), (lx, 6.4, lz + 1.0), 0.02)
        bz = b1
        k += 1
    # The near side is the west row's backs.
    for (z0, z1, h) in west_row:
        c0, c1 = max(z0, az0), min(z1, az1)
        if c1 - c0 > 2.0:
            dress_back(-ALLEY_IN, -1, c0, c1, h)
    # The two ends: a wall across behind the square, and the depot's back wall.
    for zc, label in ((az1 + 0.5, 'north'), (az0 - 0.5, 'south')):
        lane_brick.box(ALLEY_X, 4.5, zc, ALLEY_WIDTH / 2 + 0.3, 4.5, 0.5)
        level.collider(f'alley_end_{label}', ALLEY_X, 4.5, zc, ALLEY_WIDTH / 2 + 0.3, 4.5, 0.5)
    # Cables strung across, sagging, the way the street's are.
    for _ in range(6):
        cz = arng.uniform(az0 + 4, az1 - 4)
        y_in, y_out = arng.uniform(5.0, 8.0), arng.uniform(5.0, 8.0)
        mid = (ALLEY_X, (y_in + y_out) / 2 - arng.uniform(0.4, 0.9), cz + arng.uniform(-0.2, 0.2))
        cables.segment((-ALLEY_IN, y_in, cz), mid, 0.02)
        cables.segment(mid, (-ALLEY_OUT, y_out, cz), 0.02)

    # Light: three caged lamps over back doors, a bar's back-door neon, a brazier. Small
    # pools, a few metres of lane each, so most of it stays in the dark the meter reads.
    for i, (fx, lz) in enumerate(((-ALLEY_IN, -9.0), (-ALLEY_OUT, -38.5), (-ALLEY_IN, -63.0))):
        out = -1 if fx == -ALLEY_IN else 1
        shutters.box(fx + out * 0.04, 1.1, lz, 0.04, 1.1, 0.55)
        pipes.segment((fx, 3.25, lz), (fx + out * 0.45, 3.35, lz), 0.03)
        roofs.box(fx + out * 0.5, 3.32, lz, 0.13, 0.07, 0.17)
        lamp_glow.box(fx + out * 0.5, 3.22, lz, 0.07, 0.035, 0.1)
        level.empty(f'alley_lamp_{i}', fx + out * 0.5, 3.1, lz, {'type': 'light', 'color': '#ffb46a', 'intensity': 3.5, 'range': 4.5}, display='SPHERE', size=0.25)
    bar = level.box('neon_alley_bar', -ALLEY_OUT + 0.12, 3.5, -24.0, 0.1, 0.28, 0.7, neon_mats[0x22E8FF], collide=False)
    bar['spark.emissive'] = True
    level.empty('light_alley_bar', -ALLEY_OUT + 0.6, 3.5, -24.0, {'type': 'light', 'color': '#22e8ff', 'intensity': 4.0, 'range': 4.0}, display='SPHERE', size=0.3)
    shutters.box(-ALLEY_OUT + 0.04, 1.1, -24.0, 0.04, 1.1, 0.55)
    # The brazier burns in the vault gap's dead end, off the lane: whoever takes the
    # knee wall into the alley lands in its light.
    vz0, vz1 = vault_gap
    level.prop('barrel_stove', -17.0, vz1 - 0.55, yaw=0.3)
    level.empty('alley_brazier_light', -17.0, 0.9, vz1 - 0.55, {'type': 'light', 'color': '#ff7a2a', 'intensity': 6.0, 'range': 4.0}, display='SPHERE', size=0.25)

    # Cover. Dumpsters and single crates are waist high (mantle zones); the knee
    # walls leave a gap at one end, so a hostile walks round what the operator vaults.
    def dumpster_at(name, x, z, along_z=True):
        hx, hz = (0.6, 0.95) if along_z else (0.95, 0.6)
        alley_metal.box(x, 0.575, z, hx, 0.575, hz)
        alley_metal.box(x, 1.18, z, hx + 0.04, 0.03, hz + 0.04)
        level.collider(f'dumpster_{name}', x, 0.605, z, hx, 0.605, hz)
        level.mantle(f'dumpster_{name}', x, 0, z, hx, hz, 1.21)

    def crate_at(name, x, z, stacked=False):
        alley_metal.box(x, 0.5, z, 0.5, 0.5, 0.5)
        level.collider(f'alley_crate_{name}', x, 0.5, z, 0.5, 0.5, 0.5)
        if stacked:
            alley_metal.box(x, 1.5, z, 0.45, 0.5, 0.45)
            level.collider(f'alley_crate_{name}_top', x, 1.5, z, 0.45, 0.5, 0.45)
        else:
            level.mantle(f'alley_crate_{name}', x, 0, z, 0.5, 0.5, 1.0)

    def knee_wall(name, x0, x1, z):
        x, hx = (x0 + x1) / 2, (x1 - x0) / 2
        lane_brick.box(x, 0.55, z, hx, 0.55, 0.15)
        ledges.box(x, 1.12, z, hx + 0.03, 0.03, 0.2)
        level.collider(f'knee_wall_{name}', x, 0.55, z, hx, 0.55, 0.15)
        level.mantle(f'knee_wall_{name}', x, 0, z, hx, 0.15, 1.1)

    sq0, sq1 = passages['square']
    dp0, dp1 = passages['depot']
    dumpster_at('north', -ALLEY_OUT + 0.65, -5.0)
    dumpster_at('square', -ALLEY_IN - 0.65, sq0 - 2.4)
    dumpster_at('broker', -ALLEY_OUT + 0.65, -40.5)
    dumpster_at('depot', -ALLEY_IN - 0.65, dp1 + 1.6)
    # In the square's passage itself, against its south wall: cover on the way in.
    dumpster_at('square_passage', -16.0, sq0 + 0.65, along_z=False)
    knee_wall('broker', -ALLEY_OUT, -21.6, -27.0)
    knee_wall('depot', -21.9, -ALLEY_IN, -48.5)
    crate_at('broker', -ALLEY_OUT + 0.55, sum(passages['broker']) / 2)
    crate_at('north', -ALLEY_OUT + 0.55, -12.5, stacked=True)
    crate_at('depot_passage', -15.5, dp0 + 0.55)
    level.prop('metal_trash_can', -ALLEY_OUT + 0.35, -44.0, yaw=math.pi / 2)
    level.prop('metal_trash_can', -ALLEY_IN - 0.35, -11.5, yaw=math.pi / 2)
    for (px, pz) in ((-16.1, vz1 - 0.45), (-18.2, vz1 - 0.5)):
        level.prop('barrel_03', px, pz, yaw=arng.uniform(0, math.tau))
    for (px, pz) in ((-20.4, -8.2), (-20.5, -7.6), (-23.2, -19.5), (-23.3, -35.0), (-20.4, -42.0), (-20.6, -42.6), (-23.2, -52.6), (-22.9, -53.3), (-23.1, -62.0), (-14.0, sq1 - 0.4), (-17.5, sum(passages['broker']) / 2 + 0.6), (-13.5, dp1 - 0.5)):
        level.prop('trashbag', px, pz, yaw=arng.uniform(0, math.tau), scale=arng.uniform(0.85, 1.15))
    for (px, pz) in ((-20.5, -10.6), (-23.0, -29.0), (-20.4, -60.5), (-14.6, dp0 + 0.4)):
        level.prop('cardboard_box_01', px, pz, yaw=arng.uniform(0, math.tau))
    for (px, pz) in ((-23.0, -45.6), (-16.8, sq1 - 0.6)):
        level.prop('old_tyre', px, pz, yaw=arng.uniform(0, math.tau))
    for index, (x, z, dx) in enumerate(((-ALLEY_IN - 0.3, -25.5, -0.5), (-ALLEY_OUT + 0.3, -60.5, 0.5))):
        level.empty(f'steam_alley_{index}', x, 0.4, z, {'type': 'vfx', 'preset': 'steam', 'dx': dx, 'dy': 0.8, 'dz': 0.1}, display='SINGLE_ARROW', size=0.6)

    # ---- the overwatch: a fire escape up the east facades ---------------------------
    # A stair climbs from the square's corner to a catwalk at 4.5 m that runs past
    # the square and over the broker's beat. The stair is a tilted box collider
    # under rendered treads, so the character controller walks it and the
    # navmesh covers it (hostiles can follow). A knee-high apron along the street
    # edge stops a walk-off without being cover from the street.
    ox0, ox1 = OVERWATCH_X
    oz0, oz1 = OVERWATCH_Z
    oy = OVERWATCH_Y
    sx0, sx1 = STAIR_X
    floor = ((ox0 + ox1) / 2, oy - 0.05, (oz0 + oz1) / 2, (ox1 - ox0) / 2, 0.05, (oz1 - oz0) / 2)
    fire_escape.box(*floor)
    level.collider('overwatch_floor', *floor)
    apron = 0.6
    for (ax, az, ahx, ahz, label) in ((ox0 + 0.03, (oz0 + oz1) / 2, 0.03, (oz1 - oz0) / 2, 'side'), ((ox0 + ox1) / 2, oz0 + 0.03, (ox1 - ox0) / 2, 0.03, 'end')):
        fire_escape.box(ax, oy + apron / 2, az, ahx, apron / 2, ahz)
        level.collider(f'overwatch_apron_{label}', ax, oy + apron / 2, az, ahx, apron / 2, ahz)
    pz = oz0
    while pz <= oz1 + 1e-6:
        pipes.segment((ox0 + 0.03, oy, pz), (ox0 + 0.03, oy + 1.05, pz), 0.025)
        pz += 1.5
    pipes.segment((ox0 + 0.03, oy + 1.05, oz0), (ox0 + 0.03, oy + 1.05, oz1), 0.03)
    pipes.segment((ox0 + 0.03, oy + 1.05, oz0), (ox1 - 0.05, oy + 1.05, oz0), 0.03)
    bz = oz0 + 1.0
    while bz < oz1:
        # Brackets from the wall up to the floor's street edge.
        pipes.segment((ox1 - 0.04, oy - 1.3, bz), (ox0 + 0.12, oy - 0.1, bz), 0.04)
        bz += 3.0
    level.ramp('overwatch_stair', (sx0 + sx1) / 2, (sx1 - sx0) / 2, (STAIR_FOOT_Z, 0.0), (oz1, oy))
    run = (STAIR_FOOT_Z - oz1) / STAIR_STEPS
    for k in range(1, STAIR_STEPS + 1):
        # Treads straddle the ramp: half a riser above it at the nosing, half below at the back.
        fire_escape.box((sx0 + sx1) / 2, (k - 0.5) * oy / STAIR_STEPS - 0.02, STAIR_FOOT_Z - (k - 0.5) * run, (sx1 - sx0) / 2 - 0.06, 0.02, run / 2 - 0.02)
    for sx in (sx0 + 0.03, sx1 - 0.03):
        fire_escape.segment((sx, -0.05, STAIR_FOOT_Z), (sx, oy - 0.05, oz1), 0.06)
    pipes.segment((sx0 + 0.03, 0.95, STAIR_FOOT_Z), (sx0 + 0.03, oy + 1.05, oz1), 0.03)
    for k in range(0, STAIR_STEPS + 1, 3):
        pz = STAIR_FOOT_Z - k * run
        sy = k * oy / STAIR_STEPS
        pipes.segment((sx0 + 0.03, sy, pz), (sx0 + 0.03, sy + 0.95, pz), 0.022)
    # A caged bulb at the stair head: the climb is lit, the far end over the broker is not.
    roofs.box(ox1 - 0.12, oy + 2.15, oz1 + 0.6, 0.12, 0.08, 0.16)
    lamp_glow.box(ox1 - 0.12, oy + 2.05, oz1 + 0.6, 0.06, 0.035, 0.09)
    # Two cage bulbs under the catwalk, so its line reads from the street.
    for bz in (-23.0, -34.0):
        lamp_glow.box(ox1 - 0.05, oy - 0.55, bz, 0.05, 0.035, 0.08)
    level.empty('overwatch_lamp', ox1 - 0.3, oy + 2.0, oz1 + 0.6, {'type': 'light', 'color': '#ffb46a', 'intensity': 7.0, 'range': 6.0}, display='SPHERE', size=0.25)

    # ---- gameplay ---------------------------------------------------------------------
    spawn_z = STREET_Z_MAX - 6
    level.empty('spawn_operator', 0, 0, spawn_z, {'type': 'spawn', 'team': 'player', 'yaw': 0.0}, display='ARROWS', size=1.0)
    # Insert -> three objectives -> extract (docs/design/mission-shape.md). The
    # broker is a tagged Eliminate: the objective names his patrol route. The
    # charge burns for `fuse` seconds after the hold, and a hostile who stands
    # at it for `defuse` seconds pulls it off the wall.
    broker_at = (-7, 0, -38)
    objectives = [
        ('square', 'reach', 'Reach the square', 0, 0, -8, 3.0, {}),
        ('broker', 'eliminate', 'Eliminate the broker', *broker_at, 1.0, {'target': 'Broker'}),
        # Against the depot wall itself (its face is at STREET_Z_MIN).
        ('charge', 'plant', 'Set the charge on the depot wall', 0, 0, STREET_Z_MIN + 1.4, 2.2, {'hold': 3.0, 'fuse': 20.0, 'defuse': 4.0}),
        ('extract', 'extract', 'Extract at the insert', 0, 0, spawn_z, 3.0, {}),
    ]
    for order, (oid, kind, label, x, y, z, radius, extra) in enumerate(objectives):
        level.empty(
            f'objective_{oid}', x, y, z,
            {'type': 'objective', 'id': oid, 'kind': kind, 'label': label, 'radius': radius, 'order': order, **extra},
            display='CIRCLE', size=radius,
        )
    # The garrison: eight riflemen and the broker, on loops that overlap enough to cover every
    # lane, spread from the insert end to the depot (Milestone 10 wants 8 to 12
    # with routes). Reinforcements land on top of these, capped at 12 live.
    broker_passage_z = sum(passages['broker']) / 2
    patrols = {
        'Rifleman 1': [(5, 0, -4), (-2, 0, -12), (-4, 0, 6)],
        'Rifleman 2': [(4, 0, -24), (-5, 0, -34)],
        'Rifleman 3': [(0, 0, -52), (6, 0, -42), (-6, 0, -44)],
        # Kept off the insert: a route that reaches z=20 puts a rifleman 14 m
        # from the spawn, which is inside his sight cone before the player has
        # moved. The mission opens quiet or it is not a stealth mission.
        'Rifleman 4': [(7, 0, 12), (-4, 0, 6), (6, 0, 2)],
        # The alley's watcher: up and down the lane from behind the square to past
        # the broker's passage, then halfway down that passage to look at the
        # street. Taking the alley means getting past him in a three-metre lane.
        # (The square keeps Riflemen 1 and 8; this route used to be a third.)
        'Rifleman 5': [(ALLEY_X, 0, -10), (ALLEY_X, 0, -44), (-15.5, 0, broker_passage_z)],
        'Rifleman 6': [(-5, 0, -62), (5, 0, -64), (2, 0, -56)],
        'Rifleman 7': [(-6, 0, -28), (6, 0, -36), (-4, 0, -40)],
        'Rifleman 8': [(7, 0, -2), (7, 0, -20), (2, 0, -30)],
        # The objective: a short beat under the west neon, inside Rifleman 2's
        # and 7's loops, so reaching him quietly means slipping two watchers.
        'Broker': [broker_at, (-3, 0, -40), (-6, 0, -34)],
    }
    roles = {'Broker': 'hvt'}
    for route, points in patrols.items():
        for index, (x, y, z) in enumerate(points):
            props = {'type': 'patrol', 'route': route, 'index': index}
            if route in roles:
                props['role'] = roles[route]
            level.empty(f'patrol_{route.replace(" ", "_")}_{index}', x, y, z, props, display='CONE', size=0.6)
    # Where the sector sends hostiles in from once the alert model escalates
    # (docs/design/mission-shape.md, apps/showcase/src/mission/Alert.ts). The
    # alerted wave comes from the depot end the player is heading into; the
    # lockdown wave adds the flanks and one behind, on the extraction leg, so
    # a loud run has to fight its way back out.
    reinforcements = [
        # Off to the side of the plant site: the first arrival after the alarm comes round the corner, not out of the charge.
        ('depot_north', 'alerted', -6.5, 0, -66, 'Rifleman 3'),
        # In from the alley, by the broker's passage: once the street is loud the dark lane is not empty either.
        ('side_west', 'alerted', ALLEY_X, 0, broker_passage_z - 1.5, 'Rifleman 2'),
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

    for batch in (windows, ledges, pipes, cables, shutters, roofs, bollards, *awning_batches, lane_brick, alley_metal, fire_escape, lamp_glow):
        batch.finish()
    return {
        'faces': len(building_faces),
        'windows': windows.count,
        'props': sum(level.prop_counts.values()),
        'passages': {pid: (round(g0, 2), round(g1, 2)) for pid, (g0, g1) in passages.items()},
        'vault_gap': (round(vault_gap[0], 2), round(vault_gap[1], 2)),
    }


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
