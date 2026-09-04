import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  DisposeBag,
  InstancedRenderSync,
  Renderable,
  Transform,
  defineComponentType,
  type Random,
  type SceneDefinition,
  type SceneInstance,
} from '@spark/engine';

/**
 * Benchmark B, lighting (kickoff §28): a dense field of instanced props under
 * one shadowed sun and many moving, coloured point lights on seeded orbits.
 * On WebGPU the point lights take the clustered path (`LightingSystem`), so
 * the prop shaders do not grow with the light count and the lights are a
 * data texture + a compute pass; the scene sets the light budget to the
 * light count so every light spawned is lit (Benchmark B measures the
 * lights, not the preset's cap). On the WebGL2 tier the budget is capped at
 * `COMPAT_LIGHT_CAP` and the rest are switched off by importance.
 *
 * URL: `?lights=N` (1..1024, default 256).
 */

/** Per-light orbit: a circle around `(cx, cz)` with a vertical bob. Numbers only. */
const LightOrbit = defineComponentType('LightOrbit', {
  cx: 'f32',
  cz: 'f32',
  radius: 'f32',
  speed: 'f32',
  phase: 'f32',
  height: 'f32',
  bob: 'f32',
});

export const DEFAULT_LIGHT_COUNT = 256;
export const MAX_LIGHT_COUNT = 1024;
/** Half-size of the prop field in world units. */
const FIELD = 36;
const PROP_GRID = 40;
const LIGHT_INTENSITY = 22;
const LIGHT_RANGE = 7.5;

function requestedLightCount(search: string): number {
  const raw = parseInt(new URLSearchParams(search).get('lights') ?? '', 10);
  if (!Number.isFinite(raw)) return DEFAULT_LIGHT_COUNT;
  return Math.min(MAX_LIGHT_COUNT, Math.max(1, raw));
}

/** Evenly spread hues (golden angle) so neighbouring lights never share a colour. */
function lightColor(index: number, out: THREE.Color): THREE.Color {
  return out.setHSL((index * 0.618034) % 1, 0.9, 0.55);
}

export const lightsScene: SceneDefinition = {
  name: 'lights',
  create(ctx): SceneInstance {
    const bag = new DisposeBag();
    const { entities, quality, lighting, logger } = ctx;
    const random: Random = ctx.random;
    const count = requestedLightCount(typeof location === 'undefined' ? '' : location.search);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070c);
    scene.fog = new THREE.Fog(0x05070c, 60, 150);

    const camera = new THREE.PerspectiveCamera(46, ctx.renderer.aspect, 0.5, 160);
    camera.position.set(0, 33, 47);
    camera.lookAt(0, 0.5, -3);

    const pmrem = new THREE.PMREMGenerator(ctx.renderer.three);
    const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    scene.environmentIntensity = 0.12;
    bag.add(() => {
      envTarget.dispose();
      pmrem.dispose();
    });

    // ---- the one shadowed sun + a faint sky term (both pinned: never budgeted) ----
    const sun = new THREE.DirectionalLight(0xfff0d8, 1.1);
    sun.position.set(30, 42, 18);
    sun.castShadow = quality.shadows;
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    sun.shadow.camera.near = 5;
    sun.shadow.camera.far = 120;
    sun.shadow.camera.left = -FIELD - 6;
    sun.shadow.camera.right = FIELD + 6;
    sun.shadow.camera.top = FIELD + 6;
    sun.shadow.camera.bottom = -FIELD - 6;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target);
    scene.add(new THREE.HemisphereLight(0x2b3550, 0x0c0a08, 0.3));

    // ---- ground + prop field (instanced, static) ----
    const groundGeo = new THREE.PlaneGeometry(FIELD * 2 + 20, FIELD * 2 + 20);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x2c2f36, roughness: 0.5, metalness: 0.05 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    bag.add(() => {
      groundGeo.dispose();
      groundMat.dispose();
    });

    const instanced = new InstancedRenderSync(entities);
    bag.add(entities.addSystem(instanced));
    const propGeos = [new THREE.BoxGeometry(1.1, 1.1, 1.1), new THREE.CylinderGeometry(0.45, 0.5, 1.5, 14), new THREE.IcosahedronGeometry(0.7, 1)];
    const propMats = [
      new THREE.MeshStandardMaterial({ color: 0x8c8f96, roughness: 0.45, metalness: 0.1 }),
      new THREE.MeshStandardMaterial({ color: 0x6f7a8a, roughness: 0.3, metalness: 0.6 }),
      new THREE.MeshStandardMaterial({ color: 0xb0a898, roughness: 0.2, metalness: 0.85 }),
    ];
    bag.add(() => {
      for (const g of propGeos) g.dispose();
      for (const m of propMats) m.dispose();
    });
    // The kind mix is seeded, not even, so every batch can hold the whole field (1,600 matrices each; negligible).
    const propCapacity = PROP_GRID * PROP_GRID;
    const batches = propGeos.map((geo, i) => {
      const batch = instanced.createBatch(geo, propMats[i] as THREE.Material, propCapacity, { static: true });
      batch.mesh.castShadow = true;
      batch.mesh.receiveShadow = true;
      scene.add(batch.mesh);
      return batch;
    });
    const spawned: number[] = [];
    const cell = (FIELD * 2) / PROP_GRID;
    let props = 0;
    for (let gx = 0; gx < PROP_GRID; gx++) {
      for (let gz = 0; gz < PROP_GRID; gz++) {
        const x = -FIELD + (gx + 0.5) * cell + random.range(-0.35, 0.35) * cell;
        const z = -FIELD + (gz + 0.5) * cell + random.range(-0.35, 0.35) * cell;
        const kind = (gx * 7 + gz * 3 + Math.floor(random.next() * 3)) % propGeos.length;
        const s = random.range(0.6, 1.25);
        const yaw = random.range(0, Math.PI * 2);
        const eid = entities.create([Transform, { x, y: (kind === 1 ? 0.75 : 0.55) * s, z, qy: Math.sin(yaw / 2), qw: Math.cos(yaw / 2), sx: s, sy: s, sz: s }], Renderable);
        (batches[kind] as (typeof batches)[number]).add(eid);
        spawned.push(eid);
        props++;
      }
    }

    // ---- the moving lights: one entity each (Transform + Light + LightOrbit), synced by LightingSystem ----
    const markerGeo = new THREE.SphereGeometry(0.14, 10, 8);
    const markerMat = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, fog: true });
    bag.add(() => {
      markerGeo.dispose();
      markerMat.dispose();
    });
    const markers = instanced.createBatch(markerGeo, markerMat, count);
    scene.add(markers.mesh);
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
      lightColor(i, color);
      const light = new THREE.PointLight(color, LIGHT_INTENSITY, LIGHT_RANGE, 2);
      scene.add(light);
      const radius = random.range(2, 6.5);
      const eid = entities.create(
        [Transform, { x: 0, y: 2, z: 0 }],
        [
          LightOrbit,
          {
            cx: random.range(-FIELD + 3, FIELD - 3),
            cz: random.range(-FIELD + 3, FIELD - 3),
            radius,
            speed: random.range(0.25, 0.7) * (random.bool() ? 1 : -1),
            phase: random.range(0, Math.PI * 2),
            height: random.range(1.3, 3.6),
            bob: random.range(0.2, 0.8),
          },
        ],
        Renderable,
      );
      lighting.attachEntity(entities, eid, light);
      const slot = markers.add(eid);
      markers.mesh.setColorAt(slot, color.clone().multiplyScalar(2.5));
      spawned.push(eid);
    }
    if (markers.mesh.instanceColor) markers.mesh.instanceColor.needsUpdate = true;
    // Benchmark B measures the lights, so every one spawned is in budget (the tier still caps: 8 on WebGL2).
    lighting.setBudget(count);
    bag.add(() => lighting.setBudget(null));

    let simTime = 0;
    bag.add(
      entities.addSystem({
        name: 'LightOrbitSystem',
        stage: 'fixed',
        run(world, dt) {
          simTime += dt;
          const t = world.store(Transform);
          const o = world.store(LightOrbit);
          for (const eid of world.query(Transform, LightOrbit)) {
            const a = simTime * (o.speed[eid] ?? 0) + (o.phase[eid] ?? 0);
            const r = o.radius[eid] ?? 0;
            t.x[eid] = (o.cx[eid] ?? 0) + Math.cos(a) * r;
            t.z[eid] = (o.cz[eid] ?? 0) + Math.sin(a) * r;
            t.y[eid] = (o.height[eid] ?? 2) + Math.sin(a * 2.3) * (o.bob[eid] ?? 0);
          }
        },
      }),
    );

    // ---- DOM line (hidden with overlay=0 so goldens never carry it) ----
    const line = document.createElement('div');
    line.setAttribute('data-spark-lights', '');
    Object.assign(line.style, {
      position: 'absolute',
      left: '12px',
      bottom: '12px',
      padding: '6px 10px',
      font: '12px/1.4 ui-monospace, Consolas, monospace',
      color: '#d8e0ff',
      background: 'rgba(8, 10, 16, 0.75)',
      borderRadius: '4px',
      pointerEvents: 'none',
      zIndex: '10',
      whiteSpace: 'pre',
    } satisfies Partial<CSSStyleDeclaration>);
    if (!ctx.config.debugOverlay) line.style.display = 'none';
    ctx.config.container.appendChild(line);
    bag.add(() => line.remove());
    let lastPaint = -1;
    const paint = (): void => {
      const s = lighting.getStats();
      const grid = s.grid ? `grid ${s.grid.tilesX}×${s.grid.tilesY}×${s.grid.zSlices} (${s.grid.maxLightsPerCluster}/cluster)` : 'no clustering (WebGL2 tier)';
      const compute = s.computeMs === null ? '' : `  compute ${s.computeMs.toFixed(2)} ms`;
      line.textContent =
        `lights ${count} (?lights=N)  active ${s.active}  clustered ${s.clustered}  unrolled ${s.unrolled}  culled ${s.culled}  ` +
        `budget ${s.budget} (preset ${quality.preset}: ${quality.maxDynamicLights})  ${grid}${compute}  props ${props}`;
    };
    paint();
    logger.info(`lights: ${count} point lights, ${props} instanced props, budget ${lighting.budget}, clustered path=${ctx.renderer.capabilities.backend === 'webgpu'}`);

    return {
      scene,
      camera,
      update(): void {
        const now = performance.now();
        if (now - lastPaint > 250) {
          lastPaint = now;
          paint();
        }
      },
      resize(width, height): void {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      },
      dispose(): void {
        for (const eid of spawned) entities.destroy(eid);
        bag.dispose();
        scene.clear();
      },
    };
  },
};
