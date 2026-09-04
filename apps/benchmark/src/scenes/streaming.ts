import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  CullingSystem,
  DisposeBag,
  InstancedRenderSync,
  LevelLoader,
  LODSystem,
  PhysicsDebugRenderer,
  Random,
  RenderSync,
  SpatialIndex,
  StreamingManager,
  Transform,
  type ChunkPlacement,
  type ChunkSource,
  type LoadedLevel,
  type ModelAsset,
  type SceneDefinition,
  type SceneInstance,
  type StreamedAssetDefinition,
} from '@spark/engine';

// ---- district layout -----------------------------------------------------------

const CHUNK = 24;
const HALF_GRID = 20; // chunks -20..19 on each axis → 960 m square
const WORLD_MIN = -HALF_GRID * CHUNK;
const WORLD_MAX = HALF_GRID * CHUNK;
const BLOCK_INSET = 2; // street half-width: block slabs are CHUNK - 2·inset wide
const FLOOR_HEIGHT = 3.2;
const CRATE_URL = '/models/crate.glb';
const PIPES_URL = '/models/prop-pipe.glb';
const HERO_URL = '/models/hero-placeholder.glb';

/**
 * Expected placements per chunk per asset (generator averages with headroom),
 * used to size batches per LOD ring. Batch capacity is what the TRAA velocity
 * path copies every frame, so these are deliberately not worst-case; an
 * over-full batch only hides the surplus (LODSystem `overflow`), never throws.
 */
const PER_CHUNK = { blockVariant: 19, band: 46, ledge: 46, roof: 8, slab: 1, crate: 24, pipe: 3 };
const MAX_BUILDINGS = 9;
const MAX_FLOORS = 12;

// Flight
const FLIGHT_HEIGHT = 64;
const FLIGHT_SPEED = 24;
const FLIGHT_PITCH = THREE.MathUtils.degToRad(24);
const TURN_RATE = 1.1;

/** Entity capacity the benchmark app gives this scene (see registry ENGINE_HINTS). */
export const STREAMING_ENTITY_CAPACITY = 100_000;

/** Mix the district seed with chunk coordinates into a per-chunk RNG seed. */
function chunkSeed(seed: number, cx: number, cz: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ Math.imul(cx + 0x7fff, 0x85ebca6b), 0xc2b2ae35) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h ^ Math.imul(cz + 0x7fff, 0x27d4eb2f), 0x165667b1) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

function yawQuat(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

/**
 * Deterministic chunk content: a block slab, 1–6 buildings made of stacked
 * storey blocks (each storey a box + an emissive window band) with a rooftop
 * unit, and crates / pipe clusters along the streets. Chunk (0, 0) is the
 * plaza where the hero level sits. Same seed + same (cx, cz) = same chunk.
 */
function makeChunkSource(seed: number): ChunkSource {
  return {
    chunkAt(cx, cz) {
      const rng = new Random(chunkSeed(seed, cx, cz));
      const placements: ChunkPlacement[] = [];
      const ox = cx * CHUNK;
      const oz = cz * CHUNK;
      const cxw = ox + CHUNK / 2;
      const czw = oz + CHUNK / 2;
      placements.push({ asset: 'procedural:slab', position: [cxw, 0, czw], scale: [CHUNK - BLOCK_INSET * 2, 0.18, CHUNK - BLOCK_INSET * 2] });
      const plaza = cx === 0 && cz === 0;

      if (!plaza) {
        // Buildings on a 2×2 or 3×3 footprint grid inside the block.
        const grid = rng.bool(0.3) ? 2 : 3;
        const cell = (CHUNK - BLOCK_INSET * 2) / grid;
        const variants = ['procedural:block_a', 'procedural:block_b', 'procedural:block_c'];
        const tall = rng.bool(0.35); // downtown-ish chunk
        let buildings = 0;
        for (let gz = 0; gz < grid && buildings < MAX_BUILDINGS; gz++) {
          for (let gx = 0; gx < grid && buildings < MAX_BUILDINGS; gx++) {
            if (rng.bool(0.1)) continue; // empty lot
            buildings++;
            const w = cell * rng.range(0.6, 0.86);
            const d = cell * rng.range(0.6, 0.86);
            const bx = ox + BLOCK_INSET + (gx + 0.5) * cell + rng.range(-0.4, 0.4);
            const bz = oz + BLOCK_INSET + (gz + 0.5) * cell + rng.range(-0.4, 0.4);
            const floors = Math.min(MAX_FLOORS, tall ? rng.int(7, 12) : rng.int(3, 8));
            const variant = rng.pick(variants);
            const yaw = rng.bool(0.3) ? rng.range(-0.08, 0.08) : 0;
            const rotation = yawQuat(yaw);
            for (let f = 0; f < floors; f++) {
              const inset = f === 0 ? 1.04 : 1 - (f % 2) * 0.03;
              placements.push({
                asset: variant,
                position: [bx, f * FLOOR_HEIGHT, bz],
                rotation,
                scale: [w * inset, FLOOR_HEIGHT, d * inset],
              });
              if (f > 0) {
                // Window band: a thin emissive strip wrapped around the storey,
                // and a ledge slab between storeys.
                placements.push({
                  asset: 'procedural:band',
                  position: [bx, f * FLOOR_HEIGHT + FLOOR_HEIGHT * 0.5, bz],
                  rotation,
                  scale: [w * inset + 0.05, FLOOR_HEIGHT * 0.2, d * inset + 0.05],
                });
                placements.push({
                  asset: 'procedural:ledge',
                  position: [bx, f * FLOOR_HEIGHT - 0.06, bz],
                  rotation,
                  scale: [w * inset + 0.35, 0.12, d * inset + 0.35],
                });
              }
            }
            placements.push({
              asset: 'procedural:roof',
              position: [bx + rng.range(-w * 0.2, w * 0.2), floors * FLOOR_HEIGHT, bz + rng.range(-d * 0.2, d * 0.2)],
              rotation,
              scale: [w * rng.range(0.25, 0.45), rng.range(0.8, 2.2), d * rng.range(0.25, 0.45)],
            });
          }
        }
      }

      // Street props: crates stacked along the block edge, pipe clusters at corners.
      const crates = plaza ? 40 : rng.int(6, 26);
      for (let i = 0; i < crates; i++) {
        const side = rng.int(0, 3);
        const along = plaza ? (i / crates) * (CHUNK - 4) + 2 : rng.range(1.5, CHUNK - 1.5);
        const off = plaza ? 1.4 : rng.range(0.6, 1.6);
        const px = side === 0 ? ox + along : side === 1 ? ox + CHUNK - off : side === 2 ? ox + along : ox + off;
        const pz = side === 0 ? oz + off : side === 1 ? oz + along : side === 2 ? oz + CHUNK - off : oz + along;
        const s = rng.range(0.6, 1.1);
        placements.push({ asset: CRATE_URL, position: [px, 0.5 * s + 0.18, pz], rotation: yawQuat(rng.range(0, Math.PI * 2)), scale: s });
        if (!plaza && rng.bool(0.25)) {
          const s2 = s * 0.85;
          placements.push({ asset: CRATE_URL, position: [px, s + 0.18 + 0.5 * s2, pz], rotation: yawQuat(rng.range(0, Math.PI * 2)), scale: s2 });
        }
      }
      if (!plaza) {
        const pipes = rng.int(0, 4);
        for (let i = 0; i < pipes; i++) {
          const corner = rng.int(0, 3);
          const px = ox + (corner & 1 ? CHUNK - 2.2 : 2.2) + rng.range(-0.5, 0.5);
          const pz = oz + (corner & 2 ? CHUNK - 2.2 : 2.2) + rng.range(-0.5, 0.5);
          placements.push({ asset: PIPES_URL, position: [px, 0.18, pz], rotation: yawQuat(rng.range(0, Math.PI * 2)), scale: rng.range(0.8, 1.2) });
        }
      }
      return { placements };
    },
  };
}

// ---- procedural geometry ---------------------------------------------------------

/** Unit box with its base on y = 0, so `scale.y` is the height. */
function baseBox(w = 1, h = 1, d = 1): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, h / 2, 0);
  return g;
}

/** Storey block LOD0: the box plus a cornice lip and two pilaster strips (one material). */
function detailedBlock(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [baseBox()];
  const lip = new THREE.BoxGeometry(1.08, 0.08, 1.08);
  lip.translate(0, 0.96, 0);
  parts.push(lip);
  for (const sx of [-0.5, 0.5]) {
    const pilaster = new THREE.BoxGeometry(0.06, 1, 1.04);
    pilaster.translate(sx, 0.5, 0);
    parts.push(pilaster);
  }
  for (const sz of [-0.5, 0.5]) {
    const pilaster = new THREE.BoxGeometry(1.04, 1, 0.06);
    pilaster.translate(0, 0.5, sz);
    parts.push(pilaster);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

/** The first mesh in a model template: geometry + material shared with the cache. */
function firstMesh(model: ModelAsset): THREE.Mesh {
  let found: THREE.Mesh | null = null;
  model.template.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
  });
  if (!found) throw new Error(`${model.url}: no mesh`);
  return found;
}

/** Every mesh of a template merged into one geometry in template space (for multi-node props). */
function mergedTemplate(model: ModelAsset): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  model.template.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  let material: THREE.Material | null = null;
  model.template.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry.clone();
    // Only keep the attributes needed for lighting so every part merges cleanly.
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    g.applyMatrix4(mesh.matrixWorld);
    parts.push(g);
    material ??= Array.isArray(mesh.material) ? (mesh.material[0] as THREE.Material) : mesh.material;
  });
  if (!material || parts.length === 0) throw new Error(`${model.url}: no meshes`);
  const geometry = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  geometry.computeBoundingSphere();
  return { geometry, material };
}

// ---- the scene -------------------------------------------------------------------------

/**
 * Milestone 9 demonstration: a 40 × 40 chunk procedural district (24 m
 * chunks) streamed around a camera on a seeded flight path. Every placement
 * is an entity in a static instanced batch; `LODSystem` swaps storey blocks,
 * crates and pipes between full / box / none levels, `CullingSystem` does
 * frustum + distance culling through the `SpatialIndex`, and
 * `StreamingManager` activates chunks under a per-frame budget. The
 * hero-placeholder level is loaded through `LevelLoader` at the origin plaza:
 * its spawn point gets a marker entity and its `COL_` capsule becomes a
 * trimesh collider (physics debug wireframe on, F3 toggles).
 *
 * WASD / arrows steer in real time (A/D turn, W/S throttle, Q/E altitude);
 * without input the autopilot flies the same seeded route every run.
 */
export const streamingScene: SceneDefinition = {
  name: 'streaming',
  async create(ctx): Promise<SceneInstance> {
    const bag = new DisposeBag();
    const { entities, random, input, logger, quality, assets, physics } = ctx;
    const fixedClock = ctx.config.fixedFrameDelta !== null;
    const scene = new THREE.Scene();
    const sky = new THREE.Color(0x101625);
    scene.background = sky;

    const drawDistance = quality.drawDistance;
    const far = Math.min(620, 460 * drawDistance);
    const camera = new THREE.PerspectiveCamera(62, ctx.renderer.aspect, 0.5, far);
    scene.fog = new THREE.Fog(sky, far * 0.4, far * 0.98);

    // Environment + lights: dusk.
    const pmrem = new THREE.PMREMGenerator(ctx.renderer.three);
    const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    scene.environmentIntensity = 0.22;
    bag.add(() => {
      envTarget.dispose();
      pmrem.dispose();
    });
    const sun = new THREE.DirectionalLight(0xffc38a, 2.4);
    sun.castShadow = quality.shadows;
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 420;
    const shadowHalf = 110;
    sun.shadow.camera.left = -shadowHalf;
    sun.shadow.camera.right = shadowHalf;
    sun.shadow.camera.top = shadowHalf;
    sun.shadow.camera.bottom = -shadowHalf;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.05;
    scene.add(sun, sun.target);
    scene.add(new THREE.HemisphereLight(0x3a4d8a, 0x120c08, 0.55));

    // Ground: one plane for the whole district (streets); blocks are per-chunk slabs.
    const groundGeo = new THREE.PlaneGeometry(WORLD_MAX - WORLD_MIN + 200, WORLD_MAX - WORLD_MIN + 200);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.95 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    bag.add(() => {
      groundGeo.dispose();
      groundMat.dispose();
    });

    // ---- systems ----
    const spatial = new SpatialIndex({ cellSize: CHUNK, minX: WORLD_MIN, minZ: WORLD_MIN, maxX: WORLD_MAX, maxZ: WORLD_MAX, capacity: entities.capacity + 1 });
    const renderSync = new RenderSync(entities);
    const instanced = new InstancedRenderSync(entities);
    const lod = new LODSystem(entities, { lodBias: quality.lodBias });
    const culling = new CullingSystem({ spatial, drawDistance });
    lod.setCamera(camera);
    culling.setCamera(camera);
    bag.add(entities.addSystem(renderSync));
    bag.add(entities.addSystem(instanced));
    bag.add(entities.addSystem(lod));
    bag.add(entities.addSystem(culling));

    // Streaming radii scale with draw distance; the unload band is one chunk wider.
    const loadRadius = Math.min(300, 230 * drawDistance);
    const unloadRadius = loadRadius + CHUNK * 1.5;
    const maxChunks = Math.ceil((Math.PI * unloadRadius * unloadRadius) / (CHUNK * CHUNK)) + 16;
    /** Chunks whose centre can sit within `radius` of the camera (the LOD ring a level serves). */
    const chunksWithin = (radius: number): number => Math.min(maxChunks, Math.ceil((Math.PI * (radius + CHUNK) * (radius + CHUNK)) / (CHUNK * CHUNK)) + 8);
    /** Capacity for a level that serves everything nearer than `radius` (Infinity = every loaded chunk). */
    const cap = (perChunk: number, radius = Infinity): number =>
      Math.min(entities.capacity, Math.ceil((Number.isFinite(radius) ? chunksWithin(radius) : maxChunks) * perChunk * 1.25));
    const districtSeed = Math.floor(random.next() * 0xffffffff) >>> 0;
    const streaming = new StreamingManager({
      entities,
      assets,
      scene,
      instanced,
      lod,
      spatial,
      source: makeChunkSource(districtSeed),
      chunkSize: CHUNK,
      minChunkX: -HALF_GRID,
      minChunkZ: -HALF_GRID,
      maxChunkX: HALF_GRID - 1,
      maxChunkZ: HALF_GRID - 1,
      loadRadius,
      unloadRadius,
      // The streamed disk sits well ahead of the camera: most loaded chunks are in view.
      lookAhead: loadRadius * 0.82,
      directionWeight: 0.6,
      // On the fixed clock (capture) the ms cap is off so activation is frame-exact.
      budget: { maxChunksPerFrame: fixedClock ? 6 : 2, maxMs: fixedClock ? Infinity : 2.5, maxUnloadsPerFrame: 2 },
    });
    bag.add(entities.addSystem(streaming));
    bag.add(streaming);

    // ---- procedural assets ----
    const ownedGeometries: THREE.BufferGeometry[] = [];
    const ownedMaterials: THREE.Material[] = [];
    const keep = <T extends THREE.BufferGeometry>(g: T): T => {
      ownedGeometries.push(g);
      return g;
    };
    const mat = (params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial(params);
      ownedMaterials.push(m);
      return m;
    };
    bag.add(() => {
      for (const g of ownedGeometries) g.dispose();
      for (const m of ownedMaterials) m.dispose();
    });
    const plainBox = keep(baseBox());
    const blockDetail = keep(detailedBlock());
    const blockMaterials = [
      mat({ color: 0x8a8378, roughness: 0.85 }),
      mat({ color: 0x5d6570, roughness: 0.7, metalness: 0.15 }),
      mat({ color: 0x9a6f57, roughness: 0.9 }),
    ];
    const blockDef = (material: THREE.Material): StreamedAssetDefinition => ({
      levels: [
        { geometry: blockDetail, material },
        { geometry: plainBox, material },
        null,
      ],
      lodDistances: [110, far * 1.5],
      radius: 0.9,
      maxDistance: 0,
      capacity: [cap(PER_CHUNK.blockVariant, 110 * quality.lodBias), cap(PER_CHUNK.blockVariant), 0],
      castShadow: true,
      receiveShadow: true,
    });
    streaming.registerProcedural('block_a', blockDef(blockMaterials[0] as THREE.Material));
    streaming.registerProcedural('block_b', blockDef(blockMaterials[1] as THREE.Material));
    streaming.registerProcedural('block_c', blockDef(blockMaterials[2] as THREE.Material));
    streaming.registerProcedural('band', {
      levels: [{ geometry: keep(new THREE.BoxGeometry(1, 1, 1)), material: mat({ color: 0x0a0d14, roughness: 0.3, metalness: 0.6, emissive: 0xffb466, emissiveIntensity: 0.85 }) }, null],
      lodDistances: [far],
      radius: 0.8,
      maxDistance: 0,
      capacity: [cap(PER_CHUNK.band), 0],
    });
    streaming.registerProcedural('ledge', {
      levels: [{ geometry: plainBox, material: mat({ color: 0x2c2e33, roughness: 0.8 }) }, null],
      lodDistances: [far],
      radius: 0.8,
      maxDistance: 0,
      capacity: [cap(PER_CHUNK.ledge), 0],
    });
    streaming.registerProcedural('roof', {
      levels: [{ geometry: plainBox, material: mat({ color: 0x3c3f46, roughness: 0.6, metalness: 0.4 }) }, null],
      lodDistances: [far],
      radius: 0.9,
      maxDistance: 0,
      capacity: [cap(PER_CHUNK.roof), 0],
      castShadow: true,
    });
    streaming.registerProcedural('slab', {
      levels: [{ geometry: plainBox, material: mat({ color: 0x33363c, roughness: 0.95 }) }],
      lodDistances: [],
      radius: 0.75,
      maxDistance: 0,
      capacity: cap(PER_CHUNK.slab),
      receiveShadow: true,
    });
    const crateBoxMat = mat({ color: 0x7a5a3a, roughness: 0.9 });
    streaming.registerModel(CRATE_URL, (model) => {
      const mesh = firstMesh(model);
      const material = Array.isArray(mesh.material) ? (mesh.material[0] as THREE.Material) : mesh.material;
      const box = new THREE.BoxGeometry(1, 1, 1);
      return {
        levels: [
          { geometry: mesh.geometry, material },
          { geometry: box, material: crateBoxMat },
          null,
        ],
        lodDistances: [45, 120],
        radius: 0.9,
        maxDistance: 140,
        capacity: [cap(PER_CHUNK.crate, 45 * quality.lodBias), cap(PER_CHUNK.crate, 120 * quality.lodBias), 0],
        castShadow: true,
        receiveShadow: true,
        dispose: () => box.dispose(),
      };
    });
    streaming.registerModel(PIPES_URL, (model) => {
      const merged = mergedTemplate(model);
      const box = new THREE.BoxGeometry(1.2, 2.5, 1.8);
      box.translate(0, 1.25, 0.15);
      return {
        levels: [
          { geometry: merged.geometry, material: merged.material },
          { geometry: box, material: merged.material },
          null,
        ],
        lodDistances: [55, 130],
        radius: 1.8,
        maxDistance: 150,
        capacity: [cap(PER_CHUNK.pipe, 55 * quality.lodBias), cap(PER_CHUNK.pipe, 130 * quality.lodBias), 0],
        castShadow: true,
        dispose: () => {
          merged.geometry.dispose();
          box.dispose();
        },
      };
    });

    // ---- the hero level through LevelLoader (ADR-008) ----
    const markerGeo = keep(new THREE.ConeGeometry(0.35, 0.9, 12));
    markerGeo.translate(0, 1.4, 0);
    const ringGeo = keep(new THREE.TorusGeometry(0.8, 0.06, 8, 32));
    ringGeo.rotateX(Math.PI / 2);
    const markerMat = mat({ color: 0x40ff9a, emissive: 0x20ff80, emissiveIntensity: 2.5, roughness: 0.4 });
    const loader = new LevelLoader({
      entities,
      assets,
      renderSync,
      scene,
      physics,
      props: { crate: CRATE_URL, 'pipe-cluster': PIPES_URL },
      teams: ['player', 'enemy'],
      castShadow: true,
      receiveShadow: true,
      spawnMarker: () => {
        const group = new THREE.Group();
        group.add(new THREE.Mesh(markerGeo, markerMat), new THREE.Mesh(ringGeo, markerMat));
        return group;
      },
    });
    let level: LoadedLevel | null = null;
    try {
      level = await loader.load(HERO_URL, { position: [CHUNK / 2, 0.18, CHUNK / 2], yaw: Math.PI * 0.85 });
      bag.add(level);
    } catch (error) {
      logger.error(`hero level failed to load: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Prove the COL_ capsule is a real collider: a ray straight down through it,
    // cast after the first physics step (new bodies enter the query pipeline on step).
    let colliderProof = level && level.colliders.length > 0 ? 'collider: pending' : 'collider: none';
    let colliderProven = level === null || level.colliders.length === 0;
    const proveCollider = (): void => {
      if (colliderProven || !level) return;
      colliderProven = true;
      const t = entities.store(Transform);
      const c = level.colliders[0] as number;
      const hit = physics.raycast({ x: t.x[c] ?? 0, y: 20, z: t.z[c] ?? 0 }, { x: 0, y: -1, z: 0 }, 40);
      colliderProof = hit && hit.eid === c ? `collider hit y=${hit.point.y.toFixed(2)}` : 'collider MISSED';
      logger.info(`level: ${level.entities.length} entities, spawn(player)=${JSON.stringify(level.spawn('player'))}, ${colliderProof}`);
    };
    const physicsDebug = new PhysicsDebugRenderer(physics);
    scene.add(physicsDebug.object);
    physicsDebug.setEnabled(true);
    bag.add(entities.addSystem(physicsDebug));

    // ---- flight path ----
    // Starts south-east of the plaza looking at it, then cruises the district on a
    // seeded meander. Advanced in fixedUpdate so the fixed clock makes it exact.
    const pos = new THREE.Vector3(CHUNK / 2 - 30, FLIGHT_HEIGHT, CHUNK / 2 + 150);
    let heading = -Math.PI / 2 + 0.2; // dir = (cos, 0, sin): -π/2 flies toward -Z
    const meanderPhase = random.range(0, Math.PI * 2);
    const meanderPhase2 = random.range(0, Math.PI * 2);
    let time = 0;
    let manualUntil = -1;
    const dir = new THREE.Vector3();
    const look = new THREE.Vector3();
    const sunOffset = new THREE.Vector3(-90, 160, 60);
    const updateCamera = (): void => {
      dir.set(Math.cos(heading), 0, Math.sin(heading));
      camera.position.copy(pos);
      look.copy(pos).addScaledVector(dir, Math.cos(FLIGHT_PITCH) * 60);
      look.y -= Math.sin(FLIGHT_PITCH) * 60;
      camera.lookAt(look);
      // Shadow frustum follows the ground point ahead of the camera.
      look.copy(pos).addScaledVector(dir, 70);
      look.y = 0;
      sun.target.position.copy(look);
      sun.position.copy(look).add(sunOffset);
    };
    updateCamera();
    streaming.setTarget(pos.x, pos.z, Math.cos(heading), Math.sin(heading));

    // ---- DOM line ----
    const line = document.createElement('div');
    line.setAttribute('data-spark-streaming', '');
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
    // Human-facing only: hidden with `overlay=0` so goldens do not carry wall-clock numbers.
    if (!ctx.config.debugOverlay) line.style.display = 'none';
    ctx.config.container.appendChild(line);
    bag.add(() => line.remove());
    let lastLine = 0;
    const refreshLine = (): void => {
      const levelSummary = level ? `level: ${level.entities.length} ents, spawns ${level.spawnPoints.length}, props ${level.props.length}, colliders ${level.colliders.length}, ${colliderProof}` : 'level: failed';
      const s = streaming.stats();
      const c = culling.stats();
      const l = lod.stats();
      const draws = ctx.renderer.stats().drawCalls;
      line.textContent =
        `chunks ${s.active} loaded / ${s.queued} queued / ${s.loading} loading · entities ${s.entities} · visible ${c.visible}/${c.candidates} · instances ${s.visibleInstances}/${s.instances} · draws ${draws}\n` +
        `lod L0 ${l.perLevel[0] ?? 0} L1 ${l.perLevel[1] ?? 0} L2 ${l.perLevel[2] ?? 0} (switches ${l.switches}, overflow ${l.overflow}) · stream ${s.lastFrameMs.toFixed(2)} ms (max ${s.maxFrameMs.toFixed(2)}) · cam ${pos.x.toFixed(0)},${pos.z.toFixed(0)} · ${levelSummary}`;
    };
    // Expose the numbers for probes: window.__spark.engine is the engine, this is the scene.
    (window as unknown as { __streaming?: unknown }).__streaming = {
      stats: () => ({ streaming: streaming.stats(), culling: culling.stats(), lod: lod.stats(), spatial: spatial.stats() }),
    };
    bag.add(() => {
      delete (window as unknown as { __streaming?: unknown }).__streaming;
    });

    logger.info(
      `district ${HALF_GRID * 2}×${HALF_GRID * 2} chunks of ${CHUNK} m, load radius ${loadRadius.toFixed(0)} m (≈${maxChunks} chunks max), entity capacity ${entities.capacity}, far ${far.toFixed(0)} m`,
    );

    return {
      scene,
      camera,
      fixedUpdate(dt): void {
        time += dt;
        if (!colliderProven && physics.steps > 0) proveCollider();
        // Manual override: A/D turn, W/S throttle, Q/E altitude, arrows likewise.
        const turn = Math.max(-1, Math.min(1, input.axis('KeyA', 'KeyD') + input.axis('ArrowLeft', 'ArrowRight')));
        const throttle = Math.max(-1, Math.min(1, input.axis('KeyS', 'KeyW') + input.axis('ArrowDown', 'ArrowUp')));
        const climb = input.axis('KeyQ', 'KeyE');
        const manual = turn !== 0 || throttle !== 0 || climb !== 0;
        if (manual) manualUntil = time + 1.5;
        let speed = FLIGHT_SPEED;
        if (manual) {
          heading += turn * TURN_RATE * dt;
          speed = FLIGHT_SPEED * (1 + throttle * 0.9);
          pos.y = THREE.MathUtils.clamp(pos.y + climb * 18 * dt, 8, 160);
        } else if (time > manualUntil) {
          // Seeded meander, steering back toward the centre near the edge.
          const wander = 0.22 * Math.sin(time * 0.11 + meanderPhase) + 0.12 * Math.sin(time * 0.037 + meanderPhase2);
          let target = heading + wander * dt;
          const edge = Math.max(Math.abs(pos.x), Math.abs(pos.z));
          if (edge > WORLD_MAX - 140) {
            const toCentre = Math.atan2(-pos.z, -pos.x);
            let delta = toCentre - target;
            delta = Math.atan2(Math.sin(delta), Math.cos(delta));
            target += delta * Math.min(1, (edge - (WORLD_MAX - 140)) / 80) * 1.5 * dt;
          }
          heading = target;
          pos.y = THREE.MathUtils.damp(pos.y, FLIGHT_HEIGHT, 0.8, dt);
        }
        pos.x += Math.cos(heading) * speed * dt;
        pos.z += Math.sin(heading) * speed * dt;
        pos.x = THREE.MathUtils.clamp(pos.x, WORLD_MIN + 20, WORLD_MAX - 20);
        pos.z = THREE.MathUtils.clamp(pos.z, WORLD_MIN + 20, WORLD_MAX - 20);
        streaming.setTarget(pos.x, pos.z, Math.cos(heading), Math.sin(heading));
        if (input.wasPressed('F3')) logger.info(`physics debug ${physicsDebug.toggle() ? 'on' : 'off'}`);
      },
      update(): void {
        updateCamera();
        const now = performance.now();
        if (now - lastLine > 250) {
          lastLine = now;
          refreshLine();
        }
      },
      resize(width, height): void {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      },
      dispose(): void {
        bag.dispose(); // streaming (entities, batches, asset refs), level, systems, DOM line
        scene.clear();
      },
    };
  },
};
