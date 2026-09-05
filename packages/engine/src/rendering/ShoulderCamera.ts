import * as THREE from 'three/webgpu';

/**
 * Over-the-shoulder camera for the customer game (ADR-004, ADR-005). Unlike
 * `CameraRig`, which follows a target with damping and lets the game pick the
 * framing, this is a *controlled* camera: the player's mouse owns yaw and
 * pitch directly, the camera hangs behind and beside a shoulder pivot, and it
 * pulls in when geometry would occlude the pivot. Aim-down-sights tightens the
 * distance, side offset, fov and sensitivity.
 *
 * The rig is renderer-only. Occlusion is injected as a callback so the caller
 * decides what blocks the camera (normally a physics raycast on the world
 * layer, excluding the player).
 */
export interface ShoulderCameraPreset {
  /** Distance behind the shoulder pivot at the hip, world units. */
  readonly distance: number;
  /** Sideways offset of the pivot from the character's centre line; positive is the right shoulder. */
  readonly sideOffset: number;
  /** Pivot height as a fraction of the character's current height (Task Unit: 1.3 / 1.8). */
  readonly shoulderRatio: number;
  readonly fov: number;
  readonly aimDistance: number;
  readonly aimSideOffset: number;
  readonly aimFov: number;
  /** Damping rate (1/s) for the hip/aim blend. */
  readonly aimRate: number;
  /** Radians of yaw per CSS pixel of pointer movement. */
  readonly sensitivity: number;
  /** Sensitivity multiplier while aiming. */
  readonly aimSensitivityScale: number;
  /** Furthest the player can look down, radians (positive). */
  readonly maxPitchDown: number;
  /** Furthest the player can look up, radians (positive). */
  readonly maxPitchUp: number;
  /** Gap kept between the camera and whatever it pulls in against. */
  readonly collisionRadius: number;
}

/** Task Unit's third-person numbers, translated: shoulder focus at 72% height, close orbit, tight ADS. */
export const SHOULDER_PRESET: ShoulderCameraPreset = {
  distance: 2.8,
  sideOffset: 0.55,
  shoulderRatio: 1.3 / 1.8,
  fov: 60,
  aimDistance: 1.55,
  aimSideOffset: 0.6,
  aimFov: 42,
  aimRate: 12,
  sensitivity: 0.0022,
  aimSensitivityScale: 0.5,
  maxPitchDown: THREE.MathUtils.degToRad(70),
  maxPitchUp: THREE.MathUtils.degToRad(60),
  collisionRadius: 0.25,
};

/**
 * Distance along `direction` from `origin` to the first blocker within
 * `maxDistance`, or null when the way is clear. Direction is unit length.
 */
export type CameraOccluder = (origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number) => number | null;

export interface ShoulderCameraOptions {
  preset?: ShoulderCameraPreset;
  aspect?: number;
  near?: number;
  far?: number;
}

/** Clamp a pitch (positive looks down) into the preset's range. */
export function clampPitch(pitch: number, preset: ShoulderCameraPreset): number {
  return Math.min(preset.maxPitchDown, Math.max(-preset.maxPitchUp, pitch));
}

/** View basis for a yaw/pitch pair. Yaw 0 looks down -Z; positive pitch looks down. */
export function shoulderFrame(yaw: number, pitch: number, forward: THREE.Vector3, right: THREE.Vector3): void {
  const cp = Math.cos(pitch);
  forward.set(-Math.sin(yaw) * cp, -Math.sin(pitch), -Math.cos(yaw) * cp);
  right.set(Math.cos(yaw), 0, -Math.sin(yaw));
}

const _tmpRight = new THREE.Vector3();

/** Frame-rate independent exponential damping (same curve as `CameraRig`'s `damp`). */
function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export class ShoulderCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** The character's feet position in world space. Set every frame. */
  readonly target = new THREE.Vector3();
  /** The character's current height (stance-dependent). The pivot sits at `shoulderRatio` of it. */
  height = 1.8;
  /** Aim-down-sights. The blend toward the aim numbers is damped, so flipping this is smooth. */
  aiming = false;
  /** Where aim rays start: the shoulder pivot after the last `update()`. */
  readonly pivot = new THREE.Vector3();
  /**
   * Recoil offsets added on top of the player's look, radians. The game sets
   * them every tick from its weapon state; they do not accumulate into
   * `yaw`/`pitch`, so when the kick returns to zero the view returns with it.
   * Negative pitch is upward.
   */
  recoilPitch = 0;
  recoilYaw = 0;

  private readonly preset: ShoulderCameraPreset;
  private yaw = 0;
  private pitch = 0;
  private aimBlend = 0;
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly toCamera = new THREE.Vector3();

  constructor(options: ShoulderCameraOptions = {}) {
    this.preset = options.preset ?? SHOULDER_PRESET;
    this.camera = new THREE.PerspectiveCamera(this.preset.fov, options.aspect ?? 16 / 9, options.near ?? 0.05, options.far ?? 200);
    this.camera.rotation.order = 'YXZ';
  }

  getYaw(): number {
    return this.yaw;
  }

  getPitch(): number {
    return this.pitch;
  }

  setLook(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = clampPitch(pitch, this.preset);
  }

  /** Apply pointer movement in CSS pixels. Positive dy looks down. */
  look(dx: number, dy: number): void {
    const s = this.preset.sensitivity * (this.aiming ? this.preset.aimSensitivityScale : 1);
    this.yaw -= dx * s;
    this.pitch = clampPitch(this.pitch + dy * s, this.preset);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Unit forward on the ground plane (what "move forward" means to the character). */
  groundForward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  /** Unit right on the ground plane. */
  groundRight(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  /** Full view direction including pitch and recoil (for aim rays). Valid after `update()` / `snap()`. */
  viewForward(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.forward);
  }

  /**
   * View direction with an extra angular offset on top of look and recoil:
   * the reticle's own kick (the part of recoil the camera did not follow).
   */
  directionFor(yawOffset: number, pitchOffset: number, out: THREE.Vector3): THREE.Vector3 {
    shoulderFrame(this.effectiveYaw() + yawOffset, clampPitch(this.effectivePitch() + pitchOffset, this.preset), out, _tmpRight);
    return out;
  }

  /**
   * Where an angular offset from the view centre lands on screen, in CSS
   * pixels from the centre for a viewport of `viewportHeight`. Positive yaw
   * (turning left) moves left, positive pitch (looking down) moves down.
   */
  projectAngleOffset(yawOffset: number, pitchOffset: number, viewportHeight: number, out: { x: number; y: number }): { x: number; y: number } {
    const k = viewportHeight / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    out.x = -Math.tan(yawOffset) * k;
    out.y = Math.tan(pitchOffset) * k;
    return out;
  }

  /** Screen radius in CSS pixels of a cone half-angle, for spread reticles. */
  projectAngleRadius(angle: number, viewportHeight: number): number {
    return (Math.tan(angle) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * (viewportHeight / 2);
  }

  /** Effective yaw this frame: look plus recoil. */
  effectiveYaw(): number {
    return this.yaw + this.recoilYaw;
  }

  /** Effective pitch this frame: look plus recoil, clamped. */
  effectivePitch(): number {
    return clampPitch(this.pitch + this.recoilPitch, this.preset);
  }

  /** Jump straight to the resolved pose (no aim damping this frame). */
  snap(occluder?: CameraOccluder): void {
    this.aimBlend = this.aiming ? 1 : 0;
    this.resolve(occluder);
  }

  update(dt: number, occluder?: CameraOccluder): void {
    this.aimBlend = damp(this.aimBlend, this.aiming ? 1 : 0, this.preset.aimRate, dt);
    this.resolve(occluder);
  }

  private resolve(occluder: CameraOccluder | undefined): void {
    const p = this.preset;
    const b = this.aimBlend;
    const distance = THREE.MathUtils.lerp(p.distance, p.aimDistance, b);
    const side = THREE.MathUtils.lerp(p.sideOffset, p.aimSideOffset, b);
    const fov = THREE.MathUtils.lerp(p.fov, p.aimFov, b);

    const yaw = this.effectiveYaw();
    const pitch = this.effectivePitch();
    shoulderFrame(yaw, pitch, this.forward, this.right);
    this.pivot.copy(this.target);
    this.pivot.y += this.height * p.shoulderRatio;
    this.pivot.addScaledVector(this.right, side);

    // Pull in against geometry between the pivot and the desired camera spot.
    this.toCamera.copy(this.forward).negate();
    let reach = distance;
    if (occluder) {
      const hit = occluder(this.pivot, this.toCamera, distance + p.collisionRadius);
      if (hit !== null) reach = Math.max(0.05, hit - p.collisionRadius);
    }
    this.desired.copy(this.pivot).addScaledVector(this.toCamera, reach);

    this.camera.position.copy(this.desired);
    this.camera.rotation.set(-pitch, yaw, 0, 'YXZ');
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
