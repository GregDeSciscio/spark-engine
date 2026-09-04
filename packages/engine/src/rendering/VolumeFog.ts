import * as THREE from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  dot,
  exp,
  float,
  getViewPosition,
  int,
  interleavedGradientNoise,
  length,
  max,
  min,
  mix,
  mx_noise_float,
  passTexture,
  reference,
  screenCoordinate,
  smoothstep,
  time,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';

/**
 * Raymarched fog volume (kickoff §8 phase 3 "volumetric fog / lighting",
 * WebGPU only). One axis-aligned box of participating medium with a
 * height-weighted, noise-modulated density, lit by an ambient colour and
 * optionally one spot cone (the hero light). It is a post stage: the pass
 * reads scene depth, marches the view ray through the box up to the first
 * surface, and writes `(in-scattered light, transmittance)` at
 * `resolutionScale` of the swap chain. The pipeline composites it as
 * `scene * transmittance + inscatter`.
 *
 * Numbers are in world units. The scene owns a `VolumeFogSettings` (a set of
 * uniforms) and hands it to `RenderPipeline.setVolumeFog()`; animating the
 * spot or the density writes uniforms, never rebuilds the graph.
 *
 * The ray/box slab test has a pure mirror (`intersectRayBox`) for unit tests.
 */
export interface VolumeFogSpot {
  readonly position: THREE.Vector3;
  /** Direction the cone points along (normalised by the setter). */
  readonly direction: THREE.Vector3;
  /** Outer half-angle in radians. */
  readonly angle: number;
  /** 0..1, fraction of the cone that fades out toward the edge. */
  readonly penumbra: number;
  readonly color: THREE.ColorRepresentation;
  /** In-scatter intensity at the source; falls off with distance and the cone. */
  readonly intensity: number;
  /** Distance at which the spot contribution reaches zero. */
  readonly range: number;
}

export interface VolumeFogParams {
  readonly bounds: { readonly min: THREE.Vector3; readonly max: THREE.Vector3 };
  /** Extinction per world unit at full density. */
  readonly density: number;
  /** Ambient in-scatter colour (the "fog colour" you see without any light). */
  readonly color: THREE.ColorRepresentation;
  /** Ambient in-scatter intensity. */
  readonly ambient: number;
  /** Height above `bounds.min.y` over which density drops by 1/e. */
  readonly heightFalloff: number;
  /** Spatial frequency of the density noise (1/world units). */
  readonly noiseScale: number;
  /** Drift of the noise field, world units per second. */
  readonly noiseDrift: THREE.Vector3;
  /** 0 = uniform density, 1 = fully noise-driven wisps. */
  readonly noiseStrength: number;
  /** Henyey-Greenstein anisotropy for the spot, 0 isotropic, 0.3-0.6 forward scattering. */
  readonly anisotropy: number;
  readonly spot: VolumeFogSpot | null;
}

export const DEFAULT_VOLUME_FOG: VolumeFogParams = {
  bounds: { min: new THREE.Vector3(-10, 0, -10), max: new THREE.Vector3(10, 8, 10) },
  density: 0.08,
  color: 0x30405c,
  ambient: 0.06,
  heightFalloff: 4,
  noiseScale: 0.25,
  noiseDrift: new THREE.Vector3(0.3, 0.1, 0.05),
  noiseStrength: 0.6,
  anisotropy: 0.4,
  spot: null,
};

/**
 * Slab test. Returns the parametric entry/exit of `origin + t * direction`
 * through the box, clipped to `[0, maxT]`; `enter >= exit` means no overlap.
 * Pure mirror of the shader's test.
 */
export function intersectRayBox(
  origin: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
  min: { x: number; y: number; z: number },
  max: { x: number; y: number; z: number },
  maxT = Number.POSITIVE_INFINITY,
): { enter: number; exit: number } {
  let enter = 0;
  let exit = maxT;
  const axes = ['x', 'y', 'z'] as const;
  for (const axis of axes) {
    const d = direction[axis];
    const o = origin[axis];
    if (Math.abs(d) < 1e-8) {
      if (o < min[axis] || o > max[axis]) return { enter: 0, exit: 0 };
      continue;
    }
    const inv = 1 / d;
    let t0 = (min[axis] - o) * inv;
    let t1 = (max[axis] - o) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    enter = Math.max(enter, t0);
    exit = Math.min(exit, t1);
  }
  return { enter, exit };
}

/** Uniforms that drive the volume; the scene keeps this and writes it per frame if it animates. */
export class VolumeFogSettings {
  readonly boundsMin = uniform(new THREE.Vector3());
  readonly boundsMax = uniform(new THREE.Vector3());
  readonly density = uniform(0);
  readonly color = uniform(new THREE.Color());
  readonly ambient = uniform(0);
  readonly heightFalloff = uniform(1);
  readonly noiseScale = uniform(1);
  readonly noiseDrift = uniform(new THREE.Vector3());
  readonly noiseStrength = uniform(0);
  readonly anisotropy = uniform(0);
  readonly spotPosition = uniform(new THREE.Vector3());
  readonly spotDirection = uniform(new THREE.Vector3(0, -1, 0));
  /** (cos outer, cos inner) */
  readonly spotCone = uniform(new THREE.Vector2(0, 1));
  readonly spotColor = uniform(new THREE.Color());
  readonly spotIntensity = uniform(0);
  readonly spotRange = uniform(1);
  /** Whether the spot term is compiled in. Fixed at construction (a shader variant). */
  readonly hasSpot: boolean;

  constructor(params: Partial<VolumeFogParams> = {}) {
    const p = { ...DEFAULT_VOLUME_FOG, ...params };
    this.hasSpot = p.spot !== null;
    this.set(p);
  }

  set(params: Partial<VolumeFogParams>): void {
    if (params.bounds) {
      this.boundsMin.value.copy(params.bounds.min);
      this.boundsMax.value.copy(params.bounds.max);
    }
    if (params.density !== undefined) this.density.value = params.density;
    if (params.color !== undefined) this.color.value.set(params.color);
    if (params.ambient !== undefined) this.ambient.value = params.ambient;
    if (params.heightFalloff !== undefined) this.heightFalloff.value = Math.max(1e-3, params.heightFalloff);
    if (params.noiseScale !== undefined) this.noiseScale.value = params.noiseScale;
    if (params.noiseDrift !== undefined) this.noiseDrift.value.copy(params.noiseDrift);
    if (params.noiseStrength !== undefined) this.noiseStrength.value = params.noiseStrength;
    if (params.anisotropy !== undefined) this.anisotropy.value = params.anisotropy;
    if (params.spot) this.setSpot(params.spot);
  }

  setSpot(spot: Partial<VolumeFogSpot>): void {
    if (spot.position) this.spotPosition.value.copy(spot.position);
    if (spot.direction) this.spotDirection.value.copy(spot.direction).normalize();
    if (spot.angle !== undefined || spot.penumbra !== undefined) {
      const angle = spot.angle ?? Math.acos(this.spotCone.value.x);
      const penumbra = spot.penumbra ?? 1 - Math.acos(this.spotCone.value.y) / Math.max(angle, 1e-6);
      this.spotCone.value.set(Math.cos(angle), Math.cos(angle * (1 - Math.max(0, Math.min(1, penumbra)))));
    }
    if (spot.color !== undefined) this.spotColor.value.set(spot.color);
    if (spot.intensity !== undefined) this.spotIntensity.value = spot.intensity;
    if (spot.range !== undefined) this.spotRange.value = Math.max(1e-3, spot.range);
  }
}

const _quadMesh = new THREE.QuadMesh();
const _size = new THREE.Vector2();
let _rendererState: THREE.RendererUtils.RendererState | undefined;

/**
 * The pass. Construct with the scene depth texture node, the camera and the
 * settings; add its texture to the graph via `getTextureNode()`.
 */
export class VolumeFogNode extends THREE.TempNode {
  static get type(): string {
    return 'VolumeFogNode';
  }

  /** Target scale relative to the swap chain. */
  resolutionScale = 0.5;
  /** Ray-march steps through the box. */
  readonly steps = uniform(24, 'int');

  private readonly depthNode: THREE.TextureNode;
  private readonly camera: THREE.Camera;
  private readonly settings: VolumeFogSettings;
  private readonly renderTarget: THREE.RenderTarget;
  private readonly material: THREE.NodeMaterial;
  private readonly textureNode: THREE.TextureNode;
  private readonly cameraWorld: THREE.UniformNode<'mat4', THREE.Matrix4>;
  private readonly cameraProjectionInverse: THREE.UniformNode<'mat4', THREE.Matrix4>;
  private readonly cameraPosition = uniform(new THREE.Vector3());
  private readonly cameraNear: THREE.Node;
  private readonly cameraFar: THREE.Node;

  constructor(depthNode: THREE.TextureNode, camera: THREE.Camera, settings: VolumeFogSettings) {
    super('vec4');
    this.depthNode = depthNode;
    this.camera = camera;
    this.settings = settings;
    this.updateBeforeType = THREE.NodeUpdateType.FRAME;
    this.cameraWorld = uniform(camera.matrixWorld);
    this.cameraProjectionInverse = uniform(camera.projectionMatrixInverse);
    this.cameraNear = reference('near', 'float', camera);
    this.cameraFar = reference('far', 'float', camera);
    this.renderTarget = new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType });
    this.renderTarget.texture.name = 'VolumeFog';
    this.material = new THREE.NodeMaterial();
    this.material.name = 'VolumeFog';
    this.textureNode = passTexture(this as unknown as THREE.PassNode, this.renderTarget.texture);
  }

  getTextureNode(): THREE.TextureNode {
    return this.textureNode;
  }

  setSize(width: number, height: number): void {
    this.renderTarget.setSize(Math.max(1, Math.round(width * this.resolutionScale)), Math.max(1, Math.round(height * this.resolutionScale)));
  }

  override updateBefore(frame: THREE.NodeFrame): undefined {
    const renderer = frame.renderer;
    if (!renderer) return undefined;
    _rendererState = THREE.RendererUtils.resetRendererState(renderer, _rendererState as THREE.RendererUtils.RendererState);
    renderer.getDrawingBufferSize(_size);
    this.setSize(_size.x, _size.y);
    this.cameraPosition.value.setFromMatrixPosition(this.camera.matrixWorld);
    _quadMesh.material = this.material;
    _quadMesh.name = 'VolumeFog';
    renderer.setMRT(null);
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(this.renderTarget);
    _quadMesh.render(renderer);
    THREE.RendererUtils.restoreRendererState(renderer, _rendererState);
    return undefined;
  }

  override setup(builder: THREE.NodeBuilder): THREE.Node {
    const s = this.settings;
    const uvNode = uv();

    const march = Fn(() => {
      const depth = this.depthNode.sample(uvNode).r;
      const viewPosition = getViewPosition(uvNode, depth, this.cameraProjectionInverse);
      const worldPosition = this.cameraWorld.mul(vec4(viewPosition, 1.0)).xyz.toVar();
      const origin = this.cameraPosition;
      const toSurface = worldPosition.sub(origin).toVar();
      const sceneT = length(toSurface).toVar();
      const dir = toSurface.div(max(sceneT, 1e-4)).toVar();
      // Guard the slab division: a component that is exactly zero would give 0 * inf = NaN.
      const invDir = vec3(1.0).div(dir.add(vec3(1e-6)));
      const t0 = s.boundsMin.sub(origin).mul(invDir);
      const t1 = s.boundsMax.sub(origin).mul(invDir);
      const tmin = min(t0, t1);
      const tmax = max(t0, t1);
      const enter = max(max(tmin.x, tmin.y), max(tmin.z, 0.0)).toVar();
      const exit = min(min(tmax.x, tmax.y), min(tmax.z, sceneT)).toVar();

      const inscatter = vec3(0.0).toVar();
      const transmittance = float(1.0).toVar();

      If(exit.greaterThan(enter), () => {
        const stepsF = float(this.steps);
        const dt = exit.sub(enter).div(stepsF).toVar();
        const jitter = interleavedGradientNoise(screenCoordinate.xy);
        const drift = s.noiseDrift.mul(time);
        const cosOuter = s.spotCone.x;
        const cosInner = s.spotCone.y;
        const g = s.anisotropy;
        const g2 = g.mul(g);

        Loop({ start: int(0), end: this.steps, type: 'int', condition: '<' }, ({ i }) => {
          const t = enter.add(float(i).add(jitter).mul(dt));
          const p = origin.add(dir.mul(t)).toVar();
          const height = max(p.y.sub(s.boundsMin.y), 0.0);
          const heightWeight = exp(height.div(s.heightFalloff).negate());
          const noise = mx_noise_float(p.mul(s.noiseScale).add(drift)).mul(0.5).add(0.5);
          const wisps = mix(float(1.0), noise.mul(noise).mul(1.6), s.noiseStrength);
          const density = s.density.mul(heightWeight).mul(wisps).toVar();

          const light = s.color.mul(s.ambient).toVar();
          if (s.hasSpot) {
            const toP = p.sub(s.spotPosition);
            const d = length(toP).toVar();
            const l = toP.div(max(d, 1e-4));
            const cone = smoothstep(cosOuter, cosInner, dot(l, s.spotDirection));
            const falloff = smoothstep(s.spotRange, s.spotRange.mul(0.35), d).div(d.mul(d).mul(0.06).add(1.0));
            // Henyey-Greenstein toward the camera: light travels along l, scatters back along -dir.
            const cosTheta = dot(l, dir.negate());
            const phase = g2.oneMinus().div(g2.add(1.0).sub(g.mul(2.0).mul(cosTheta)).pow(1.5).mul(12.566));
            light.addAssign(s.spotColor.mul(s.spotIntensity).mul(cone).mul(falloff).mul(phase.mul(4.0).add(0.15)));
          }

          const extinction = density.mul(dt);
          const stepTransmittance = exp(extinction.negate());
          inscatter.addAssign(light.mul(transmittance).mul(stepTransmittance.oneMinus()));
          transmittance.mulAssign(stepTransmittance);
          If(transmittance.lessThan(0.01), () => {
            Break();
          });
        });
      });

      return vec4(inscatter, transmittance);
    });

    const shared = (builder as unknown as { getSharedContext(): Record<string, unknown> }).getSharedContext();
    this.material.fragmentNode = march().context(shared);
    this.material.needsUpdate = true;
    return this.textureNode;
  }

  override dispose(): void {
    this.renderTarget.dispose();
    this.material.dispose();
    super.dispose();
  }
}
