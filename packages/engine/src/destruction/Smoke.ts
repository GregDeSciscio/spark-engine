import * as THREE from 'three/webgpu';
import { cos, float, instancedBufferAttribute, instancedDynamicBufferAttribute, sin, smoothstep, time, uniform, uv, vec3 } from 'three/tsl';
import { withoutOwnMotion } from '../rendering/Velocity';
import type { Piece } from './core/pieces';
import { GONE, STANDING, type Debris } from './Debris';

/**
 * THE FINALS Season 12's dynamic smoke and gas: a cloud that takes the shape
 * of the space around it instead of passing through walls.
 *
 * Each cloud floods a 0.5 m voxel grid outward from where the grenade landed
 * (shortest path first, so it is round in the open and pours through doors
 * and holes), up to its volume. Voxels inside a chunk (standing, rubble or
 * loose) are solid. When the building changes the cloud re-checks its space,
 * so smoke flows into a hole that was just opened, and a blast blows a
 * pocket clear that refills a moment later. Drawn as one instanced set of
 * soft sprites, one per filled voxel, drifting in the shader.
 */

export type SmokeKind = 'smoke' | 'gas';

/**
 * `rise`/`sink`: cost of flooding up or down a cell (smoke climbs, gas pools low).
 * `flat`: how much vertical distance counts against roundness (gas spreads wide and low).
 */
const KINDS: Record<SmokeKind, { radius: number; seconds: number; color: THREE.Color; alpha: number; rise: number; sink: number; flat: number }> = {
  // Season 12 numbers: smoke 4.5 m for 13 s, gas 4.5 m for 8 s.
  smoke: { radius: 4.5, seconds: 13, color: new THREE.Color(0.8, 0.8, 0.78), alpha: 0.2, rise: 0.9, sink: 1.15, flat: 1 },
  gas: { radius: 4.5, seconds: 8, color: new THREE.Color(0.42, 0.62, 0.16), alpha: 0.2, rise: 1.5, sink: 0.85, flat: 1.7 },
};

type FloatNode = ReturnType<typeof float>;
type Vec3Node = ReturnType<typeof vec3>;

const CELL = 0.5;
const MAX_CLOUDS = 4;
/** Sprites per cloud: the voxel budget of a 4.5 m sphere. */
const PER_CLOUD = Math.ceil(((4 / 3) * Math.PI * 4.5 ** 3) / CELL ** 3);
const GROW_SECONDS = 1.1;
const DISPLACED_SECONDS = 2.2;

const NEIGHBOURS: Array<[number, number, number, number]> = [];
for (let dx = -1; dx <= 1; dx++)
  for (let dy = -1; dy <= 1; dy++)
    for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dy && !dz) continue;
      NEIGHBOURS.push([dx, dy, dz, Math.hypot(dx, dy, dz)]);
    }

class Heap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, val: number): void {
    const k = this.keys;
    const v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p]! <= key) break;
      k[i] = k[p]!;
      v[i] = v[p]!;
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): [number, number] {
    const k = this.keys;
    const v = this.vals;
    const top: [number, number] = [k[0]!, v[0]!];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= k.length) break;
        const r = l + 1;
        const c = r < k.length && k[r]! < k[l]! ? r : l;
        if (k[c]! >= lk) break;
        k[i] = k[c]!;
        v[i] = v[c]!;
        i = c;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return top;
  }
}

let nextCloudId = 0;

class Cloud {
  readonly kind: SmokeKind;
  /** Offsets cell indices so slot caching never confuses two clouds. */
  readonly id = (nextCloudId++ % 64) * 1e6;
  readonly min = new THREE.Vector3();
  readonly n: [number, number, number];
  readonly solid: Uint8Array;
  /** Path length from the source, or Infinity while unreached. */
  readonly dist: Float32Array;
  readonly filled: Uint8Array;
  readonly density: Float32Array;
  readonly displaced: Float32Array;
  /** 1 where something solid is overhead (indoors, under a slab): that smoke is in shadow. */
  readonly covered: Uint8Array;
  /** Cell centres, xyz per cell (fixed for the cloud's life). */
  readonly centers: Float32Array;
  readonly order: number[] = [];
  readonly heap = new Heap();
  readonly budget: number;
  /** The cell the cloud started from (i, j, k). */
  readonly src: [number, number, number] = [0, 0, 0];
  age = 0;

  constructor(kind: SmokeKind, at: THREE.Vector3) {
    this.kind = kind;
    const r = KINDS[kind].radius + 1.5;
    this.min.set(at.x - r, Math.max(0, at.y - 3), at.z - r);
    this.n = [Math.ceil((2 * r) / CELL), Math.ceil((at.y + 6 - this.min.y) / CELL), Math.ceil((2 * r) / CELL)];
    const total = this.n[0] * this.n[1] * this.n[2];
    this.solid = new Uint8Array(total);
    this.dist = new Float32Array(total).fill(Infinity);
    this.filled = new Uint8Array(total);
    this.density = new Float32Array(total);
    this.displaced = new Float32Array(total);
    this.covered = new Uint8Array(total);
    this.centers = new Float32Array(total * 3);
    const v = new THREE.Vector3();
    for (let c = 0; c < total; c++) this.centers.set(this.center(c, v).toArray(), c * 3);
    this.budget = PER_CLOUD;
  }

  /** Recompute which voxels have something solid above them (after the occupancy changes). */
  shadeFromAbove(): void {
    const [nx, ny, nz] = this.n;
    for (let k = 0; k < nz; k++)
      for (let i = 0; i < nx; i++) {
        let roof = 0;
        for (let j = ny - 1; j >= 0; j--) {
          const c = this.index(i, j, k);
          if (this.solid[c]) roof = 1;
          this.covered[c] = roof;
        }
      }
  }

  index(i: number, j: number, k: number): number {
    return (j * this.n[2] + k) * this.n[0] + i;
  }

  center(c: number, out: THREE.Vector3): THREE.Vector3 {
    const nx = this.n[0];
    const nz = this.n[2];
    const i = c % nx;
    const k = Math.floor(c / nx) % nz;
    const j = Math.floor(c / (nx * nz));
    return out.set(this.min.x + (i + 0.5) * CELL, this.min.y + (j + 0.5) * CELL, this.min.z + (k + 0.5) * CELL);
  }

  cellOf(p: THREE.Vector3): number {
    const i = Math.floor((p.x - this.min.x) / CELL);
    const j = Math.floor((p.y - this.min.y) / CELL);
    const k = Math.floor((p.z - this.min.z) / CELL);
    if (i < 0 || j < 0 || k < 0 || i >= this.n[0] || j >= this.n[1] || k >= this.n[2]) return -1;
    return this.index(i, j, k);
  }

  get count(): number {
    return this.order.length;
  }

  /**
   * Fill order: mostly straight-line distance from the source (round in the
   * open; a grid's path metric alone grows a boxy octahedron), plus some of
   * the detour a path takes, so smoke still has to find the door to get out.
   */
  priority(c: number, path: number): number {
    const nx = this.n[0];
    const nz = this.n[2];
    const i = c % nx;
    const k = Math.floor(c / nx) % nz;
    const j = Math.floor(c / (nx * nz));
    const straight = Math.hypot(i - this.src[0], (j - this.src[1]) * KINDS[this.kind].flat, k - this.src[2]);
    return straight + 0.35 * Math.max(0, path - straight);
  }

  /** Flood up to `steps` more voxels. Stale queue entries don't count against `steps`. */
  grow(steps: number): void {
    const [nx, ny, nz] = this.n;
    const { rise, sink } = KINDS[this.kind];
    let pops = 0;
    while (steps > 0 && this.heap.size > 0 && this.order.length < this.budget && pops++ < 40_000) {
      const [, c] = this.heap.pop();
      if (this.filled[c] || this.solid[c]) continue;
      const d = this.dist[c]!;
      steps--;
      this.filled[c] = 1;
      this.order.push(c);
      const i = c % nx;
      const k = Math.floor(c / nx) % nz;
      const j = Math.floor(c / (nx * nz));
      for (const [dx, dy, dz, w] of NEIGHBOURS) {
        const a = i + dx;
        const b = j + dy;
        const e = k + dz;
        if (a < 0 || b < 0 || e < 0 || a >= nx || b >= ny || e >= nz) continue;
        const nc = this.index(a, b, e);
        if (this.solid[nc] || this.filled[nc]) continue;
        // Diagonal moves may not cut a wall's corner: both axis-aligned steps must be open.
        if (dx && dy && this.solid[this.index(a, j, k)] && this.solid[this.index(i, b, k)]) continue;
        if (dx && dz && this.solid[this.index(a, j, k)] && this.solid[this.index(i, j, e)]) continue;
        if (dy && dz && this.solid[this.index(i, b, k)] && this.solid[this.index(i, j, e)]) continue;
        const nd = d + w * (dy > 0 ? rise : dy < 0 ? sink : 1);
        if (nd < this.dist[nc]!) {
          this.dist[nc] = nd;
          this.heap.push(this.priority(nc, nd), nc);
        }
      }
    }
  }

  /** The space changed: drop voxels that are now solid, and let the edge flow on into anything newly open. */
  reshape(): void {
    const [nx, ny, nz] = this.n;
    const keep: number[] = [];
    for (const c of this.order) {
      if (this.solid[c]) {
        this.filled[c] = 0;
        this.density[c] = 0;
      } else keep.push(c);
    }
    this.order.length = 0;
    this.order.push(...keep);
    // Every filled voxel's open neighbours rejoin the frontier (a new hole next to the cloud gets found).
    for (const c of this.order) {
      const i = c % nx;
      const k = Math.floor(c / nx) % nz;
      const j = Math.floor(c / (nx * nz));
      for (const [dx, dy, dz, w] of NEIGHBOURS) {
        const a = i + dx;
        const b = j + dy;
        const e = k + dz;
        if (a < 0 || b < 0 || e < 0 || a >= nx || b >= ny || e >= nz) continue;
        const nc = this.index(a, b, e);
        if (this.solid[nc] || this.filled[nc]) continue;
        const nd = this.dist[c]! + w;
        if (nd < this.dist[nc]!) this.dist[nc] = nd;
        this.heap.push(this.priority(nc, this.dist[nc]!), nc);
      }
    }
  }
}

export class SmokeSystem {
  private readonly clouds: Cloud[] = [];
  private readonly debris: Debris;
  private readonly pieces: readonly Piece[];
  readonly object: THREE.Group = new THREE.Group();
  private readonly sprites: Record<SmokeKind, { sprite: THREE.Sprite; pos: THREE.InstancedBufferAttribute; alpha: THREE.InstancedBufferAttribute; shade: THREE.InstancedBufferAttribute; cell: Float64Array }>;
  private dirty = false;
  private reshapeTimer = 0;
  private readonly tmp = new THREE.Vector3();
  private readonly inv = new THREE.Matrix4();
  private readonly pose = new THREE.Matrix4();

  constructor(debris: Debris, pieces: readonly Piece[]) {
    this.debris = debris;
    this.pieces = pieces;
    const capacity = PER_CLOUD * MAX_CLOUDS;
    const make = (kind: SmokeKind): { sprite: THREE.Sprite; pos: THREE.InstancedBufferAttribute; alpha: THREE.InstancedBufferAttribute; shade: THREE.InstancedBufferAttribute; cell: Float64Array } => {
      const pos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
      const shade = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1).setUsage(THREE.DynamicDrawUsage);
      const phases = new Float32Array(capacity);
      for (let i = 0; i < capacity; i++) phases[i] = (i * 2.399963) % (Math.PI * 2);
      // TSL attribute nodes come back untyped; these are one float and one vec3 per sprite.
      const phase = instancedBufferAttribute(new THREE.InstancedBufferAttribute(phases, 1)) as unknown as FloatNode;
      const material = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
      const drift = vec3(sin(time.mul(0.55).add(phase)), sin(time.mul(0.4).add(phase.mul(1.7))).mul(0.6), cos(time.mul(0.5).add(phase.mul(2.3)))).mul(0.16);
      const at = instancedDynamicBufferAttribute(pos) as unknown as Vec3Node;
      // No motion of its own for motion blur: the drift is slow, and without it every sprite smears from the origin.
      material.positionNode = withoutOwnMotion(at.add(drift));
      material.scaleNode = float(1.15).add(sin(time.mul(0.3).add(phase)).mul(0.15));
      const soft = smoothstep(float(0.5), float(0.05), uv().sub(0.5).length());
      // Shade so it reads as a volume, not a flat fill: darker low down and in the folds
      // (per-sprite variation), lighter on top, a little brighter at each sprite's centre.
      const height = at.y.mul(0.09).add(0.72).clamp(0.72, 1.0);
      const fold = sin(phase.mul(3.1)).mul(0.1).add(0.92);
      const core = soft.mul(0.08).add(0.95);
      const indoor = instancedDynamicBufferAttribute(shade) as unknown as FloatNode;
      material.colorNode = uniform(KINDS[kind].color).mul(height.mul(fold).mul(core).mul(indoor));
      // Billowing: each sprite thickens and thins on its own slow beat.
      const billow = sin(time.mul(0.8).add(phase.mul(5))).mul(0.28).add(0.72);
      material.opacityNode = soft.mul(instancedDynamicBufferAttribute(alpha) as unknown as FloatNode).mul(billow);
      const sprite = new THREE.Sprite(material);
      pos.setXYZ(0, 0, -60, 0);
      sprite.count = 1;
      sprite.frustumCulled = false;
      sprite.renderOrder = 10;
      this.object.add(sprite);
      return { sprite, pos, alpha, shade, cell: new Float64Array(capacity).fill(-1) };
    };
    this.sprites = { smoke: make('smoke'), gas: make('gas') };
  }

  get cloudCount(): number {
    return this.clouds.length;
  }

  get voxels(): number {
    return this.clouds.reduce((s, c) => s + c.count, 0);
  }

  /** A grenade went off at `at` (already pulled back into open space). */
  spawn(kind: SmokeKind, at: THREE.Vector3): void {
    if (this.clouds.length >= MAX_CLOUDS) this.clouds.shift();
    const cloud = new Cloud(kind, at);
    this.occupancy(cloud);
    cloud.shadeFromAbove();
    let start = cloud.cellOf(at);
    if (start < 0 || cloud.solid[start]) {
      // Landed inside something: start from the nearest open voxel.
      let best = Infinity;
      for (let c = 0; c < cloud.solid.length; c++) {
        if (cloud.solid[c]) continue;
        const d = cloud.center(c, this.tmp).distanceToSquared(at);
        if (d < best) {
          best = d;
          start = c;
        }
      }
    }
    if (start < 0) return;
    cloud.dist[start] = 0;
    cloud.src[0] = start % cloud.n[0];
    cloud.src[2] = Math.floor(start / cloud.n[0]) % cloud.n[2];
    cloud.src[1] = Math.floor(start / (cloud.n[0] * cloud.n[2]));
    cloud.heap.push(0, start);
    this.clouds.push(cloud);
  }

  /** The structure changed somewhere: clouds re-check their space shortly. */
  markDirty(): void {
    this.dirty = true;
  }

  /** A blast clears a pocket that refills a moment later. */
  blast(at: THREE.Vector3, radius: number): void {
    for (const cloud of this.clouds) {
      for (const c of cloud.order) {
        if (cloud.center(c, this.tmp).distanceTo(at) < radius) cloud.displaced[c] = DISPLACED_SECONDS;
      }
    }
  }

  /** Mark voxels inside any chunk solid: standing chunks in their rest pose, loose ones and rubble where they are now. */
  private occupancy(cloud: Cloud): void {
    cloud.solid.fill(0);
    const max = new THREE.Vector3(cloud.min.x + cloud.n[0] * CELL, cloud.min.y + cloud.n[1] * CELL, cloud.min.z + cloud.n[2] * CELL);
    const wmin = new THREE.Vector3();
    const wmax = new THREE.Vector3();
    const local = new THREE.Vector3();
    for (const piece of this.pieces) {
      const state = this.debris.state[piece.id]!;
      if (state === GONE) continue;
      const moved = state !== STANDING;
      if (moved) this.debris.restToWorld(piece.id, this.pose);
      else this.pose.identity();
      if (!moved) {
        wmin.set(piece.min[0], piece.min[1], piece.min[2]);
        wmax.set(piece.max[0], piece.max[1], piece.max[2]);
      } else {
        // The rest box's eight corners, moved: a little loose, and far cheaper than every vertex.
        wmin.set(Infinity, Infinity, Infinity);
        wmax.set(-Infinity, -Infinity, -Infinity);
        for (let k = 0; k < 8; k++) {
          this.tmp.set(k & 1 ? piece.max[0] : piece.min[0], k & 2 ? piece.max[1] : piece.min[1], k & 4 ? piece.max[2] : piece.min[2]).applyMatrix4(this.pose);
          wmin.min(this.tmp);
          wmax.max(this.tmp);
        }
      }
      if (wmax.x < cloud.min.x || wmax.y < cloud.min.y || wmax.z < cloud.min.z || wmin.x > max.x || wmin.y > max.y || wmin.z > max.z) continue;
      this.inv.copy(this.pose).invert();
      const i0 = Math.max(0, Math.floor((wmin.x - cloud.min.x) / CELL));
      const j0 = Math.max(0, Math.floor((wmin.y - cloud.min.y) / CELL));
      const k0 = Math.max(0, Math.floor((wmin.z - cloud.min.z) / CELL));
      const i1 = Math.min(cloud.n[0] - 1, Math.floor((wmax.x - cloud.min.x) / CELL));
      const j1 = Math.min(cloud.n[1] - 1, Math.floor((wmax.y - cloud.min.y) / CELL));
      const k1 = Math.min(cloud.n[2] - 1, Math.floor((wmax.z - cloud.min.z) / CELL));
      for (let j = j0; j <= j1; j++)
        for (let k = k0; k <= k1; k++)
          for (let i = i0; i <= i1; i++) {
            const c = cloud.index(i, j, k);
            if (cloud.solid[c]) continue;
            cloud.center(c, local).applyMatrix4(this.inv);
            // Inside the convex chunk (grown by a quarter cell, so thin walls still seal): behind every face.
            let inside = true;
            for (const f of piece.faces) {
              const v0 = piece.vertices[f.verts[0]!]!;
              if ((local.x - v0[0]) * f.normal[0] + (local.y - v0[1]) * f.normal[1] + (local.z - v0[2]) * f.normal[2] > CELL * 0.25) {
                inside = false;
                break;
              }
            }
            if (inside) cloud.solid[c] = 1;
          }
    }
  }

  update(dt: number): void {
    this.reshapeTimer -= dt;
    if (this.dirty && this.reshapeTimer <= 0) {
      this.dirty = false;
      this.reshapeTimer = 0.4;
      for (const cloud of this.clouds) {
        this.occupancy(cloud);
        cloud.shadeFromAbove();
        cloud.reshape();
      }
    }
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const cloud = this.clouds[i]!;
      cloud.age += dt;
      if (cloud.age > KINDS[cloud.kind].seconds) this.clouds.splice(i, 1);
    }
    const counts: Record<SmokeKind, number> = { smoke: 0, gas: 0 };
    for (const cloud of this.clouds) {
      const k = KINDS[cloud.kind];
      cloud.grow(Math.ceil((cloud.budget / GROW_SECONDS) * dt));
      // Thin out over the last three seconds.
      const life = Math.min(1, (k.seconds - cloud.age) / 3);
      const out = this.sprites[cloud.kind];
      for (let idx = 0; idx < cloud.order.length; idx++) {
        const c = cloud.order[idx]!;
        // Filled last means the cloud's edge: thinner there, so it has no hard shell.
        const edge = idx / cloud.budget;
        const fringe = 1 - 0.65 * edge * edge;
        const target = cloud.displaced[c]! > 0 ? 0 : 1;
        if (cloud.displaced[c]! > 0) cloud.displaced[c]! -= dt;
        // Fill in fast, clear faster (a blast), come back slowly.
        const rate = target > cloud.density[c]! ? 1.0 : 9;
        cloud.density[c] = THREE.MathUtils.clamp(cloud.density[c]! + Math.sign(target - cloud.density[c]!) * rate * dt, 0, 1);
        const n = counts[cloud.kind]++;
        if (n >= out.alpha.count) break;
        // The same voxel in the same slot as last frame: its position is already there.
        if (out.cell[n] !== c + cloud.id) {
          out.cell[n] = c + cloud.id;
          out.pos.setXYZ(n, cloud.centers[c * 3]!, cloud.centers[c * 3 + 1]!, cloud.centers[c * 3 + 2]!);
        }
        out.alpha.setX(n, cloud.density[c]! * k.alpha * life * fringe);
        out.shade.setX(n, cloud.covered[c] ? 0.62 : 1);
      }
    }
    for (const kind of ['smoke', 'gas'] as const) {
      const s = this.sprites[kind];
      // Never zero instances: one invisible sprite under the ground keeps the shader compiled from load on.
      if (counts[kind] === 0) {
        s.pos.setXYZ(0, 0, -60, 0);
        s.alpha.setX(0, 0);
        s.cell[0] = -1;
      }
      s.sprite.count = Math.max(1, counts[kind]);
      s.pos.needsUpdate = true;
      s.alpha.needsUpdate = true;
      s.shade.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const s of Object.values(this.sprites)) {
      s.sprite.material.dispose();
      this.object.remove(s.sprite);
    }
  }
}
