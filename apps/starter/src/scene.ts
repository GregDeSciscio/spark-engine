import * as THREE from 'three/webgpu';
import {
  CharacterController,
  DisposeBag,
  RenderSync,
  Transform,
  renderPlaceholder,
  type Entity,
  type SceneDefinition,
  type SceneInstance,
} from '@spark/engine';

/**
 * The starter scene: a lit floor, a stack of crates you can push over, a
 * capsule you walk with WASD and jump with Space, a camera that follows it,
 * and a thump when you land. Everything a Spark Engine scene does is in this
 * one file; docs/guide/first-scene.md walks through it.
 *
 * The shape every scene shares: a `SceneDefinition` has a name and a
 * `create(ctx)` that returns a `SceneInstance` (a three scene, a camera, the
 * update hooks you need, and `dispose`). `ctx` is the engine: entities,
 * physics, input, audio, assets, animation, particles, lighting and UI.
 */

const PLAYER_SPEED = 5; // metres per second
const JUMP_SPEED = 7;
const CAMERA_OFFSET = new THREE.Vector3(0, 4, 7);

export const starterScene: SceneDefinition = {
  name: 'starter',
  async create(ctx): Promise<SceneInstance> {
    const { entities, physics, input, audio, quality, logger } = ctx;
    const bag = new DisposeBag(); // everything registered here is undone in dispose()
    const spawned: Entity[] = []; // entities this scene made, destroyed in dispose()

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0d12);
    const camera = new THREE.PerspectiveCamera(50, ctx.renderer.aspect, 0.1, 200);

    // ---- light ---------------------------------------------------------------------
    const sun = new THREE.DirectionalLight(0xfff1dc, 3);
    sun.position.set(6, 10, 4);
    sun.castShadow = quality.shadows; // the quality preset decides; scenes read it, never force it
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    sun.shadow.camera.left = sun.shadow.camera.bottom = -14;
    sun.shadow.camera.right = sun.shadow.camera.top = 14;
    sun.shadow.camera.far = 40;
    sun.shadow.bias = -0.0005;
    scene.add(sun, sun.target, new THREE.HemisphereLight(0x8fa9ff, 0x2a1d14, 0.45));

    // ---- physics ↔ rendering -----------------------------------------------------------
    // Entities carry a Transform; physics writes it each fixed step, RenderSync copies it
    // to a three object each frame. Register the system with the entity world.
    const renderSync = new RenderSync(entities);
    bag.add(entities.addSystem(renderSync));

    /** A box that is both a rigid body and a mesh. */
    const box = (x: number, y: number, z: number, size: THREE.Vector3, color: number, dynamic: boolean): Entity => {
      const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
      const material = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
      bag.add(() => {
        geometry.dispose();
        material.dispose();
      });
      const eid = entities.create([Transform, { x, y, z }]);
      physics.addBody(eid, {
        type: dynamic ? 'dynamic' : 'fixed',
        shape: { kind: 'box', hx: size.x / 2, hy: size.y / 2, hz: size.z / 2 },
        layer: dynamic ? 'debris' : 'world',
        friction: 0.7,
      });
      renderSync.attach(entities, eid, mesh);
      spawned.push(eid);
      return eid;
    };

    box(0, -0.5, 0, new THREE.Vector3(30, 1, 30), 0x2b2f38, false); // the floor
    const crate = new THREE.Vector3(1, 1, 1);
    for (let row = 0; row < 4; row++) {
      for (let i = 0; i <= row; i++) box((i - row / 2) * 1.05, 3.5 - row, -4, crate, 0xc2743a, true); // a pyramid to knock over
    }

    // ---- the player ---------------------------------------------------------------------
    // A kinematic capsule driven by the character controller: it slides along walls,
    // steps over small ledges and snaps to the ground.
    const playerGeometry = new THREE.CapsuleGeometry(0.35, 1.0, 8, 16);
    const playerMaterial = new THREE.MeshStandardMaterial({ color: 0x3f7cb8, roughness: 0.4 });
    const playerMesh = new THREE.Mesh(playerGeometry, playerMaterial);
    playerMesh.castShadow = true;
    scene.add(playerMesh);
    bag.add(() => {
      playerGeometry.dispose();
      playerMaterial.dispose();
    });
    const player = entities.create([Transform, { x: 0, y: 1, z: 4 }]);
    physics.addBody(player, {
      type: 'kinematicPosition',
      shape: { kind: 'capsule', halfHeight: 0.5, radius: 0.35 },
      layer: 'player',
      collidesWith: ['world', 'debris'],
    });
    renderSync.attach(entities, player, playerMesh);
    spawned.push(player);
    const controller = new CharacterController(physics, { stepHeight: 0.4, snapToGround: 0.3, characterMass: 80 });
    controller.attach(player);
    bag.add(controller);

    // ---- a sound --------------------------------------------------------------------------
    // The engine ships synthesised placeholder cues so audio works before you have files.
    // Replace `buffer` with `url: '/audio/thump.ogg'` (or `urls` for variants) when you do.
    audio.defineSound({ name: 'thump', buffer: await renderPlaceholder('placeholder-impact'), bus: 'sfx', pitchVariance: 2 });
    bag.add(() => audio.undefineSound('thump'));

    // ---- per-frame state -------------------------------------------------------------------
    const forward = new THREE.Vector3();
    const move = { x: 0, y: 0, z: 0 };
    const playerPos = new THREE.Vector3();
    const t = entities.store(Transform);
    let wasAirborne = false;

    logger.info('starter: WASD to move, Space to jump, push the crates over');

    return {
      scene,
      camera,

      /** Fixed step: deterministic simulation. Read input, move the body. */
      fixedUpdate(dt): void {
        camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        const strafe = input.axis('KeyA', 'KeyD');
        const advance = input.axis('KeyS', 'KeyW');
        let mx = forward.x * advance - forward.z * strafe;
        let mz = forward.z * advance + forward.x * strafe;
        const length = Math.hypot(mx, mz);
        if (length > 1) {
          mx /= length;
          mz /= length;
        }
        move.x = mx * PLAYER_SPEED * dt;
        move.z = mz * PLAYER_SPEED * dt;
        if (input.wasPressed('Space')) controller.jump(player, JUMP_SPEED);
        controller.move(player, move, dt);

        // Landing: the controller reports how long the capsule has been off the ground.
        const airborne = controller.airborneSeconds(player) > 0.1;
        if (wasAirborne && !airborne) audio.playAt('thump', player);
        wasAirborne = airborne;
      },

      /** After physics and animation: the camera follows the player. */
      lateUpdate(): void {
        playerPos.set(t.x[player] ?? 0, t.y[player] ?? 0, t.z[player] ?? 0);
        camera.position.copy(playerPos).add(CAMERA_OFFSET);
        camera.lookAt(playerPos);
      },

      resize(width, height): void {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      },

      dispose(): void {
        for (const eid of spawned) entities.destroy(eid); // removes bodies, transforms and render bindings
        bag.dispose();
        scene.clear();
      },
    };
  },
};
