import * as THREE from 'three/webgpu';
import {
  color,
  float,
  length,
  materialOpacity,
  mix,
  mx_fractal_noise_float,
  positionWorld,
  sin,
  smoothstep,
  time,
  transformNormalToView,
  uv,
  vec3,
} from 'three/tsl';
import {
  CameraRig,
  DisposeBag,
  applySceneEnvironment,
  type CameraRigPreset,
  type Random,
  type SceneDefinition,
  type SceneInstance,
} from '@spark/engine';

/**
 * Rainy Cyberpunk Alley, first pass (kickoff §48). Everything is procedural:
 * two facades with lit windows, wet asphalt with a noise puddle mask, neon
 * signs with matching lights, steam sprites, an instanced rain field stepped
 * on the fixed clock, dense primitive props, a placeholder hero, and the
 * isometric camera rig. Post (bloom / AO / TRAA) comes from the preset.
 *
 * Layout: the alley runs along Z. Inner faces of the facades are at x = ±5.5.
 * The hero stands near z = 2; the alley recedes toward -Z into the fog.
 */

const ALLEY_HALF_WIDTH = 5.5;
const WALL_THICKNESS = 1;
const WALL_HEIGHT = 18;
const WALL_Z_MIN = -60;
const WALL_Z_MAX = 30;
const RAIN_TOP = 20;

const ALLEY_CAMERA: CameraRigPreset = {
  yaw: 0.22,
  pitch: 0.46,
  distance: 26,
  fov: 38,
  followRate: 4,
  lookAheadSeconds: 0.3,
  lookAheadRate: 3,
  shakeTranslation: 0.3,
  shakeRoll: 0.02,
  traumaDecay: 1.4,
};

interface NeonSpec {
  color: number;
  side: -1 | 1;
  y: number;
  z: number;
  width: number;
  height: number;
  glyph: 'ring' | 'bars' | 'chevron';
  flicker: boolean;
}

const NEON_SIGNS: readonly NeonSpec[] = [
  { color: 0xff2bd6, side: -1, y: 5.2, z: -2, width: 2.6, height: 1.2, glyph: 'bars', flicker: false },
  { color: 0x22e8ff, side: 1, y: 6.4, z: -6, width: 2.2, height: 2.2, glyph: 'ring', flicker: false },
  { color: 0xff7a1a, side: -1, y: 3.6, z: -12, width: 3.0, height: 1.0, glyph: 'bars', flicker: true },
  { color: 0x4dff6a, side: 1, y: 4.4, z: -17, width: 1.6, height: 1.6, glyph: 'chevron', flicker: false },
  { color: 0xff3d5a, side: -1, y: 7.0, z: -22, width: 2.4, height: 1.4, glyph: 'ring', flicker: false },
  { color: 0x3d7bff, side: 1, y: 3.0, z: -27, width: 2.8, height: 1.2, glyph: 'bars', flicker: false },
  { color: 0xffd23d, side: -1, y: 5.6, z: -33, width: 2.0, height: 2.0, glyph: 'chevron', flicker: true },
  { color: 0xb14dff, side: 1, y: 8.2, z: 2, width: 2.2, height: 1.1, glyph: 'bars', flicker: false },
];

export const alleyScene: SceneDefinition = {
  name: 'alley',
  create(ctx): SceneInstance {
    const bag = new DisposeBag();
    const { random, quality } = ctx;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05060a);
    scene.fog = new THREE.FogExp2(0x0a0e1a, 0.021);

    // Dynamic resolution only makes sense on a wall clock; never on the capture clock.
    ctx.renderer.setDynamicResolutionEnabled(ctx.config.fixedFrameDelta === null && quality.dynamicResolution);
    bag.add(() => ctx.renderer.setDynamicResolutionEnabled(false));

    // ---- camera -----------------------------------------------------------
    const rig = new CameraRig({ preset: ALLEY_CAMERA, aspect: ctx.renderer.aspect, near: 0.5, far: 140, random: random.fork() });
    const heroPosition = new THREE.Vector3(-0.8, 0, 2);
    // Frame the hero in the lower third with the alley receding above it.
    const frameTarget = (out: THREE.Vector3): THREE.Vector3 => out.set(hero.position.x - 0.9, 1.2, hero.position.z - 6);
    const hero = new THREE.Group();
    hero.position.copy(heroPosition);
    frameTarget(rig.target);
    rig.snap();

    // ---- image-based lighting: a dark room with neon panels ---------------
    const envScene = buildEnvironmentScene();
    bag.add(applySceneEnvironment(ctx.renderer, scene, envScene, 1.0));
    bag.add(() => disposeHierarchy(envScene));

    // ---- lights -------------------------------------------------------------
    const moon = new THREE.DirectionalLight(0x6f88d0, 3.0);
    moon.position.set(-9, 22, -4);
    moon.target.position.set(0, 0, -8);
    moon.castShadow = quality.shadows;
    moon.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    moon.shadow.camera.near = 2;
    moon.shadow.camera.far = 70;
    moon.shadow.camera.left = -14;
    moon.shadow.camera.right = 14;
    moon.shadow.camera.top = 26;
    moon.shadow.camera.bottom = -26;
    moon.shadow.bias = -0.0006;
    moon.shadow.normalBias = 0.03;
    scene.add(moon, moon.target);

    scene.add(new THREE.HemisphereLight(0x2a3a66, 0x0e0b08, 2.0));

    const heroLight = new THREE.SpotLight(0xfff0dc, 3200, 18, 0.48, 0.65, 2);
    heroLight.position.set(0.5, 9.5, 3.5);
    heroLight.target.position.copy(heroPosition);
    heroLight.castShadow = quality.shadows;
    heroLight.shadow.mapSize.set(quality.shadowMapSize / 2, quality.shadowMapSize / 2);
    heroLight.shadow.camera.near = 1;
    heroLight.shadow.camera.far = 20;
    heroLight.shadow.bias = -0.0004;
    heroLight.shadow.normalBias = 0.02;
    scene.add(heroLight, heroLight.target);

    // ---- shared geometry / materials ---------------------------------------
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

    // ---- ground: wet asphalt with puddles ---------------------------------
    {
      const groundGeo = geo(new THREE.PlaneGeometry(40, 100, 1, 1));
      const groundMat = mat(new THREE.MeshStandardNodeMaterial());
      const worldXZ = positionWorld.xz;
      const puddle = smoothstep(0.5, 0.64, mx_fractal_noise_float(vec3(worldXZ.mul(0.22), 3.7), 3, 2.1, 0.55, 0.5).add(0.5));
      const grime = mx_fractal_noise_float(vec3(worldXZ.mul(0.9), 11.0), 2, 2.0, 0.5, 0.5).add(0.5);
      const asphalt = mix(color(0x1e2126), color(0x2b2e34), grime);
      groundMat.colorNode = mix(asphalt, asphalt.mul(0.35), puddle);
      groundMat.roughnessNode = mix(mix(float(0.55), float(0.38), grime), float(0.035), puddle);
      groundMat.metalnessNode = float(0.0);
      // Rain ripples: a subtle animated normal perturbation confined to puddles.
      const ripple = sin(worldXZ.x.mul(31.0).add(time.mul(7.0))).mul(sin(worldXZ.y.mul(27.0).sub(time.mul(5.3))));
      const rippleN = vec3(ripple.mul(0.025), 1.0, ripple.mul(0.02)).normalize();
      groundMat.normalNode = transformNormalToView(mix(vec3(0, 1, 0), rippleN, puddle));
      const ground = new THREE.Mesh(groundGeo, groundMat);
      ground.rotation.x = -Math.PI / 2;
      ground.position.set(0, 0, -15);
      ground.receiveShadow = true;
      scene.add(ground);
    }

    // ---- facades ------------------------------------------------------------
    const wallMat = mat(new THREE.MeshStandardNodeMaterial());
    {
      const grime = mx_fractal_noise_float(positionWorld.mul(0.35), 3, 2.0, 0.5, 0.5).add(0.5);
      const streaks = mx_fractal_noise_float(vec3(positionWorld.x.mul(1.6), positionWorld.y.mul(0.12), positionWorld.z.mul(1.6)), 2, 2.0, 0.5, 0.5).add(0.5);
      const base = mix(color(0x34363d), color(0x46464e), grime).mul(mix(float(0.7), float(1.05), streaks));
      wallMat.colorNode = base;
      // Wet near the ground, dry higher up.
      wallMat.roughnessNode = mix(float(0.32), float(0.82), smoothstep(0.0, 3.5, positionWorld.y));
      wallMat.metalnessNode = float(0.0);
    }
    const wallGeo = geo(new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, WALL_Z_MAX - WALL_Z_MIN));
    for (const side of [-1, 1] as const) {
      const wall = new THREE.Mesh(wallGeo, wallMat);
      wall.position.set(side * (ALLEY_HALF_WIDTH + WALL_THICKNESS / 2), WALL_HEIGHT / 2, (WALL_Z_MIN + WALL_Z_MAX) / 2);
      wall.receiveShadow = true;
      wall.castShadow = true;
      scene.add(wall);
    }
    // Far end: a cross building closes the alley so the fog has something to swallow.
    {
      const endGeo = geo(new THREE.BoxGeometry(30, 26, 6));
      const end = new THREE.Mesh(endGeo, wallMat);
      end.position.set(0, 13, WALL_Z_MIN - 3);
      scene.add(end);
    }

    // Ledges and horizontal pipe runs break up the facades.
    {
      const ledgeGeo = geo(new THREE.BoxGeometry(0.5, 0.25, WALL_Z_MAX - WALL_Z_MIN));
      const ledgeMat = mat(new THREE.MeshStandardMaterial({ color: 0x23252b, roughness: 0.6, metalness: 0.2 }));
      for (const side of [-1, 1] as const) {
        for (const y of [2.6, 9.9]) {
          const ledge = new THREE.Mesh(ledgeGeo, ledgeMat);
          ledge.position.set(side * (ALLEY_HALF_WIDTH - 0.2), y, (WALL_Z_MIN + WALL_Z_MAX) / 2);
          ledge.castShadow = true;
          ledge.receiveShadow = true;
          scene.add(ledge);
        }
      }
      const pipeMat = mat(new THREE.MeshStandardMaterial({ color: 0x4a4d55, roughness: 0.35, metalness: 0.85 }));
      const pipeGeo = geo(new THREE.CylinderGeometry(0.11, 0.11, WALL_Z_MAX - WALL_Z_MIN, 10));
      for (const side of [-1, 1] as const) {
        for (const y of [1.6, 1.95]) {
          const pipe = new THREE.Mesh(pipeGeo, pipeMat);
          pipe.rotation.x = Math.PI / 2;
          pipe.position.set(side * (ALLEY_HALF_WIDTH - 0.18), y, (WALL_Z_MIN + WALL_Z_MAX) / 2);
          pipe.castShadow = true;
          pipe.receiveShadow = true;
          scene.add(pipe);
        }
      }
      const riserGeo = geo(new THREE.CylinderGeometry(0.14, 0.14, WALL_HEIGHT, 10));
      for (let i = 0; i < 7; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const riser = new THREE.Mesh(riserGeo, pipeMat);
        riser.position.set(side * (ALLEY_HALF_WIDTH - 0.2), WALL_HEIGHT / 2, -55 + i * 12.5 + random.range(-1.5, 1.5));
        riser.castShadow = true;
        riser.receiveShadow = true;
        scene.add(riser);
      }
    }

    // ---- windows: two instanced draws (lit / dark) -------------------------
    {
      const windowGeo = geo(new THREE.PlaneGeometry(1.1, 1.5));
      // transparent: true opts these out of the GTAO context (unlit surfaces must not receive AO grain).
      const litMat = mat(new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(2.4, 2.4, 2.4), fog: true, transparent: true }));
      const darkMat = mat(new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.1, metalness: 0.6 }));
      const rows = [3.8, 6.6, 9.4, 12.2, 15.0];
      const columns: number[] = [];
      for (let z = WALL_Z_MIN + 3; z < WALL_Z_MAX - 2; z += 2.9) columns.push(z);
      const total = rows.length * columns.length * 2;
      const lit = new THREE.InstancedMesh(windowGeo, litMat, total);
      const dark = new THREE.InstancedMesh(windowGeo, darkMat, total);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3(1, 1, 1);
      const p = new THREE.Vector3();
      const c = new THREE.Color();
      const palette = [0xffb86b, 0xffd9a0, 0x9fd4ff, 0xff8cc8, 0xc8ffd6, 0xfff1c9];
      let litCount = 0;
      let darkCount = 0;
      for (const side of [-1, 1] as const) {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), side === -1 ? Math.PI / 2 : -Math.PI / 2);
        for (const y of rows) {
          for (const z of columns) {
            p.set(side * (ALLEY_HALF_WIDTH - 0.1), y, z);
            m.compose(p, q, s);
            if (random.next() < 0.42) {
              lit.setMatrixAt(litCount, m);
              c.setHex(random.pick(palette)).multiplyScalar(random.range(0.35, 1.0));
              lit.setColorAt(litCount, c);
              litCount++;
            } else {
              dark.setMatrixAt(darkCount, m);
              darkCount++;
            }
          }
        }
      }
      lit.count = litCount;
      dark.count = darkCount;
      dark.receiveShadow = true;
      scene.add(lit, dark);
      // Window frames for depth: one instanced box behind each window.
      const frameGeo = geo(new THREE.BoxGeometry(1.3, 1.7, 0.16));
      const frameMat = mat(new THREE.MeshStandardMaterial({ color: 0x1a1c22, roughness: 0.7, metalness: 0.1 }));
      const frames = new THREE.InstancedMesh(frameGeo, frameMat, total);
      let f = 0;
      for (const side of [-1, 1] as const) {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), side === -1 ? Math.PI / 2 : -Math.PI / 2);
        for (const y of rows) {
          for (const z of columns) {
            p.set(side * (ALLEY_HALF_WIDTH + 0.04), y, z);
            m.compose(p, q, s);
            frames.setMatrixAt(f++, m);
          }
        }
      }
      frames.count = f;
      frames.castShadow = true;
      frames.receiveShadow = true;
      scene.add(frames);
    }

    // ---- neon signs + matching lights ---------------------------------------
    const flickering: { material: THREE.MeshBasicNodeMaterial; light: THREE.PointLight; base: number; phase: number; color: THREE.Color }[] = [];
    {
      const housingMat = mat(new THREE.MeshStandardMaterial({ color: 0x121317, roughness: 0.55, metalness: 0.5 }));
      const bracketGeo = geo(new THREE.BoxGeometry(0.9, 0.08, 0.08));
      const tubeRadius = 0.045;
      for (const spec of NEON_SIGNS) {
        const group = new THREE.Group();
        const x = spec.side * (ALLEY_HALF_WIDTH - 0.9);
        group.position.set(x, spec.y, spec.z);
        // The sign hangs perpendicular to the wall so both walls read from the camera.
        const housingGeo = geo(new THREE.BoxGeometry(0.12, spec.height + 0.3, spec.width + 0.3));
        const housing = new THREE.Mesh(housingGeo, housingMat);
        housing.castShadow = true;
        group.add(housing);
        const bracket = new THREE.Mesh(bracketGeo, housingMat);
        bracket.position.set(spec.side * 0.45, spec.height / 2 + 0.1, 0);
        group.add(bracket);

        const neon = new THREE.Color(spec.color);
        const neonMat = mat(new THREE.MeshBasicNodeMaterial({ color: neon.clone().multiplyScalar(5.5), fog: true, transparent: true }));
        const addTube = (w: number, h: number, dy: number, dz: number, ry = 0): void => {
          const g = geo(new THREE.BoxGeometry(tubeRadius * 2, h, w));
          const t = new THREE.Mesh(g, neonMat);
          t.position.set(0, dy, dz);
          t.rotation.x = ry;
          group.add(t);
        };
        // Rim.
        addTube(spec.width, tubeRadius * 2, spec.height / 2, 0);
        addTube(spec.width, tubeRadius * 2, -spec.height / 2, 0);
        addTube(tubeRadius * 2, spec.height, 0, spec.width / 2);
        addTube(tubeRadius * 2, spec.height, 0, -spec.width / 2);
        // Glyph.
        if (spec.glyph === 'ring') {
          const ringGeo = geo(new THREE.TorusGeometry(Math.min(spec.width, spec.height) * 0.28, tubeRadius, 8, 32));
          const ring = new THREE.Mesh(ringGeo, neonMat);
          ring.rotation.y = Math.PI / 2;
          group.add(ring);
        } else if (spec.glyph === 'bars') {
          for (let i = 0; i < 3; i++) {
            addTube(spec.width * random.range(0.35, 0.75), tubeRadius * 2, (i - 1) * spec.height * 0.28, random.range(-0.15, 0.15) * spec.width);
          }
        } else {
          addTube(spec.height * 0.7, tubeRadius * 2, 0, spec.width * 0.15, Math.PI / 4);
          addTube(spec.height * 0.7, tubeRadius * 2, 0, -spec.width * 0.15, -Math.PI / 4);
        }
        // Both sides of the sign glow: a translucent panel with the neon colour.
        const panelGeo = geo(new THREE.PlaneGeometry(spec.width, spec.height));
        const panelMat = mat(
          new THREE.MeshStandardMaterial({
            color: 0x000000,
            emissive: neon,
            emissiveIntensity: 0.9,
            roughness: 0.4,
            metalness: 0.0,
            side: THREE.DoubleSide,
          }),
        );
        const panel = new THREE.Mesh(panelGeo, panelMat);
        panel.rotation.y = Math.PI / 2;
        panel.position.x = 0;
        group.add(panel);
        scene.add(group);

        const light = new THREE.PointLight(spec.color, 140, 9.5, 2);
        light.position.set(x - spec.side * 0.9, spec.y - 0.4, spec.z);
        scene.add(light);
        if (spec.flicker) flickering.push({ material: neonMat, light, base: light.intensity, phase: random.range(0, 6.28), color: neon });
      }
    }

    // Warm spill from a couple of windows/doors at street level.
    {
      const doorGeo = geo(new THREE.PlaneGeometry(1.4, 2.4));
      const doorMat = mat(new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(2.6, 1.6, 0.9), fog: true, transparent: true }));
      for (const [side, z] of [
        [-1, -9],
        [1, -20],
      ] as const) {
        const door = new THREE.Mesh(doorGeo, doorMat);
        door.position.set(side * (ALLEY_HALF_WIDTH - 0.08), 1.2, z);
        door.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2;
        scene.add(door);
        const spill = new THREE.SpotLight(0xffc27a, 900, 13, 0.9, 0.7, 2);
        spill.position.set(side * (ALLEY_HALF_WIDTH - 0.4), 2.6, z);
        spill.target.position.set(side * 1.5, 0, z + 0.5);
        scene.add(spill, spill.target);
      }
    }

    // ---- props ---------------------------------------------------------------
    {
      const crateGeo = geo(new THREE.BoxGeometry(1, 1, 1));
      const crateMats = [0x5a4632, 0x3d4d5c, 0x6b6b60, 0x4a3b2a].map((c) =>
        mat(new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, metalness: 0.05 })),
      );
      const addCrate = (x: number, y: number, z: number, size: number, yaw: number): void => {
        const crate = new THREE.Mesh(crateGeo, random.pick(crateMats));
        crate.position.set(x, y + size / 2, z);
        crate.scale.setScalar(size);
        crate.rotation.y = yaw;
        crate.castShadow = true;
        crate.receiveShadow = true;
        scene.add(crate);
      };
      // Foreground stack (camera side, right).
      addCrate(3.9, 0, 5.2, 1.1, 0.2);
      addCrate(3.2, 0, 6.4, 0.9, -0.3);
      addCrate(3.8, 1.1, 5.3, 0.8, 0.6);
      // Mid stacks against the walls.
      for (let i = 0; i < 12; i++) {
        const side = random.bool() ? -1 : 1;
        const size = random.range(0.7, 1.2);
        const z = random.range(-38, 0);
        addCrate(side * (ALLEY_HALF_WIDTH - 0.6 - random.range(0, 0.8)), 0, z, size, random.range(-0.4, 0.4));
        if (random.bool(0.4)) addCrate(side * (ALLEY_HALF_WIDTH - 0.7), size, z + random.range(-0.2, 0.2), size * 0.85, random.range(-0.5, 0.5));
      }

      // Barrels.
      const barrelGeo = geo(new THREE.CylinderGeometry(0.42, 0.42, 1.15, 18));
      const barrelMats = [0x2f3a44, 0x54321e, 0x3b3f3a].map((c) =>
        mat(new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.6 })),
      );
      for (let i = 0; i < 6; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const barrel = new THREE.Mesh(barrelGeo, random.pick(barrelMats));
        barrel.position.set(side * (ALLEY_HALF_WIDTH - random.range(0.7, 1.6)), 0.575, random.range(-34, 4));
        barrel.castShadow = true;
        barrel.receiveShadow = true;
        scene.add(barrel);
      }

      // Dumpster with a propped lid.
      const dumpsterMat = mat(new THREE.MeshStandardMaterial({ color: 0x1f3a2a, roughness: 0.5, metalness: 0.55 }));
      const dumpster = new THREE.Group();
      const body = new THREE.Mesh(geo(new THREE.BoxGeometry(2.6, 1.4, 1.4)), dumpsterMat);
      body.position.y = 0.75;
      body.castShadow = true;
      body.receiveShadow = true;
      const lid = new THREE.Mesh(geo(new THREE.BoxGeometry(2.6, 0.1, 1.45)), dumpsterMat);
      lid.position.set(0, 1.45, -0.7);
      lid.rotation.x = -0.5;
      lid.castShadow = true;
      dumpster.add(body, lid);
      dumpster.position.set(-3.9, 0, -4.5);
      dumpster.rotation.y = 0.12;
      scene.add(dumpster);

      // Wall-mounted AC units.
      const acGeo = geo(new THREE.BoxGeometry(0.7, 0.75, 1.0));
      const acMat = mat(new THREE.MeshStandardMaterial({ color: 0x8a8d92, roughness: 0.4, metalness: 0.7 }));
      for (let i = 0; i < 6; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const ac = new THREE.Mesh(acGeo, acMat);
        ac.position.set(side * (ALLEY_HALF_WIDTH - 0.35), random.range(4.5, 8.5), random.range(-36, 6));
        ac.castShadow = true;
        ac.receiveShadow = true;
        scene.add(ac);
      }

      // Cables sagging across the alley.
      const cableMat = mat(new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.6, metalness: 0.3 }));
      for (let i = 0; i < 5; i++) {
        const z = -30 + i * 7 + random.range(-1.5, 1.5);
        const y = random.range(8.5, 12.5);
        const sag = random.range(0.9, 1.8);
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(-ALLEY_HALF_WIDTH, y, z),
          new THREE.Vector3(random.range(-1, 1), y - sag, z + random.range(-0.4, 0.4)),
          new THREE.Vector3(ALLEY_HALF_WIDTH, y + random.range(-0.6, 0.6), z + random.range(-0.5, 0.5)),
        ]);
        const cable = new THREE.Mesh(geo(new THREE.TubeGeometry(curve, 24, 0.035, 6, false)), cableMat);
        cable.castShadow = true;
        scene.add(cable);
      }

      // Steam vent on the left wall.
      const ventGeo = geo(new THREE.BoxGeometry(0.2, 0.6, 1.0));
      const vent = new THREE.Mesh(ventGeo, acMat);
      vent.position.set(-ALLEY_HALF_WIDTH + 0.1, 0.6, -7.5);
      scene.add(vent);
    }

    // ---- steam sprites -------------------------------------------------------
    interface Puff {
      sprite: THREE.Sprite;
      material: THREE.SpriteNodeMaterial;
      age: number;
      life: number;
      drift: THREE.Vector3;
      origin: THREE.Vector3;
    }
    const puffs: Puff[] = [];
    {
      const radial = smoothstep(0.5, 0.08, length(uv().sub(0.5)));
      const makePuffMaterial = (tint: THREE.Color): THREE.SpriteNodeMaterial => {
        const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, fog: true });
        m.colorNode = color(tint);
        m.opacityNode = radial.mul(materialOpacity);
        m.opacity = 0;
        return mat(m);
      };
      const vents: { origin: THREE.Vector3; tint: THREE.Color; drift: THREE.Vector3 }[] = [
        { origin: new THREE.Vector3(-4.9, 0.9, -7.5), tint: new THREE.Color(0.55, 0.62, 0.78), drift: new THREE.Vector3(0.7, 0.9, 0.1) },
        { origin: new THREE.Vector3(4.6, 0.4, -16), tint: new THREE.Color(0.5, 0.7, 0.62), drift: new THREE.Vector3(-0.5, 0.8, 0.2) },
      ];
      for (const v of vents) {
        for (let i = 0; i < 9; i++) {
          const material = makePuffMaterial(v.tint);
          const sprite = new THREE.Sprite(material);
          const life = random.range(3.5, 5.5);
          const puff: Puff = { sprite, material, age: random.range(0, life), life, drift: v.drift, origin: v.origin };
          puffs.push(puff);
          scene.add(sprite);
        }
      }
    }
    const stepPuff = (puff: Puff, dt: number): void => {
      puff.age += dt;
      if (puff.age >= puff.life) puff.age -= puff.life;
      const t = puff.age / puff.life;
      const scale = 1.0 + t * 4.0;
      puff.sprite.scale.set(scale, scale, 1);
      puff.sprite.position.set(
        puff.origin.x + puff.drift.x * puff.age + Math.sin(puff.age * 1.7) * 0.25,
        puff.origin.y + puff.drift.y * puff.age,
        puff.origin.z + puff.drift.z * puff.age,
      );
      // Fade in fast, out slow.
      puff.material.opacity = Math.min(1, t * 6) * (1 - t) * (1 - t) * 0.75;
    };
    for (const puff of puffs) stepPuff(puff, 0);

    // ---- rain: one instanced draw, fixed-step, deterministic wrap -----------
    const rainCount = Math.max(50, Math.round(2600 * quality.particleDensity));
    const rain = createRain(rainCount, random.fork());
    geometries.push(rain.geometry);
    materials.push(rain.material);
    scene.add(rain.mesh);

    // ---- hero placeholder ----------------------------------------------------
    {
      const bodyGeo = geo(new THREE.CapsuleGeometry(0.32, 0.85, 6, 20));
      const bodyMat = mat(new THREE.MeshStandardMaterial({ color: 0x1d2230, roughness: 0.45, metalness: 0.35 }));
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      body.position.y = 0.85;
      body.castShadow = true;
      body.receiveShadow = true;
      hero.add(body);
      const visorGeo = geo(new THREE.BoxGeometry(0.34, 0.08, 0.12));
      const visorMat = mat(new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0.3, 4.5, 5.0), fog: true, transparent: true }));
      const visor = new THREE.Mesh(visorGeo, visorMat);
      visor.position.set(0, 1.28, 0.28);
      hero.add(visor);
      const packGeo = geo(new THREE.BoxGeometry(0.4, 0.5, 0.2));
      const packMat = mat(new THREE.MeshStandardMaterial({ color: 0x343a48, roughness: 0.6, metalness: 0.3 }));
      const pack = new THREE.Mesh(packGeo, packMat);
      pack.position.set(0, 0.95, -0.3);
      pack.castShadow = true;
      hero.add(pack);
      hero.position.copy(heroPosition);
      hero.rotation.y = -0.4;
      scene.add(hero);
    }

    let elapsed = 0;
    let nextThump = 4;

    return {
      scene,
      camera: rig.camera,
      fixedUpdate(fixedDt): void {
        rain.step(fixedDt);
        for (const puff of puffs) stepPuff(puff, fixedDt);
      },
      update(dt): void {
        elapsed += dt;
        hero.position.y = heroPosition.y + Math.sin(elapsed * 2.1) * 0.06;
        hero.rotation.y = -0.4 + Math.sin(elapsed * 0.7) * 0.15;
        frameTarget(rig.target);
        if (elapsed >= nextThump) {
          rig.addTrauma(0.35);
          nextThump += 7;
        }
        rig.update(dt);
        for (const f of flickering) {
          const n = Math.sin(elapsed * 23 + f.phase) * Math.sin(elapsed * 7.3 + f.phase * 2);
          const on = n > -0.85 ? 1 : 0.15;
          f.light.intensity = f.base * on;
          f.material.color.copy(f.color).multiplyScalar(5.5 * on);
        }
      },
      resize(width, height): void {
        rig.setAspect(width / height);
      },
      dispose(): void {
        bag.dispose();
        scene.clear();
      },
    };
  },
};

// ---- helpers ------------------------------------------------------------------

interface RainField {
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  step(dt: number): void;
}

function createRain(count: number, random: Random): RainField {
  const geometry = new THREE.BoxGeometry(0.014, 0.42, 0.014);
  const material = new THREE.MeshBasicNodeMaterial({
    color: new THREE.Color(0.75, 0.82, 1.0),
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    fog: true,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.frustumCulled = false;
  const xs = new Float32Array(count);
  const ys = new Float32Array(count);
  const zs = new Float32Array(count);
  const speeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    xs[i] = random.range(-ALLEY_HALF_WIDTH - 1, ALLEY_HALF_WIDTH + 1);
    ys[i] = random.range(0, RAIN_TOP);
    zs[i] = random.range(-34, 16);
    speeds[i] = random.range(13, 19);
  }
  const windX = 0.9;
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.atan2(windX, 16));
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  const write = (): void => {
    for (let i = 0; i < count; i++) {
      p.set(xs[i] ?? 0, ys[i] ?? 0, zs[i] ?? 0);
      m.compose(p, tilt, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  write();
  return {
    mesh,
    geometry,
    material,
    step(dt): void {
      for (let i = 0; i < count; i++) {
        let y = (ys[i] ?? 0) - (speeds[i] ?? 15) * dt;
        let x = (xs[i] ?? 0) + windX * dt;
        if (y < -0.3) {
          y += RAIN_TOP;
          x = random.range(-ALLEY_HALF_WIDTH - 1, ALLEY_HALF_WIDTH + 1);
        }
        if (x > ALLEY_HALF_WIDTH + 1) x -= (ALLEY_HALF_WIDTH + 1) * 2;
        ys[i] = y;
        xs[i] = x;
      }
      write();
    },
  };
}

/** A dark box with neon-coloured panels: what the puddles and metal reflect. */
function buildEnvironmentScene(): THREE.Scene {
  const env = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(20, 12, 40), new THREE.MeshBasicMaterial({ color: 0x06070c, side: THREE.BackSide }));
  env.add(room);
  const panels: [number, THREE.Vector3, THREE.Euler, number][] = [
    [0xff2bd6, new THREE.Vector3(-9.9, 2, -6), new THREE.Euler(0, Math.PI / 2, 0), 0.9],
    [0x22e8ff, new THREE.Vector3(9.9, 3, -12), new THREE.Euler(0, -Math.PI / 2, 0), 1.1],
    [0xff7a1a, new THREE.Vector3(-9.9, 1, -16), new THREE.Euler(0, Math.PI / 2, 0), 0.8],
    [0x3d7bff, new THREE.Vector3(9.9, 1.5, 4), new THREE.Euler(0, -Math.PI / 2, 0), 0.7],
    [0x4a5a78, new THREE.Vector3(0, 5.9, -8), new THREE.Euler(Math.PI / 2, 0, 0), 0.9],
    [0x3a4460, new THREE.Vector3(0, 5.9, 8), new THREE.Euler(Math.PI / 2, 0, 0), 0.7],
  ];
  for (const [hex, position, rotation, intensity] of panels) {
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 2.5),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(intensity * 3) }),
    );
    panel.position.copy(position);
    panel.rotation.copy(rotation);
    env.add(panel);
  }
  return env;
}

function disposeHierarchy(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}
