import * as THREE from 'three/webgpu';
import type { AudioSystem } from '../audio/AudioSystem';
import type { EngineConfig } from '../core/Config';
import type { Disposable } from '../core/Disposable';
import { EventEmitter } from '../core/Events';
import type { Logger } from '../core/Logger';
import type { Random } from '../core/Random';
import type { Entity, EntityWorld } from '../ecs/EntityWorld';
import { SideTable } from '../ecs/SideTable';
import type { System } from '../ecs/System';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { BodyHandle, JointHandle, Vec3Like } from '../physics/types';
import type { ParticleSystem } from '../vfx/ParticleSystem';
import { budgetsOf } from './Budget';
import { ChunkMesh } from './ChunkMesh';
import { Destructible } from './components';
import { findConnections, type Connection } from './core/connections';
import type { Piece } from './core/pieces';
import type { NodeLoad } from './core/strain';
import { buildStructure } from './core/structure';
import { Debris, GONE, RUBBLE, STANDING, type Census, type DebrisOptions, type Fling, type Sink } from './Debris';
import { DestructionFx, type Heard } from './DestructionFx';
import { GravelField } from './Gravel';
import { Hinges, type HingeOptions } from './Hinges';
import { Rebar } from './Rebar';
import { SmokeSystem, type SmokeKind } from './Smoke';
import type { DestructionSounds } from './sounds';
import { InlineStrainHost, StrainWorkerPool, WorkerStrainHost, type StrainHost, type StrainInit, type StrainStep } from './strain/StrainHost';

/**
 * Fixed-stage and late-stage orders of `Destruction.systems()`. The fixed
 * system runs before the physics step (`PHYSICS_ORDER.kinematicPush` is 90):
 * debris splits and settles, hinges regroup and wear, ropes follow their
 * chunks, then Rapier steps. The late one runs before `RenderSync` (1000):
 * the step guard, then chunk matrices, rebar, ropes, smoke and gravel.
 */
export const DESTRUCTION_ORDER = { fixed: 80, late: 990 } as const;

/** What `Destruction` takes from the scene context; a `SceneContext` fits. */
export interface DestructionDeps {
  readonly entities: EntityWorld;
  readonly physics: PhysicsWorld;
  /** Forked once: the structure keeps its own stream (shake, torque, gravel, the tells). */
  readonly random: Random;
  /** Particles (blasts, dust, the tells). Without them, none. */
  readonly vfx?: ParticleSystem | undefined;
  /** Sound. Without it, or without `options.sounds`, silent. */
  readonly audio?: AudioSystem | undefined;
  readonly logger?: Logger | undefined;
  /** `fixedFrameDelta` (`?fixedclock`) puts the strain solve inline, so a fixed-clock run is deterministic. */
  readonly config?: Pick<EngineConfig, 'fixedFrameDelta'> | undefined;
}

/** The structure: pre-fractured pieces (ids 0..n−1) and, optionally, their glued contacts. */
export interface DestructionStructure {
  readonly pieces: readonly Piece[];
  /** Found from the pieces (`findConnections`) when left out. */
  readonly connections?: readonly Connection[] | undefined;
}

export interface DestructionOptions {
  /**
   * Solve strain in a worker (ADR-011). Default true; it is inline anyway in
   * Node, under `?fixedclock`, and wherever `Worker` is missing.
   */
  worker?: boolean | undefined;
  /** The game's sound takes. None: silent (the engine ships no audio). */
  sounds?: DestructionSounds | undefined;
  /** Fixed ticks between cascade steps: a collapse unfolds over a second or two, not in one frame. Default 5. */
  cascadeTicks?: number | undefined;
  /** Hits (`damage`) that pop a chunk loose. Default 3. */
  hitsToPop?: number | undefined;
  /** Speed (m/s) a popped chunk leaves at, along the hit. Default 4. */
  popSpeed?: number | undefined;
  /** Blast overpressure (Pa) at the edge of a crater, falling off with the square of distance. Default 4.8e5. */
  blastPressure?: number | undefined;
  /** Fixed ticks between re-sending hanging loads (hinges, ropes) to Strain. Default 6. */
  loadTicks?: number | undefined;
  /**
   * Chunks brought loose per fixed step while a collapse is under way.
   * Default 90: building a few hundred bodies, hulls and hinges in one frame
   * was the one hitch a player could feel.
   */
  detachPerTick?: number | undefined;
  /**
   * Islands up to this many chunks come apart as a hinged net of single
   * chunks (a bridge deck, part of a roof: they sag and drape); bigger ones
   * fall as their authored elements, hinged to each other. Default 120.
   */
  netIsland?: number | undefined;
  /**
   * Islands bigger than this (chunks) fall as loose elements with nothing linking them. Default 1,000.
   * A whole tower in free fall has nothing it could hang from: its elements hinged to each other made a
   * net of hundreds of bodies that fought its own contacts and writhed where the tower had stood.
   */
  looseIsland?: number | undefined;
  /**
   * A standing chunk Strain breaks while loose weight rests on it of more than this many times its
   * own is crushed: it goes to grit and dust instead of becoming a block that, stacked where it
   * stood, would hold the same weight up forever. So is a chunk a big island stood on when Strain cut
   * it loose, if its share of the island's weight is over this many times its own (`failSupports`).
   * Default 10.
   */
  crushRatio?: number | undefined;
  /**
   * Debris still where it was built, at the bottom of a pile (a loose body at rest on the ground,
   * standing structure or rubble, or a chunk of rubble), pressed by more than this many times its
   * own weight and by more than `squeezeForce`, two reads running, is crushed the same way: the
   * panels and blocks of a failed storey, still upright under the storeys they failed under.
   * Debris that has fallen never is (a heap's bottom can be pressed as hard), nor debris resting on
   * other loose debris: the walls of a building's top carry the storeys above as it comes down and
   * as it pauses (crushed, they ground away and left a hollow shell). Default 20.
   */
  squeezeRatio?: number | undefined;
  /**
   * The least force (N) that crushes debris at the bottom of a pile (`squeezeRatio`). A failed
   * storey's panels under a building's top carry a couple of hundred kN each; the bottom of a heap
   * of rubble, tens. Default 100,000.
   */
  squeezeForce?: number | undefined;
  /** Velocity change (m/s in one step) of a hung body that clangs: it hit something, or a rope snapped taut. Default 0.9. */
  clangDeltaV?: number | undefined;
  /** Gravity (m/s²) for hanging loads. Default: the physics world's. */
  gravity?: number | undefined;
  /**
   * The physics world's solver iterations are raised to at least this while
   * the structure lives (hinge chains and ropes want a stiffer solve than
   * Rapier's 4; at 4 a hinge rig shook and a 269 ms step was seen). Default 6.
   */
  solverIterations?: number | undefined;
  debris?: DebrisOptions | undefined;
  hinges?: HingeOptions | undefined;
}

export interface DestructionEvents extends Record<string, unknown> {
  /** A falling body broke up on impact: where, its mass (kg) and its chunks. */
  shatter: { at: THREE.Vector3; mass: number; pieces: readonly number[] };
  /** Debris came down hard: where the hardest landing was, the mass of all that landed this step, and how fast. */
  land: { at: THREE.Vector3; mass: number; speed: number };
  /** A hinge gave way under `load` (N). */
  tear: { at: THREE.Vector3; load: number };
  /** A chunk near its limit shed dust and groaned (the weakening tell); `severity` 0–1. */
  weakening: { at: THREE.Vector3; piece: number; severity: number };
  /** A strain step landed (what broke, what came loose). */
  step: StrainStep;
  /** An explosion went off; `chunks` it took out of the structure. */
  blast: { point: THREE.Vector3; radius: number; normal: THREE.Vector3 | null; chunks: number };
  /** What a big island (`under` chunks) stood on failed when Strain cut it loose: those chunks were crushed. */
  fail: { pieces: readonly number[]; under: number };
  /** A loose wall or column still upright as built landed hard under what was above it, and was crushed. */
  buckle: { at: THREE.Vector3; mass: number; pieces: readonly number[] };
}

export interface DestructionStats {
  chunks: number;
  standing: number;
  contacts: number;
  dof: number;
  init: StrainInit | null;
  last: StrainStep | null;
  cascadeSteps: number;
  cascadeMs: number;
  cascading: boolean;
  bodies: number;
  sleeping: number;
  debris: Debris['counters'];
  flings: Fling[];
  sinks: Sink[];
  hinges: { live: number; links: number; formed: number; torn: number };
  ropes: number;
  smoke: { clouds: number; voxels: number };
  sanity: { nonFinite: number; maxSpeed: number; minY: number };
  heat: boolean;
  strainMode: 'worker' | 'inline';
}

export type DestructionCensus = Census & { hinges: ReturnType<Hinges['audit']> };

/** A rope from a chunk to a hung body (`hang`). */
interface Rope {
  readonly body: BodyHandle;
  readonly piece: number;
  /** Where it is tied, in the chunk's rest pose. */
  readonly anchorRest: THREE.Vector3;
  /** Where it is tied on the hung body, in its frame. */
  readonly hook: THREE.Vector3;
  readonly length: number;
  joint: JointHandle | null;
  /** The body the chunk was on when the joint was made. */
  onBody: BodyHandle | null;
}

interface Resolved {
  cascadeTicks: number;
  hitsToPop: number;
  popSpeed: number;
  blastPressure: number;
  loadTicks: number;
  detachPerTick: number;
  netIsland: number;
  looseIsland: number;
  crushRatio: number;
  squeezeRatio: number;
  squeezeForce: number;
  clangDeltaV: number;
  gravity: number;
  solverIterations: number;
}

const tables = new WeakMap<EntityWorld, SideTable<Destruction>>();

function tableOf(entities: EntityWorld): SideTable<Destruction> {
  let table = tables.get(entities);
  if (!table) {
    table = new SideTable<Destruction>(entities, (d) => d.release());
    tables.set(entities, table);
  }
  return table;
}

const _t: Vec3Like = { x: 0, y: 0, z: 0 };
const _r = { x: 0, y: 0, z: 0, w: 1 };
const _v: Vec3Like = { x: 0, y: 0, z: 0 };
/** Below this speed (m/s) a squeezed loose body counts as at rest (`squeezeRatio`). */
const RESTING_SPEED = 0.5;
/** A contact this close to level (the vertical part of its normal) is one a chunk rests on (`failSupports`). */
const BEARING = 0.7;

/**
 * A destructible structure, THE FINALS style (ADR-011): pre-fractured chunks
 * glued at their contacts, a strain solve that decides what breaks, hinges
 * that make broken structure sag and hang before it falls, debris that
 * shatters and settles into rubble, rebar, soot, dust, gravel, smoke that
 * takes the shape of the space, and the sounds of all of it.
 *
 * One structure is one entity (`Destructible`, `entity`) owning every chunk's
 * collider with the chunk id as its `part`: `physics.raycast` reports it, and
 * `Destruction.of(entities, hit.eid)?.damage(hit.part)` acts on it. The scene
 * adds `object` to its three scene, registers `systems()`, and disposes it.
 */
export class Destruction implements Disposable {
  /** The structure's entity. */
  readonly entity: Entity;
  /** Chunks, rebar, smoke, gravel, the ropes and the blast flash and emitters: add it to the scene. */
  readonly object = new THREE.Group();
  readonly events = new EventEmitter<DestructionEvents>();
  /** Where the listener (the camera) is: the blast shake falls off with distance from it. The game keeps it current. */
  readonly listener = new THREE.Vector3();
  readonly pieces: readonly Piece[];
  readonly connections: readonly Connection[];
  /** The layers, for tools and tests. */
  readonly debris: Debris;
  readonly hinges: Hinges;
  readonly chunks: ChunkMesh;
  readonly rebar: Rebar;
  readonly smokes: SmokeSystem;
  readonly gravel: GravelField;
  private readonly fx: DestructionFx;
  private readonly entities: EntityWorld;
  private readonly physics: PhysicsWorld;
  private readonly logger: Logger | undefined;
  private readonly random: Random;
  private readonly o: Resolved;
  private readonly host: StrainHost;
  private readonly previousIterations: number;
  /** Contact bookkeeping on this side: which glue Strain broke, and every contact per chunk. */
  private readonly broken: Uint8Array;
  private readonly contactsOf: number[][];
  /** Each authored element's chunks (a storey's wall panel, a slab, a column). */
  private readonly elementChunks = new Map<number, number[]>();
  /** Hits taken per chunk (`damage`). */
  private readonly hits: Uint8Array;
  private readonly restM = new THREE.Matrix4();
  private readonly spanPoints: number[] = [];
  private readonly ropes: Rope[] = [];
  /** Each hung body's velocity a step ago: a sudden change is a clang. */
  private readonly hungLastV = new Map<BodyHandle, THREE.Vector3>();
  private ropeLines: THREE.LineSegments | null = null;
  private ropeSegs: number[] = [];
  private init: StrainInit | null = null;
  private last: StrainStep | null = null;
  private pending = false;
  private inFlight = true; // until init answers
  /** Something changed (chunks gone, loads) after the step in flight was asked for: its "stable" doesn't count. */
  private changedInFlight = false;
  private ticksSinceStep = 0;
  private cascadeSteps = 0;
  private cascadeMs = 0;
  private heatOn = false;
  private tick = 0;
  private clock = 0;
  private readonly transient: NodeLoad[] = [];
  private lastBlast: { point: THREE.Vector3; radius: number; tick: number } | null = null;
  /** Standing chunks near their limit, for the weakening tells. */
  private hot: number[] = [];
  /**
   * What Strain cut loose, waiting to become bodies: a collapse builds a few hundred
   * bodies, hulls and hinges, and doing them all in one frame was the one hitch a
   * player could feel. A few per fixed step; the delay is a frame or two.
   */
  private readonly detachQueue: number[][] = [];
  private blastAfterDetach = false;
  /** Hanging loads last sent to Strain, per standing chunk. */
  private readonly sentLoads = new Map<number, number>();
  /**
   * Loose bodies resting on standing chunks: what each pressed down on them (N per chunk), raw
   * as last read and as it counts, from the last step it was awake (asleep, its contacts are not
   * solved and say nothing). `marker` is one of its chunks, to follow it into the rubble.
   */
  private readonly resting = new Map<BodyHandle, { marker: number; raw: Map<number, number>; load: Map<number, number> }>();
  /** What bodies that settled on the structure press on it, by one of their chunks, while that stays rubble. */
  private readonly settledOn = new Map<number, Map<number, number>>();
  /** Resting weight (N) per standing chunk as last sent to Strain: what crushes it if it breaks. */
  private readonly restOn = new Map<number, number>();
  /** Loose bodies and rubble chunks squeezed past `squeezeRatio` at the last read: a second read in a row crushes them. */
  private squeezed = new Set<BodyHandle>();
  private squeezedRubble = new Set<number>();
  /** Dents per standing chunk: how far it has been shoved, and which way (accumulates, capped). */
  private readonly dents = new Map<number, THREE.Vector3>();
  private disposed = false;

  /** The runtime of a structure's entity (a raycast's `eid`), if it is one. */
  static of(entities: EntityWorld, eid: Entity): Destruction | undefined {
    return tables.get(entities)?.get(eid);
  }

  constructor(deps: DestructionDeps, structure: DestructionStructure, options: DestructionOptions = {}) {
    const t0 = performance.now();
    this.entities = deps.entities;
    this.physics = deps.physics;
    this.logger = deps.logger;
    this.random = deps.random.fork();
    this.o = {
      cascadeTicks: options.cascadeTicks ?? 5,
      hitsToPop: options.hitsToPop ?? 3,
      popSpeed: options.popSpeed ?? 4,
      blastPressure: options.blastPressure ?? 4.8e5,
      loadTicks: options.loadTicks ?? 6,
      detachPerTick: options.detachPerTick ?? 90,
      netIsland: options.netIsland ?? 120,
      looseIsland: options.looseIsland ?? 1000,
      crushRatio: options.crushRatio ?? 10,
      squeezeRatio: options.squeezeRatio ?? 20,
      squeezeForce: options.squeezeForce ?? 100_000,
      clangDeltaV: options.clangDeltaV ?? 0.9,
      gravity: options.gravity ?? Math.abs(deps.physics.gravity.y),
      solverIterations: options.solverIterations ?? 6,
    };
    const pieces = structure.pieces;
    pieces.forEach((p, i) => {
      if (p.id !== i) throw new Error(`Destruction: piece ids must be 0..n-1 in order (got ${p.id} at ${i})`);
    });
    const connections = structure.connections ?? findConnections(pieces);
    this.pieces = pieces;
    this.connections = connections;
    const data = buildStructure(pieces, connections);

    this.entity = this.entities.create([Destructible, { chunks: pieces.length, standing: pieces.length, loose: 0 }]);
    tableOf(this.entities).set(this.entity, this);
    this.previousIterations = this.physics.solverIterations;
    if (this.previousIterations < this.o.solverIterations) this.physics.solverIterations = this.o.solverIterations;

    this.fx = new DestructionFx({ entities: this.entities, vfx: deps.vfx, audio: deps.audio, random: this.random.fork() });
    this.object.add(this.fx.object);
    this.fx.loadSounds(options.sounds);
    this.chunks = new ChunkMesh(pieces);
    this.object.add(this.chunks.mesh);
    // Steel out of broken concrete, riding on the chunks, and the bars hanging pieces hang by.
    this.rebar = new Rebar(connections);
    this.object.add(this.rebar.stubs, this.rebar.spans);
    this.chunks.onMove = (p, m) => this.rebar.follow(p, m);
    // Every structure in the physics world draws on the same budgets: a level's buildings share what Rapier can afford.
    const budgets = budgetsOf(this.physics);
    this.debris = new Debris(this.physics, this.entity, pieces, options.debris, this.random.fork(), budgets.bodies);
    this.hinges = new Hinges(this.debris, connections, pieces, options.hinges, budgets.links);
    this.smokes = new SmokeSystem(this.debris, pieces);
    this.object.add(this.smokes.object);
    this.gravel = new GravelField(this.physics, this.random.fork());
    this.object.add(this.gravel.mesh);

    this.broken = new Uint8Array(connections.length);
    this.hits = new Uint8Array(pieces.length);
    this.contactsOf = pieces.map(() => []);
    for (const c of connections) {
      this.contactsOf[c.a]!.push(c.id);
      if (c.b >= 0) this.contactsOf[c.b]!.push(c.id);
    }
    for (const p of pieces) {
      const list = this.elementChunks.get(p.element);
      if (list) list.push(p.id);
      else this.elementChunks.set(p.element, [p.id]);
    }
    this.wire();
    this.logger?.info(`destruction: ${pieces.length} chunks, ${connections.length} contacts, built in ${(performance.now() - t0).toFixed(0)} ms`);

    // Strain: in a worker unless asked not to, or there is none, or the clock is fixed (results must land on the frame that asked).
    const fixedClock = deps.config?.fixedFrameDelta !== null && deps.config?.fixedFrameDelta !== undefined;
    if (options.worker === false || fixedClock || typeof Worker === 'undefined') {
      this.host = new InlineStrainHost();
    } else {
      // One worker per physics world, shared by its structures (each keeps its own solver in it).
      const host = new WorkerStrainHost(StrainWorkerPool.of(this.physics));
      host.onFallback = (reason) => this.logger?.warn(`destruction: ${reason}; solving strain on the main thread`);
      this.host = host;
    }
    this.host.init(data, (info) => {
      if (this.disposed) return;
      this.init = info;
      this.inFlight = false;
      this.logger?.info(`destruction: strain ready (${this.host.mode}), ${info.dof} DOF, first solve ${info.timing.totalMs.toFixed(1)} ms`);
    });
  }

  /** The debris callbacks: what the layers tell each other, the fx and the game. */
  private wire(): void {
    const { debris, hinges, chunks, fx, pieces, connections } = this;
    debris.onTrapped = (body) => hinges.release(body);
    debris.letGo = (body) => hinges.release(body);
    debris.canPile = (id) => {
      const b = debris.body(id);
      return !b || !hinges.holds(b.body);
    };
    debris.onGone = (gone) => {
      for (const p of gone) chunks.setVisible(p, false);
    };
    debris.onSettle = (settled, alone) => {
      for (const p of settled) chunks.setMatrix(p, debris.restToWorld(p, this.restM), alone);
    };
    debris.onLand = (at, mass, speed) => {
      fx.land(at, mass, speed);
      this.events.emit('land', { at, mass, speed });
    };
    hinges.onTear = (at, load) => {
      fx.snap(at, load);
      this.events.emit('tear', { at, load });
    };
    debris.onBuckle = (at, mass, crushed, body) => {
      hinges.release(body);
      this.crumble(at, mass);
      this.smokes.blast(at, 2);
      this.events.emit('buckle', { at, mass, pieces: crushed });
    };
    debris.onShatter = (shards) => {
      const first = shards[0];
      let mass = 0;
      for (const p of shards) mass += pieces[p]!.mass;
      if (first !== undefined) {
        const c = pieces[first]!.centroid;
        const at = new THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(debris.restToWorld(first, this.restM));
        fx.shatter(at, mass);
        this.gravel.spawn(at, Math.min(70, Math.round(mass / 250)), 2.5);
        // Debris crashing down pushes smoke and gas out of the way.
        this.smokes.blast(at, 2);
        this.events.emit('shatter', { at, mass, pieces: shards });
      }
      // The impact that broke it up snaps the steel tying it to its neighbours too. Kept, those links
      // held an eight-storey tower up after its ground storey went: each counts only its neighbour's
      // weight, never the storeys above, so the net stood like a frame.
      const body = first === undefined ? null : debris.bodyOf(first);
      if (body !== null) hinges.release(body);
      // The glue inside a slab that hit the ground becomes a weak net: it drapes before it tears.
      const set = new Set(shards);
      hinges.add(
        this.glueWithin(set).filter((c) => connections[c]!.area > 0.06),
        0.5,
        0.6,
      );
    };
  }

  /** Unbroken glue between chunks of `set` (optionally only across different groups). */
  private glueWithin(set: ReadonlySet<number>, across?: (a: number, b: number) => boolean): number[] {
    const out: number[] = [];
    for (const p of set) {
      for (const c of this.contactsOf[p]!) {
        const k = this.connections[c]!;
        if (k.a !== p || k.b < 0 || this.broken[c] || !set.has(k.b)) continue;
        if (!across || across(k.a, k.b)) out.push(c);
      }
    }
    return out;
  }

  private elementClusters(island: readonly number[]): number[][] {
    const groups = new Map<number, number[]>();
    for (const p of island) {
      const e = this.pieces[p]!.element;
      const g = groups.get(e);
      if (g) g.push(p);
      else groups.set(e, [p]);
    }
    return [...groups.values()];
  }

  // ---- strain ------------------------------------------------------------------------

  private onStep(step: StrainStep): void {
    if (this.disposed) return; // a worker answer after the structure went
    const { debris, hinges, connections, pieces } = this;
    this.inFlight = false;
    this.last = step;
    this.cascadeSteps++;
    this.cascadeMs += step.timing.totalMs;
    for (const c of step.broken) this.broken[c] = 1;
    this.rebar.broke(step.broken);
    if (step.broken.length > 0 || step.detached.length > 0) this.smokes.markDirty();
    this.fx.cracks(step.broken.slice(0, 24).map((c) => new THREE.Vector3(...connections[c]!.point)));
    if (step.heat) {
      this.hot = [];
      for (let p = 0; p < step.heat.length; p++) if (step.heat[p]! > 0.45 && debris.state[p] === STANDING) this.hot.push(p);
    }
    // What Strain broke becomes hinges; they wake when the two sides end up on different bodies.
    hinges.add(step.broken);
    for (const cut of step.detached) {
      const crushed = this.crush(cut);
      const island = crushed.length > this.o.netIsland ? this.failSupports(crushed) : crushed;
      if (island.length === 0) continue;
      const set = new Set(island);
      if (island.length <= this.o.netIsland) {
        // A small island (a bridge deck, part of a roof): every chunk its own body and all of
        // its glue hinges, so it hangs from where it broke and sags, bends and drapes.
        hinges.add(this.glueWithin(set), 0.9, 1);
        for (const p of island) this.detachQueue.push([p]);
      } else {
        // A big one falls as its authored elements, hinged to each other by the glue between them
        // (a chunk-by-chunk net of a whole building would blow the joint and body budgets). A very big
        // one (a whole tower) falls as loose elements: see `looseIsland`.
        if (island.length <= this.o.looseIsland) {
          hinges.add(
            this.glueWithin(set, (a, b) => pieces[a]!.element !== pieces[b]!.element),
            0.6,
            0.7,
          );
        }
        // Top first: what has come loose rests on what hasn't yet, so it all drops together. Bottom
        // first, the lower storeys fell away while the top was still fixed in the air.
        const clusters = this.elementClusters(island).map((g) => ({ g, top: Math.max(...g.map((p) => pieces[p]!.centroid[1])) }));
        for (const { g } of clusters.sort((a, b) => b.top - a.top)) this.detachQueue.push(g);
      }
    }
    // Whatever a recent blast cut loose leaves with it (once it has all come loose).
    if (this.lastBlast && this.tick - this.lastBlast.tick < 30 && step.detached.length > 0) this.blastAfterDetach = true;
    if (step.heat && this.heatOn) this.chunks.setHeat(step.heat);
    if (step.stable && !this.changedInFlight) this.pending = false;
    this.changedInFlight = false;
    this.events.emit('step', step);
  }

  /** The chunks of a freshly cut-loose island that loose weight was crushing (`crushRatio`) go to grit; returns the rest. */
  private crush(island: readonly number[]): readonly number[] {
    if (this.restOn.size === 0) return island;
    const { debris, chunks, pieces } = this;
    const crushed = island.filter((p) => (this.restOn.get(p) ?? 0) > this.o.crushRatio * pieces[p]!.mass * this.o.gravity);
    if (crushed.length === 0) return island;
    let mass = 0;
    const at = new THREE.Vector3();
    for (const p of crushed) {
      const { centroid: c, mass: m } = pieces[p]!;
      debris.remove(p);
      chunks.setVisible(p, false);
      this.restOn.delete(p);
      this.gravel.spawn(new THREE.Vector3(c[0], c[1], c[2]), 8, 3);
      at.x += c[0];
      at.y += c[1];
      at.z += c[2];
      mass += m;
    }
    this.fx.shatter(at.divideScalar(crushed.length), mass);
    this.smokes.markDirty();
    const gone = new Set(crushed);
    return island.filter((p) => !gone.has(p));
  }

  /**
   * What a big island stood on when Strain cut it loose has failed under it, and is crushed now.
   * Strain broke those contacts because the chunks under them could not carry the island; but left
   * standing, or loose and upright where they stood, they are rigid blocks to the physics and held
   * it up anyway. An eight-storey tower cut loose over its blown-out ground storey stood there a
   * second or two, then ground down over five: every rule that crushed debris later (resting weight
   * read twice, squeezed panels in place) caught up with Strain's verdict a little at a time.
   *
   * At each broken bearing contact under the island (its chunk on top, the ground or a chunk that is
   * still there below), the share of the island's weight it carried, by contact area, is set against
   * the wall or column at that joint: the one below, or failing that the island's own (a wall whose
   * foot broke came away with the island and still reached the floor; standing on it, the island
   * stood). Over `crushRatio` times its weight, that member goes to grit: the chunk at the joint
   * and the rest of its element, below it outside the island or all of it inside. Slabs are what
   * members hold up, never the member that failed. The island drops and breaks up where it lands; a
   * slab that comes off a sound wall leaves it (its share is small), and small islands keep hanging
   * by their hinges. Returns the island without its own crushed chunks.
   */
  private failSupports(island: readonly number[]): readonly number[] {
    const { debris, chunks, pieces, connections } = this;
    const inIsland = new Set(island);
    const joints: Array<{ top: number; under: number; area: number }> = [];
    let area = 0;
    for (const p of island) {
      for (const c of this.contactsOf[p]!) {
        const k = connections[c]!;
        const under = k.a === p ? k.b : k.a;
        if (!this.broken[c] || inIsland.has(under) || (under >= 0 && debris.state[under] === GONE)) continue;
        // The normal points from a to b: the island's chunk is on top when it points down out of it.
        if ((k.a === p ? -k.normal[1] : k.normal[1]) < BEARING) continue;
        joints.push({ top: p, under, area: k.area });
        area += k.area;
      }
    }
    if (area === 0) return island;
    let mass = 0;
    for (const p of island) mass += pieces[p]!.mass;
    const failed = new Set<number>();
    const member = (p: number, below: number | null): void => {
      for (const q of this.elementChunks.get(pieces[p]!.element) ?? [p]) {
        if (failed.has(q) || inIsland.has(q) !== (below === null) || (below !== null && pieces[q]!.centroid[1] > below + 0.01)) continue;
        const st = debris.state[q]!;
        if (st === GONE || (st !== STANDING && !debris.inPlace(q))) continue;
        failed.add(q);
      }
    };
    for (const j of joints) {
      const share = (mass * j.area) / area;
      if (j.under >= 0 && pieces[j.under]!.kind !== 'slab') {
        if (share > this.o.crushRatio * pieces[j.under]!.mass) member(j.under, pieces[j.under]!.centroid[1]);
      } else if (pieces[j.top]!.kind !== 'slab' && share > this.o.crushRatio * pieces[j.top]!.mass) member(j.top, null);
    }
    if (failed.size === 0) return island;
    const standing: number[] = [];
    const bodies = new Set<BodyHandle>();
    let gone = 0;
    const at = new THREE.Vector3();
    for (const q of failed) {
      const { centroid: c, mass: m } = pieces[q]!;
      const st = debris.state[q]!;
      if (st === STANDING) {
        debris.remove(q);
        chunks.setVisible(q, false);
        debris.counters.crushed++;
        // The island's own chunks have already left Strain's structure.
        if (!inIsland.has(q)) standing.push(q);
      } else if (st === RUBBLE) debris.crushRubble(q);
      else {
        const body = debris.bodyOf(q);
        if (body === null || bodies.has(body)) continue;
        bodies.add(body);
        debris.crush(body);
      }
      this.restOn.delete(q);
      this.gravel.spawn(new THREE.Vector3(c[0], c[1], c[2]), 6, 3);
      at.x += c[0] * m;
      at.y += c[1] * m;
      at.z += c[2] * m;
      gone += m;
    }
    this.fx.shatter(at.divideScalar(gone), gone);
    this.smokes.markDirty();
    this.events.emit('fail', { pieces: [...failed], under: island.length });
    this.strainRemove(standing);
    return island.filter((p) => !failed.has(p));
  }

  /** Chunks leave the structure: tell Strain, and queue a cascade (its first step on the next tick). */
  private strainRemove(nodes: number[]): void {
    if (nodes.length === 0) return;
    this.host.remove(nodes);
    this.queueStep();
    this.ticksSinceStep = this.o.cascadeTicks;
  }

  /**
   * Something changed: a cascade step is wanted (a fresh cascade, counted from
   * zero, unless one is going). A change made while a step is in flight
   * keeps the cascade going even if that step comes back stable: it was
   * asked before the change, so its "stable" says nothing about it.
   */
  private queueStep(): void {
    if (!this.pending) {
      this.cascadeSteps = 0;
      this.cascadeMs = 0;
    }
    this.pending = true;
    if (this.inFlight) this.changedInFlight = true;
  }

  /**
   * What loose bodies pressed on standing chunks in the last physics step. A building's top cut
   * loose by Strain sat on the columns whose joints had just failed under it, and stood there: once
   * it was debris its weight was nobody's, so the columns never felt it.
   */
  private readResting(): void {
    const { debris } = this;
    const bodies = this.physics.bodies;
    const fresh = new Map<BodyHandle, Map<number, number>>();
    const markers = new Map<BodyHandle, number>();
    const pressed = new Map<BodyHandle, number>();
    const pressedRubble = new Map<number, number>();
    this.physics.contactForces((a, b, force) => {
      const ia = bodies.info(a);
      const ib = bodies.info(b);
      if (!ia || !ib) return;
      // How hard each of our loose bodies and rubble chunks is pressed: by its hardest-pressing neighbour.
      const f = Math.hypot(force.x, force.y, force.z);
      for (const i of [ia, ib]) {
        if (i.owner !== this.entity || i.body === debris.building) continue;
        if (i.body === debris.rubble) pressedRubble.set(i.part, Math.max(f, pressedRubble.get(i.part) ?? 0));
        else pressed.set(i.body, Math.max(f, pressed.get(i.body) ?? 0));
      }
      // `a` pushes `b` with `force`: a standing chunk is pressed down by -force.y as `b`, by force.y as `a`.
      const aStands = ia.body === debris.building;
      if (aStands === (ib.body === debris.building)) return;
      const [piece, other, down] = aStands ? [ia.part, ib, force.y] : [ib.part, ia, -force.y];
      if (down <= 0 || bodies.type(other.body) !== 'dynamic') return;
      let on = fresh.get(other.body);
      if (!on) {
        fresh.set(other.body, (on = new Map()));
        markers.set(other.body, other.part);
      }
      on.set(piece, (on.get(piece) ?? 0) + down);
    });
    for (const [body, rec] of this.resting) {
      if (fresh.has(body) || (bodies.exists(body) && bodies.isSleeping(body))) continue;
      // Gone into the rubble on the structure: what it pressed with stays while it lies there.
      if (rec.marker >= 0 && debris.state[rec.marker] === RUBBLE) this.settledOn.set(rec.marker, rec.load);
      this.resting.delete(body);
    }
    for (const [body, raw] of fresh) {
      const prev = this.resting.get(body)?.raw;
      // A load counts once two reads in a row see it: a landing's spike lasts a step or two.
      const load = new Map<number, number>();
      for (const [p, f] of raw) load.set(p, Math.min(f, prev?.get(p) ?? 0));
      this.resting.set(body, { marker: markers.get(body)!, raw, load });
    }
    for (const marker of this.settledOn.keys()) if (debris.state[marker] !== RUBBLE) this.settledOn.delete(marker);

    this.squeeze(pressed, pressedRubble);
  }

  /**
   * Debris is not structure. A failed support still where it stood, pressed by many times its own
   * weight two reads running (not one landing), is ground to grit. A building's top cut loose by
   * Strain came to rest on the panels its failed storey broke into, upright on the ground where they
   * had stood, and on the rubble some of them settled into in place: rigid, they held it there for
   * good. Pressure alone could not tell them from the bottom of the heap the top lands in (crushing
   * that too ground away a third of a building); that they never moved can.
   */
  private squeeze(pressed: ReadonlyMap<BodyHandle, number>, pressedRubble: ReadonlyMap<number, number>): void {
    const { debris, hinges, pieces } = this;
    const bodies = this.physics.bodies;
    const { squeezeForce, squeezeRatio, gravity } = this.o;
    const over = new Set<BodyHandle>();
    for (const [body, f] of pressed) {
      // A loose wall or column still standing as built, under more than `crushRatio` times its weight,
      // is a member carrying what came down on it (a tower's top, dropped a storey onto the heap of the
      // one that failed, stood again on its own walls): it buckles, wherever it is, on one read.
      if (f >= squeezeForce && f > this.o.crushRatio * bodies.mass(body) * gravity && debris.isUprightMember(body)) {
        const pieces = [...debris.piecesOf(body)];
        hinges.release(body);
        const gone = debris.crush(body);
        if (gone) {
          this.crumble(gone.at, gone.mass);
          this.events.emit('buckle', { at: gone.at, mass: gone.mass, pieces });
        }
        continue;
      }
      if (f < squeezeForce || f < squeezeRatio * bodies.mass(body) * gravity) continue;
      const first = debris.piecesOf(body)[0];
      if (first === undefined || !debris.inPlace(first)) continue;
      if (!bodies.velocity(body, _v) || Math.hypot(_v.x, _v.y, _v.z) > RESTING_SPEED || !debris.restsOnSettled(body)) continue;
      if (!this.squeezed.has(body)) {
        over.add(body);
        continue;
      }
      const gone = debris.crush(body);
      if (gone) this.crumble(gone.at, gone.mass);
    }
    this.squeezed = over;
    const overRubble = new Set<number>();
    for (const [p, f] of pressedRubble) {
      if (f < squeezeForce || f < squeezeRatio * pieces[p]!.mass * gravity || !debris.inPlace(p)) continue;
      if (!this.squeezedRubble.has(p)) {
        overRubble.add(p);
        continue;
      }
      const at = debris.crushRubble(p);
      if (at) this.crumble(at, pieces[p]!.mass);
    }
    this.squeezedRubble = overRubble;
  }

  /** Grit, dust and a crumble where something was crushed. */
  private crumble(at: THREE.Vector3, mass: number): void {
    this.gravel.spawn(at, Math.min(40, Math.round(mass / 60)), 3);
    this.fx.shatter(at, mass);
    this.smokes.markDirty();
  }

  /** Hanging loads, and resting ones (`readResting`): what weighs on standing chunks (sent to Strain when it changes). */
  private syncLoads(pull: Map<number, number>): void {
    this.restOn.clear();
    const add = (on: ReadonlyMap<number, number>): void => {
      for (const [p, f] of on) if (f > 0) this.restOn.set(p, (this.restOn.get(p) ?? 0) + f);
    };
    for (const rec of this.resting.values()) add(rec.load);
    for (const on of this.settledOn.values()) add(on);
    for (const [p, f] of this.restOn) pull.set(p, (pull.get(p) ?? 0) + f);
    const { debris } = this;
    for (const r of this.ropes) {
      if (r.joint === null || debris.state[r.piece] !== STANDING) continue;
      let live = 0;
      for (const o of this.ropes) if (o.joint !== null && o.body === r.body) live++;
      pull.set(r.piece, (pull.get(r.piece) ?? 0) + (this.physics.bodies.mass(r.body) * this.o.gravity) / live);
    }
    const changes: NodeLoad[] = [];
    for (const [p, f] of pull) {
      if (debris.state[p] !== STANDING) continue;
      const prev = this.sentLoads.get(p) ?? 0;
      if (Math.abs(f - prev) > Math.max(1500, prev * 0.15)) {
        this.sentLoads.set(p, f);
        changes.push({ node: p, fx: 0, fy: -f, fz: 0 });
      }
    }
    for (const [p] of this.sentLoads) {
      if (pull.has(p) && debris.state[p] === STANDING) continue;
      this.sentLoads.delete(p);
      if (debris.state[p] === STANDING) changes.push({ node: p, fx: 0, fy: 0, fz: 0 });
    }
    if (changes.length > 0) {
      this.host.load(changes);
      this.queueStep();
    }
  }

  // ---- what a game does to it ------------------------------------------------------------

  /** Shove and tilt a standing chunk (a visual set: it still stands, and Strain decides whether it breaks). */
  private dent(p: number, dir: THREE.Vector3, amount: number): void {
    const v = this.dents.get(p) ?? new THREE.Vector3();
    v.addScaledVector(dir, amount);
    if (v.length() > 0.22) v.setLength(0.22);
    this.dents.set(p, v);
    // Shove and a small tilt about the axis across the shove, pivoting on the chunk's centre.
    const [cx, cy, cz] = this.pieces[p]!.centroid;
    const axis = new THREE.Vector3(0, 1, 0).cross(v);
    const tilt = axis.lengthSq() > 1e-8 ? new THREE.Quaternion().setFromAxisAngle(axis.normalize(), v.length() * 0.9) : new THREE.Quaternion();
    const m = new THREE.Matrix4()
      .makeTranslation(cx + v.x, cy + v.y, cz + v.z)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(tilt))
      .multiply(new THREE.Matrix4().makeTranslation(-cx, -cy, -cz));
    this.chunks.setStandingMatrix(p, m);
  }

  /**
   * An explosion at `point` (pushed a little into the surface it hit, whose
   * `normal` that was). Chunks in the inner part of the crater are
   * pulverized, the rest of it is blown loose; the ring around it is dented
   * and loaded for one strain step (the blast wave); the crater shows its
   * steel and soot; loose debris, rubble, smoke and any other dynamic body
   * nearby are shoved. Returns how many chunks it took out.
   */
  explode(point: Vec3Like, radius: number, normal: Vec3Like | null = null): number {
    if (this.disposed) return 0;
    const { debris, chunks, pieces } = this;
    const at = new THREE.Vector3(point.x, point.y, point.z);
    const n = normal ? new THREE.Vector3(normal.x, normal.y, normal.z) : null;
    this.fx.explosion(at, radius, n);
    this.gravel.spawn(n ? at.clone().addScaledVector(n, 0.5) : at, 50, 8, n);
    const tmp = new THREE.Vector3();
    const push = new THREE.Vector3();
    const hitList: number[] = [];
    for (const p of pieces) {
      if (debris.state[p.id] !== STANDING) continue;
      tmp.set(p.centroid[0], p.centroid[1], p.centroid[2]);
      const d = tmp.distanceTo(at);
      if (d > radius * 2.8) continue;
      if (d > radius) {
        // The blast wave: a one-step push on standing chunks around the crater, outward
        // from it and, for a hit from outside, mostly along the way the blast came in.
        const area = Math.cbrt(p.volume) ** 2;
        const f = (this.o.blastPressure * area * radius * radius) / (d * d);
        push.copy(tmp).sub(at).normalize();
        if (n) push.addScaledVector(n, -1.5).normalize();
        this.transient.push({ node: p.id, fx: push.x * f, fy: push.y * f, fz: push.z * f });
        // The ring right around the crater is dented: shoved in and tilted.
        if (d < radius * 1.9) this.dent(p.id, push, (1 - (d - radius) / (radius * 0.9)) * 0.14);
        continue;
      }
      hitList.push(p.id);
      if (d < radius * 0.45) {
        debris.remove(p.id); // pulverized
        chunks.setVisible(p.id, false);
        this.gravel.spawn(tmp, 10, 7, tmp.clone().sub(at).normalize(), 1.2);
      } else {
        const speed = 9 * (1 - d / radius) + 2;
        debris.detach([p.id], (c) => c.clone().sub(at).normalize().multiplyScalar(speed).add(tmp.set(0, 2, 0)));
      }
    }
    // The crater shows its steel: the glue between what went and what still stands.
    for (const p of hitList)
      for (const c of this.contactsOf[p]!) {
        const k = this.connections[c]!;
        const other = k.a === p ? k.b : k.a;
        if (other >= 0 && debris.state[other] === STANDING) this.rebar.broke([c]);
      }
    // And soot, on what it blew loose and on what still stands round it: black at the crater, gone by 2.5 radii.
    for (const p of pieces) {
      if (debris.state[p.id] === GONE) continue;
      const d = tmp.set(p.centroid[0], p.centroid[1], p.centroid[2]).distanceTo(at);
      if (d < radius * 2.5) chunks.scorch(p.id, Math.min(1, 1.25 * (1 - (d - radius * 0.5) / (radius * 2))));
    }
    debris.blast(at, radius * 2.4, 7);
    this.smokes.blast(at, radius * 3.2);
    this.smokes.markDirty();
    this.shove(at, radius);
    this.lastBlast = { point: at.clone(), radius, tick: this.tick };
    if (hitList.length === 0 && this.transient.length > 0) {
      this.queueStep();
      this.ticksSinceStep = this.o.cascadeTicks;
    }
    this.strainRemove(hitList);
    this.events.emit('blast', { point: at, radius, normal: n, chunks: hitList.length });
    return hitList.length;
  }

  /**
   * The blast shoves every other dynamic body within five radii (a slung
   * container, a crate, a ragdoll): away from it, mostly sideways (an upward
   * shove only slackens a rope; a sideways one swings it), with a twist.
   */
  private shove(at: THREE.Vector3, radius: number): void {
    const reach = radius * 5;
    const { bodies } = this.physics;
    const found = new Set<BodyHandle>();
    this.physics.overlapShape({ kind: 'sphere', radius: reach }, { position: at }, (c, owner) => {
      if (owner === this.entity) return true;
      const info = bodies.info(c);
      if (info) found.add(info.body);
      return true;
    });
    const to = new THREE.Vector3();
    for (const b of found) {
      if (bodies.type(b) !== 'dynamic' || !bodies.pose(b, _t)) continue;
      to.set(_t.x - at.x, _t.y - at.y, _t.z - at.z);
      const d = to.length();
      if (d >= reach) continue;
      to.y *= 0.25;
      const m = bodies.mass(b);
      to.normalize().multiplyScalar(m * 9 * (1 - d / reach));
      bodies.applyImpulse(b, to, { x: 0, y: m * 1.5, z: 0 });
    }
  }

  /**
   * A hit on one chunk (a bullet: `raycast` → `part`). After `hitsToPop` hits
   * a standing chunk pops loose, along `direction` when given. Returns
   * whether it popped.
   */
  damage(part: number, hits = 1, direction?: Vec3Like): boolean {
    if (this.disposed || part < 0 || part >= this.pieces.length || this.debris.state[part] !== STANDING) return false;
    this.hits[part] = Math.min(255, this.hits[part]! + hits);
    if (this.hits[part]! < this.o.hitsToPop) return false;
    const v = new THREE.Vector3();
    if (direction) v.set(direction.x, direction.y, direction.z).normalize().multiplyScalar(this.o.popSpeed);
    this.debris.detach([part], () => v.clone());
    this.strainRemove([part]);
    return true;
  }

  /** Take standing chunks out for good (scripted demolition, scenarios); returns how many went. */
  remove(parts: Iterable<number>): number {
    if (this.disposed) return 0;
    const taken: number[] = [];
    for (const p of parts) {
      if (this.debris.state[p] !== STANDING) continue;
      this.debris.remove(p);
      this.chunks.setVisible(p, false);
      taken.push(p);
    }
    this.strainRemove(taken);
    return taken.length;
  }

  /** A smoke or gas grenade at `point` (in open space: pull it back off the surface it hit). */
  smoke(kind: SmokeKind, point: Vec3Like): void {
    if (this.disposed) return;
    this.smokes.spawn(kind, new THREE.Vector3(point.x, point.y, point.z));
  }

  /** The stress view: white at baseline, yellow a quarter of the way to breaking, red at the break. */
  heatView(on: boolean): void {
    this.heatOn = on;
    if (!on) this.chunks.setHeat(null);
    else if (this.last?.heat) this.chunks.setHeat(this.last.heat);
  }

  get heat(): boolean {
    return this.heatOn;
  }

  /**
   * Hang a dynamic body from a chunk by a rope: tied at `anchorRest` (a point
   * in the chunk's rest pose) and at `hook` (in the body's frame), `length`
   * metres long. The rope follows its chunk wherever it goes (standing,
   * loose, rubble) and is cut when the chunk is destroyed. What hangs from a
   * standing chunk loads it in Strain, and the body clangs when it is
   * jolted. Returns the rope's index.
   */
  hang(body: BodyHandle, piece: number, anchorRest: Vec3Like, hook: Vec3Like, length: number): number {
    if (this.disposed) throw new Error('Destruction: disposed');
    if (this.physics.bodies.type(body) !== 'dynamic') throw new Error(`Destruction.hang: body ${body} is not a dynamic body`);
    if (piece < 0 || piece >= this.pieces.length) throw new Error(`Destruction.hang: no piece ${piece}`);
    this.ropes.push({
      body,
      piece,
      anchorRest: new THREE.Vector3(anchorRest.x, anchorRest.y, anchorRest.z),
      hook: new THREE.Vector3(hook.x, hook.y, hook.z),
      length,
      joint: null,
      onBody: null,
    });
    if (!this.hungLastV.has(body)) {
      this.physics.bodies.velocity(body, _v);
      this.hungLastV.set(body, new THREE.Vector3(_v.x, _v.y, _v.z));
    }
    this.ensureRopeLines();
    this.syncRopes();
    return this.ropes.length - 1;
  }

  /** Ropes holding now. */
  get ropeCount(): number {
    let n = 0;
    for (const r of this.ropes) if (r.joint !== null) n++;
    return n;
  }

  /** Keep each rope tied to whatever body its chunk is on now; cut it if the chunk (or the hung body) is gone. */
  private syncRopes(): void {
    const { bodies, joints } = this.physics;
    for (const r of this.ropes) {
      const alive = bodies.exists(r.body);
      const body = !alive || this.debris.state[r.piece] === GONE ? null : this.debris.bodyOf(r.piece);
      if (body !== null && body === r.onBody && r.joint !== null) continue;
      if (r.joint !== null) joints.remove(r.joint);
      r.joint = null;
      r.onBody = null;
      if (body === null) continue;
      const anchorWorld = r.anchorRest.clone().applyMatrix4(this.debris.restToWorld(r.piece, this.restM));
      bodies.pose(body, _t, _r);
      const local = anchorWorld.sub(new THREE.Vector3(_t.x, _t.y, _t.z)).applyQuaternion(new THREE.Quaternion(_r.x, _r.y, _r.z, _r.w).invert());
      r.joint = joints.create(body, r.body, { kind: 'rope', anchorA: local, anchorB: r.hook, length: r.length });
      r.onBody = body;
    }
  }

  private ensureRopeLines(): void {
    const capacity = this.ropes.length * 6;
    const old = this.ropeLines;
    if (old && (old.geometry.getAttribute('position') as THREE.BufferAttribute).array.length >= capacity) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(capacity, 12)), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    if (old) {
      old.geometry.dispose();
      old.geometry = geo;
      return;
    }
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x3b3430 }));
    lines.frustumCulled = false;
    this.ropeLines = lines;
    this.object.add(lines);
  }

  // ---- the frame ----------------------------------------------------------------------

  /** The fixed-stage system (before physics) and the late-stage one (before RenderSync). Register both. */
  systems(): System[] {
    return [
      { name: `DestructionFixed#${this.entity}`, stage: 'fixed', order: DESTRUCTION_ORDER.fixed, run: (_w, dt) => this.fixedStep(dt) },
      { name: `DestructionLate#${this.entity}`, stage: 'late', order: DESTRUCTION_ORDER.late, run: (_w, dt) => this.lateStep(dt) },
    ];
  }

  /** One fixed step, before physics. `systems()` runs it; call it yourself only without them. */
  fixedStep(dt: number): void {
    if (this.disposed) return;
    const { debris, hinges, fx } = this;
    this.tick++;
    const loadTick = this.tick % this.o.loadTicks === 0;
    // First, while the last step's colliders are all still where it left them.
    if (loadTick) this.readResting();

    // Bring loose what Strain cut free, a budget per step (always at least one group).
    for (let budget = this.o.detachPerTick; this.detachQueue.length > 0 && budget > 0; ) {
      const group = this.detachQueue.shift()!;
      budget -= group.length;
      debris.detach(group);
    }
    if (this.blastAfterDetach && this.detachQueue.length === 0 && this.lastBlast) {
      this.blastAfterDetach = false;
      debris.blast(this.lastBlast.point, this.lastBlast.radius * 3, 5);
    }

    // Debris splits on impact and settles; hinges regroup and wear; ropes follow their anchors.
    debris.fixedUpdate();
    const pull = hinges.fixedUpdate(dt, this.o.gravity);
    this.syncRopes();
    if (loadTick) this.syncLoads(pull);

    // Something hanging off its last hinges groans now and then; a hung body clangs when it hits.
    const { ratio, at } = hinges.strain;
    if (this.tick % 30 === 15 && ratio > hinges.options.endurance * 0.5) fx.strain(at, Math.min(1, ratio / hinges.options.endurance - 0.5));
    const bodies = this.physics.bodies;
    for (const [body, lastV] of this.hungLastV) {
      if (!bodies.velocity(body, _v)) {
        this.hungLastV.delete(body);
        continue;
      }
      const jolt = Math.hypot(_v.x - lastV.x, _v.y - lastV.y, _v.z - lastV.z);
      if (jolt > this.o.clangDeltaV && bodies.pose(body, _t)) fx.clang(new THREE.Vector3(_t.x, _t.y, _t.z), jolt);
      lastV.set(_v.x, _v.y, _v.z);
    }

    // Weakening tells: every half second, a couple of chunks near their limit shed dust and groan.
    if (this.tick % 30 === 0 && this.hot.length > 0) {
      for (let i = 0; i < 2; i++) {
        const p = this.hot[Math.floor(this.random.next() * this.hot.length)]!;
        if (debris.state[p] !== STANDING) continue;
        const piece = this.pieces[p]!;
        const where = new THREE.Vector3(piece.centroid[0], piece.min[1], piece.centroid[2]);
        const severity = Math.min(1, this.last?.heat?.[p] ?? 0.5);
        fx.weakening(where, severity);
        this.events.emit('weakening', { at: where, piece: p, severity });
      }
    }

    // Pace the cascade.
    this.ticksSinceStep++;
    if (this.pending && !this.inFlight && this.ticksSinceStep >= this.o.cascadeTicks) {
      this.ticksSinceStep = 0;
      this.inFlight = true;
      this.host.step(true, this.transient.splice(0), (step) => this.onStep(step));
    }

    const store = this.entities.store(Destructible);
    store.standing[this.entity] = this.last?.liveNodes ?? this.pieces.length;
    store.loose[this.entity] = debris.bodyCount;
  }

  /** One rendered frame, after the scene's own late update. `systems()` runs it. */
  lateStep(dt: number): void {
    if (this.disposed) return;
    const { debris, chunks } = this;
    this.fx.update(dt, this.listener);
    this.clock += dt;
    this.gravel.update(dt, this.clock);
    // Loose debris moves through clouds: let them re-check their space every so often.
    if (this.tick % 30 === 0 && debris.bodyCount - debris.sleepingCount > 0) this.smokes.markDirty();
    this.smokes.update(dt);
    debris.guard();
    chunks.beginFrame(); // last frame's poses become the velocity pass's previous ones
    debris.writeMatrices((p, m, alone) => chunks.setMatrix(p, m, alone));

    // The ropes.
    const lines = this.ropeLines;
    if (lines) {
      const segs = this.ropeSegs;
      segs.length = 0;
      const bodies = this.physics.bodies;
      const q = new THREE.Quaternion();
      for (const r of this.ropes) {
        if (r.joint === null || !bodies.pose(r.body, _t, _r)) continue;
        const a = r.anchorRest.clone().applyMatrix4(debris.restToWorld(r.piece, this.restM));
        const h = r.hook.clone().applyQuaternion(q.set(_r.x, _r.y, _r.z, _r.w)).add(new THREE.Vector3(_t.x, _t.y, _t.z));
        segs.push(a.x, a.y, a.z, h.x, h.y, h.z);
      }
      const attr = lines.geometry.getAttribute('position') as THREE.BufferAttribute;
      const n = Math.min(segs.length, attr.array.length);
      (attr.array as Float32Array).set(segs.slice(0, n));
      lines.geometry.setDrawRange(0, n / 3);
      // Every rope cut: no draw at all (WebGPU warns at a draw of no vertices).
      lines.visible = n > 0;
      attr.needsUpdate = true;
    }
    this.rebar.setSpans(this.hinges.spans(this.spanPoints));
  }

  /** The camera shake to add this frame (from blasts near the listener). */
  get shakeOffset(): THREE.Vector3 {
    return this.fx.shakeOffset;
  }

  /** Where the strain solve runs now. */
  get strainMode(): 'worker' | 'inline' {
    return this.host.mode;
  }

  /** Has the first strain solve landed? Until then nothing breaks. */
  get ready(): boolean {
    return this.init !== null;
  }

  stats(): DestructionStats {
    const { debris, hinges } = this;
    return {
      chunks: this.pieces.length,
      standing: this.last?.liveNodes ?? this.pieces.length,
      contacts: this.connections.length,
      dof: this.init?.dof ?? 0,
      init: this.init,
      last: this.last,
      cascadeSteps: this.cascadeSteps,
      cascadeMs: this.cascadeMs,
      cascading: this.pending,
      bodies: debris.bodyCount,
      sleeping: debris.sleepingCount,
      debris: { ...debris.counters },
      flings: [...debris.flings],
      sinks: [...debris.sinks],
      hinges: { live: hinges.liveHinges, links: hinges.linkCount, ...hinges.counters },
      ropes: this.ropeCount,
      smoke: { clouds: this.smokes.cloudCount, voxels: this.smokes.voxels },
      sanity: debris.sanity(),
      heat: this.heatOn,
      strainMode: this.host.mode,
    };
  }

  /** What the loose debris is doing (asleep, hanging, roped, free; moving or still), and a hinge bookkeeping audit. */
  census(): DestructionCensus {
    return { ...this.debris.census(), hinges: this.hinges.audit() };
  }

  /** Loose bodies with a non-finite pose or speed, the fastest speed, and the lowest point. */
  sanity(): { nonFinite: number; maxSpeed: number; minY: number } {
    return this.debris.sanity();
  }

  /** Start (or stop) logging every sound played, stamped in seconds from now: films mix them offline. */
  listen(on: boolean): void {
    this.fx.listen(on);
  }

  /** The sounds logged since the last call, oldest first. */
  takeHeard(): Heard[] {
    return this.fx.takeHeard();
  }

  /** Remove everything: bodies, colliders, joints (ropes included), meshes, the worker and the entity. */
  dispose(): void {
    if (this.disposed) return;
    this.release();
    tables.get(this.entities)?.delete(this.entity);
    if (this.entities.exists(this.entity)) this.entities.destroy(this.entity);
  }

  /** @internal Everything but the entity (its side table entry calls this when the entity goes first). */
  release(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.host.dispose();
    for (const r of this.ropes) if (r.joint !== null) this.physics.joints.remove(r.joint);
    this.ropes.length = 0;
    this.hungLastV.clear();
    this.hinges.dispose();
    this.debris.dispose();
    this.fx.dispose();
    this.chunks.dispose();
    this.rebar.dispose();
    this.smokes.dispose();
    this.gravel.dispose();
    if (this.ropeLines) {
      this.ropeLines.geometry.dispose();
      (this.ropeLines.material as THREE.Material).dispose();
    }
    this.object.removeFromParent();
    this.object.clear();
    try {
      // Put the world's solver back, unless something else changed it meanwhile.
      if (this.previousIterations < this.o.solverIterations && this.physics.solverIterations === this.o.solverIterations) this.physics.solverIterations = this.previousIterations;
    } catch {
      // The physics world was disposed first.
    }
    this.events.clear();
  }
}
