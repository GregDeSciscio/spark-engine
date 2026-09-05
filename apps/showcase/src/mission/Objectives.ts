import * as THREE from 'three/webgpu';
import { DisposeBag, Transform, type Entity, type EntityWorld, type RenderSync, type WorldLabels } from '@spark/engine';

/**
 * Objectives from `docs/design/mission-shape.md` as level data plus a runner
 * that steps through them. Three kinds for v1: Reach (enter a volume), Plant
 * (hold interact inside the volume for a few seconds), Eliminate (every
 * listed hostile down). Completing an objective moves the checkpoint there.
 * The runner draws one ground marker and label for the current objective and
 * nothing else; it owns no player or enemy state.
 */
export type ObjectiveKind = 'reach' | 'plant' | 'eliminate';

export interface ObjectiveDef {
  readonly id: string;
  readonly kind: ObjectiveKind;
  /** Short imperative for the HUD: "Reach the square". */
  readonly label: string;
  /** Feet position of the marker / volume centre. */
  readonly position: THREE.Vector3;
  /** Horizontal radius of the volume. */
  readonly radius: number;
  /** Plant only: seconds the interact key must be held inside the volume. */
  readonly holdSeconds?: number;
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

export interface MissionStatus {
  readonly objective: ObjectiveDef | null;
  readonly index: number;
  readonly total: number;
  readonly distance: number;
  readonly inRange: boolean;
  /** 0..1 hold progress for Plant, 0 otherwise. */
  readonly progress: number;
  readonly complete: boolean;
}

const MARKER_COLOR = 0x4dd2ff;

export class MissionRunner {
  readonly objectives: readonly ObjectiveDef[];
  checkpoint: Checkpoint;
  /** Set for one tick when an objective completes; the scene reads and clears it. */
  justCompleted: ObjectiveDef | null = null;

  private readonly deps: MissionDeps;
  private readonly bag = new DisposeBag();
  private index = 0;
  private hold = 0;
  private readonly markerEid: Entity;
  private readonly marker: THREE.Group;
  private readonly ring: THREE.Mesh;
  private time = 0;
  private lastDistance = Infinity;
  private lastInRange = false;

  constructor(deps: MissionDeps, objectives: readonly ObjectiveDef[], start: Checkpoint) {
    this.deps = deps;
    this.objectives = objectives;
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

  status(): MissionStatus {
    return {
      objective: this.current,
      index: this.index,
      total: this.objectives.length,
      distance: this.lastDistance,
      inRange: this.lastInRange,
      progress: this.current?.kind === 'plant' ? Math.min(1, this.hold / (this.current.holdSeconds ?? 3)) : 0,
      complete: this.complete,
    };
  }

  /**
   * Advance the current objective. `interact` is whether the interact key is
   * held this tick; `hostilesAlive` feeds Eliminate.
   */
  fixedUpdate(dt: number, playerFeet: THREE.Vector3, interact: boolean, hostilesAlive: number): void {
    this.time += dt;
    const ring = this.ring.scale;
    const pulse = 1 + Math.sin(this.time * 3) * 0.06;
    ring.set(pulse, pulse, 1);

    const obj = this.current;
    if (!obj) return;
    const dx = playerFeet.x - obj.position.x;
    const dz = playerFeet.z - obj.position.z;
    this.lastDistance = Math.hypot(dx, dz);
    this.lastInRange = this.lastDistance <= obj.radius;

    let done = false;
    switch (obj.kind) {
      case 'reach':
        done = this.lastInRange;
        break;
      case 'plant':
        if (this.lastInRange && interact) this.hold += dt;
        else this.hold = Math.max(0, this.hold - dt * 2);
        done = this.hold >= (obj.holdSeconds ?? 3);
        break;
      case 'eliminate':
        done = hostilesAlive === 0;
        break;
    }
    if (!done) return;

    this.hold = 0;
    this.checkpoint = { position: obj.position.clone(), yaw: this.checkpoint.yaw };
    this.justCompleted = obj;
    this.index += 1;
    this.placeMarker();
  }

  /** Back to the checkpoint's objective state (the current objective stays current). */
  resetProgress(): void {
    this.hold = 0;
  }

  private placeMarker(): void {
    const { entities, labels } = this.deps;
    const obj = this.current;
    this.marker.visible = obj !== null;
    if (!obj) {
      labels.setText(this.markerEid, '');
      return;
    }
    const t = entities.store(Transform);
    t.x[this.markerEid] = obj.position.x;
    t.y[this.markerEid] = obj.position.y;
    t.z[this.markerEid] = obj.position.z;
    const s = obj.radius;
    this.marker.scale.set(s, 1, s);
    labels.setText(this.markerEid, obj.kind === 'plant' ? 'PLANT' : obj.kind === 'reach' ? 'GO' : 'CLEAR');
  }

  dispose(): void {
    this.bag.dispose();
  }
}
