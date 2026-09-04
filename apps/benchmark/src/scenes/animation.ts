import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  CameraRig,
  DisposeBag,
  RenderSync,
  THIRD_PERSON_PRESET,
  Transform,
  damp,
  type AnimationEvent,
  type AnimationGraphDef,
  type CameraRigPreset,
  type Entity,
  type SceneDefinition,
  type SceneInstance,
} from '@spark/engine';

const MANNEQUIN_URL = '/models/mannequin.glb';
const CROWD_COLUMNS = 10;
const CROWD_ROWS = 6;
const WALK_SPEED = 1.2;
const RUN_SPEED = 4.0;
const TURN_RATE = 10;
const SPEED_RATE = 8;

/**
 * The Milestone 6 graph. Base layer: a 1D idle/walk/run blend on `speed`, with
 * `hit` and `death` reachable from anywhere by trigger. Upper layer: an
 * additive `attack` masked to the spine, chest, head and right arm, so it
 * plays over walking or running.
 */
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
  pitch: THREE.MathUtils.degToRad(21),
  distance: 7.5,
  fov: 52,
  followRate: 6,
};

interface CrowdMember {
  eid: Entity;
  nextAt: number;
  dead: boolean;
  diedAt: number;
}

/**
 * Milestone 6 demonstration: the skinned mannequin from the asset pipeline,
 * one player driven by input through a state machine (WASD idle/walk/run blend
 * with root motion moving the entity, Shift walks, Space = additive attack on
 * the upper body, H = hit, K = death, R = respawn, drag to orbit) under a
 * third-person camera rig, plus 60 background mannequins cycling states on a
 * seeded schedule. Same seed = same crowd = same pixels.
 */
export const animationScene: SceneDefinition = {
  name: 'animation',
  async create(ctx): Promise<SceneInstance> {
    const bag = new DisposeBag();
    const { entities, animation, assets, input, random, logger } = ctx;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0d13);
    scene.fog = new THREE.Fog(0x0b0d13, 30, 70);

    const rig = new CameraRig({ preset: FOLLOW_CAMERA, aspect: ctx.renderer.aspect, near: 0.1, far: 120, random: random.fork() });

    const pmrem = new THREE.PMREMGenerator(ctx.renderer.three);
    const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    scene.environmentIntensity = 0.35;
    bag.add(() => {
      envTarget.dispose();
      pmrem.dispose();
    });

    const sun = new THREE.DirectionalLight(0xffedd6, 3.0);
    sun.position.set(-8, 18, -6);
    sun.castShadow = ctx.quality.shadows;
    sun.shadow.mapSize.set(ctx.quality.shadowMapSize, ctx.quality.shadowMapSize);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    sun.shadow.camera.left = -22;
    sun.shadow.camera.right = 22;
    sun.shadow.camera.top = 22;
    sun.shadow.camera.bottom = -22;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.target.position.set(0, 0, 8);
    scene.add(sun, sun.target);
    scene.add(new THREE.HemisphereLight(0x8aa4ff, 0x2a2016, 0.45));

    const groundGeo = new THREE.PlaneGeometry(90, 90);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x272b34, roughness: 0.92 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(90, 45, 0x3a4152, 0x2f3542);
    grid.position.y = 0.005;
    scene.add(grid);
    bag.add(() => {
      groundGeo.dispose();
      groundMat.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
    });

    // ---- systems + assets ---------------------------------------------------
    const renderSync = new RenderSync(entities);
    bag.add(entities.addSystem(renderSync));
    const spawned: Entity[] = [];

    const mannequin = await assets.loadModel(MANNEQUIN_URL);
    bag.add(() => assets.release(MANNEQUIN_URL));
    logger.info(
      `mannequin: ${mannequin.info.triangles} tris, skinned=${mannequin.info.skinned}, clips [${mannequin.clips
        .map((c) => `${c.name} ${c.duration.toFixed(2)}s${Array.isArray(c.spark.events) ? ` ${c.spark.events.length}ev` : ''}${c.spark.loop === false ? ' once' : ''}`)
        .join(', ')}]`,
    );

    const spawnMannequin = (x: number, z: number, yaw: number, rootMotion: 'transform' | 'none'): { eid: Entity; object: THREE.Object3D } => {
      const object = mannequin.instantiate({ castShadow: true, receiveShadow: true });
      scene.add(object);
      const eid = entities.create([Transform, { x, z, qy: Math.sin(yaw / 2), qw: Math.cos(yaw / 2) }]);
      renderSync.attach(entities, eid, object);
      animation.attach(eid, object, mannequin.animations, MANNEQUIN_GRAPH, { rootMotion: { mode: rootMotion } });
      spawned.push(eid);
      return { eid, object };
    };

    // ---- player -------------------------------------------------------------
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
    let facing = 0;
    let speed = 0;
    let dead = false;
    let lastEvent: AnimationEvent | null = null;
    bag.add(
      animation.events.on('event', (e) => {
        if (e.eid === player.eid) lastEvent = e;
      }),
    );
    bag.add(
      animation.events.on('transition', (t) => {
        if (t.eid === player.eid) logger.debug(`player layer ${t.layer}: ${t.from} -> ${t.to}`);
      }),
    );

    // ---- crowd: seeded initial states + schedule ----------------------------
    const crowd: CrowdMember[] = [];
    for (let i = 0; i < CROWD_COLUMNS * CROWD_ROWS; i++) {
      const col = i % CROWD_COLUMNS;
      const row = Math.floor(i / CROWD_COLUMNS);
      const x = (col - (CROWD_COLUMNS - 1) / 2) * 1.9 + random.range(-0.3, 0.3);
      const z = 4.5 + row * 2.1 + random.range(-0.3, 0.3);
      const { eid } = spawnMannequin(x, z, Math.PI + random.range(-0.6, 0.6), 'none');
      const roll = random.next();
      if (roll < 0.1) {
        animation.setParam(eid, 'dead', 1);
        animation.play(eid, 'death', 0, { duration: 0, offset: random.range(0, 1) });
      } else if (roll < 0.22) {
        animation.setTrigger(eid, 'hit');
      } else if (roll < 0.4) {
        animation.setTrigger(eid, 'attack');
        animation.setParam(eid, 'speed', random.pick([0, WALK_SPEED, RUN_SPEED]));
      } else {
        animation.setParam(eid, 'speed', random.pick([0, 0, WALK_SPEED * 0.5, WALK_SPEED, (WALK_SPEED + RUN_SPEED) / 2, RUN_SPEED]));
      }
      animation.advance(eid, random.range(0, 2));
      crowd.push({ eid, nextAt: random.range(0.3, 2.5), dead: roll < 0.1, diedAt: 0 });
    }

    // ---- DOM label ------------------------------------------------------------
    const label = document.createElement('div');
    label.setAttribute('data-spark-animation', '');
    Object.assign(label.style, {
      position: 'absolute',
      left: '12px',
      bottom: '12px',
      padding: '6px 10px',
      font: '12px/1.5 ui-monospace, Consolas, monospace',
      color: '#d8e0ff',
      background: 'rgba(8, 10, 16, 0.75)',
      borderRadius: '4px',
      pointerEvents: 'none',
      whiteSpace: 'pre',
      zIndex: '10',
    } satisfies Partial<CSSStyleDeclaration>);
    ctx.config.container.appendChild(label);
    bag.add(() => label.remove());
    const updateLabel = (): void => {
      const base = animation.snapshot(player.eid, 0);
      const upper = animation.snapshot(player.eid, 1);
      const blend = base.state === 'locomotion' ? ` (${speed < WALK_SPEED * 0.5 ? 'idle' : speed < (WALK_SPEED + RUN_SPEED) / 2 ? 'walk' : 'run'})` : '';
      const ev = lastEvent ? `${lastEvent.name}${typeof lastEvent.marker.foot === 'string' ? ` ${lastEvent.marker.foot}` : ''} @ ${lastEvent.time.toFixed(2)}s (${lastEvent.clip})` : '-';
      label.textContent =
        `state: ${base.state}${blend}${base.transitioning ? ' ~' : ''} · upper: ${upper.state}${upper.transitioning ? ' ~' : ''} · speed ${speed.toFixed(1)} m/s\n` +
        `last event: ${ev}\n` +
        `WASD move · Shift walk · Space attack · H hit · K die · R respawn · drag orbit`;
    };
    updateLabel();

    const t = entities.store(Transform);
    const forward = new THREE.Vector3();
    let time = 0;
    let orbitYaw = FOLLOW_CAMERA.yaw;
    rig.target.set(0, 1, 0);
    rig.snap();

    return {
      scene,
      camera: rig.camera,
      fixedUpdate(dt): void {
        time += dt;
        // Player: camera-relative input → facing + speed parameter; root motion moves the entity.
        rig.camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        const strafe = dead ? 0 : Math.max(-1, Math.min(1, input.axis('KeyA', 'KeyD') + input.axis('ArrowLeft', 'ArrowRight')));
        const advance = dead ? 0 : Math.max(-1, Math.min(1, input.axis('KeyS', 'KeyW') + input.axis('ArrowDown', 'ArrowUp')));
        const mx = forward.x * advance + -forward.z * strafe;
        const mz = forward.z * advance + forward.x * strafe;
        const len = Math.hypot(mx, mz);
        let targetSpeed = 0;
        if (len > 0.01) {
          targetSpeed = input.isDown('ShiftLeft') || input.isDown('ShiftRight') ? WALK_SPEED : RUN_SPEED;
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

        // Crowd schedule: seeded, fixed-step, so the same seed gives the same show.
        for (const m of crowd) {
          if (time < m.nextAt) continue;
          m.nextAt = time + random.range(0.8, 3.0);
          if (m.dead) {
            if (time - m.diedAt < 2) continue;
            m.dead = false;
            animation.setParam(m.eid, 'dead', 0);
            animation.setTrigger(m.eid, 'respawn');
            continue;
          }
          const roll = random.next();
          if (roll < 0.45) animation.setParam(m.eid, 'speed', random.pick([0, WALK_SPEED, RUN_SPEED, random.range(0, RUN_SPEED)]));
          else if (roll < 0.7) animation.setTrigger(m.eid, 'attack');
          else if (roll < 0.88) animation.setTrigger(m.eid, 'hit');
          else {
            m.dead = true;
            m.diedAt = time;
            animation.setParam(m.eid, 'dead', 1);
            animation.setParam(m.eid, 'speed', 0);
            animation.setTrigger(m.eid, 'die');
          }
        }
      },
      update(dt): void {
        if (!dead) {
          if (input.wasPressed('Space')) animation.setTrigger(player.eid, 'attack');
          if (input.wasPressed('KeyH')) animation.setTrigger(player.eid, 'hit');
          if (input.wasPressed('KeyK')) {
            dead = true;
            animation.setParam(player.eid, 'dead', 1);
            animation.setTrigger(player.eid, 'die');
          }
        } else if (input.wasPressed('KeyR')) {
          dead = false;
          animation.setParam(player.eid, 'dead', 0);
          animation.setTrigger(player.eid, 'respawn');
        }
        if (input.isButtonDown(0) || input.isButtonDown(2)) orbitYaw -= input.pointerDelta.x * 0.006;
        const orbit = rig.getOrbit();
        rig.setOrbit(orbitYaw, orbit.pitch, orbit.distance);
        void dt;
      },
      lateUpdate(dt): void {
        rig.target.set(t.x[player.eid] ?? 0, (t.y[player.eid] ?? 0) + 1.0, t.z[player.eid] ?? 0);
        rig.update(dt);
        updateLabel();
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
