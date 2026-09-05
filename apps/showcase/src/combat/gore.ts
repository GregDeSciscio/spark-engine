import * as THREE from 'three/webgpu';
import { float, length, mx_noise_float, smoothstep, uv, vec2, vec3 } from 'three/tsl';
import { Decals, DisposeBag, Transform, prepareDecalMaterial, type Entity, type EntityWorld, type ParticleSystem, type PhysicsWorld, type Random } from '@spark/engine';

/**
 * Gore tier one (docs/design/gore-scope.md): blood sprays from hits as GPU
 * particles, splatter decals on whatever is behind the target, drips on the
 * floor under the hit, and a pool that grows under a corpse over a few
 * seconds. Everything here is presentation; nothing reads it back.
 *
 * Caps: one decal pool of 64 for splatter and drips, 24 for corpse pools
 * (three growth steps per body), so the oldest recycle. Per-character wound
 * masks wait for real character art with a UV layout; until then the actor
 * tints its material toward blood as health drops.
 */
export interface GoreDeps {
  readonly entities: EntityWorld;
  readonly vfx: ParticleSystem;
  readonly scene: THREE.Scene;
  readonly physics: PhysicsWorld;
  readonly random: Random;
  /** Level meshes by physics entity, for clipping decals. */
  readonly worldMeshes: ReadonlyMap<Entity, THREE.Mesh>;
}

const SPLATTER_REACH = 2.6;
const DRIP_REACH = 2.2;
/** Size and delay of each growth step of a corpse pool. */
const POOL_STEPS: readonly { readonly at: number; readonly size: number }[] = [
  { at: 1.0, size: 0.45 },
  { at: 2.2, size: 0.8 },
  { at: 3.8, size: 1.15 },
];

function bloodMaterial(seed: number, edge: number): THREE.MeshStandardNodeMaterial {
  const m = prepareDecalMaterial(new THREE.MeshStandardNodeMaterial());
  m.color.setHex(0x3a0409);
  m.roughness = 0.25;
  m.metalness = 0;
  // A ragged blob: the disc edge is pushed around by low-frequency noise.
  const p = uv().sub(vec2(0.5, 0.5));
  const n = mx_noise_float(vec3(uv().mul(5.0), float(seed)));
  m.opacityNode = smoothstep(float(0.5), float(edge), length(p).add(n.mul(0.16)));
  return m;
}

interface PendingPool {
  readonly position: () => THREE.Vector3;
  readonly startedAt: number;
  step: number;
}

export class Gore {
  private readonly deps: GoreDeps;
  private readonly bag = new DisposeBag();
  private readonly marks: Decals;
  private readonly pools: Decals;
  private readonly splatter: THREE.MeshStandardNodeMaterial;
  private readonly drip: THREE.MeshStandardNodeMaterial;
  private readonly pool: THREE.MeshStandardNodeMaterial;
  private readonly bloodEid: Entity | null;
  private readonly pending: PendingPool[] = [];
  private readonly down = new THREE.Vector3(0, -1, 0);
  private readonly tmp = new THREE.Vector3();
  private readonly hit = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private now = 0;

  constructor(deps: GoreDeps) {
    this.deps = deps;
    this.marks = new Decals(deps.scene, { dynamicCapacity: 64 });
    this.pools = new Decals(deps.scene, { dynamicCapacity: 24 });
    this.bag.add(this.marks);
    this.bag.add(this.pools);
    this.splatter = bloodMaterial(3, 0.28);
    this.drip = bloodMaterial(11, 0.34);
    this.pool = bloodMaterial(7, 0.36);
    this.bag.add(() => {
      this.splatter.dispose();
      this.drip.dispose();
      this.pool.dispose();
    });
    const eid = deps.entities.create(Transform);
    this.bag.add(() => deps.entities.destroy(eid));
    const handle = deps.vfx.spawnEmitter(eid, 'blood');
    if (handle) {
      deps.scene.add(handle.object);
      this.bag.add(() => deps.scene.remove(handle.object));
      this.bloodEid = eid;
    } else this.bloodEid = null;
  }

  /** A bullet went into a character at `point` travelling along `direction`. */
  characterHit(point: THREE.Vector3, direction: THREE.Vector3, heavy = false): void {
    const { vfx, physics, random, worldMeshes } = this.deps;
    if (this.bloodEid !== null) vfx.burstAt(this.bloodEid, point, direction, heavy ? 28 : 14);
    // Splatter on what is behind the target, along the shot.
    const behind = physics.raycast(point, direction, SPLATTER_REACH, { layers: 'world' });
    if (behind) {
      const mesh = worldMeshes.get(behind.eid);
      if (mesh) {
        this.hit.set(behind.point.x, behind.point.y, behind.point.z);
        this.normal.set(behind.normal.x, behind.normal.y, behind.normal.z);
        const size = random.range(0.3, 0.55) * (heavy ? 1.4 : 1) * (1 - 0.5 * (behind.distance / SPLATTER_REACH));
        this.marks.spawn({ position: this.hit, normal: this.normal, size, rotation: random.range(0, Math.PI * 2), target: mesh, material: this.splatter });
      }
    }
    // Drips on the floor under the wound.
    if (random.next() < 0.6) {
      const floor = physics.raycast(point, this.down, DRIP_REACH, { layers: 'world' });
      if (floor) {
        const mesh = worldMeshes.get(floor.eid);
        if (mesh) {
          this.hit.set(floor.point.x + random.range(-0.15, 0.15), floor.point.y, floor.point.z + random.range(-0.15, 0.15));
          this.normal.set(floor.normal.x, floor.normal.y, floor.normal.z);
          this.marks.spawn({ position: this.hit, normal: this.normal, size: random.range(0.12, 0.28), rotation: random.range(0, Math.PI * 2), target: mesh, material: this.drip });
        }
      }
    }
  }

  /** A body came to rest somewhere: grow a pool under `position()` over the next seconds (the callback follows a settling ragdoll). */
  corpse(position: () => THREE.Vector3): void {
    this.pending.push({ position, startedAt: this.now, step: 0 });
  }

  fixedUpdate(dt: number): void {
    this.now += dt;
    const { physics, worldMeshes, random } = this.deps;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i] as PendingPool;
      const step = POOL_STEPS[p.step];
      if (!step) {
        this.pending.splice(i, 1);
        continue;
      }
      if (this.now - p.startedAt < step.at) continue;
      p.step += 1;
      const from = p.position();
      this.tmp.set(from.x, from.y + 0.3, from.z);
      const floor = physics.raycast(this.tmp, this.down, 2.5, { layers: 'world' });
      if (!floor) continue;
      const mesh = worldMeshes.get(floor.eid);
      if (!mesh) continue;
      this.hit.set(floor.point.x, floor.point.y, floor.point.z);
      this.normal.set(floor.normal.x, floor.normal.y, floor.normal.z);
      this.pools.spawn({ position: this.hit, normal: this.normal, size: step.size * random.range(0.9, 1.1), rotation: random.range(0, Math.PI * 2), target: mesh, material: this.pool });
    }
  }

  dispose(): void {
    this.bag.dispose();
  }
}
