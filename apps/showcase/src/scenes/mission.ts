import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DisposeBag, RenderSync, ShoulderCamera, type SceneDefinition, type SceneInstance } from '@spark/engine';
import { Operator } from '../actors/Operator';
import { buildBlockout } from '../levels/blockout';
import { createOperatorHud } from '../ui/hud';

const MANNEQUIN_URL = '/models/mannequin.glb';

/**
 * Milestone 5 scaffold: the operator in a grey-box night street under the
 * over-the-shoulder camera. No weapon, no enemy, no objective yet; those land
 * in this order on top of this scene (`docs/design/mission-shape.md`).
 */
export const missionScene: SceneDefinition = {
  name: 'mission',
  async create(ctx): Promise<SceneInstance> {
    const bag = new DisposeBag();
    const { entities, physics, animation, assets, audio, ui, input, random, quality, logger } = ctx;
    const scene = new THREE.Scene();

    // Dynamic resolution only makes sense on a wall clock; never on the capture clock.
    ctx.renderer.setDynamicResolutionEnabled(ctx.config.fixedFrameDelta === null && quality.dynamicResolution);
    bag.add(() => ctx.renderer.setDynamicResolutionEnabled(false));

    // ---- image-based lighting until the level ships its own -------------------
    const pmrem = new THREE.PMREMGenerator(ctx.renderer.three);
    const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    scene.environmentIntensity = 0.12;
    bag.add(() => {
      envTarget.dispose();
      pmrem.dispose();
    });

    // ---- level ----------------------------------------------------------------
    const renderSync = new RenderSync(entities);
    bag.add(entities.addSystem(renderSync));
    const level = buildBlockout(scene, entities, physics, quality, random.fork());
    bag.add(level);

    // ---- operator ------------------------------------------------------------
    const model = await assets.loadModel(MANNEQUIN_URL);
    bag.add(() => assets.release(MANNEQUIN_URL));
    const operator = new Operator({ entities, physics, animation, renderSync, scene, model }, level.spawn, level.spawnYaw);
    bag.add(operator);

    // ---- camera --------------------------------------------------------------
    const camera = new ShoulderCamera({ aspect: ctx.renderer.aspect, near: 0.05, far: 200 });
    camera.setLook(level.spawnYaw, THREE.MathUtils.degToRad(6));
    ui.setCamera(camera.camera);
    audio.setListenerCamera(camera.camera);
    bag.add(() => {
      ui.setCamera(null);
      audio.setListenerCamera(null);
    });
    // The camera pulls in against the world, never against the player's own capsule.
    const occluder = (origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): number | null =>
      physics.raycast(origin, direction, maxDistance, { layers: 'world', excludeEid: operator.eid })?.distance ?? null;
    const feet = new THREE.Vector3();
    const syncCamera = (): void => {
      operator.feet(feet);
      camera.target.copy(feet);
      camera.height = operator.height;
      camera.aiming = operator.aiming;
    };
    syncCamera();
    camera.snap(occluder);

    // ---- HUD and pointer lock ------------------------------------------------
    const hud = createOperatorHud(ui);
    bag.add(hud);
    const onPointerDown = (): void => {
      if (!input.isPointerLocked && !input.isCaptured) input.requestPointerLock();
    };
    ctx.config.container.addEventListener('pointerdown', onPointerDown);
    bag.add(() => ctx.config.container.removeEventListener('pointerdown', onPointerDown));

    logger.info(`mission: operator at (${level.spawn.x.toFixed(1)}, ${level.spawn.z.toFixed(1)}), ${ctx.lighting.budget} local lights in budget`);

    return {
      scene,
      camera: camera.camera,
      update(_dt) {
        if (input.isPointerLocked) {
          const d = input.pointerDelta;
          camera.look(d.x, d.y);
        }
        operator.update(input, camera);
        hud.setLocked(input.isPointerLocked);
        hud.setAiming(operator.aiming);
        hud.setStatus(operator.stance, operator.speed, operator.grounded);
      },
      fixedUpdate(fixedDt) {
        operator.fixedUpdate(fixedDt);
      },
      lateUpdate(dt) {
        syncCamera();
        camera.update(dt, occluder);
      },
      resize(width, height) {
        camera.setAspect(width / height);
      },
      dispose() {
        bag.dispose();
      },
    };
  },
};
