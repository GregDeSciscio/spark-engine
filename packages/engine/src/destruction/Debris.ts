import * as THREE from 'three/webgpu';
import { Random } from '../core/Random';
import type { Entity } from '../ecs/EntityWorld';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { BodyHandle, ColliderHandle, QuatLike, Vec3Like } from '../physics/types';
import { SharedBudget, type BudgetMember } from './Budget';
import type { Piece } from './core/pieces';

/**
 * The debris layer: physics bodies for everything that has come loose, and
 * the rubble it settles into.
 *
 * A chunk is in one of four places: standing (a collider on the fixed
 * building body), loose (a dynamic body, alone or with the rest of its
 * island), rubble (settled: a collider on a fixed rubble body, so piles cost
 * nothing to simulate and stay where they fell, for as long as a path of
 * supports leads down from them to the ground), or gone.
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
  /**
   * Dynamic bodies wanted at most. Past it the stillest settle where they are, if they rest on
   * something; a quarter past it, hinges let go of what they have held longest; half again past
   * it, the oldest are cleared.
   */
  maxBodies: number;
  /** Fixed steps a body must be still (or asleep) before it settles into rubble. */
  pileAfterTicks: number;
}

export type DebrisOptions = { [K in keyof DebrisSettings]?: DebrisSettings[K] | undefined };

/**
 * What the debris layer holds, as plain data (`Debris.save`): chunks gone, rubble by the settling it
 * came to rest in (one rest-to-world matrix each, column-major), and loose bodies with their matrix
 * and velocities. Hinges, nets and the support graph are not kept: they are rebuilt or let go.
 */
export interface DebrisSave {
  gone: number[];
  piles: Array<{ pieces: number[]; pose: number[] }>;
  bodies: Array<{ pieces: number[]; pose: number[]; linvel: [number, number, number]; angvel: [number, number, number] }>;
}

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
/** Rubble support queries per fixed step (each is a shape query in the physics module, about 13 µs). */
const RECHECKS = 16;
/** Rubble the sweep through all of it looks at per fixed step (`recheckRubble`). */
const SWEEP = 6;
/** Rubble this low (centroid height, m) lies on the ground: the sweep leaves it be. */
const SWEEP_ABOVE = 0.4;
/** Rubble this close across (m) to a loss of support re-checks, for this many fixed steps, gathered again this often. */
const LOSS_REACH = 3.5;
const LOSS_TICKS = 240;
const LOSS_REGATHER = 60;
/** Grid cell (m, across) of the rubble index. */
const RUBBLE_CELL = 2;
/** Loose debris that rubble rests on holds it until it has moved this far (m) from where it was. */
const MOVED_OFF = 0.1;
/** A support that is not a chunk of this structure: the ground, or anything else's collider. */
const FOREIGN = -1;
/** A body turned less than 15° from as built (the `w` of its rotation, cos 7.5°) is upright (`upright`). */
const UPRIGHT = Math.cos((7.5 * Math.PI) / 180);
/** How much of its recent peak falling speed a body keeps from one step to the next (`Body.fall`). */
const FALL_FADE = 0.85;
/** A body holding at least this share of its element's chunks is still that wall or column, a member (`upright`). */
const MEMBER_SHARE = 0.6;
/** Support queries the budget may spend a step finding bodies that rest on something, and steps before it asks one that rested on nothing again. */
const BUDGET_QUERIES = 24;
const BUDGET_RETRY = 15;
/** A quarter over budget, hinges let go of this many bodies a step. */
const LET_GO = 4;
/** Past this many times the budget, the oldest bodies are cleared. */
const HARD_CAP = 1.5;
/** Colliders a shatter may move per step; the rest of it breaks out over the next steps. */
const BREAK_COLLIDERS_PER_STEP = 64;
/** A body falling at least this fast (m/s) that one step slows by at least as much has landed on something. */
const LANDING = 2.5;
/** The most a body coming down fast may leave an impact upward (m/s), or a tenth of its fall speed if more. */
const BOUNCE = 1;
const FRICTION = 0.8;
const RESTITUTION = 0.05;
/** Contact force (N) on a standing chunk worth reporting (`PhysicsWorld.contactForces`): about a tonne. */
export const RESTING_FORCE = 10_000;
/**
 * The same for a loose or settled chunk: pressed this hard (five tonnes), it may be being crushed.
 * Half of `Destruction`'s default `squeezeForce`: every pair over it is an event, and a heap has many.
 */
export const SQUEEZE_FORCE = 50_000;

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
  /** How fast it has been falling of late (m/s down, the peak, fading): a landing on loose debris takes a few steps. */
  fall: number;
  /** Speed plus half the spin, last step: how far from still it is. */
  motion: number;
  asleepTicks: number;
  /** When the budget last found it lying on nothing: not asked again for a while. */
  budgetMiss: number;
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

/** The rubble index's key for a grid cell. */
function cellKey(ix: number, iz: number): number {
  return (ix + 32768) * 65536 + (iz + 32768);
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
const _where = new THREE.Matrix4();
const _at = new THREE.Vector3();

export class Debris implements BudgetMember {
  readonly options: DebrisSettings;
  /** The body budget, shared with every structure in the physics world (`budgetsOf`), or its own. */
  private readonly budget: SharedBudget;
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
  /** Chunks lying in rubble; the same by grid cell of where they lie (`RUBBLE_CELL`); and where (world centroids, xyz). */
  private readonly rubbleSet = new Set<number>();
  private readonly rubbleCells = new Map<number, Set<number>>();
  private readonly rubbleAt: Float32Array;
  /** Places something just stopped holding things up; rubble near them re-checks its support for a while. */
  private readonly losses: Array<{ x: number; y: number; z: number; until: number; next: number }> = [];
  /** Per chunk: STANDING, GONE, RUBBLE, or the id of its loose body. */
  readonly state: Float64Array;
  private tick = 0;
  private nextBodyId = 0;
  /** Bodies created, split, settled and cleared, for the HUD; `dropped`: rubble chunks that lost their last path to the ground and fell. */
  readonly counters = { created: 0, shattered: 0, piled: 0, cleared: 0, crushed: 0, flung: 0, sunk: 0, dropped: 0, bounced: 0 };
  /** The latest flings, for the soak and probes. */
  readonly flings: Fling[] = [];
  /** Bodies seen going through the floor, for the soak: how they came loose, how old, how fast. */
  readonly sinks: Sink[] = [];
  /** Chunks the budget (or the kill plane) cleared away, so the view can hide them. */
  onGone: ((pieces: readonly number[]) => void) | null = null;
  /** A multi-chunk body just broke up on impact (its glue can become a net of hinges). */
  onShatter: ((pieces: readonly number[]) => void) | null = null;
  /** A wall or column still upright as built landed hard (`fixedUpdate`), and `body` is about to be crushed: where, its mass, its chunks. */
  onBuckle: ((at: THREE.Vector3, mass: number, pieces: readonly number[], body: BodyHandle) => void) | null = null;
  /** Landings this step that did not shatter anything: where the hardest was, the mass of all that landed, and how fast the hardest came down. */
  onLand: ((at: THREE.Vector3, mass: number, speed: number) => void) | null = null;
  /** Chunks that just settled into rubble (their final matrix must be written once); `alone` if they were a single-chunk body. */
  onSettle: ((pieces: readonly number[], alone: boolean) => void) | null = null;
  /** A body kept being thrown: whatever holds it (hinges) should let go. */
  onTrapped: ((body: BodyHandle) => void) | null = null;
  /** Over budget: whatever holds this body (hinges) should let go, so it can fall and settle. */
  letGo: ((body: BodyHandle) => void) | null = null;
  /** May this body settle? (False while hinges hold it.) */
  canPile: (bodyId: number) => boolean = () => true;
  /** Rubble waiting for a support check. */
  private readonly recheck = new Set<number>();
  /** Where the sweep through all the rubble has got to. */
  private sweep: Iterator<number> | null = null;
  /**
   * The support graph. Per chunk of rubble, what it rests on (chunks, or `FOREIGN`), found as it
   * settles; per chunk in any state, the rubble resting on it. Rubble stays only while a path of
   * these links leads down to the ground or the standing structure: when a link goes, everything
   * above it with no other path falls in the same step (`dropUnheld`).
   */
  private readonly supports: Array<number[] | null>;
  private readonly carries: Array<Set<number> | null>;
  /** Which settling each rubble chunk came to rest in, and each settling's chunks still in the rubble: they share a pose, and hold or fall as one. */
  private readonly pileOf: Int32Array;
  private readonly pileChunks = new Map<number, Set<number>>();
  private nextPile = 0;
  /** Chunks no longer settled that rubble still rests on, and where each was then: they hold it until they move off. */
  private readonly watched = new Set<number>();
  private readonly watchAt: Float32Array;
  /** Rubble that lost a support since the last `dropUnheld`. */
  private readonly unsure = new Set<number>();
  /** Chunks per authored element: how much of a wall a body still holds (`upright`). */
  private readonly elementSize = new Map<number, number>();

  constructor(physics: PhysicsWorld, owner: Entity, pieces: readonly Piece[], options: DebrisOptions = {}, random: Random = new Random(1), budget: SharedBudget = new SharedBudget()) {
    const o = { ...DEFAULT_DEBRIS };
    for (const k of Object.keys(o) as Array<keyof DebrisSettings>) o[k] = options[k] ?? o[k];
    this.options = o;
    this.budget = budget;
    budget.join(this);
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
    this.rubbleAt = new Float32Array(pieces.length * 3);
    this.state = new Float64Array(pieces.length).fill(STANDING);
    this.supports = pieces.map(() => null);
    this.carries = pieces.map(() => null);
    this.pileOf = new Int32Array(pieces.length);
    this.watchAt = new Float32Array(pieces.length * 3);
    for (const p of pieces) this.elementSize.set(p.element, (this.elementSize.get(p.element) ?? 0) + 1);
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
    // Standing chunks report what presses on them: loose weight resting on the structure is Strain's to carry.
    // Loose and settled ones report being squeezed: debris can't hold up what a column could.
    const forceEvents = body === this.building ? RESTING_FORCE : SQUEEZE_FORCE;
    const base = { owner: this.owner, part: piece, position, rotation, density, friction: FRICTION, restitution: RESTITUTION, forceEvents };
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

  /**
   * A loose body's mass and the velocity it had going into the last physics step (before whatever
   * it hit there stopped it), or null if `body` is not one of this layer's.
   */
  incoming(body: BodyHandle): { mass: number; velocity: THREE.Vector3 } | null {
    const b = this.byHandle.get(body);
    if (!b) return null;
    return { mass: this.physics.bodies.mass(body), velocity: b.lastVel };
  }

  get bodyCount(): number {
    return this.bodies.size;
  }

  /** @internal `BudgetMember`: bodies held, and the most wanted alone. */
  get budgetCount(): number {
    return this.bodies.size;
  }

  /** @internal */
  get budgetWanted(): number {
    return this.options.maxBodies;
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

  /** Something at this chunk stopped holding things up (it fell, broke away, was crushed or destroyed). */
  private lostSupport(piece: number): void {
    const s = this.state[piece]!;
    const [x, y, z] = this.pieces[piece]!.centroid;
    if (s === RUBBLE) this.lostSupportAt(this.rubbleAt[piece * 3]!, this.rubbleAt[piece * 3 + 1]!, this.rubbleAt[piece * 3 + 2]!);
    else if (s >= 0) {
      _at.set(x, y, z).applyMatrix4(this.restToWorld(piece, _where));
      this.lostSupportAt(_at.x, _at.y, _at.z);
    } else this.lostSupportAt(x, y, z);
  }

  /** A loss of support at a world point: rubble round it is checked now and again while it lasts. */
  private lostSupportAt(x: number, y: number, z: number): void {
    for (let i = this.losses.length - 1; i >= Math.max(0, this.losses.length - 40); i--) {
      const e = this.losses[i]!;
      if (Math.abs(e.x - x) < 1.5 && Math.abs(e.y - y) < 1.5 && Math.abs(e.z - z) < 1.5) {
        e.y = Math.min(e.y, y);
        e.until = this.tick + LOSS_TICKS;
        e.next = this.tick;
        return;
      }
    }
    this.losses.push({ x, y, z, until: this.tick + LOSS_TICKS, next: this.tick });
  }

  /** Rubble across from a loss, above it or not far below, waits for a check. */
  private gather(e: { x: number; y: number; z: number }): void {
    const at = this.rubbleAt;
    for (let ix = Math.floor((e.x - LOSS_REACH) / RUBBLE_CELL); ix <= Math.floor((e.x + LOSS_REACH) / RUBBLE_CELL); ix++) {
      for (let iz = Math.floor((e.z - LOSS_REACH) / RUBBLE_CELL); iz <= Math.floor((e.z + LOSS_REACH) / RUBBLE_CELL); iz++) {
        const cell = this.rubbleCells.get(cellKey(ix, iz));
        if (!cell) continue;
        for (const p of cell) {
          const i = p * 3;
          if (Math.abs(at[i]! - e.x) < LOSS_REACH && Math.abs(at[i + 2]! - e.z) < LOSS_REACH && at[i + 1]! > e.y - 1) this.recheck.add(p);
        }
      }
    }
  }

  private rubbleCell(piece: number): number {
    return cellKey(Math.floor(this.rubbleAt[piece * 3]! / RUBBLE_CELL), Math.floor(this.rubbleAt[piece * 3 + 2]! / RUBBLE_CELL));
  }

  /**
   * Is this chunk resting on something? Its hull, moved down a few
   * centimetres, must meet standing structure, or a collider lower than itself
   * (the ground, rubble beneath it), not just a rubble neighbour beside it.
   * Loose debris counts only if it lies on something settled itself, and never
   * if hinges hold it: a building's top settled into rubble hung its broken
   * pieces under it, and they held it up in mid-air; so did a chunk asleep,
   * wedged in the rubble round it. `settled`: no loose body at all, as it can
   * still move away from under it.
   */
  private supported(piece: number, settled = false): boolean {
    const c = this.colliderOf(piece);
    if (c === null) return true;
    const bodies = this.physics.bodies;
    const t = { x: 0, y: 0, z: 0 };
    const r = { x: 0, y: 0, z: 0, w: 1 };
    if (!bodies.colliderPose(c, t, r)) return true;
    let held = false;
    const under: Body[] = [];
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
        const dynamic = info.body !== this.building && info.body !== this.rubble && bodies.type(info.body) === 'dynamic';
        if (dynamic && settled) return true;
        const below = info.body === this.building || (bodies.colliderPose(other, _t2) && _t2.y < t.y - 0.05);
        if (!below) return true;
        const loose = dynamic ? this.byHandle.get(info.body) : undefined;
        if (loose) {
          if (this.canPile(loose.id) && !under.includes(loose)) under.push(loose);
          return true;
        }
        held = true;
        return false;
      },
      { excludeCollider: c },
    );
    // Asked after the query, not inside it: one shape query at a time.
    return held || under.some((b) => b.pieces.some((q) => this.supported(q, true)));
  }

  /**
   * One more still step for a loose body: it becomes rubble (`toPile`) once it
   * has been still for `pileAfterTicks` with nothing holding it, resting on
   * something settled.
   */
  private still(b: Body, toPile: Body[]): void {
    // Stillness while hinges hold it says nothing: let go, it has to show it stays put on its own.
    if (!this.canPile(b.id)) {
      b.asleepTicks = 0;
      return;
    }
    if (++b.asleepTicks < this.options.pileAfterTicks) return;
    // On a loose body is not settled. A building's top, cut loose and held by a few hinges, froze in
    // the air: what lay on the hinged pieces turned to rubble where it was, and stayed when they fell.
    if (b.pieces.some((p) => this.supported(p, true))) toPile.push(b);
    else b.asleepTicks = 0;
  }

  /**
   * Rubble that nothing holds up any more falls again. Rubble round a loss of support is gathered
   * for a check when the loss happens, and again every `LOSS_REGATHER` steps while it lasts (what
   * held it may go a moment later). With nothing waiting, a sweep goes through all of it a few a
   * step, for what no loss was seen for (debris it lay on rolled away). Gathering only now and then,
   * from every chunk, missed rubble: a building's top settled by the budget stayed in mid-air when
   * what it lay on was crushed. Each check is a shape query: at most `RECHECKS` a step.
   */
  private recheckRubble(): void {
    for (let i = this.losses.length - 1; i >= 0; i--) if (this.losses[i]!.until < this.tick) this.losses.splice(i, 1);
    if (this.rubbleSet.size === 0) {
      this.recheck.clear();
      return;
    }
    for (const e of this.losses) {
      if (e.next > this.tick) continue;
      e.next = this.tick + LOSS_REGATHER;
      this.gather(e);
    }
    if (this.recheck.size === 0) {
      for (let n = 0; n < SWEEP; n++) {
        this.sweep ??= this.rubbleSet.values();
        const next = this.sweep.next();
        if (next.done) {
          this.sweep = null;
          break;
        }
        if (this.rubbleAt[next.value * 3 + 1]! > SWEEP_ABOVE) this.recheck.add(next.value);
      }
    }
    let n = 0;
    for (const p of this.recheck) {
      if (n++ >= RECHECKS) break;
      this.recheck.delete(p);
      if (this.state[p] === RUBBLE && !this.supported(p)) this.wake(p);
    }
  }

  /**
   * What a chunk of rubble rests on: chunks of this structure, or `FOREIGN` (the ground, anything
   * else's collider). Its hull moved down a few centimetres meets them. Standing structure holds
   * what rests on or against it; anything else only if it is lower; never what hinges hold, which
   * hangs from what it would be holding up.
   */
  private findSupports(piece: number): number[] {
    const out: number[] = [];
    const c = this.colliderOf(piece);
    const bodies = this.physics.bodies;
    const t = { x: 0, y: 0, z: 0 };
    const r = { x: 0, y: 0, z: 0, w: 1 };
    if (c === null || !bodies.colliderPose(c, t, r)) return out;
    this.physics.overlapShape(
      c,
      { position: { x: t.x, y: t.y - 0.06, z: t.z }, rotation: r },
      (other) => {
        const info = bodies.info(other);
        if (!info) return true;
        if (info.body !== this.building && !(bodies.colliderPose(other, _t2) && _t2.y < t.y - 0.05)) return true;
        if (info.owner !== this.owner || info.part < 0) {
          if (!out.includes(FOREIGN)) out.push(FOREIGN);
          return true;
        }
        const q = info.part;
        const s = this.state[q]!;
        if (q !== piece && !(s >= 0 && !this.canPile(s)) && !out.includes(q)) out.push(q);
        return true;
      },
      { excludeCollider: c },
    );
    return out;
  }

  /** A chunk of rubble rests on `on`: the links both ways. Loose debris among them holds it while it stays put. */
  private link(piece: number, on: number[]): void {
    this.supports[piece] = on;
    for (const q of on) {
      if (q === FOREIGN) continue;
      (this.carries[q] ??= new Set()).add(piece);
      if (this.state[q]! >= 0 && !this.watched.has(q)) this.watchFrom(q);
    }
  }

  /** Rubble leaves the rubble: what it rested on no longer carries it. */
  private unlink(piece: number): void {
    for (const q of this.supports[piece] ?? []) if (q !== FOREIGN) this.carries[q]?.delete(piece);
    this.supports[piece] = null;
  }

  /** A chunk that is no longer settled holds what rests on it until it moves off: from where it is now. */
  private watchFrom(piece: number): void {
    const [x, y, z] = this.pieces[piece]!.centroid;
    _at.set(x, y, z).applyMatrix4(this.restToWorld(piece, _where));
    this.watchAt.set([_at.x, _at.y, _at.z], piece * 3);
    this.watched.add(piece);
  }

  /** A chunk holds nothing up any more (it is gone, or moved off): what rested on it has to find its way down again. */
  private unhold(piece: number): void {
    this.watched.delete(piece);
    const carried = this.carries[piece];
    if (!carried) return;
    for (const d of carried) {
      const on = this.supports[d];
      const i = on ? on.indexOf(piece) : -1;
      if (i >= 0) on!.splice(i, 1);
      this.unsure.add(d);
    }
    this.carries[piece] = null;
  }

  /** Loose chunks that rubble rests on: one that has moved off holds it no longer. */
  private checkWatched(): void {
    for (const p of this.watched) {
      const s = this.state[p]!;
      if (s === GONE) this.unhold(p);
      else if (s === STANDING || s === RUBBLE || !this.carries[p]?.size) this.watched.delete(p);
      else {
        const [x, y, z] = this.pieces[p]!.centroid;
        _at.set(x, y, z).applyMatrix4(this.restToWorld(p, _where));
        const i = p * 3;
        if (Math.hypot(_at.x - this.watchAt[i]!, _at.y - this.watchAt[i + 1]!, _at.z - this.watchAt[i + 2]!) > MOVED_OFF) this.unhold(p);
      }
    }
  }

  /**
   * Rubble that lost a support stays only if a path of supports still leads down from it to the
   * ground, the structure or loose debris still in place; so does everything resting on it. What has
   * no path falls now, all of it, as the bodies it settled as. Decided chunk by chunk ("is something
   * lower touching me?"), rubble was held up by the rubble under it whether that was held up or not:
   * a tower's top, settled on its last corner, peeled away from below for seconds after the corner went.
   *
   * The chunks of one settling were one rigid body: it holds if any of them does, and falls whole.
   * A settled floor's chunks lie side by side, and only those over a wall rest on anything lower.
   */
  private dropUnheld(): void {
    if (this.unsure.size === 0) return;
    // Everything that may have lost its path: the rubble that lost a support, the rest of its
    // settling, and all that any of it carries.
    const zone = new Set<number>();
    const stack: number[] = [];
    const enter = (p: number): void => {
      if (this.state[p] !== RUBBLE || zone.has(p)) return;
      zone.add(p);
      stack.push(p);
    };
    for (const p of this.unsure) enter(p);
    this.unsure.clear();
    while (stack.length > 0) {
      const p = stack.pop()!;
      for (const q of this.pileChunks.get(this.pileOf[p]!) ?? []) enter(q);
      for (const d of this.carries[p] ?? []) enter(d);
    }
    // Held: a support outside the zone; then the rest of that settling, and up through what it carries.
    const held = new Set<number>();
    const hold = (p: number): void => {
      if (!zone.has(p) || held.has(p)) return;
      held.add(p);
      stack.push(p);
    };
    for (const p of zone) if (this.supports[p]?.some((q) => q === FOREIGN || (!zone.has(q) && this.state[q] !== GONE))) hold(p);
    while (stack.length > 0) {
      const p = stack.pop()!;
      for (const q of this.pileChunks.get(this.pileOf[p]!) ?? []) hold(q);
      for (const d of this.carries[p] ?? []) hold(d);
    }
    // The rest falls, a body for each settling it came to rest in.
    const falls = new Map<number, number[]>();
    for (const p of zone) {
      if (held.has(p)) continue;
      const k = this.pileOf[p]!;
      const g = falls.get(k);
      if (g) g.push(p);
      else falls.set(k, [p]);
    }
    for (const g of falls.values()) {
      this.counters.dropped += g.length;
      this.wakeTogether(g);
    }
  }

  /** The chunk leaves the building or the rubble: its fixed collider goes. */
  private dropFixed(piece: number): void {
    this.version++;
    const s = this.state[piece];
    // Whatever rests on it, it holds until it moves off; from the rubble, it no longer rests on anything.
    if (this.carries[piece]?.size && (s === STANDING || s === RUBBLE)) this.watchFrom(piece);
    if (s === RUBBLE) {
      this.unlink(piece);
      const mates = this.pileChunks.get(this.pileOf[piece]!);
      mates?.delete(piece);
      if (mates?.size === 0) this.pileChunks.delete(this.pileOf[piece]!);
    }
    const c = this.collider[piece]!;
    if (c > 0 && (s === STANDING || s === RUBBLE)) {
      this.lostSupport(piece);
      this.physics.bodies.removeCollider(c as ColliderHandle, false);
      this.collider[piece] = 0;
    }
    if (s === RUBBLE) this.rubbleCells.get(this.rubbleCell(piece))?.delete(piece);
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
    this.unhold(piece);
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
      // Blown away from under rubble, it no longer holds it up.
      this.lostSupportAt(_t.x, _t.y, _t.z);
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
    const toBuckle: Body[] = [];
    const toPile: Body[] = [];
    const { shatterDeltaV } = this.options;
    let landed: Body | null = null;
    let landedHit = 0;
    let landedSpeed = 0;
    let landedMass = 0;
    for (const b of this.bodies.values()) {
      // Asleep: nothing to read or clamp (every getter is a call into the physics module).
      if (bodies.isSleeping(b.body)) {
        b.jolt = 0;
        this.still(b, toPile);
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
      b.fall = Math.max(b.fall * FALL_FADE, -b.lastVel.y);
      // Landed: stopped hard in one step, or (an upright member coming down on loose debris) over a few.
      const hard = b.jolt > shatterDeltaV;
      const stopped = hard || b.fall - Math.max(0, -v.y) > shatterDeltaV;
      if (b.pieces.length > 1 && this.tick - b.born > 6 && stopped && this.upright(b)) toBuckle.push(b);
      else if (b.pieces.length > 1 && this.tick - b.born > 6 && hard) toSplit.push(b);
      else if (-b.lastVel.y > LANDING && v.y - b.lastVel.y > LANDING) {
        const mass = bodies.mass(b.body);
        landedMass += mass;
        const hit = mass * (v.y - b.lastVel.y);
        if (hit > landedHit) [landed, landedHit, landedSpeed] = [b, hit, -b.lastVel.y];
      }
      // Concrete doesn't bounce. A storey coming down onto the slab that had just stopped under it was
      // pushed back out of it at nearly the speed it fell, every wall at once, and the top rose a metre
      // or two before it fell again (apps/slice's probe timed it). Coming down fast, a body leaves the
      // impact upward at no more than a tenth of its fall speed, or a metre a second. The impact above
      // (jolt, landing, shatter) was read from the speed it really had.
      const rebound = Math.max(BOUNCE, -b.lastVel.y * 0.1);
      if (b.lastVel.y < -LANDING && v.y > rebound) {
        v.y = rebound;
        bodies.setVelocity(b.body, v);
        this.counters.bounced++;
      }
      b.lastVel.copy(v);
      b.motion = v.length() + spin * 0.5;
      // Still by our measure counts as asleep.
      if (b.motion < STILL && this.tick - b.born > 20) {
        this.still(b, toPile);
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
    // A wall or column that lands hard still standing as built took the blow as a member, what was
    // above it coming down on it: it is crushed. Shattered into blocks, a falling tower's walls stood
    // on the ground as a stack and held the storeys above up for a second or more. Crushing only the
    // foot and breaking the rest into chunks left those stacked where the wall stood, still holding
    // the slab; the single-chunk bodies it made (bowed out or not) pushed the budget into clearing
    // more of an eight-storey building than crushing whole walls does (18-37% against 18%).
    for (const b of toBuckle) {
      if (!this.bodies.has(b.id)) continue;
      bodies.centerOfMass(b.body, _t);
      // First, so whatever ties it to its neighbours lets go of it.
      this.onBuckle?.(new THREE.Vector3(_t.x, _t.y, _t.z), bodies.mass(b.body), [...b.pieces], b.body);
      this.clear(b, true);
    }
    // After the shatters: their sound comes first.
    if (landed && this.bodies.has(landed.id)) {
      bodies.centerOfMass(landed.body, _t);
      this.onLand?.(new THREE.Vector3(_t.x, _t.y, _t.z), landedMass, landedSpeed);
    }
    for (const b of toPile) if (this.bodies.has(b.id)) this.pile(b);
    // What lost its path to the ground falls now; the shape-query recheck stays as a net for what the
    // links can't see (loose debris that rolled out from under rubble before the rubble settled on it).
    this.checkWatched();
    this.dropUnheld();
    this.recheckRubble();
    const budget = this.budget;
    if (budget.excess(this) > 0) {
      // Over budget (this structure's share of it, when several share it): settle the stillest, oldest bodies where they are (rubble stays; nothing vanishes), if
      // they lie on something. Settled wherever they were, bodies still falling froze in mid-air. On other
      // debris is fine: when that goes, the loss of support is seen and they fall again.
      const order = [...this.bodies.values()].filter((b) => this.canPile(b.id)).sort((a, b) => a.motion - b.motion || a.born - b.born);
      let excess = budget.excess(this);
      let queries = BUDGET_QUERIES;
      for (const b of order) {
        if (excess <= 0 || queries <= 0) break;
        if (!this.bodies.has(b.id) || this.tick - b.budgetMiss < BUDGET_RETRY) continue;
        let piled = false;
        for (const p of b.pieces) {
          if (queries-- <= 0) break;
          if (!this.supported(p)) continue;
          this.pile(b);
          excess--;
          piled = true;
          break;
        }
        // Mid-air (or on debris that is): the same stillest few would be asked again every step.
        if (!piled) b.budgetMiss = this.tick;
      }
      // A quarter over: hinges let go of what they have held longest, a few a step; it falls, lands and
      // can settle. Clearing the oldest there took a hundred bodies away at once, mid-fall.
      if (budget.excess(this, 1.25) > 0) {
        let n = LET_GO;
        for (const b of [...this.bodies.values()].sort((a, c) => a.born - c.born)) {
          if (n <= 0) break;
          if (this.canPile(b.id)) continue;
          this.letGo?.(b.body);
          n--;
        }
      }
      // Far over (a whole street coming down at once): the oldest go.
      const cut = budget.excess(this, HARD_CAP);
      if (cut > 0) {
        const byAge = [...this.bodies.values()].sort((a, b) => a.born - b.born);
        for (const b of byAge.slice(0, cut)) this.clear(b);
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

  private clear(b: Body, crushed = false): void {
    // What lay on it may lie on nothing now (a top settled on panels that were then crushed).
    for (const p of b.pieces) this.lostSupport(p);
    for (const p of b.pieces) {
      this.setState(p, GONE);
      this.collider[p] = 0;
      this.unhold(p);
    }
    this.removeBody(b);
    if (crushed) this.counters.crushed++;
    else this.counters.cleared++;
    this.onGone?.(b.pieces);
  }

  /**
   * A loose body ground to grit under more than debris can bear: it and its
   * chunks are gone. Returns where its centre of mass was and its mass, or
   * null if no loose body has that handle.
   */
  crush(body: BodyHandle): { at: THREE.Vector3; mass: number } | null {
    const b = this.byHandle.get(body);
    if (!b) return null;
    const bodies = this.physics.bodies;
    bodies.centerOfMass(b.body, _t);
    const out = { at: new THREE.Vector3(_t.x, _t.y, _t.z), mass: bodies.mass(b.body) };
    this.clear(b, true);
    return out;
  }

  /** The same for one chunk of the rubble. Returns where it was, or null if it is not rubble. */
  crushRubble(piece: number): THREE.Vector3 | null {
    if (this.state[piece] !== RUBBLE) return null;
    const [cx, cy, cz] = this.pieces[piece]!.centroid;
    const at = new THREE.Vector3(cx, cy, cz).applyMatrix4(this.rubblePose[piece]!);
    this.remove(piece);
    this.counters.crushed++;
    this.onGone?.([piece]);
    return at;
  }

  /** A wall or column body still turned as it was built (within `UPRIGHT`) and most of its element: a member, not a block lying about. */
  private upright(b: Body): boolean {
    const first = this.pieces[b.pieces[0]!]!;
    if (first.kind === 'slab' || b.pieces.some((p) => this.pieces[p]!.element !== first.element)) return false;
    // Most of its element still in one piece: a fragment of a shattered wall under a slab in a heap is
    // pressed as hard, and crushing those too ground away a third to two thirds of a building.
    if (b.pieces.length < MEMBER_SHARE * this.elementSize.get(first.element)!) return false;
    this.physics.bodies.pose(b.body, _t, _r);
    return Math.abs(_r.w) > UPRIGHT;
  }

  /** Is this a loose wall or column of more than one chunk, still standing as it was built? */
  isUprightMember(body: BodyHandle): boolean {
    const b = this.byHandle.get(body);
    return b !== undefined && b.pieces.length > 1 && this.upright(b);
  }

  /** Does a loose body rest on something settled (the ground, standing structure, rubble), not just on other loose bodies? */
  restsOnSettled(body: BodyHandle): boolean {
    const b = this.byHandle.get(body);
    return b !== undefined && b.pieces.some((p) => this.supported(p, true));
  }

  /** A loose body's chunks (empty if no loose body has that handle). */
  piecesOf(body: BodyHandle): readonly number[] {
    return this.byHandle.get(body)?.pieces ?? [];
  }

  /** Is this chunk (loose or settled) still within `within` metres of where it was built? */
  inPlace(piece: number, within = 0.5): boolean {
    const [x, y, z] = this.pieces[piece]!.centroid;
    _at.set(x, y, z).applyMatrix4(this.restToWorld(piece, _where));
    return Math.hypot(_at.x - x, _at.y - y, _at.z - z) < within;
  }

  private addBody(init: Omit<Body, 'lastPos' | 'lastRot' | 'streak' | 'flungAt' | 'sunk' | 'budgetMiss' | 'fall'>): void {
    this.physics.bodies.pose(init.body, _t, _r);
    const b: Body = { ...init, lastPos: new THREE.Vector3(_t.x, _t.y, _t.z), lastRot: new THREE.Quaternion(_r.x, _r.y, _r.z, _r.w), streak: 0, flungAt: -99, sunk: false, budgetMiss: -BUDGET_RETRY, fall: Math.max(0, -init.lastVel.y) };
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
    const pile = this.nextPile++;
    this.pileChunks.set(pile, new Set(settled));
    this.removeBody(b);
    settled.forEach((p, i) => {
      const pose = poses[i]!;
      const [cx, cy, cz] = this.pieces[p]!.centroid;
      pose.decompose(_p, _q, _s);
      const center = new THREE.Vector3(cx, cy, cz).applyMatrix4(pose);
      this.collider[p] = this.addChunkCollider(this.rubble, p, true, center, { x: _q.x, y: _q.y, z: _q.z, w: _q.w });
      this.rubblePose[p] = pose;
      this.setState(p, RUBBLE);
      this.pileOf[p] = pile;
      this.rubbleSet.add(p);
      this.rubbleAt.set([center.x, center.y, center.z], p * 3);
      const key = this.rubbleCell(p);
      let cell = this.rubbleCells.get(key);
      if (!cell) this.rubbleCells.set(key, (cell = new Set()));
      cell.add(p);
    });
    // What each rests on, once all of them are in: the chunks of one settling can rest on each other.
    for (const p of settled) this.link(p, this.findSupports(p));
    this.counters.piled++;
    this.onSettle?.(settled, settled.length === 1);
  }

  /** Rubble that settled together (one pose) back to one loose body where it lies; a single chunk as `wake` does it. */
  private wakeTogether(group: readonly number[]): void {
    if (group.length === 1) {
      this.wake(group[0]!);
      return;
    }
    const pose = this.rubblePose[group[0]!]!.clone();
    pose.decompose(_p, _q, _s);
    const rotation = _q.clone();
    let mass = 0;
    const com = new THREE.Vector3();
    for (const p of group) {
      const piece = this.pieces[p]!;
      mass += piece.mass;
      com.x += piece.centroid[0] * piece.mass;
      com.y += piece.centroid[1] * piece.mass;
      com.z += piece.centroid[2] * piece.mass;
    }
    com.divideScalar(mass);
    const body = this.physics.bodies.create({ type: 'dynamic', position: com.clone().applyMatrix4(pose), rotation });
    const id = this.nextBodyId++;
    for (const p of group) {
      this.dropFixed(p);
      this.collider[p] = this.addChunkCollider(body, p, true, this.offset(p, com), undefined, this.options.density);
      this.setState(p, id);
    }
    this.addBody({ id, body, pieces: [...group], origin: com, born: this.tick, from: 'wake', lastVel: new THREE.Vector3(), jolt: 0, motion: 1, asleepTicks: 0 });
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

  /** What this layer holds, as plain data (`DebrisSave`), for a checkpoint. */
  save(): DebrisSave {
    const gone: number[] = [];
    for (let p = 0; p < this.state.length; p++) if (this.state[p] === GONE) gone.push(p);
    const piles: DebrisSave['piles'] = [];
    for (const set of this.pileChunks.values()) {
      const pieces = [...set].sort((a, b) => a - b);
      const pose = this.rubblePose[pieces[0]!];
      if (pose) piles.push({ pieces, pose: [...pose.elements] });
    }
    const bodies: DebrisSave['bodies'] = [];
    const m = new THREE.Matrix4();
    for (const b of this.bodies.values()) {
      const pieces = [...b.pieces].sort((x, y) => x - y);
      this.physics.bodies.velocity(b.body, _lv, _av);
      bodies.push({ pieces, pose: [...this.restToWorld(pieces[0]!, m).elements], linvel: [_lv.x, _lv.y, _lv.z], angvel: [_av.x, _av.y, _av.z] });
    }
    return { gone, piles, bodies };
  }

  /**
   * Put a structure that has only just been built into the state `save` recorded: chunks gone,
   * rubble where it lay (resting on whatever it rests on now), loose bodies where they were and
   * moving as they were. Chunks named twice, or not standing any more, are skipped.
   */
  load(save: DebrisSave): void {
    for (const p of save.gone) if (this.state[p] === STANDING) this.remove(p);
    const restored: number[] = [];
    for (const pile of save.piles) {
      const pieces = pile.pieces.filter((p) => this.state[p] === STANDING);
      if (pieces.length === 0) continue;
      const pose = new THREE.Matrix4().fromArray(pile.pose);
      const id = this.nextPile++;
      this.pileChunks.set(id, new Set(pieces));
      pose.decompose(_p, _q, _s);
      for (const p of pieces) {
        this.dropFixed(p);
        const [cx, cy, cz] = this.pieces[p]!.centroid;
        const center = new THREE.Vector3(cx, cy, cz).applyMatrix4(pose);
        this.collider[p] = this.addChunkCollider(this.rubble, p, true, center, { x: _q.x, y: _q.y, z: _q.z, w: _q.w });
        this.rubblePose[p] = pose.clone();
        this.setState(p, RUBBLE);
        this.pileOf[p] = id;
        this.rubbleSet.add(p);
        this.rubbleAt.set([center.x, center.y, center.z], p * 3);
        const key = this.rubbleCell(p);
        let cell = this.rubbleCells.get(key);
        if (!cell) this.rubbleCells.set(key, (cell = new Set()));
        cell.add(p);
        restored.push(p);
      }
      this.onSettle?.(pieces, pieces.length === 1);
    }
    for (const saved of save.bodies) {
      const pieces = saved.pieces.filter((p) => this.state[p] === STANDING);
      if (pieces.length === 0) continue;
      const pose = new THREE.Matrix4().fromArray(saved.pose);
      pose.decompose(_p, _q, _s);
      let mass = 0;
      const com = new THREE.Vector3();
      for (const p of pieces) {
        const piece = this.pieces[p]!;
        mass += piece.mass;
        com.x += piece.centroid[0] * piece.mass;
        com.y += piece.centroid[1] * piece.mass;
        com.z += piece.centroid[2] * piece.mass;
      }
      com.divideScalar(mass);
      const v = new THREE.Vector3(...saved.linvel);
      const body = this.physics.bodies.create({ type: 'dynamic', position: com.clone().applyMatrix4(pose), rotation: _q.clone(), linearVelocity: v, angularVelocity: new THREE.Vector3(...saved.angvel), ccd: pieces.length === 1 || v.length() > FAST });
      const id = this.nextBodyId++;
      for (const p of pieces) {
        this.dropFixed(p);
        this.collider[p] = this.addChunkCollider(body, p, true, this.offset(p, com), undefined, this.options.density);
        this.setState(p, id);
      }
      this.addBody({ id, body, pieces, origin: com, born: this.tick, from: 'wake', lastVel: v.clone(), jolt: 0, motion: 1, asleepTicks: 0 });
    }
    // What the restored rubble rests on, once all of it is in.
    for (const p of restored) this.link(p, this.findSupports(p));
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
    this.budget.leave(this);
    for (const b of [...this.bodies.values()]) this.removeBody(b);
    this.physics.bodies.destroy(this.building);
    this.physics.bodies.destroy(this.rubble);
    this.collider.fill(0);
  }
}
