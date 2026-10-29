import * as THREE from 'three/webgpu';
import { Random } from '../core/Random';
import type { Entity } from '../ecs/EntityWorld';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { BodyHandle, ColliderHandle, QuatLike, Vec3Like } from '../physics/types';
import type { Piece } from './core/pieces';

/**
 * The debris layer: physics bodies for everything that has come loose, and
 * the rubble it settles into.
 *
 * A chunk is in one of four places: standing (a collider on the fixed
 * building body), loose (a dynamic body, alone or with the rest of its
 * island), rubble (settled: a collider on a fixed rubble body, so piles cost
 * nothing to simulate and stay where they fell), or gone.
 *
 * Every collider is owned by the structure's entity with the chunk's id as
 * its part (ADR-010), so a game's raycast names the building and the chunk.
 * Each chunk's convex shape is built once, from its faces, relative to its
 * centroid; a body places it with a collider offset.
 */

export interface DebrisSettings {
  /** kg/m³ of loose chunks. */
  density: number;
  /** A multi-chunk body shatters when its velocity changes this much in one step (an impact). */
  shatterDeltaV: number;
  /** It breaks into clusters of the chunks that share a cell this size (m) of their rest pose; 0: every chunk alone. */
  shatterCell: number;
  /** Most dynamic bodies at once; past it the stillest settle where they are. */
  maxBodies: number;
  /** Fixed steps a body must be still (or asleep) before it settles into rubble. */
  pileAfterTicks: number;
}

export type DebrisOptions = { [K in keyof DebrisSettings]?: DebrisSettings[K] | undefined };

export const DEFAULT_DEBRIS: Readonly<DebrisSettings> = { density: 2400, shatterDeltaV: 3.5, shatterCell: 2, maxBodies: 360, pileAfterTicks: 25 };

/** Velocity clamps for loose bodies (m/s, rad/s). */
const MAX_SPEED = 24;
const MAX_SPIN = 10;
/** Scale of a loose chunk's collision hull about its centroid. */
export const HULL_SHRINK = 0.97;
/** Below this (m/s, plus half the spin in rad/s) a body counts as at rest. */
const STILL = 0.12;
/** Clusters thrown faster than this (m/s) get continuous collision too. */
const FAST = 8;
/** Rubble support queries per re-check pass. */
const RECHECKS = 40;
/** Colliders a shatter may move per step; the rest of it breaks out over the next steps. */
const BREAK_COLLIDERS_PER_STEP = 64;
/** A body falling at least this fast (m/s) that one step slows by at least as much has landed on something. */
const LANDING = 2.5;
const FRICTION = 0.8;
const RESTITUTION = 0.05;

/** `Debris.state` of a chunk still part of the structure. */
export const STANDING = -1;
/** `Debris.state` of a chunk destroyed or cleared away. */
export const GONE = -2;
/** `Debris.state` of a chunk settled into rubble. */
export const RUBBLE = -3;

interface Body {
  id: number;
  body: BodyHandle;
  pieces: number[];
  /** Rest-pose point the body frame sits on (the island's centre of mass at rest). */
  origin: THREE.Vector3;
  born: number;
  /** How it came loose: from the structure, broken off another body, what was left of one, or rubble woken. */
  from: BodyOrigin;
  lastVel: THREE.Vector3;
  /** Pose before the last step, for the guard to put it back. */
  lastPos: THREE.Vector3;
  lastRot: THREE.Quaternion;
  /** Throws in a row (a few ticks apart at most), and the tick of the last. */
  streak: number;
  flungAt: number;
  /** Seen below the floor (counted once). */
  sunk: boolean;
  /** Velocity change over the last step (impacts, joints catching). */
  jolt: number;
  /** Speed plus half the spin, last step: how far from still it is. */
  motion: number;
  asleepTicks: number;
}

export type BodyOrigin = 'detach' | 'split' | 'rest' | 'wake';

/** A body the physics step threw faster than anything in a collapse should move (the step guard caught it). */
export interface Fling {
  speed: number;
  from: BodyOrigin;
  pieces: number;
  /** Fixed steps since it was made. */
  age: number;
  held: boolean;
  y: number;
  /** Its first chunk, and the joints (hinges, ropes) on it. */
  piece: number;
  joints: number;
}

/** A body seen going through the floor: how it came loose, how old, how fast. */
export interface Sink {
  from: BodyOrigin;
  pieces: number;
  age: number;
  held: boolean;
  speed: number;
}

/** A body whose centre is this far below the ground's top (m) has gone through it. */
const SUNK = -0.5;
/** Faster than this (m/s) after a step is a throw, not motion: nothing in a collapse gets there (the clamp holds 24, a blast adds 7). */
const FLING = 32;
/** Throws in a row that make a body trapped. */
const TRAPPED = 3;

/** What the loose bodies are doing: asleep, or awake and held by hinges / jointed (ropes) / free, moving or still. */
export interface Census {
  bodies: number;
  asleep: number;
  held: { moving: number; still: number };
  jointed: { moving: number; still: number };
  free: { moving: number; still: number };
  /** The liveliest awake bodies. */
  movers: Array<{ kind: 'held' | 'jointed' | 'free'; speed: number; spin: number; y: number; pieces: number; age: number }>;
}

export interface DebrisHit {
  /** The chunk hit, or −1 for anything that is not part of this structure (the ground). */
  piece: number;
  /** Where the chunk is: STANDING, RUBBLE, or a loose body id. */
  state: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

/** A chunk's convex shape relative to its centroid: full size (standing) and shrunk (loose, rubble). */
interface ChunkShape {
  readonly full: Float32Array;
  readonly shrunk: Float32Array;
  readonly indices: Uint32Array;
  /** What Rapier accepted: the faces as a convex mesh, else the hull of the corners, else nothing. */
  kind: 'mesh' | 'hull' | 'none';
}

function chunkShape(piece: Piece): ChunkShape {
  const [cx, cy, cz] = piece.centroid;
  const n = piece.vertices.length;
  const full = new Float32Array(n * 3);
  const shrunk = new Float32Array(n * 3);
  piece.vertices.forEach((v, i) => {
    full[i * 3] = v[0] - cx;
    full[i * 3 + 1] = v[1] - cy;
    full[i * 3 + 2] = v[2] - cz;
    shrunk[i * 3] = (v[0] - cx) * HULL_SHRINK;
    shrunk[i * 3 + 1] = (v[1] - cy) * HULL_SHRINK;
    shrunk[i * 3 + 2] = (v[2] - cz) * HULL_SHRINK;
  });
  // Faces wind counter-clockwise around their outward normals, so a fan keeps every triangle outward.
  const tris: number[] = [];
  for (const face of piece.faces) {
    const [a, ...rest] = face.verts;
    for (let i = 0; i + 1 < rest.length; i++) tris.push(a!, rest[i]!, rest[i + 1]!);
  }
  return { full, shrunk, indices: Uint32Array.from(tris), kind: 'mesh' };
}

const _m = new THREE.Matrix4();
const _shift = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);
const ZERO: Vec3Like = { x: 0, y: 0, z: 0 };
const _t: Vec3Like = { x: 0, y: 0, z: 0 };
const _t2: Vec3Like = { x: 0, y: 0, z: 0 };
const _r: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
const _lv: Vec3Like = { x: 0, y: 0, z: 0 };
const _av: Vec3Like = { x: 0, y: 0, z: 0 };

export class Debris {
  readonly options: DebrisSettings;
  readonly physics: PhysicsWorld;
  /** The structure's entity: owner of every collider here. */
  readonly owner: Entity;
  private readonly pieces: readonly Piece[];
  private readonly random: Random;
  private readonly shapes: ChunkShape[];
  /** Holds every standing chunk's collider (fixed, sharded and massless: ADR-010). */
  readonly building: BodyHandle;
  /** Holds every settled chunk's collider. */
  readonly rubble: BodyHandle;
  /** The chunk's collider wherever it is (0: none). */
  private readonly collider: Float64Array;
  /** Rest → world for rubble chunks. */
  private readonly rubblePose: Array<THREE.Matrix4 | null>;
  private readonly bodies = new Map<number, Body>();
  /** Chunks that changed body since `takeMoved` last ran. */
  private readonly moved = new Set<number>();
  /** Shatters still breaking out, oldest first (`breakPending`). */
  private readonly breakQueue: Array<{ body: number; groups: number[][] }> = [];
  private readonly byHandle = new Map<BodyHandle, Body>();
  /** Bumped whenever a chunk changes body (comes loose, splits, settles, wakes, goes): hinges regroup only then. */
  version = 0;
  /** Chunks lying in rubble. */
  private readonly rubbleSet = new Set<number>();
  /** Places something just stopped holding things up; rubble near them re-checks its support for a while. */
  private readonly supportLost: Array<{ x: number; y: number; z: number; until: number }> = [];
  /** Per chunk: STANDING, GONE, RUBBLE, or the id of its loose body. */
  readonly state: Float64Array;
  private tick = 0;
  private nextBodyId = 0;
  /** Bodies created, split, settled and cleared, for the HUD. */
  readonly counters = { created: 0, shattered: 0, piled: 0, cleared: 0, flung: 0, sunk: 0 };
  /** The latest flings, for the soak and probes. */
  readonly flings: Fling[] = [];
  /** Bodies seen going through the floor, for the soak: how they came loose, how old, how fast. */
  readonly sinks: Sink[] = [];
  /** Chunks the budget (or the kill plane) cleared away, so the view can hide them. */
  onGone: ((pieces: readonly number[]) => void) | null = null;
  /** A multi-chunk body just broke up on impact (its glue can become a net of hinges). */
  onShatter: ((pieces: readonly number[]) => void) | null = null;
  /** Landings this step that did not shatter anything: where the hardest was, the mass of all that landed, and how fast the hardest came down. */
  onLand: ((at: THREE.Vector3, mass: number, speed: number) => void) | null = null;
  /** Chunks that just settled into rubble (their final matrix must be written once); `alone` if they were a single-chunk body. */
  onSettle: ((pieces: readonly number[], alone: boolean) => void) | null = null;
  /** A body kept being thrown: whatever holds it (hinges) should let go. */
  onTrapped: ((body: BodyHandle) => void) | null = null;
  /** May this body settle? (False while hinges hold it.) */
  canPile: (bodyId: number) => boolean = () => true;
  /** Rubble queued for a support check. */
  private recheckQueue: number[] = [];

  constructor(physics: PhysicsWorld, owner: Entity, pieces: readonly Piece[], options: DebrisOptions = {}, random: Random = new Random(1)) {
    const o = { ...DEFAULT_DEBRIS };
    for (const k of Object.keys(o) as Array<keyof DebrisSettings>) o[k] = options[k] ?? o[k];
    this.options = o;
    this.physics = physics;
    this.owner = owner;
    this.pieces = pieces;
    this.random = random;
    this.shapes = pieces.map(chunkShape);
    this.building = physics.bodies.create({ type: 'fixed' });
    this.rubble = physics.bodies.create({ type: 'fixed' });
    this.collider = new Float64Array(pieces.length);
    for (const p of pieces) {
      _t.x = p.centroid[0];
      _t.y = p.centroid[1];
      _t.z = p.centroid[2];
      this.collider[p.id] = this.addChunkCollider(this.building, p.id, false, _t);
    }
    this.rubblePose = pieces.map(() => null);
    this.state = new Float64Array(pieces.length).fill(STANDING);
  }

  /**
   * Put a chunk's collider on `body` at `position` (and `rotation`) in its
   * frame. Loose and settled chunks get the shrunk shape, so neighbours that
   * come away together don't start out pressed against each other (or
   * against the edge a hinge pivots on).
   */
  private addChunkCollider(body: BodyHandle, piece: number, shrunk: boolean, position: Vec3Like, rotation?: QuatLike, density?: number): ColliderHandle | 0 {
    const shape = this.shapes[piece]!;
    const vertices = shrunk ? shape.shrunk : shape.full;
    const base = { owner: this.owner, part: piece, position, rotation, density, friction: FRICTION, restitution: RESTITUTION };
    const bodies = this.physics.bodies;
    if (shape.kind === 'mesh') {
      try {
        return bodies.addCollider(body, { ...base, shape: { kind: 'convexMesh', vertices, indices: shape.indices } });
      } catch {
        shape.kind = 'hull'; // a sliver Rapier won't take as a mesh: its hull, from now on
      }
    }
    if (shape.kind === 'hull') {
      try {
        return bodies.addCollider(body, { ...base, shape: { kind: 'convexHull', points: vertices } });
      } catch {
        shape.kind = 'none';
      }
    }
    return 0;
  }

  get bodyCount(): number {
    return this.bodies.size;
  }

  get sleepingCount(): number {
    let n = 0;
    for (const b of this.bodies.values()) if (this.physics.bodies.isSleeping(b.body)) n++;
    return n;
  }

  census(): Census {
    const c: Census = { bodies: this.bodies.size, asleep: 0, held: { moving: 0, still: 0 }, jointed: { moving: 0, still: 0 }, free: { moving: 0, still: 0 }, movers: [] };
    const { bodies, joints } = this.physics;
    const movers: Array<[number, Census['movers'][number]]> = [];
    for (const b of this.bodies.values()) {
      if (bodies.isSleeping(b.body)) {
        c.asleep++;
        continue;
      }
      const name = !this.canPile(b.id) ? 'held' : joints.countOf(b.body) > 0 ? 'jointed' : 'free';
      const kind = c[name];
      if (b.motion < STILL) kind.still++;
      else kind.moving++;
      bodies.velocity(b.body, _lv, _av);
      bodies.centerOfMass(b.body, _t);
      movers.push([b.motion, { kind: name, speed: +Math.hypot(_lv.x, _lv.y, _lv.z).toFixed(2), spin: +Math.hypot(_av.x, _av.y, _av.z).toFixed(2), y: +_t.y.toFixed(2), pieces: b.pieces.length, age: this.tick - b.born }]);
    }
    c.movers = movers
      .sort((a, b) => b[0] - a[0])
      .slice(0, 14)
      .map(([, m]) => m);
    return c;
  }

  /** Health check: loose bodies with a non-finite pose or speed, the fastest speed, and the lowest point. */
  sanity(): { nonFinite: number; maxSpeed: number; minY: number } {
    let nonFinite = 0;
    let maxSpeed = 0;
    let minY = Infinity;
    const bodies = this.physics.bodies;
    for (const b of this.bodies.values()) {
      // The centre of mass, not the body's frame: a body that lost chunks keeps a frame that can sit away from them.
      bodies.centerOfMass(b.body, _t);
      bodies.velocity(b.body, _lv);
      const speed = Math.hypot(_lv.x, _lv.y, _lv.z);
      if (![_t.x, _t.y, _t.z, speed].every(Number.isFinite)) nonFinite++;
      else {
        maxSpeed = Math.max(maxSpeed, speed);
        minY = Math.min(minY, _t.y);
      }
    }
    return { nonFinite, maxSpeed, minY: Number.isFinite(minY) ? minY : 0 };
  }

  /** Pieces that changed body (standing, loose body, rubble, gone) since the last call, for hinge regrouping. */
  takeMoved(): number[] {
    const out = [...this.moved];
    this.moved.clear();
    return out;
  }

  private setState(piece: number, state: number): void {
    this.state[piece] = state;
    this.moved.add(piece);
  }

  /** The body a chunk belongs to now (the building, the rubble, or its loose body), or null if it is gone. */
  bodyOf(piece: number): BodyHandle | null {
    const s = this.state[piece]!;
    if (s === STANDING) return this.building;
    if (s === RUBBLE) return this.rubble;
    if (s === GONE) return null;
    return this.bodies.get(s)?.body ?? null;
  }

  /** The chunk's collider now (standing, loose or rubble), or null if it has none. */
  colliderOf(piece: number): ColliderHandle | null {
    const c = this.collider[piece]!;
    return c > 0 ? (c as ColliderHandle) : null;
  }

  /** How hard a loose body was jolted last step (m/s of velocity change); 0 for fixed bodies. */
  joltOf(body: BodyHandle): number {
    return this.byHandle.get(body)?.jolt ?? 0;
  }

  /** Loose body record by id. */
  body(id: number): { body: BodyHandle; pieces: readonly number[]; jolt: number } | undefined {
    return this.bodies.get(id);
  }

  /** Rest → world for a chunk where it is now (identity while standing). */
  restToWorld(piece: number, out: THREE.Matrix4): THREE.Matrix4 {
    const s = this.state[piece]!;
    if (s === RUBBLE) return out.copy(this.rubblePose[piece]!);
    const b = s >= 0 ? this.bodies.get(s) : undefined;
    if (!b) return out.identity();
    this.physics.bodies.pose(b.body, _t, _r);
    out.compose(_p.set(_t.x, _t.y, _t.z), _q.set(_r.x, _r.y, _r.z, _r.w), ONE);
    return out.multiply(_shift.makeTranslation(-b.origin.x, -b.origin.y, -b.origin.z));
  }

  /** Something at this chunk stopped holding things up (it fell, broke away or was destroyed). */
  private lostSupport(piece: number): void {
    const [x, y, z] = this.pieces[piece]!.centroid;
    const pose = this.state[piece] === RUBBLE ? this.rubblePose[piece] : null;
    const at = new THREE.Vector3(x, y, z);
    if (pose) at.applyMatrix4(pose);
    for (let i = this.supportLost.length - 1; i >= Math.max(0, this.supportLost.length - 40); i--) {
      const e = this.supportLost[i]!;
      if (Math.abs(e.x - at.x) < 1.5 && Math.abs(e.y - at.y) < 1.5 && Math.abs(e.z - at.z) < 1.5) {
        e.until = this.tick + 240;
        return;
      }
    }
    this.supportLost.push({ x: at.x, y: at.y, z: at.z, until: this.tick + 240 });
  }

  /**
   * Is this rubble chunk still resting on something? Its hull, moved down a few
   * centimetres, must meet standing structure, or a collider lower than itself
   * (the ground, rubble beneath it), not just a rubble neighbour beside it.
   */
  private supported(piece: number): boolean {
    const c = this.colliderOf(piece);
    if (c === null) return true;
    const bodies = this.physics.bodies;
    const t = { x: 0, y: 0, z: 0 };
    const r = { x: 0, y: 0, z: 0, w: 1 };
    if (!bodies.colliderPose(c, t, r)) return true;
    let held = false;
    this.physics.overlapShape(
      c,
      { position: { x: t.x, y: t.y - 0.06, z: t.z }, rotation: r },
      (other) => {
        // Any standing chunk it rests on or against holds it (the sandbox's rule since its first
        // rubble: there the building's hulls were in world coordinates, so they all sat at y = 0).
        // Anything else holds it if that chunk is lower: by where the chunk is, not its body's frame,
        // which (for a body that lost chunks) can sit metres away and held rubble up in mid-air.
        const info = bodies.info(other);
        if (!info) return true;
        const below = info.body === this.building || (bodies.colliderPose(other, _t2) && _t2.y < t.y - 0.05);
        if (below) {
          held = true;
          return false;
        }
        return true;
      },
      { excludeCollider: c },
    );
    return held;
  }

  /**
   * Rubble near a recent loss of support that nothing holds up any more falls
   * again. Candidates are gathered when the losses change; each pass then
   * shape-queries at most `RECHECKS` of them (a collapse can put hundreds near
   * a loss, and every query is a call into the physics module).
   */
  private recheckRubble(): void {
    for (let i = this.supportLost.length - 1; i >= 0; i--) if (this.supportLost[i]!.until < this.tick) this.supportLost.splice(i, 1);
    if (this.supportLost.length === 0 || this.rubbleSet.size === 0) {
      this.recheckQueue.length = 0;
      return;
    }
    if (this.recheckQueue.length === 0) {
      const at = new THREE.Vector3();
      for (const p of this.rubbleSet) {
        const c = this.pieces[p]!.centroid;
        at.set(c[0], c[1], c[2]).applyMatrix4(this.rubblePose[p]!);
        if (this.supportLost.some((e) => Math.abs(e.x - at.x) < 3.5 && Math.abs(e.z - at.z) < 3.5 && at.y > e.y - 1)) this.recheckQueue.push(p);
      }
    }
    const batch = this.recheckQueue.splice(0, RECHECKS);
    for (const p of batch) if (this.state[p] === RUBBLE && !this.supported(p)) this.wake(p);
  }

  /** The chunk leaves the building or the rubble: its fixed collider goes. */
  private dropFixed(piece: number): void {
    this.version++;
    const s = this.state[piece];
    const c = this.collider[piece]!;
    if (c > 0 && (s === STANDING || s === RUBBLE)) {
      this.lostSupport(piece);
      this.physics.bodies.removeCollider(c as ColliderHandle, false);
      this.collider[piece] = 0;
    }
    this.rubbleSet.delete(piece);
    this.rubblePose[piece] = null;
  }

  /** A chunk is gone for good (pulverized, or cleared by the budget). */
  remove(piece: number): void {
    const s = this.state[piece]!;
    if (s >= 0) {
      const b = this.bodies.get(s);
      if (b && b.pieces.length > 1) this.split(b, [piece]);
      const own = this.bodies.get(this.state[piece]!);
      if (own) this.removeBody(own);
      this.collider[piece] = 0;
    }
    this.dropFixed(piece);
    this.setState(piece, GONE);
  }

  /**
   * Turn standing chunks into one loose body (a strain island, or one element
   * of it), at rest or with a velocity given at its centre of mass.
   */
  detach(group: readonly number[], linvel?: (center: THREE.Vector3) => THREE.Vector3): number {
    const live = group.filter((p) => this.state[p] === STANDING);
    if (live.length === 0) return -1;
    let mass = 0;
    const com = new THREE.Vector3();
    for (const p of live) {
      const piece = this.pieces[p]!;
      mass += piece.mass;
      com.x += piece.centroid[0] * piece.mass;
      com.y += piece.centroid[1] * piece.mass;
      com.z += piece.centroid[2] * piece.mass;
    }
    com.divideScalar(mass);
    const v = linvel ? linvel(com) : new THREE.Vector3();
    // Continuous collision for single chunks (a later blast can make any of them fast) and anything
    // thrown fast; big clusters are too slow and too large to tunnel.
    const body = this.physics.bodies.create({ type: 'dynamic', position: com, linearVelocity: v, ccd: live.length === 1 || v.length() > FAST });
    const id = this.nextBodyId++;
    for (const p of live) {
      this.dropFixed(p);
      this.collider[p] = this.addChunkCollider(body, p, true, this.offset(p, com), undefined, this.options.density);
      this.setState(p, id);
    }
    this.addBody({ id, body, pieces: live, origin: com, born: this.tick, from: 'detach', lastVel: v.clone(), jolt: 0, motion: 1, asleepTicks: 0 });
    this.counters.created++;
    return id;
  }

  /** Where a chunk's centroid sits in a body whose frame is at `origin` of the rest pose (unrotated). */
  private offset(piece: number, origin: THREE.Vector3): Vec3Like {
    const c = this.pieces[piece]!.centroid;
    return { x: c[0] - origin.x, y: c[1] - origin.y, z: c[2] - origin.z };
  }

  /**
   * An explosion's blast wave: loose bodies within `radius` are pushed away
   * from `center`, and rubble within it is shaken loose again.
   */
  blast(center: THREE.Vector3, radius: number, speed: number): void {
    const d = new THREE.Vector3();
    for (let p = 0; p < this.pieces.length; p++) {
      if (this.state[p] !== RUBBLE) continue;
      const pose = this.rubblePose[p]!;
      const c = this.pieces[p]!.centroid;
      d.set(c[0], c[1], c[2]).applyMatrix4(pose);
      if (d.distanceTo(center) < radius * 0.7) this.wake(p);
    }
    const bodies = this.physics.bodies;
    for (const b of this.bodies.values()) {
      bodies.centerOfMass(b.body, _t);
      d.set(_t.x, _t.y, _t.z).sub(center);
      const dist = d.length();
      if (dist > radius) continue;
      const falloff = 1 - dist / radius;
      const m = bodies.mass(b.body);
      d.normalize().multiplyScalar(speed * falloff * m);
      d.y += 0.35 * speed * falloff * m;
      const r = this.random;
      bodies.applyImpulse(b.body, d, { x: (r.next() - 0.5) * m, y: (r.next() - 0.5) * m, z: (r.next() - 0.5) * m });
    }
  }

  /** Settled chunk back to a loose body where it lies. */
  private wake(piece: number): void {
    const pose = this.rubblePose[piece]!;
    pose.decompose(_p, _q, _s);
    const [cx, cy, cz] = this.pieces[piece]!.centroid;
    const center = new THREE.Vector3(cx, cy, cz).applyMatrix4(pose);
    this.dropFixed(piece);
    this.setState(piece, STANDING); // transient, so loose() accepts it
    this.loose(piece, center, _q.clone(), new THREE.Vector3(), new THREE.Vector3(), 'wake');
  }

  /**
   * Before each physics step: split bodies that just hit something, settle
   * still ones into rubble, and keep to the budget by settling the stillest
   * and oldest first (debris in heaps and nets rarely meets Rapier's own
   * sleep thresholds, so "still" is judged here).
   */
  fixedUpdate(): void {
    this.tick++;
    this.guard();
    const bodies = this.physics.bodies;
    const v = new THREE.Vector3();
    const toSplit: Body[] = [];
    const toPile: Body[] = [];
    const { pileAfterTicks, shatterDeltaV } = this.options;
    let landed: Body | null = null;
    let landedHit = 0;
    let landedSpeed = 0;
    let landedMass = 0;
    for (const b of this.bodies.values()) {
      // Asleep: nothing to read or clamp (every getter is a call into the physics module).
      if (bodies.isSleeping(b.body)) {
        b.jolt = 0;
        if (++b.asleepTicks >= pileAfterTicks && this.canPile(b.id)) toPile.push(b);
        continue;
      }
      bodies.velocity(b.body, _lv, _av);
      v.set(_lv.x, _lv.y, _lv.z);
      // Fast but believable (a blast on something already flying): held to a ceiling.
      if (v.lengthSq() > MAX_SPEED * MAX_SPEED) {
        v.setLength(MAX_SPEED);
        bodies.setVelocity(b.body, v);
      }
      const spin = Math.hypot(_av.x, _av.y, _av.z);
      if (spin > MAX_SPIN) bodies.setVelocity(b.body, null, { x: (_av.x * MAX_SPIN) / spin, y: (_av.y * MAX_SPIN) / spin, z: (_av.z * MAX_SPIN) / spin });
      b.jolt = v.distanceTo(b.lastVel);
      if (b.pieces.length > 1 && this.tick - b.born > 6 && b.jolt > shatterDeltaV) toSplit.push(b);
      else if (-b.lastVel.y > LANDING && v.y - b.lastVel.y > LANDING) {
        const mass = bodies.mass(b.body);
        landedMass += mass;
        const hit = mass * (v.y - b.lastVel.y);
        if (hit > landedHit) [landed, landedHit, landedSpeed] = [b, hit, -b.lastVel.y];
      }
      b.lastVel.copy(v);
      b.motion = v.length() + spin * 0.5;
      // Still by our measure counts as asleep.
      if (b.motion < STILL && this.tick - b.born > 20) {
        if (++b.asleepTicks >= pileAfterTicks && this.canPile(b.id)) toPile.push(b);
      } else {
        b.asleepTicks = 0;
      }
      bodies.centerOfMass(b.body, _t);
      const comY = _t.y;
      if (comY < SUNK && !b.sunk) {
        b.sunk = true;
        this.counters.sunk++;
        this.sinks.push({ from: b.from, pieces: b.pieces.length, age: this.tick - b.born, held: !this.canPile(b.id), speed: +v.length().toFixed(1) });
        if (this.sinks.length > 8) this.sinks.shift();
      }
      if (comY < -30) this.clear(b);
    }
    this.breakPending();
    for (const b of toSplit) {
      this.shatter(b);
      this.counters.shattered++;
      this.onShatter?.(b.pieces);
    }
    // After the shatters: their sound comes first.
    if (landed && this.bodies.has(landed.id)) {
      bodies.centerOfMass(landed.body, _t);
      this.onLand?.(new THREE.Vector3(_t.x, _t.y, _t.z), landedMass, landedSpeed);
    }
    for (const b of toPile) if (this.bodies.has(b.id)) this.pile(b);
    if (this.tick % 8 === 0) this.recheckRubble();
    if (this.bodies.size > this.options.maxBodies) {
      // Over budget: settle the stillest, oldest bodies where they are (rubble stays; nothing vanishes).
      const order = [...this.bodies.values()].filter((b) => this.canPile(b.id)).sort((a, b) => a.motion - b.motion || a.born - b.born);
      for (const b of order.slice(0, this.bodies.size - this.options.maxBodies)) if (this.bodies.has(b.id)) this.pile(b);
      // Still over (everything is hinged): the oldest go.
      if (this.bodies.size > this.options.maxBodies * 1.25) {
        const byAge = [...this.bodies.values()].sort((a, b) => a.born - b.born);
        for (const b of byAge.slice(0, this.bodies.size - this.options.maxBodies)) this.clear(b);
      }
    }
  }

  /**
   * The net under the solver. A step that throws a body faster than anything in
   * a collapse moves (a hinge fighting a contact, hulls pushed apart as they part)
   * is undone for that body: back where it was, with the velocity it had. One that
   * keeps being thrown is trapped: whatever joints hold it let go, and if it is
   * still thrown it settles where it is (or, if hinges still hold it, is cleared).
   * Runs before each step and again before drawing, so a throw is never seen.
   */
  guard(): void {
    let trapped: Body[] | null = null;
    const { bodies, joints } = this.physics;
    for (const b of this.bodies.values()) {
      if (bodies.isSleeping(b.body)) continue;
      bodies.velocity(b.body, _lv);
      const speed = Math.hypot(_lv.x, _lv.y, _lv.z);
      if (speed <= FLING) {
        bodies.pose(b.body, _t, _r);
        b.lastPos.set(_t.x, _t.y, _t.z);
        b.lastRot.set(_r.x, _r.y, _r.z, _r.w);
        continue;
      }
      this.counters.flung++;
      this.flings.push({ speed: +speed.toFixed(1), from: b.from, pieces: b.pieces.length, age: this.tick - b.born, held: !this.canPile(b.id), y: +b.lastPos.y.toFixed(2), piece: b.pieces[0]!, joints: joints.countOf(b.body) });
      if (this.flings.length > 16) this.flings.shift();
      bodies.setPose(b.body, b.lastPos, b.lastRot);
      bodies.setVelocity(b.body, b.lastVel, ZERO);
      b.streak = this.tick - b.flungAt <= 4 ? b.streak + 1 : 1;
      b.flungAt = this.tick;
      if (b.streak >= TRAPPED) (trapped ??= []).push(b);
    }
    for (const b of trapped ?? []) {
      if (!this.bodies.has(b.id)) continue;
      if (b.streak === TRAPPED) this.onTrapped?.(b.body);
      else if (this.canPile(b.id)) this.pile(b);
      else if (b.streak >= TRAPPED * 2) this.clear(b);
    }
  }

  private clear(b: Body): void {
    for (const p of b.pieces) {
      this.setState(p, GONE);
      this.collider[p] = 0;
    }
    this.removeBody(b);
    this.counters.cleared++;
    this.onGone?.(b.pieces);
  }

  private addBody(init: Omit<Body, 'lastPos' | 'lastRot' | 'streak' | 'flungAt' | 'sunk'>): void {
    this.physics.bodies.pose(init.body, _t, _r);
    const b: Body = { ...init, lastPos: new THREE.Vector3(_t.x, _t.y, _t.z), lastRot: new THREE.Quaternion(_r.x, _r.y, _r.z, _r.w), streak: 0, flungAt: -99, sunk: false };
    this.version++;
    this.bodies.set(b.id, b);
    this.byHandle.set(b.body, b);
  }

  /** The body goes, with its colliders and joints. */
  private removeBody(b: Body): void {
    this.version++;
    this.byHandle.delete(b.body);
    this.physics.bodies.destroy(b.body);
    this.bodies.delete(b.id);
  }

  /** A still body becomes rubble: its chunks' colliders move onto the fixed rubble body, posed where they lie. */
  private pile(b: Body): void {
    const settled = [...b.pieces];
    const poses = settled.map((p) => this.restToWorld(p, new THREE.Matrix4()));
    this.removeBody(b);
    settled.forEach((p, i) => {
      const pose = poses[i]!;
      const [cx, cy, cz] = this.pieces[p]!.centroid;
      pose.decompose(_p, _q, _s);
      const center = new THREE.Vector3(cx, cy, cz).applyMatrix4(pose);
      this.collider[p] = this.addChunkCollider(this.rubble, p, true, center, { x: _q.x, y: _q.y, z: _q.z, w: _q.w });
      this.rubblePose[p] = pose;
      this.setState(p, RUBBLE);
      this.rubbleSet.add(p);
    });
    this.counters.piled++;
    this.onSettle?.(settled, settled.length === 1);
  }

  /**
   * An impact broke a body up: into clusters of the chunks that share a `shatterCell` cell of the
   * rest pose, not every chunk on its own. A 190-chunk slab used to become 190 bodies in one step
   * (8 ms of body and collider creation, then 360 awake bodies for Rapier to step). The biggest
   * cluster stays in the body; the rest break out over the next few steps, a collider budget at a
   * time (`breakPending`). A cluster that lands hard again breaks up in turn.
   */
  private shatter(b: Body): void {
    const cell = this.options.shatterCell;
    let groups: number[][];
    if (cell <= 0) {
      groups = b.pieces.map((p) => [p]);
    } else {
      const byCell = new Map<string, number[]>();
      for (const p of b.pieces) {
        const c = this.pieces[p]!.centroid;
        const key = `${Math.floor(c[0] / cell)},${Math.floor(c[1] / cell)},${Math.floor(c[2] / cell)}`;
        let g = byCell.get(key);
        if (!g) byCell.set(key, (g = []));
        g.push(p);
      }
      groups = [...byCell.values()];
    }
    if (groups.length < 2) return;
    groups.sort((a, c) => c.length - a.length);
    this.breakQueue.push({ body: b.id, groups: groups.slice(1) });
  }

  /** Break `which` chunks out of a body as single chunks that carry on with its motion; the rest stay together. */
  private split(b: Body, which: readonly number[]): void {
    this.breakOut(
      b,
      which.map((p) => [p]),
    );
  }

  /** Shatters waiting to finish: groups still to break out of a body, a collider budget per step. */
  private breakPending(): void {
    let budget = BREAK_COLLIDERS_PER_STEP;
    while (this.breakQueue.length > 0 && budget > 0) {
      const job = this.breakQueue[0]!;
      const b = this.bodies.get(job.body);
      if (!b) {
        this.breakQueue.shift();
        continue;
      }
      const now: number[][] = [];
      let left = b.pieces.length;
      while (job.groups.length > 0 && (now.length === 0 || budget >= job.groups[0]!.length)) {
        const g = job.groups.shift()!.filter((p) => this.state[p] === b.id);
        budget -= g.length;
        // Something always stays: the body itself is the last group.
        if (g.length > 0 && g.length < left) {
          now.push(g);
          left -= g.length;
        }
      }
      if (job.groups.length === 0) this.breakQueue.shift();
      if (now.length > 0) this.breakOut(b, now);
    }
  }

  /**
   * Groups of a body's chunks leave it as bodies of their own, each carrying on with the motion its
   * part had. Only their colliders move (removed here, made anew there): the body keeps the rest
   * as they are, in the same frame, rather than being rebuilt around them.
   */
  private breakOut(b: Body, groups: readonly (readonly number[])[]): void {
    const bodies = this.physics.bodies;
    bodies.pose(b.body, _t, _r);
    bodies.velocity(b.body, _lv, _av);
    const pos = new THREE.Vector3(_t.x, _t.y, _t.z);
    const lin = new THREE.Vector3(_lv.x, _lv.y, _lv.z);
    const ang = new THREE.Vector3(_av.x, _av.y, _av.z);
    const q = new THREE.Quaternion(_r.x, _r.y, _r.z, _r.w);
    const origin = b.origin;
    const leaving = new Set<number>();
    for (const g of groups) for (const p of g) leaving.add(p);
    for (const p of leaving) {
      const c = this.collider[p]!;
      if (c > 0) bodies.removeCollider(c as ColliderHandle, false);
      this.collider[p] = 0;
    }
    b.pieces = b.pieces.filter((p) => !leaving.has(p));
    // What it lost moved its centre of mass, which reads as a jolt next step: it counts as new, so it
    // doesn't shatter again on that alone.
    b.born = this.tick;
    this.version++;
    /** A rest point's place in the world now, and how fast it moves with the old body. */
    const place = (c: THREE.Vector3): { world: THREE.Vector3; vel: THREE.Vector3 } => {
      const local = c.clone().sub(origin).applyQuaternion(q);
      return { world: local.clone().add(pos), vel: lin.clone().add(ang.clone().cross(local)) };
    };
    for (const g of groups) {
      if (g.length === 1) {
        const p = g[0]!;
        const c = this.pieces[p]!.centroid;
        this.setState(p, STANDING); // transient, so loose() accepts it
        const { world, vel } = place(new THREE.Vector3(c[0], c[1], c[2]));
        this.loose(p, world, q, vel, ang, 'split');
        continue;
      }
      let mass = 0;
      const com = new THREE.Vector3();
      for (const p of g) {
        const piece = this.pieces[p]!;
        mass += piece.mass;
        com.x += piece.centroid[0] * piece.mass;
        com.y += piece.centroid[1] * piece.mass;
        com.z += piece.centroid[2] * piece.mass;
      }
      com.divideScalar(mass);
      // Its own frame, at its centre of mass (like a detached body), turned as the old body was.
      const { world: at, vel } = place(com);
      const body = bodies.create({ type: 'dynamic', position: at, rotation: q, linearVelocity: vel, angularVelocity: ang, ccd: vel.length() > FAST });
      const id = this.nextBodyId++;
      for (const p of g) {
        this.collider[p] = this.addChunkCollider(body, p, true, this.offset(p, com), undefined, this.options.density);
        this.setState(p, id);
      }
      this.addBody({ id, body, pieces: [...g], origin: com, born: this.tick, from: 'split', lastVel: vel.clone(), jolt: 0, motion: 1, asleepTicks: 0 });
    }
    if (b.pieces.length === 0) this.removeBody(b);
  }

  /** One chunk as its own body, its rest centroid at `center` with rotation `q`. */
  private loose(p: number, center: THREE.Vector3, q: THREE.Quaternion, vel: THREE.Vector3, ang: THREE.Vector3, from: BodyOrigin): number {
    const piece = this.pieces[p]!;
    const [cx, cy, cz] = piece.centroid;
    // A chunk flung off the rim of a spinning wall starts no faster than anything else may move.
    if (vel.lengthSq() > MAX_SPEED * MAX_SPEED) vel.setLength(MAX_SPEED);
    const body = this.physics.bodies.create({ type: 'dynamic', position: center, rotation: q, linearVelocity: vel, angularVelocity: ang, ccd: true });
    this.collider[p] = this.addChunkCollider(body, p, true, ZERO, undefined, this.options.density);
    const id = this.nextBodyId++;
    this.setState(p, id);
    this.addBody({ id, body, pieces: [p], origin: new THREE.Vector3(cx, cy, cz), born: this.tick, from, lastVel: vel.clone(), jolt: 0, motion: 1, asleepTicks: 0 });
    return id;
  }

  /** Write each moving chunk's matrix. Standing, rubble and gone chunks are skipped (rubble is written on settling). */
  writeMatrices(set: (piece: number, m: THREE.Matrix4, alone: boolean) => void, all = false): void {
    const bodies = this.physics.bodies;
    for (const b of this.bodies.values()) {
      if (!all && bodies.isSleeping(b.body)) continue;
      bodies.pose(b.body, _t, _r);
      _m.compose(_p.set(_t.x, _t.y, _t.z), _q.set(_r.x, _r.y, _r.z, _r.w), ONE);
      _m.multiply(_shift.makeTranslation(-b.origin.x, -b.origin.y, -b.origin.z));
      for (const p of b.pieces) set(p, _m, b.pieces.length === 1);
    }
  }

  /** Closest hit along a ray; piece −1 for anything that is not this structure (the ground). */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number): DebrisHit | null {
    const hit = this.physics.raycast(origin, dir, maxDistance);
    if (!hit) return null;
    const point = new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z);
    const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
    if (hit.eid !== this.owner || hit.part < 0) return { piece: -1, state: GONE, point, normal };
    return { piece: hit.part, state: this.state[hit.part]!, point, normal };
  }

  /** Every body this layer made goes, with its colliders and joints. */
  dispose(): void {
    for (const b of [...this.bodies.values()]) this.removeBody(b);
    this.physics.bodies.destroy(this.building);
    this.physics.bodies.destroy(this.rubble);
    this.collider.fill(0);
  }
}
