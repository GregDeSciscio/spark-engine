import * as THREE from 'three/webgpu';
import {
  abs,
  color,
  float,
  floor,
  fract,
  hash,
  materialColor,
  materialRoughness,
  max,
  min,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalWorld,
  positionWorld,
  saturate,
  sin,
  smoothstep,
  time,
  transformNormalToView,
  vec2,
  vec3,
} from 'three/tsl';

/**
 * The surface library: procedural, world-space PBR node materials for the
 * rainy-city look, promoted from the benchmark alley so levels get them by
 * name (docs/architecture/lessons-from-the-showcase.md). World-space means
 * no UVs are needed and scaled unit cubes (the level pipeline's building
 * block) tile correctly. Every surface reads as wet: it is always raining.
 *
 * Assignment is by name: a glTF material called `brick` (or `brick.anything`,
 * since Blender needs unique names) becomes the brick surface when
 * `SurfaceLibrary.applyTo` runs over a loaded level, and a `spark.surface`
 * extra on an object overrides the material name. One material instance per
 * surface (and tint) is shared across every mesh that uses it, so the swap
 * never adds draw-call variety or shader variants.
 */
export type SurfaceName = 'asphalt' | 'brick' | 'concrete' | 'metal' | 'skyline' | 'window';

export const SURFACE_NAMES: readonly SurfaceName[] = ['asphalt', 'brick', 'concrete', 'metal', 'skyline', 'window'];

/** Window grid spacing the level dressing uses, so the lit/dark choice per pane lines up with the geometry. */
export const WINDOW_GRID = { u: 2.4, v: 3.2 } as const;

export function isSurfaceName(value: string): value is SurfaceName {
  return (SURFACE_NAMES as readonly string[]).includes(value);
}

export interface SurfaceOptions {
  /** Base colour for the tinted surfaces (`metal`): the material colour the wet sheen darkens. */
  readonly color?: THREE.ColorRepresentation | undefined;
  /** Dry roughness for `metal`. Default 0.55. */
  readonly roughness?: number | undefined;
  readonly metalness?: number | undefined;
}

type Vec3Node = THREE.Node<'vec3'>;
type FloatNode = THREE.Node<'float'>;

/** Wet sheen for any lit surface: glossy and darker on upward faces and in the splash zone near the ground. */
export function wetSheenGraph(): { color: Vec3Node; roughness: FloatNode } {
  const wet = saturate(saturate(normalWorld.y).mul(0.8).add(smoothstep(1.3, 0.0, positionWorld.y).mul(0.35)));
  const base = vec3(materialColor);
  return {
    roughness: mix(materialRoughness, float(0.13), wet) as unknown as FloatNode,
    color: mix(base, base.mul(0.6), wet.mul(0.7)) as unknown as Vec3Node,
  };
}

/** Wet asphalt: grime variation, hairline cracks, a two-scale puddle mask with animated ripples, glossy everywhere. */
function asphalt(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'surface:asphalt';
  const worldXZ = positionWorld.xz;
  const puddleNoise = mx_fractal_noise_float(vec3(worldXZ.mul(0.22), 3.7), 3, 2.1, 0.55, 0.5).add(0.5);
  const puddleDetail = mx_noise_float(vec3(worldXZ.mul(1.1), 8.2)).mul(0.08);
  const puddle = smoothstep(0.47, 0.58, puddleNoise.add(puddleDetail));
  const grime = mx_fractal_noise_float(vec3(worldXZ.mul(0.9), 11.0), 2, 2.0, 0.5, 0.5).add(0.5);
  const cracks = smoothstep(0.045, 0.0, abs(mx_noise_float(vec3(worldXZ.mul(0.55), 21.0)))).mul(smoothstep(0.3, 0.6, grime));
  const speckle = mx_noise_float(vec3(worldXZ.mul(18.0), 2.0)).mul(0.5).add(0.5);
  const base = mix(color(0x1c1f24), color(0x2a2d33), grime).mul(speckle.mul(0.3).add(0.85));
  const cracked = mix(base, color(0x0b0c0f), cracks.mul(0.8));
  m.colorNode = mix(cracked, cracked.mul(0.35), puddle);
  const wetRough = mix(float(0.5), float(0.36), grime).add(cracks.mul(0.3)).sub(speckle.mul(0.05));
  m.roughnessNode = mix(wetRough, float(0.03), puddle);
  m.metalnessNode = float(0.0);
  // Rain ripples: two crossed animated waves warped by noise so they do not read as a grid, confined to puddles.
  const warp = mx_noise_float(vec3(worldXZ.mul(0.8), 5.0)).mul(2.5);
  const ripple = sin(worldXZ.x.mul(29.0).add(warp).add(time.mul(6.5)))
    .mul(sin(worldXZ.y.mul(25.0).sub(warp).sub(time.mul(5.1))))
    .add(sin(worldXZ.x.add(worldXZ.y).mul(17.0).add(time.mul(3.7))).mul(0.5));
  const rippleN = vec3(ripple.mul(0.03), 1.0, ripple.mul(0.025)).normalize();
  const crackN = vec3(cracks.mul(0.15), 1.0, cracks.mul(-0.1)).normalize();
  m.normalNode = transformNormalToView(mix(crackN, rippleN, puddle));
  return m;
}

/**
 * Brick: courses along the wall's horizontal axis (picked per face from the
 * world normal, so ±X and ±Z walls both tile), half-brick offset per course,
 * mortar recessed through a normal tilt, per-brick tint, grime and streaks,
 * wet toward the ground.
 */
function brick(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'surface:brick';
  const brickW = 0.46;
  const brickH = 0.155;
  const mortarW = 0.02;
  const facingX = abs(normalWorld.x).greaterThan(0.5);
  const u = facingX.select(positionWorld.z, positionWorld.x);
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
  // Damp, not mirror-wet: walls stay above the SSR gloss threshold so the puddles carry the reflections.
  m.roughnessNode = mix(dryRough, float(0.5), wet.mul(0.85));
  m.metalnessNode = float(0.0);
  const tiltU = fu.sub(brickW * 0.5).sign().mul(smoothstep(mortarW * 1.8, mortarW * 0.4, edgeU));
  const tiltY = fv.sub(brickH * 0.5).sign().mul(smoothstep(mortarW * 1.8, mortarW * 0.4, edgeV));
  const bumps = mx_noise_float(positionWorld.mul(14.0)).mul(0.06);
  const tilt = facingX.select(vec3(0.0, tiltY.mul(-0.28).add(bumps), tiltU.mul(-0.28).add(bumps)), vec3(tiltU.mul(-0.28).add(bumps), tiltY.mul(-0.28).add(bumps), 0.0));
  m.normalNode = transformNormalToView(normalWorld.add(tilt).normalize());
  return m;
}

/** Concrete: light grey with aggregate speckle and stains, damp at the base. */
function concrete(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'surface:concrete';
  const speckle = mx_noise_float(positionWorld.mul(22.0)).mul(0.5).add(0.5);
  const stain = mx_fractal_noise_float(positionWorld.mul(1.3), 2, 2.0, 0.5, 0.5).add(0.5);
  const base = mix(color(0x5c5d5a), color(0x6e6f6a), speckle).mul(mix(float(0.75), float(1.0), stain));
  const damp = smoothstep(0.12, 0.0, positionWorld.y);
  const upWet = saturate(normalWorld.y).mul(0.5);
  m.colorNode = mix(base, base.mul(0.55), max(damp.mul(0.8), upWet));
  m.roughnessNode = mix(float(0.86).sub(speckle.mul(0.1)), float(0.3), max(damp, upWet));
  m.metalnessNode = float(0.0);
  return m;
}

/** Painted metal (crates, barriers, pipes): the material colour under a rain sheen. */
function metal(options: SurfaceOptions): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'surface:metal';
  m.color.set(options.color ?? 0x3a3f4a);
  m.roughness = options.roughness ?? 0.55;
  m.metalness = options.metalness ?? 0.35;
  const sheen = wetSheenGraph();
  const chips = mx_noise_float(positionWorld.mul(6.0)).mul(0.5).add(0.5);
  m.colorNode = mix(sheen.color, sheen.color.mul(0.7), smoothstep(0.7, 0.85, chips).mul(0.6));
  m.roughnessNode = sheen.roughness;
  return m;
}

/**
 * Distant skyline for backdrop cards: a dark mass with a world-space grid of
 * windows, a seeded fraction of them lit in warm or cool tones, fading into
 * haze toward the top. Unlit and emissive, so it reads through fog and bloom.
 */
function skyline(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'surface:skyline';
  const facingX = abs(normalWorld.x).greaterThan(0.5);
  const u = facingX.select(positionWorld.z, positionWorld.x);
  const v = positionWorld.y;
  const cell = vec2(floor(u.div(1.6)), floor(v.div(2.2)));
  const inU = fract(u.div(1.6));
  const inV = fract(v.div(2.2));
  const pane = smoothstep(0.25, 0.32, inU).mul(smoothstep(0.75, 0.68, inU)).mul(smoothstep(0.2, 0.28, inV)).mul(smoothstep(0.8, 0.72, inV));
  const id = hash(cell.x.add(cell.y.mul(311.0)).add(17.0));
  const id2 = hash(cell.x.add(cell.y.mul(311.0)).add(59.0));
  // Tower silhouettes: columns of cells switch off above a per-column height.
  const column = floor(u.div(9.0));
  const towerTop = hash(column.add(3.0)).mul(60.0).add(14.0);
  const inTower = smoothstep(towerTop.add(1.0), towerTop, v);
  const lit = smoothstep(0.62, 0.66, id).mul(inTower);
  const warm = color(0xffc27a);
  const cool = color(0x7ab8ff);
  const tone = mix(warm, cool, smoothstep(0.4, 0.6, id2));
  const haze = smoothstep(70.0, 15.0, v);
  m.colorNode = color(0x05060a);
  m.emissiveNode = tone.mul(pane).mul(lit).mul(id2.mul(0.5).add(0.6)).mul(haze).mul(2.2);
  m.roughnessNode = float(1.0);
  m.metalnessNode = float(0.0);
  return m;
}

/**
 * Windows: each pane in a world-space grid (`WINDOW_GRID`) is lit or dark by a
 * hash, so one material covers every window box a level places on that grid.
 * Lit panes glow warm or cool through half-closed blinds and a mullion,
 * dimmer toward the sill; dark ones are bluish glass with a wet gloss.
 */
function window(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'surface:window';
  const facingX = abs(normalWorld.x).greaterThan(0.5);
  const u = facingX.select(positionWorld.z, positionWorld.x);
  const v = positionWorld.y;
  const cell = vec2(floor(u.div(WINDOW_GRID.u)), floor(v.div(WINDOW_GRID.v)));
  const id = hash(cell.x.add(cell.y.mul(211.0)).add(41.0));
  const id2 = hash(cell.x.add(cell.y.mul(211.0)).add(97.0));
  const lit = smoothstep(0.58, 0.62, id);
  // Pane-local coordinates: 0..1 across the pane's own span within the cell.
  const pu = fract(u.div(WINDOW_GRID.u).add(0.5)).sub(0.5).mul(WINDOW_GRID.u).div(1.1).add(0.5);
  const pv = fract(v.div(WINDOW_GRID.v).add(0.5)).sub(0.5).mul(WINDOW_GRID.v).div(1.5).add(0.5);
  const glow = mix(float(1.35), float(0.55), saturate(pv).oneMinus().pow(1.6));
  const slats = smoothstep(0.35, 0.5, fract(pv.mul(6.0))).mul(0.4).add(0.6);
  const mullion = smoothstep(0.47, 0.485, pu).mul(smoothstep(0.53, 0.515, pu)).oneMinus();
  const tone = mix(color(0xffc27a), color(0x8cc4ff), smoothstep(0.35, 0.65, id2));
  m.colorNode = mix(color(0x0d1220), color(0x1a1408), lit);
  m.emissiveNode = tone.mul(glow.mul(slats).mul(mullion)).mul(lit).mul(2.4);
  m.roughnessNode = mix(float(0.15), float(0.4), lit);
  m.metalnessNode = float(0.0);
  return m;
}

/**
 * Creates and caches one material per surface (and tint), so every mesh that
 * asks for `brick` shares the same instance. Dispose it with the scene.
 */
export class SurfaceLibrary {
  private readonly cache = new Map<string, THREE.MeshStandardNodeMaterial>();
  private disposed = false;

  get(name: SurfaceName, options: SurfaceOptions = {}): THREE.MeshStandardNodeMaterial {
    if (this.disposed) throw new Error('SurfaceLibrary: disposed');
    const tint = options.color !== undefined ? new THREE.Color(options.color).getHexString() : '';
    const key = `${name}:${tint}:${options.roughness ?? ''}:${options.metalness ?? ''}`;
    let m = this.cache.get(key);
    if (!m) {
      m = create(name, options);
      this.cache.set(key, m);
    }
    return m;
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * Swap the materials of every mesh under `root` whose `spark.surface`
   * extra or material name names a surface. The original material's colour,
   * roughness and metalness become the surface options for tinted surfaces
   * (`metal`). Returns how many meshes changed.
   */
  applyTo(root: THREE.Object3D, mapping: Readonly<Record<string, SurfaceName>> = IDENTITY): number {
    let count = 0;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const extra = mesh.userData['spark.surface'];
      const source = mesh.material as THREE.Material;
      const wanted = typeof extra === 'string' ? extra : source?.name;
      if (!wanted) return;
      // `metal.barrier` is the metal surface: Blender needs unique material names, so a suffix after the first dot is a variant.
      const surface = mapping[wanted] ?? mapping[wanted.split('.')[0] as string];
      if (!surface) return;
      const std = source as THREE.MeshStandardMaterial;
      const options: SurfaceOptions =
        surface === 'metal' && std.isMeshStandardMaterial
          ? { color: std.color.getHex(), roughness: std.roughness, metalness: std.metalness }
          : {};
      mesh.material = this.get(surface, options);
      count += 1;
    });
    return count;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
  }
}

/** Material or extra name → surface, for names that already are surface names. */
const IDENTITY: Readonly<Record<string, SurfaceName>> = Object.fromEntries(SURFACE_NAMES.map((n) => [n, n]));

function create(name: SurfaceName, options: SurfaceOptions): THREE.MeshStandardNodeMaterial {
  switch (name) {
    case 'asphalt':
      return asphalt();
    case 'brick':
      return brick();
    case 'concrete':
      return concrete();
    case 'metal':
      return metal(options);
    case 'skyline':
      return skyline();
    case 'window':
      return window();
  }
}

/** One-off creation without the cache. Prefer a `SurfaceLibrary` in scenes. */
export function createSurface(name: SurfaceName, options: SurfaceOptions = {}): THREE.MeshStandardNodeMaterial {
  return create(name, options);
}
