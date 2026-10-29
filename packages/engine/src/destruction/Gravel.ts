import * as THREE from 'three/webgpu';
import type { Random } from '../core/Random';
import type { PhysicsWorld } from '../physics/PhysicsWorld';

/**
 * The small stuff: gravel and broken bits thrown off by blasts and by chunks
 * breaking up. Too small and too many to simulate as bodies, so each stone
 * flies ballistically on the CPU and stops on the surface found straight
 * below where it was thrown (a ray into the physics world at spawn). One
 * instanced draw; the oldest stones are reused once the pool is full, so
 * piles keep a gritty layer without growing without bound.
 */

const CAPACITY = 3500;
const MAX_PER_FRAME = 260;
const GRAVITY = 9.81;

/** A lumpy low-poly stone: an icosahedron with its vertices pushed in and out. */
function rockGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const k = 0.7 + ((i * 7919) % 13) / 30;
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * 0.75, pos.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

const DOWN = { x: 0, y: -1, z: 0 };

export class GravelField {
  readonly mesh: THREE.InstancedMesh;
  private readonly physics: PhysicsWorld;
  private readonly random: Random;
  private readonly pos = new Float32Array(CAPACITY * 3);
  private readonly vel = new Float32Array(CAPACITY * 3);
  private readonly floor = new Float32Array(CAPACITY);
  private readonly size = new Float32Array(CAPACITY);
  private readonly spin = new Float32Array(CAPACITY * 3);
  private readonly moving = new Uint8Array(CAPACITY);
  private next = 0;
  private live = 0;
  /** Settled stones re-check what is under them a slice at a time (a floor can fall away). */
  private checkCursor = 0;
  private readonly rayFrom = { x: 0, y: 0, z: 0 };
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(physics: PhysicsWorld, random: Random) {
    this.physics = physics;
    this.random = random;
    const material = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
    this.mesh = new THREE.InstancedMesh(rockGeometry(), material, CAPACITY);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    // Colours up front (concrete greys and paint flecks), so none is created mid-game.
    for (let i = 0; i < CAPACITY; i++) {
      const r = (i * 2654435761) % 1000 / 1000;
      // Linear values matching the chunks: broken concrete, and flecks of the beige paint.
      if (r < 0.65) this.c.setRGB(0.21 + r * 0.12, 0.2 + r * 0.115, 0.185 + r * 0.1);
      else this.c.setRGB(0.6, 0.5, 0.35);
      this.mesh.setColorAt(i, this.c);
      this.mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
    }
  }

  get count(): number {
    return this.live;
  }

  /**
   * Height of the first upward-facing surface below (x, y, z). A ray that
   * starts inside a chunk (a blast point is in the wall it hit) first meets
   * that chunk from the inside: such hits are skipped and the ray goes on.
   */
  private floorBelow(x: number, y: number, z: number): number {
    let top = y;
    for (let tries = 0; tries < 6; tries++) {
      this.rayFrom.x = x;
      this.rayFrom.y = top;
      this.rayFrom.z = z;
      const hit = this.physics.raycast(this.rayFrom, DOWN, 60, { solid: false });
      if (!hit) return 0;
      const at = top - hit.distance;
      if (hit.normal.y > 0.3) return at;
      top = at - 0.01;
    }
    return 0;
  }

  /** Stones thrown this frame (a big collapse shatters dozens of bodies at once). */
  private spawnedThisFrame = 0;

  /** Throw `count` stones from `at`, spreading out at up to `speed` m/s around `dir` (default: up and out). */
  spawn(at: THREE.Vector3, count: number, speed: number, dir: THREE.Vector3 | null = null, sizeScale = 1): void {
    count = Math.min(count, MAX_PER_FRAME - this.spawnedThisFrame);
    if (count <= 0) return;
    this.spawnedThisFrame += count;
    // One ray per burst: every stone in it lands on the surface below the burst for now; the
    // background re-check drops any whose patch of floor isn't really there.
    const floor = this.floorBelow(at.x, at.y + 0.2, at.z);
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % CAPACITY;
      this.live = Math.min(CAPACITY, this.live + 1);
      const o = i * 3;
      this.pos[o] = at.x + (this.random.next() - 0.5) * 0.6;
      this.pos[o + 1] = at.y + (this.random.next() - 0.5) * 0.4;
      this.pos[o + 2] = at.z + (this.random.next() - 0.5) * 0.6;
      const v = this.p.set(this.random.next() - 0.5, this.random.next() * 0.8 + 0.2, this.random.next() - 0.5).normalize();
      if (dir) v.addScaledVector(dir, 1.2).normalize();
      v.multiplyScalar(speed * (0.3 + this.random.next() * 0.7));
      this.vel[o] = v.x;
      this.vel[o + 1] = v.y;
      this.vel[o + 2] = v.z;
      this.spin[o] = (this.random.next() - 0.5) * 12;
      this.spin[o + 1] = (this.random.next() - 0.5) * 12;
      this.spin[o + 2] = (this.random.next() - 0.5) * 12;
      this.size[i] = (0.035 + this.random.next() ** 2 * 0.11) * sizeScale;
      this.floor[i] = floor;
      this.moving[i] = 1;
    }
    this.mesh.count = this.live;
  }

  update(dt: number, time: number): void {
    this.spawnedThisFrame = 0;
    let changed = false;
    // A slice of the resting stones per frame: if the surface under one has gone, it falls to the next.
    for (let n = 0; n < 120 && this.live > 0; n++) {
      const i = (this.checkCursor = (this.checkCursor + 1) % this.live);
      if (this.moving[i]) continue;
      const o = i * 3;
      const below = this.floorBelow(this.pos[o]!, this.floor[i]! + 0.02, this.pos[o + 2]!);
      if (below < this.floor[i]! - 0.05) {
        this.floor[i] = below;
        this.vel[o] = this.vel[o + 1] = this.vel[o + 2] = 0;
        this.moving[i] = 1;
      }
    }
    for (let i = 0; i < this.live; i++) {
      if (!this.moving[i]) continue;
      changed = true;
      const o = i * 3;
      this.vel[o + 1]! -= GRAVITY * dt;
      this.pos[o]! += this.vel[o]! * dt;
      this.pos[o + 1]! += this.vel[o + 1]! * dt;
      this.pos[o + 2]! += this.vel[o + 2]! * dt;
      const r = this.size[i]!;
      if (this.pos[o + 1]! < this.floor[i]! + r * 0.6) {
        this.pos[o + 1] = this.floor[i]! + r * 0.6;
        // A small skip, then rest.
        if (this.vel[o + 1]! < -2.5) {
          this.vel[o + 1] = -this.vel[o + 1]! * 0.25;
          this.vel[o]! *= 0.4;
          this.vel[o + 2]! *= 0.4;
        } else this.moving[i] = 0;
      }
      const t = this.moving[i] ? time : 0;
      this.e.set(this.spin[o]! * t + i, this.spin[o + 1]! * t + i * 1.3, this.spin[o + 2]! * t);
      this.mesh.setMatrixAt(i, this.m.compose(this.p.set(this.pos[o]!, this.pos[o + 1]!, this.pos[o + 2]!), this.q.setFromEuler(this.e), this.s.set(r, r, r)));
    }
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
