import * as THREE from 'three/webgpu';
import {
  builtinAOContext,
  mrt,
  normalView,
  output,
  packNormalToRGB,
  pass,
  renderOutput,
  sample,
  screenUV,
  unpackRGBToNormal,
  velocity,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { fsr1 } from 'three/addons/tsl/display/FSR1Node.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import type { Disposable } from '../core/Disposable';
import { Logger } from '../core/Logger';
import type { QualitySettings } from './QualityPresets';
import type { ActiveBackend } from './Renderer';

/**
 * Post stages the pipeline knows about. Every one is individually toggleable
 * and reports whether the active backend can run it at all.
 *
 * - `ao`    GTAO from a depth/normal prepass, applied to indirect light only
 *           (`builtinAOContext`). WebGPU only (MRT + prepass).
 * - `traa`  Temporal reprojection AA from the shared velocity buffer. WebGPU only.
 * - `msaa`  Hardware MSAA on the scene pass. Used only when no effect needs to
 *           sample the depth buffer (i.e. AO and TRAA are both off).
 * - `fsr1`  FidelityFX Super Resolution 1 upscale when renderScale < 1.
 *           Off means a plain bilinear resolve.
 * - `bloom` HDR bloom before tone mapping.
 * - `fxaa`  Post-tonemap FXAA. The compat-tier AA.
 */
export type PostEffectName = 'ao' | 'traa' | 'msaa' | 'fsr1' | 'bloom' | 'fxaa';

export const POST_EFFECT_NAMES: readonly PostEffectName[] = ['ao', 'traa', 'msaa', 'fsr1', 'bloom', 'fxaa'];

export interface PostEffectState {
  readonly name: PostEffectName;
  /** Requested on (by preset or explicit toggle). */
  readonly enabled: boolean;
  /** The active backend can run it. `enabled && available` is what actually renders. */
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

interface DisposableNode {
  dispose?: () => void;
}

/**
 * Engine-owned wrapper around three's `RenderPipeline`. Composes the TSL
 * display nodes into one graph driven by `QualitySettings` (kickoff §7). The
 * graph is rebuilt lazily when the scene, camera, quality, toggles, or the
 * "scaled vs native" state changes; per-frame work is just `render()`.
 *
 * Graph (WebGPU, everything on):
 *
 *   prepass (normal+velocity+depth) ─► GTAO ─┐
 *   scene pass (AO context) ─► TRAA ─► FSR1 ─► + bloom ─► tone map ─► [FXAA]
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
  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;
  private dirty = true;
  private disposed = false;
  private nodes: DisposableNode[] = [];
  private scenePass: THREE.PassNode | null = null;
  private prePass: THREE.PassNode | null = null;
  private activeEffects: PostEffectName[] = [];
  private toneMapping: THREE.ToneMapping = THREE.ACESFilmicToneMapping;
  private outputColorSpace: string = THREE.SRGBColorSpace;

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
      bloom: quality.bloom,
      fxaa: quality.fxaa,
    };
    this.renderScale = quality.renderScale;
  }

  /** Whether the active backend can run an effect at all. */
  isAvailable(name: PostEffectName): boolean {
    switch (name) {
      case 'ao':
      case 'traa':
        return this.backend === 'webgpu';
      case 'msaa':
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

  setEffectEnabled(name: PostEffectName, enabled: boolean): void {
    if (this.enabled[name] === enabled) return;
    this.enabled[name] = enabled;
    this.dirty = true;
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.enabled.ao = quality.ambientOcclusion !== 'off';
    this.enabled.traa = quality.temporalAA;
    this.enabled.msaa = quality.msaaSamples > 0;
    this.enabled.fsr1 = quality.upscaler === 'fsr1';
    this.enabled.bloom = quality.bloom;
    this.enabled.fxaa = quality.fxaa;
    this.dirty = true;
  }

  getQuality(): QualitySettings {
    return this.quality;
  }

  setToneMapping(toneMapping: THREE.ToneMapping, outputColorSpace: string): void {
    if (toneMapping === this.toneMapping && outputColorSpace === this.outputColorSpace) return;
    this.toneMapping = toneMapping;
    this.outputColorSpace = outputColorSpace;
    this.dirty = true;
  }

  getRenderScale(): number {
    return this.renderScale;
  }

  /**
   * Internal resolution relative to the swap chain. Scene passes resize on the
   * fly; only crossing the 1.0 boundary rebuilds the graph (the upscale stage
   * comes and goes).
   */
  setRenderScale(scale: number): void {
    const clamped = Math.min(1, Math.max(0.25, scale));
    if (clamped === this.renderScale) return;
    const crossed = (clamped < 1) !== (this.renderScale < 1);
    this.renderScale = clamped;
    if (crossed) {
      this.dirty = true;
    } else {
      this.scenePass?.setResolutionScale(clamped);
      this.prePass?.setResolutionScale(clamped);
    }
  }

  /** The swap chain changed size. Pass nodes track the drawing buffer themselves; nothing to rebuild. */
  resize(): void {
    // Intentionally empty: PassNode, GTAONode, TRAANode, BloomNode, FSR1Node and
    // FXAANode all read renderer.getDrawingBufferSize() in updateBefore().
  }

  stats(): RenderPipelineStats {
    const rt = this.scenePass?.renderTarget;
    return {
      scenePasses: (this.scenePass ? 1 : 0) + (this.prePass ? 1 : 0),
      active: [...this.activeEffects],
      sceneWidth: rt?.width ?? 0,
      sceneHeight: rt?.height ?? 0,
    };
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.disposed) return;
    if (scene !== this.scene || camera !== this.camera) {
      this.scene = scene;
      this.camera = camera;
      this.dirty = true;
    }
    if (this.dirty) this.rebuild(scene, camera);
    this.three.render();
  }

  private rebuild(scene: THREE.Scene, camera: THREE.Camera): void {
    this.releaseNodes();
    this.dirty = false;

    const q = this.quality;
    const on = (name: PostEffectName): boolean => this.enabled[name] && this.isAvailable(name);
    const useAO = on('ao');
    const useTRAA = on('traa');
    // Depth-sampling effects cannot read a multisampled depth attachment.
    const useMSAA = on('msaa') && !useAO && !useTRAA;
    const scaled = this.renderScale < 1;
    const useFSR = scaled && on('fsr1');
    const useBloom = on('bloom');
    const useFXAA = on('fxaa');
    const active: PostEffectName[] = [];

    // Scene pass (beauty). HDR half-float target by default.
    const scenePass = pass(scene, camera, { samples: useMSAA ? q.msaaSamples : 0 });
    scenePass.name = 'Scene';
    scenePass.setResolutionScale(this.renderScale);
    this.scenePass = scenePass;
    this.nodes.push(scenePass);
    if (useMSAA) active.push('msaa');

    let depthNode: THREE.TextureNode | null = null;
    let velocityNode: THREE.TextureNode | null = null;

    if (useAO) {
      // Shared prepass: view-space normals in the colour slot, velocity in MRT,
      // depth from the attachment. AO reads depth+normal; TRAA reads depth+velocity.
      const prePass = pass(scene, camera);
      prePass.name = 'Prepass';
      prePass.transparent = false;
      prePass.setResolutionScale(this.renderScale);
      prePass.setMRT(mrt({ output: packNormalToRGB(normalView), velocity }));
      this.prePass = prePass;
      this.nodes.push(prePass);

      const prePassNormal = sample((uv) => unpackRGBToNormal(prePass.getTextureNode().sample(uv)));
      depthNode = prePass.getTextureNode('depth');
      velocityNode = prePass.getTextureNode('velocity');

      const aoNode = ao(depthNode, prePassNormal, camera);
      aoNode.resolutionScale = q.aoResolutionScale;
      aoNode.useTemporalFiltering = useTRAA;
      aoNode.radius.value = q.ambientOcclusion === 'gtao' ? 0.5 : 0.35;
      aoNode.samples.value = q.ambientOcclusion === 'gtao' ? 16 : 8;
      this.nodes.push(aoNode);
      scenePass.contextNode = builtinAOContext(aoNode.getTextureNode().sample(screenUV).r);
      active.push('ao');
    } else if (useTRAA) {
      scenePass.setMRT(mrt({ output, velocity }));
      depthNode = scenePass.getTextureNode('depth');
      velocityNode = scenePass.getTextureNode('velocity');
    }

    let colorTexture: THREE.TextureNode = scenePass.getTextureNode('output');
    let color: THREE.Node = colorTexture;

    if (useTRAA && depthNode && velocityNode) {
      const traaNode = traa(colorTexture, depthNode, velocityNode, camera);
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

    if (useBloom) {
      const bloomNode = bloom(color as THREE.Node<'vec4'>, q.bloomStrength, q.bloomRadius, q.bloomThreshold);
      this.nodes.push(bloomNode);
      color = (color as THREE.Node<'vec4'>).add(bloomNode);
      active.push('bloom');
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
    this.log.debug(`graph rebuilt: backend=${this.backend} scale=${this.renderScale.toFixed(2)} active=[${active.join(' ')}]`);
  }

  private releaseNodes(): void {
    for (const node of this.nodes) {
      try {
        node.dispose?.();
      } catch (error) {
        this.log.warn('node dispose failed', error);
      }
    }
    this.nodes = [];
    this.scenePass = null;
    this.prePass = null;
    this.activeEffects = [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseNodes();
    this.three.dispose();
    this.scene = null;
    this.camera = null;
  }
}
