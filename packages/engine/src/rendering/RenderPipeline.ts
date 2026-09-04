import * as THREE from 'three/webgpu';
import {
  builtinAOContext,
  convertToTexture,
  float,
  int,
  max,
  metalness,
  mrt,
  normalView,
  output,
  packNormalToRGB,
  pass,
  renderOutput,
  roughness,
  sample,
  screenUV,
  select,
  smoothstep,
  step,
  uniform,
  unpackRGBToNormal,
  vec3,
  vec4,
  velocity,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { fsr1 } from 'three/addons/tsl/display/FSR1Node.js';
import { godrays } from 'three/addons/tsl/display/GodraysNode.js';
import type GTAONode from 'three/addons/tsl/display/GTAONode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import type { Disposable } from '../core/Disposable';
import { Logger } from '../core/Logger';
import type { QualitySettings } from './QualityPresets';
import type { ActiveBackend } from './Renderer';
import { VolumeFogNode, type VolumeFogSettings } from './VolumeFog';

/**
 * Post stages the pipeline knows about, in graph order. Every one is
 * individually toggleable and reports whether the active backend / layout can
 * run it at all.
 *
 * - `ao`          GTAO from a normal+depth prepass, applied to indirect light only
 *                 (`builtinAOContext`). WebGPU only.
 * - `traa`        Temporal reprojection AA from the scene pass velocity MRT. WebGPU only.
 * - `msaa`        Hardware MSAA on the scene pass. Only engaged when the preset has
 *                 neither AO nor TRAA (they cannot sample a multisampled depth buffer).
 * - `fsr1`        FidelityFX Super Resolution 1 upscale for renderScale < 1.
 *                 Off means a plain bilinear resolve.
 * - `ssr`         Screen-space reflections (mirror trace, roughness blur) from the
 *                 scene pass normal + metalness/roughness MRT. WebGPU only; the MRT
 *                 layout exists only when the preset has `screenSpaceReflections`.
 * - `volumetrics` Raymarched fog volume (`VolumeFog.ts`), present when the scene
 *                 registered one via `setVolumeFog`. WebGPU only.
 * - `godrays`     Screen-space light shafts from a shadow-casting directional/point
 *                 light registered via `setGodraysLight`. WebGPU only.
 * - `motionBlur`  Per-pixel motion blur along the velocity MRT. WebGPU only.
 * - `bloom`       HDR bloom before tone mapping.
 * - `dof`         Depth of field (`setFocus`, or `CameraRig.bindFocus`). WebGPU only.
 * - `fxaa`        Post-tonemap FXAA. The compat-tier AA.
 */
export type PostEffectName = 'ao' | 'traa' | 'msaa' | 'fsr1' | 'ssr' | 'volumetrics' | 'godrays' | 'motionBlur' | 'bloom' | 'dof' | 'fxaa';

export const POST_EFFECT_NAMES: readonly PostEffectName[] = [
  'ao',
  'traa',
  'msaa',
  'fsr1',
  'ssr',
  'volumetrics',
  'godrays',
  'motionBlur',
  'bloom',
  'dof',
  'fxaa',
];

export interface PostEffectState {
  readonly name: PostEffectName;
  /** Requested on (by preset or explicit toggle). */
  readonly enabled: boolean;
  /** The active backend and scene-pass layout can run it. `enabled && available` is what renders. */
  readonly available: boolean;
}

export interface RenderPipelineStats {
  /** Number of full scene renders per frame (1, or 2 with the AO prepass). */
  scenePasses: number;
  /** Effects actually in the current graph. */
  active: PostEffectName[];
  /** Internal scene-pass size in pixels. */
  sceneWidth: number;
  sceneHeight: number;
}

/** Light shaft appearance for `setGodraysLight`. */
export interface GodraysOptions {
  /** Colour the shafts are tinted with (linear). Default: the light's colour. */
  readonly color?: THREE.ColorRepresentation;
  /** Additive strength of the shafts. Default 0.6. */
  readonly intensity?: number;
  /** GodraysNode `density` (accumulation rate). Default 0.7. */
  readonly density?: number;
  /** GodraysNode `maxDensity` (brightness cap). Default 0.5. */
  readonly maxDensity?: number;
  /** GodraysNode `distanceAttenuation`. Default 2. */
  readonly distanceAttenuation?: number;
}

interface DisposableNode {
  dispose?: () => void;
}

/**
 * The expensive part of the graph: scene passes and the AO prepass. Every
 * scene material gets one GPU pipeline per pass variant, and compiling those
 * takes seconds on some driver stacks, so these live for the whole
 * scene/camera/quality combination and are only rewired by toggles.
 */
interface SceneLayout {
  scene: THREE.Scene;
  camera: THREE.Camera;
  quality: QualitySettings;
  /** MSAA engaged on the scene pass (excludes AO and TRAA for this layout). */
  msaa: boolean;
  samples: number;
  /** The one scene pass. On WebGPU it carries the velocity MRT and (if the preset has AO) the AO context permanently. */
  scenePass: THREE.PassNode;
  /**
   * WebGPU only. The projection matrix the `velocity` MRT node uses, owned by
   * the layout and shared with TRAA. `VelocityNode` builds a different shader
   * when its override is null, so keeping one persistent override means
   * adding or removing TRAA never recompiles a scene material.
   */
  velocityProjection: THREE.Matrix4 | null;
  /**
   * WebGPU only, presets with `screenSpaceReflections`: the scene pass MRT
   * also carries a view-space normal and a (metalness, roughness) attachment.
   * Part of the layout (a shader variant), so SSR on/off never recompiles.
   */
  ssr: boolean;
  /**
   * WebGPU only, presets with AO. Prepass and GTAO live for the layout's
   * lifetime and always render (GTAO first, which renders the prepass, which
   * renders the shadow maps under the default context), so the frame's
   * structure and every material's builder context are identical whether AO
   * is on or off. AO off just forces the sampled factor to 1 (`aoDisable`)
   * and drops both passes to 1/20 resolution.
   */
  prePass: THREE.PassNode | null;
  aoNode: GTAONode | null;
  aoDisable: THREE.UniformNode<'float', number> | null;
}

/** Resolution scale of the AO prepass/GTAO while AO is switched off (kept resident, see SceneLayout). */
const AO_IDLE_SCALE = 0.05;

/** Frames to keep retrying a godrays compose while its light has no shadow map yet. */
const GODRAYS_RETRY_FRAMES = 8;

const _drawingSize = new THREE.Vector2();

/**
 * Engine-owned wrapper around three's `RenderPipeline`. Composes the TSL
 * display nodes into one graph driven by `QualitySettings` (kickoff §7).
 *
 * Two tiers of rebuild:
 * - **layout** (scene, camera, quality or backend change): the scene pass,
 *   prepass and GTAO are recreated. Expensive (scene materials recompile).
 * - **compose** (effect toggles, upscale stage appearing, a volume or godrays
 *   light registered): only the cheap quad-level nodes (TRAA, FSR1, SSR, fog
 *   volume, godrays, motion blur, bloom, DOF, FXAA, tone map) are recreated
 *   and wired to the persistent scene pass. Scene materials keep their
 *   pipelines: the pass always has the same MRT layout and the same AO
 *   context, and AO on/off only swaps the texture that context samples.
 *
 * Render-scale changes are neither: the pass targets resize in place. Focus
 * distance, fog volume parameters and godrays strength are uniforms.
 *
 * Graph (WebGPU, everything on):
 *
 *   prepass (normal, depth) ─► GTAO ─► (AO texture, sampled by the scene pass context)
 *   scene pass (MRT output+velocity[+normal+material])
 *     ─► TRAA ─► FSR1 ─► + SSR ─► × fog volume + in-scatter ─► + godrays
 *     ─► motion blur ─► + bloom ─► DOF ─► tone map ─► [FXAA]
 *
 * Compat tier (WebGL2 backend): scene pass [MSAA] ─► + bloom ─► tone map ─► FXAA.
 */
export class RenderPipeline implements Disposable {
  readonly three: THREE.RenderPipeline;

  private readonly log = new Logger('pipeline');
  private readonly renderer: THREE.WebGPURenderer;
  private readonly backend: ActiveBackend;
  private quality: QualitySettings;
  private readonly enabled: Record<PostEffectName, boolean>;
  private renderScale = 1;
  /**
   * True while a controller may move the render scale every few hundred ms.
   * Keeps the upscale stage resident so scale changes never touch the graph.
   */
  private dynamicScaling = false;
  private layout: SceneLayout | null = null;
  private composeDirty = true;
  private disposed = false;
  /** Cheap per-composition nodes. */
  private nodes: DisposableNode[] = [];
  private activePass: THREE.PassNode | null = null;
  private activeEffects: PostEffectName[] = [];
  private aoActive = false;
  private traaActive = false;
  private toneMapping: THREE.ToneMapping = THREE.ACESFilmicToneMapping;
  private outputColorSpace: string = THREE.SRGBColorSpace;

  // ---- Milestone 7 state (uniforms and registrations; never shader variants) ----
  private readonly focusDistance = uniform(10);
  private readonly focusRange = uniform(4);
  private volumeFog: VolumeFogSettings | null = null;
  private godraysLight: THREE.DirectionalLight | THREE.PointLight | null = null;
  private readonly godraysColor = uniform(new THREE.Vector3(1, 1, 1));
  private readonly godraysTint = new THREE.Color();
  private readonly godraysIntensity = uniform(0.6);
  private godraysOptions: GodraysOptions = {};
  private godraysRetry = 0;

  constructor(renderer: THREE.WebGPURenderer, backend: ActiveBackend, quality: QualitySettings) {
    this.renderer = renderer;
    this.backend = backend;
    this.quality = quality;
    this.three = new THREE.RenderPipeline(renderer);
    // The graph applies tone mapping and colour space itself so FXAA can run after them.
    this.three.outputColorTransform = false;
    this.enabled = {
      ao: quality.ambientOcclusion !== 'off',
      traa: quality.temporalAA,
      msaa: quality.msaaSamples > 0,
      fsr1: quality.upscaler === 'fsr1',
      ssr: quality.screenSpaceReflections,
      volumetrics: quality.volumetrics,
      godrays: quality.volumetrics,
      motionBlur: quality.motionBlur,
      bloom: quality.bloom,
      dof: quality.depthOfField,
      fxaa: quality.fxaa,
    };
    this.renderScale = quality.renderScale;
  }

  /** Whether the active backend and scene-pass layout can run an effect at all. */
  isAvailable(name: PostEffectName): boolean {
    const gpuLayout = this.backend === 'webgpu' && !this.layoutUsesMSAA();
    switch (name) {
      case 'ao':
        return this.layout ? this.layout.aoNode !== null : gpuLayout && this.quality.ambientOcclusion !== 'off';
      case 'traa':
        return gpuLayout;
      case 'msaa':
        return this.layoutUsesMSAA();
      case 'ssr':
        return this.layout ? this.layout.ssr : gpuLayout && this.quality.screenSpaceReflections;
      case 'volumetrics':
        return gpuLayout && this.volumeFog !== null;
      case 'godrays':
        return gpuLayout && this.godraysLight !== null;
      case 'motionBlur':
      case 'dof':
        return gpuLayout;
      case 'fsr1':
      case 'bloom':
      case 'fxaa':
        return true;
    }
  }

  getEffects(): PostEffectState[] {
    return POST_EFFECT_NAMES.map((name) => ({ name, enabled: this.enabled[name], available: this.isAvailable(name) }));
  }

  /** Effects that are actually rendering this frame (enabled, available, and not pre-empted). */
  getActiveEffects(): readonly PostEffectName[] {
    return this.activeEffects;
  }

  isEffectEnabled(name: PostEffectName): boolean {
    return this.enabled[name];
  }

  setEffectEnabled(name: PostEffectName, enabled: boolean): void {
    if (this.enabled[name] === enabled) return;
    this.enabled[name] = enabled;
    this.composeDirty = true;
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.enabled.ao = quality.ambientOcclusion !== 'off';
    this.enabled.traa = quality.temporalAA;
    this.enabled.msaa = quality.msaaSamples > 0;
    this.enabled.fsr1 = quality.upscaler === 'fsr1';
    this.enabled.ssr = quality.screenSpaceReflections;
    this.enabled.volumetrics = quality.volumetrics;
    this.enabled.godrays = quality.volumetrics;
    this.enabled.motionBlur = quality.motionBlur;
    this.enabled.bloom = quality.bloom;
    this.enabled.dof = quality.depthOfField;
    this.enabled.fxaa = quality.fxaa;
    // Layout depends on quality (MSAA, AO resolution, SSR MRT); it is rebuilt on next render.
    this.composeDirty = true;
  }

  getQuality(): QualitySettings {
    return this.quality;
  }

  setToneMapping(toneMapping: THREE.ToneMapping, outputColorSpace: string): void {
    if (toneMapping === this.toneMapping && outputColorSpace === this.outputColorSpace) return;
    this.toneMapping = toneMapping;
    this.outputColorSpace = outputColorSpace;
    this.composeDirty = true;
  }

  // ---- Milestone 7 controls --------------------------------------------------

  /**
   * Depth-of-field focus plane: `distance` along the view direction in world
   * units, `range` how far from it a surface may be before it is fully
   * defocused. Uniforms; safe to call every frame (`CameraRig.bindFocus`).
   */
  setFocus(distance: number, range: number): void {
    this.focusDistance.value = Math.max(0.01, distance);
    this.focusRange.value = Math.max(0.01, range);
  }

  getFocus(): { distance: number; range: number } {
    return { distance: this.focusDistance.value, range: this.focusRange.value };
  }

  /**
   * Register (or remove, with null) the scene's fog volume. The `volumetrics`
   * effect is available only while one is registered. The settings object is
   * a set of uniforms: keep it and write it to animate the volume.
   */
  setVolumeFog(settings: VolumeFogSettings | null): void {
    if (this.volumeFog === settings) return;
    this.volumeFog = settings;
    this.composeDirty = true;
  }

  getVolumeFog(): VolumeFogSettings | null {
    return this.volumeFog;
  }

  /**
   * Register (or remove, with null) the shadow-casting directional or point
   * light the `godrays` effect marches through. The light must cast shadows
   * (the effect reads its shadow map); the stage is composed as soon as the
   * shadow map exists, normally the frame after registration.
   */
  setGodraysLight(light: THREE.DirectionalLight | THREE.PointLight | null, options: GodraysOptions = {}): void {
    this.godraysLight = light;
    this.godraysOptions = options;
    this.godraysTint.set(options.color ?? light?.color ?? 0xffffff);
    this.godraysColor.value.set(this.godraysTint.r, this.godraysTint.g, this.godraysTint.b);
    this.godraysIntensity.value = options.intensity ?? 0.6;
    this.godraysRetry = GODRAYS_RETRY_FRAMES;
    this.composeDirty = true;
  }

  /** Change the shaft strength/tint without a rebuild. */
  setGodraysIntensity(intensity: number, color?: THREE.ColorRepresentation): void {
    this.godraysIntensity.value = intensity;
    if (color !== undefined) {
      this.godraysTint.set(color);
      this.godraysColor.value.set(this.godraysTint.r, this.godraysTint.g, this.godraysTint.b);
    }
  }

  // ---- scale / size ---------------------------------------------------------------

  getRenderScale(): number {
    return this.renderScale;
  }

  /**
   * Internal resolution relative to the swap chain. Pass targets are resized
   * and re-initialised immediately so consumers (TRAA sizes its history from
   * the beauty texture) never see a stale size. No nodes are created unless
   * the upscale stage has to appear or disappear, which cannot happen while
   * dynamic scaling is active.
   */
  setRenderScale(scale: number): void {
    const clamped = Math.min(1, Math.max(0.25, scale));
    if (clamped === this.renderScale) return;
    const before = this.wantsUpscaleStage();
    this.renderScale = clamped;
    if (this.wantsUpscaleStage() !== before) this.composeDirty = true;
    this.sizePasses();
  }

  /**
   * Tell the pipeline that a controller will move the render scale at runtime.
   * While active, the FSR1 stage stays in the graph even at scale 1 (where it
   * degenerates to a mild RCAS sharpen), so scale changes never rebuild.
   */
  setDynamicScaling(active: boolean): void {
    if (this.dynamicScaling === active) return;
    const before = this.wantsUpscaleStage();
    this.dynamicScaling = active;
    if (this.wantsUpscaleStage() !== before) this.composeDirty = true;
  }

  isDynamicScaling(): boolean {
    return this.dynamicScaling;
  }

  /** The swap chain changed size. Resize the pass targets now rather than one consumer at a time. */
  resize(): void {
    this.sizePasses();
  }

  stats(): RenderPipelineStats {
    const rt = this.activePass?.renderTarget;
    const scenePasses = this.activePass ? (this.activeEffects.includes('ao') ? 2 : 1) : 0;
    return {
      scenePasses,
      active: [...this.activeEffects],
      sceneWidth: rt?.width ?? 0,
      sceneHeight: rt?.height ?? 0,
    };
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.disposed) return;
    const layout = this.ensureLayout(scene, camera);
    if (this.composeDirty) this.compose(layout);
    if (layout.velocityProjection && !this.traaActive) {
      // TRAA does this itself (with its jitter-free matrix) while it is in the
      // graph; without it the override must still be set, see SceneLayout.
      layout.velocityProjection.copy(camera.projectionMatrix);
      velocity.setProjectionMatrix(layout.velocityProjection);
    }
    this.three.render();
  }

  // ---- layout (expensive, persistent) ---------------------------------------

  private layoutUsesMSAA(): boolean {
    if (this.layout) return this.layout.msaa;
    return this.quality.msaaSamples > 0 && this.quality.ambientOcclusion === 'off' && !this.quality.temporalAA;
  }

  private wantsUpscaleStage(): boolean {
    return this.enabled.fsr1 && this.isAvailable('fsr1') && (this.dynamicScaling || this.renderScale < 1);
  }

  private ensureLayout(scene: THREE.Scene, camera: THREE.Camera): SceneLayout {
    const current = this.layout;
    if (current && current.scene === scene && current.camera === camera && current.quality === this.quality) return current;
    this.releaseLayout();

    const q = this.quality;
    // Depth-sampling effects cannot read a multisampled depth attachment, so
    // MSAA only exists in layouts whose preset asks for neither.
    const msaa = q.msaaSamples > 0 && q.ambientOcclusion === 'off' && !q.temporalAA;
    const samples = msaa ? q.msaaSamples : 0;

    const scenePass = pass(scene, camera, { samples });
    scenePass.name = 'Scene';
    scenePass.setResolutionScale(this.renderScale);

    let velocityProjection: THREE.Matrix4 | null = null;
    let prePass: THREE.PassNode | null = null;
    let aoNode: GTAONode | null = null;
    let aoDisable: THREE.UniformNode<'float', number> | null = null;
    const ssrLayout = this.backend === 'webgpu' && !msaa && q.screenSpaceReflections;
    if (this.backend === 'webgpu' && !msaa) {
      // Fixed layout for the WebGPU scene pass: velocity MRT (cheap) with a
      // persistent projection override, and, when the preset has AO, an AO
      // context that always samples the GTAO target. Toggling TRAA or AO then
      // never changes a scene material's shader or bindings.
      // Geometry attachments carry alpha 0 for any fragment that is not
      // fully opaque, so under the pass's blend state alpha-blended objects
      // (rain streaks, steam, soft decals) leave the velocity, normal and
      // material of the surface behind them untouched instead of smearing
      // their own into it (motion blur and TRAA would otherwise drag the wall
      // along with every raindrop). Solid unlit materials (neon tubes,
      // windows) do write; they never assign metalness / roughness, so the
      // material attachment reads (0, 0) there and SSR treats that as "not a
      // lit surface" and traces nothing through them.
      const solid = step(0.999, output.a);
      const targets: Record<string, THREE.Node> = { output, velocity: vec4((velocity as unknown as THREE.Node<'vec2'>).xy, 0.0, solid) };
      if (ssrLayout) {
        targets.normal = vec4(packNormalToRGB(normalView), solid);
        targets.material = vec4(metalness, roughness, 0.0, solid);
      }
      scenePass.setMRT(mrt(targets));
      velocityProjection = new THREE.Matrix4().copy(camera.projectionMatrix);
      velocity.setProjectionMatrix(velocityProjection);
    }
    if (this.backend === 'webgpu' && !msaa && q.ambientOcclusion !== 'off') {
      prePass = pass(scene, camera);
      prePass.name = 'Prepass';
      prePass.transparent = false;
      prePass.setResolutionScale(this.renderScale);
      prePass.setMRT(mrt({ output: packNormalToRGB(normalView) }));
      const prePassNormal = sample((uv) => unpackRGBToNormal(prePass!.getTextureNode().sample(uv)));
      const prePassDepth = prePass.getTextureNode('depth');

      aoNode = ao(prePassDepth, prePassNormal, camera);
      aoNode.resolutionScale = q.aoResolutionScale;
      aoNode.useTemporalFiltering = q.temporalAA;
      aoNode.radius.value = q.ambientOcclusion === 'gtao' ? 0.5 : 0.35;
      aoNode.samples.value = q.ambientOcclusion === 'gtao' ? 16 : 8;
      aoDisable = uniform(0);
      scenePass.contextNode = builtinAOContext(aoNode.getTextureNode().sample(screenUV).r.max(aoDisable));
    }

    const layout: SceneLayout = {
      scene,
      camera,
      quality: q,
      msaa,
      samples,
      scenePass,
      velocityProjection,
      ssr: ssrLayout,
      prePass,
      aoNode,
      aoDisable,
    };
    this.layout = layout;
    this.composeDirty = true;
    this.godraysRetry = GODRAYS_RETRY_FRAMES;
    this.sizePasses();
    this.log.debug(`layout built: backend=${this.backend} msaa=${samples} ssrMRT=${ssrLayout} scale=${this.renderScale.toFixed(2)}`);
    return layout;
  }

  /** Size and initialise every pass target for the current drawing buffer and render scale. */
  private sizePasses(): void {
    const layout = this.layout;
    if (!layout) return;
    this.renderer.getDrawingBufferSize(_drawingSize);
    for (const p of [layout.scenePass, layout.prePass]) {
      if (!p) continue;
      p.setResolutionScale(p === layout.prePass && !this.aoActive ? AO_IDLE_SCALE : this.renderScale);
      p.setSize(_drawingSize.x, _drawingSize.y);
      // three sizes pass targets lazily from inside whichever node samples them
      // first. TRAANode reads the beauty size before that happens and would
      // build its history at the stale size, then copy a depth texture of the
      // wrong size (GPUValidationError, and on rebuild an uncaught TypeError).
      this.renderer.initRenderTarget(p.renderTarget);
    }
  }

  private releaseLayout(): void {
    const layout = this.layout;
    if (!layout) return;
    this.releaseNodes();
    for (const node of [layout.aoNode, layout.prePass, layout.scenePass]) {
      try {
        (node as DisposableNode | null)?.dispose?.();
      } catch (error) {
        this.log.warn('layout node dispose failed', error);
      }
    }

    if (layout.velocityProjection) velocity.setProjectionMatrix(null);
    this.layout = null;
    this.activePass = null;
    this.aoActive = false;
    this.traaActive = false;
  }

  // ---- composition (cheap, per toggle) ---------------------------------------

  private compose(layout: SceneLayout): void {
    this.releaseNodes();
    this.composeDirty = false;

    const q = layout.quality;
    const on = (name: PostEffectName): boolean => this.enabled[name] && this.isAvailable(name);
    const useAO = on('ao');
    const useTRAA = on('traa');
    const useFSR = this.wantsUpscaleStage();
    const useSSR = on('ssr');
    const useVolumetrics = on('volumetrics');
    const useGodrays = on('godrays');
    const useMotionBlur = on('motionBlur');
    const useBloom = on('bloom');
    const useDOF = on('dof');
    const useFXAA = on('fxaa');
    const active: PostEffectName[] = [];

    const scenePass = layout.scenePass;
    const camera = layout.camera;
    this.activePass = scenePass;
    if (layout.msaa) active.push('msaa');

    // GTAO (and through it the prepass) always render when the layout has
    // them, kept in the graph by referencing the GTAO texture below. AO off
    // only neutralises the sampled factor and shrinks both passes.
    let aoTrigger: THREE.TextureNode | null = null;
    this.aoActive = useAO && layout.aoNode !== null;
    if (layout.aoNode && layout.aoDisable) {
      aoTrigger = layout.aoNode.getTextureNode();
      layout.aoDisable.value = this.aoActive ? 0 : 1;
      layout.aoNode.resolutionScale = this.aoActive ? q.aoResolutionScale : AO_IDLE_SCALE;
      this.sizePasses();
      if (this.aoActive) active.push('ao');
    }

    const depthTexture = scenePass.getTextureNode('depth');
    let colorTexture: THREE.TextureNode = scenePass.getTextureNode('output');
    let color: THREE.Node = colorTexture;

    this.traaActive = useTRAA && layout.velocityProjection !== null;
    if (this.traaActive && layout.velocityProjection) {
      const traaNode = traa(colorTexture, depthTexture, scenePass.getTextureNode('velocity'), camera);
      // TRAA writes the jitter-free projection into its own matrix and hands
      // that to `velocity`; point it at the layout's persistent one instead so
      // the scene materials' velocity uniform is always this object (r185).
      (traaNode as unknown as { _originalProjectionMatrix: THREE.Matrix4 })._originalProjectionMatrix = layout.velocityProjection;
      this.nodes.push(traaNode);
      // TRAANode exposes its resolve target as a texture node (not in the typings).
      colorTexture = (traaNode as unknown as { getTextureNode(): THREE.TextureNode }).getTextureNode();
      color = traaNode;
      active.push('traa');
    }

    if (useFSR) {
      const fsrNode = fsr1(colorTexture, 0.25);
      this.nodes.push(fsrNode);
      color = fsrNode;
      active.push('fsr1');
    }
    // When scaled without FSR the scene texture is simply sampled at swap-chain
    // resolution by the final quad: a bilinear resolve for free.

    if (useSSR && layout.ssr) {
      // Mirror trace against the (TRAA-resolved) beauty, blurred by roughness
      // through the node's mip chain. `metalnessNode` is really a reflection
      // weight: metals reflect fully, dielectrics only when glossy (puddles,
      // wet paint), and (0, 0) surfaces are unlit and get nothing.
      const normalTexture = scenePass.getTextureNode('normal');
      const normalNode = sample((uv) => unpackRGBToNormal(normalTexture.sample(uv)));
      const materialTexture = scenePass.getTextureNode('material');
      const metal = materialTexture.r;
      const rough = materialTexture.g;
      const lit = metal.add(rough).greaterThan(0.001);
      const reflectWeight = select(lit, max(metal, smoothstep(0.32, 0.02, rough)), float(0));
      const ssrNode = ssr(colorTexture, depthTexture, normalNode, {
        metalnessNode: reflectWeight,
        roughnessNode: rough,
        reflectNonMetals: true,
        camera,
      });
      ssrNode.resolutionScale = q.ssrResolutionScale;
      ssrNode.quality.value = q.ssrQuality;
      ssrNode.maxDistance.value = q.ssrMaxDistance;
      ssrNode.thickness.value = 0.25;
      // The mirror path already applies a grazing-angle term ((dot(I, R) + 1) / 2, about 0.15 at a
      // 25° camera pitch) and a squared distance falloff; the extra gain keeps neon legible in
      // puddles from the three-quarter camera (ADR-004) instead of physically faint.
      ssrNode.intensity.value = 2.4;
      this.nodes.push(ssrNode);
      color = (color as THREE.Node<'vec4'>).add(ssrNode);
      active.push('ssr');
    }

    if (useVolumetrics && this.volumeFog) {
      const fogNode = new VolumeFogNode(depthTexture, camera, this.volumeFog);
      fogNode.resolutionScale = q.volumetricResolutionScale;
      fogNode.steps.value = q.volumetricSteps;
      this.nodes.push(fogNode);
      const fogTexture = fogNode.getTextureNode();
      const c = color as THREE.Node<'vec4'>;
      color = vec4(c.rgb.mul(fogTexture.a).add(fogTexture.rgb), 1.0);
      active.push('volumetrics');
    }

    if (useGodrays && this.godraysLight) {
      const light = this.godraysLight;
      if (light.castShadow && light.shadow.map) {
        const godraysNode = godrays(depthTexture, camera, light);
        godraysNode.resolutionScale = 0.5;
        godraysNode.raymarchSteps.value = q.godraysSteps;
        godraysNode.density.value = this.godraysOptions.density ?? 0.7;
        godraysNode.maxDensity.value = this.godraysOptions.maxDensity ?? 0.5;
        godraysNode.distanceAttenuation.value = this.godraysOptions.distanceAttenuation ?? 2;
        this.nodes.push(godraysNode);
        const shafts = vec3(this.godraysColor).mul(godraysNode.getTextureNode().r.mul(this.godraysIntensity));
        color = (color as THREE.Node<'vec4'>).add(vec4(shafts, 0.0));
        active.push('godrays');
      } else if (this.godraysRetry > 0) {
        // The shadow map is created by the first scene render; compose again next frame.
        this.godraysRetry--;
        this.composeDirty = true;
      } else {
        this.log.warn('godrays: light has no shadow map (castShadow off or shadows disabled); stage skipped');
      }
    }

    if (useMotionBlur && layout.velocityProjection) {
      // The velocity MRT is an NDC delta; halve it for UV space and scale by
      // the preset's shutter fraction.
      const source = this.asTexture(color);
      const velocityUV = scenePass.getTextureNode('velocity').xy.mul(0.5 * q.motionBlurStrength);
      color = motionBlur(source, velocityUV, int(q.motionBlurSamples));
      active.push('motionBlur');
    }

    if (useBloom) {
      const bloomNode = bloom(color as THREE.Node<'vec4'>, q.bloomStrength, q.bloomRadius, q.bloomThreshold);
      this.nodes.push(bloomNode);
      color = (color as THREE.Node<'vec4'>).add(bloomNode);
      active.push('bloom');
    }

    if (useDOF) {
      const dofNode = dof(color, scenePass.getViewZNode(), this.focusDistance, this.focusRange, q.dofBokehScale);
      this.nodes.push(dofNode);
      color = dofNode;
      active.push('dof');
    }

    if (aoTrigger) {
      // A zero-weighted sample keeps the GTAO texture (and so GTAO and the
      // prepass) in the quad graph; as the left operand it is built first, so
      // GTAO updates before the scene pass that samples it through the context.
      color = aoTrigger.sample(screenUV).r.mul(0.0).add(color as THREE.Node<'vec4'>);
    }

    let final: THREE.Node = renderOutput(color, this.toneMapping, this.outputColorSpace);
    if (useFXAA) {
      const fxaaNode = fxaa(final);
      this.nodes.push(fxaaNode);
      final = fxaaNode;
      active.push('fxaa');
    }

    this.three.outputNode = final;
    this.three.needsUpdate = true;
    this.activeEffects = active;
    this.log.debug(`graph composed: backend=${this.backend} scale=${this.renderScale.toFixed(2)} active=[${active.join(' ')}]`);
  }

  /** A node the next stage can `.sample()`: the node itself if it already is a texture, else one RTT copy. */
  private asTexture(node: THREE.Node): THREE.TextureNode {
    const texture = convertToTexture(node) as THREE.TextureNode;
    if (texture !== (node as unknown)) {
      const rtt = texture as unknown as { renderTarget?: THREE.RenderTarget | null };
      this.nodes.push({ dispose: () => rtt.renderTarget?.dispose() });
    }
    return texture;
  }

  private releaseNodes(): void {
    // A removed TRAA leaves its last jitter offset on the camera.
    const cam = this.layout?.camera as (THREE.Camera & { clearViewOffset?: () => void }) | undefined;
    cam?.clearViewOffset?.();
    for (const node of this.nodes) {
      try {
        node.dispose?.();
      } catch (error) {
        this.log.warn('node dispose failed', error);
      }
    }
    this.nodes = [];
    this.activeEffects = [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseLayout();
    this.three.dispose();
  }
}
