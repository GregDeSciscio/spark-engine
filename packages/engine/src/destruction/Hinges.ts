import * as THREE from 'three/webgpu';
import type { BodyHandle, JointHandle, QuatLike, Vec3Like } from '../physics/types';
import { GROUND, type Connection } from './core/connections';
import type { Piece } from './core/pieces';
import { STANDING, type Debris } from './Debris';

/**
 * Gradual destruction: THE FINALS' Season 12 layer between Strain and debris.
 *
 * When Strain breaks a contact, the chunks on either side don't simply part:
 * the contact becomes a weak hinge. While both chunks stand it is dormant;
 * once they end up on different bodies it holds them together with one or
 * two ball joints at the edge of the old contact, so a floor that lost a
 * support swings down and hangs, a wall leans out from its base, and the
 * glue inside a falling slab turns into a net that drapes before it tears.
 *
 * A hinge tires: carrying more than its endurance load, swinging, and being
 * jolted all wear it down, and it tears outright if its anchors are pulled
 * apart. What hangs off a standing chunk pulls on it, and that pull goes
 * back into Strain, so a sagging floor can peel the wall it hangs from.
 */

export interface HingeSettings {
  /** Load (N) a hinge holds per m² of the contact it grew from. */
  strength: number;
  /** Fraction of its strength a hinge holds indefinitely; past it, it tires. */
  endurance: number;
  /** Health lost per second per unit of load ratio past endurance. */
  fatigue: number;
  /** Health lost per radian of swing. */
  swingWear: number;
  /** Health lost per m/s of jolt past `joltFloor`. */
  joltWear: number;
  joltFloor: number;
  /** Anchors this far apart (m) tear a hinge between two loose bodies (they can fight each other in loops). */
  tearDistance: number;
  /** The same, for a body hanging off fixed structure (heavier swings stretch a joint more). */
  tearDistanceFixed: number;
  /** Most body pairs held by joints at once (joints cost solver time). */
  maxLinks: number;
}

export type HingeOptions = { [K in keyof HingeSettings]?: HingeSettings[K] | undefined };

export const DEFAULT_HINGES: Readonly<HingeSettings> = {
  strength: 450_000,
  endurance: 0.35,
  fatigue: 0.8,
  swingWear: 0.04,
  joltWear: 0.05,
  joltFloor: 3,
  // Joint stretch is the only force readout the physics gives: tear early, before a loop of hinged bodies fights itself.
  tearDistance: 0.12,
  tearDistanceFixed: 0.25,
  maxLinks: 260,
};

interface Hinge {
  id: number;
  conn: number;
  a: number;
  /** Piece, or GROUND. */
  b: number;
  health: number;
  /** Strength multiplier (nets inside a shattered slab are weaker than torn structure). */
  grade: number;
  alive: boolean;
  /** The link it is part of now (two body handles), or null while dormant. */
  key: string | null;
}

interface Link {
  key: string;
  /** Fixed steps both (loose) sides have been still: a resting net lets go so its rubble can settle. */
  still: number;
  sig: string;
  bodyA: BodyHandle;
  bodyB: BodyHandle;
  /** A body never changes type (debris makes a new one), so both are read once. Mass can change (chunks break out of it). */
  dynA: boolean;
  dynB: boolean;
  hinges: Hinge[];
  joints: JointHandle[];
  /** Anchors in each body's local frame, per joint, for tear checks. */
  anchors: Array<[THREE.Vector3, THREE.Vector3]>;
  /** Rebar drawn through each pivot: its ends inside A and inside B, in their local frames. */
  bars: Array<[THREE.Vector3, THREE.Vector3]>;
  strength: number;
}

/** A body's pose and velocities, read once per step (a chunk in a net sits in several links). */
interface BodyPose {
  t: Vec3Like;
  r: QuatLike;
  v: Vec3Like;
  w: Vec3Like;
}

const _m = new THREE.Matrix4();
/** How far a hinge's rebar runs into each piece from the pivot (m). */
const BAR_DEPTH = 0.22;
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _t: Vec3Like = { x: 0, y: 0, z: 0 };
const _r: QuatLike = { x: 0, y: 0, z: 0, w: 1 };

function poseToWorld(pose: { t: Vec3Like; r: QuatLike }, local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const { t, r } = pose;
  return out.copy(local).applyQuaternion(_q.set(r.x, r.y, r.z, r.w)).add(_w.set(t.x, t.y, t.z));
}

export class Hinges {
  readonly options: HingeSettings;
  private readonly debris: Debris;
  private readonly connections: readonly Connection[];
  private readonly pieces: readonly Piece[];
  private hinges: Hinge[] = [];
  private nextId = 0;
  private ticks = 0;
  /** Regroup only when bodies or hinges changed since last time (it walks every hinge). */
  private seenVersion = -1;
  private changed = true;
  private readonly ofConn = new Map<number, Hinge>();
  private links = new Map<string, Link>();
  /** Piece → the hinges on it, to find the ones a body change touched. */
  private readonly byPiece = new Map<number, Hinge[]>();
  /** Link key → the live hinges joining those two bodies now. */
  private readonly byKey = new Map<string, Set<Hinge>>();
  /** Hinges added since the last regroup. */
  private fresh: Hinge[] = [];
  /** Body → live links on it. */
  private readonly linksOnBody = new Map<BodyHandle, number>();
  private readonly poses = new Map<BodyHandle, BodyPose>();
  private readonly masses = new Map<BodyHandle, number>();
  /** Hinges formed, links torn, for the HUD. */
  readonly counters = { formed: 0, torn: 0 };
  /** A link gave way (load, wear or stretch; not `release`): where, and the load it carried (N). */
  onTear: ((at: THREE.Vector3, load: number) => void) | null = null;
  /** The hardest-worked link to fixed structure this step: its load over its strength (0: nothing hangs), and where. */
  readonly strain = { ratio: 0, at: new THREE.Vector3() };

  constructor(debris: Debris, connections: readonly Connection[], pieces: readonly Piece[], options: HingeOptions = {}) {
    const o = { ...DEFAULT_HINGES };
    for (const k of Object.keys(o) as Array<keyof HingeSettings>) o[k] = options[k] ?? o[k];
    this.options = o;
    this.debris = debris;
    this.connections = connections;
    this.pieces = pieces;
  }

  get linkCount(): number {
    return this.links.size;
  }

  get liveHinges(): number {
    let n = 0;
    for (const h of this.hinges) if (h.alive) n++;
    return n;
  }

  /** Does any hinge hold this body? (It must not settle into rubble while it hangs.) */
  holds(body: BodyHandle): boolean {
    return (this.linksOnBody.get(body) ?? 0) > 0;
  }

  /** Contacts Strain just broke, or glue inside something that just came apart, become (dormant) hinges. */
  add(conns: Iterable<number>, grade = 1, health = 1): void {
    for (const c of conns) {
      if (this.ofConn.has(c)) continue;
      const k = this.connections[c]!;
      const h: Hinge = { id: this.nextId++, conn: c, a: k.a, b: k.b, health, grade, alive: true, key: null };
      this.hinges.push(h);
      this.ofConn.set(c, h);
      this.fresh.push(h);
      for (const piece of [k.a, k.b]) {
        if (piece === GROUND) continue;
        const list = this.byPiece.get(piece);
        if (list) list.push(h);
        else this.byPiece.set(piece, [h]);
      }
      this.changed = true;
    }
  }

  private bodyOfSide(piece: number): BodyHandle | null {
    return piece === GROUND ? this.debris.building : this.debris.bodyOf(piece);
  }

  private isDynamic(body: BodyHandle): boolean {
    return this.debris.physics.bodies.type(body) === 'dynamic';
  }

  private worldToBody(body: BodyHandle, world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    this.debris.physics.bodies.pose(body, _t, _r);
    return out.copy(world).sub(_w.set(_t.x, _t.y, _t.z)).applyQuaternion(_q.set(_r.x, _r.y, _r.z, _r.w).invert());
  }

  /**
   * Where a hinge pivots, in world space: the edge of its contact patch on
   * the side the hanging body's mass is (`com`), so the swing rolls over that
   * edge instead of grinding through the face it sat on. `pose` carries the
   * patch from rest to where it is now.
   */
  private anchorWorld(h: Hinge, pose: THREE.Matrix4, com: THREE.Vector3 | null): THREE.Vector3 {
    const k = this.connections[h.conn]!;
    const p = new THREE.Vector3(...k.point).applyMatrix4(pose);
    if (!com) return p;
    const rot = new THREE.Matrix3().setFromMatrix4(pose);
    const n = new THREE.Vector3(...k.normal).applyMatrix3(rot).normalize();
    // Toward the hanging mass, and down: a deck hanging off a wall pivots on the bottom edge of its end.
    const d = com.clone().sub(p);
    d.y -= 1.5;
    d.addScaledVector(n, -d.dot(n));
    if (d.lengthSq() < 1e-6) return p;
    d.normalize();
    const e1 = new THREE.Vector3(...k.e1).applyMatrix3(rot);
    const e2 = new THREE.Vector3(...k.e2).applyMatrix3(rot);
    const dx = d.dot(e1);
    const dy = d.dot(e2);
    let reach = 0;
    for (const [x, y] of k.poly) reach = Math.max(reach, x * dx + y * dy);
    return p.addScaledVector(d, reach * 0.9);
  }

  private makeLink(key: string, sig: string, bodyA: BodyHandle, bodyB: BodyHandle, hs: Hinge[]): Link | null {
    const { bodies, joints } = this.debris.physics;
    const dynA = this.isDynamic(bodyA);
    const dynB = this.isDynamic(bodyB);
    // The hanging side is the dynamic one (the lighter, if both are): anchor toward its mass.
    const hanging = !dynA ? bodyB : !dynB ? bodyA : bodies.mass(bodyA) < bodies.mass(bodyB) ? bodyA : bodyB;
    bodies.centerOfMass(hanging, _t); // not its pose: a body that lost chunks keeps a frame away from them
    const com = new THREE.Vector3(_t.x, _t.y, _t.z);
    const anchors = hs.map((h) => {
      // Carry the patch to the world with a side that has a real chunk.
      const carrier = h.a !== GROUND ? h.a : h.b;
      return { h, world: this.anchorWorld(h, this.debris.restToWorld(carrier, _m), com) };
    });
    // One joint for a point-like contact, two at the far ends of a long one (a hinge line).
    let pick = [anchors[0]!];
    let far = 0;
    for (let i = 0; i < anchors.length; i++)
      for (let j = i + 1; j < anchors.length; j++) {
        const d = anchors[i]!.world.distanceTo(anchors[j]!.world);
        if (d > far) {
          far = d;
          pick = [anchors[i]!, anchors[j]!];
        }
      }
    if (far < 0.25) pick = [anchors[0]!];

    const link: Link = { key, sig, bodyA, bodyB, dynA, dynB, hinges: hs, joints: [], anchors: [], bars: [], strength: 0, still: 0 };
    for (const h of hs) link.strength += this.connections[h.conn]!.area * this.options.strength * h.grade;
    for (const { world } of pick) {
      const la = this.worldToBody(bodyA, world, new THREE.Vector3());
      const lb = this.worldToBody(bodyB, world, new THREE.Vector3());
      // Neighbours in a net: no contact between the pair (it costs solver time and fights the joint).
      // Against fixed structure contacts stay on, so a hinged chunk can't swing into the wall it hangs from.
      link.joints.push(joints.create(bodyA, bodyB, { kind: 'spherical', anchorA: la, anchorB: lb, contacts: !(dynA && dynB) }));
      link.anchors.push([la, lb]);
    }
    // Rebar through each pivot, from inside one piece to inside the other along the contact normal
    // (which points from side a to side b): two bars a hand apart along the patch.
    for (const { h, world } of pick) {
      const k = this.connections[h.conn]!;
      const rot = new THREE.Matrix3().setFromMatrix4(this.debris.restToWorld(h.a !== GROUND ? h.a : h.b, _m));
      const n = new THREE.Vector3(...k.normal).applyMatrix3(rot).normalize();
      const along = new THREE.Vector3(...k.e1).applyMatrix3(rot).normalize();
      const aOnA = this.bodyOfSide(h.a) === bodyA;
      for (const side of [-0.06, 0.06]) {
        const at = world.clone().addScaledVector(along, side);
        const inA = at.clone().addScaledVector(n, aOnA ? -BAR_DEPTH : BAR_DEPTH);
        const inB = at.clone().addScaledVector(n, aOnA ? BAR_DEPTH : -BAR_DEPTH);
        link.bars.push([this.worldToBody(bodyA, inA, inA), this.worldToBody(bodyB, inB, inB)]);
      }
    }
    for (const b of [bodyA, bodyB]) this.linksOnBody.set(b, (this.linksOnBody.get(b) ?? 0) + 1);
    return link;
  }

  private dropLink(link: Link): void {
    const joints = this.debris.physics.joints;
    for (const j of link.joints) joints.remove(j);
    for (const b of [link.bodyA, link.bodyB]) {
      const n = (this.linksOnBody.get(b) ?? 1) - 1;
      if (n > 0) this.linksOnBody.set(b, n);
      else this.linksOnBody.delete(b);
    }
  }

  /**
   * Bookkeeping check, for probes: joints in the world that no link owns
   * (ropes, and anything else the game made), links whose joints are gone,
   * and bodies whose link count disagrees with the links.
   */
  audit(): { joints: number; untracked: number; deadLinks: number; badCounts: number } {
    const jointsApi = this.debris.physics.joints;
    const expected = new Map<BodyHandle, number>();
    let deadLinks = 0;
    let owned = 0;
    for (const link of this.links.values()) {
      let alive = 0;
      for (const j of link.joints) if (jointsApi.exists(j)) alive++;
      owned += alive;
      if (alive !== link.joints.length) deadLinks++;
      for (const b of [link.bodyA, link.bodyB]) expected.set(b, (expected.get(b) ?? 0) + 1);
    }
    const joints = jointsApi.count;
    let badCounts = 0;
    for (const [h, n] of expected) if ((this.linksOnBody.get(h) ?? 0) !== n) badCounts++;
    for (const h of this.linksOnBody.keys()) if (!expected.has(h)) badCounts++;
    return { joints, untracked: joints - owned, deadLinks, badCounts };
  }

  /** Let go of everything holding this body (the debris guard caught it fighting its joints). */
  release(body: BodyHandle): void {
    for (const [key, link] of this.links) {
      if (link.bodyA !== body && link.bodyB !== body) continue;
      this.tear(link);
      this.dropLink(link);
      this.links.delete(key);
    }
  }

  private tear(link: Link): void {
    for (const h of link.hinges) {
      h.alive = false;
      this.unkey(h, null);
    }
    this.counters.torn++;
    this.changed = true;
  }

  /**
   * Once per fixed step, before physics: regroup hinges by the bodies they
   * now join (bodies split and settle), make or drop joints to match, and
   * wear every link. Returns the pull (N, downward) on each standing chunk
   * that something hangs from, for Strain.
   */
  fixedUpdate(dt: number, gravity: number): Map<number, number> {
    // Dead hinges stay in `ofConn` (a contact never hinges twice) but leave the working list.
    if (++this.ticks % 120 === 0) {
      this.hinges = this.hinges.filter((h) => h.alive);
      for (const [piece, list] of this.byPiece) {
        const live = list.filter((h) => h.alive);
        if (live.length > 0) this.byPiece.set(piece, live);
        else this.byPiece.delete(piece);
      }
    }

    // ---- regroup (only when something moved between bodies) ---------------------
    if (this.changed || this.debris.version !== this.seenVersion) this.regroup();
    return this.wear(dt, gravity);
  }

  /**
   * Bring links in line with which bodies the hinges now join. Only the hinges on pieces that
   * changed body (and new ones) are looked at, and only the links they touched are redone: walking
   * every hinge on every body change cost 1-3 ms a step through a collapse.
   */
  private regroup(): void {
    this.changed = false;
    this.seenVersion = this.debris.version;
    const touched = new Set<Hinge>(this.fresh);
    this.fresh = [];
    for (const p of this.debris.takeMoved()) for (const h of this.byPiece.get(p) ?? []) touched.add(h);
    const dirty = new Set<string>();
    for (const h of touched) {
      let key: string | null = null;
      if (h.alive) {
        const ba = this.bodyOfSide(h.a);
        const bb = this.bodyOfSide(h.b);
        if (ba === null || bb === null) h.alive = false;
        else if (ba !== bb && (this.isDynamic(ba) || this.isDynamic(bb))) key = ba < bb ? `${ba}:${bb}` : `${bb}:${ba}`;
      }
      if (key === h.key) continue;
      this.unkey(h, dirty);
      if (key === null) continue; // dormant: both sides on one body, or both fixed
      h.key = key;
      let set = this.byKey.get(key);
      if (!set) this.byKey.set(key, (set = new Set()));
      set.add(h);
      dirty.add(key);
    }
    for (const key of dirty) this.relink(key);
  }

  /** Take a hinge out of the link it was in; that link needs redoing (`dirty`). */
  private unkey(h: Hinge, dirty: Set<string> | null): void {
    if (h.key === null) return;
    const set = this.byKey.get(h.key);
    set?.delete(h);
    if (set && set.size === 0) this.byKey.delete(h.key);
    dirty?.add(h.key);
    h.key = null;
  }

  /** Make the link for `key` match the hinges now joining its two bodies (unchanged links are kept as they are). */
  private relink(key: string): void {
    const set = this.byKey.get(key);
    const old = this.links.get(key);
    if (!set || set.size === 0) {
      if (old) {
        this.dropLink(old);
        this.links.delete(key);
      }
      return;
    }
    const hs = [...set].sort((a, b) => a.id - b.id);
    const sig = hs.map((h) => h.id).join(',');
    if (old && old.sig === sig && this.debris.physics.joints.exists(old.joints[0]!)) return;
    if (old) {
      this.dropLink(old);
      this.links.delete(key);
    }
    if (this.links.size >= this.options.maxLinks) {
      // Over budget: these just let go.
      for (const h of hs) {
        h.alive = false;
        this.unkey(h, null);
      }
      return;
    }
    const first = hs[0]!;
    const ba = this.bodyOfSide(first.a)!;
    const bb = this.bodyOfSide(first.b)!;
    const [a, b] = ba < bb ? [ba, bb] : [bb, ba];
    const link = this.makeLink(key, sig, a, b, hs);
    if (link) {
      this.links.set(key, link);
      if (!old) this.counters.formed++;
    }
  }

  /** Wear every link; returns the pull on standing chunks for Strain. */
  private wear(dt: number, gravity: number): Map<number, number> {
    this.poses.clear();
    this.masses.clear();
    this.strain.ratio = 0;
    const pull = new Map<number, number>();
    const o = this.options;
    const p1 = new THREE.Vector3();
    const p2 = new THREE.Vector3();
    // Loose bodies hinged to each other hang together: the whole assembly's
    // weight is carried by its links to fixed structure, shared among them.
    const parent = new Map<BodyHandle, BodyHandle>();
    const find = (h: BodyHandle): BodyHandle => {
      let r = h;
      while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    const mass = new Map<BodyHandle, number>();
    const bodies = this.debris.physics.bodies;
    /** Each body's mass, read once a step (it changes when chunks break out of a body). */
    const massOf = (b: BodyHandle): number => {
      let m = this.masses.get(b);
      if (m === undefined) this.masses.set(b, (m = bodies.mass(b)));
      return m;
    };
    for (const link of this.links.values()) {
      if (link.dynA && !parent.has(link.bodyA)) {
        parent.set(link.bodyA, link.bodyA);
        mass.set(link.bodyA, massOf(link.bodyA));
      }
      if (link.dynB && !parent.has(link.bodyB)) {
        parent.set(link.bodyB, link.bodyB);
        mass.set(link.bodyB, massOf(link.bodyB));
      }
      if (link.dynA && link.dynB) parent.set(find(link.bodyA), find(link.bodyB));
    }
    const weight = new Map<BodyHandle, number>();
    const anchored = new Map<BodyHandle, number>();
    for (const [h, m] of mass) weight.set(find(h), (weight.get(find(h)) ?? 0) + m * gravity);
    for (const link of this.links.values()) {
      if (link.dynA === link.dynB) continue;
      const r = find(link.dynA ? link.bodyA : link.bodyB);
      anchored.set(r, (anchored.get(r) ?? 0) + 1);
    }
    for (const [key, link] of this.links) {
      const { bodyA: A, bodyB: B } = link;
      const loose = link.dynA && link.dynB;
      let load: number;
      if (loose) {
        // Between two loose bodies: roughly the lighter one's weight.
        load = 0.5 * Math.min(massOf(A), massOf(B)) * gravity;
      } else {
        const r = find(link.dynA ? A : B);
        load = (weight.get(r) ?? 0) / Math.max(1, anchored.get(r) ?? 1);
      }
      const pa = this.pose(A);
      const pb = this.pose(B);
      const wa = pa.w;
      const wb = pb.w;
      const swing = Math.hypot(wa.x - wb.x, wa.y - wb.y, wa.z - wb.z);
      const jolt = Math.max(this.debris.joltOf(A), this.debris.joltOf(B));
      const ratio = load / Math.max(1, link.strength);
      const wear = (Math.max(0, ratio - o.endurance) * o.fatigue + swing * o.swingWear) * dt + Math.max(0, jolt - o.joltFloor) * o.joltWear;
      let torn = false;
      for (const h of link.hinges) {
        h.health -= wear;
        if (h.health <= 0) torn = true;
      }
      if (loose) {
        let quiet = swing < 0.25;
        if (quiet) {
          const va = pa.v;
          const vb = pb.v;
          quiet = Math.hypot(va.x, va.y, va.z) < 0.25 && Math.hypot(vb.x, vb.y, vb.z) < 0.25;
        }
        link.still = quiet ? link.still + 1 : 0;
        // Rubble at rest in a heap: the net has done its work.
        if (link.still > 45) {
          for (const h of link.hinges) {
            h.alive = false;
            this.unkey(h, null);
          }
          this.dropLink(link);
          this.links.delete(key);
          continue;
        }
      }
      const tearAt = loose ? o.tearDistance : o.tearDistanceFixed;
      for (const [la, lb] of link.anchors) {
        if (poseToWorld(pa, la, p1).distanceTo(poseToWorld(pb, lb, p2)) > tearAt) torn = true;
      }
      const anchor = link.anchors[0];
      if (!loose && !torn && ratio > this.strain.ratio && anchor) {
        this.strain.ratio = ratio;
        poseToWorld(pa, anchor[0], this.strain.at);
      }
      if (torn) {
        if (this.onTear && anchor) this.onTear(poseToWorld(pa, anchor[0], new THREE.Vector3()), load);
        this.tear(link);
        this.dropLink(link);
        this.links.delete(key);
        continue;
      }
      // The pull on the standing chunks this hangs from, for Strain.
      if (!loose) {
        let n = 0;
        for (const h of link.hinges) n += +this.standing(h.a) + +this.standing(h.b);
        for (const h of link.hinges) for (const p of [h.a, h.b]) if (this.standing(p)) pull.set(p, (pull.get(p) ?? 0) + load / n);
      }
    }
    return pull;
  }

  private pose(b: BodyHandle): BodyPose {
    let p = this.poses.get(b);
    if (!p) {
      p = { t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0, w: 1 }, v: { x: 0, y: 0, z: 0 }, w: { x: 0, y: 0, z: 0 } };
      const bodies = this.debris.physics.bodies;
      bodies.pose(b, p.t, p.r);
      bodies.velocity(b, p.v, p.w);
      this.poses.set(b, p);
    }
    return p;
  }

  private standing(p: number): boolean {
    return p !== GROUND && this.debris.state[p] === STANDING;
  }

  /** The rebar of every live link this step: pairs of world points (inside A, inside B), six numbers a bar. */
  spans(out: number[] = []): number[] {
    out.length = 0;
    const bodies = this.debris.physics.bodies;
    const pose = { t: _t, r: _r };
    for (const link of this.links.values()) {
      for (const [la, lb] of link.bars) {
        bodies.pose(link.bodyA, _t, _r);
        poseToWorld(pose, la, _v);
        out.push(_v.x, _v.y, _v.z);
        bodies.pose(link.bodyB, _t, _r);
        poseToWorld(pose, lb, _v);
        out.push(_v.x, _v.y, _v.z);
      }
    }
    return out;
  }

  dispose(): void {
    for (const link of this.links.values()) this.dropLink(link);
    this.links.clear();
  }
}
