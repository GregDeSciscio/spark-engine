import * as THREE from 'three/webgpu';
import type { Connection } from './core/connections';
import { rng } from './core/math';

/** Most stubs at once; past it the oldest are reused. */
const STUBS = 3000;
/** Most hinge bars drawn at once (links × their anchors, a few bars each). */
const SPANS = 1200;
const RADIUS = 0.014;

const _m = new THREE.Matrix4();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** A unit bar along +y from the origin, a few sides (it is 2.8 cm thick). */
function barGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(RADIUS, RADIUS, 1, 5, 1, false);
  g.translate(0, 0.5, 0);
  return g;
}

/** A bar from `a` to `b`. */
function barMatrix(a: THREE.Vector3, b: THREE.Vector3, out: THREE.Matrix4): THREE.Matrix4 {
  _d.subVectors(b, a);
  const length = _d.length();
  if (length < 1e-4) return out.makeScale(0, 0, 0);
  _q.setFromUnitVectors(UP, _d.divideScalar(length));
  return out.compose(a, _q, _s.set(1, length, 1));
}

/**
 * Rebar: the steel left sticking out of broken concrete, and the bars a hanging piece hangs by.
 *
 * - **Stubs.** When a glued contact breaks, a few short bars stick out of its patch on both sides,
 *   bent a little off the contact normal. Each is fixed in its chunk's rest frame and rides on the
 *   chunk's matrix (`follow`); it is hidden while the neighbour still fills the space it sticks
 *   into, and shows once that neighbour falls away or is blown out.
 * - **Spans.** Every live hinge is drawn as bars running through its pivot from inside one piece to
 *   inside the other (`setSpans`): what a hanging slab hangs by, bending as it swings.
 */
export class Rebar {
  readonly stubs: THREE.InstancedMesh;
  readonly spans: THREE.InstancedMesh;
  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly connections: readonly Connection[];
  private readonly random: () => number;
  /** Per stub slot: its chunk (-1 free) and its bar in that chunk's rest frame. */
  private readonly stubPiece = new Int32Array(STUBS).fill(-1);
  private readonly stubRest: THREE.Matrix4[] = Array.from({ length: STUBS }, () => new THREE.Matrix4());
  /** Chunk → its stub slots. */
  private readonly byPiece = new Map<number, number[]>();
  /** Contacts that already have their stubs. */
  private readonly done = new Set<number>();
  private next = 0;
  private used = 0;

  constructor(connections: readonly Connection[], seed = 7) {
    this.connections = connections;
    this.random = rng(seed);
    const geometry = barGeometry();
    this.material = new THREE.MeshStandardNodeMaterial({ color: 0x4d3a2e, roughness: 0.55, metalness: 0.6 });
    this.stubs = new THREE.InstancedMesh(geometry, this.material, STUBS);
    this.spans = new THREE.InstancedMesh(geometry, this.material, SPANS);
    for (const mesh of [this.stubs, this.spans]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
  }

  /** Glued contacts that just broke (or lost one side): stubs out of their patches. */
  broke(conns: Iterable<number>): void {
    let changed = false;
    for (const c of conns) {
      if (this.done.has(c)) continue;
      this.done.add(c);
      const k = this.connections[c]!;
      if (k.b < 0 || k.area < 0.03) continue; // ground contacts and slivers have none
      const n = Math.min(4, Math.max(1, Math.round(k.area * 10)));
      // The patch's extent along its own axes, to keep the bars inside it.
      let u0 = Infinity;
      let u1 = -Infinity;
      let v0 = Infinity;
      let v1 = -Infinity;
      for (const [u, v] of k.poly) {
        u0 = Math.min(u0, u);
        u1 = Math.max(u1, u);
        v0 = Math.min(v0, v);
        v1 = Math.max(v1, v);
      }
      for (let i = 0; i < n; i++) {
        const u = u0 + (u1 - u0) * (0.2 + 0.6 * this.random());
        const v = v0 + (v1 - v0) * (0.2 + 0.6 * this.random());
        _a.set(...k.point)
          .addScaledVector(_b.set(...k.e1), u)
          .addScaledVector(_d.set(...k.e2), v);
        // One stub each way: out of a toward where b was, and out of b back toward a.
        for (const [piece, sign] of [
          [k.a, 1],
          [k.b, -1],
        ] as const) {
          // Bent off the normal along the patch's long side only: across the short side (a wall's
          // thickness) a tilted bar pokes out of the wall's faces where nothing is broken.
          const dir = _b.set(...k.normal).multiplyScalar(sign);
          const long = u1 - u0 >= v1 - v0 ? k.e1 : k.e2;
          const short = long === k.e1 ? k.e2 : k.e1;
          const bend = (this.random() - 0.5) * 0.6;
          const lean = (this.random() - 0.5) * 0.08;
          dir.x += long[0] * bend + short[0] * lean;
          dir.y += long[1] * bend + short[1] * lean;
          dir.z += long[2] * bend + short[2] * lean;
          dir.normalize();
          const length = 0.15 + this.random() * 0.3;
          // From a little inside the chunk, so the stub comes out of its face rather than off it.
          _from.copy(_a).addScaledVector(dir, -0.04);
          this.addStub(piece, barMatrix(_from, _to.copy(_from).addScaledVector(dir, length + 0.04), _m));
        }
        changed = true;
      }
    }
    if (changed) this.stubs.instanceMatrix.needsUpdate = true;
  }

  private addStub(piece: number, rest: THREE.Matrix4): void {
    const slot = this.next;
    this.next = (this.next + 1) % STUBS;
    const old = this.stubPiece[slot]!;
    if (old >= 0) {
      const list = this.byPiece.get(old)!;
      list.splice(list.indexOf(slot), 1);
    }
    this.stubPiece[slot] = piece;
    this.stubRest[slot]!.copy(rest);
    const list = this.byPiece.get(piece);
    if (list) list.push(slot);
    else this.byPiece.set(piece, [slot]);
    // Where the chunk is now: standing chunks are in their rest pose.
    this.stubs.setMatrixAt(slot, rest);
    this.used = Math.min(STUBS, this.used + 1);
    this.stubs.count = this.used;
  }

  /** A chunk moved (its rest → world matrix), or is gone (null). */
  follow(piece: number, world: THREE.Matrix4 | null): void {
    const slots = this.byPiece.get(piece);
    if (!slots || slots.length === 0) return;
    for (const slot of slots) this.stubs.setMatrixAt(slot, world ? _m.multiplyMatrices(world, this.stubRest[slot]!) : _m.makeScale(0, 0, 0));
    this.stubs.instanceMatrix.needsUpdate = true;
  }

  /** The hinge bars this frame: pairs of world points, one bar from each first to each second. */
  setSpans(points: readonly number[]): void {
    const count = Math.min(SPANS, Math.floor(points.length / 6));
    for (let i = 0; i < count; i++) {
      const o = i * 6;
      _from.set(points[o]!, points[o + 1]!, points[o + 2]!);
      _to.set(points[o + 3]!, points[o + 4]!, points[o + 5]!);
      this.spans.setMatrixAt(i, barMatrix(_from, _to, _m));
    }
    this.spans.count = count;
    if (count > 0) this.spans.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.stubs.geometry.dispose();
    this.material.dispose();
    this.stubs.dispose();
    this.spans.dispose();
  }
}
