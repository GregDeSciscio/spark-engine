import * as THREE from 'three/webgpu';
import { dot, float, hash, length, max, mix, pow, screenUV, smoothstep, time, uniform, vec3, vec4 } from 'three/tsl';

/**
 * Colour grading for the post stack: exposure in HDR before tone mapping,
 * then in display space lift / gamma / gain, contrast, saturation, a
 * shadow-to-highlight split tone, a vignette and film grain. Every knob is a
 * uniform, so a grade can be tuned live; the graph never rebuilds for a
 * value change. `CYBERPUNK_GRADE` is the customer game's look: crushed teal
 * shadows, magenta highlights, a heavy vignette, a whisper of grain.
 */
export interface ColorGradeParams {
  /** HDR multiplier before tone mapping. */
  readonly exposure: number;
  /** Contrast about mid grey; 1 = none. */
  readonly contrast: number;
  /** 0 = greyscale, 1 = as rendered, >1 = boosted. */
  readonly saturation: number;
  /** Added to the blacks (per channel, small values). */
  readonly lift: THREE.ColorRepresentation;
  /** Mid-tone power per channel; 1 = none, <1 brightens. */
  readonly gamma: THREE.ColorRepresentation;
  /** Multiplier on the whites per channel. */
  readonly gain: THREE.ColorRepresentation;
  /** Multiplier applied in the shadows, blended to `highlightTint` by luminance. White = none. */
  readonly shadowTint: THREE.ColorRepresentation;
  readonly highlightTint: THREE.ColorRepresentation;
  /** 0..1 darkening at the corners. */
  readonly vignette: number;
  /** 0..1 where the vignette starts (fraction of the half-diagonal). */
  readonly vignetteStart: number;
  /** 0..1 grain amplitude. */
  readonly grain: number;
}

export const NEUTRAL_GRADE: ColorGradeParams = {
  exposure: 1,
  contrast: 1,
  saturation: 1,
  lift: 0x000000,
  gamma: 0xffffff,
  gain: 0xffffff,
  shadowTint: 0xffffff,
  highlightTint: 0xffffff,
  vignette: 0,
  vignetteStart: 0.5,
  grain: 0,
};

/** The Task Unit sequel's look (ADR-005): dark, wet, neon. */
export const CYBERPUNK_GRADE: ColorGradeParams = {
  exposure: 1.06,
  contrast: 1.14,
  saturation: 1.12,
  lift: new THREE.Color(0.012, 0.004, 0.03),
  gamma: new THREE.Color(1.0, 1.0, 1.0),
  gain: new THREE.Color(1.02, 0.98, 1.06),
  shadowTint: new THREE.Color(0.82, 0.95, 1.18),
  highlightTint: new THREE.Color(1.14, 0.97, 1.1),
  vignette: 0.48,
  vignetteStart: 0.45,
  grain: 0.035,
};

export class ColorGradeSettings {
  readonly exposure = uniform(1);
  readonly contrast = uniform(1);
  readonly saturation = uniform(1);
  readonly lift = uniform(new THREE.Color(0, 0, 0));
  readonly gamma = uniform(new THREE.Color(1, 1, 1));
  readonly gain = uniform(new THREE.Color(1, 1, 1));
  readonly shadowTint = uniform(new THREE.Color(1, 1, 1));
  readonly highlightTint = uniform(new THREE.Color(1, 1, 1));
  readonly vignette = uniform(0);
  readonly vignetteStart = uniform(0.5);
  readonly grain = uniform(0);

  constructor(params: Partial<ColorGradeParams> = {}) {
    this.set({ ...NEUTRAL_GRADE, ...params });
  }

  set(params: Partial<ColorGradeParams>): void {
    if (params.exposure !== undefined) this.exposure.value = params.exposure;
    if (params.contrast !== undefined) this.contrast.value = params.contrast;
    if (params.saturation !== undefined) this.saturation.value = params.saturation;
    if (params.lift !== undefined) this.lift.value.set(params.lift);
    if (params.gamma !== undefined) this.gamma.value.set(params.gamma);
    if (params.gain !== undefined) this.gain.value.set(params.gain);
    if (params.shadowTint !== undefined) this.shadowTint.value.set(params.shadowTint);
    if (params.highlightTint !== undefined) this.highlightTint.value.set(params.highlightTint);
    if (params.vignette !== undefined) this.vignette.value = Math.max(0, Math.min(1, params.vignette));
    if (params.vignetteStart !== undefined) this.vignetteStart.value = Math.max(0, Math.min(1, params.vignetteStart));
    if (params.grain !== undefined) this.grain.value = Math.max(0, params.grain);
  }
}

const LUMA = vec3(0.2126, 0.7152, 0.0722);

/** HDR stage, before tone mapping: exposure. */
export function colorGradeHDR(input: THREE.Node<'vec4'>, s: ColorGradeSettings): THREE.Node<'vec4'> {
  return vec4(input.rgb.mul(s.exposure), input.a) as unknown as THREE.Node<'vec4'>;
}

/** Display stage, after tone mapping and output encoding: the grade proper. */
export function colorGradeLDR(input: THREE.Node<'vec4'>, s: ColorGradeSettings): THREE.Node<'vec4'> {
  type V3 = THREE.Node<'vec3'>;
  let c = input.rgb as unknown as V3;
  // Lift / gamma / gain.
  const gain = s.gain as unknown as V3;
  const lift = s.lift as unknown as V3;
  const gamma = max(s.gamma as unknown as V3, vec3(0.05)) as unknown as V3;
  c = c.mul(gain).add(lift.mul(c.oneMinus())) as unknown as V3;
  c = pow(max(c, vec3(0.0)) as unknown as V3, vec3(1.0).div(gamma)) as unknown as V3;
  // Contrast about mid grey, then saturation about luminance.
  c = c.sub(0.5).mul(s.contrast).add(0.5) as unknown as V3;
  const luma = dot(c, LUMA);
  c = mix(vec3(luma), c, s.saturation) as unknown as V3;
  // Split tone: shadows take one tint, highlights the other.
  const shadow = s.shadowTint as unknown as V3;
  const highlight = s.highlightTint as unknown as V3;
  c = c.mul(mix(shadow, highlight, smoothstep(0.0, 1.0, luma))) as unknown as V3;
  // Vignette from the centre; grain as per-pixel, per-frame hash noise.
  const radial = length(screenUV.sub(0.5).mul(2.0)).mul(0.7071);
  const vignette = float(1.0).sub(s.vignette.mul(smoothstep(s.vignetteStart, float(1.15), radial)));
  const noise = hash(screenUV.x.mul(1920.0).add(screenUV.y.mul(1080.0 * 7919.0)).add(time.mul(60.0)));
  c = c.mul(vignette).add(noise.sub(0.5).mul(s.grain)) as unknown as V3;
  return vec4(c.clamp(0.0, 1.0), input.a) as unknown as THREE.Node<'vec4'>;
}
