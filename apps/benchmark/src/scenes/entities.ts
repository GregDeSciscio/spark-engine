import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  DisposeBag,
  InstancedRenderSync,
  Renderable,
  RenderSync,
  Transform,
  Velocity,
  defineComponentType,
  type SceneDefinition,
  type SceneInstance,
} from '@spark/engine';

/** Per-entity orbit parameters for the demo. Numbers only. */
const Orbit = defineComponentType('Orbit', { radius: 'f32', speed: 'f32', phase: 'f32', height: 'f32' });

/**
 * Milestone 1 demonstration: a few thousand entities driven by fixed-step
 * systems, rendered as one instanced draw, plus three "hero" entities that use
 * ordinary meshes through RenderSync. Same seed = same scene.
 */
export const entitiesScene: SceneDefinition = {
  name: 'entities',
  create(ctx): SceneInstance {
    const bag = new DisposeBag();
    const { entities, random } = ctx;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07080d);

    const camera = new THREE.PerspectiveCamera(40, ctx.renderer.aspect, 0.1, 200);
    camera.position.set(0, 22, 34);
    camera.lookAt(0, 1, 0);

    const pmrem = new THREE.PMREMGenerator(ctx.renderer.three);
    const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    scene.environmentIntensity = 0.3;
    bag.add(() => {
      envTarget.dispose();
      pmrem.dispose();
    });

    const sun = new THREE.DirectionalLight(0xffe7c9, 2.6);
    sun.position.set(12, 20, 8);
    sun.castShadow = ctx.quality.shadows;
    sun.shadow.mapSize.set(ctx.quality.shadowMapSize, ctx.quality.shadowMapSize);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    sun.shadow.camera.left = -26;
    sun.shadow.camera.right = 26;
    sun.shadow.camera.top = 26;
    sun.shadow.camera.bottom = -26;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    scene.add(sun, sun.target);
    scene.add(new THREE.HemisphereLight(0x6f8dff, 0x1a120c, 0.35));

    const groundGeo = new THREE.CircleGeometry(30, 64);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.9 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    bag.add(() => {
      groundGeo.dispose();
      groundMat.dispose();
    });

    // Systems. Registered per scene, removed on dispose.
    const renderSync = new RenderSync(entities);
    const instancedSync = new InstancedRenderSync(entities);
    bag.add(entities.addSystem(renderSync));
    bag.add(entities.addSystem(instancedSync));
    bag.add(
      entities.addSystem({
        name: 'OrbitSystem',
        stage: 'fixed',
        run(world, dt) {
          const t = world.store(Transform);
          const o = world.store(Orbit);
          time += dt;
          for (const eid of world.query(Transform, Orbit)) {
            const a = time * (o.speed[eid] ?? 0) + (o.phase[eid] ?? 0);
            const r = o.radius[eid] ?? 0;
            t.x[eid] = Math.cos(a) * r;
            t.z[eid] = Math.sin(a) * r;
            t.y[eid] = (o.height[eid] ?? 0) + Math.sin(a * 3) * 0.25;
            // spin about Y: quaternion from angle
            const half = a * 1.5;
            t.qy[eid] = Math.sin(half);
            t.qw[eid] = Math.cos(half);
          }
        },
      }),
    );
    bag.add(
      entities.addSystem({
        name: 'VelocitySystem',
        stage: 'fixed',
        run(world, dt) {
          const t = world.store(Transform);
          const v = world.store(Velocity);
          for (const eid of world.query(Transform, Velocity)) {
            t.y[eid] = (t.y[eid] ?? 0) + (v.y[eid] ?? 0) * dt;
            if ((t.y[eid] ?? 0) > 6 || (t.y[eid] ?? 0) < 1) v.y[eid] = -(v.y[eid] ?? 0);
          }
        },
      }),
    );
    let time = 0;

    // Instanced swarm: one draw call.
    const count = Math.floor(2400 * ctx.quality.particleDensity);
    const cubeGeo = new THREE.BoxGeometry(0.35, 0.35, 0.35);
    const cubeMat = new THREE.MeshStandardMaterial({ color: 0x6fc3ff, roughness: 0.4, metalness: 0.2, emissive: 0x0a2a44, emissiveIntensity: 0.8 });
    const batch = instancedSync.createBatch(cubeGeo, cubeMat, count);
    batch.mesh.castShadow = true;
    batch.mesh.receiveShadow = true;
    scene.add(batch.mesh);
    bag.add(() => {
      cubeGeo.dispose();
      cubeMat.dispose();
    });
    const spawned: number[] = [];
    for (let i = 0; i < count; i++) {
      const ring = Math.floor(i / 200);
      const eid = entities.create(
        [Transform, { sx: 0.6 + random.next() * 0.8, sy: 0.6 + random.next() * 0.8, sz: 0.6 + random.next() * 0.8 }],
        [Orbit, { radius: 6 + ring * 1.7 + random.range(-0.4, 0.4), speed: 0.25 + random.range(-0.08, 0.08) * (ring % 2 ? -1 : 1), phase: random.range(0, Math.PI * 2), height: 1.2 + ring * 0.35 }],
        Renderable,
      );
      batch.add(eid);
      spawned.push(eid);
    }

    // Hero entities through RenderSync (ordinary meshes).
    const heroGeo = new THREE.IcosahedronGeometry(1.2, 2);
    bag.add(() => heroGeo.dispose());
    const heroColors = [0xff5c4d, 0xffd34d, 0x8bff6b];
    heroColors.forEach((color, i) => {
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.2, metalness: 0.85 });
      bag.add(() => mat.dispose());
      const mesh = new THREE.Mesh(heroGeo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      const eid = entities.create([Transform, { x: (i - 1) * 5, y: 2 + i, z: 0 }], [Velocity, { y: 1.5 + i * 0.7 }]);
      renderSync.attach(entities, eid, mesh);
      spawned.push(eid);
    });

    return {
      scene,
      camera,
      resize(width, height): void {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      },
      dispose(): void {
        for (const eid of spawned) entities.destroy(eid);
        bag.dispose();
        scene.clear();
      },
    };
  },
};
