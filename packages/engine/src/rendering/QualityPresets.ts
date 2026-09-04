import type { QualityPreset } from '../core/Config';

/**
 * Concrete renderer settings per quality tier. Every knob the render pipeline
 * reads lives here so a preset is one object, not scattered conditionals.
 *
 * Milestone 0/1 consumes shadows, MSAA and render scale. The post-processing
 * fields are read by the RenderPipeline from Milestone 2 on; they are declared
 * now so presets are complete from day one.
 */
export interface QualitySettings {
  readonly preset: QualityPreset;
  /** Internal render scale relative to the swap chain. */
  readonly renderScale: number;
  readonly shadows: boolean;
  readonly shadowMapSize: number;
  readonly shadowCascades: number;
  /** MSAA sample count on the scene pass (0 = off). */
  readonly msaaSamples: number;
  readonly anisotropy: number;
  readonly bloom: boolean;
  readonly ambientOcclusion: 'off' | 'ssao' | 'gtao';
  readonly aoResolutionScale: number;
  readonly temporalAA: boolean;
  readonly screenSpaceReflections: boolean;
  readonly motionBlur: boolean;
  readonly depthOfField: boolean;
  readonly volumetrics: boolean;
  /** Post-tonemap FXAA. The compat-tier anti-aliasing; off where TRAA runs. */
  readonly fxaa: boolean;
  /** How a sub-1.0 render scale is resolved to the swap chain. */
  readonly upscaler: 'fsr1' | 'bilinear';
  /** Bloom shape. Threshold is in linear HDR units: 1.0 = only over-bright pixels bloom. */
  readonly bloomStrength: number;
  readonly bloomRadius: number;
  readonly bloomThreshold: number;
  /** Dynamic resolution: move `renderScale` between the floor and 1.0 to hold the frame budget. */
  readonly dynamicResolution: boolean;
  readonly dynamicResolutionFloor: number;
  readonly particleDensity: number;
  readonly lodBias: number;
  readonly drawDistance: number;
  readonly maxDynamicLights: number;
}

const base: Omit<QualitySettings, 'preset'> = {
  renderScale: 1,
  shadows: true,
  shadowMapSize: 2048,
  shadowCascades: 2,
  msaaSamples: 4,
  anisotropy: 8,
  bloom: true,
  ambientOcclusion: 'gtao',
  aoResolutionScale: 0.5,
  temporalAA: true,
  screenSpaceReflections: true,
  motionBlur: false,
  depthOfField: false,
  volumetrics: false,
  fxaa: false,
  upscaler: 'fsr1',
  bloomStrength: 0.55,
  bloomRadius: 0.35,
  bloomThreshold: 1.0,
  dynamicResolution: true,
  dynamicResolutionFloor: 0.6,
  particleDensity: 1,
  lodBias: 1,
  drawDistance: 1,
  maxDynamicLights: 64,
};

export const QUALITY_SETTINGS: Record<QualityPreset, QualitySettings> = {
  low: {
    ...base,
    preset: 'low',
    renderScale: 0.75,
    shadowMapSize: 1024,
    shadowCascades: 1,
    msaaSamples: 0,
    anisotropy: 2,
    bloom: false,
    ambientOcclusion: 'off',
    temporalAA: false,
    screenSpaceReflections: false,
    fxaa: true,
    upscaler: 'bilinear',
    particleDensity: 0.4,
    lodBias: 0.6,
    drawDistance: 0.6,
    maxDynamicLights: 8,
  },
  medium: {
    ...base,
    preset: 'medium',
    renderScale: 1,
    shadowMapSize: 1024,
    shadowCascades: 1,
    msaaSamples: 0,
    anisotropy: 4,
    ambientOcclusion: 'ssao',
    temporalAA: false,
    screenSpaceReflections: false,
    fxaa: true,
    particleDensity: 0.7,
    lodBias: 0.8,
    drawDistance: 0.8,
    maxDynamicLights: 16,
  },
  high: {
    ...base,
    preset: 'high',
  },
  ultra: {
    ...base,
    preset: 'ultra',
    shadowMapSize: 4096,
    shadowCascades: 3,
    anisotropy: 16,
    aoResolutionScale: 1,
    motionBlur: true,
    volumetrics: true,
    particleDensity: 1.5,
    lodBias: 1.5,
    drawDistance: 1.5,
    maxDynamicLights: 128,
  },
  cinematic: {
    ...base,
    preset: 'cinematic',
    shadowMapSize: 4096,
    shadowCascades: 4,
    msaaSamples: 8,
    anisotropy: 16,
    aoResolutionScale: 1,
    motionBlur: true,
    depthOfField: true,
    volumetrics: true,
    dynamicResolution: false,
    particleDensity: 2,
    lodBias: 2,
    drawDistance: 2,
    maxDynamicLights: 256,
  },
};

export function getQualitySettings(preset: QualityPreset): QualitySettings {
  return QUALITY_SETTINGS[preset];
}
