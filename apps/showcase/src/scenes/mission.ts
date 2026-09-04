import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DisposeBag, Navigation, RenderSync, ShoulderCamera, initNavigation, renderAllPlaceholders, type SceneDefinition, type SceneInstance } from '@spark/engine';
import { Operator } from '../actors/Operator';
import { TargetDummy } from '../actors/TargetDummy';
import { Gunplay } from '../combat/Gunplay';
import { RIFLE_BASELINE } from '../combat/weapons';
import { buildBlockout } from '../levels/blockout';
import { createOperatorHud } from '../ui/hud';

const MANNEQUIN_URL = '/models/mannequin.glb';
/** `?freelook=1`: treat the pointer as locked without asking the browser. For headless capture and probes, where pointer lock cannot be granted. */
const FREELOOK = new URLSearchParams(location.search).get('freelook') === '1';
/** `?nav=1`: start with the navmesh overlay on (F4 toggles it either way). */
const NAV_OVERLAY = new URLSearchParams(location.search).get('nav') === '1';
const SOUND_SHOT = 'rifle-shot';
const SOUND_HIT = 'impact';

/**
 * Milestone 5, second step: the operator with the baseline rifle in a
 * grey-box night street, shooting range dummies. No enemy AI or objective
 * yet; those land next (`docs/design/mission-shape.md`).
 */
export const missionScene: SceneDefinition = {
  name: 'mission',
  async create(ctx): Promise<SceneInstance> {
    const bag = new DisposeBag();
    const { entities, physics, animation, assets, audio, ui, input, random, quality, vfx, logger } = ctx;
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

    // ---- navigation: baked at load for the blockout; shipped levels bake offline (ADR-009) ----
    await initNavigation();
    const navStart = performance.now();
    const navigation = Navigation.bake(level.navSoup.positions, level.navSoup.indices);
    bag.add(navigation);
    const navStats = navigation.stats();
    logger.info(`mission: navmesh ${navStats.polys} polys / ${navStats.vertices} verts from ${level.navSoup.triangleCount} tris in ${(performance.now() - navStart).toFixed(0)} ms`);
    const navLines = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(navigation.debugLines(), 3)),
      new THREE.LineBasicMaterial({ color: 0x4dff9a, transparent: true, opacity: 0.6, depthTest: false }),
    );
    navLines.position.y = 0.06;
    navLines.renderOrder = 10;
    navLines.visible = NAV_OVERLAY;
    scene.add(navLines);
    bag.add(() => {
      scene.remove(navLines);
      navLines.geometry.dispose();
      (navLines.material as THREE.Material).dispose();
    });

    // ---- actors ----------------------------------------------------------------
    const model = await assets.loadModel(MANNEQUIN_URL);
    bag.add(() => assets.release(MANNEQUIN_URL));
    const operator = new Operator({ entities, physics, animation, renderSync, scene, model }, level.spawn, level.spawnYaw);
    bag.add(operator);
    const dummies = level.targetSpots.map((spot, i) => {
      const dummy = new TargetDummy({ entities, physics, animation, renderSync, scene, model, labels: ui.labels }, `Target ${i + 1}`, spot.position, spot.yaw);
      bag.add(dummy);
      return dummy;
    });

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

    // ---- audio: placeholder cues until real samples land ------------------------
    const placeholders = await renderAllPlaceholders();
    const impact = placeholders.get('placeholder-impact');
    const sounds = impact ? { shot: SOUND_SHOT, hit: SOUND_HIT } : null;
    if (impact) {
      audio.defineSound({ name: SOUND_SHOT, bus: 'sfx', buffer: impact, volume: 0.9, pitchVariance: 2, cooldownMs: 30, maxInstances: 6 });
      audio.defineSound({ name: SOUND_HIT, bus: 'sfx', buffer: impact, volume: 0.5, pitchVariance: 5, cooldownMs: 40, maxInstances: 6 });
      bag.add(() => {
        audio.undefineSound(SOUND_SHOT);
        audio.undefineSound(SOUND_HIT);
        audio.stopAll(0.1);
      });
    }

    // ---- gunplay ---------------------------------------------------------------
    const gunplay = new Gunplay(
      { entities, physics, vfx, audio, labels: ui.labels, scene, random: random.fork(), camera, operator, dummies, worldMeshes: level.meshes, sounds },
      RIFLE_BASELINE,
      operator.muzzle,
    );
    bag.add(gunplay);

    // ---- HUD and pointer lock ------------------------------------------------
    const hud = createOperatorHud(ui);
    bag.add(hud);
    const onPointerDown = (): void => {
      if (!FREELOOK && !input.isPointerLocked && !input.isCaptured) input.requestPointerLock();
    };
    ctx.config.container.addEventListener('pointerdown', onPointerDown);
    bag.add(() => ctx.config.container.removeEventListener('pointerdown', onPointerDown));

    logger.info(`mission: operator at (${level.spawn.x.toFixed(1)}, ${level.spawn.z.toFixed(1)}), ${dummies.length} targets, ${ctx.lighting.budget} local lights in budget`);

    return {
      scene,
      camera: camera.camera,
      update(_dt) {
        const locked = FREELOOK || input.isPointerLocked;
        if (locked) {
          const d = input.pointerDelta;
          camera.look(d.x, d.y);
        }
        operator.update(input, camera);
        if (input.wasPressed('F4')) navLines.visible = !navLines.visible;
        // The click that takes control must not also fire.
        gunplay.update(locked && input.isButtonDown(0), locked && input.wasButtonPressed(0), input.wasPressed('KeyR'));
        const weapon = gunplay.weapon;
        hud.setLocked(locked);
        hud.setAiming(operator.aiming);
        hud.setSpread(gunplay.spreadNow());
        hud.setAmmo(weapon.ammo, weapon.reserve, weapon.reloading, weapon.reloadProgress);
        hud.setStatus(operator.stance, operator.speed, operator.grounded);
        hud.setScore(gunplay.stats.hits, gunplay.stats.kills);
      },
      fixedUpdate(fixedDt) {
        operator.fixedUpdate(fixedDt);
        gunplay.fixedUpdate(fixedDt);
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
