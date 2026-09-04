import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  CharacterController,
  DisposeBag,
  InstancedRenderSync,
  PhysicsDebugRenderer,
  Renderable,
  RenderSync,
  Transform,
  type Entity,
  type PhysicsPair,
  type SceneDefinition,
  type SceneInstance,
} from '@spark/engine';

const DEBRIS_COUNT = 300;
const PLAYER_SPEED = 5;
const JUMP_SPEED = 8;

/**
 * Milestone 4 demonstration: Rapier at the fixed step. A walled arena with a
 * ramp, 300 dynamic boxes and spheres dropped from a seeded pattern (two
 * instanced draws), a sensor volume that lights up while anything is inside,
 * a kinematic capsule driven through the character controller (WASD/arrows
 * relative to the camera, Space to jump), pointer raycast hover highlighting,
 * and the physics debug wireframe on F3. Same seed = same pile.
 */
export const physicsScene: SceneDefinition = {
  name: 'physics',
  create(ctx): SceneInstance {
    const bag = new DisposeBag();
    const { entities, physics, random, input, logger } = ctx;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0c12);

    const camera = new THREE.PerspectiveCamera(42, ctx.renderer.aspect, 0.1, 200);
    camera.position.set(0, 17, 27);
    camera.lookAt(0, 1, 0);

    const pmrem = new THREE.PMREMGenerator(ctx.renderer.three);
    const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    scene.environmentIntensity = 0.3;
    bag.add(() => {
      envTarget.dispose();
      pmrem.dispose();
    });

    const sun = new THREE.DirectionalLight(0xffe9cf, 2.8);
    sun.position.set(14, 22, 10);
    sun.castShadow = ctx.quality.shadows;
    sun.shadow.mapSize.set(ctx.quality.shadowMapSize, ctx.quality.shadowMapSize);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 70;
    sun.shadow.camera.left = -24;
    sun.shadow.camera.right = 24;
    sun.shadow.camera.top = 24;
    sun.shadow.camera.bottom = -24;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    scene.add(sun, sun.target);
    scene.add(new THREE.HemisphereLight(0x7f96ff, 0x1c130d, 0.35));

    // ---- layers + systems --------------------------------------------------
    physics.layers.define('world', 'debris', 'player', 'trigger');
    const renderSync = new RenderSync(entities);
    const instancedSync = new InstancedRenderSync(entities);
    const debug = new PhysicsDebugRenderer(physics);
    scene.add(debug.object);
    bag.add(entities.addSystem(renderSync));
    bag.add(entities.addSystem(instancedSync));
    bag.add(entities.addSystem(debug));
    const spawned: Entity[] = [];

    // ---- static arena ------------------------------------------------------
    const staticMat = new THREE.MeshStandardMaterial({ color: 0x2a2e38, roughness: 0.9 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x3b4252, roughness: 0.7, metalness: 0.1 });
    const rampMat = new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.6, metalness: 0.2 });
    bag.add(() => {
      staticMat.dispose();
      wallMat.dispose();
      rampMat.dispose();
    });

    function addStaticBox(
      hx: number,
      hy: number,
      hz: number,
      position: THREE.Vector3,
      quaternion: THREE.Quaternion,
      material: THREE.Material,
    ): Entity {
      const geo = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
      bag.add(() => geo.dispose());
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      const eid = entities.create([
        Transform,
        { x: position.x, y: position.y, z: position.z, qx: quaternion.x, qy: quaternion.y, qz: quaternion.z, qw: quaternion.w },
      ]);
      physics.addBody(eid, { type: 'fixed', shape: { kind: 'box', hx, hy, hz }, layer: 'world', friction: 0.8, events: false });
      renderSync.attach(entities, eid, mesh);
      spawned.push(eid);
      return eid;
    }

    const identity = new THREE.Quaternion();
    addStaticBox(15, 0.5, 15, new THREE.Vector3(0, -0.5, 0), identity, staticMat); // ground, top at y=0
    addStaticBox(0.4, 2, 15, new THREE.Vector3(-14.6, 2, 0), identity, wallMat); // left wall
    addStaticBox(0.4, 2, 15, new THREE.Vector3(14.6, 2, 0), identity, wallMat); // right wall
    addStaticBox(15, 2, 0.4, new THREE.Vector3(0, 2, -14.6), identity, wallMat); // back wall
    // Ramp: tilted about Z so it rises toward -x; debris rolls off toward +x.
    const rampTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.42);
    addStaticBox(4, 0.25, 5, new THREE.Vector3(-8.5, 1.45, -3), rampTilt, rampMat);

    // ---- debris: 300 dynamic bodies through two instanced draws -----------
    const boxGeo = new THREE.BoxGeometry(0.7, 0.7, 0.7);
    const sphereGeo = new THREE.SphereGeometry(0.35, 20, 14);
    const boxMat = new THREE.MeshStandardMaterial({ color: 0x6fc3ff, roughness: 0.45, metalness: 0.15 });
    const sphereMat = new THREE.MeshStandardMaterial({ color: 0xff8a5c, roughness: 0.3, metalness: 0.4 });
    bag.add(() => {
      boxGeo.dispose();
      sphereGeo.dispose();
      boxMat.dispose();
      sphereMat.dispose();
    });
    const boxes = instancedSync.createBatch(boxGeo, boxMat, DEBRIS_COUNT);
    const spheres = instancedSync.createBatch(sphereGeo, sphereMat, DEBRIS_COUNT);
    for (const batch of [boxes, spheres]) {
      batch.mesh.castShadow = true;
      batch.mesh.receiveShadow = true;
      scene.add(batch.mesh);
    }
    const tmpQ = new THREE.Quaternion();
    const tmpE = new THREE.Euler();
    for (let i = 0; i < DEBRIS_COUNT; i++) {
      // Seeded spawn: a 10×10 column grid, three tiers high, jittered; the
      // west columns land on the ramp so the pile spreads across the floor.
      const col = i % 10;
      const row = Math.floor(i / 10) % 10;
      const tier = Math.floor(i / 100);
      tmpE.set(random.range(0, Math.PI), random.range(0, Math.PI), random.range(0, Math.PI));
      tmpQ.setFromEuler(tmpE);
      const eid = entities.create(
        [
          Transform,
          {
            x: -9 + col * 1.6 + random.range(-0.35, 0.35),
            y: 7 + tier * 5 + random.range(0, 1.5),
            z: -7 + row * 1.4 + random.range(-0.35, 0.35),
            qx: tmpQ.x,
            qy: tmpQ.y,
            qz: tmpQ.z,
            qw: tmpQ.w,
          },
        ],
        Renderable,
      );
      const isBox = i % 2 === 0;
      physics.addBody(eid, {
        type: 'dynamic',
        shape: isBox ? { kind: 'box', hx: 0.35, hy: 0.35, hz: 0.35 } : { kind: 'sphere', radius: 0.35 },
        layer: 'debris',
        friction: 0.6,
        restitution: isBox ? 0.1 : 0.35,
        events: false, // the sensor reports these; skip contact events for bulk debris
      });
      (isBox ? boxes : spheres).add(eid);
      spawned.push(eid);
    }

    // ---- sensor trigger volume ---------------------------------------------
    const triggerGeo = new THREE.BoxGeometry(3, 2, 3);
    const triggerMat = new THREE.MeshStandardMaterial({
      color: 0x3a7bff,
      emissive: 0x1030a0,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.35,
      roughness: 0.3,
      depthWrite: false,
    });
    bag.add(() => {
      triggerGeo.dispose();
      triggerMat.dispose();
    });
    const triggerMesh = new THREE.Mesh(triggerGeo, triggerMat);
    scene.add(triggerMesh);
    const trigger = entities.create([Transform, { x: 7.5, y: 1, z: 4 }]);
    physics.addBody(trigger, {
      type: 'fixed',
      shape: { kind: 'box', hx: 1.5, hy: 1, hz: 1.5 },
      layer: 'trigger',
      collidesWith: ['debris', 'player'],
      isSensor: true,
    });
    renderSync.attach(entities, trigger, triggerMesh);
    spawned.push(trigger);
    let insideCount = 0;
    const updateTriggerColor = (): void => {
      const active = insideCount > 0;
      triggerMat.color.setHex(active ? 0xff5a3a : 0x3a7bff);
      triggerMat.emissive.setHex(active ? 0xa02010 : 0x1030a0);
      triggerMat.emissiveIntensity = active ? 1.4 : 0.6;
    };
    bag.add(
      physics.events.on('triggerEnter', (p: PhysicsPair) => {
        if (p.a !== trigger) return;
        insideCount += 1;
        updateTriggerColor();
        logger.info(`trigger enter: entity ${p.b} (inside=${insideCount})`);
      }),
    );
    bag.add(
      physics.events.on('triggerExit', (p: PhysicsPair) => {
        if (p.a !== trigger) return;
        insideCount = Math.max(0, insideCount - 1);
        updateTriggerColor();
        logger.info(`trigger exit: entity ${p.b} (inside=${insideCount})`);
      }),
    );

    // ---- kinematic player capsule ------------------------------------------
    const playerGeo = new THREE.CapsuleGeometry(0.35, 1.0, 6, 16);
    const playerMat = new THREE.MeshStandardMaterial({ color: 0x9dff6b, roughness: 0.35, metalness: 0.2, emissive: 0x1a3a08 });
    bag.add(() => {
      playerGeo.dispose();
      playerMat.dispose();
    });
    const playerMesh = new THREE.Mesh(playerGeo, playerMat);
    playerMesh.castShadow = true;
    playerMesh.receiveShadow = true;
    scene.add(playerMesh);
    const player = entities.create([Transform, { x: 2, y: 1.2, z: 9 }]);
    physics.addBody(player, {
      type: 'kinematicPosition',
      shape: { kind: 'capsule', halfHeight: 0.5, radius: 0.35 },
      layer: 'player',
      collidesWith: ['world', 'debris', 'trigger'],
    });
    renderSync.attach(entities, player, playerMesh);
    spawned.push(player);
    const controller = new CharacterController(physics, { stepHeight: 0.4, snapToGround: 0.3, characterMass: 80 });
    controller.attach(player);
    bag.add(controller);

    const forward = new THREE.Vector3();
    const move = { x: 0, y: 0, z: 0 };

    // ---- pointer raycast hover ---------------------------------------------
    let hovered: Entity | null = null;
    const ndc = new THREE.Vector2();
    const rayOrigin = new THREE.Vector3();
    const rayDir = new THREE.Vector3();
    const setHover = (eid: Entity | null): void => {
      if (eid === hovered) return;
      const t = entities.store(Transform);
      if (hovered !== null && entities.exists(hovered)) {
        t.sx[hovered] = 1;
        t.sy[hovered] = 1;
        t.sz[hovered] = 1;
      }
      hovered = eid;
      if (hovered !== null) {
        t.sx[hovered] = 1.2;
        t.sy[hovered] = 1.2;
        t.sz[hovered] = 1.2;
      }
    };

    return {
      scene,
      camera,
      fixedUpdate(dt): void {
        // Camera-relative planar input.
        camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        const strafe = Math.max(-1, Math.min(1, input.axis('KeyA', 'KeyD') + input.axis('ArrowLeft', 'ArrowRight')));
        const advance = Math.max(-1, Math.min(1, input.axis('KeyS', 'KeyW') + input.axis('ArrowDown', 'ArrowUp')));
        // right = forward × up
        const rx = -forward.z;
        const rz = forward.x;
        let mx = forward.x * advance + rx * strafe;
        let mz = forward.z * advance + rz * strafe;
        const len = Math.hypot(mx, mz);
        if (len > 1) {
          mx /= len;
          mz /= len;
        }
        move.x = mx * PLAYER_SPEED * dt;
        move.z = mz * PLAYER_SPEED * dt;
        if (input.wasPressed('Space')) controller.jump(player, JUMP_SPEED);
        controller.move(player, move, dt);
      },
      update(): void {
        if (input.wasPressed('F3')) logger.info(`physics debug ${debug.toggle() ? 'on' : 'off'}`);
        const pointer = input.pointer;
        if (!pointer.inside) {
          setHover(null);
          return;
        }
        const size = ctx.renderer.size;
        ndc.set((pointer.x / size.width) * 2 - 1, -(pointer.y / size.height) * 2 + 1);
        rayOrigin.setFromMatrixPosition(camera.matrixWorld);
        rayDir.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(rayOrigin).normalize();
        const hit = physics.raycast(rayOrigin, rayDir, 200, { layers: 'debris' });
        setHover(hit?.eid ?? null);
      },
      resize(width, height): void {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      },
      dispose(): void {
        setHover(null);
        for (const eid of spawned) entities.destroy(eid);
        bag.dispose();
        scene.clear();
      },
    };
  },
};
