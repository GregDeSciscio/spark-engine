import * as THREE from 'three/webgpu';
import { exp, float, fog, max, positionView, positionWorld, uniform, vec3 } from 'three/tsl';

/**
 * Atmospheric fog with a height term (kickoff §8 phase 2, "improved
 * atmospheric fog"). Exponential-squared distance fog whose density grows
 * toward the ground, so an alley floor sits in haze while the rooftops stay
 * clear. Installed as `scene.fogNode`, so every material (and fogged
 * particle sprite) picks it up through three's node fog path.
 *
 * The density model is one closed-form expression with a pure TypeScript
 * mirror (`heightFogDensity` / `heightFogFactor`) so it can be unit-tested:
 *
 *   densityAt(y) = density * (1 + groundBoost * exp(-max(y - groundY, 0) / falloff))
 *   factor(d, y) = 1 - exp(-(d * densityAt(y))^2)
 *
 * It is evaluated at the shaded fragment (no integration along the ray),
 * which is the standard cheap approximation and is exact for a flat floor.
 */
export interface HeightFogParams {
  /** Fog colour in linear space. */
  readonly color: THREE.ColorRepresentation;
  /** Base density (FogExp2 units, 1/world units). */
  readonly density: number;
  /** World Y below which the ground boost is fully applied. */
  readonly groundY: number;
  /** Height above `groundY` over which the boost decays by 1/e. */
  readonly falloff: number;
  /** Extra density at ground level as a fraction of `density` (0 = plain exp2 fog). */
  readonly groundBoost: number;
}

export const DEFAULT_HEIGHT_FOG: HeightFogParams = {
  color: 0x0a0e1a,
  density: 0.02,
  groundY: 0,
  falloff: 3,
  groundBoost: 1,
};

/** Effective density at world height `y`. Pure. */
export function heightFogDensity(y: number, params: HeightFogParams): number {
  const above = Math.max(y - params.groundY, 0);
  const falloff = Math.max(params.falloff, 1e-6);
  return params.density * (1 + params.groundBoost * Math.exp(-above / falloff));
}

/** Fog blend factor in [0, 1) for a fragment `distance` away at world height `y`. Pure. */
export function heightFogFactor(distance: number, y: number, params: HeightFogParams): number {
  const d = Math.max(distance, 0) * heightFogDensity(y, params);
  return 1 - Math.exp(-d * d);
}

export interface HeightFog {
  /** Assign to `scene.fogNode`. */
  readonly node: THREE.Node;
  /** Live uniforms: change them without rebuilding any material. */
  readonly color: THREE.UniformNode<'vec3', THREE.Vector3>;
  readonly density: THREE.UniformNode<'float', number>;
  readonly groundY: THREE.UniformNode<'float', number>;
  readonly falloff: THREE.UniformNode<'float', number>;
  readonly groundBoost: THREE.UniformNode<'float', number>;
  set(params: Partial<HeightFogParams>): void;
}

/** Build the TSL fog node. Call once per scene and assign `result.node` to `scene.fogNode`. */
export function createHeightFog(params: Partial<HeightFogParams> = {}): HeightFog {
  const p: HeightFogParams = { ...DEFAULT_HEIGHT_FOG, ...params };
  const tint = new THREE.Color(p.color);
  const color = uniform(new THREE.Vector3(tint.r, tint.g, tint.b));
  const density = uniform(p.density);
  const groundY = uniform(p.groundY);
  const falloff = uniform(p.falloff);
  const groundBoost = uniform(p.groundBoost);

  const viewZ = positionView.z.negate();
  const above = max(positionWorld.y.sub(groundY), 0);
  const boost = exp(above.div(max(falloff, 1e-6)).negate()).mul(groundBoost).add(1);
  const d = viewZ.mul(density.mul(boost));
  const factor = exp(d.mul(d).negate()).oneMinus();
  const node = fog(vec3(color), float(factor));

  return {
    node,
    color,
    density,
    groundY,
    falloff,
    groundBoost,
    set(next): void {
      if (next.color !== undefined) {
        tint.set(next.color);
        color.value.set(tint.r, tint.g, tint.b);
      }
      if (next.density !== undefined) density.value = next.density;
      if (next.groundY !== undefined) groundY.value = next.groundY;
      if (next.falloff !== undefined) falloff.value = next.falloff;
      if (next.groundBoost !== undefined) groundBoost.value = next.groundBoost;
    },
  };
}
