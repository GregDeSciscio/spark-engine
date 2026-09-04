/**
 * Distance attenuation matching the WebAudio PannerNode formulas, so the
 * engine can predict (and test) what a spatial voice will sound like, cull
 * voices that are inaudible before they take a slot, and drive non-panner
 * fallbacks with the same curve.
 */
export type DistanceModel = 'inverse' | 'linear' | 'exponential';

export interface SpatialOptions {
  /** Default `inverse`. */
  readonly distanceModel?: DistanceModel | undefined;
  /** Distance at which the sound is at full volume. Default 1. */
  readonly refDistance?: number | undefined;
  /** How quickly volume falls off past `refDistance`. Default 1. */
  readonly rolloff?: number | undefined;
  /** Beyond this the volume stops decreasing (and `inaudibleBeyond` may cull). Default 40. */
  readonly maxDistance?: number | undefined;
  /** Use HRTF (higher quality, more CPU) instead of equal-power panning. Default false. */
  readonly hrtf?: boolean | undefined;
}

export interface ResolvedSpatial {
  readonly distanceModel: DistanceModel;
  readonly refDistance: number;
  readonly rolloff: number;
  readonly maxDistance: number;
  readonly hrtf: boolean;
}

export const DEFAULT_SPATIAL: ResolvedSpatial = {
  distanceModel: 'inverse',
  refDistance: 1,
  rolloff: 1,
  maxDistance: 40,
  hrtf: false,
};

export function resolveSpatial(options: SpatialOptions | undefined): ResolvedSpatial {
  if (!options) return DEFAULT_SPATIAL;
  const refDistance = options.refDistance ?? DEFAULT_SPATIAL.refDistance;
  const rolloff = options.rolloff ?? DEFAULT_SPATIAL.rolloff;
  const maxDistance = options.maxDistance ?? DEFAULT_SPATIAL.maxDistance;
  if (!(refDistance > 0)) throw new Error('spatial: refDistance must be > 0');
  if (!(rolloff >= 0)) throw new Error('spatial: rolloff must be >= 0');
  if (!(maxDistance > refDistance)) throw new Error('spatial: maxDistance must exceed refDistance');
  return {
    distanceModel: options.distanceModel ?? DEFAULT_SPATIAL.distanceModel,
    refDistance,
    rolloff,
    maxDistance,
    hrtf: options.hrtf ?? false,
  };
}

/**
 * Gain in [0, 1] for a source `distance` away. Mirrors the Web Audio spec:
 * inverse:     ref / (ref + rolloff · (max(d, ref) − ref))
 * linear:      1 − rolloff · (clamp(d, ref, max) − ref) / (max − ref)
 * exponential: (max(d, ref) / ref) ^ −rolloff
 */
export function attenuation(distance: number, s: ResolvedSpatial = DEFAULT_SPATIAL): number {
  const d = Math.max(distance, s.refDistance);
  switch (s.distanceModel) {
    case 'linear': {
      const clamped = Math.min(d, s.maxDistance);
      return Math.max(0, 1 - (s.rolloff * (clamped - s.refDistance)) / (s.maxDistance - s.refDistance));
    }
    case 'exponential':
      return Math.pow(d / s.refDistance, -s.rolloff);
    case 'inverse':
    default:
      return s.refDistance / (s.refDistance + s.rolloff * (d - s.refDistance));
  }
}

/** True when a source at `distance` would be quieter than `threshold` (default −60 dB). */
export function inaudible(distance: number, s: ResolvedSpatial = DEFAULT_SPATIAL, threshold = 0.001): boolean {
  if (s.distanceModel === 'linear') return distance >= s.maxDistance;
  return attenuation(distance, s) < threshold;
}
