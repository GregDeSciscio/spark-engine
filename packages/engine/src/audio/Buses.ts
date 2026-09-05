/**
 * Bus names and gain math. Pure: no WebAudio here, so the arithmetic is unit
 * testable and the same numbers drive both the live graph and `stats()`.
 */
export const BUS_NAMES = ['music', 'sfx', 'ui', 'ambience'] as const;
export type BusName = (typeof BUS_NAMES)[number];

export function isBusName(value: string): value is BusName {
  return (BUS_NAMES as readonly string[]).includes(value);
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

/**
 * Perceptual volume → linear gain. A squared curve keeps the lower half of a
 * slider useful (linear gain sounds "all loud, then off"). Muted is exactly 0.
 */
export function busGain(volume: number, muted: boolean): number {
  if (muted) return 0;
  const v = clamp01(volume);
  return v * v;
}

/** The gain a voice actually plays at: master × bus × voice, each already linear. */
export function effectiveGain(master: number, bus: number, voice: number): number {
  return clamp01(master) * clamp01(bus) * Math.max(0, voice);
}

/** Bus state as reported by `stats()` and kept per bus by the system. */
export interface BusState {
  volume: number;
  muted: boolean;
  /** Voices currently allocated on this bus. */
  voices: number;
  /** Simultaneous-voice cap (steal-oldest when exceeded). */
  maxVoices: number;
}

/** Default per-bus voice caps: SFX is where stacking happens, music barely needs any. */
export const DEFAULT_MAX_VOICES: Readonly<Record<BusName, number>> = {
  music: 4,
  sfx: 24,
  ui: 8,
  // Two stereo beds, up to eight point emitters and a handful of one-shots (drips, thunder) at once: a wet street needs the room.
  ambience: 16,
};
