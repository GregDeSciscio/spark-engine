import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  CYBERPUNK_GRADE,
  ColorGradeSettings,
  DisposeBag,
  RagdollWorld,
  RenderSync,
  ShoulderCamera,
  initNavigation,
  litness,
  type CaptureAPI,
  type SceneDefinition,
  type SceneInstance,
} from '@spark/engine';
import { Enemy } from '../actors/Enemy';
import { OPERATOR_MAX_HEALTH, Operator } from '../actors/Operator';
import { CHARACTER_URL } from '../actors/rig';
import { MissionAudio } from '../audio/MissionAudio';
import { TargetDummy } from '../actors/TargetDummy';
import { AWARENESS, overallState } from '../ai/Awareness';
import type { Damageable } from '../combat/Damageable';
import { Impacts } from '../combat/effects';
import { Gore } from '../combat/gore';
import { Gunplay } from '../combat/Gunplay';
import { RIFLE_BASELINE } from '../combat/weapons';
import { createAtmosphere } from '../levels/atmosphere';
import { buildBlockout } from '../levels/blockout';
import { applyAtmosphere, loadStreetLevel, type MissionLevel } from '../levels/MissionLevel';
import { MissionRunner } from '../mission/Objectives';
import { createOperatorHud } from '../ui/hud';

/** `?freelook=1`: treat the pointer as locked without asking the browser. For headless capture and probes, where pointer lock cannot be granted. */
const FREELOOK = new URLSearchParams(location.search).get('freelook') === '1';
/** `?nav=1`: start with the navmesh overlay on (F4 toggles it either way). */
const NAV_OVERLAY = new URLSearchParams(location.search).get('nav') === '1';
/** `?grade=0` renders without the colour grade, for comparison shots. */
const GRADE = new URLSearchParams(location.search).get('grade') !== '0';
/** `?level=blockout` forces the procedural street; the default is the Blender-authored one, with the blockout as fallback. */
const LEVEL = new URLSearchParams(location.search).get('level') ?? 'street';
const STREET_URL = '/levels/street.glb';
/** Seconds the damage vignette takes to fade. */
const HURT_FADE = 0.8;
/** Ragdoll caps (docs/design/gore-scope.md): at most this many simulating, none older than this. */
const MAX_RAGDOLLS = 6;
const RAGDOLL_SECONDS = 12;

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

    // The look: crushed teal shadows, magenta highlights, vignette, grain (ADR-005).
    if (GRADE) {
      ctx.renderer.pipeline.setColorGrade(new ColorGradeSettings(CYBERPUNK_GRADE));
      bag.add(() => ctx.renderer.pipeline.setColorGrade(null));
    }

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
    const sky = applyAtmosphere(scene, quality);
    bag.add(sky);
    await initNavigation();
    let level: MissionLevel;
    if (LEVEL === 'blockout') {
      level = buildBlockout(scene, entities, physics, random.fork());
    } else {
      try {
        level = await loadStreetLevel({ entities, physics, assets, renderSync, scene, logger, lighting: ctx.lighting }, STREET_URL);
      } catch (error) {
        logger.warn(`mission: street level failed (${error instanceof Error ? error.message : String(error)}); falling back to the blockout`);
        level = buildBlockout(scene, entities, physics, random.fork());
      }
    }
    bag.add(level);
    const weather = createAtmosphere({ entities, vfx, scene, quality, pipeline: ctx.renderer.pipeline, gpu: ctx.renderer.capabilities.backend === 'webgpu' }, level, sky.moon);
    bag.add(weather);
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

    // ---- audio: the mission's cue set (tools/audio); cues without takes are silent no-ops ----
    const sfx = await MissionAudio.load({ audio, animation, random: random.fork(), logger });
    bag.add(sfx);
    bag.add(() => audio.stopAll(0.1));

    // ---- actors ----------------------------------------------------------------
    const model = await assets.loadModel(CHARACTER_URL);
    bag.add(() => assets.release(CHARACTER_URL));
    const effects = { entities, vfx, scene };
    const impacts = new Impacts({ ...effects, audio, random: random.fork(), worldMeshes: level.meshes, sfx });
    bag.add(impacts);
    const gore = new Gore({ ...effects, physics, random: random.fork(), worldMeshes: level.meshes });
    bag.add(gore);
    const ragdolls = new RagdollWorld(entities, physics);
    bag.add(ragdolls);
    bag.add(entities.addSystem(ragdolls.system()));
    const operator = new Operator({ entities, physics, animation, renderSync, scene, model, sfx }, level.spawn, level.spawnYaw);
    bag.add(operator);
    const dummies = level.targetSpots.map((spot, i) => {
      const dummy = new TargetDummy({ entities, physics, animation, renderSync, scene, model, labels: ui.labels }, `Target ${i + 1}`, spot.position, spot.yaw);
      bag.add(dummy);
      return dummy;
    });
    const enemies = level.patrols.map((spec) => {
      const enemy = new Enemy(
        { ...effects, physics, animation, renderSync, model, labels: ui.labels, navigation, random: random.fork(), audio, impacts, sfx, ragdolls, gore },
        spec,
      );
      bag.add(enemy);
      return enemy;
    });
    const targets: Damageable[] = [...dummies, ...enemies];
    // Beds, neon and lamp hums at the level's lights, steam at the authored vents, and every footstep marker in the level.
    sfx.startAmbience({ lights: () => MissionAudio.emittersFromScene(scene), steam: level.vfx.filter((v) => v.preset === 'steam').map((v) => v.position) });
    sfx.bindFootsteps((eid) => (eid === operator.eid ? 1 : 0.85));

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
        gore,
        sfx,
        onShot: (position, loudness) => {
          for (const e of enemies) e.hear(position, loudness, now);
        },
      },
      RIFLE_BASELINE,
      operator.muzzle,
    );
    bag.add(gunplay);
    // How lit the operator is: the lighting query at chest height, shadowed by the level (ADR-005).
    const chest = new THREE.Vector3();
    const lightDir = new THREE.Vector3();
    const lightOccluder = (from: THREE.Vector3, to: THREE.Vector3): boolean => {
      lightDir.copy(to).sub(from);
      const d = lightDir.length();
      return physics.raycast(from, lightDir, d, { layers: 'world' }) !== null;
    };
    const sampleLit = (): void => {
      operator.feet(chest);
      chest.y += 1.2;
      const e = ctx.lighting.illuminanceAt(chest, { ambient: AWARENESS.nightAmbient, occluder: lightOccluder, maxOccluded: 3 });
      operator.lit = litness(e, AWARENESS.litReference);
    };
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
    let wasAlert = false;
    const listenerPos = new THREE.Vector3();

    // ---- HUD and pointer lock ------------------------------------------------
    const hud = createOperatorHud(ui);
    bag.add(hud);
    // Free look: the pointer is treated as locked. Forced by `?freelook=1`, or adopted
    // when the browser refuses pointer lock outright (an embedding without the permission).
    let freelook = FREELOOK;
    const onPointerDown = (): void => {
      if (!freelook && !input.isPointerLocked && !input.isCaptured) input.requestPointerLock();
    };
    ctx.config.container.addEventListener('pointerdown', onPointerDown);
    bag.add(() => ctx.config.container.removeEventListener('pointerdown', onPointerDown));

    // Checkpoint reload: back to the last completed objective; dead hostiles stay dead, the rest reset.
    const reticle = { x: 0, y: 0 };

    // ---- QA hook (`window.__spark.game`) for scripted probes, like Task Unit's render_game_to_text ----
    let autoFire = 0;
    let shotsSeen = 0;
    const qaTarget = new THREE.Vector3();
    const qaTo = new THREE.Vector3();
    const qa = {
      /** Aim the shot line through a world point. Iterates, since the shoulder pivot moves with the yaw. */
      lookAt(x: number, y: number, z: number): void {
        qaTarget.set(x, y, z);
        for (let i = 0; i < 4; i++) {
          qaTo.copy(qaTarget).sub(camera.pivot);
          camera.setLook(Math.atan2(-qaTo.x, -qaTo.z), -Math.atan2(qaTo.y, Math.hypot(qaTo.x, qaTo.z)));
          syncCamera();
          camera.snap(occluder);
        }
      },
      /** Hold the trigger until this many rounds have left the gun. */
      fire(rounds: number): void {
        autoFire = rounds;
      },
      aim(on: boolean): void {
        operator.aiming = on;
        qaAim = on;
      },
      /** Hold a movement direction (camera-relative, -1..1 each) until called with zeros. */
      move(forward: number, strafe: number): void {
        operator.autoMove = forward === 0 && strafe === 0 ? null : { forward, strafe };
      },
      /** Change stance the way the C / X keys do. */
      stance: (next: 'stand' | 'crouch' | 'prone') => operator.setStance(next),
      /** Take damage as if an enemy round landed. */
      hurt: (damage: number) => operator.takeDamage(damage, 'torso', now),
      /** The audio layer: cue count, beds, emitters in range and playing. */
      audio: () => sfx.stats(),
      /** Current animation state per layer, plus the blend parameters. */
      anim: () => ({
        base: animation.getState(operator.eid),
        upper: animation.getState(operator.eid, 1),
        flinch: animation.getState(operator.eid, 2),
        stance: operator.stance,
        speed: operator.speed,
        grounded: operator.grounded,
      }),
      pivot: () => camera.pivot.toArray(),
      cameraPos: () => camera.camera.position.toArray(),
      viewForward: () => camera.viewForward(new THREE.Vector3()).toArray(),
      /** Raw physics ray between two world points, for probing what a shot line meets. */
      ray(from: [number, number, number], to: [number, number, number], solid = false) {
        const o = new THREE.Vector3(...from);
        const d = new THREE.Vector3(...to).sub(o);
        const len = d.length();
        const hit = physics.raycast(o, d, len, { layers: ['world', 'target', 'enemy'], excludeEid: operator.eid, solid });
        return hit ? { eid: hit.eid, distance: hit.distance, point: [hit.point.x, hit.point.y, hit.point.z], len } : { eid: null, len };
      },
      stats: () => ({
        shots: gunplay.stats.shots,
        hits: gunplay.stats.hits,
        kills: gunplay.stats.kills,
        ammo: gunplay.weapon.ammo,
        reloading: gunplay.weapon.reloading,
        aimBlocked: gunplay.aimBlocked,
        spreadDeg: gunplay.spreadNow(),
        health: operator.health,
        lit: operator.lit,
        stance: operator.stance,
        colliderHeight: operator.colliderHeight,
        feet: operator.feet(new THREE.Vector3()).toArray(),
        targets: dummies.map((d) => ({ name: d.name, health: d.health, dead: d.dead, feet: d.feet(new THREE.Vector3()).toArray() })),
        enemies: enemies.map((e) => ({ name: e.name, state: e.state, health: e.health, dead: e.dead, feet: e.feet(new THREE.Vector3()).toArray(), ...e.coverState() })),
      }),
    };
    let qaAim = false;
    const capture = (globalThis as { __spark?: CaptureAPI }).__spark;
    if (capture) capture.game = qa;
    bag.add(() => {
      if (capture && capture.game === qa) capture.game = undefined;
    });

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
      update(dt) {
        if (!freelook && input.pointerLockUnavailable) {
          freelook = true;
          logger.warn(`mission: pointer lock unavailable here (${input.pointerLockError}); using free look`);
        }
        const locked = freelook || input.isPointerLocked;
        if (locked) {
          const d = input.pointerDelta;
          camera.look(d.x, d.y);
        }
        operator.update(input, camera, now, dt);
        if (qaAim) operator.aiming = true;
        if (input.wasPressed('F4')) navLines.visible = !navLines.visible;
        if (operator.dead && input.wasPressed('Enter')) retry();
        interactHeld = !operator.dead && input.isDown('KeyF');
        // The click that takes control must not also fire.
        gunplay.update((locked && input.isButtonDown(0)) || autoFire > 0, (locked && input.wasButtonPressed(0)) || autoFire > 0, input.wasPressed('KeyR') || (autoFire > 0 && gunplay.weapon.ammo === 0));
        const weapon = gunplay.weapon;
        operator.reloading = weapon.reloading;
        hud.setLocked(locked, freelook && !FREELOOK ? 'pointer lock refused by this view: free look, cursor stays visible. Open http://localhost:5174 in a browser tab for the real thing' : null);
        hud.setAiming(operator.aiming);
        const viewportHeight = ctx.config.container.clientHeight || 720;
        hud.setSpread(camera.projectAngleRadius(THREE.MathUtils.degToRad(gunplay.spreadNow()), viewportHeight));
        gunplay.reticleOffset(viewportHeight, reticle);
        hud.setReticle(reticle.x, reticle.y, gunplay.aimBlocked);
        hud.setAmmo(weapon.ammo, weapon.reserve, weapon.reloading, weapon.reloadProgress);
        hud.setHealth(operator.health / OPERATOR_MAX_HEALTH, Math.max(0, 1 - (now - operator.lastHitAt) / HURT_FADE) * (operator.dead ? 1 : 0.85));
        sfx.setHeartbeat(operator.dead ? 0 : operator.health / OPERATOR_MAX_HEALTH);
        hud.setVisibility(operator.lit);
        const alertState = overallState(enemies.filter((e) => !e.dead).map((e) => e.state));
        hud.setAlert(alertState);
        if (alertState === 'alert' && !wasAlert) sfx.alertStinger();
        wasAlert = alertState === 'alert';
        hud.setStatus(operator.stance, operator.speed, operator.grounded);
        hud.setScore(gunplay.stats.hits, gunplay.stats.kills, enemies.filter((e) => !e.dead).length);
        hud.setFailed(operator.dead);
        const ms = mission.status();
        sfx.setPlantProgress(ms.objective?.kind === 'plant' ? ms.progress : 0);
        const promptText =
          ms.objective?.kind === 'plant' && ms.inRange ? (ms.progress > 0 ? 'setting charge' : 'hold F to set the charge') : null;
        hud.setObjective(ms.index, ms.total, ms.objective?.label ?? null, ms.distance, ms.progress, promptText);
        hud.setComplete(ms.complete);
      },
      fixedUpdate(fixedDt) {
        now += fixedDt;
        operator.fixedUpdate(fixedDt);
        gunplay.fixedUpdate(fixedDt);
        if (autoFire > 0) {
          autoFire = Math.max(0, autoFire - (gunplay.stats.shots - shotsSeen));
        }
        shotsSeen = gunplay.stats.shots;
        for (const d of dummies) d.fixedUpdate(now);
        sampleLit();
        for (const e of enemies) e.fixedUpdate(fixedDt, now, operator, onAlert);
        gore.fixedUpdate(fixedDt);
        // Retire ragdolls past the cap or the age limit; their bones keep the last pose.
        const live = ragdolls.list();
        for (let i = 0; i < live.length; i++) {
          const r = live[i];
          if (!r) continue;
          if (live.length - i > MAX_RAGDOLLS || r.age > RAGDOLL_SECONDS) enemies.find((e) => e.eid === r.owner)?.retireRagdoll();
        }
        operator.feet(feet);
        mission.fixedUpdate(fixedDt, feet, interactHeld, enemies.filter((e) => !e.dead).length);
        if (mission.justCompleted) {
          logger.info(`mission: objective "${mission.justCompleted.id}" complete, checkpoint moved`);
          sfx.objectiveComplete(mission.justCompleted.kind, mission.complete);
          mission.justCompleted = null;
        }
      },
      lateUpdate(dt) {
        syncCamera();
        camera.update(dt, occluder);
        weather.update(feet);
        sfx.update(dt, camera.camera.getWorldPosition(listenerPos));
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
