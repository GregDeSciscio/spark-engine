import * as THREE from 'three/webgpu';
import type { Random } from '../core/Random';

/**
 * The camera model from ADR-004: isometric / three-quarter and close
 * third-person are primary. The rig owns a PerspectiveCamera, follows a target
 * with frame-rate-independent damping, adds look-ahead, and shakes via a
 * trauma value that decays over time.
 *
 * The math lives in plain functions so it can be tested without three.
 */

export interface CameraRigPreset {
  /** Rotation around the world Y axis, radians. 0 looks down -Z. */
  readonly yaw: number;
  /** Angle above the horizon, radians. Positive looks down. */
  readonly pitch: number;
  readonly distance: number;
  readonly fov: number;
  /** Damping rate (1/s). Higher = snappier. ~6 feels like a tight follow, ~2 floaty. */
  readonly followRate: number;
  /** How far ahead of the target (along its velocity) the framing leads, in seconds of travel. */
  readonly lookAheadSeconds: number;
  readonly lookAheadRate: number;
  /** Peak shake translation in world units at trauma 1. */
  readonly shakeTranslation: number;
  /** Peak shake roll in radians at trauma 1. */
  readonly shakeRoll: number;
  /** Trauma lost per second. */
  readonly traumaDecay: number;
}

/** Fixed three-quarter view with a narrow fov: reads nearly orthographic. */
export const ISOMETRIC_PRESET: CameraRigPreset = {
  yaw: Math.PI / 4,
  pitch: THREE.MathUtils.degToRad(38),
  distance: 26,
  fov: 30,
  followRate: 5,
  lookAheadSeconds: 0.35,
  lookAheadRate: 3,
  shakeTranslation: 0.35,
  shakeRoll: THREE.MathUtils.degToRad(1.5),
  traumaDecay: 1.4,
};

/** Close over-the-shoulder orbit. */
export const THIRD_PERSON_PRESET: CameraRigPreset = {
  yaw: 0,
  pitch: THREE.MathUtils.degToRad(18),
  distance: 6,
  fov: 55,
  followRate: 8,
  lookAheadSeconds: 0.25,
  lookAheadRate: 5,
  shakeTranslation: 0.15,
  shakeRoll: THREE.MathUtils.degToRad(2),
  traumaDecay: 1.6,
};

/**
 * Frame-rate independent exponential damping. Moves `current` toward `target`
 * by the fraction `1 - e^(-rate * dt)`, so the same wall time always yields the
 * same fraction of the distance regardless of frame count.
 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  if (dt <= 0 || rate <= 0) return current;
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** Camera offset from its target for a yaw/pitch/distance orbit. */
export function orbitOffset(yaw: number, pitch: number, distance: number): { x: number; y: number; z: number } {
  const horizontal = Math.cos(pitch) * distance;
  return {
    x: Math.sin(yaw) * horizontal,
    y: Math.sin(pitch) * distance,
    z: Math.cos(yaw) * horizontal,
  };
}

export function decayTrauma(trauma: number, decayPerSecond: number, dt: number): number {
  return Math.max(0, Math.min(1, trauma - decayPerSecond * dt));
}

/**
 * Shake magnitude for a trauma level. Squared so small hits are subtle and
 * large ones bite (the standard "trauma" model).
 */
export function shakeAmount(trauma: number): number {
  const t = Math.max(0, Math.min(1, trauma));
  return t * t;
}

export interface CameraRigOptions {
  preset?: CameraRigPreset;
  aspect?: number;
  near?: number;
  far?: number;
  /** Seeded source for the shake. Same seed + same trauma → same shake. */
  random?: Random;
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  /** Where the rig wants to look. Set every frame for a moving hero. */
  readonly target = new THREE.Vector3();

  private preset: CameraRigPreset;
  private yaw: number;
  private pitch: number;
  private distance: number;
  private readonly focus = new THREE.Vector3();
  private readonly lookAhead = new THREE.Vector3();
  private readonly previousTarget = new THREE.Vector3();
  private hasPrevious = false;
  private trauma = 0;
  private readonly random: Random | null;
  private readonly shakeOffset = new THREE.Vector3();
  private shakeRoll = 0;
  private readonly tmp = new THREE.Vector3();

  constructor(options: CameraRigOptions = {}) {
    this.preset = options.preset ?? ISOMETRIC_PRESET;
    this.yaw = this.preset.yaw;
    this.pitch = this.preset.pitch;
    this.distance = this.preset.distance;
    this.random = options.random ?? null;
    this.camera = new THREE.PerspectiveCamera(this.preset.fov, options.aspect ?? 16 / 9, options.near ?? 0.1, options.far ?? 200);
  }

  getPreset(): CameraRigPreset {
    return this.preset;
  }

  setPreset(preset: CameraRigPreset): void {
    this.preset = preset;
    this.yaw = preset.yaw;
    this.pitch = preset.pitch;
    this.distance = preset.distance;
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
  }

  /** Orbit controls for the third-person preset. Isometric callers normally leave these alone. */
  setOrbit(yaw: number, pitch: number, distance: number = this.distance): void {
    this.yaw = yaw;
    this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
    this.distance = Math.max(0.1, distance);
  }

  getOrbit(): { yaw: number; pitch: number; distance: number } {
    return { yaw: this.yaw, pitch: this.pitch, distance: this.distance };
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Add shake. Clamped to [0, 1]; stacking hits saturates rather than explodes. */
  addTrauma(amount: number): void {
    this.trauma = Math.max(0, Math.min(1, this.trauma + amount));
  }

  getTrauma(): number {
    return this.trauma;
  }

  /** Snap the rig to its target with no damping (scene start, teleports). */
  snap(): void {
    this.focus.copy(this.target);
    this.lookAhead.set(0, 0, 0);
    this.previousTarget.copy(this.target);
    this.hasPrevious = true;
    this.apply();
  }

  update(dt: number): void {
    const p = this.preset;

    // Look-ahead from the target's own motion, damped so it does not jitter.
    if (this.hasPrevious && dt > 0) {
      this.tmp.subVectors(this.target, this.previousTarget).divideScalar(dt).multiplyScalar(p.lookAheadSeconds);
    } else {
      this.tmp.set(0, 0, 0);
    }
    this.lookAhead.x = damp(this.lookAhead.x, this.tmp.x, p.lookAheadRate, dt);
    this.lookAhead.y = damp(this.lookAhead.y, this.tmp.y, p.lookAheadRate, dt);
    this.lookAhead.z = damp(this.lookAhead.z, this.tmp.z, p.lookAheadRate, dt);
    this.previousTarget.copy(this.target);
    this.hasPrevious = true;

    // Damped follow.
    const goalX = this.target.x + this.lookAhead.x;
    const goalY = this.target.y + this.lookAhead.y;
    const goalZ = this.target.z + this.lookAhead.z;
    this.focus.x = damp(this.focus.x, goalX, p.followRate, dt);
    this.focus.y = damp(this.focus.y, goalY, p.followRate, dt);
    this.focus.z = damp(this.focus.z, goalZ, p.followRate, dt);

    // Shake.
    this.trauma = decayTrauma(this.trauma, p.traumaDecay, dt);
    const amount = shakeAmount(this.trauma);
    if (amount > 0 && this.random) {
      this.shakeOffset.set(
        this.random.range(-1, 1) * amount * p.shakeTranslation,
        this.random.range(-1, 1) * amount * p.shakeTranslation,
        this.random.range(-1, 1) * amount * p.shakeTranslation * 0.5,
      );
      this.shakeRoll = this.random.range(-1, 1) * amount * p.shakeRoll;
    } else {
      this.shakeOffset.set(0, 0, 0);
      this.shakeRoll = 0;
    }

    this.apply();
  }

  private apply(): void {
    const offset = orbitOffset(this.yaw, this.pitch, this.distance);
    const cam = this.camera;
    cam.position.set(this.focus.x + offset.x + this.shakeOffset.x, this.focus.y + offset.y + this.shakeOffset.y, this.focus.z + offset.z + this.shakeOffset.z);
    cam.up.set(Math.sin(this.shakeRoll), Math.cos(this.shakeRoll), 0);
    cam.lookAt(this.focus.x + this.shakeOffset.x * 0.5, this.focus.y + this.shakeOffset.y * 0.5, this.focus.z);
    cam.updateMatrixWorld();
  }
}
