import type { Stance } from '../actors/Operator';

/**
 * The enemy awareness model from `docs/design/mission-shape.md`, as pure
 * numbers. Awareness is a 0..1 meter fed by sight and sound and drained by
 * time; the ladder is read off it. The enemy owns the state machine; this
 * file only says how fast the meter moves.
 */
export type AwarenessState = 'unaware' | 'suspicious' | 'alert' | 'searching';

export const AWARENESS = {
  /** Beyond this the player is never seen. */
  sightRange: 40,
  fovDeg: 120,
  /** Inside this the player is noticed regardless of facing. */
  closeRange: 3,
  /** Meter level that turns patrol into investigation. */
  suspiciousAt: 0.35,
  /** Meter drain per second while nothing is seen. */
  decayPerSecond: 0.12,
  /** Seconds without a sighting before an alert enemy starts searching. */
  loseAfter: 3.5,
  /** Seconds spent looking around at an investigated point. */
  investigateLook: 2.5,
  /** Seconds spent looking around at the last known position before giving up. */
  searchLook: 5,
  /** Fraction of a sound's loudness radius inside which it means alert, not suspicion. */
  loudAlertFraction: 0.35,
  /** Radius within which one enemy's alert warns the others. */
  warnRadius: 30,
  /** Sight gain multiplier for a target in full darkness (1 = light does not matter). */
  darkGain: 0.25,
  /** Illuminance from sky and moon everywhere, in the engine's light units. */
  nightAmbient: 0.35,
  /** Illuminance that reads as 63 percent lit on the visibility meter. */
  litReference: 2.0,
} as const;

export interface SightSample {
  /** Line of sight is clear. */
  readonly visible: boolean;
  readonly distance: number;
  /** Inside the view cone. */
  readonly inCone: boolean;
  readonly stance: Stance;
  /** Target horizontal speed. */
  readonly speed: number;
  /** 0..1 how lit the target is (engine illuminance through `litness`). */
  readonly lit: number;
}

/** Awareness gained per second from this sighting. Zero when the target cannot be seen. */
export function sightGain(s: SightSample): number {
  if (!s.visible) return 0;
  if (!s.inCone && s.distance > AWARENESS.closeRange) return 0;
  if (s.distance > AWARENESS.sightRange) return 0;
  // Slow at range, fast up close: a figure at 30 m takes seconds to register, one at 8 m under a second.
  const near = Math.min(1, Math.max(0, 1 - s.distance / AWARENESS.sightRange));
  let gain = 0.12 + 2.6 * near * near;
  if (s.stance === 'crouch') gain *= 0.7;
  else if (s.stance === 'prone') gain *= 0.45;
  if (s.speed > 0.5) gain *= 1 + Math.min(1, s.speed / 8) * 0.8;
  // Darkness is the stealth resource: a figure in shadow registers at a quarter of the rate of one under a neon.
  gain *= AWARENESS.darkGain + (1 - AWARENESS.darkGain) * Math.min(1, Math.max(0, s.lit));
  if (s.distance <= AWARENESS.closeRange) gain = Math.max(gain, 4);
  return gain;
}

/** The loudest state across a group, for the HUD. */
export function overallState(states: readonly AwarenessState[]): 'undetected' | 'suspicious' | 'alert' {
  let level: 'undetected' | 'suspicious' | 'alert' = 'undetected';
  for (const s of states) {
    if (s === 'alert') return 'alert';
    if (s === 'suspicious' || s === 'searching') level = 'suspicious';
  }
  return level;
}
