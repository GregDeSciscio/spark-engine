import * as THREE from 'three/webgpu';
import { float, fract, min, mx_fractal_noise_float, positionWorld, smoothstep, vec3 } from 'three/tsl';
import {
  Destruction,
  DisposeBag,
  RenderSync,
  STANDING,
  Transform,
  findConnections,
  type DestructionCensus,
  type DestructionStats,
  type Entity,
  type Heard,
  type SceneDefinition,
  type SceneInstance,
  type SmokeKind,
} from '@spark/engine';
import { buildArena } from './arena';
import { Hud } from './hud';
import { SOUNDS } from './sounds';

/**
 * The sandbox: two fractured buildings, a footbridge between them and a
 * container slung under it, as one `Destruction` structure. Strain runs in a
 * worker; what it breaks turns into hinges (Season 12's gradual layer)
 * before it turns into debris, and debris settles into rubble. Fly with WASD,
 * Space/C for up/down, Shift to hurry; right-drag to look, or F for mouse
 * look with a crosshair.
 *   LMB fire (at the cursor, or the crosshair in mouse look) · 1 rocket · 2 rifle
 *   3 breach charge · 4 smoke · 5 gas · H stress heat view · R rebuild
 *   ` the engine's stats panel, and the solver and debris counters with it
 */

export type Weapon = 'rocket' | 'rifle' | 'charge' | 'smoke' | 'gas';

const WEAPONS: Record<Weapon, { radius: number; label: string }> = {
  rocket: { radius: 1.6, label: 'Rocket (1)' },
  rifle: { radius: 0, label: 'Rifle (2)' },
  charge: { radius: 2.6, label: 'Breach charge (3)' },
  smoke: { radius: 0, label: 'Smoke grenade (4)' },
  gas: { radius: 0, label: 'Gas grenade (5)' },
};

export interface SandboxOptions {
  strain: 'worker' | 'inline';
  /** Add the eight-storey tower (`?tower=1`). */
  tower?: boolean | undefined;
  /** Is the engine's stats panel showing? The HUD shows its counters with it. Default: always. */
  statsShown?: (() => boolean) | undefined;
}

export interface SandboxStats extends DestructionStats {
  view: { x: number; y: number; z: number; yaw: number; pitch: number; locked: boolean };
  weapon: Weapon;
}

export type Scenario = 'A-ground' | 'bridge-A-end' | 'B-corner' | 'A-top-walls' | 'T-ground';

/** The probe surface on `window.__spark.game`. */
export interface SandboxApi {
  stats(): SandboxStats;
  setView(px: number, py: number, pz: number, tx: number, ty: number, tz: number): void;
  /** Detonate at a world point; (nx, ny, nz) is the surface normal it hit, when it hit one. */
  explode(x: number, y: number, z: number, radius: number, nx?: number, ny?: number, nz?: number): number;
  /** Take out a named set of chunks (supports, a bridge end, …). */
  scenario(name: Scenario): number;
  /** Pop a smoke or gas grenade at a world point. */
  grenade(kind: SmokeKind, x: number, y: number, z: number): void;
  setHeat(on: boolean): void;
  /** Fire the current weapon along the camera's view. */
  fire(): void;
  /** Fire through a point on screen, in normalized device coordinates (−1..1). */
  fireAt(x: number, y: number): void;
  setWeapon(w: Weapon): void;
  /** What the loose debris is doing (asleep, hanging, free; moving or still). */
  census(): DestructionCensus & { container: { y: number; speed: number; ropes: number } };
  /** Start (or stop) logging every sound played, stamped in seconds from now: for a film's soundtrack. */
  listen(on: boolean): void;
  /** The sounds played since the last call, oldest first. */
  heard(): Heard[];
}

export function sandboxScene(options: SandboxOptions, onApi: (api: SandboxApi) => void): SceneDefinition {
  return {
    name: 'destruction-sandbox',
    create(ctx): SceneInstance {
      const { physics, input, quality, entities } = ctx;
      const bag = new DisposeBag();
      const spawned: Entity[] = [];

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xa9c3d6);
      scene.fog = new THREE.Fog(0xa9c3d6, 70, 220);
      const camera = new THREE.PerspectiveCamera(70, ctx.renderer.aspect, 0.05, 400);
      ctx.audio.setListenerCamera(camera);
      bag.add(() => ctx.audio.setListenerCamera(null));

      // ---- light -------------------------------------------------------------------------
      const sun = new THREE.DirectionalLight(0xfff0d8, 3.2);
      sun.position.set(-18, 30, -22);
      sun.castShadow = quality.shadows;
      sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
      sun.shadow.camera.left = sun.shadow.camera.bottom = -30;
      sun.shadow.camera.right = sun.shadow.camera.top = 30;
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 100;
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.02;
      scene.add(sun, sun.target, new THREE.HemisphereLight(0xcfe3ff, 0x6d6255, 1.1));

      // ---- ground (an ordinary engine body) -------------------------------------------------
      const renderSync = new RenderSync(entities);
      bag.add(entities.addSystem(renderSync));
      const groundGeo = new THREE.BoxGeometry(200, 1, 200);
      // Worn paving: grain, and a 4 m slab grid so the eye can read distance and scale.
      const groundMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
      const gxz = positionWorld.xz;
      const joint = min(fract(gxz.x.div(4)), fract(gxz.y.div(4)));
      const seam = smoothstep(float(0), float(0.012), joint).mul(0.25).add(0.75);
      const gnoise = mx_fractal_noise_float(vec3(gxz.x, 0, gxz.y).mul(0.9), 4, 2, 0.5);
      groundMat.colorNode = vec3(0.21, 0.22, 0.2).mul(gnoise.mul(0.1).add(1)).mul(seam); // linear: about #7f827c
      const groundMesh = new THREE.Mesh(groundGeo, groundMat);
      groundMesh.receiveShadow = true;
      scene.add(groundMesh);
      bag.add(() => {
        groundGeo.dispose();
        groundMat.dispose();
      });
      const ground = entities.create([Transform, { x: 0, y: -0.5, z: 0 }]);
      physics.addBody(ground, { type: 'fixed', shape: { kind: 'box', hx: 100, hy: 0.5, hz: 100 }, layer: 'world', friction: 0.9, events: false });
      renderSync.attach(entities, ground, groundMesh);
      spawned.push(ground);

      // ---- the arena: one destructible structure -------------------------------------------
      const arena = buildArena({ tower: options.tower === true });
      const { pieces } = arena;
      const destruction = new Destruction(ctx, { pieces, connections: findConnections(pieces) }, { worker: options.strain === 'worker', sounds: SOUNDS });
      scene.add(destruction.object);
      for (const system of destruction.systems()) bag.add(entities.addSystem(system));
      bag.add(destruction);
      const groupOf = (p: number): string => arena.groups.find((g) => p >= g.first && p < g.first + g.count)?.name ?? '?';

      // ---- the slung container: an ordinary entity body, hung from the bridge deck ----------
      const { center: cc, half } = arena.container;
      const containerGeo = new THREE.BoxGeometry(half[0] * 2, half[1] * 2, half[2] * 2);
      const containerMat = new THREE.MeshStandardMaterial({ color: 0x2f7d8c, roughness: 0.6, metalness: 0.2 });
      const containerMesh = new THREE.Mesh(containerGeo, containerMat);
      containerMesh.castShadow = containerMesh.receiveShadow = true;
      scene.add(containerMesh);
      bag.add(() => {
        containerGeo.dispose();
        containerMat.dispose();
      });
      const container = entities.create([Transform, { x: cc[0], y: cc[1], z: cc[2] }]);
      // Steel at 280 kg/m³ of its box: about ten tonnes.
      const containerMass = 280 * 8 * half[0] * half[1] * half[2];
      physics.addBody(container, { type: 'dynamic', shape: { kind: 'box', hx: half[0], hy: half[1], hz: half[2] }, mass: containerMass, friction: 0.7, angularDamping: 0.4, linearDamping: 0.05, events: false });
      renderSync.attach(entities, container, containerMesh);
      spawned.push(container);
      const containerBody = physics.bodyOf(container)!;
      // Two ropes from the deck's underside to the top of the container: they follow their deck chunk, and are cut with it.
      for (const r of arena.ropes) {
        const [ax, ay, az] = r.anchor;
        destruction.hang(containerBody, r.piece, { x: ax, y: ay, z: az }, { x: ax - cc[0], y: half[1], z: 0 }, ay - (cc[1] + half[1]));
      }

      // ---- weapons ---------------------------------------------------------------------------
      let weapon: Weapon = 'rocket';
      const dir = new THREE.Vector3();
      const tmp = new THREE.Vector3();

      const raycaster = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      /** Fire along the view, or through a point on screen (NDC) when aiming with the cursor. */
      const fire = (at?: THREE.Vector2): void => {
        if (at) {
          raycaster.setFromCamera(at, camera);
          dir.copy(raycaster.ray.direction);
        } else camera.getWorldDirection(dir);
        // The engine's own raycast: a hit on the arena names its entity and the chunk.
        const hit = physics.raycast(camera.position, dir, 250);
        if (!hit) return;
        const point = new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z);
        const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
        if (weapon === 'smoke' || weapon === 'gas') {
          destruction.smoke(weapon, point.addScaledVector(normal, 0.6));
          return;
        }
        if (weapon === 'rifle') {
          Destruction.of(entities, hit.eid)?.damage(hit.part, 1, dir);
          return;
        }
        destruction.explode(point.addScaledVector(normal, -0.2), WEAPONS[weapon].radius, normal);
      };

      const scenario = (name: Scenario): number => {
        const bridge = arena.groups.find((g) => g.name === 'bridge')!;
        const pick = pieces.filter((p) => {
          if (destruction.debris.state[p.id] !== STANDING) return false;
          const g = groupOf(p.id);
          const [x, y, z] = p.centroid;
          switch (name) {
            case 'A-ground':
              // The whole ground storey but one corner: what is above has three metres to fall.
              return g === 'A' && p.max[1] < 3.0 && p.kind !== 'slab' && !(x < -15 && z < -3);
            case 'bridge-A-end':
              return g === 'bridge' && p.min[0] < arena.groups[0]!.params!.x + arena.groups[0]!.params!.width + 1.3 && p.id >= bridge.first;
            case 'B-corner':
              return g === 'B' && y < 3 && x > 16 && z < -1;
            case 'T-ground':
              // The tower's ground storey but its front-left corner: eight storeys above it.
              return g === 'T' && p.max[1] < 3.0 && p.kind !== 'slab' && !(x < -2.5 && z < 13.5);
            case 'A-top-walls':
              // The top storey's walls and columns under the right half: only the roof is left to hang.
              return g === 'A' && p.min[1] > 6.3 && p.max[1] < 9.4 && p.kind !== 'slab' && x > -11;
          }
          return false;
        });
        return destruction.remove(pick.map((p) => p.id));
      };

      // ---- fly camera --------------------------------------------------------------------------
      const view = { yaw: 0, pitch: 0, pos: new THREE.Vector3() };
      const setView = (p: THREE.Vector3, target: THREE.Vector3): void => {
        view.pos.copy(p);
        tmp.copy(target).sub(p).normalize();
        view.pitch = Math.asin(tmp.y);
        view.yaw = Math.atan2(-tmp.x, -tmp.z);
      };
      setView(new THREE.Vector3(-4, 9, -30), new THREE.Vector3(-1, 4, 0));
      const euler = new THREE.Euler(0, 0, 0, 'YXZ');
      const move = new THREE.Vector3();

      // ---- HUD ---------------------------------------------------------------------------------
      const stats = (): SandboxStats => ({
        ...destruction.stats(),
        view: { x: view.pos.x, y: view.pos.y, z: view.pos.z, yaw: view.yaw, pitch: view.pitch, locked: input.isPointerLocked },
        weapon,
      });
      ctx.renderer.canvas.style.cursor = 'crosshair';
      const hud = new Hud(ctx.renderer.canvas.parentElement ?? document.body);
      bag.add(hud);
      let hudTimer = 0;

      const v = { x: 0, y: 0, z: 0 };
      onApi({
        stats,
        setView: (px, py, pz, tx, ty, tz) => setView(new THREE.Vector3(px, py, pz), new THREE.Vector3(tx, ty, tz)),
        explode: (x, y, z, r, nx, ny, nz) => destruction.explode({ x, y, z }, r, nx === undefined ? null : { x: nx, y: ny ?? 0, z: nz ?? 0 }),
        scenario,
        grenade: (kind, x, y, z) => destruction.smoke(kind, { x, y, z }),
        setHeat: (on) => destruction.heatView(on),
        fire: () => fire(),
        fireAt: (x, y) => fire(ndc.set(x, y)),
        setWeapon: (w) => {
          weapon = w;
        },
        census: () => {
          physics.bodies.pose(containerBody, v);
          const y = v.y;
          physics.bodies.velocity(containerBody, v);
          const container = { y: +y.toFixed(2), speed: +Math.hypot(v.x, v.y, v.z).toFixed(2), ropes: destruction.ropeCount };
          return { ...destruction.census(), container };
        },
        listen: (on) => destruction.listen(on),
        heard: () => destruction.takeHeard(),
      });

      return {
        scene,
        camera,

        /**
         * Input, once per rendered frame: presses and mouse deltas last one frame,
         * and a frame can pass without a fixed step (or hold two).
         */
        update(dt): void {
          const look = input.isPointerLocked || input.isButtonDown(2);
          if (look) {
            const d = input.pointerDelta;
            view.yaw -= d.x * 0.0022;
            view.pitch = THREE.MathUtils.clamp(view.pitch - d.y * 0.0022, -1.5, 1.5);
          }
          const speed = (input.isDown('ShiftLeft') ? 22 : 8) * dt;
          move.set(input.axis('KeyA', 'KeyD'), input.axis('KeyC', 'Space'), -input.axis('KeyS', 'KeyW'));
          euler.set(0, view.yaw, 0);
          move.applyEuler(euler).multiplyScalar(speed);
          view.pos.add(move);

          if (input.wasPressed('KeyF')) {
            if (input.isPointerLocked) input.exitPointerLock();
            else input.requestPointerLock();
          }
          if (input.wasButtonPressed(0)) {
            if (input.isPointerLocked) fire();
            else {
              // Without mouse look, fire where the cursor points.
              const { x, y } = input.pointer;
              const el = ctx.renderer.canvas;
              fire(ndc.set((x / el.clientWidth) * 2 - 1, -((y / el.clientHeight) * 2 - 1)));
            }
          }
          if (input.wasPressed('Digit1')) weapon = 'rocket';
          if (input.wasPressed('Digit2')) weapon = 'rifle';
          if (input.wasPressed('Digit3')) weapon = 'charge';
          if (input.wasPressed('Digit4')) weapon = 'smoke';
          if (input.wasPressed('Digit5')) weapon = 'gas';
          if (input.wasPressed('KeyH')) destruction.heatView(!destruction.heat);
          if (input.wasPressed('KeyR')) location.reload();
        },

        lateUpdate(dt): void {
          euler.set(view.pitch, view.yaw, 0);
          camera.quaternion.setFromEuler(euler);
          // The blast shake falls off from the listener; Destruction's late stage (after this) moves it on.
          destruction.listener.copy(view.pos);
          camera.position.copy(view.pos).add(destruction.shakeOffset);

          hudTimer += dt;
          if (hudTimer > 0.2) {
            hudTimer = 0;
            hud.render(stats(), WEAPONS[weapon].label, input.isPointerLocked, options.statsShown?.() ?? true);
          }
        },

        resize(width, height): void {
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        },

        dispose(): void {
          bag.dispose();
          for (const eid of spawned) entities.destroy(eid);
          scene.clear();
        },
      };
    },
  };
}
