import * as THREE from 'three/webgpu';

/**
 * "How lit is this point": a CPU estimate of the illuminance the scene's
 * local lights deliver to a position, for gameplay (ADR-005 asks for it so
 * darkness can matter to enemy perception) and for HUD light meters. It
 * mirrors three's physical point and spot falloff, so a number here tracks
 * what the renderer draws, minus shadows; an optional occluder callback
 * (normally a physics raycast) adds shadowing for the strongest few lights.
 */
export interface IlluminanceLight {
  readonly position: THREE.Vector3;
  readonly intensity: number;
  /** Cutoff distance, 0 for none (three's `distance`). */
  readonly distance: number;
  readonly decay: number;
  /** Spot cone; absent for point lights. */
  readonly spot?: { readonly direction: THREE.Vector3; readonly angle: number; readonly penumbra: number } | undefined;
}

export interface IlluminanceOptions {
  /** A constant floor from sky, moon and bounce, in the same units. Default 0. */
  readonly ambient?: number | undefined;
  /** Returns true when the way from the light to the point is blocked. Applied to the `maxOccluded` strongest contributors. */
  readonly occluder?: ((from: THREE.Vector3, to: THREE.Vector3) => boolean) | undefined;
  /** How many lights get the (costly) occlusion test. Default 3. */
  readonly maxOccluded?: number | undefined;
}

/** three's `getDistanceAttenuation`: inverse-power falloff with a smooth window to the cutoff. */
export function distanceFalloff(distance: number, cutoff: number, decay: number): number {
  let falloff = 1 / Math.max(Math.pow(distance, decay), 0.01);
  if (cutoff > 0) {
    const r = Math.min(1, Math.max(0, 1 - Math.pow(distance / cutoff, 4)));
    falloff *= r * r;
  }
  return falloff;
}

/** three's `getSpotAttenuation`: 1 inside the inner cone, 0 outside the outer, smooth between. */
export function spotFactor(cosToPoint: number, angle: number, penumbra: number): number {
  const outer = Math.cos(angle);
  const inner = Math.cos(angle * (1 - penumbra));
  if (cosToPoint <= outer) return 0;
  if (cosToPoint >= inner) return 1;
  const t = (cosToPoint - outer) / Math.max(inner - outer, 1e-6);
  return t * t * (3 - 2 * t);
}

const _toPoint = new THREE.Vector3();
const _contrib: { value: number; light: IlluminanceLight }[] = [];

/** Sum of every light's contribution at `point`, in three's light units. */
export function illuminanceAt(lights: readonly IlluminanceLight[], point: THREE.Vector3, options: IlluminanceOptions = {}): number {
  _contrib.length = 0;
  for (const light of lights) {
    if (light.intensity <= 0) continue;
    _toPoint.copy(point).sub(light.position);
    const d = _toPoint.length();
    if (light.distance > 0 && d >= light.distance) continue;
    let value = light.intensity * distanceFalloff(d, light.distance, light.decay);
    if (light.spot) {
      const cosine = d > 1e-6 ? _toPoint.dot(light.spot.direction) / d : 1;
      value *= spotFactor(cosine, light.spot.angle, light.spot.penumbra);
    }
    if (value > 1e-5) _contrib.push({ value, light });
  }
  let total = options.ambient ?? 0;
  if (options.occluder && _contrib.length > 0) {
    _contrib.sort((a, b) => b.value - a.value);
    const tested = Math.min(_contrib.length, options.maxOccluded ?? 3);
    for (let i = 0; i < _contrib.length; i++) {
      const c = _contrib[i] as { value: number; light: IlluminanceLight };
      if (i < tested && options.occluder(c.light.position, point)) continue;
      total += c.value;
    }
  } else {
    for (const c of _contrib) total += c.value;
  }
  return total;
}

/** Map illuminance to a 0..1 "how visible am I" meter; `reference` is the illuminance that reads as 63 percent lit. */
export function litness(illuminance: number, reference = 2): number {
  if (illuminance <= 0) return 0;
  return 1 - Math.exp(-illuminance / Math.max(reference, 1e-6));
}

const _pos = new THREE.Vector3();
const _target = new THREE.Vector3();

/** Read a three point or spot light into a record; null for other light types (directional and hemisphere go through `ambient`). */
export function lightRecord(light: THREE.Light, out: { position: THREE.Vector3; direction: THREE.Vector3 }): IlluminanceLight | null {
  const point = light as THREE.PointLight;
  if (point.isPointLight) {
    light.getWorldPosition(out.position);
    return { position: out.position, intensity: point.intensity, distance: point.distance, decay: point.decay };
  }
  const spot = light as THREE.SpotLight;
  if (spot.isSpotLight) {
    light.getWorldPosition(out.position);
    spot.target.getWorldPosition(_target);
    out.direction.copy(_target).sub(out.position).normalize();
    return {
      position: out.position,
      intensity: spot.intensity,
      distance: spot.distance,
      decay: spot.decay,
      spot: { direction: out.direction, angle: spot.angle, penumbra: spot.penumbra },
    };
  }
  void _pos;
  return null;
}
