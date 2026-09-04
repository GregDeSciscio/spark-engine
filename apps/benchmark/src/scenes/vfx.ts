import * as THREE from 'three/webgpu';
import {
  DisposeBag,
  ParticleSystem,
  Transform,
  type EmitterHandle,
  type Entity,
  type SceneDefinition,
  type SceneInstance,
} from '@spark/engine';

/**
 * Milestone 8 demonstration: GPU particles. A dark yard with a fire pit and
 * a few lit props, an `embers` emitter over the fire, two `steam` vents, a
 * seeded schedule of `sparks` bursts from a grinder, a 100k-streak `rain`
 * volume that follows the camera target as it drifts, and a `muzzleFlash`
 * on Space. A DOM line reports live particle counts.
 *
 * On the WebGL2 backend the scene boots the same geometry and lights with
 * no emitters and a "GPU particles unavailable" note (ADR-001).
 */

const RAIN_CAPACITY = 100_000;
const CAMERA_ORBIT_RADIUS = 13;
const CAMERA_HEIGHT = 5.2;
const TARGET_DRIFT_RADIUS = 2.5;

export const vfxScene: SceneDefinition = {
  name: 'vfx',
  create(ctx): SceneInstance {
    const bag = new DisposeBag();
    const { entities, random, quality, input, logger } = ctx;
    const vfx = ParticleSystem.from(entities);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05060a);
    scene.fog = new THREE.FogExp2(0x090b12, 0.03);

    ctx.renderer.setDynamicResolutionEnabled(ctx.config.fixedFrameDelta === null && quality.dynamicResolution);
    bag.add(() => ctx.renderer.setDynamicResolutionEnabled(false));

    // ---- camera: slow orbit around a drifting target -----------------------
    const camera = new THREE.PerspectiveCamera(46, ctx.renderer.aspect, 0.2, 120);
    const target = new THREE.Vector3(0, 1, 0);
    let simTime = 0;
    const placeCamera = (): void => {
      const a = 0.55 + simTime * 0.06;
      target.set(Math.cos(simTime * 0.11) * TARGET_DRIFT_RADIUS, 1.0, Math.sin(simTime * 0.11) * TARGET_DRIFT_RADIUS);
      camera.position.set(target.x + Math.cos(a) * CAMERA_ORBIT_RADIUS, CAMERA_HEIGHT, target.z + Math.sin(a) * CAMERA_ORBIT_RADIUS);
      camera.lookAt(target.x, target.y + 0.6, target.z);
    };
    placeCamera();

    // ---- lights ---------------------------------------------------------------
    const moon = new THREE.DirectionalLight(0x5f7ac8, 1.6);
    moon.position.set(-8, 16, 6);
    moon.target.position.set(0, 0, 0);
    moon.castShadow = quality.shadows;
    moon.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    moon.shadow.camera.near = 2;
    moon.shadow.camera.far = 50;
    moon.shadow.camera.left = -18;
    moon.shadow.camera.right = 18;
    moon.shadow.camera.top = 18;
    moon.shadow.camera.bottom = -18;
    moon.shadow.bias = -0.0005;
    moon.shadow.normalBias = 0.03;
    scene.add(moon, moon.target);
    scene.add(new THREE.HemisphereLight(0x22304f, 0x0b0805, 1.4));

    const fireLight = new THREE.PointLight(0xff7a2a, 90, 14, 2);
    fireLight.position.set(0, 1.1, 0);
    fireLight.castShadow = quality.shadows;
    fireLight.shadow.mapSize.set(quality.shadowMapSize / 4, quality.shadowMapSize / 4);
    fireLight.shadow.bias = -0.002;
    scene.add(fireLight);

    const lampLight = new THREE.SpotLight(0xdfe9ff, 900, 22, 0.6, 0.5, 2);
    lampLight.position.set(6.5, 6.4, -4.5);
    lampLight.target.position.set(5, 0, -3.5);
    scene.add(lampLight, lampLight.target);

    const flashLight = new THREE.PointLight(0xffd39a, 0, 10, 2);
    flashLight.position.set(-4.2, 1.35, 3.4);
    scene.add(flashLight);

    // ---- geometry / materials -----------------------------------------------
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    const geo = <T extends THREE.BufferGeometry>(g: T): T => {
      geometries.push(g);
      return g;
    };
    const mat = <T extends THREE.Material>(m: T): T => {
      materials.push(m);
      return m;
    };
    bag.add(() => {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    });

    const ground = new THREE.Mesh(geo(new THREE.CircleGeometry(34, 64)), mat(new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.62, metalness: 0.05 })));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Fire pit: a ring of stones and a bed of coals.
    const stoneMat = mat(new THREE.MeshStandardMaterial({ color: 0x4a4740, roughness: 0.95 }));
    const stoneGeo = geo(new THREE.DodecahedronGeometry(0.32, 0));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const stone = new THREE.Mesh(stoneGeo, stoneMat);
      stone.position.set(Math.cos(a) * 1.05, 0.2, Math.sin(a) * 1.05);
      stone.rotation.set(random.range(0, 3), random.range(0, 3), random.range(0, 3));
      stone.scale.setScalar(random.range(0.75, 1.15));
      stone.castShadow = true;
      stone.receiveShadow = true;
      scene.add(stone);
    }
    const coals = new THREE.Mesh(
      geo(new THREE.CylinderGeometry(0.8, 0.9, 0.22, 24)),
      mat(new THREE.MeshStandardMaterial({ color: 0x1a0a04, emissive: new THREE.Color(0xff4a10), emissiveIntensity: 2.4, roughness: 0.9 })),
    );
    coals.position.y = 0.11;
    scene.add(coals);

    // Props: crates, barrels, a pipe run with the steam vents, a lamp post, a grinder bench.
    const crateMat = mat(new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.8 }));
    const crateGeo = geo(new THREE.BoxGeometry(1, 1, 1));
    const addCrate = (x: number, y: number, z: number, size: number, yaw: number): void => {
      const crate = new THREE.Mesh(crateGeo, crateMat);
      crate.position.set(x, y + size / 2, z);
      crate.scale.setScalar(size);
      crate.rotation.y = yaw;
      crate.castShadow = true;
      crate.receiveShadow = true;
      scene.add(crate);
    };
    addCrate(4.6, 0, -2.6, 1.1, 0.3);
    addCrate(5.6, 0, -3.4, 0.9, -0.2);
    addCrate(4.9, 1.1, -2.8, 0.75, 0.9);
    addCrate(-5.2, 0, -4.4, 1.2, 0.15);

    const barrelMat = mat(new THREE.MeshStandardMaterial({ color: 0x2f3a44, roughness: 0.45, metalness: 0.6 }));
    const barrelGeo = geo(new THREE.CylinderGeometry(0.42, 0.42, 1.15, 18));
    for (const [x, z] of [
      [-3.4, -5.4],
      [-4.4, -5.0],
      [6.4, 1.8],
    ] as const) {
      const barrel = new THREE.Mesh(barrelGeo, barrelMat);
      barrel.position.set(x, 0.575, z);
      barrel.castShadow = true;
      barrel.receiveShadow = true;
      scene.add(barrel);
    }

    const pipeMat = mat(new THREE.MeshStandardMaterial({ color: 0x6a6f78, roughness: 0.35, metalness: 0.85 }));
    const pipe = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.16, 0.16, 12, 12)), pipeMat);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(0, 0.4, -6.5);
    pipe.castShadow = true;
    pipe.receiveShadow = true;
    scene.add(pipe);
    const ventGeo = geo(new THREE.CylinderGeometry(0.14, 0.18, 0.5, 12));
    const ventPositions = [new THREE.Vector3(-2.6, 0.75, -6.5), new THREE.Vector3(3.1, 0.75, -6.5)];
    for (const p of ventPositions) {
      const vent = new THREE.Mesh(ventGeo, pipeMat);
      vent.position.copy(p).setY(0.6);
      vent.castShadow = true;
      scene.add(vent);
    }

    const post = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.08, 0.1, 6.4, 10)), pipeMat);
    post.position.set(6.5, 3.2, -4.5);
    post.castShadow = true;
    scene.add(post);
    const lampHead = new THREE.Mesh(geo(new THREE.BoxGeometry(0.5, 0.25, 0.5)), mat(new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(2.2, 2.5, 3.0), fog: true, transparent: true })));
    lampHead.position.set(6.5, 6.35, -4.5);
    scene.add(lampHead);

    const benchMat = mat(new THREE.MeshStandardMaterial({ color: 0x3b3f46, roughness: 0.5, metalness: 0.4 }));
    const bench = new THREE.Mesh(geo(new THREE.BoxGeometry(1.8, 0.12, 0.8)), benchMat);
    bench.position.set(-4.6, 0.9, 3.6);
    bench.castShadow = true;
    bench.receiveShadow = true;
    scene.add(bench);
    for (const dx of [-0.75, 0.75]) {
      const leg = new THREE.Mesh(geo(new THREE.BoxGeometry(0.1, 0.9, 0.7)), benchMat);
      leg.position.set(-4.6 + dx, 0.45, 3.6);
      leg.castShadow = true;
      scene.add(leg);
    }
    const grinder = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.22, 0.22, 0.08, 20)), pipeMat);
    grinder.rotation.z = Math.PI / 2;
    grinder.position.set(-4.3, 1.2, 3.6);
    grinder.castShadow = true;
    scene.add(grinder);

    // ---- emitters ------------------------------------------------------------------
    const spawned: Entity[] = [];
    const handles: EmitterHandle[] = [];
    const emitter = (
      x: number,
      y: number,
      z: number,
      preset: Parameters<ParticleSystem['spawnEmitter']>[1],
      overrides?: Parameters<ParticleSystem['spawnEmitter']>[2],
      quaternion?: THREE.Quaternion,
    ): Entity => {
      const q = quaternion ?? new THREE.Quaternion();
      const eid = entities.create([Transform, { x, y, z, qx: q.x, qy: q.y, qz: q.z, qw: q.w }]);
      spawned.push(eid);
      const handle = vfx.spawnEmitter(eid, preset, overrides);
      if (handle) {
        handles.push(handle);
        scene.add(handle.object);
      }
      return eid;
    };

    const rainCapacity = Math.max(1000, Math.round(RAIN_CAPACITY * quality.particleDensity));
    const rainEid = emitter(target.x, 11, target.z, 'rain', {
      capacity: rainCapacity,
      wrap: { size: [44, 26, 44] },
      shape: { kind: 'box', size: [44, 26, 44] },
      direction: [0.08, -1, 0.03],
    });
    emitter(0, 0.35, 0, 'embers');
    for (const p of ventPositions) {
      emitter(p.x, p.y, p.z, 'steam', { capacity: 256 });
    }
    // Sparks fly off the grinder wheel, aimed up and away from the bench.
    const sparksEid = emitter(-4.3, 1.42, 3.6, 'sparks', { capacity: 2048 }, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.9));
    // Muzzle flash: local-space emitter aimed along +X from a "muzzle" in front of the bench.
    const flashEid = emitter(-4.2, 1.35, 3.4, 'muzzleFlash', {}, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2));

    // Seeded burst schedule: bursts of sparks at pseudo-random intervals.
    let nextBurst = 1.2;
    const scheduleNext = (): void => {
      nextBurst = simTime + random.range(0.7, 1.9);
    };
    let flashUntil = -1;

    if (!vfx.available) logger.info('vfx scene: GPU particles unavailable on this backend, rendering props only');

    // ---- DOM overlay --------------------------------------------------------------
    const container = ctx.config.container;
    const note = document.createElement('div');
    note.setAttribute('data-spark-vfx', '');
    Object.assign(note.style, {
      position: 'absolute',
      left: '8px',
      bottom: '8px',
      padding: '6px 10px',
      background: 'rgba(0,0,0,0.6)',
      color: vfx.available ? '#d8e4ff' : '#ffd8a8',
      font: '12px/1.45 ui-monospace, Menlo, Consolas, monospace',
      borderRadius: '4px',
      pointerEvents: 'none',
      zIndex: '1000',
      whiteSpace: 'pre',
    } satisfies Partial<CSSStyleDeclaration>);
    note.textContent = vfx.available ? 'GPU particles: warming up' : 'GPU particles unavailable on this backend (WebGL2 tier, ADR-001)';
    // Human-facing only: hidden with `overlay=0` so goldens and thumbnails carry no DOM text.
    if (!ctx.config.debugOverlay) note.style.display = 'none';
    container.appendChild(note);
    bag.add(() => note.remove());
    let lastPaint = -1;
    const paint = (): void => {
      if (!vfx.available) return;
      const s = vfx.stats();
      const compute = s.computeMs === null ? 'n/a' : `${s.computeMs.toFixed(2)} ms`;
      note.textContent =
        `GPU particles  ${s.live.toLocaleString()} live / ${s.capacity.toLocaleString()} capacity  ` +
        `${s.enabled}/${s.emitters} emitters  compute ${compute}  [Space] muzzle flash`;
    };

    const t = entities.store(Transform);
    return {
      scene,
      camera,
      fixedUpdate(fixedDt): void {
        simTime += fixedDt;
        placeCamera();
        // The rain volume follows the camera target (scene hooks run before systems, so the emitter reads this pose).
        t.x[rainEid] = target.x;
        t.z[rainEid] = target.z;
        if (simTime >= nextBurst) {
          vfx.burst(sparksEid, Math.round(random.range(140, 320)));
          scheduleNext();
        }
        // Coals flicker deterministically with simulation time.
        fireLight.intensity = 80 + Math.sin(simTime * 17.3) * 6 + Math.sin(simTime * 5.1) * 8;
        flashLight.intensity = simTime < flashUntil ? 260 : 0;
      },
      update(dt): void {
        if (input.wasPressed('Space')) {
          vfx.burst(flashEid, 24);
          vfx.burst(sparksEid, 60);
          flashUntil = simTime + 0.07;
        }
        lastPaint += dt;
        if (lastPaint < 0 || lastPaint > 0.25) {
          lastPaint = 0;
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
