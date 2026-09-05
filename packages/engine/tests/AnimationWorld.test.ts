import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { AnimationWorld, Animator } from '../src/animation/Animator';
import { createAnimationSystems } from '../src/animation/systems';
import type { AnimationGraphDef } from '../src/animation/AnimationGraph';
import { Transform, Velocity } from '../src/ecs/components/Transform';
import { EntityWorld } from '../src/ecs/EntityWorld';

// Integration: the three-backed AnimationWorld over a tiny procedural rig
// (root → hips → arm). No renderer; the mixer and bones are plain objects.

const DT = 1 / 60;

function makeRig(): { root: THREE.Group; bones: Record<string, THREE.Bone>; clips: THREE.AnimationClip[] } {
  const rootBone = new THREE.Bone();
  rootBone.name = 'root';
  rootBone.userData['spark.rootBone'] = true;
  const hips = new THREE.Bone();
  hips.name = 'hips';
  hips.position.set(0, 1, 0);
  const arm = new THREE.Bone();
  arm.name = 'upperArm_R';
  arm.position.set(0.3, 0.4, 0);
  rootBone.add(hips);
  hips.add(arm);
  const root = new THREE.Group();
  root.add(rootBone);

  const q = (x: number): number[] => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, 0, 0)).toArray();
  const walk = new THREE.AnimationClip('walk', 1, [
    new THREE.VectorKeyframeTrack('root.position', [0, 1], [0, 0, 0, 0, 0, 1.2]),
    new THREE.VectorKeyframeTrack('hips.position', [0, 0.5, 1], [0, 1, 0, 0, 0.95, 0, 0, 1, 0]),
    new THREE.QuaternionKeyframeTrack('upperArm_R.quaternion', [0, 0.5, 1], [...q(0), ...q(0.5), ...q(0)]),
  ]);
  walk.userData['spark.events'] = [{ name: 'footstep', time: 0.25 }];
  const idle = new THREE.AnimationClip('idle', 2, [new THREE.VectorKeyframeTrack('hips.position', [0, 2], [0, 1, 0, 0, 1, 0])]);
  const attack = new THREE.AnimationClip('attack', 0.5, [
    new THREE.QuaternionKeyframeTrack('upperArm_R.quaternion', [0, 0.25, 0.5], [...q(0), ...q(-1.2), ...q(0)]),
    new THREE.VectorKeyframeTrack('hips.position', [0, 0.5], [0, 1, 0, 0, 1.5, 0]),
  ]);
  attack.userData['spark.loop'] = false;
  attack.userData['spark.events'] = [{ name: 'hit', time: 0.25 }];
  return { root, bones: { root: rootBone, hips, arm }, clips: [walk, idle, attack] };
}

const GRAPH: AnimationGraphDef = {
  params: { speed: 0 },
  layers: [
    {
      entry: 'locomotion',
      states: [
        {
          name: 'locomotion',
          blend: {
            param: 'speed',
            points: [
              { clip: 'idle', threshold: 0 },
              { clip: 'walk', threshold: 1 },
            ],
          },
        },
      ],
    },
    {
      entry: 'none',
      mask: ['upperArm_R'],
      states: [{ name: 'none' }, { name: 'attack', clip: 'attack', transitions: [{ to: 'none', exitTime: 1, duration: 0 }] }],
      anyState: [{ to: 'attack', conditions: [{ trigger: 'attack' }], duration: 0 }],
    },
  ],
};

function fixture(): { entities: EntityWorld; animation: AnimationWorld; frame(): void; dispose(): void } {
  const entities = new EntityWorld({ capacity: 64 });
  const animation = new AnimationWorld(entities);
  for (const s of createAnimationSystems(animation)) entities.addSystem(s);
  return {
    entities,
    animation,
    frame(): void {
      entities.runStage('fixed', DT);
      entities.runStage('update', DT);
      entities.runStage('late', DT);
    },
    dispose(): void {
      entities.dispose();
      animation.dispose();
    },
  };
}

describe('AnimationWorld', () => {
  it('attaches, adds the Animator component and poses the entry state immediately', () => {
    const f = fixture();
    const rig = makeRig();
    const eid = f.entities.create([Transform, {}]);
    f.animation.attach(eid, rig.root, rig.clips, GRAPH);
    expect(f.entities.has(eid, Animator)).toBe(true);
    expect(f.animation.getState(eid)).toBe('locomotion');
    expect(f.animation.getState(eid, 1)).toBe('none');
    expect(f.animation.count).toBe(1);
    expect(() => f.animation.attach(eid, rig.root, rig.clips, { layers: [{ entry: 'a', states: [{ name: 'a', clip: 'nope' }] }] })).toThrow(
      /references clip "nope"/,
    );
    f.dispose();
  });

  it('walk root motion moves the Transform along the facing and pins the root bone', () => {
    const f = fixture();
    const rig = makeRig();
    // Facing +X: 90 degrees about Y.
    const eid = f.entities.create([Transform, { qy: Math.SQRT1_2, qw: Math.SQRT1_2 }]);
    f.animation.attach(eid, rig.root, rig.clips, GRAPH);
    f.animation.setParam(eid, 'speed', 1);
    for (let i = 0; i < 120; i++) f.frame();
    const t = f.entities.store(Transform);
    // Two walk loops = 2.4 m; the update-stage delta lands on the next fixed step, so one frame is still pending.
    expect(t.x[eid]).toBeCloseTo(2.4 - 1.2 * DT, 3);
    expect(Math.abs(t.z[eid] ?? 0)).toBeLessThan(1e-4);
    expect(t.y[eid]).toBe(0);
    expect(rig.bones.root.position.x).toBe(0);
    expect(rig.bones.root.position.z).toBe(0);
    // The skeleton is still animated: mid-loop the hips are below their rest height.
    for (let i = 0; i < 15; i++) f.frame();
    expect(rig.bones.hips.position.y).toBeLessThan(1);
    expect(rig.bones.root.position.x).toBe(0);
    f.dispose();
  });

  it('root motion respects the Animator.rootMotion flag, the mode and the speed multiplier', () => {
    const f = fixture();
    const a = f.entities.store(Animator);
    const t = f.entities.store(Transform);

    const off = f.entities.create([Transform, {}]);
    f.animation.attach(off, makeRig().root, makeRig().clips, GRAPH, { rootMotion: { mode: 'none' } });
    f.animation.setParam(off, 'speed', 1);

    const flagged = f.entities.create([Transform, {}]);
    f.animation.attach(flagged, makeRig().root, makeRig().clips, GRAPH);
    f.animation.setParam(flagged, 'speed', 1);
    a.rootMotion[flagged] = 0;

    const fast = f.entities.create([Transform, {}]);
    f.animation.attach(fast, makeRig().root, makeRig().clips, GRAPH);
    f.animation.setParam(fast, 'speed', 1);
    a.speed[fast] = 2;

    const vel = f.entities.create([Transform, {}], Velocity);
    f.animation.attach(vel, makeRig().root, makeRig().clips, GRAPH, { rootMotion: { mode: 'velocity' } });
    f.animation.setParam(vel, 'speed', 1);

    for (let i = 0; i < 61; i++) f.frame();
    expect(t.z[off]).toBe(0);
    expect(t.z[flagged]).toBe(0);
    expect(t.z[fast]).toBeCloseTo(2.4, 3);
    expect(t.z[vel]).toBe(0);
    expect(f.entities.store(Velocity).z[vel]).toBeCloseTo(1.2, 3);
    f.dispose();
  });

  it('blends root motion by weight', () => {
    const f = fixture();
    const rig = makeRig();
    const eid = f.entities.create([Transform, {}]);
    f.animation.attach(eid, rig.root, rig.clips, GRAPH);
    f.animation.setParam(eid, 'speed', 0.5); // half idle (no motion), half walk
    for (let i = 0; i < 61; i++) f.frame();
    // Blend duration is 1.5 s, so one second covers 2/3 of a walk loop at half weight: 1.2 * 2/3 * 0.5.
    expect(f.entities.store(Transform).z[eid]).toBeCloseTo(1.2 * (2 / 3) * 0.5, 3);
    f.dispose();
  });

  it('fires events through the global emitter and per-entity listeners', () => {
    const f = fixture();
    const rig = makeRig();
    const eid = f.entities.create([Transform, {}]);
    f.animation.attach(eid, rig.root, rig.clips, GRAPH);
    f.animation.setParam(eid, 'speed', 1);
    const global: string[] = [];
    const local: number[] = [];
    f.animation.events.on('event', (e) => global.push(`${e.eid}:${e.name}@${e.time}`));
    const off = f.animation.on(eid, 'footstep', (e) => local.push(e.time));
    for (let i = 0; i < 60; i++) f.frame();
    expect(global).toEqual([`${eid}:footstep@0.25`]);
    expect(local).toEqual([0.25]);
    expect(f.animation.lastEvent(eid)?.name).toBe('footstep');
    off();
    for (let i = 0; i < 60; i++) f.frame();
    expect(global.length).toBe(2);
    expect(local.length).toBe(1);
    f.dispose();
  });

  it('additive masked layer only touches masked bones and reports transitions', () => {
    const f = fixture();
    const rig = makeRig();
    const eid = f.entities.create([Transform, {}]);
    f.animation.attach(eid, rig.root, rig.clips, GRAPH);
    const transitions: string[] = [];
    f.animation.events.on('transition', (t) => transitions.push(`${t.layer}:${t.from}->${t.to}`));
    f.frame();
    const armBefore = rig.bones.arm.quaternion.clone();
    const hipsBefore = rig.bones.hips.position.y;
    f.animation.setTrigger(eid, 'attack');
    for (let i = 0; i < 17; i++) f.frame(); // transition frame + 16 steps = 0.267 s: past the 0.25 s peak / hit marker
    expect(f.animation.getState(eid, 1)).toBe('attack');
    expect(rig.bones.arm.quaternion.angleTo(armBefore)).toBeGreaterThan(0.5);
    // hips.position is animated by attack but masked out: unchanged by the upper layer.
    expect(rig.bones.hips.position.y).toBeCloseTo(hipsBefore, 6);
    expect(f.animation.lastEvent(eid)?.name).toBe('hit');
    for (let i = 0; i < 20; i++) f.frame();
    expect(f.animation.getState(eid, 1)).toBe('none');
    expect(rig.bones.arm.quaternion.angleTo(armBefore)).toBeLessThan(1e-3);
    expect(transitions).toEqual(['1:none->attack', '1:attack->none']);
    // Layer weight from the component scales the additive contribution.
    f.entities.store(Animator).layer1[eid] = 0;
    f.animation.setTrigger(eid, 'attack');
    for (let i = 0; i < 15; i++) f.frame();
    expect(rig.bones.arm.quaternion.angleTo(armBefore)).toBeLessThan(1e-3);
    f.dispose();
  });

  it('play(), advance() and detach on destroy', () => {
    const f = fixture();
    const rig = makeRig();
    const eid = f.entities.create([Transform, {}]);
    f.animation.attach(eid, rig.root, rig.clips, GRAPH);
    f.animation.play(eid, 'attack', 1, { duration: 0, offset: 0.5 });
    expect(f.animation.snapshot(eid, 1).phase).toBe(0.5);
    const fired: string[] = [];
    f.animation.events.on('event', (e) => fired.push(e.name));
    f.animation.setParam(eid, 'speed', 1);
    f.animation.advance(eid, 0.5); // silent: no events, no root motion
    expect(fired).toEqual([]);
    f.frame();
    expect(f.entities.store(Transform).z[eid]).toBe(0);
    expect(f.animation.stats().animators).toBe(1);
    f.entities.destroy(eid);
    expect(f.animation.has(eid)).toBe(false);
    expect(f.animation.stats().animators).toBe(0);
    f.frame(); // nothing to step
    f.dispose();
  });
});

describe('override layers', () => {
  it('replaces the base pose on masked bones by the layer weight and leaves the rest alone', async () => {
    const { overrideBoost } = await import('../src/animation/Animator');
    expect(overrideBoost(0)).toBe(0);
    expect(overrideBoost(0.5)).toBeCloseTo(1);
    expect(overrideBoost(0.9)).toBeCloseTo(9);
    expect(overrideBoost(1)).toBe(1000);

    const f = fixture();
    const rig = makeRig();
    const eid = f.entities.create([Transform, {}]);
    // Base: attack holds the arm bent (frame 0.25 is -1.2 rad) and lifts the hips; override: idle keeps hips at rest, arm untouched.
    const graph: AnimationGraphDef = {
      layers: [
        { entry: 'attack', states: [{ name: 'attack', clip: 'attack', speed: 0 }] },
        { entry: 'idle', additive: false, mask: ['hips'], states: [{ name: 'idle', clip: 'idle' }] },
      ],
    };
    f.animation.attach(eid, rig.root, rig.clips, graph, { rootMotion: { mode: 'none' } });
    const a = f.entities.store(Animator);
    a.layer1[eid] = 1;
    f.frame();
    // Hips: override wins (idle holds y = 1, attack frame 0 also has y = 1; step the attack to mid-clip to see a difference).
    f.animation.play(eid, 'attack', 0, { offset: 0.5, duration: 0 });
    f.frame();
    expect(rig.bones.hips.position.y).toBeCloseTo(1, 2);
    // The arm is not in the mask: the base pose stays.
    expect(Math.abs(new THREE.Euler().setFromQuaternion(rig.bones.arm.quaternion).x)).toBeGreaterThan(0.5);
    // Half weight: hips halfway between the base (1.25 at mid-clip) and the override (1).
    a.layer1[eid] = 0.5;
    f.frame();
    expect(rig.bones.hips.position.y).toBeGreaterThan(1.05);
    expect(rig.bones.hips.position.y).toBeLessThan(1.25);
    a.layer1[eid] = 0;
    f.frame();
    expect(rig.bones.hips.position.y).toBeGreaterThan(1.2);
    f.dispose();
  });
});
