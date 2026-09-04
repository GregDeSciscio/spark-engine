import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  CameraRig,
  DisposeBag,
  RenderSync,
  THIRD_PERSON_PRESET,
  Transform,
  Renderable,
  InstancedRenderSync,
  createBar,
  createMenuItem,
  createPanel,
  createText,
  damp,
  renderAllPlaceholders,
  type AnimationGraphDef,
  type CameraRigPreset,
  type Entity,
  type SceneDefinition,
  type SceneInstance,
  type SoundDefinition,
} from '@spark/engine';

const MANNEQUIN_URL = '/models/mannequin.glb';
const CROWD_COLUMNS = 4;
const CROWD_ROWS = 3;
const DEBRIS_COUNT = 6;
const WALK_SPEED = 1.2;
const RUN_SPEED = 4.0;
const TURN_RATE = 10;
const SPEED_RATE = 8;
const ATTACK_REACH = 2.2;
const STAMINA_DRAIN = 0.22;
const STAMINA_REGEN = 0.12;
const HEALTH_REGEN = 0.02;

/** Same graph as the animation scene: idle/walk/run blend, hit/death by trigger, additive upper-body attack. */
const MANNEQUIN_GRAPH: AnimationGraphDef = {
  params: { speed: 0, dead: 0 },
  layers: [
    {
      name: 'base',
      entry: 'locomotion',
      states: [
        {
          name: 'locomotion',
          blend: {
            param: 'speed',
            points: [
              { clip: 'idle', threshold: 0 },
              { clip: 'walk', threshold: WALK_SPEED },
              { clip: 'run', threshold: RUN_SPEED },
            ],
          },
        },
        { name: 'hit', clip: 'hit', transitions: [{ to: 'locomotion', exitTime: 1, duration: 0.15 }] },
        { name: 'death', clip: 'death', transitions: [{ to: 'locomotion', conditions: [{ trigger: 'respawn' }], duration: 0.3 }] },
      ],
      anyState: [
        { to: 'death', conditions: [{ trigger: 'die' }], duration: 0.1 },
        { to: 'hit', conditions: [{ trigger: 'hit' }, { param: 'dead', op: '==', value: 0 }], duration: 0.08, allowSelf: true },
      ],
    },
    {
      name: 'upper',
      entry: 'none',
      mask: ['spine', 'chest', 'head', 'upperArm_R', 'lowerArm_R'],
      states: [
        { name: 'none' },
        { name: 'attack', clip: 'attack', transitions: [{ to: 'none', exitTime: 1, duration: 0.15 }] },
      ],
      anyState: [{ to: 'attack', conditions: [{ trigger: 'attack' }, { param: 'dead', op: '==', value: 0 }], duration: 0.05 }],
    },
  ],
};

const FOLLOW_CAMERA: CameraRigPreset = {
  ...THIRD_PERSON_PRESET,
  yaw: Math.PI,
  pitch: THREE.MathUtils.degToRad(19),
  distance: 7,
  fov: 52,
  followRate: 6,
};

/** Placeholder cue list for this scene. Replace by pointing `url` at real files (see docs/audio/cue-sheet.md). */
const CUES: readonly Omit<SoundDefinition, 'buffer' | 'url'>[] = [
  { name: 'placeholder-footstep', bus: 'sfx', volume: 0.5, pitchVariance: 2, volumeVariance: 0.25, cooldownMs: 90, maxInstances: 6 },
  { name: 'placeholder-impact', bus: 'sfx', volume: 0.9, pitchVariance: 1.5, cooldownMs: 40, maxInstances: 4 },
  { name: 'placeholder-ui-click', bus: 'ui', volume: 0.6 },
  { name: 'placeholder-neon-buzz', bus: 'ambience', volume: 0.7, loop: true },
  { name: 'placeholder-rain', bus: 'ambience', volume: 0.5, loop: true },
  { name: 'placeholder-music-base', bus: 'music', volume: 0.8, loop: true },
  { name: 'placeholder-music-layer', bus: 'music', volume: 0.8, loop: true },
];

interface CrowdMember {
  eid: Entity;
  name: string;
  health: number;
  nextAt: number;
  dead: boolean;
  diedAt: number;
}

/**
 * Milestone 10 demonstration: the audio and UI modules on top of the
 * animation scene at small scale. A DOM HUD (health, stamina, state readout),
 * pooled world-space health bars + names over twelve mannequins, damage
 * numbers when the player's attack lands (Space, proximity check), an Escape
 * menu that captures input, and placeholder audio: rain bed, a spatial neon
 * buzz on the lamp, footsteps from animation events, impacts from physics
 * contacts and attacks, UI clicks, and a two-stem music bed whose intensity
 * follows the player's speed. Same seed = same crowd = same pixels; the DOM
 * overlay is outside the canvas screenshot.
 */
export const hudScene: SceneDefinition = {
  name: 'hud',
  async create(ctx): Promise<SceneInstance> {
    const bag = new DisposeBag();
    const { entities, animation, assets, audio, ui, physics, input, random, logger } = ctx;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0d13);
    scene.fog = new THREE.Fog(0x0b0d13, 28, 60);

    const rig = new CameraRig({ preset: FOLLOW_CAMERA, aspect: ctx.renderer.aspect, near: 0.1, far: 120, random: random.fork() });
    ui.setCamera(rig.camera);
    audio.setListenerCamera(rig.camera);
    bag.add(() => {
      ui.setCamera(null);
      audio.setListenerCamera(null);
    });

    const pmrem = new THREE.PMREMGenerator(ctx.renderer.three);
    const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    scene.environmentIntensity = 0.3;
    bag.add(() => {
      envTarget.dispose();
      pmrem.dispose();
    });

    const sun = new THREE.DirectionalLight(0xdfe6ff, 1.6);
    sun.position.set(-8, 18, -6);
    sun.castShadow = ctx.quality.shadows;
    sun.shadow.mapSize.set(ctx.quality.shadowMapSize, ctx.quality.shadowMapSize);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    sun.shadow.camera.left = -18;
    sun.shadow.camera.right = 18;
    sun.shadow.camera.top = 18;
    sun.shadow.camera.bottom = -18;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.target.position.set(0, 0, 6);
    scene.add(sun, sun.target);
    scene.add(new THREE.HemisphereLight(0x6f8cff, 0x1c1610, 0.4));

    const groundGeo = new THREE.PlaneGeometry(80, 80);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.85, metalness: 0.05 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(80, 40, 0x343b4c, 0x2a303d);
    grid.position.y = 0.005;
    scene.add(grid);
    bag.add(() => {
      groundGeo.dispose();
      groundMat.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
    });

    // ---- systems + physics ground ----------------------------------------------
    const renderSync = new RenderSync(entities);
    const instanced = new InstancedRenderSync(entities);
    bag.add(entities.addSystem(renderSync));
    bag.add(entities.addSystem(instanced));
    const spawned: Entity[] = [];
    physics.layers.define('world', 'debris');
    const groundBody = entities.create([Transform, { y: -0.5 }]);
    physics.addBody(groundBody, { type: 'fixed', shape: { kind: 'box', hx: 40, hy: 0.5, hz: 40 }, layer: 'world', friction: 0.8, events: false });
    spawned.push(groundBody);

    // ---- lamp prop: the spatial neon buzz lives here ----------------------------
    const lampPos = new THREE.Vector3(4.5, 0, 2.5);
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.08, 3.2, 12);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3b4150, roughness: 0.5, metalness: 0.7 });
    const tubeGeo = new THREE.CapsuleGeometry(0.07, 0.9, 4, 12);
    const tubeMat = new THREE.MeshStandardMaterial({ color: 0xff9ad6, emissive: 0xff4fb8, emissiveIntensity: 3.5, roughness: 0.3 });
    const lamp = new THREE.Group();
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = 1.6;
    pole.castShadow = true;
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    tube.position.set(0, 3.1, 0);
    tube.rotation.z = Math.PI / 2;
    const glow = new THREE.PointLight(0xff5fc0, 14, 12, 2);
    glow.position.set(0, 3.0, 0);
    lamp.add(pole, tube, glow);
    scene.add(lamp);
    bag.add(() => {
      poleGeo.dispose();
      poleMat.dispose();
      tubeGeo.dispose();
      tubeMat.dispose();
    });
    const lampEid = entities.create([Transform, { x: lampPos.x, y: lampPos.y, z: lampPos.z }]);
    renderSync.attach(entities, lampEid, lamp);
    spawned.push(lampEid);

    // ---- debris: a few dynamic cubes so physics contacts fire impact cues ------
    const debrisGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    const debrisMat = new THREE.MeshStandardMaterial({ color: 0x6fc3ff, roughness: 0.45, metalness: 0.15 });
    bag.add(() => {
      debrisGeo.dispose();
      debrisMat.dispose();
    });
    const debris = instanced.createBatch(debrisGeo, debrisMat, DEBRIS_COUNT);
    debris.mesh.castShadow = true;
    debris.mesh.receiveShadow = true;
    scene.add(debris.mesh);
    for (let i = 0; i < DEBRIS_COUNT; i++) {
      const eid = entities.create(
        [Transform, { x: lampPos.x - 1.5 + random.range(-0.6, 0.6), y: 3 + i * 0.9, z: lampPos.z + 1.2 + random.range(-0.6, 0.6) }],
        Renderable,
      );
      physics.addBody(eid, { type: 'dynamic', shape: { kind: 'box', hx: 0.25, hy: 0.25, hz: 0.25 }, layer: 'debris', friction: 0.6, restitution: 0.25 });
      debris.add(eid);
      spawned.push(eid);
    }

    // ---- mannequins --------------------------------------------------------------
    const mannequin = await assets.loadModel(MANNEQUIN_URL);
    bag.add(() => assets.release(MANNEQUIN_URL));

    const spawnMannequin = (x: number, z: number, yaw: number, rootMotion: 'transform' | 'none'): { eid: Entity; object: THREE.Object3D } => {
      const object = mannequin.instantiate({ castShadow: true, receiveShadow: true });
      scene.add(object);
      const eid = entities.create([Transform, { x, z, qy: Math.sin(yaw / 2), qw: Math.cos(yaw / 2) }]);
      renderSync.attach(entities, eid, object);
      animation.attach(eid, object, mannequin.animations, MANNEQUIN_GRAPH, { rootMotion: { mode: rootMotion } });
      spawned.push(eid);
      return { eid, object };
    };

    const player = spawnMannequin(0, 0, 0, 'transform');
    const playerMaterials: THREE.Material[] = [];
    player.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const source = mesh.material as THREE.MeshStandardMaterial;
      const tinted = source.clone();
      tinted.color.setHex(source.name.includes('accent') ? 0x3a1e16 : 0xff7a4d);
      mesh.material = tinted;
      playerMaterials.push(tinted);
    });
    bag.add(() => {
      for (const m of playerMaterials) m.dispose();
    });
    ui.labels.attach(player.eid, { kind: 'text', text: 'YOU', color: '#ffb08a', offsetY: 2.15 });

    const crowd: CrowdMember[] = [];
    for (let i = 0; i < CROWD_COLUMNS * CROWD_ROWS; i++) {
      const col = i % CROWD_COLUMNS;
      const row = Math.floor(i / CROWD_COLUMNS);
      const x = (col - (CROWD_COLUMNS - 1) / 2) * 2.2 + random.range(-0.3, 0.3);
      const z = 3.5 + row * 2.2 + random.range(-0.3, 0.3);
      const { eid } = spawnMannequin(x, z, Math.PI + random.range(-0.6, 0.6), 'none');
      const roll = random.next();
      if (roll < 0.15) {
        animation.setTrigger(eid, 'attack');
        animation.setParam(eid, 'speed', random.pick([0, WALK_SPEED]));
      } else {
        animation.setParam(eid, 'speed', random.pick([0, 0, WALK_SPEED * 0.5, WALK_SPEED, RUN_SPEED]));
      }
      animation.advance(eid, random.range(0, 2));
      const name = `Unit ${String(i + 1).padStart(2, '0')}`;
      ui.labels.attach(eid, { kind: 'healthbar', text: name, offsetY: 2.05 });
      crowd.push({ eid, name, health: 1, nextAt: random.range(0.3, 2.5), dead: false, diedAt: 0 });
    }

    // ---- audio: placeholder cues, beds, event bindings --------------------------
    const placeholders = await renderAllPlaceholders();
    for (const cue of CUES) {
      const buffer = placeholders.get(cue.name as Parameters<typeof placeholders.get>[0]);
      if (!buffer) throw new Error(`hud: no placeholder buffer for ${cue.name}`);
      audio.defineSound({ ...cue, buffer });
    }
    bag.add(() => {
      for (const cue of CUES) audio.undefineSound(cue.name);
    });
    audio.setVolume('music', 0.7);
    audio.ambience.play('placeholder-rain', { fadeIn: 2 });
    audio.music.play({ base: 'placeholder-music-base', layer: 'placeholder-music-layer' }, { fadeIn: 1.5 });
    const buzz = audio.playAt('placeholder-neon-buzz', lampEid, { loop: true, spatial: { refDistance: 2, rolloff: 1.4, maxDistance: 30 } });
    bag.add(() => {
      buzz.stop(0.1);
      audio.music.stop(0.2);
      audio.ambience.stop(0.2);
      audio.stopAll(0.1);
    });
    bag.add(audio.bindAnimationEvents(animation, { footstep: 'placeholder-footstep' }));
    bag.add(audio.bindPhysicsEvents(physics, { collisionStart: 'placeholder-impact' }, { minImpulse: 1.5, maxImpulse: 8 }));

    // ---- gameplay state --------------------------------------------------------------
    const t = entities.store(Transform);
    let facing = 0;
    let speed = 0;
    let health = 1;
    let stamina = 1;
    let exhausted = false;
    let time = 0;
    let orbitYaw = FOLLOW_CAMERA.yaw;
    let hits = 0;
    const forward = new THREE.Vector3();

    const nearestInReach = (): CrowdMember | null => {
      const px = t.x[player.eid] ?? 0;
      const pz = t.z[player.eid] ?? 0;
      const fx = Math.sin(facing);
      const fz = Math.cos(facing);
      let best: CrowdMember | null = null;
      let bestD = ATTACK_REACH;
      for (const m of crowd) {
        if (m.dead) continue;
        const dx = (t.x[m.eid] ?? 0) - px;
        const dz = (t.z[m.eid] ?? 0) - pz;
        const d = Math.hypot(dx, dz);
        if (d >= bestD) continue;
        if (d > 0.3 && (dx * fx + dz * fz) / d < 0.2) continue;
        best = m;
        bestD = d;
      }
      return best;
    };

    // The attack clip's `hit` marker (0.3 s in) is the contact frame: resolve damage then.
    bag.add(
      animation.events.on('event', (e) => {
        if (e.eid !== player.eid || e.name !== 'hit') return;
        const target = nearestInReach();
        if (!target) return;
        const damage = random.int(8, 24);
        target.health = Math.max(0, target.health - damage / 100);
        ui.labels.setValue(target.eid, target.health);
        ui.labels.popup(target.eid, `-${damage}`, { life: 0.9, color: '#ff6a4a', size: 18 });
        audio.playAt('placeholder-impact', target.eid);
        animation.setTrigger(target.eid, 'hit');
        hits += 1;
        if (target.health <= 0) {
          target.dead = true;
          target.diedAt = time;
          animation.setParam(target.eid, 'dead', 1);
          animation.setParam(target.eid, 'speed', 0);
          animation.setTrigger(target.eid, 'die');
          ui.labels.popup(target.eid, 'DOWN', { life: 1.2, color: '#ffd166', size: 14, rise: 1.4 });
        }
      }),
    );

    // ---- HUD --------------------------------------------------------------------------
    const hud = createPanel({ title: 'Status', anchor: 'top-right' });
    const healthBar = createBar({ label: 'health', color: 'var(--spark-ui-health)' });
    const staminaBar = createBar({ label: 'stamina', color: 'var(--spark-ui-stamina)' });
    const readout = createText('', { dim: true });
    hud.add(healthBar, staminaBar, readout);
    ui.mount('hud', hud);

    const help = createPanel({ anchor: 'bottom-left' });
    const audioNote = createText('placeholder audio: click to enable');
    const controls = createText('WASD move · Shift walk · Space attack · Esc menu · drag orbit', { dim: true });
    help.add(audioNote, controls);
    ui.mount('hud', help);

    const menu = createPanel({ title: 'Paused', anchor: 'center', className: 'spark-menu' });
    const closeMenu = (): void => {
      if (!ui.isVisible('menu')) return;
      ui.hide('menu');
      audio.play('placeholder-ui-click');
    };
    menu.add(
      createText('Game input is captured while this is open.', { dim: true }),
      createMenuItem('Resume (Esc)', closeMenu),
      createMenuItem('Mute music', () => {
        audio.mute('music', !audio.isMuted('music'));
        audio.play('placeholder-ui-click');
      }),
    );
    ui.mount('menu', menu);
    bag.add(() => {
      ui.hide('menu');
      ui.unmount(hud);
      ui.unmount(help);
      ui.unmount(menu);
    });

    const updateHud = (): void => {
      healthBar.set(health);
      staminaBar.set(stamina);
      const base = animation.snapshot(player.eid, 0);
      const upper = animation.snapshot(player.eid, 1);
      const gait = speed < WALK_SPEED * 0.5 ? 'idle' : speed < (WALK_SPEED + RUN_SPEED) / 2 ? 'walk' : 'run';
      const stats = audio.stats();
      readout.set(
        `${base.state === 'locomotion' ? gait : base.state}${upper.state === 'attack' ? ' + attack' : ''} · ${speed.toFixed(1)} m/s${exhausted ? ' · exhausted' : ''}\n` +
          `hits ${hits} · labels ${ui.labels.stats().visible}/${ui.labels.stats().active}\n` +
          `audio ${stats.state} · voices ${stats.activeVoices} · music ${(stats.music.intensity * 100).toFixed(0)}%`,
      );
      audioNote.set(
        stats.state === 'running'
          ? `placeholder audio: running (${stats.activeVoices} voices, ${stats.spatialVoices} spatial)`
          : stats.state === 'unavailable'
            ? 'placeholder audio: WebAudio unavailable'
            : 'placeholder audio: click to enable',
      );
    };
    updateHud();
    logger.info(`hud: ${crowd.length} crowd, ${DEBRIS_COUNT} debris, ${CUES.length} placeholder cues`);

    rig.target.set(0, 1, 0);
    rig.snap();

    return {
      scene,
      camera: rig.camera,
      fixedUpdate(dt): void {
        time += dt;
        rig.camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        // Input reads are empty while the menu captures, so the player simply stops.
        const strafe = Math.max(-1, Math.min(1, input.axis('KeyA', 'KeyD') + input.axis('ArrowLeft', 'ArrowRight')));
        const advance = Math.max(-1, Math.min(1, input.axis('KeyS', 'KeyW') + input.axis('ArrowDown', 'ArrowUp')));
        const mx = forward.x * advance + -forward.z * strafe;
        const mz = forward.z * advance + forward.x * strafe;
        const len = Math.hypot(mx, mz);
        let targetSpeed = 0;
        if (len > 0.01) {
          const wantsWalk = input.isDown('ShiftLeft') || input.isDown('ShiftRight') || exhausted;
          targetSpeed = wantsWalk ? WALK_SPEED : RUN_SPEED;
          const targetYaw = Math.atan2(mx / len, mz / len);
          let diff = targetYaw - facing;
          diff = Math.atan2(Math.sin(diff), Math.cos(diff));
          facing += diff * (1 - Math.exp(-TURN_RATE * dt));
        }
        speed = damp(speed, targetSpeed, SPEED_RATE, dt);
        if (speed < 0.02) speed = 0;
        animation.setParam(player.eid, 'speed', speed);
        t.qx[player.eid] = 0;
        t.qz[player.eid] = 0;
        t.qy[player.eid] = Math.sin(facing / 2);
        t.qw[player.eid] = Math.cos(facing / 2);

        // Stamina: running drains, anything else regenerates; empty forces a walk until a third is back.
        if (speed > WALK_SPEED + 0.1) stamina = Math.max(0, stamina - STAMINA_DRAIN * dt);
        else stamina = Math.min(1, stamina + STAMINA_REGEN * dt);
        if (stamina <= 0) exhausted = true;
        else if (exhausted && stamina > 0.33) exhausted = false;
        health = Math.min(1, health + HEALTH_REGEN * dt);

        for (const m of crowd) {
          if (time < m.nextAt) continue;
          m.nextAt = time + random.range(0.8, 3.0);
          if (m.dead) {
            if (time - m.diedAt < 3) continue;
            m.dead = false;
            m.health = 1;
            ui.labels.setValue(m.eid, 1);
            animation.setParam(m.eid, 'dead', 0);
            animation.setTrigger(m.eid, 'respawn');
            continue;
          }
          const roll = random.next();
          if (roll < 0.5) animation.setParam(m.eid, 'speed', random.pick([0, WALK_SPEED, RUN_SPEED, random.range(0, RUN_SPEED)]));
          else if (roll < 0.8) animation.setTrigger(m.eid, 'attack');
          else animation.setTrigger(m.eid, 'hit');
        }
      },
      update(dt): void {
        if (input.wasPressed('Escape')) {
          if (ui.isVisible('menu')) closeMenu();
          else {
            ui.show('menu');
            audio.play('placeholder-ui-click');
          }
        }
        if (input.wasPressed('Space')) animation.setTrigger(player.eid, 'attack');
        if (input.wasPressed('KeyH')) {
          animation.setTrigger(player.eid, 'hit');
          health = Math.max(0, health - 0.15);
          ui.labels.popup(player.eid, '-15', { life: 0.9, color: '#ff6a4a', size: 18 });
          audio.playAt('placeholder-impact', player.eid);
        }
        if (input.isButtonDown(0) || input.isButtonDown(2)) orbitYaw -= input.pointerDelta.x * 0.006;
        const orbit = rig.getOrbit();
        rig.setOrbit(orbitYaw, orbit.pitch, orbit.distance);
        audio.music.setIntensity(Math.min(1, speed / RUN_SPEED), 0.6);
        void dt;
      },
      lateUpdate(dt): void {
        rig.target.set(t.x[player.eid] ?? 0, (t.y[player.eid] ?? 0) + 1.0, t.z[player.eid] ?? 0);
        rig.update(dt);
        updateHud();
      },
      resize(width, height): void {
        rig.setAspect(width / height);
      },
      dispose(): void {
        for (const eid of spawned) entities.destroy(eid);
        bag.dispose();
        scene.clear();
      },
    };
  },
};
