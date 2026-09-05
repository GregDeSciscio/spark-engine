import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DisposeBag, RenderSync, ShoulderCamera, initNavigation, renderAllPlaceholders, type SceneDefinition, type SceneInstance } from '@spark/engine';
import { Enemy } from '../actors/Enemy';
import { OPERATOR_MAX_HEALTH, Operator } from '../actors/Operator';
import { TargetDummy } from '../actors/TargetDummy';
import { AWARENESS, overallState } from '../ai/Awareness';
import type { Damageable } from '../combat/Damageable';
import { Impacts } from '../combat/effects';
import { Gunplay } from '../combat/Gunplay';
import { RIFLE_BASELINE } from '../combat/weapons';
import { buildBlockout } from '../levels/blockout';
import { applyAtmosphere, loadStreetLevel, type MissionLevel } from '../levels/MissionLevel';
import { MissionRunner } from '../mission/Objectives';
import { createOperatorHud } from '../ui/hud';

const MANNEQUIN_URL = '/models/mannequin.glb';
/** `?freelook=1`: treat the pointer as locked without asking the browser. For headless capture and probes, where pointer lock cannot be granted. */
const FREELOOK = new URLSearchParams(location.search).get('freelook') === '1';
/** `?nav=1`: start with the navmesh overlay on (F4 toggles it either way). */
const NAV_OVERLAY = new URLSearchParams(location.search).get('nav') === '1';
/** `?level=blockout` forces the procedural street; the default is the Blender-authored one, with the blockout as fallback. */
const LEVEL = new URLSearchParams(location.search).get('level') ?? 'street';
const STREET_URL = '/levels/street.glb';
const SOUND_SHOT = 'rifle-shot';
const SOUND_HIT = 'impact';
/** Seconds the damage vignette takes to fade. */
const HURT_FADE = 0.8;

/**
 * Milestone 5 gameplay slice: the operator with the baseline rifle against
 * three riflemen patrolling a grey-box night street on a baked navmesh, with
 * the awareness ladder from `docs/design/mission-shape.md`, and a
 * three-objective mission (reach, plant, extract). Completing an objective
 * moves the checkpoint; dying shows the failed card and Enter reloads it
 * (full health and ammo, surviving hostiles reset to their routes). The level
 * is the Blender-authored street through the ADR-008 pipeline, navmesh baked
 * offline (ADR-009); the code-built blockout stays as `?level=blockout`.
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
    // Every layer any body will reference, before the first body exists, so the bit layout never depends on load order.
    physics.layers.define('world', 'player', 'target', 'enemy', 'trigger');
    bag.add(applyAtmosphere(scene, quality));
    await initNavigation();
    let level: MissionLevel;
    if (LEVEL === 'blockout') {
      level = buildBlockout(scene, entities, physics, random.fork());
    } else {
      try {
        level = await loadStreetLevel({ entities, physics, assets, renderSync, scene, logger }, STREET_URL);
      } catch (error) {
        logger.warn(`mission: street level failed (${error instanceof Error ? error.message : String(error)}); falling back to the blockout`);
        level = buildBlockout(scene, entities, physics, random.fork());
      }
    }
    bag.add(level);
    const navigation = level.navigation;
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

    // ---- audio: placeholder cues until real samples land ------------------------
    const placeholders = await renderAllPlaceholders();
    const impact = placeholders.get('placeholder-impact');
    const shotSound = impact ? SOUND_SHOT : null;
    const hitSound = impact ? SOUND_HIT : null;
    if (impact) {
      audio.defineSound({ name: SOUND_SHOT, bus: 'sfx', buffer: impact, volume: 0.9, pitchVariance: 2, cooldownMs: 30, maxInstances: 8 });
      audio.defineSound({ name: SOUND_HIT, bus: 'sfx', buffer: impact, volume: 0.5, pitchVariance: 5, cooldownMs: 40, maxInstances: 6 });
      bag.add(() => {
        audio.undefineSound(SOUND_SHOT);
        audio.undefineSound(SOUND_HIT);
        audio.stopAll(0.1);
      });
    }

    // ---- actors ----------------------------------------------------------------
    const model = await assets.loadModel(MANNEQUIN_URL);
    bag.add(() => assets.release(MANNEQUIN_URL));
    const effects = { entities, vfx, scene };
    const impacts = new Impacts({ ...effects, audio, random: random.fork(), worldMeshes: level.meshes, hitSound });
    bag.add(impacts);
    const operator = new Operator({ entities, physics, animation, renderSync, scene, model }, level.spawn, level.spawnYaw);
    bag.add(operator);
    const dummies = level.targetSpots.map((spot, i) => {
      const dummy = new TargetDummy({ entities, physics, animation, renderSync, scene, model, labels: ui.labels }, `Target ${i + 1}`, spot.position, spot.yaw);
      bag.add(dummy);
      return dummy;
    });
    const enemies = level.patrols.map((spec) => {
      const enemy = new Enemy(
        { ...effects, physics, animation, renderSync, model, labels: ui.labels, navigation, random: random.fork(), audio, impacts, shotSound },
        spec,
      );
      bag.add(enemy);
      return enemy;
    });
    const targets: Damageable[] = [...dummies, ...enemies];

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

    // ---- gunplay and hearing -------------------------------------------------------
    let now = 0;
    const gunplay = new Gunplay(
      {
        ...effects,
        physics,
        audio,
        labels: ui.labels,
        random: random.fork(),
        camera,
        operator,
        targets,
        impacts,
        shotSound,
        onShot: (position, loudness) => {
          for (const e of enemies) e.hear(position, loudness, now);
        },
      },
      RIFLE_BASELINE,
      operator.muzzle,
    );
    bag.add(gunplay);
    const enemyFeet = new THREE.Vector3();
    const otherFeet = new THREE.Vector3();
    const onAlert = (source: Enemy): void => {
      source.feet(enemyFeet);
      operator.feet(feet);
      for (const other of enemies) {
        if (other === source) continue;
        other.feet(otherFeet);
        if (otherFeet.distanceTo(enemyFeet) <= AWARENESS.warnRadius) other.warn(feet, now);
      }
    };

    // ---- objectives and checkpoints ----------------------------------------------
    const mission = new MissionRunner({ entities, scene, labels: ui.labels, renderSync }, level.objectives, { position: level.spawn, yaw: level.spawnYaw });
    bag.add(mission);
    let interactHeld = false;

    // ---- HUD and pointer lock ------------------------------------------------
    const hud = createOperatorHud(ui);
    bag.add(hud);
    const onPointerDown = (): void => {
      if (!FREELOOK && !input.isPointerLocked && !input.isCaptured) input.requestPointerLock();
    };
    ctx.config.container.addEventListener('pointerdown', onPointerDown);
    bag.add(() => ctx.config.container.removeEventListener('pointerdown', onPointerDown));

    // Checkpoint reload: back to the last completed objective; dead hostiles stay dead, the rest reset.
    const retry = (): void => {
      const cp = mission.checkpoint;
      operator.respawn(cp.position, cp.yaw);
      camera.setLook(cp.yaw, THREE.MathUtils.degToRad(6));
      for (const e of enemies) if (!e.dead) e.reset();
      gunplay.resetAmmo();
      mission.resetProgress();
      hud.setFailed(false);
    };

    logger.info(
      `mission: operator at (${level.spawn.x.toFixed(1)}, ${level.spawn.z.toFixed(1)}), ${enemies.length} hostiles, ${dummies.length} targets, ${ctx.lighting.budget} local lights in budget`,
    );

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
        if (operator.dead && input.wasPressed('Enter')) retry();
        interactHeld = !operator.dead && input.isDown('KeyF');
        // The click that takes control must not also fire.
        gunplay.update(locked && input.isButtonDown(0), locked && input.wasButtonPressed(0), input.wasPressed('KeyR'));
        const weapon = gunplay.weapon;
        hud.setLocked(locked);
        hud.setAiming(operator.aiming);
        hud.setSpread(gunplay.spreadNow());
        hud.setAmmo(weapon.ammo, weapon.reserve, weapon.reloading, weapon.reloadProgress);
        hud.setHealth(operator.health / OPERATOR_MAX_HEALTH, Math.max(0, 1 - (now - operator.lastHitAt) / HURT_FADE) * (operator.dead ? 1 : 0.85));
        hud.setAlert(overallState(enemies.filter((e) => !e.dead).map((e) => e.state)));
        hud.setStatus(operator.stance, operator.speed, operator.grounded);
        hud.setScore(gunplay.stats.hits, gunplay.stats.kills, enemies.filter((e) => !e.dead).length);
        hud.setFailed(operator.dead);
        const ms = mission.status();
        const promptText =
          ms.objective?.kind === 'plant' && ms.inRange ? (ms.progress > 0 ? 'setting charge' : 'hold F to set the charge') : null;
        hud.setObjective(ms.index, ms.total, ms.objective?.label ?? null, ms.distance, ms.progress, promptText);
        hud.setComplete(ms.complete);
      },
      fixedUpdate(fixedDt) {
        now += fixedDt;
        operator.fixedUpdate(fixedDt);
        gunplay.fixedUpdate(fixedDt);
        for (const d of dummies) d.fixedUpdate(now);
        for (const e of enemies) e.fixedUpdate(fixedDt, now, operator, onAlert);
        operator.feet(feet);
        mission.fixedUpdate(fixedDt, feet, interactHeld, enemies.filter((e) => !e.dead).length);
        if (mission.justCompleted) {
          logger.info(`mission: objective "${mission.justCompleted.id}" complete, checkpoint moved`);
          mission.justCompleted = null;
        }
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
