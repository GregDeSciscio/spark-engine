import type { Random } from '@spark/engine';
import { recoilImpulse, spreadDegrees, type ShooterState, type WeaponDefinition } from './weapons';

/**
 * One held weapon's state: magazine, cadence, reload, bloom and the recoil
 * offset the camera carries. Input intent is set per frame (`trigger`,
 * `triggerEdge`, `reloadRequested`); everything that changes state runs in
 * `fixedUpdate` so it is deterministic under the fixed step. Shots are
 * returned to the caller, which owns the ray and the effects.
 */
export interface Shot {
  /** Cone half-angle this shot was fired with, degrees. */
  readonly spreadDeg: number;
}

export class Weapon {
  readonly def: WeaponDefinition;
  ammo: number;
  reserve: number;
  /** Held this frame (auto fire). */
  trigger = false;
  /** Pressed this frame (semi fire). */
  triggerEdge = false;
  reloadRequested = false;

  private cooldown = 0;
  private reloadTimer = -1;
  private bloomDeg = 0;
  private shotIndex = 0;
  private sinceLastShot = 10;
  private recoilPitchDeg = 0;
  private recoilYawDeg = 0;
  private readonly shots: Shot[] = [];

  constructor(def: WeaponDefinition) {
    this.def = def;
    this.ammo = def.magazineSize;
    this.reserve = def.reserveAmmo;
  }

  get reloading(): boolean {
    return this.reloadTimer >= 0;
  }

  /** 0..1 progress of the current reload, or 0. */
  get reloadProgress(): number {
    return this.reloadTimer < 0 ? 0 : 1 - this.reloadTimer / this.def.reloadTime;
  }

  get bloom(): number {
    return this.bloomDeg;
  }

  /** Current camera recoil offset, degrees. Pitch is upward. */
  get recoilPitch(): number {
    return this.recoilPitchDeg;
  }

  get recoilYaw(): number {
    return this.recoilYawDeg;
  }

  /** The spread a shot would have right now, for the crosshair. */
  spreadNow(state: ShooterState): number {
    return spreadDegrees(this.def, state, this.bloomDeg);
  }

  fixedUpdate(dt: number, state: ShooterState, random: Random): readonly Shot[] {
    this.shots.length = 0;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.sinceLastShot += dt;

    // Bloom recovers whenever the gun is quiet; recoil returns after a short delay.
    this.bloomDeg = Math.max(0, this.bloomDeg - this.def.accuracy.bloomRecoveryDegPerSecond * dt);
    if (this.sinceLastShot > this.def.recoil.recoveryDelay) {
      this.recoilPitchDeg *= Math.exp(-this.def.recoil.returnSpeed * dt);
      this.recoilYawDeg *= Math.exp(-this.def.recoil.yawReturnSpeed * dt);
      if (Math.abs(this.recoilPitchDeg) < 1e-3) this.recoilPitchDeg = 0;
      if (Math.abs(this.recoilYawDeg) < 1e-3) this.recoilYawDeg = 0;
    }
    if (this.sinceLastShot > 0.4) this.shotIndex = 0;

    if (this.reloadTimer >= 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer < 0) {
        const want = this.def.magazineSize - this.ammo;
        const take = Math.min(want, this.reserve);
        this.ammo += take;
        this.reserve -= take;
        this.reloadTimer = -1;
      }
      this.clearIntent();
      return this.shots;
    }

    const wantsReload = this.reloadRequested || (this.ammo === 0 && (this.trigger || this.triggerEdge));
    if (wantsReload && this.ammo < this.def.magazineSize && this.reserve > 0) {
      this.reloadTimer = this.def.reloadTime;
      this.clearIntent();
      return this.shots;
    }

    const wantsFire = this.def.fireMode === 'auto' ? this.trigger || this.triggerEdge : this.triggerEdge;
    if (wantsFire && this.ammo > 0 && this.cooldown === 0) {
      this.ammo -= 1;
      this.cooldown = 60 / this.def.rpm;
      this.sinceLastShot = 0;
      const spreadDeg = spreadDegrees(this.def, state, this.bloomDeg);
      const kick = recoilImpulse(this.def, this.shotIndex, this.bloomDeg, random);
      this.shotIndex += 1;
      this.bloomDeg = Math.min(this.def.accuracy.maxBloomDeg, this.bloomDeg + this.def.accuracy.bloomPerShotDeg);
      this.recoilPitchDeg = Math.min(this.def.recoil.pitchClampDeg, this.recoilPitchDeg + kick.pitchDeg);
      this.recoilYawDeg = Math.max(-this.def.recoil.yawClampDeg, Math.min(this.def.recoil.yawClampDeg, this.recoilYawDeg + kick.yawDeg));
      this.shots.push({ spreadDeg });
    }
    this.clearIntent();
    return this.shots;
  }

  private clearIntent(): void {
    this.triggerEdge = false;
    this.reloadRequested = false;
  }
}
