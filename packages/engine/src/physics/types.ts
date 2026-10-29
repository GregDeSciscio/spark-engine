import type { Entity } from '../ecs/EntityWorld';
import type { BodyType } from './components';
import type { LayerSpec } from './Layers';

/**
 * Plain value types shared by the physics module's entity API (`PhysicsWorld`)
 * and its handle layer (`Bodies`, `Joints`). No Rapier types appear here.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** A position and an optional rotation (identity when left out). */
export interface Pose {
  position: Vec3Like;
  rotation?: QuatLike | undefined;
}

export type ShapeDesc =
  | { kind: 'box'; hx: number; hy: number; hz: number }
  | { kind: 'sphere'; radius: number }
  | { kind: 'capsule'; halfHeight: number; radius: number }
  | { kind: 'trimesh'; vertices: Float32Array; indices: Uint32Array }
  | {
      kind: 'heightfield';
      /** Row-major `rows × cols` heights (Rapier layout: rows along Z, columns along X). */
      rows: number;
      cols: number;
      heights: Float32Array;
      /** World size of the field along x/z and the height multiplier along y. */
      scale: Vec3Like;
    }
  /** The convex hull of a point cloud (`x, y, z` triples), computed when the collider is made. */
  | { kind: 'convexHull'; points: Float32Array }
  /**
   * A mesh that is already convex: `vertices` as `x, y, z` triples and
   * `indices` as triangles. No hull is computed, so it is the cheap way to
   * build many convex pieces whose faces are known (fracture chunks).
   */
  | { kind: 'convexMesh'; vertices: Float32Array; indices: Uint32Array };

/** Anchors are in each body's local frame. */
export type JointDesc =
  | { kind: 'spherical'; anchorA: Vec3Like; anchorB: Vec3Like }
  | { kind: 'revolute'; anchorA: Vec3Like; anchorB: Vec3Like; axis: Vec3Like }
  | { kind: 'fixed'; anchorA: Vec3Like; anchorB: Vec3Like }
  /** The anchors may come apart up to `length` and no further (slack below it). */
  | { kind: 'rope'; anchorA: Vec3Like; anchorB: Vec3Like; length: number };

/** A joint description plus options that apply to every kind. */
export type JointOptions = JointDesc & {
  /**
   * Whether the two joined bodies still collide with each other. Default
   * true (Rapier's default). Turn it off for neighbours in a jointed net,
   * where contacts cost solver time and fight the joint.
   */
  contacts?: boolean | undefined;
};

/** Handles are plain integers, never reused, so they fit typed arrays and ECS components. */
export type BodyHandle = number & { readonly __physicsHandle: 'body' };
export type ColliderHandle = number & { readonly __physicsHandle: 'collider' };
export type JointHandle = number & { readonly __physicsHandle: 'joint' };

/** The part id of a collider that was given none. */
export const NO_PART = -1;

export interface BodyInit {
  type: BodyType;
  position?: Vec3Like | undefined;
  rotation?: QuatLike | undefined;
  linearVelocity?: Vec3Like | undefined;
  angularVelocity?: Vec3Like | undefined;
  /** Continuous collision detection for fast dynamic bodies. */
  ccd?: boolean | undefined;
  lockRotations?: boolean | undefined;
  linearDamping?: number | undefined;
  angularDamping?: number | undefined;
}

export interface ColliderInit {
  shape: ShapeDesc;
  /**
   * The entity this collider belongs to: raycasts, overlaps and contact
   * events report it. It must exist; when it is destroyed, every collider it
   * owns is removed with it.
   */
  owner: Entity;
  /** What part of the owner this is (a chunk, a limb). Reported with hits. Default `NO_PART`. */
  part?: number | undefined;
  /** Offset from the body's origin, in the body's frame. */
  position?: Vec3Like | undefined;
  rotation?: QuatLike | undefined;
  /** Mass per unit volume. Default 1. Ignored on fixed bodies, which have no mass. */
  density?: number | undefined;
  /** Explicit mass, overriding density. Ignored on fixed bodies. */
  mass?: number | undefined;
  friction?: number | undefined;
  restitution?: number | undefined;
  /** Layer this collider belongs to. Default `'default'`. */
  layer?: LayerSpec | undefined;
  /** Layers it collides with. Default `'all'`. */
  collidesWith?: LayerSpec | undefined;
  /** Sensors detect overlaps (trigger events) without a physical response. */
  isSensor?: boolean | undefined;
  /**
   * Report contacts (or trigger overlaps) involving this collider. Default
   * false, so bulk debris costs no event traffic; Rapier still reports a pair
   * when the other collider has events on.
   */
  events?: boolean | undefined;
  /**
   * Report this collider's contact forces above this many newtons, through
   * `PhysicsWorld.contactForces`. Default: none.
   */
  forceEvents?: number | undefined;
}

/** Who a collider belongs to. */
export interface ColliderInfo {
  readonly body: BodyHandle;
  readonly owner: Entity;
  readonly part: number;
}

/** A joint's two bodies and where it holds each, in that body's frame. */
export interface JointAnchors {
  readonly bodyA: BodyHandle;
  readonly bodyB: BodyHandle;
  readonly anchorA: Readonly<Vec3Like>;
  readonly anchorB: Readonly<Vec3Like>;
}

export interface OverlapOptions {
  /** Only report colliders on these layers. Default all. */
  layers?: LayerSpec | undefined;
  /** Include sensors. Default false. */
  includeSensors?: boolean | undefined;
  /** Skip this collider (the one being tested, when `shape` is a collider). */
  excludeCollider?: ColliderHandle | undefined;
  /** Skip every collider on this body. */
  excludeBody?: BodyHandle | undefined;
  /** Skip every collider this entity owns, and its body. */
  excludeEid?: Entity | undefined;
}

/**
 * Called per overlapping collider with its owner and part. Return `false` to
 * stop the query early.
 */
export type OverlapVisitor = (collider: ColliderHandle, owner: Entity, part: number) => boolean | void;

/** One touching pair's contact force in the last step: `force` (N, world) is what `a` pushes `b` with. */
export type ContactForceVisitor = (a: ColliderHandle, b: ColliderHandle, force: Readonly<Vec3Like>) => void;
