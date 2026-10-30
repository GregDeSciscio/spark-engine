import * as THREE from 'three/webgpu';
import {
  CharacterController,
  Destruction,
  GONE,
  DisposeBag,
  LevelLoader,
  NavAgent,
  Navigation,
  RenderSync,
  ShoulderCamera,
  StrainWorkerPool,
  Transform,
  authoredStructure,
  budgetsOf,
  initNavigation,
  type DestructionSave,
  type Entity,
  type LoadedLevel,
  type NavGeometry,
  type PieceBox,
  type SceneDefinition,
  type SceneInstance,
} from '@spark/engine';
import { Hud } from './hud';
import { SOUNDS } from './sounds';

/**
 * The destruction slice (docs/design/destruction-game-readiness.md): a yard
 * authored in Blender (`pnpm level:yard`) whose three buildings are
 * destructible boxes, a player on the shoulder camera, and bots that walk a
 * navmesh rebuilt where the buildings change. Debris and gas hurt; F5 saves a
 * checkpoint and F9 (or dying) goes back to it.
 *
 *   WASD move · Space jump · click to lock the mouse (or right-drag to look)
 *   LMB fire · 1 rocket · 2 rifle · 3 gas grenade · F5 save · F9 load
 */

export type Weapon = 'rocket' | 'rifle' | 'gas';

const LEVEL_URL = '/levels/yard.glb';
const PLAYER_SPEED = 5;
const BOT_SPEED = 3.2;
const CAPSULE = { kind: 'capsule' as const, halfHeight: 0.5, radius: 0.35 };
/** The hit test reaches a few centimetres past the controller's skin. */
const HIT_SHAPE = { ...CAPSULE, radius: CAPSULE.radius + 0.06 };
const ROCKET_RADIUS = 1.7;
/** Damage per kg·m/s of debris momentum: a 2-tonne chunk at 4 m/s takes 40, a storey coming down kills. */
const DEBRIS_DAMAGE = 1 / 200;
/** Damage a second at full gas. */
const GAS_DAMAGE = 30;
const NAV_BOUNDS = { min: { x: -40, y: -1, z: -40 }, max: { x: 40, y: 16, z: 40 } };
const SEEDS: Record<string, number> = { depot: 3, tower: 5, shed: 9 };

interface Bot {
  eid: Entity;
  mesh: THREE.Mesh;
  agent: NavAgent;
  health: number;
  alive: boolean;
  /** Which patrol point it walks to next. */
  leg: number;
  /** Chasing the player (seen within range) rather than patrolling. */
  chasing: boolean;
}

/** What a checkpoint holds: every structure's destroyed state, the player, the bots. */
interface Checkpoint {
  structures: Record<string, DestructionSave>;
  player: [number, number, number, number];
  bots: Array<{ x: number; y: number; z: number; health: number; alive: boolean; leg: number }>;
}

export interface SliceStats {
  structures: Array<{ name: string; chunks: number; standing: number; bodies: number; strainMode: 'worker' | 'inline'; cascading: boolean }>;
  worker: { structures: number; running: boolean };
  budgets: { bodies: number; bodyLimit: number; links: number; linkLimit: number };
  nav: { pendingTiles: number; rebuilt: number };
  player: { x: number; y: number; z: number; health: number; deaths: number; yaw: number; locked: boolean };
  bots: Array<{ x: number; y: number; z: number; health: number; alive: boolean; chasing: boolean; pathComplete: boolean }>;
  hits: number;
  checkpoint: boolean;
  weapon: Weapon;
}

/** The probe surface on `window.__spark.game`. */
export interface SliceApi {
  stats(): SliceStats;
  /** Detonate at a world point (every structure within reach takes it, and the bots near it). */
  explode(x: number, y: number, z: number, radius?: number): number;
  /** Take out a structure's chunks whose centroids lie in the box `min`..`max`. */
  removeBox(structure: string, min: [number, number, number], max: [number, number, number]): number;
  gas(x: number, y: number, z: number): void;
  setPlayer(x: number, y: number, z: number, yaw?: number): void;
  /** Put a bot somewhere and have it stand there (`hold`), or let it go back to its patrol. */
  placeBot(index: number, x: number, y: number, z: number, hold?: boolean): void;
  /** Walking length of the navmesh path between two points, or -1 if it doesn't get there. */
  pathLength(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number;
  /** Rebuild every waiting navmesh tile now; returns how many. */
  flushNav(): number;
  save(): void;
  load(): boolean;
  fire(weapon: Weapon): void;
  aim(yaw: number, pitch: number): void;
  /**
   * How far (m) a structure's chunks built above `aboveY` have come down on average, and how many
   * are still within half a metre of where they were built: a top that floats shows here first.
   */
  drop(structure: string, aboveY: number): { drop: number; inPlace: number; count: number };
  /** Start (or stop) logging every destruction sound played, over all the structures. */
  listen(on: boolean): void;
  /** The sounds played since the last call, by name, with a count each. */
  heard(): Record<string, number>;
}

/**
 * What `pnpm perf` runs (`?scene=slice-yard` or `slice-collapse`): `yard`, the yard standing with the bots on patrol; `collapse`, the
 * same with the probe's barrage on the clock (the tower's ground storey at 2 s, four rockets into the
 * depot at 3 s, three into the shed at 4 s), so the perf window holds three buildings coming down.
 */
export type SliceDemo = 'yard' | 'collapse';

/** The perf barrage, as (sim seconds, what) pairs. */
const COLLAPSE: ReadonlyArray<readonly [number, (api: SliceApi) => void]> = [
  [2, (g) => g.removeBox('tower', [8.5, 0, 5.5], [17.5, 2.8, 14.5])],
  [
    3,
    (g) => {
      for (const [x, y, z] of [
        [-17, 1.4, 2.2],
        [-11, 1.4, 2.2],
        [-14, 4.6, 2.2],
        [-19.8, 1.4, 6],
      ] as const)
        g.explode(x, y, z, 1.8);
    },
  ],
  [
    4,
    (g) => {
      for (const [x, z] of [
        [0, -18.4],
        [2.5, -18],
        [4, -17],
      ] as const)
        g.explode(x, 1.4, z, 2.4);
    },
  ],
];

/** Knobs for measuring what a slower machine needs (`?maxBodies=`, `?navTiles=`). */
export interface SliceTuning {
  /** The structures' shared debris body budget. Default: the engine's. */
  maxBodies?: number | undefined;
  /** Navmesh tiles rebuilt per frame. Default 1. */
  navTiles?: number | undefined;
}

export function sliceScene(onApi: (api: SliceApi) => void, demo: SliceDemo = 'yard', tuning: SliceTuning = {}): SceneDefinition {
  return {
    name: 'slice',
    async create(ctx): Promise<SceneInstance> {
      const { entities, physics, input, quality, logger } = ctx;
      const bag = new DisposeBag();
      const spawned: Entity[] = [];
      const t = entities.store(Transform);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xa7bfd2);
      scene.fog = new THREE.Fog(0xa7bfd2, 60, 160);

      // ---- light ---------------------------------------------------------------------
      const sun = new THREE.DirectionalLight(0xfff0d8, 3.2);
      sun.position.set(-20, 34, -26);
      sun.castShadow = quality.shadows;
      sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
      sun.shadow.camera.left = sun.shadow.camera.bottom = -42;
      sun.shadow.camera.right = sun.shadow.camera.top = 42;
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 120;
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.02;
      scene.add(sun, sun.target, new THREE.HemisphereLight(0xcfe3ff, 0x6d6255, 1.1));

      const renderSync = new RenderSync(entities);
      bag.add(entities.addSystem(renderSync));

      // ---- the level: authored in Blender, its buildings destructible boxes ----------------
      const loader = new LevelLoader({ entities, assets: ctx.assets, renderSync, scene, physics, teams: ['player', 'bots'], castShadow: true, receiveShadow: true });
      const level: LoadedLevel = await loader.load(LEVEL_URL);
      bag.add(level);
      const patrol = level.descriptors
        .filter((d) => d.kind === 'unknown' && d.type === 'patrol')
        .sort((a, b) => Number(a.node.spark['index']) - Number(b.node.spark['index']))
        .map((d) => new THREE.Vector3(...d.node.position));
      const botStarts = level.descriptors.filter((d) => d.kind === 'spawn' && d.team === 'bots').map((d) => new THREE.Vector3(...d.node.position));
      const statics = level.descriptors.flatMap((d) => (d.kind === 'collider' ? [d] : []));

      // ---- the navmesh: the level's static boxes and every structure as it stands now --------
      await initNavigation();
      const structures = new Map<string, Destruction>();
      const geometry: NavGeometry = (soup, min, max) => {
        for (const c of statics) {
          const [x, y, z] = c.node.position;
          const [hx, hy, hz] = c.halfExtents;
          if (x + hx < min.x || x - hx > max.x || z + hz < min.z || z - hz > max.z) continue;
          soup.addBox(x, y, z, hx, hy, hz);
        }
        for (const d of structures.values()) d.navGeometry(soup, min, max);
      };
      let nav: Navigation | null = null;
      bag.add(() => nav?.dispose());

      // One Destruction per authored building: they share the world's budgets and its strain worker.
      const owned = new Map<string, () => void>();
      /** Logging sounds (the probe's `listen`): structures built later, by a checkpoint load, log too. */
      let listening = false;
      const build = (name: string, boxes: readonly PieceBox[]): Destruction => {
        const d = new Destruction(ctx, authoredStructure(boxes, { seed: SEEDS[name] ?? 1 }), { sounds: SOUNDS, ...(tuning.maxBodies === undefined ? {} : { debris: { maxBodies: tuning.maxBodies } }) });
        scene.add(d.object);
        const off = d.systems().map((s) => entities.addSystem(s));
        d.events.on('hit', (h) => hurt(h.eid, h.momentum * DEBRIS_DAMAGE));
        d.events.on('reshape', (r) => nav?.invalidate(r.min, r.max));
        if (listening) d.listen(true);
        structures.set(name, d);
        owned.set(name, () => {
          for (const o of off) o();
          d.dispose();
        });
        return d;
      };
      bag.add(() => {
        for (const release of owned.values()) release();
      });
      for (const [name, boxes] of level.destructibles) build(name, boxes);
      nav = Navigation.tiled(geometry, NAV_BOUNDS);

      // ---- the player ---------------------------------------------------------------------
      const controller = new CharacterController(physics, { stepHeight: 0.4, snapToGround: 0.3, characterMass: 80 });
      bag.add(controller);
      const capsuleGeo = new THREE.CapsuleGeometry(CAPSULE.radius, CAPSULE.halfHeight * 2, 8, 16);
      const playerMat = new THREE.MeshStandardMaterial({ color: 0x3f7cb8, roughness: 0.45 });
      const botMat = new THREE.MeshStandardMaterial({ color: 0xb8433f, roughness: 0.5 });
      bag.add(() => {
        capsuleGeo.dispose();
        playerMat.dispose();
        botMat.dispose();
      });
      const start = level.spawn('player') ?? { x: 0, y: 0, z: -30 };
      const playerMesh = new THREE.Mesh(capsuleGeo, playerMat);
      playerMesh.castShadow = true;
      scene.add(playerMesh);
      const player = entities.create([Transform, { x: start.x, y: start.y + 0.9, z: start.z }]);
      physics.addBody(player, { type: 'kinematicPosition', shape: CAPSULE, layer: 'player' });
      renderSync.attach(entities, player, playerMesh);
      controller.attach(player);
      spawned.push(player);
      Destruction.watchHits(physics, player, HIT_SHAPE);
      let health = 100;
      let deaths = 0;

      const cam = new ShoulderCamera({ aspect: ctx.renderer.aspect, far: 300 });
      // Sounds are heard from the camera.
      ctx.audio.setListenerCamera(cam.camera);
      bag.add(() => ctx.audio.setListenerCamera(null));
      cam.setLook(Math.PI, -0.12); // facing +z, up the yard
      const occluder = (origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): number | null =>
        physics.raycast(origin, direction, maxDistance, { excludeEid: player })?.distance ?? null;

      // ---- the bots -------------------------------------------------------------------------
      const bots: Bot[] = [];
      const held = new Set<number>();
      const makeBot = (at: THREE.Vector3, i: number): Bot => {
        const mesh = new THREE.Mesh(capsuleGeo, botMat);
        mesh.castShadow = true;
        scene.add(mesh);
        const eid = entities.create([Transform, { x: at.x, y: at.y + 0.9, z: at.z }]);
        physics.addBody(eid, { type: 'kinematicPosition', shape: CAPSULE, layer: 'bots' });
        renderSync.attach(entities, eid, mesh);
        controller.attach(eid);
        Destruction.watchHits(physics, eid, HIT_SHAPE);
        return { eid, mesh, agent: new NavAgent(nav!), health: 100, alive: true, leg: i % Math.max(1, patrol.length), chasing: false };
      };
      botStarts.forEach((at, i) => bots.push(makeBot(at, i)));

      // The game's damage rule: blasts, bullets, debris and gas all come through here.
      let hits = 0;
      function hurt(eid: Entity, amount: number): void {
        if (amount <= 0) return;
        if (eid === player) {
          hits++;
          health -= amount;
          return;
        }
        const bot = bots.find((b) => b.eid === eid && b.alive);
        if (!bot) return;
        hits++;
        bot.health -= amount;
        if (bot.health <= 0) kill(bot);
      }
      // A dead bot goes, and whatever it was holding up comes down: a kinematic capsule never gives.
      function kill(bot: Bot): void {
        bot.alive = false;
        bot.health = 0;
        bot.agent.clear();
        scene.remove(bot.mesh);
        controller.detach(bot.eid);
        if (entities.exists(bot.eid)) entities.destroy(bot.eid);
      }
      bag.add(() => {
        for (const b of bots) if (b.alive) kill(b);
      });

      // ---- weapons ---------------------------------------------------------------------------
      let weapon: Weapon = 'rocket';
      const dir = new THREE.Vector3();
      const explodeAt = (point: THREE.Vector3, normal: THREE.Vector3 | null, radius = ROCKET_RADIUS): number => {
        let taken = 0;
        for (const d of structures.values()) if (d.bounds.distanceToPoint(point) < radius * 3) taken += d.explode(point, radius, normal);
        for (const b of bots) {
          if (!b.alive) continue;
          const dist = Math.hypot(t.x[b.eid]! - point.x, t.y[b.eid]! - point.y, t.z[b.eid]! - point.z);
          if (dist < radius * 2.5) hurt(b.eid, 120 * (1 - dist / (radius * 2.5)));
        }
        return taken;
      };
      const fire = (): void => {
        cam.viewForward(dir);
        const hit = physics.raycast(cam.camera.position, dir, 250, { excludeEid: player });
        if (!hit) return;
        const point = new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z);
        const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
        if (weapon === 'gas') {
          Destruction.nearest(entities, point)?.smoke('gas', point.addScaledVector(normal, 0.6));
          return;
        }
        if (weapon === 'rifle') {
          const bot = bots.find((b) => b.alive && b.eid === hit.eid);
          if (bot) hurt(bot.eid, 34);
          else Destruction.of(entities, hit.eid)?.damage(hit.part, 1, dir);
          return;
        }
        explodeAt(point.addScaledVector(normal, -0.2), normal);
      };

      // ---- checkpoints -------------------------------------------------------------------------
      let checkpoint: Checkpoint | null = null;
      const save = (): void => {
        const out: Record<string, DestructionSave> = {};
        for (const [name, d] of structures) out[name] = d.save();
        const cp: Checkpoint = {
          structures: out,
          player: [t.x[player]!, t.y[player]!, t.z[player]!, health],
          bots: bots.map((b) => ({ x: b.alive ? t.x[b.eid]! : 0, y: b.alive ? t.y[b.eid]! : 0, z: b.alive ? t.z[b.eid]! : 0, health: b.health, alive: b.alive, leg: b.leg })),
        };
        // Plain data, as a save file would hold it.
        checkpoint = JSON.parse(JSON.stringify(cp)) as Checkpoint;
        hud.flash('checkpoint saved');
      };
      const load = (): boolean => {
        if (!checkpoint) return false;
        const cp = checkpoint;
        // Each structure built afresh from the level's boxes and put back as it was saved; the old ones go
        // after, so what the structures of a world share (the effects, the worker) is kept, not made again.
        const old = [...owned.values()];
        owned.clear();
        structures.clear();
        for (const [name, boxes] of level.destructibles) {
          const d = build(name, boxes);
          const s = cp.structures[name];
          if (s) d.restore(s);
        }
        for (const release of old) release();
        // The navmesh stays; where each building stands is rebuilt a tile a frame (its restored damage
        // comes through reshape as usual). Rebuilding the whole mesh at once took 0.3 s of the load.
        for (const d of structures.values()) nav?.invalidate(d.bounds.min, d.bounds.max);
        for (const b of bots) if (b.alive) kill(b);
        bots.length = 0;
        held.clear();
        cp.bots.forEach((s, i) => {
          const bot = makeBot(botStarts[i] ?? new THREE.Vector3(), i);
          bots.push(bot);
          if (!s.alive) {
            kill(bot);
            return;
          }
          t.x[bot.eid] = s.x;
          t.y[bot.eid] = s.y;
          t.z[bot.eid] = s.z;
          bot.health = s.health;
          bot.leg = s.leg;
        });
        [t.x[player], t.y[player], t.z[player], health] = cp.player;
        hud.flash('checkpoint loaded');
        return true;
      };

      // ---- HUD and probes -----------------------------------------------------------------------
      const hud = new Hud(ctx.renderer.canvas.parentElement ?? document.body);
      bag.add(hud);
      const stats = (): SliceStats => {
        const b = budgetsOf(physics);
        const pool = StrainWorkerPool.of(physics);
        return {
          structures: [...structures].map(([name, d]) => {
            const s = d.stats();
            return { name, chunks: s.chunks, standing: s.standing, bodies: s.bodies, strainMode: s.strainMode, cascading: s.cascading };
          }),
          worker: { structures: pool.size, running: pool.running },
          budgets: { bodies: b.bodies.total, bodyLimit: b.bodies.limit, links: b.links.total, linkLimit: b.links.limit },
          nav: { pendingTiles: nav?.pendingTiles ?? 0, rebuilt: nav?.rebuilt ?? 0 },
          player: { x: t.x[player]!, y: t.y[player]!, z: t.z[player]!, health, deaths, yaw: cam.getYaw(), locked: input.isPointerLocked },
          bots: bots.map((bot) => ({
            x: bot.alive ? t.x[bot.eid]! : 0,
            y: bot.alive ? t.y[bot.eid]! : 0,
            z: bot.alive ? t.z[bot.eid]! : 0,
            health: bot.health,
            alive: bot.alive,
            chasing: bot.chasing,
            pathComplete: bot.agent.lastPathComplete,
          })),
          hits,
          checkpoint: checkpoint !== null,
          weapon,
        };
      };
      const corners: Array<{ x: number; y: number; z: number }> = [];
      const api: SliceApi = {
        stats,
        explode: (x, y, z, radius) => explodeAt(new THREE.Vector3(x, y, z), null, radius ?? ROCKET_RADIUS),
        removeBox: (name, min, max) => {
          const d = structures.get(name);
          if (!d) return 0;
          return d.remove(d.pieces.filter((p) => p.centroid.every((c, i) => c >= min[i]! && c <= max[i]!)).map((p) => p.id));
        },
        gas: (x, y, z) => Destruction.nearest(entities, { x, y, z })?.smoke('gas', { x, y, z }),
        setPlayer: (x, y, z, yaw) => {
          t.x[player] = x;
          t.y[player] = y;
          t.z[player] = z;
          if (yaw !== undefined) cam.setLook(yaw, cam.getPitch());
        },
        placeBot: (i, x, y, z, hold = true) => {
          const bot = bots[i];
          if (!bot?.alive) return;
          t.x[bot.eid] = x;
          t.y[bot.eid] = y;
          t.z[bot.eid] = z;
          bot.agent.clear();
          if (hold) held.add(i);
          else held.delete(i);
        },
        pathLength: (ax, ay, az, bx, by, bz) => {
          if (!nav || !nav.findPath({ x: ax, y: ay, z: az }, { x: bx, y: by, z: bz }, corners)) return -1;
          let len = 0;
          let px = ax;
          let pz = az;
          for (const c of corners) {
            len += Math.hypot(c.x - px, c.z - pz);
            px = c.x;
            pz = c.z;
          }
          return len;
        },
        flushNav: () => {
          let n = 0;
          while (nav && nav.pendingTiles > 0) n += nav.update(4);
          return n;
        },
        save,
        load,
        fire: (w) => {
          weapon = w;
          fire();
        },
        aim: (yaw, pitch) => cam.setLook(yaw, pitch),
        drop: (name, aboveY) => {
          const d = structures.get(name);
          let sum = 0;
          let inPlace = 0;
          let count = 0;
          if (!d) return { drop: 0, inPlace: 0, count: 0 };
          const m = new THREE.Matrix4();
          const p = new THREE.Vector3();
          for (const piece of d.pieces) {
            if (piece.min[1] < aboveY || d.debris.state[piece.id] === GONE) continue;
            const fell = piece.centroid[1] - p.set(...piece.centroid).applyMatrix4(d.debris.restToWorld(piece.id, m)).y;
            sum += fell;
            if (fell < 0.5) inPlace++;
            count++;
          }
          return { drop: count > 0 ? sum / count : 0, inPlace, count };
        },
        listen: (on) => {
          listening = on;
          for (const d of structures.values()) d.listen(on);
        },
        heard: () => {
          const out: Record<string, number> = {};
          for (const d of structures.values()) for (const h of d.takeHeard()) out[h.name] = (out[h.name] ?? 0) + 1;
          return out;
        },
      };
      onApi(api);
      let barrage = demo === 'collapse' ? 0 : COLLAPSE.length;

      logger.info(`slice: ${structures.size} structures (${[...structures.keys()].join(', ')}), ${bots.length} bots, ${patrol.length} patrol points`);
      const move = { x: 0, y: 0, z: 0 };
      const still = { x: 0, y: 0, z: 0 };
      const step = { x: 0, y: 0, z: 0 };
      const fwd = new THREE.Vector3();
      const right = new THREE.Vector3();
      const head = new THREE.Vector3();
      const toPlayer = new THREE.Vector3();
      let clock = 0;
      let hudTimer = 0;
      let slowFrames = 0;

      return {
        scene,
        camera: cam.camera,

        update(dt): void {
          // Input once per rendered frame: presses last one frame.
          if (input.wasButtonPressed(0)) {
            if (input.isPointerLocked || input.pointerLockUnavailable) fire();
            else input.requestPointerLock();
          }
          if (input.isPointerLocked || input.isButtonDown(2)) cam.look(input.pointerDelta.x, input.pointerDelta.y);
          if (input.wasPressed('Digit1')) weapon = 'rocket';
          if (input.wasPressed('Digit2')) weapon = 'rifle';
          if (input.wasPressed('Digit3')) weapon = 'gas';
          if (input.wasPressed('F5')) save();
          if (input.wasPressed('F9')) load();
          if (input.wasPressed('Space')) controller.jump(player, 7);
          // A tile of navmesh a frame where the buildings changed, or every other frame while frames run long
          // (a tile is a few milliseconds of Recast; on a fixed clock every frame is short, so it stays deterministic).
          if (dt < 1 / 40 || ++slowFrames % 2 === 0) nav?.update(tuning.navTiles ?? 1);
        },

        fixedUpdate(dt): void {
          clock += dt;
          while (barrage < COLLAPSE.length && clock >= COLLAPSE[barrage]![0]) COLLAPSE[barrage++]![1](api);
          cam.groundForward(fwd);
          cam.groundRight(right);
          const strafe = input.axis('KeyA', 'KeyD');
          const advance = input.axis('KeyS', 'KeyW');
          move.x = (fwd.x * advance + right.x * strafe) * PLAYER_SPEED * dt;
          move.z = (fwd.z * advance + right.z * strafe) * PLAYER_SPEED * dt;
          controller.move(player, move, dt);

          // Gas, where each of them breathes.
          head.set(t.x[player]!, t.y[player]! + 0.6, t.z[player]!);
          hurt(player, Destruction.densityAt(entities, 'gas', head) * GAS_DAMAGE * dt);
          for (const bot of bots) {
            if (!bot.alive) continue;
            head.set(t.x[bot.eid]!, t.y[bot.eid]! + 0.6, t.z[bot.eid]!);
            hurt(bot.eid, Destruction.densityAt(entities, 'gas', head) * GAS_DAMAGE * dt);
          }
          if (health <= 0) {
            deaths++;
            if (!load()) {
              health = 100;
              [t.x[player], t.y[player], t.z[player]] = [start.x, start.y + 0.9, start.z];
            }
          }

          // Bots chase the player when they see them, and otherwise walk their patrol.
          bots.forEach((bot, i) => {
            if (!bot.alive) return;
            const at = { x: t.x[bot.eid]!, y: t.y[bot.eid]!, z: t.z[bot.eid]! };
            if (held.has(i)) {
              controller.move(bot.eid, still, dt);
              return;
            }
            toPlayer.set(t.x[player]! - at.x, t.y[player]! - at.y, t.z[player]! - at.z);
            const dist = toPlayer.length();
            let sees = false;
            if (dist < 26) {
              head.set(at.x, at.y + 0.6, at.z);
              sees = physics.raycast(head, toPlayer.normalize(), dist, { excludeEid: bot.eid })?.eid === player;
            }
            bot.chasing = sees;
            if (sees && dist > 6) bot.agent.setDestination({ x: t.x[player]!, y: t.y[player]!, z: t.z[player]! });
            else if (sees) bot.agent.clear();
            else if (!bot.agent.hasDestination || bot.agent.arrived(at)) {
              const goal = patrol[bot.leg % patrol.length];
              if (goal) bot.agent.setDestination(goal);
              bot.leg++;
            }
            const going = bot.agent.steer(at, clock, step);
            controller.move(bot.eid, going ? { x: step.x * BOT_SPEED * dt, y: 0, z: step.z * BOT_SPEED * dt } : still, dt);
          });
        },

        lateUpdate(dt): void {
          cam.target.set(t.x[player]!, t.y[player]! - 0.85, t.z[player]!);
          cam.update(dt, occluder);
          // The blast shake falls off from the camera; the structures share it, so it is added once.
          for (const d of structures.values()) d.listener.copy(cam.camera.position);
          const first = structures.values().next().value;
          if (first) cam.camera.position.add(first.shakeOffset);
          hudTimer += dt;
          if (hudTimer > 0.2) {
            hudTimer = 0;
            hud.render(stats());
          }
        },

        resize(width, height): void {
          cam.setAspect(width / height);
        },

        dispose(): void {
          bag.dispose();
          for (const eid of spawned) if (entities.exists(eid)) entities.destroy(eid);
          scene.clear();
        },
      };
    },
  };
}
