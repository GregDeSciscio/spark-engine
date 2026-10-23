import * as THREE from 'three/webgpu';
import { DisposeBag, Renderable, Transform, type Entity, type EntityWorld, type RenderSync, type WorldLabels } from '@spark/engine';

/**
 * Objectives from `docs/design/mission-shape.md` as level data plus a runner
 * that steps through them. The shape's three kinds for v1 and the leg home:
 *
 * - Reach: enter a volume.
 * - Plant: hold interact inside the volume, then defend the charge until its
 *   fuse runs out. A hostile who works at an armed charge long enough defuses
 *   it, and the objective is back to the hold.
 * - Eliminate: a tagged hostile down (`target`), or with no tag every hostile.
 * - Extract: a Reach that ends the mission.
 *
 * Completing an objective moves the checkpoint there. The runner draws one
 * ground marker and label for the current objective and nothing else; it owns
 * no player or enemy state, and asks the scene about the world through
 * `ObjectiveWorld`.
 */
export type ObjectiveKind = 'reach' | 'plant' | 'eliminate' | 'extract';

export interface ObjectiveDef {
  readonly id: string;
  readonly kind: ObjectiveKind;
  /** Short imperative for the HUD: "Reach the square". */
  readonly label: string;
  /** Feet position of the marker / volume centre. For a tagged Eliminate, where the target starts. */
  readonly position: THREE.Vector3;
  /** Horizontal radius of the volume. */
  readonly radius: number;
  /** Plant only: seconds the interact key must be held inside the volume. */
  readonly holdSeconds?: number;
  /** Plant only: seconds the armed charge must survive. 0 (the default) completes on the hold, with nothing to defend. */
  readonly fuseSeconds?: number;
  /** Plant only: seconds a hostile at the charge takes to defuse it. */
  readonly defuseSeconds?: number;
  /** Eliminate only: the hostile to kill, by name. Absent, the objective is every hostile. */
  readonly target?: string;
}

/** What the runner needs to know about the world each step; the scene answers. */
export interface ObjectiveWorld {
  /** Live hostiles, for an untagged Eliminate. */
  readonly hostilesAlive: number;
  /** A named hostile's feet, written into `out`. False once it is dead or out of the world. */
  targetPosition(name: string, out: THREE.Vector3): boolean;
  /** Whether a live hostile is within `radius` of `position`: someone is at the charge. */
  hostileWithin(position: THREE.Vector3, radius: number): boolean;
}

export interface Checkpoint {
  readonly position: THREE.Vector3;
  readonly yaw: number;
}

export interface MissionDeps {
  readonly entities: EntityWorld;
  readonly scene: THREE.Scene;
  readonly labels: WorldLabels;
  readonly renderSync: RenderSync;
}

export type PlantPhase = 'hold' | 'armed';

export interface MissionStatus {
  readonly objective: ObjectiveDef | null;
  readonly index: number;
  readonly total: number;
  readonly distance: number;
  readonly inRange: boolean;
  /** 0..1 hold progress for Plant, 0 otherwise. */
  readonly progress: number;
  /** Plant only: holding interact, or the charge is set and burning. Null for other kinds. */
  readonly phase: PlantPhase | null;
  /** Seconds left on an armed charge, 0 otherwise. */
  readonly fuse: number;
  /** 0..1 how far a hostile has got with defusing it. */
  readonly defuse: number;
  readonly complete: boolean;
}

/** Something the scene reacts to: a sound, a set piece, a log line. Drained once per step. */
export interface ObjectiveEvent {
  readonly kind: 'armed' | 'defused' | 'detonated' | 'completed';
  readonly objective: ObjectiveDef;
}

const MARKER_COLOR = 0x4dd2ff;
/** How close a hostile has to be to an armed charge to work on it. */
export const DEFUSE_RADIUS = 1.8;
const DEFAULT_DEFUSE_SECONDS = 4;
const MARKER_TEXT: Record<ObjectiveKind, string> = { reach: 'GO', plant: 'PLANT', eliminate: 'TARGET', extract: 'EXTRACT' };

export class MissionRunner {
  readonly objectives: readonly ObjectiveDef[];
  checkpoint: Checkpoint;

  private readonly deps: MissionDeps;
  private readonly start: Checkpoint;
  private readonly bag = new DisposeBag();
  private index = 0;
  private hold = 0;
  /** The armed charge, while one is burning. */
  private armed: { fuse: number; defuse: number } | null = null;
  private readonly events: ObjectiveEvent[] = [];
  private readonly markerEid: Entity;
  private readonly marker: THREE.Group;
  private readonly ring: THREE.Mesh;
  private readonly at = new THREE.Vector3();
  private time = 0;
  private lastDistance = Infinity;
  private lastInRange = false;
  private markerText = '';

  constructor(deps: MissionDeps, objectives: readonly ObjectiveDef[], start: Checkpoint) {
    this.deps = deps;
    this.objectives = objectives;
    this.start = { position: start.position.clone(), yaw: start.yaw };
    this.checkpoint = { position: start.position.clone(), yaw: start.yaw };
    const { entities, scene, labels, renderSync } = deps;

    // One marker, moved from objective to objective: a flat glowing ring plus a floating label.
    this.marker = new THREE.Group();
    const ringGeo = new THREE.RingGeometry(0.85, 1.0, 48);
    const ringMat = new THREE.MeshBasicMaterial({ color: MARKER_COLOR, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.04;
    const postGeo = new THREE.CylinderGeometry(0.03, 0.03, 2.2, 8);
    const postMat = new THREE.MeshBasicMaterial({ color: MARKER_COLOR, transparent: true, opacity: 0.35, depthWrite: false });
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.y = 1.1;
    this.marker.add(this.ring, post);
    scene.add(this.marker);
    this.bag.add(() => {
      scene.remove(this.marker);
      ringGeo.dispose();
      ringMat.dispose();
      postGeo.dispose();
      postMat.dispose();
    });
    this.markerEid = entities.create(Transform);
    this.bag.add(() => entities.destroy(this.markerEid));
    renderSync.attach(entities, this.markerEid, this.marker);
    labels.attach(this.markerEid, { kind: 'text', text: '', color: '#4dd2ff', offsetY: 2.5 });
    this.bag.add(() => labels.detach(this.markerEid));
    this.placeMarker();
  }

  get current(): ObjectiveDef | null {
    return this.objectives[this.index] ?? null;
  }

  get complete(): boolean {
    return this.index >= this.objectives.length;
  }

  /** The charge is set and burning: where it is, for the scene's prop and the hostiles' hunt. */
  get armedCharge(): ObjectiveDef | null {
    return this.armed ? this.current : null;
  }

  status(): MissionStatus {
    const obj = this.current;
    const plant = obj?.kind === 'plant';
    return {
      objective: obj,
      index: this.index,
      total: this.objectives.length,
      distance: this.lastDistance,
      inRange: this.lastInRange,
      progress: plant ? Math.min(1, this.hold / (obj.holdSeconds ?? 3)) : 0,
      phase: plant ? (this.armed ? 'armed' : 'hold') : null,
      fuse: this.armed ? Math.max(0, this.armed.fuse) : 0,
      defuse: this.armed && obj ? Math.min(1, this.armed.defuse / (obj.defuseSeconds ?? DEFAULT_DEFUSE_SECONDS)) : 0,
      complete: this.complete,
    };
  }

  /** What happened since the last call, oldest first. */
  takeEvents(): ObjectiveEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /** Advance the current objective. `interact` is whether the interact key is held this tick. */
  fixedUpdate(dt: number, playerFeet: THREE.Vector3, interact: boolean, world: ObjectiveWorld): void {
    this.time += dt;
    const ring = this.ring.scale;
    const pulse = 1 + Math.sin(this.time * (this.armed ? 9 : 3)) * 0.06;
    ring.set(pulse, pulse, 1);

    const obj = this.current;
    if (!obj) return;
    // A tagged target moves: the marker and the distance follow it.
    const tracked = obj.kind === 'eliminate' && obj.target !== undefined;
    const targetAlive = tracked && world.targetPosition(obj.target as string, this.at);
    if (targetAlive) this.moveMarker(this.at);
    else this.at.copy(obj.position);
    const dx = playerFeet.x - this.at.x;
    const dz = playerFeet.z - this.at.z;
    this.lastDistance = Math.hypot(dx, dz);
    this.lastInRange = this.lastDistance <= obj.radius;

    let done = false;
    switch (obj.kind) {
      case 'reach':
      case 'extract':
        done = this.lastInRange;
        break;
      case 'plant':
        done = this.plant(dt, obj, interact, world);
        break;
      case 'eliminate':
        done = tracked ? !targetAlive : world.hostilesAlive === 0;
        break;
    }
    if (!done) return;

    this.hold = 0;
    this.armed = null;
    this.checkpoint = { position: obj.position.clone(), yaw: this.checkpoint.yaw };
    this.events.push({ kind: 'completed', objective: obj });
    this.index += 1;
    this.placeMarker();
  }

  /** The two halves of a plant: the hold, then the fuse. Returns whether it went off. */
  private plant(dt: number, obj: ObjectiveDef, interact: boolean, world: ObjectiveWorld): boolean {
    if (!this.armed) {
      if (this.lastInRange && interact) this.hold += dt;
      else this.hold = Math.max(0, this.hold - dt * 2);
      if (this.hold < (obj.holdSeconds ?? 3)) return false;
      if ((obj.fuseSeconds ?? 0) <= 0) return true;
      this.armed = { fuse: obj.fuseSeconds ?? 0, defuse: 0 };
      this.events.push({ kind: 'armed', objective: obj });
      this.placeMarker();
      return false;
    }
    this.armed.fuse -= dt;
    // Work on the charge builds while someone is at it and bleeds off when they are driven away.
    if (world.hostileWithin(obj.position, DEFUSE_RADIUS)) this.armed.defuse += dt;
    else this.armed.defuse = Math.max(0, this.armed.defuse - dt);
    if (this.armed.defuse >= (obj.defuseSeconds ?? DEFAULT_DEFUSE_SECONDS)) {
      this.armed = null;
      this.hold = 0;
      this.events.push({ kind: 'defused', objective: obj });
      this.placeMarker();
      return false;
    }
    if (this.armed.fuse > 0) return false;
    this.events.push({ kind: 'detonated', objective: obj });
    return true;
  }

  /** Checkpoint reload: the current objective starts over. A charge that was burning is gone. */
  resetProgress(): void {
    this.hold = 0;
    this.armed = null;
    this.events.length = 0;
    this.placeMarker();
  }

  /** A fresh run: the first objective and the insertion checkpoint. */
  restart(): void {
    this.index = 0;
    this.checkpoint = { position: this.start.position.clone(), yaw: this.start.yaw };
    this.lastDistance = Infinity;
    this.lastInRange = false;
    this.resetProgress();
  }

  private moveMarker(position: THREE.Vector3): void {
    const t = this.deps.entities.store(Transform);
    t.x[this.markerEid] = position.x;
    t.y[this.markerEid] = position.y;
    t.z[this.markerEid] = position.z;
  }

  private placeMarker(): void {
    const { entities, labels } = this.deps;
    const obj = this.current;
    // RenderSync writes the group's visibility and scale from the entity every
    // frame, so both go through the components. Set on the Object3D they were
    // overwritten: the ring never took its radius and never hid at the end.
    entities.store(Renderable).visible[this.markerEid] = obj ? 1 : 0;
    const text = !obj ? '' : this.armed ? 'ARMED' : obj.kind === 'eliminate' && obj.target === undefined ? 'CLEAR' : MARKER_TEXT[obj.kind];
    if (text !== this.markerText) {
      this.markerText = text;
      labels.setText(this.markerEid, text);
    }
    if (!obj) return;
    this.moveMarker(obj.position);
    const t = entities.store(Transform);
    t.sx[this.markerEid] = obj.radius;
    t.sy[this.markerEid] = 1;
    t.sz[this.markerEid] = obj.radius;
  }

  dispose(): void {
    this.bag.dispose();
  }
}
