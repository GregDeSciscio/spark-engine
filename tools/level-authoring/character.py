"""
Retarget the Universal Animation Library clips onto Quaternius' Cyberpunk Game
Kit character, headless:

    blender --background --python tools/level-authoring/character.py -- \
        <ual.gltf> <SK_Character.usda> <out-dir> [Clip1,Clip2,...]

Both rigs rest in a T-pose. For every mapped target bone the retarget takes
the source bone's rotation *delta from its rest* and applies it to the target
bone's rest, in armature space, so proportions can differ and the target keeps
its own silhouette; limb bones are first aligned so their rest direction
matches the source's (both are T-posed, so this is a hair's rotation here,
but it makes the script survive an A-posed target later). The hips copy the
source hips' travel scaled by the hip-height ratio, so crouches and the death
fall land on the floor. The kit's foot bones are IK-style controls parented to
the root; they are reparented under the shins first (keeping their rest
offset) so they follow the legs in the engine's ragdoll as well as here.

The target is scaled to `TARGET_HEIGHT` (the kit character is 1.37 m) with the
scale applied, so the export carries no node scale (the engine's ragdoll
assumes unit-scaled bone chains). Each clip is exported as its own GLB,
`<out-dir>/<ClipName>.glb`, with the action active and the scene range set to
it: in Blender 5.1 the NLA-track and per-action export modes flatten actions
baked from Python to a single key per channel. The node build
(`tools/asset-pipeline/build-character.mjs --rig=cyberpunk`) merges the files
into one model, renames the clips and adds the `spark.*` extras.
"""

import os
import shutil
import sys

import bpy
from mathutils import Matrix, Vector

TARGET_HEIGHT = 1.8

# target bone -> source bone. `align` limb bones onto the source rest direction.
MAP = {
    'Body': ('DEF-hips', False),
    'Abdomen': ('DEF-spine.001', False),
    'Torso': ('DEF-spine.002', False),
    'Chest': ('DEF-spine.003', False),
    'Neck': ('DEF-neck', False),
    'Head': ('DEF-head', False),
    'Shoulder_L': ('DEF-shoulder.L', False),
    'UpperArm_L': ('DEF-upper_arm.L', True),
    'LowerArm_L': ('DEF-forearm.L', True),
    'Hand_L': ('DEF-hand.L', True),
    'Shoulder_R': ('DEF-shoulder.R', False),
    'UpperArm_R': ('DEF-upper_arm.R', True),
    'LowerArm_R': ('DEF-forearm.R', True),
    'Hand_R': ('DEF-hand.R', True),
    'UpperLeg_L': ('DEF-thigh.L', True),
    'LowerLeg_L': ('DEF-shin.L', True),
    'UpperLeg_R': ('DEF-thigh.R', True),
    'LowerLeg_R': ('DEF-shin.R', True),
    'Foot_L': ('DEF-foot.L', False),
    'Foot_R': ('DEF-foot.R', False),
}
HIPS = 'Body'
SRC_HIPS = 'DEF-hips'
# IK-style foot bones -> the shin they belong to.
FEET = {'Foot_L': 'LowerLeg_L', 'Foot_R': 'LowerLeg_R'}
# The kit's sword mesh: it is weighted to the Weapon socket and the game brings its own rifle.
DROP_MATERIALS = {'Blade', 'Blade_Edge'}


def log(msg):
    print(f'character: {msg}', flush=True)


def import_source(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    objs = set(bpy.data.objects) - before
    arm = next(o for o in objs if o.type == 'ARMATURE')
    ad = arm.animation_data
    actions = []
    for track in list(ad.nla_tracks):
        for strip in track.strips:
            actions.append(strip.action)
        ad.nla_tracks.remove(track)
    ad.action = None
    # Everything but the armature can go: the mesh only slows frame evaluation.
    for o in objs:
        if o is not arm:
            bpy.data.objects.remove(o, do_unlink=True)
    return arm, actions


def import_target(path):
    before = set(bpy.data.objects)
    bpy.ops.wm.usd_import(filepath=path, import_skeletons=True, import_blendshapes=False)
    objs = set(bpy.data.objects) - before
    arm = next(o for o in objs if o.type == 'ARMATURE')
    meshes = [o for o in objs if o.type == 'MESH']
    keep = []
    dropped = []
    for m in meshes:
        names = {mat.name for mat in m.data.materials if mat}
        (dropped if names & DROP_MATERIALS else keep).append(m)
    empties = [o for o in objs if o.type == 'EMPTY']
    for m in dropped:
        bpy.data.objects.remove(m, do_unlink=True)
    # Flatten: drop the USD Xform empties, keep world transforms.
    bpy.ops.object.select_all(action='DESELECT')
    for o in [arm, *keep]:
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    for o in empties:
        bpy.data.objects.remove(o, do_unlink=True)
    for m in keep:
        m.parent = arm
        m.matrix_parent_inverse = arm.matrix_world.inverted()
    reparent_feet(arm)
    return arm, keep


def reparent_feet(arm):
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    for foot, shin in FEET.items():
        eb[foot].use_connect = False
        eb[foot].parent = eb[shin]
    bpy.ops.object.mode_set(mode='OBJECT')
    log(f'feet reparented under the shins: {FEET}')


def scale_target(arm, meshes, height):
    bpy.context.view_layer.update()
    top = max((m.matrix_world @ Vector(c)).z for m in meshes for c in m.bound_box)
    bottom = min((m.matrix_world @ Vector(c)).z for m in meshes for c in m.bound_box)
    s = height / (top - bottom)
    for o in [arm, *meshes]:
        o.matrix_world = Matrix.Scale(s, 4) @ o.matrix_world
    bpy.ops.object.select_all(action='DESELECT')
    for o in [arm, *meshes]:
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.context.view_layer.update()
    log(f'target scaled x{s:.3f} to {height} m (was {top - bottom:.3f})')
    return s


def rest_dir(bone):
    return (bone.tail_local - bone.head_local).normalized()


class Retarget:
    def __init__(self, src, tgt):
        self.src = src
        self.tgt = tgt
        self.order = []  # target bones, parents first

        def walk(b):
            self.order.append(b)
            for c in b.children:
                walk(c)

        for b in tgt.data.bones:
            if b.parent is None:
                walk(b)
        # Rest data.
        self.rest_local = {}
        self.ref_rot = {}
        for b in self.order:
            ml = b.matrix_local
            self.rest_local[b.name] = (b.parent.matrix_local.inverted() @ ml) if b.parent else ml.copy()
        for tname, (sname, align) in MAP.items():
            tb = tgt.data.bones[tname]
            sb = src.data.bones[sname]
            src_rot0 = sb.matrix_local.to_3x3()
            tgt_rot0 = tb.matrix_local.to_3x3()
            if align:
                a = rest_dir(tb).rotation_difference(rest_dir(sb)).to_matrix()
                tgt_rot0 = a @ tgt_rot0
            self.ref_rot[tname] = (src_rot0.inverted(), tgt_rot0)
        hips_t = tgt.data.bones[HIPS].head_local
        hips_s = src.data.bones[SRC_HIPS].head_local
        self.hips_rest_t = hips_t.copy()
        self.hips_rest_s = hips_s.copy()
        self.hips_ratio = hips_t.z / hips_s.z if hips_s.z > 1e-6 else 1.0
        log(f'hips travel ratio {self.hips_ratio:.3f} ({len(MAP)} bones mapped, {len(self.order)} in the target)')

    def pose_frame(self):
        """Compute target pose matrices (armature space) from the source's current pose and write the bases."""
        src_pose = self.src.pose.bones
        tgt_pose = self.tgt.pose.bones
        desired = {}
        for b in self.order:
            name = b.name
            parent_m = desired[b.parent.name] if b.parent else Matrix.Identity(4)
            follow = parent_m @ self.rest_local[name]
            m = follow.copy()
            if name in MAP:
                sname = MAP[name][0]
                src_inv0, tgt_rot0 = self.ref_rot[name]
                src_rot = src_pose[sname].matrix.to_3x3()
                rot = (src_rot @ src_inv0 @ tgt_rot0).to_4x4()
                if name == HIPS:
                    travel = (src_pose[SRC_HIPS].matrix.translation - self.hips_rest_s) * self.hips_ratio
                    pos = self.hips_rest_t + travel
                else:
                    pos = follow.translation
                m = rot
                m.translation = pos
            desired[name] = m
            basis = follow.inverted() @ m
            pb = tgt_pose[name]
            pb.matrix_basis = basis
        return desired

    def verify(self):
        """After a view-layer update, the pose bones must sit where the bases said."""
        desired = self.pose_frame()
        bpy.context.view_layer.update()
        worst = 0.0
        for name, m in desired.items():
            pb = self.tgt.pose.bones[name]
            for r in range(3):
                for c in range(4):
                    worst = max(worst, abs(pb.matrix[r][c] - m[r][c]))
        log(f'pose check: max deviation {worst:.5f}')
        if worst > 1e-3:
            raise RuntimeError('pose bone matrices disagree with the computed bases; check inherit flags')


def assign_action(arm, action):
    ad = arm.animation_data or arm.animation_data_create()
    ad.action = action
    slots = getattr(action, 'slots', None)
    if slots is not None and hasattr(ad, 'action_slot'):
        if len(slots) == 0:
            slots.new(id_type='OBJECT', name=arm.name)
        ad.action_slot = slots[0]


def bake(src, tgt, actions, wanted, rt):
    scene = bpy.context.scene
    for pb in tgt.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    keyed = {n for n in MAP} | {HIPS}
    out = []
    for act in actions:
        if wanted and act.name not in wanted:
            continue
        assign_action(src, act)
        start, end = act.frame_range
        start, end = int(round(start)), int(round(end))
        new = bpy.data.actions.new(act.name)
        new.use_fake_user = True
        assign_action(tgt, new)
        for f in range(start, end + 1):
            scene.frame_set(f)
            rt.pose_frame()
            for name in keyed:
                pb = tgt.pose.bones[name]
                pb.keyframe_insert('rotation_quaternion', frame=f)
                if name == HIPS:
                    pb.keyframe_insert('location', frame=f)
        out.append((new, start, end, act.name))
        log(f'baked {act.name}: frames {start}-{end}')
    src.animation_data.action = None
    return out


def export(tgt, meshes, out_dir, baked):
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    tgt.select_set(True)
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = tgt
    scene = bpy.context.scene
    for new, start, end, name in baked:
        assign_action(tgt, new)
        scene.frame_start = start
        scene.frame_end = end
        scene.frame_set(start)
        bpy.ops.export_scene.gltf(
            filepath=os.path.join(out_dir, f'{name}.glb'),
            export_format='GLB',
            use_selection=True,
            export_extras=True,
            export_apply=True,
            export_yup=True,
            export_materials='EXPORT',
            export_animations=True,
            export_animation_mode='SCENE',
            export_force_sampling=True,
            export_frame_range=False,
            export_optimize_animation_size=False,
            export_rest_position_armature=True,
            export_skins=True,
            export_def_bones=False,
            export_normals=True,
            export_tangents=False,
            export_lights=False,
        )
    tgt.animation_data.action = None
    log(f'wrote {len(baked)} clip file(s) to {out_dir}')


def main(argv):
    ual, usda, out = argv[0], argv[1], argv[2]
    wanted = set(argv[3].split(',')) if len(argv) > 3 and argv[3] else None
    bpy.ops.wm.read_factory_settings(use_empty=True)
    src, actions = import_source(ual)
    log(f'source {src.name}: {len(src.data.bones)} bones, {len(actions)} clips, fps {bpy.context.scene.render.fps}')
    tgt, meshes = import_target(usda)
    log(f'target {tgt.name}: {len(tgt.data.bones)} bones, meshes {[m.name for m in meshes]}')
    scale_target(tgt, meshes, TARGET_HEIGHT)
    for i, m in enumerate(meshes):
        m.name = 'Character' if i == 0 else f'Character_{i}'
    tgt.name = 'CharacterArmature'
    rt = Retarget(src, tgt)
    bpy.context.scene.frame_set(1)
    rt.verify()
    baked = bake(src, tgt, actions, wanted, rt)
    if not baked:
        raise RuntimeError('no clips baked')
    export(tgt, meshes, out, baked)


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if len(args) < 3:
        print(__doc__)
        sys.exit(2)
    main(args)
