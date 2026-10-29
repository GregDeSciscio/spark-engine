import * as THREE from 'three/webgpu';
import { attribute, bumpMap, float, mix, mx_fractal_noise_float, mx_noise_float, mx_worley_noise_float, normalView, smoothstep, vec3 } from 'three/tsl';
import { rng } from './core/math';
import type { Piece, Surface } from './core/pieces';

/** Paint per surface; fracture faces are raw concrete, varied a little per chunk. */
export const CHUNK_PALETTE: Record<Surface, number> = {
  outer: 0xe4d3b4,
  edge: 0xd9c6a5,
  inner: 0xf1ede4,
  floor: 0xb8b1a3,
  ceiling: 0xf4f1ea,
  fracture: 0x7f7b74,
};

/** Flat-shaded triangles for one chunk, in its rest (world) pose, coloured per face. */
export function pieceGeometry(piece: Piece, random: () => number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const rough: number[] = [];
  const shade = 0.9 + random() * 0.2;
  const color = new THREE.Color();
  for (const face of piece.faces) {
    color.setHex(CHUNK_PALETTE[face.surface]);
    if (face.surface === 'fracture') color.multiplyScalar(shade);
    const [a, ...rest] = face.verts;
    for (let i = 0; i + 1 < rest.length; i++) {
      for (const idx of [a!, rest[i]!, rest[i + 1]!]) {
        const p = piece.vertices[idx]!;
        positions.push(p[0], p[1], p[2]);
        normals.push(face.normal[0], face.normal[1], face.normal[2]);
        colors.push(color.r, color.g, color.b);
        rough.push(face.surface === 'fracture' ? 1 : 0);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute('rough', new THREE.Float32BufferAttribute(rough, 1));
  return g;
}

/**
 * Paint and concrete with some grain: fine fractal noise and broad blotches
 * on top of the vertex colours, from each chunk's *rest* position (the raw
 * `position` attribute; in a BatchedMesh `positionLocal` is already moved by
 * the chunk's matrix, so noise from it would swim as the chunk falls).
 *
 * Broken faces are rough concrete in relief: bumped by a height field of
 * fractal noise and the cells of the aggregate (worley noise), with the
 * stones of the aggregate a shade off the cement between them. No extra
 * geometry: the faces stay flat, only their shading breaks up.
 */
function concreteMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, metalness: 0 });
  const rest = attribute('position', 'vec3') as unknown as ReturnType<typeof vec3>;
  // 1 on break faces: broken concrete is pitted and uneven, paint is not.
  const broken = attribute('rough', 'float') as unknown as ReturnType<typeof float>;
  const grain = mx_fractal_noise_float(rest.mul(3.1), 3, 2, 0.5);
  const blotch = mx_noise_float(rest.mul(0.45));
  const pits = mx_fractal_noise_float(rest.mul(11), 2, 2, 0.5);
  // The aggregate: stones (worley cells, ~3 cm) set in cement.
  const cells = mx_worley_noise_float(rest.mul(26));
  const stone = float(1).sub(smoothstep(0.18, 0.42, cells));
  const relief = mx_fractal_noise_float(rest.mul(6), 3, 2, 0.55).mul(0.7).add(stone.mul(0.45));
  m.colorNode = vec3(float(1).add(grain.mul(mix(float(0.08), float(0.2), broken))).add(blotch.mul(0.06)).add(pits.mul(broken).mul(0.22)).add(stone.sub(0.35).mul(broken).mul(0.2)));
  m.roughnessNode = float(0.86).add(grain.mul(0.08)).add(broken.mul(0.08));
  const bumped = bumpMap(relief, float(0.9)) as unknown as ReturnType<typeof vec3>;
  m.normalNode = mix(normalView, bumped, broken);
  return m;
}

/** Between full size and the loose collision hulls in Debris.ts (HULL_SHRINK, 0.97): no visible sinking, no visible gaps. */
const LOOSE_SCALE = 0.985;

const WHITE = new THREE.Color(1, 1, 1);
const HOT = new THREE.Color(1.0, 0.18, 0.08);
const WARM = new THREE.Color(1.0, 0.85, 0.2);
/** What a blast leaves on concrete it doesn't break: soot. */
const SOOT = new THREE.Color(0.2, 0.18, 0.16);

/**
 * Every chunk of every building in one BatchedMesh: one draw for the whole
 * structure, a matrix per chunk (THE FINALS' "GPU transform pool"). Chunks
 * keep their rest-pose geometry; moving one is a matrix write.
 */
export class ChunkMesh {
  readonly mesh: THREE.BatchedMesh;
  private readonly instance: Int32Array;
  /** Per chunk: scale about its centroid to the size of its (shrunk) loose collision hull. */
  private readonly shrink: THREE.Matrix4[];
  private readonly tmpM = new THREE.Matrix4();
  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly tmp = new THREE.Color();
  /** Per chunk: soot from blasts nearby (0 clean, 1 black), and the stress tint (null: off). */
  private readonly soot: Float32Array;
  private heat: Float32Array | null = null;
  /** Told whenever a chunk moves (its rest → world matrix) or goes (null): the rebar rides on it. */
  onMove: ((piece: number, world: THREE.Matrix4 | null) => void) | null = null;

  constructor(pieces: readonly Piece[], seed = 1) {
    const random = rng(seed);
    const geometries = pieces.map((p) => pieceGeometry(p, random));
    const vertexCount = geometries.reduce((s, g) => s + g.getAttribute('position').count, 0);
    this.material = concreteMaterial();
    this.mesh = new THREE.BatchedMesh(pieces.length, vertexCount, 0, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // Opaque chunks need no per-frame sort (it was a visible slice of the frame with 1,800 of them).
    this.mesh.sortObjects = false;
    this.instance = new Int32Array(pieces.length);
    this.soot = new Float32Array(pieces.length);
    this.shrink = pieces.map((p) => {
      const [x, y, z] = p.centroid;
      return new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeScale(LOOSE_SCALE, LOOSE_SCALE, LOOSE_SCALE)).multiply(new THREE.Matrix4().makeTranslation(-x, -y, -z));
    });
    const identity = new THREE.Matrix4();
    geometries.forEach((g, i) => {
      const geo = this.mesh.addGeometry(g);
      const inst = this.mesh.addInstance(geo);
      this.instance[i] = inst;
      this.mesh.setMatrixAt(inst, identity);
      // Create the colour texture up front so turning the heat view on never recompiles the shader.
      this.mesh.setColorAt(inst, WHITE);
      g.dispose();
    });
  }

  /** Move a chunk that is still standing (a dent): full size, no hull scaling. */
  setStandingMatrix(piece: number, matrix: THREE.Matrix4): void {
    this.mesh.setMatrixAt(this.instance[piece]!, matrix);
    this.onMove?.(piece, matrix);
  }

  /**
   * Place a chunk that has come loose (or settled): rest → world. A chunk on its own is drawn
   * at its hull's size; one that is part of a bigger rigid body stays full size, so the seams
   * inside a fallen wall stay closed.
   */
  setMatrix(piece: number, matrix: THREE.Matrix4, alone = true): void {
    this.mesh.setMatrixAt(this.instance[piece]!, alone ? this.tmpM.copy(matrix).multiply(this.shrink[piece]!) : matrix);
    this.onMove?.(piece, matrix);
  }

  setVisible(piece: number, visible: boolean): void {
    this.mesh.setVisibleAt(this.instance[piece]!, visible);
    if (!visible) this.onMove?.(piece, null);
  }

  /** Tint chunks by stress over baseline (0 = white, 1 = about to break); null clears it. */
  setHeat(heat: Float32Array | null): void {
    this.heat = heat;
    for (let i = 0; i < this.instance.length; i++) this.paint(i);
  }

  /** Blacken a chunk by `amount` (soot builds up to fully black). */
  scorch(piece: number, amount: number): void {
    const s = Math.min(1, this.soot[piece]! + amount);
    if (s === this.soot[piece]) return;
    this.soot[piece] = s;
    this.paint(piece);
  }

  /** A chunk's instance colour: its stress tint, then its soot. */
  private paint(i: number): void {
    const h = this.heat ? Math.min(1, this.heat[i] ?? 0) : 0;
    // Yellow by a quarter of the way to breaking, red at the break.
    if (h <= 0.02) this.tmp.copy(WHITE);
    else if (h < 0.25) this.tmp.copy(WHITE).lerp(WARM, h * 4);
    else this.tmp.copy(WARM).lerp(HOT, (h - 0.25) / 0.75);
    if (this.soot[i]! > 0) this.tmp.lerp(SOOT, this.soot[i]! * 0.85);
    this.mesh.setColorAt(this.instance[i]!, this.tmp);
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
  }
}
