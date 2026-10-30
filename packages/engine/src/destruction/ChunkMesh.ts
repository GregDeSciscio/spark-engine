import * as THREE from 'three/webgpu';
import { attribute, bumpMap, float, Fn, int, ivec2, mat4, mix, mx_fractal_noise_float, mx_noise_float, mx_worley_noise_float, normalLocal, normalView, positionGeometry, positionPrevious, smoothstep, textureLoad, varying, vec3, vec4 } from 'three/tsl';
import { writesVelocity } from '../rendering/Velocity';
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

/** The per-chunk textures: a matrix (rest → world, four texels, a column each) and a tint (one texel). */
interface ChunkPool {
  readonly matrices: THREE.DataTexture;
  readonly matrixData: Float32Array;
  readonly matrixWidth: number;
  /** Last frame's matrices, laid out as `matrices`: where each chunk was, for the velocity pass (motion blur, TAA). */
  readonly previous: THREE.DataTexture;
  readonly previousData: Float32Array;
  /** Set when a pass that reads velocity builds the material: only then is `previous` kept up. */
  velocity: boolean;
  readonly tints: THREE.DataTexture;
  readonly tintData: Float32Array;
  readonly tintWidth: number;
}

/** A float RGBA texture of at least `texels` texels, about square, its width a multiple of `multiple`. */
function floatTexture(texels: number, multiple: number): { texture: THREE.DataTexture; data: Float32Array; width: number } {
  const width = Math.ceil(Math.ceil(Math.sqrt(texels)) / multiple) * multiple;
  const height = Math.max(1, Math.ceil(texels / width));
  const data = new Float32Array(width * height * 4);
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  return { texture, data, width };
}

/**
 * Paint and concrete with some grain: fine fractal noise and broad blotches
 * on top of the vertex colours, from each chunk's *rest* position (the raw
 * `position` attribute; `positionLocal` is moved by the chunk's matrix, so
 * noise from it would swim as the chunk falls).
 *
 * Broken faces are rough concrete in relief: bumped by a height field of
 * fractal noise and the cells of the aggregate (worley noise), with the
 * stones of the aggregate a shade off the cement between them. No extra
 * geometry: the faces stay flat, only their shading breaks up.
 *
 * Each vertex carries its chunk's id: the vertex stage reads the chunk's
 * matrix and tint from `pool`. The shadow passes take the material's
 * `positionNode` too, so shadows move with the chunks.
 *
 * A pass that writes velocity (motion blur, TAA) also gets where the vertex
 * was last frame, from `pool.previous`, as three's instancing does
 * (`rendering/Velocity.ts`). Left alone, the previous position is the raw
 * `position` (the rest pose), and every chunk that has moved blurs back
 * toward where it stood.
 */
function concreteMaterial(pool: ChunkPool): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, metalness: 0 });
  const chunk = int(attribute('chunk', 'float') as unknown as ReturnType<typeof float>);
  const mw = int(pool.matrixWidth);
  m.positionNode = Fn((builder) => {
    const j = chunk.mul(4).toConst();
    const x = j.mod(mw).toConst();
    const y = j.div(mw).toConst();
    const c0 = textureLoad(pool.matrices, ivec2(x, y)).toConst();
    const c1 = textureLoad(pool.matrices, ivec2(x.add(1), y)).toConst();
    const c2 = textureLoad(pool.matrices, ivec2(x.add(2), y)).toConst();
    const c3 = textureLoad(pool.matrices, ivec2(x.add(3), y)).toConst();
    if (writesVelocity(builder)) {
      pool.velocity = true;
      const p0 = textureLoad(pool.previous, ivec2(x, y));
      const p1 = textureLoad(pool.previous, ivec2(x.add(1), y));
      const p2 = textureLoad(pool.previous, ivec2(x.add(2), y));
      const p3 = textureLoad(pool.previous, ivec2(x.add(3), y));
      positionPrevious.assign(mat4(p0, p1, p2, p3).mul(vec4(positionPrevious, 1)).xyz);
    }
    // Normals by the inverse transpose of a rotation and scale: each axis (column) over its squared length.
    const n = normalLocal;
    normalLocal.assign(
      c0.xyz
        .mul(n.x.div(c0.xyz.dot(c0.xyz)))
        .add(c1.xyz.mul(n.y.div(c1.xyz.dot(c1.xyz))))
        .add(c2.xyz.mul(n.z.div(c2.xyz.dot(c2.xyz)))),
    );
    return mat4(c0, c1, c2, c3).mul(vec4(positionGeometry, 1)).xyz;
  })();
  const tw = int(pool.tintWidth);
  const tint = varying(textureLoad(pool.tints, ivec2(chunk.mod(tw), chunk.div(tw))).rgb);
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
  m.colorNode = vec3(float(1).add(grain.mul(mix(float(0.08), float(0.2), broken))).add(blotch.mul(0.06)).add(pits.mul(broken).mul(0.22)).add(stone.sub(0.35).mul(broken).mul(0.2))).mul(tint);
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
 * Every chunk of every building in one mesh: one draw a pass for the whole
 * structure however many chunks there are, a matrix per chunk in a texture
 * (THE FINALS' "GPU transform pool"). Chunks keep their rest-pose geometry;
 * moving one is a matrix write. A `BatchedMesh` was a draw per chunk on
 * WebGPU (three's backend draws its instances one at a time): 5,400 draws a
 * frame for the sandbox's 1,800 chunks, 10,100 with the tower.
 */
export class ChunkMesh {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>;
  private readonly pool: ChunkPool;
  /** Per chunk: where it is (rest → world, 16 floats) whether shown or not, and whether it is shown. */
  private readonly poses: Float32Array;
  private readonly shown: Uint8Array;
  /** A drawn matrix changed since `previous` last caught up. */
  private moved = false;
  /** Per chunk: scale about its centroid to the size of its (shrunk) loose collision hull. */
  private readonly shrink: THREE.Matrix4[];
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmp = new THREE.Color();
  /** Per chunk: soot from blasts nearby (0 clean, 1 black), and the stress tint (null: off). */
  private readonly soot: Float32Array;
  private heat: Float32Array | null = null;
  /** Told whenever a chunk moves (its rest → world matrix) or goes (null): the rebar rides on it. */
  onMove: ((piece: number, world: THREE.Matrix4 | null) => void) | null = null;

  constructor(pieces: readonly Piece[], seed = 1) {
    const random = rng(seed);
    const n = pieces.length;
    const geometries = pieces.map((p) => pieceGeometry(p, random));
    const vertexCount = geometries.reduce((s, g) => s + g.getAttribute('position').count, 0);
    // One geometry: every chunk's triangles in its rest pose, each vertex marked with its chunk.
    const position = new Float32Array(vertexCount * 3);
    const normal = new Float32Array(vertexCount * 3);
    const color = new Float32Array(vertexCount * 3);
    const rough = new Float32Array(vertexCount);
    const chunk = new Float32Array(vertexCount);
    let at = 0;
    geometries.forEach((g, i) => {
      const count = g.getAttribute('position').count;
      position.set(g.getAttribute('position').array, at * 3);
      normal.set(g.getAttribute('normal').array, at * 3);
      color.set(g.getAttribute('color').array, at * 3);
      rough.set(g.getAttribute('rough').array, at);
      chunk.fill(i, at, at + count);
      at += count;
      g.dispose();
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
    geometry.setAttribute('rough', new THREE.BufferAttribute(rough, 1));
    geometry.setAttribute('chunk', new THREE.BufferAttribute(chunk, 1));

    const matrices = floatTexture(n * 4, 4);
    const previous = floatTexture(n * 4, 4);
    const tints = floatTexture(n, 1);
    this.pool = {
      matrices: matrices.texture,
      matrixData: matrices.data,
      matrixWidth: matrices.width,
      previous: previous.texture,
      previousData: previous.data,
      velocity: false,
      tints: tints.texture,
      tintData: tints.data,
      tintWidth: tints.width,
    };
    this.poses = new Float32Array(n * 16);
    this.shown = new Uint8Array(n).fill(1);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      identity.toArray(this.poses, i * 16);
      identity.toArray(this.pool.matrixData, i * 16);
    }
    this.pool.previousData.set(this.pool.matrixData);
    this.pool.tintData.fill(1);
    this.mesh = new THREE.Mesh(geometry, concreteMaterial(this.pool));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // Its bounds are the rest pose, and chunks fly well out of them.
    this.mesh.frustumCulled = false;
    this.soot = new Float32Array(n);
    this.shrink = pieces.map((p) => {
      const [x, y, z] = p.centroid;
      return new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeScale(LOOSE_SCALE, LOOSE_SCALE, LOOSE_SCALE)).multiply(new THREE.Matrix4().makeTranslation(-x, -y, -z));
    });
  }

  /** A chunk's matrix: kept, and drawn unless the chunk is hidden (a hidden chunk's is zero: no triangles). */
  private place(piece: number, matrix: THREE.Matrix4): void {
    matrix.toArray(this.poses, piece * 16);
    if (this.shown[piece]) matrix.toArray(this.pool.matrixData, piece * 16);
    this.pool.matrices.needsUpdate = true;
    this.moved = true;
  }

  /**
   * Once a rendered frame, before that frame's chunk matrices are written: what was drawn last
   * frame becomes the previous pose the velocity pass (motion blur, TAA) measures motion from.
   * Costs nothing unless a pass reads velocity, and nothing in a frame where no chunk moved.
   */
  beginFrame(): void {
    if (!this.pool.velocity || !this.moved) return;
    this.pool.previousData.set(this.pool.matrixData);
    this.pool.previous.needsUpdate = true;
    this.moved = false;
  }

  /** Move a chunk that is still standing (a dent): full size, no hull scaling. */
  setStandingMatrix(piece: number, matrix: THREE.Matrix4): void {
    this.place(piece, matrix);
    this.onMove?.(piece, matrix);
  }

  /**
   * Place a chunk that has come loose (or settled): rest → world. A chunk on its own is drawn
   * at its hull's size; one that is part of a bigger rigid body stays full size, so the seams
   * inside a fallen wall stay closed.
   */
  setMatrix(piece: number, matrix: THREE.Matrix4, alone = true): void {
    this.place(piece, alone ? this.tmpM.copy(matrix).multiply(this.shrink[piece]!) : matrix);
    this.onMove?.(piece, matrix);
  }

  setVisible(piece: number, visible: boolean): void {
    this.shown[piece] = visible ? 1 : 0;
    const o = piece * 16;
    if (visible) {
      const pose = this.poses.subarray(o, o + 16);
      this.pool.matrixData.set(pose, o);
      // Its previous matrix is the hidden one, all zeros (w = 0, no velocity to speak of): start it still.
      this.pool.previousData.set(pose, o);
      this.pool.previous.needsUpdate = true;
    } else this.pool.matrixData.fill(0, o, o + 16);
    this.pool.matrices.needsUpdate = true;
    this.moved = true;
    if (!visible) this.onMove?.(piece, null);
  }

  /** Tint chunks by stress over baseline (0 = white, 1 = about to break); null clears it. */
  setHeat(heat: Float32Array | null): void {
    this.heat = heat;
    for (let i = 0; i < this.soot.length; i++) this.paint(i);
  }

  /** Blacken a chunk by `amount` (soot builds up to fully black). */
  scorch(piece: number, amount: number): void {
    const s = Math.min(1, this.soot[piece]! + amount);
    if (s === this.soot[piece]) return;
    this.soot[piece] = s;
    this.paint(piece);
  }

  /** A chunk's tint: its stress tint, then its soot. */
  private paint(i: number): void {
    const h = this.heat ? Math.min(1, this.heat[i] ?? 0) : 0;
    // Yellow by a quarter of the way to breaking, red at the break.
    if (h <= 0.02) this.tmp.copy(WHITE);
    else if (h < 0.25) this.tmp.copy(WHITE).lerp(WARM, h * 4);
    else this.tmp.copy(WARM).lerp(HOT, (h - 0.25) / 0.75);
    if (this.soot[i]! > 0) this.tmp.lerp(SOOT, this.soot[i]! * 0.85);
    this.pool.tintData[i * 4] = this.tmp.r;
    this.pool.tintData[i * 4 + 1] = this.tmp.g;
    this.pool.tintData[i * 4 + 2] = this.tmp.b;
    this.pool.tints.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.pool.matrices.dispose();
    this.pool.previous.dispose();
    this.pool.tints.dispose();
  }
}
