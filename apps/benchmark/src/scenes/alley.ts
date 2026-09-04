import * as THREE from 'three/webgpu';
import {
  abs,
  color,
  float,
  floor,
  fract,
  hash,
  length,
  materialColor,
  materialOpacity,
  materialRoughness,
  max,
  min,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalView,
  normalWorld,
  positionGeometry,
  positionWorld,
  saturate,
  sin,
  smoothstep,
  time,
  transformNormalToView,
  uv,
  vec3,
} from 'three/tsl';
import {
  CameraRig,
  Decals,
  PARTICLE_PRESETS,
  DisposeBag,
  RenderSync,
  Transform,
  VolumeFogSettings,
  applySceneEnvironment,
  createHeightFog,
  damp,
  materialParam,
  prepareDecalMaterial,
  type AnimationGraphDef,
  type CameraRigPreset,
  type Entity,
  type ParticleEmitterDescriptorInput,
  type Random,
  type SceneDefinition,
  type SceneInstance,
} from '@spark/engine';

/**
 * Rainy Cyberpunk Alley, second pass (kickoff §48, Milestone 7). Still fully
 * procedural, now built on the advanced-rendering stack:
 *
 * - procedural TSL surfaces: brick facades with mortar recesses, wet asphalt
 *   with a puddle mask and animated ripples, concrete kerbs; wet sheen on every
 *   prop (upward faces and the splash zone near the ground go glossy)
 * - projected decals: oil stains and grime on the asphalt, torn posters and
 *   damp streaks on the walls; impact marks from the dynamic pool on each thump
 * - GPU particles: a wrapping rain volume that follows the camera target,
 *   steam from two vents, expanding splash rings on the ground (the CPU rain
 *   field of v1 survives as the WebGL2 fallback)
 * - height fog (`scene.fogNode`), a raymarched fog volume around the hero
 *   spot, godrays from the moon, SSR in the puddles (all from the preset, the
 *   volume opts in on `high` where it measured under budget)
 * - composition: a slightly lower pitch, a fire escape and cables in the
 *   foreground, a flickering neon sign, the hero pinned in the lower third
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
const RAIN_VOLUME: readonly [number, number, number] = [16, 22, 46];
const RAIN_CAPACITY = 20_000;
/** Rain streaks inside this distance of the lens shrink and fade (no thick near-camera smears). */
const RAIN_NEAR_FADE = 7;

// ---- hero -----------------------------------------------------------------------
const MANNEQUIN_URL = '/models/mannequin.glb';
const HERO_WALK = 1.2;
const HERO_RUN = 4.0;
const HERO_TURN_RATE = 10;
const HERO_SPEED_RATE = 8;
/** Seconds an idle leg of the autopilot spends turning toward the next heading. */
const HERO_TURN_TIME = 0.7;
/** Where the hero key light and fog-volume spot aim; the autopilot loop stays inside that pool. */
const HERO_SPOT = new THREE.Vector3(-0.8, 0, 2);
const HERO_START = new THREE.Vector3(-0.8, 0, -0.4);
/** Facing when walking toward the camera: three-quarter, so the face and the wet shoulders both read. */
const HERO_APPROACH_YAW = 0.35;
const HERO_X_LIMIT = ALLEY_HALF_WIDTH - 1.1;
const HERO_Z_MIN = -34;
const HERO_Z_MAX = 9;

/** idle/walk/run on `speed` with root motion; an additive attack on the upper body (Space). */
const HERO_GRAPH: AnimationGraphDef = {
  params: { speed: 0 },
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
              { clip: 'walk', threshold: HERO_WALK },
              { clip: 'run', threshold: HERO_RUN },
            ],
          },
        },
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
      anyState: [{ to: 'attack', conditions: [{ trigger: 'attack' }], duration: 0.05 }],
    },
  ],
};

interface AutopilotLeg {
  duration: number;
  walk: boolean;
  yaw: number;
}

const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const ALLEY_CAMERA: CameraRigPreset = {
  yaw: 0.17,
  pitch: 0.4,
  distance: 24,
  fov: 39,
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
  /** Point light intensity (default 140). */
  light?: number;
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
  { color: 0x22e8ff, side: 1, y: 3.4, z: 7.5, width: 1.8, height: 0.9, glyph: 'bars', flicker: true, light: 40 },
];

/** Expanding rings where drops hit the wet ground: a mesh emitter of flat rings, alpha-blended, short-lived. */
function splashRingDescriptor(geometry: THREE.BufferGeometry, material: THREE.NodeMaterial, capacity: number, rate: number): ParticleEmitterDescriptorInput {
  return {
    capacity,
    rate,
    lifetime: [0.3, 0.5],
    shape: { kind: 'box', size: [11, 0.02, 34] },
    space: 'world',
    direction: [0, 1, 0],
    speed: [0, 0],
    spread: 0,
    gravity: 0,
    drag: 0,
    size: [0.07, 0.14],
    sizeOverLife: [
      [0, 0.15],
      [1, 1],
    ],
    colorOverLife: [
      [0, 1, 1, 1, 0.4],
      [0.5, 1, 1, 1, 0.22],
      [1, 1, 1, 1, 0],
    ],
    render: { kind: 'mesh', geometry, material, align: 'none' },
    seed: 77,
  };
}

export const alleyScene: SceneDefinition = {
  name: 'alley',
  async create(ctx): Promise<SceneInstance> {
    const bag = new DisposeBag();
    const { random, quality, entities, vfx, logger, animation, assets, input } = ctx;
    const pipeline = ctx.renderer.pipeline;
    const gpu = ctx.renderer.capabilities.backend === 'webgpu';
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05060a);
    // Height fog: exp2 distance fog that thickens toward the asphalt (HeightFog.ts).
    const fog = createHeightFog({ color: 0x0a0e1c, density: 0.0165, groundY: 0, falloff: 4.5, groundBoost: 1.1 });
    scene.fogNode = fog.node;

    // Dynamic resolution only makes sense on a wall clock; never on the capture clock.
    ctx.renderer.setDynamicResolutionEnabled(ctx.config.fixedFrameDelta === null && quality.dynamicResolution);
    bag.add(() => ctx.renderer.setDynamicResolutionEnabled(false));

    // ---- camera -----------------------------------------------------------
    const rig = new CameraRig({ preset: ALLEY_CAMERA, aspect: ctx.renderer.aspect, near: 0.5, far: 140, random: random.fork(), focusRange: 7 });
    const heroPosition = HERO_SPOT;
    /** The hero's world position this frame (read back from its Transform after root motion). */
    const heroPose = HERO_START.clone();
    // Frame the hero in the lower third with the alley receding above it.
    const frameTarget = (out: THREE.Vector3): THREE.Vector3 => out.set(heroPose.x - 0.9, 1.2, heroPose.z - 5.5);
    frameTarget(rig.target);
    // DOF (cinematic) keeps the hero sharp, not the framing point 5 m behind it.
    rig.focusTarget = heroPose;
    rig.bindFocus(pipeline);
    bag.add(() => rig.bindFocus(null));
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

    // Hung from the left facade and aimed across the alley, so its cone crosses the frame instead of pointing at the camera.
    const heroLight = new THREE.SpotLight(0xfff0dc, 3400, 20, 0.42, 0.6, 2);
    heroLight.position.set(-4.6, 8.6, 6.0);
    heroLight.target.position.copy(heroPosition);
    heroLight.castShadow = quality.shadows;
    heroLight.shadow.mapSize.set(quality.shadowMapSize / 2, quality.shadowMapSize / 2);
    heroLight.shadow.camera.near = 1;
    heroLight.shadow.camera.far = 20;
    heroLight.shadow.bias = -0.0004;
    heroLight.shadow.normalBias = 0.02;
    scene.add(heroLight, heroLight.target);

    // ---- volumetrics: the hero spot's cone in a fog volume, and moon shafts ----
    if (gpu) {
      const spotDirection = heroPosition.clone().sub(heroLight.position).normalize();
      const volume = new VolumeFogSettings({
        bounds: { min: new THREE.Vector3(-ALLEY_HALF_WIDTH, 0, -16), max: new THREE.Vector3(ALLEY_HALF_WIDTH, 11.5, 14) },
        // Density is nearly uniform with height (long falloff) so the spot reads as a beam, not a pool on the asphalt.
        density: 0.032,
        color: 0x2c3a58,
        ambient: 0.02,
        heightFalloff: 16,
        noiseScale: 0.2,
        noiseDrift: new THREE.Vector3(0.25, 0.08, 0.12),
        noiseStrength: 0.4,
        anisotropy: 0.4,
        spot: {
          position: heroLight.position,
          direction: spotDirection,
          angle: heroLight.angle,
          penumbra: 0.6,
          color: 0xffe8d0,
          intensity: 19,
          range: 19,
        },
      });
      pipeline.setVolumeFog(volume);
      pipeline.setGodraysLight(moon, { color: 0x7d95d8, intensity: 0.7, density: 0.9, maxDensity: 0.4, distanceAttenuation: 1.6 });
      bag.add(() => {
        pipeline.setVolumeFog(null);
        pipeline.setGodraysLight(null);
      });
      // The volume measured well under 1.5 ms at 1080p on the reference GPU, so
      // the alley opts in on high (the preset default is ultra+, see effect-costs.md).
      if (quality.preset === 'high' && quality.shadows) pipeline.setEffectEnabled('volumetrics', true);
    }

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
    // Material graphs are shared, never rebuilt per material: three keys a shader
    // program on the node *instances* of the graph, so two materials only share a
    // compiled pipeline when they reference the same nodes and differ through
    // material properties (`materialColor`, `materialRoughness`, `userData`
    // references). Every per-material constant baked into a fresh graph is one
    // more 0.2–0.8 s shader compile per pass (docs/performance/cold-start.md).
    const wetSheen = createWetSheenGraph();
    /** A lit prop material with rain sheen: glossy on upward faces and in the splash zone near the ground. */
    const wetStandard = (hex: number, roughnessValue: number, metalnessValue: number): THREE.MeshStandardNodeMaterial => {
      const m = mat(new THREE.MeshStandardNodeMaterial());
      m.color.setHex(hex);
      m.roughness = roughnessValue;
      m.metalness = metalnessValue;
      m.roughnessNode = wetSheen.roughness;
      m.colorNode = wetSheen.color;
      return m;
    };
    /**
     * The hero's rain-wet skin: the mannequin's base colour and roughness, darkened
     * and glossed where water sits (upward faces, drip streaks down the body, the
     * splash zone at the ankles) so the neon and the key light land as tight
     * highlights, plus a cool sky rim so the silhouette
     * separates from the wet asphalt. `positionGeometry` (bind pose) keeps the
     * streaks fixed to the surface while the skin animates. Standard, not
     * physical: the clear-coat variant compiled for ~18 s on D3D11 and stalled
     * the first frames; standard with a low wet roughness reads the same here.
     */
    const wetSkinGraph = createWetSkinGraph();
    const wetSkin = (source: THREE.MeshStandardMaterial, height: number): THREE.MeshStandardNodeMaterial => {
      const m = mat(new THREE.MeshStandardNodeMaterial());
      m.name = `${source.name}_wet`;
      // The asset ships a light showroom grey; under the 3400 cd key spot that clips to white, so the hero wears the alley palette: dark slate with near-black trim.
      m.color.setHex(source.name.includes('accent') ? 0x0c0d12 : 0x232838);
      m.roughness = source.roughness;
      m.metalness = source.metalness;
      // Drip streak frequency in bind-pose units, per mesh height (read by the shared graph).
      m.userData.streakScale = new THREE.Vector3(14 / height, 2.4 / height, 14 / height);
      m.colorNode = wetSkinGraph.color;
      m.roughnessNode = wetSkinGraph.roughness;
      m.emissiveNode = wetSkinGraph.emissive;
      return m;
    };

    // ---- ground: wet asphalt with puddles ---------------------------------
    const groundGeo = geo(new THREE.PlaneGeometry(40, 100, 1, 1));
    const groundMat = mat(createAsphaltMaterial());
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, -15);
    ground.receiveShadow = true;
    ground.updateMatrixWorld();
    scene.add(ground);

    // ---- facades ------------------------------------------------------------
    const wallMat = mat(createBrickMaterial());
    const wallGeo = geo(new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, WALL_Z_MAX - WALL_Z_MIN));
    const walls: THREE.Mesh[] = [];
    for (const side of [-1, 1] as const) {
      const wall = new THREE.Mesh(wallGeo, wallMat);
      wall.position.set(side * (ALLEY_HALF_WIDTH + WALL_THICKNESS / 2), WALL_HEIGHT / 2, (WALL_Z_MIN + WALL_Z_MAX) / 2);
      wall.receiveShadow = true;
      wall.castShadow = true;
      wall.updateMatrixWorld();
      scene.add(wall);
      walls.push(wall);
    }
    // Far end: a cross building closes the alley so the fog has something to swallow.
    {
      const endGeo = geo(new THREE.BoxGeometry(30, 26, 6));
      const end = new THREE.Mesh(endGeo, wallMat);
      end.position.set(0, 13, WALL_Z_MIN - 3);
      scene.add(end);
    }
    // Concrete kerbs along both walls.
    {
      const kerbGeo = geo(new THREE.BoxGeometry(0.55, 0.16, WALL_Z_MAX - WALL_Z_MIN));
      const kerbMat = mat(createConcreteMaterial());
      for (const side of [-1, 1] as const) {
        const kerb = new THREE.Mesh(kerbGeo, kerbMat);
        kerb.position.set(side * (ALLEY_HALF_WIDTH - 0.275), 0.08, (WALL_Z_MIN + WALL_Z_MAX) / 2);
        kerb.receiveShadow = true;
        kerb.castShadow = true;
        scene.add(kerb);
      }
    }

    // Ledges and horizontal pipe runs break up the facades.
    const pipeMat = wetStandard(0x4a4d55, 0.38, 0.85);
    {
      const ledgeGeo = geo(new THREE.BoxGeometry(0.5, 0.25, WALL_Z_MAX - WALL_Z_MIN));
      const ledgeMat = wetStandard(0x23252b, 0.62, 0.2);
      for (const side of [-1, 1] as const) {
        for (const y of [2.6, 9.9]) {
          const ledge = new THREE.Mesh(ledgeGeo, ledgeMat);
          ledge.position.set(side * (ALLEY_HALF_WIDTH - 0.2), y, (WALL_Z_MIN + WALL_Z_MAX) / 2);
          ledge.castShadow = true;
          ledge.receiveShadow = true;
          scene.add(ledge);
        }
      }
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
      litMat.colorNode = windowInterior();
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
      const frameMat = wetStandard(0x1a1c22, 0.7, 0.1);
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
      const housingMat = wetStandard(0x121317, 0.55, 0.5);
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

        const light = new THREE.PointLight(spec.color, spec.light ?? 140, 9.5, 2);
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
    const acMat = wetStandard(0x8a8d92, 0.42, 0.7);
    {
      const crateGeo = geo(new THREE.BoxGeometry(1, 1, 1));
      const crateMats = [0x5a4632, 0x3d4d5c, 0x6b6b60, 0x4a3b2a].map((c) => wetStandard(c, 0.82, 0.05));
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
      const barrelMats = [0x2f3a44, 0x54321e, 0x3b3f3a].map((c) => wetStandard(c, 0.48, 0.6));
      for (let i = 0; i < 6; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const barrel = new THREE.Mesh(barrelGeo, random.pick(barrelMats));
        barrel.position.set(side * (ALLEY_HALF_WIDTH - random.range(0.7, 1.6)), 0.575, random.range(-34, 4));
        barrel.castShadow = true;
        barrel.receiveShadow = true;
        scene.add(barrel);
      }

      // Dumpster with a propped lid.
      const dumpsterMat = wetStandard(0x1f3a2a, 0.52, 0.55);
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
      for (let i = 0; i < 6; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const ac = new THREE.Mesh(acGeo, acMat);
        ac.position.set(side * (ALLEY_HALF_WIDTH - 0.35), random.range(4.5, 8.5), random.range(-36, 6));
        ac.castShadow = true;
        ac.receiveShadow = true;
        scene.add(ac);
      }

      // Cables sagging across the alley; two of them in the foreground, high, for depth.
      const cableMat = wetStandard(0x0a0a0c, 0.6, 0.3);
      const cableSpans: [number, number, number][] = [];
      for (let i = 0; i < 5; i++) cableSpans.push([-30 + i * 7 + random.range(-1.5, 1.5), random.range(8.5, 12.5), random.range(0.9, 1.8)]);
      cableSpans.push([9.5, 11.6, 1.4], [13, 12.6, 1.9]);
      for (const [z, y, sag] of cableSpans) {
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(-ALLEY_HALF_WIDTH, y, z),
          new THREE.Vector3(random.range(-1, 1), y - sag, z + random.range(-0.4, 0.4)),
          new THREE.Vector3(ALLEY_HALF_WIDTH, y + random.range(-0.6, 0.6), z + random.range(-0.5, 0.5)),
        ]);
        const cable = new THREE.Mesh(geo(new THREE.TubeGeometry(curve, 24, 0.035, 6, false)), cableMat);
        cable.castShadow = true;
        scene.add(cable);
      }

      // Steam vents on both walls.
      const ventGeo = geo(new THREE.BoxGeometry(0.2, 0.6, 1.0));
      const vent = new THREE.Mesh(ventGeo, acMat);
      vent.position.set(-ALLEY_HALF_WIDTH + 0.1, 0.6, -7.5);
      scene.add(vent);
      const vent2 = new THREE.Mesh(ventGeo, acMat);
      vent2.position.set(ALLEY_HALF_WIDTH - 0.1, 0.4, -16);
      scene.add(vent2);

      // Fire escape on the right wall, between the camera and the hero: the foreground silhouette.
      const ironMat = wetStandard(0x0d0e12, 0.5, 0.75);
      const escape = new THREE.Group();
      const railGeo = geo(new THREE.BoxGeometry(0.05, 0.05, 1));
      const postGeo = geo(new THREE.BoxGeometry(0.05, 1, 0.05));
      const addPlatform = (y: number, z0: number, z1: number): void => {
        const len = z1 - z0;
        const deck = new THREE.Mesh(geo(new THREE.BoxGeometry(1.7, 0.08, len)), ironMat);
        deck.position.set(ALLEY_HALF_WIDTH - 0.85, y, (z0 + z1) / 2);
        deck.castShadow = true;
        deck.receiveShadow = true;
        escape.add(deck);
        // Grating lines under the deck so it reads as a fire escape, not a slab.
        for (let k = 0; k < 6; k++) {
          const slat = new THREE.Mesh(railGeo, ironMat);
          slat.scale.z = len;
          slat.position.set(ALLEY_HALF_WIDTH - 1.65 + k * 0.3, y - 0.06, (z0 + z1) / 2);
          escape.add(slat);
        }
        for (const h of [0.55, 1.05]) {
          const rail = new THREE.Mesh(railGeo, ironMat);
          rail.scale.z = len;
          rail.position.set(ALLEY_HALF_WIDTH - 1.7, y + h, (z0 + z1) / 2);
          rail.castShadow = true;
          escape.add(rail);
        }
        for (let k = 0; k <= 5; k++) {
          const post = new THREE.Mesh(postGeo, ironMat);
          post.scale.y = 1.1;
          post.position.set(ALLEY_HALF_WIDTH - 1.7, y + 0.55, z0 + (len * k) / 5);
          post.castShadow = true;
          escape.add(post);
        }
      };
      addPlatform(4.3, 5.5, 11.5);
      addPlatform(7.9, 5.5, 11.5);
      // Ladder between the two platforms and a stair down to the street.
      for (const dz of [-0.3, 0.3]) {
        const side = new THREE.Mesh(postGeo, ironMat);
        side.scale.y = 3.6;
        side.position.set(ALLEY_HALF_WIDTH - 1.55, 6.1, 10.5 + dz);
        side.castShadow = true;
        escape.add(side);
      }
      for (let k = 0; k < 9; k++) {
        const rung = new THREE.Mesh(railGeo, ironMat);
        rung.scale.z = 0.6;
        rung.position.set(ALLEY_HALF_WIDTH - 1.55, 4.5 + k * 0.4, 10.5);
        escape.add(rung);
      }
      const stair = new THREE.Mesh(geo(new THREE.BoxGeometry(0.9, 0.08, 4.6)), ironMat);
      stair.position.set(ALLEY_HALF_WIDTH - 1.0, 2.3, 3.4);
      stair.rotation.x = -0.75;
      stair.castShadow = true;
      escape.add(stair);
      scene.add(escape);

    }

    // ---- decals: grime, oil, posters (Decals.ts) --------------------------------
    const decals = new Decals(scene, { dynamicCapacity: 12 });
    bag.add(decals);
    const up = new THREE.Vector3(0, 1, 0);
    // One mask graph per decal family; colour, roughness and the mask parameters are material properties.
    const blobMask = decalBlobMask();
    const blobDecal = (hex: number, roughnessValue: number, edge: number, seed: number, opacity = 1): THREE.MeshStandardNodeMaterial => {
      const m = mat(prepareDecalMaterial(new THREE.MeshStandardNodeMaterial()));
      m.color.setHex(hex);
      m.roughness = roughnessValue;
      m.metalness = 0;
      m.opacity = opacity;
      m.userData.edge = edge;
      m.userData.seed = seed;
      m.opacityNode = blobMask;
      return m;
    };
    {
      const oilMat = blobDecal(0x07080b, 0.04, 0.55, 3.1);
      for (const [x, z, size, rot] of [
        [1.6, -1.5, 3.2, 0.4],
        [-2.2, -12.5, 2.6, 2.1],
        [2.4, -22, 3.8, 1.2],
      ] as const) {
        decals.addDecal({ position: new THREE.Vector3(x, 0, z), normal: up, size: new THREE.Vector3(size, size * 0.7, 0.4), rotation: rot, target: ground, material: oilMat });
      }
      const grimeMat = blobDecal(0x141210, 0.95, 0.4, 5.3, 0.85);
      for (let i = 0; i < 7; i++) {
        const side = random.bool() ? -1 : 1;
        decals.addDecal({
          position: new THREE.Vector3(side * random.range(2.6, 4.6), 0, random.range(-34, 6)),
          normal: up,
          size: new THREE.Vector3(random.range(2, 3.5), random.range(1.5, 2.5), 0.4),
          rotation: random.range(0, Math.PI),
          target: ground,
          material: grimeMat,
        });
      }
      // Damp streaks climbing the walls from the kerb.
      const dampMat = mat(prepareDecalMaterial(new THREE.MeshStandardNodeMaterial()));
      dampMat.color.setHex(0x0c0d10);
      dampMat.roughness = 0.3;
      dampMat.metalness = 0;
      dampMat.opacityNode = decalStreakMask();
      for (let i = 0; i < 6; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const wall = walls[side === -1 ? 0 : 1] as THREE.Mesh;
        decals.addDecal({
          position: new THREE.Vector3(side * ALLEY_HALF_WIDTH, 0.9, random.range(-30, 8)),
          normal: new THREE.Vector3(-side, 0, 0),
          size: new THREE.Vector3(random.range(1.6, 2.8), 1.9, 0.5),
          target: wall,
          material: dampMat,
        });
      }
      // Torn posters at eye level.
      const posterPalette: [number, number][] = [
        [0xd9c7a8, 0xc8322c],
        [0x1e2a4a, 0x22e8ff],
        [0xefe6d0, 0x233a86],
        [0xf2c94c, 0x1b1b1b],
        [0x2b2b30, 0xff2bd6],
      ];
      const posterArt = posterColor();
      const tornMask = decalTornMask();
      for (let i = 0; i < 6; i++) {
        const side = random.bool() ? -1 : 1;
        const wall = walls[side === -1 ? 0 : 1] as THREE.Mesh;
        const [paper, accent] = random.pick(posterPalette);
        const posterMat = mat(prepareDecalMaterial(new THREE.MeshStandardNodeMaterial()));
        posterMat.color.setHex(paper);
        posterMat.roughness = 0.55;
        posterMat.metalness = 0;
        posterMat.userData.accent = new THREE.Color(accent);
        posterMat.userData.stripes = random.range(2, 6);
        posterMat.userData.seed = random.range(0, 100);
        posterMat.colorNode = posterArt;
        posterMat.opacityNode = tornMask;
        decals.addDecal({
          position: new THREE.Vector3(side * ALLEY_HALF_WIDTH, random.range(1.6, 2.4), random.range(-28, 9)),
          normal: new THREE.Vector3(-side, 0, 0),
          size: new THREE.Vector3(random.range(0.7, 1.0), random.range(1.0, 1.4), 0.5),
          rotation: random.range(-0.08, 0.08),
          target: wall,
          material: posterMat,
        });
      }
    }
    // Impact marks from the dynamic pool: one per "thump" (see update()).
    const impactMat = blobDecal(0x050505, 0.85, 0.7, 9.1);
    const impactRandom = random.fork();

    // ---- particles: GPU rain / steam / splashes, CPU rain as the compat fallback ----
    const spawned: Entity[] = [];
    let rainEid: Entity | null = null;
    let cpuRain: RainField | null = null;
    const splashMaterial = mat(new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    splashMaterial.colorNode = color(new THREE.Color(0.55, 0.62, 0.8));
    const splashGeometry = geo(new THREE.RingGeometry(0.72, 1, 14).rotateX(-Math.PI / 2));
    if (vfx.available) {
      const emitter = (x: number, y: number, z: number, preset: Parameters<typeof vfx.spawnEmitter>[1], overrides?: Parameters<typeof vfx.spawnEmitter>[2]): Entity => {
        const eid = entities.create([Transform, { x, y, z }]);
        spawned.push(eid);
        const handle = vfx.spawnEmitter(eid, preset, overrides);
        if (handle) scene.add(handle.object);
        return eid;
      };
      const rainCapacity = Math.max(2000, Math.round(RAIN_CAPACITY * quality.particleDensity));
      rainEid = emitter(rig.target.x, 10, rig.target.z, 'rain', {
        capacity: rainCapacity,
        wrap: { size: RAIN_VOLUME },
        shape: { kind: 'box', size: RAIN_VOLUME },
        direction: [0.06, -1, 0.02],
        speed: [13, 19],
        size: [0.015, 0.024],
        // A render override replaces the preset block (merged over the sprite defaults), so restate the streak look.
        render: { ...PARTICLE_PRESETS.rain.render, nearFade: RAIN_NEAR_FADE },
        colorOverLife: [
          [0, 0.7, 0.78, 1.0, 0.24],
          [1, 0.7, 0.78, 1.0, 0.24],
        ],
      });
      const steamCapacity = Math.max(48, Math.round(200 * quality.particleDensity));
      emitter(-ALLEY_HALF_WIDTH + 0.3, 0.9, -7.5, 'steam', { capacity: steamCapacity, direction: [0.55, 0.8, 0.1], wind: [0.45, 1.0, 0.05] });
      emitter(ALLEY_HALF_WIDTH - 0.3, 0.55, -16, 'steam', { capacity: steamCapacity, direction: [-0.5, 0.8, 0.2], wind: [-0.35, 1.0, 0.1] });
      const splashCapacity = Math.max(100, Math.round(600 * quality.particleDensity));
      emitter(0, 0.02, -9, splashRingDescriptor(splashGeometry, splashMaterial, splashCapacity, Math.round(800 * quality.particleDensity)));
    } else {
      logger.info('alley: GPU particles unavailable on this backend, using the CPU rain field');
      cpuRain = createRain(Math.max(50, Math.round(2600 * quality.particleDensity)), random.fork());
      geometries.push(cpuRain.geometry);
      materials.push(cpuRain.material);
      scene.add(cpuRain.mesh);
    }

    // ---- hero: the skinned mannequin, rain-wet ----------------------------------------
    // One entity: Transform (moved by root motion), RenderSync (object follows it),
    // Animator (idle/walk/run blend + additive attack). Real time: WASD relative to
    // the camera, Shift walks, Space attacks. Until the first key press (and always
    // on the capture clock) a seeded autopilot walks an idle/walk loop inside the
    // key light's pool, so goldens show a mid-stride hero and stay deterministic.
    const renderSync = new RenderSync(entities);
    bag.add(entities.addSystem(renderSync));
    const mannequin = await assets.loadModel(MANNEQUIN_URL);
    bag.add(() => assets.release(MANNEQUIN_URL));
    const heroObject = mannequin.instantiate({ castShadow: true, receiveShadow: true, name: 'Hero' });
    heroObject.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      const height = box ? Math.max(1e-3, box.max.y - box.min.y) : 1.8;
      mesh.material = wetSkin(mesh.material as THREE.MeshStandardMaterial, height);
    });
    scene.add(heroObject);
    let heroYaw = HERO_APPROACH_YAW;
    const heroEid = entities.create([Transform, { x: HERO_START.x, y: 0, z: HERO_START.z, qy: Math.sin(heroYaw / 2), qw: Math.cos(heroYaw / 2) }]);
    spawned.push(heroEid);
    renderSync.attach(entities, heroEid, heroObject);
    animation.attach(heroEid, heroObject, mannequin.animations, HERO_GRAPH, { rootMotion: { mode: 'transform' } });
    // Start mid-stride so the first frames (and the 30-frame golden) are a walk, not a blend-in.
    let heroSpeed = HERO_WALK;
    animation.setParam(heroEid, 'speed', heroSpeed);
    animation.advance(heroEid, 0.45);
    logger.info(`hero: mannequin ${mannequin.info.triangles} tris, ${mannequin.clips.length} clips, root motion on`);

    // Seeded autopilot: approach the camera at three-quarter, pause and turn, walk back the same line.
    const walkLeg = random.range(2.8, 3.3);
    const legs: AutopilotLeg[] = [
      { duration: walkLeg, walk: true, yaw: HERO_APPROACH_YAW },
      { duration: random.range(1.3, 1.8), walk: false, yaw: HERO_APPROACH_YAW },
      { duration: walkLeg, walk: true, yaw: HERO_APPROACH_YAW + Math.PI },
      { duration: random.range(1.3, 1.8), walk: false, yaw: HERO_APPROACH_YAW + Math.PI },
    ];
    const loopDuration = legs.reduce((sum, leg) => sum + leg.duration, 0);
    const autopilotPose = (t: number): { walk: boolean; yaw: number } => {
      let local = t % loopDuration;
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i] as AutopilotLeg;
        if (local < leg.duration) {
          if (leg.walk) return { walk: true, yaw: leg.yaw };
          const next = legs[(i + 1) % legs.length] as AutopilotLeg;
          const k = clamp((local - (leg.duration - HERO_TURN_TIME)) / HERO_TURN_TIME, 0, 1);
          const smooth = k * k * (3 - 2 * k);
          return { walk: false, yaw: leg.yaw + wrapAngle(next.yaw - leg.yaw) * smooth };
        }
        local -= leg.duration;
      }
      return { walk: false, yaw: heroYaw };
    };
    let autopilot = true;
    let heroTime = 0;
    const forward = new THREE.Vector3();
    const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

    let elapsed = 0;
    let nextThump = 4;
    const transforms = entities.store(Transform);
    const readHeroPose = (): void => {
      heroPose.set(transforms.x[heroEid] ?? 0, 0, transforms.z[heroEid] ?? 0);
    };

    return {
      scene,
      camera: rig.camera,
      fixedUpdate(fixedDt): void {
        cpuRain?.step(fixedDt);
        // Hero heading + speed parameter; the animation root motion moves the entity after this hook.
        heroTime += fixedDt;
        let targetSpeed = 0;
        if (autopilot) {
          const pose = autopilotPose(heroTime);
          heroYaw = pose.yaw;
          targetSpeed = pose.walk ? HERO_WALK : 0;
        } else {
          rig.camera.getWorldDirection(forward);
          forward.y = 0;
          forward.normalize();
          const strafe = clamp(input.axis('KeyA', 'KeyD') + input.axis('ArrowLeft', 'ArrowRight'), -1, 1);
          const advance = clamp(input.axis('KeyS', 'KeyW') + input.axis('ArrowDown', 'ArrowUp'), -1, 1);
          const mx = forward.x * advance + -forward.z * strafe;
          const mz = forward.z * advance + forward.x * strafe;
          const len = Math.hypot(mx, mz);
          if (len > 0.01) {
            targetSpeed = input.isDown('ShiftLeft') || input.isDown('ShiftRight') ? HERO_WALK : HERO_RUN;
            heroYaw += wrapAngle(Math.atan2(mx / len, mz / len) - heroYaw) * (1 - Math.exp(-HERO_TURN_RATE * fixedDt));
          }
        }
        heroSpeed = damp(heroSpeed, targetSpeed, HERO_SPEED_RATE, fixedDt);
        if (heroSpeed < 0.02) heroSpeed = 0;
        animation.setParam(heroEid, 'speed', heroSpeed);
        transforms.qx[heroEid] = 0;
        transforms.qz[heroEid] = 0;
        transforms.qy[heroEid] = Math.sin(heroYaw / 2);
        transforms.qw[heroEid] = Math.cos(heroYaw / 2);
        // Keep the hero on the asphalt between the kerbs (root motion has no collision here).
        transforms.x[heroEid] = clamp(transforms.x[heroEid] ?? 0, -HERO_X_LIMIT, HERO_X_LIMIT);
        transforms.z[heroEid] = clamp(transforms.z[heroEid] ?? 0, HERO_Z_MIN, HERO_Z_MAX);
        readHeroPose();
        if (rainEid !== null) {
          // The rain volume follows the framing target; scene hooks run before systems, so the emitter reads this pose.
          transforms.x[rainEid] = rig.target.x;
          transforms.z[rainEid] = rig.target.z;
        }
      },
      update(dt): void {
        elapsed += dt;
        if (autopilot && MOVE_KEYS.some((code) => input.isDown(code))) autopilot = false;
        if (input.wasPressed('Space')) animation.setTrigger(heroEid, 'attack');
        readHeroPose();
        frameTarget(rig.target);
        if (elapsed >= nextThump) {
          rig.addTrauma(0.35);
          nextThump += 7;
          decals.spawn({
            position: new THREE.Vector3(impactRandom.range(-3, 3), 0, impactRandom.range(-14, 0)),
            normal: up,
            size: impactRandom.range(0.6, 1.1),
            rotation: impactRandom.range(0, Math.PI * 2),
            target: ground,
            material: impactMat,
          });
        }
        rig.update(dt);
        for (const f of flickering) {
          const n = Math.sin(elapsed * 23 + f.phase) * Math.sin(elapsed * 7.3 + f.phase * 2);
          const buzz = Math.sin(elapsed * 61 + f.phase) > 0.92 ? 0.55 : 1;
          const on = (n > -0.85 ? 1 : 0.15) * buzz;
          f.light.intensity = f.base * on;
          f.material.color.copy(f.color).multiplyScalar(5.5 * on);
        }
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

// ---- procedural materials --------------------------------------------------------
//
// Graphs that several materials share read their per-material values through
// material references (`materialColor`, `materialRoughness`) and `materialParam`
// (`userData.*`), so the whole family compiles to one program per pass. Anything
// baked in as a constant would split it (see the note in `create()`).

/** Rain sheen for lit props: glossy on upward faces and in the splash zone near the ground; base colour / roughness from the material. */
function createWetSheenGraph(): { color: THREE.Node<'vec3'>; roughness: THREE.Node<'float'> } {
  const wet = saturate(saturate(normalWorld.y).mul(0.8).add(smoothstep(1.3, 0.0, positionWorld.y).mul(0.35)));
  const base = vec3(materialColor);
  return {
    roughness: mix(materialRoughness, float(0.13), wet) as unknown as THREE.Node<'float'>,
    color: mix(base, base.mul(0.6), wet.mul(0.7)) as unknown as THREE.Node<'vec3'>,
  };
}

/** The hero's wet skin (see `wetSkin` in `create()`); drip streak frequency from `userData.streakScale`. */
function createWetSkinGraph(): { color: THREE.Node<'vec3'>; roughness: THREE.Node<'float'>; emissive: THREE.Node<'vec3'> } {
  const up = saturate(normalWorld.y);
  const streakScale = materialParam('streakScale', 'vec3');
  const streakNoise = mx_noise_float(positionGeometry.mul(streakScale));
  const drips = smoothstep(0.25, 0.8, streakNoise.mul(0.5).add(0.5));
  const splash = smoothstep(0.5, 0.0, positionWorld.y);
  const wet = saturate(up.mul(0.7).add(drips.mul(0.5)).add(splash.mul(0.45)));
  const base = vec3(materialColor);
  const rim = saturate(normalView.z).oneMinus().pow(3.0);
  return {
    color: mix(base, base.mul(0.5), wet.mul(0.8)) as unknown as THREE.Node<'vec3'>,
    roughness: mix(materialRoughness, float(0.1), wet) as unknown as THREE.Node<'float'>,
    emissive: color(0x4a5f9e).mul(rim).mul(0.3) as unknown as THREE.Node<'vec3'>,
  };
}

/**
 * Brick facade. Bricks tile along world Z (the alley axis) and Y with a
 * half-brick offset per course; mortar lines are recessed through a
 * world-space normal tilt; per-brick hash tint; grime and vertical streaks;
 * wet and darker toward the ground.
 */
function createBrickMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const brickW = 0.46;
  const brickH = 0.155;
  const mortarW = 0.02;
  const u = positionWorld.z;
  const v = positionWorld.y;
  const row = floor(v.div(brickH));
  const offset = fract(row.mul(0.5)).mul(brickW);
  const u2 = u.add(offset).add(200.0);
  const col = floor(u2.div(brickW));
  const fu = fract(u2.div(brickW)).mul(brickW);
  const fv = fract(v.div(brickH)).mul(brickH);
  const edgeU = min(fu, float(brickW).sub(fu));
  const edgeV = min(fv, float(brickH).sub(fv));
  const edge = min(edgeU, edgeV);
  const mortar = smoothstep(mortarW * 0.6, mortarW * 1.6, edge).oneMinus();
  const brickId = hash(col.add(row.mul(131.0)).add(7.0));
  const brickId2 = hash(col.add(row.mul(131.0)).add(91.0));
  const grime = mx_fractal_noise_float(positionWorld.mul(0.35), 3, 2.0, 0.5, 0.5).add(0.5);
  const streaks = mx_fractal_noise_float(vec3(positionWorld.x.mul(1.6), positionWorld.y.mul(0.12), positionWorld.z.mul(1.6)), 2, 2.0, 0.5, 0.5).add(0.5);
  const wet = smoothstep(3.5, 0.0, positionWorld.y);
  const brickTint = mix(color(0x4a3a36), color(0x5e4a44), brickId).mul(brickId2.mul(0.35).add(0.8));
  const surface = mix(brickTint, color(0x3b3a3f), smoothstep(0.35, 0.8, grime).mul(0.55)).mul(mix(float(0.7), float(1.05), streaks));
  const base = mix(surface, color(0x2a2a2c), mortar);
  m.colorNode = mix(base, base.mul(0.6), wet);
  const speckle = mx_noise_float(positionWorld.mul(9.0)).mul(0.08);
  const dryRough = mix(float(0.74).add(speckle), float(0.93), mortar);
  // Damp, not mirror-wet: the walls stay above the SSR gloss threshold so the puddles carry the reflections.
  m.roughnessNode = mix(dryRough, float(0.5), wet.mul(0.85));
  m.metalnessNode = float(0.0);
  // Mortar recess: tilt the normal toward the brick centre at each edge (walls face ±X, so the tangent plane is YZ).
  // Kept gentle: a strong recess sparkles under the neon point lights at grazing angles (a moiré of highlights).
  const tiltZ = fu.sub(brickW * 0.5).sign().mul(smoothstep(mortarW * 1.8, mortarW * 0.4, edgeU));
  const tiltY = fv.sub(brickH * 0.5).sign().mul(smoothstep(mortarW * 1.8, mortarW * 0.4, edgeV));
  const bumps = mx_noise_float(positionWorld.mul(14.0)).mul(0.06);
  const perturbed = normalWorld.add(vec3(0.0, tiltY.mul(-0.28).add(bumps), tiltZ.mul(-0.28).add(bumps))).normalize();
  m.normalNode = transformNormalToView(perturbed);
  return m;
}

/** Wet asphalt: grime variation, hairline cracks, a two-scale puddle mask with animated ripples, glossy everywhere (it is raining). */
function createAsphaltMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const worldXZ = positionWorld.xz;
  const puddleNoise = mx_fractal_noise_float(vec3(worldXZ.mul(0.22), 3.7), 3, 2.1, 0.55, 0.5).add(0.5);
  const puddleDetail = mx_noise_float(vec3(worldXZ.mul(1.1), 8.2)).mul(0.08);
  const puddle = smoothstep(0.47, 0.58, puddleNoise.add(puddleDetail));
  const grime = mx_fractal_noise_float(vec3(worldXZ.mul(0.9), 11.0), 2, 2.0, 0.5, 0.5).add(0.5);
  const cracks = smoothstep(0.045, 0.0, abs(mx_noise_float(vec3(worldXZ.mul(0.55), 21.0)))).mul(smoothstep(0.3, 0.6, grime));
  const speckle = mx_noise_float(vec3(worldXZ.mul(18.0), 2.0)).mul(0.5).add(0.5);
  const asphalt = mix(color(0x1c1f24), color(0x2a2d33), grime).mul(speckle.mul(0.3).add(0.85));
  const cracked = mix(asphalt, color(0x0b0c0f), cracks.mul(0.8));
  m.colorNode = mix(cracked, cracked.mul(0.35), puddle);
  const wetRough = mix(float(0.5), float(0.36), grime).add(cracks.mul(0.3)).sub(speckle.mul(0.05));
  m.roughnessNode = mix(wetRough, float(0.03), puddle);
  m.metalnessNode = float(0.0);
  // Rain ripples: two crossed animated waves, warped by noise so they do not read as a grid; confined to puddles.
  const warp = mx_noise_float(vec3(worldXZ.mul(0.8), 5.0)).mul(2.5);
  const ripple = sin(worldXZ.x.mul(29.0).add(warp).add(time.mul(6.5)))
    .mul(sin(worldXZ.y.mul(25.0).sub(warp).sub(time.mul(5.1))))
    .add(sin(worldXZ.x.add(worldXZ.y).mul(17.0).add(time.mul(3.7))).mul(0.5));
  const rippleN = vec3(ripple.mul(0.03), 1.0, ripple.mul(0.025)).normalize();
  const crackN = vec3(cracks.mul(0.15), 1.0, cracks.mul(-0.1)).normalize();
  m.normalNode = transformNormalToView(mix(crackN, rippleN, puddle));
  return m;
}

/** Concrete kerb: light grey with aggregate speckle, chipped edges, damp at the base. */
function createConcreteMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const speckle = mx_noise_float(positionWorld.mul(22.0)).mul(0.5).add(0.5);
  const stain = mx_fractal_noise_float(positionWorld.mul(1.3), 2, 2.0, 0.5, 0.5).add(0.5);
  const base = mix(color(0x5c5d5a), color(0x6e6f6a), speckle).mul(mix(float(0.75), float(1.0), stain));
  const damp = smoothstep(0.12, 0.0, positionWorld.y);
  m.colorNode = mix(base, base.mul(0.55), damp.mul(0.8));
  m.roughnessNode = mix(float(0.86).sub(speckle.mul(0.1)), float(0.3), damp);
  m.metalnessNode = float(0.0);
  return m;
}

/** Lit window interior: the instance colour, dimmer toward the sill, seen through half-closed blinds and a mullion. */
function windowInterior(): THREE.Node<'vec3'> {
  const u = uv();
  const glow = mix(float(1.35), float(0.55), u.y.oneMinus().pow(1.6));
  const slats = smoothstep(0.35, 0.5, fract(u.y.mul(6.0))).mul(0.4).add(0.6);
  const mullion = smoothstep(0.47, 0.485, u.x).mul(smoothstep(0.53, 0.515, u.x)).oneMinus();
  // The per-instance colour is multiplied in by the material itself (InstancedMesh.instanceColor).
  return vec3(materialColor).mul(glow.mul(slats).mul(mullion));
}

/** Soft blob mask for a decal quad: radial falloff eaten by noise so the edge is ragged. `userData.edge` / `userData.seed` per material. */
function decalBlobMask(): THREE.Node<'float'> {
  const centred = uv().sub(0.5).mul(2.0);
  const radial = length(centred);
  const n = mx_fractal_noise_float(vec3(uv().mul(4.0), materialParam('seed', 'float')), 3, 2.0, 0.5, 0.5).mul(0.5);
  return smoothstep(1.0, materialParam('edge', 'float'), radial.add(n)).mul(materialOpacity);
}

/** Vertical damp streaks rising from the bottom edge of the decal. */
function decalStreakMask(): THREE.Node<'float'> {
  const u = uv();
  const columns = mx_noise_float(vec3(u.x.mul(9.0), 0.3, 1.0)).mul(0.5).add(0.5);
  const rise = smoothstep(0.95, 0.05, u.y.add(columns.mul(0.5)));
  const sideFade = smoothstep(0.0, 0.15, u.x).mul(smoothstep(1.0, 0.85, u.x));
  return rise.mul(sideFade).mul(0.8).mul(materialOpacity);
}

/** Torn-paper mask: the rectangle minus a noisy bite along the edges (`userData.seed`). */
function decalTornMask(): THREE.Node<'float'> {
  const u = uv();
  const edgeDist = min(min(u.x, u.x.oneMinus()), min(u.y, u.y.oneMinus()));
  const bite = mx_fractal_noise_float(vec3(u.mul(6.0), materialParam('seed', 'float')), 2, 2.0, 0.5, 0.5).mul(0.14);
  return smoothstep(0.0, 0.06, edgeDist.sub(bite).add(0.03)).mul(materialOpacity);
}

/** Poster artwork: paper (material colour) with a band of `userData.accent` stripes (`userData.stripes` of them) and a fake headline block. */
function posterColor(): THREE.Node<'vec3'> {
  const u = uv();
  const band = smoothstep(0.55, 0.57, u.y).mul(smoothstep(0.92, 0.9, u.y));
  const stripe = fract(u.x.mul(materialParam('stripes', 'float'))).greaterThan(0.5).select(float(1.0), float(0.0));
  const headline = smoothstep(0.18, 0.2, u.y).mul(smoothstep(0.32, 0.3, u.y)).mul(smoothstep(0.1, 0.12, u.x)).mul(smoothstep(0.9, 0.88, u.x));
  const wear = mx_noise_float(vec3(u.mul(7.0), 3.0)).mul(0.5).add(0.5);
  const accent = materialParam('accent', 'color');
  const art = mix(vec3(materialColor), accent, max(band.mul(stripe), headline));
  return mix(art, art.mul(0.55), wear.mul(0.5)).mul(0.9);
}

// ---- helpers ------------------------------------------------------------------

interface RainField {
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  step(dt: number): void;
}

/** The v1 CPU rain: one instanced draw stepped on the fixed clock. Kept as the WebGL2 (no compute) fallback. */
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
