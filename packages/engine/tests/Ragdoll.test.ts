import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { Transform } from '../src/ecs/components/Transform';
import { EntityWorld } from '../src/ecs/EntityWorld';
import { PhysicsWorld, initRapier } from '../src/physics/PhysicsWorld';
import { RagdollWorld } from '../src/physics/Ragdoll';
import { createPhysicsSystems } from '../src/physics/systems';

const DT = 1 / 60;

interface Fixture {
  entities: EntityWorld;
  physics: PhysicsWorld;
  ragdolls: RagdollWorld;
  tick(n?: number): void;
  dispose(): void;
}

async function fixture(): Promise<Fixture> {
  const entities = new EntityWorld({ capacity: 256 });
  const physics = await PhysicsWorld.create({ entities, fixedStepHz: 60 });
  physics.layers.define('world', 'ragdoll');
  for (const s of createPhysicsSystems(physics)) entities.addSystem(s);
  const ragdolls = new RagdollWorld(entities, physics);
  entities.addSystem(ragdolls.system());
  const ground = entities.create([Transform, { y: -0.5 }]);
  physics.addBody(ground, { type: 'fixed', shape: { kind: 'box', hx: 20, hy: 0.5, hz: 20 }, layer: 'world' });
  return {
    entities,
    physics,
    ragdolls,
    tick(n = 1): void {
      for (let i = 0; i < n; i++) {
        entities.runStage('fixed', DT);
        entities.runStage('update', DT);
      }
    },
    dispose(): void {
      ragdolls.dispose();
      entities.dispose();
      physics.dispose();
    },
  };
}

/** A three-bone chain standing upright at y=2: hips → spine → head, each 0.3 m. */
function skeleton(): { root: THREE.Object3D; hips: THREE.Bone; spine: THREE.Bone; head: THREE.Bone } {
  const root = new THREE.Object3D();
  root.name = 'character';
  root.position.set(0, 2, 0);
  const hips = new THREE.Bone();
  hips.name = 'hips';
  const spine = new THREE.Bone();
  spine.name = 'spine';
  spine.position.set(0, 0.3, 0);
  const head = new THREE.Bone();
  head.name = 'head';
  head.position.set(0, 0.3, 0);
  hips.add(spine);
  spine.add(head);
  root.add(hips);
  root.updateMatrixWorld(true);
  return { root, hips, spine, head };
}

const CONFIG = {
  bones: [
    { bone: 'hips', radius: 0.08 },
    { bone: 'spine', radius: 0.07 },
    { bone: 'head', radius: 0.08, length: 0.2 },
  ],
  layer: 'ragdoll',
  collidesWith: ['world'],
};

beforeAll(async () => {
  await initRapier();
});

describe('RagdollWorld', () => {
  it('builds one body per bone, chained by joints, and the chain falls and lands', async () => {
    const f = await fixture();
    const { root, hips, spine } = skeleton();
    const owner = f.entities.create(Transform);
    const r = f.ragdolls.create(owner, root, CONFIG, { blendSeconds: 0 });
    expect(r.parts.length).toBe(3);
    expect(f.ragdolls.count).toBe(1);
    const hipsStart = hips.getWorldPosition(new THREE.Vector3()).y;
    f.tick(240);
    const hipsNow = hips.getWorldPosition(new THREE.Vector3());
    const spineNow = spine.getWorldPosition(new THREE.Vector3());
    expect(hipsNow.y).toBeLessThan(hipsStart - 1);
    expect(hipsNow.y).toBeGreaterThan(-0.2);
    // The joint keeps the spine attached to the hips.
    expect(spineNow.distanceTo(hipsNow)).toBeLessThan(0.45);
    expect(r.age).toBeCloseTo(4, 1);
    expect(r.weight).toBe(1);
    f.dispose();
  });

  it('carries an activation velocity and an impulse', async () => {
    const f = await fixture();
    const { root, hips } = skeleton();
    const owner = f.entities.create(Transform);
    f.ragdolls.create(owner, root, CONFIG, {
      blendSeconds: 0,
      activation: { velocity: { x: 3, y: 0, z: 0 }, impulse: { point: { x: 0, y: 2.6, z: 0 }, direction: { x: 0, y: 0, z: 1 }, strength: 2 } },
    });
    f.tick(20);
    const p = hips.getWorldPosition(new THREE.Vector3());
    expect(p.x).toBeGreaterThan(0.3);
    f.dispose();
  });

  it('blends from the animated pose over blendSeconds', async () => {
    const f = await fixture();
    const { root, hips } = skeleton();
    const owner = f.entities.create(Transform);
    const r = f.ragdolls.create(owner, root, CONFIG, { blendSeconds: 0.5 });
    f.tick(6);
    expect(r.weight).toBeGreaterThan(0);
    expect(r.weight).toBeLessThan(1);
    expect(hips.position.y).toBeLessThan(0);
    f.tick(60);
    expect(r.weight).toBe(1);
    f.dispose();
  });

  it('removes its bodies on remove()', async () => {
    const f = await fixture();
    const { root } = skeleton();
    const owner = f.entities.create(Transform);
    const r = f.ragdolls.create(owner, root, CONFIG);
    const eids = r.parts.map((p) => p.eid);
    expect(eids.every((e) => f.physics.hasBody(e))).toBe(true);
    expect(f.ragdolls.remove(owner)).toBe(true);
    expect(eids.every((e) => !f.entities.exists(e))).toBe(true);
    expect(f.ragdolls.count).toBe(0);
    f.tick(5);
    f.dispose();
  });
});
