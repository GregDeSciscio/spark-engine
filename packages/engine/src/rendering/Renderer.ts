import * as THREE from 'three/webgpu';
import type { BackendPreference } from '../core/Config';
import type { Disposable } from '../core/Disposable';
import { Logger } from '../core/Logger';
import { DynamicResolutionController } from './DynamicResolution';
import type { QualitySettings } from './QualityPresets';
import { RenderPipeline } from './RenderPipeline';

export type ActiveBackend = 'webgpu' | 'webgl';

export interface RendererCapabilities {
  readonly backend: ActiveBackend;
  /** Whether WebGPU was available at all, regardless of which backend was chosen. */
  readonly webgpuAvailable: boolean;
  /** GPU timestamp queries usable, so `gpuMs` in stats is real. */
  readonly timestampQuery: boolean;
  readonly maxTextureSize: number;
  readonly adapter: { vendor: string; architecture: string; device: string; description: string } | null;
}

export interface RendererOptions {
  container: HTMLElement;
  backend: BackendPreference;
  maxPixelRatio: number;
  renderScale: number;
  quality: QualitySettings;
  /** Fixed drawing-buffer size for deterministic capture. Overrides container size. */
  fixedSize?: { width: number; height: number } | undefined;
  /**
   * Track GPU timestamps (WebGPU `timestamp-query`). Default true. The engine
   * turns this off on a fixed clock: in synchronous stepped rendering the async
   * resolve never lands before the next frame, so the query pool only grows
   * until three warns "Maximum number of queries exceeded".
   */
  trackTimestamp?: boolean | undefined;
}

export interface RenderFrameStats {
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  /** Last resolved GPU frame time in ms, or null if unmeasurable on this backend. */
  gpuMs: number | null;
  /** Drawing-buffer (swap chain) size in physical pixels. */
  width: number;
  height: number;
  /** Internal scene-pass size in physical pixels (drawing buffer x renderScale). */
  sceneWidth: number;
  sceneHeight: number;
  pixelRatio: number;
  renderScale: number;
  /** Post effects actually rendering this frame, in graph order. */
  postEffects: string[];
}

export class RendererInitError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RendererInitError';
  }
}

export async function detectWebGPU(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

/**
 * Engine-owned wrapper around three's `WebGPURenderer`.
 *
 * One renderer class, two backends: WebGPU when available and permitted, else
 * three's WebGL2 backend. Nothing outside `rendering/` should touch the
 * underlying three renderer except through `three` for scene-level needs
 * (PMREM generation, loaders that need a renderer).
 */
export class SparkRenderer implements Disposable {
  readonly canvas: HTMLCanvasElement;
  readonly three: THREE.WebGPURenderer;
  readonly capabilities: RendererCapabilities;
  /** The post-processing graph. Every frame goes through it (Milestone 2). */
  readonly pipeline: RenderPipeline;
  /**
   * Moves `renderScale` to hold the frame budget. Off by default; the owner
   * enables it for real-time runs only (never on a fixed clock, where frame
   * times are meaningless for pacing).
   */
  readonly dynamicResolution: DynamicResolutionController;

  private readonly log = new Logger('renderer');
  private readonly container: HTMLElement;
  private readonly maxPixelRatio: number;
  private renderScale: number;
  private fixedSize: { width: number; height: number } | null;
  private resizeObserver: ResizeObserver | null = null;
  private quality: QualitySettings;
  private lastGpuMs: number | null = null;
  private disposed = false;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private lastRenderTime: number | null = null;

  private constructor(options: RendererOptions, three: THREE.WebGPURenderer, capabilities: RendererCapabilities) {
    this.container = options.container;
    this.maxPixelRatio = options.maxPixelRatio;
    this.renderScale = options.renderScale;
    this.fixedSize = options.fixedSize ?? null;
    this.quality = options.quality;
    this.three = three;
    this.canvas = three.domElement;
    this.capabilities = capabilities;
    this.pipeline = new RenderPipeline(three, capabilities.backend, options.quality);
    this.pipeline.setRenderScale(this.renderScale);
    this.dynamicResolution = new DynamicResolutionController(
      { floor: options.quality.dynamicResolutionFloor, ceiling: 1 },
      this.renderScale,
    );
    this.dynamicResolution.enabled = false;
  }

  /**
   * Create and initialise a renderer. Tries the preferred backend; if WebGPU
   * initialisation throws, falls back to WebGL2 unless `backend === 'webgpu'`
   * was demanded explicitly.
   */
  static async create(options: RendererOptions): Promise<SparkRenderer> {
    const log = new Logger('renderer');
    const webgpuAvailable = await detectWebGPU();

    let wantWebGPU: boolean;
    if (options.backend === 'webgpu') {
      if (!webgpuAvailable) throw new RendererInitError('WebGPU was required but is not available in this browser');
      wantWebGPU = true;
    } else if (options.backend === 'webgl') {
      wantWebGPU = false;
    } else {
      wantWebGPU = webgpuAvailable;
    }

    const tryInit = async (forceWebGL: boolean): Promise<THREE.WebGPURenderer> => {
      const renderer = new THREE.WebGPURenderer({
        // The swap chain is only ever written by the pipeline's final quad;
        // anti-aliasing (MSAA / TRAA / FXAA) lives on the scene pass instead.
        antialias: false,
        forceWebGL,
        trackTimestamp: options.trackTimestamp ?? true,
        // powerPreference is deliberately not set: Chromium on Windows ignores it
        // and logs a console warning, which would fail the clean-console check.
      });
      try {
        await renderer.init();
      } catch (error) {
        renderer.dispose();
        throw error;
      }
      return renderer;
    };

    let renderer: THREE.WebGPURenderer;
    let backend: ActiveBackend;
    try {
      renderer = await tryInit(!wantWebGPU);
      backend = wantWebGPU ? 'webgpu' : 'webgl';
    } catch (error) {
      if (wantWebGPU && options.backend === 'auto') {
        log.warn('WebGPU initialisation failed, falling back to WebGL2', error);
        try {
          renderer = await tryInit(true);
          backend = 'webgl';
        } catch (fallbackError) {
          throw new RendererInitError('Both WebGPU and WebGL2 backends failed to initialise', fallbackError);
        }
      } else {
        throw new RendererInitError(`Renderer backend "${options.backend}" failed to initialise`, error);
      }
    }

    // Defensive: three decides the backend; confirm rather than assume.
    const backendObject = renderer.backend as { isWebGPUBackend?: boolean };
    if (backendObject.isWebGPUBackend !== true) backend = 'webgl';

    let timestampQuery = false;
    let adapter: RendererCapabilities['adapter'] = null;
    if (backend === 'webgpu' && (options.trackTimestamp ?? true)) {
      try {
        timestampQuery = renderer.hasFeature('timestamp-query');
      } catch {
        timestampQuery = false;
      }
      const device = (renderer.backend as { device?: GPUDevice }).device;
      const info = device?.adapterInfo;
      if (info) {
        adapter = {
          vendor: info.vendor,
          architecture: info.architecture,
          device: info.device,
          description: info.description,
        };
      }
    }

    const capabilities: RendererCapabilities = {
      backend,
      webgpuAvailable,
      timestampQuery,
      maxTextureSize: 8192,
      adapter,
    };

    // three starts an internal requestAnimationFrame loop on init even with no
    // callback (Animation.js). The engine drives frames itself; stop three's so
    // there is exactly one per-frame bookkeeping path (see beginFrame()).
    (renderer as unknown as { _animation: { stop(): void } })._animation.stop();

    const instance = new SparkRenderer(options, renderer, capabilities);
    instance.configure();
    instance.attach();
    log.info(`backend=${backend} webgpuAvailable=${webgpuAvailable} timestampQuery=${timestampQuery}`);
    return instance;
  }

  private configure(): void {
    const r = this.three;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = this.quality.shadows;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.pipeline.setToneMapping(r.toneMapping, r.outputColorSpace);
  }

  private attach(): void {
    const canvas = this.canvas;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.setAttribute('data-spark-canvas', '');
    this.container.appendChild(canvas);
    this.resize();
    if (typeof ResizeObserver !== 'undefined' && !this.fixedSize) {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
    }
  }

  /** Recompute drawing-buffer size from the container (or fixed size) and DPR. Idempotent. */
  resize(): void {
    if (this.disposed) return;
    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, this.maxPixelRatio);
    let width: number;
    let height: number;
    if (this.fixedSize) {
      width = this.fixedSize.width;
      height = this.fixedSize.height;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
    } else {
      width = Math.max(1, Math.floor(this.container.clientWidth));
      height = Math.max(1, Math.floor(this.container.clientHeight));
    }
    if (width === this.width && height === this.height && dpr === this.pixelRatio) return;
    this.width = width;
    this.height = height;
    this.pixelRatio = dpr;
    this.applySize();
  }

  private applySize(): void {
    // The swap chain is always native size; the pipeline renders its scene
    // passes at `renderScale` and resolves up to it.
    this.three.setPixelRatio(this.fixedSize ? 1 : this.pixelRatio);
    this.three.setSize(this.width, this.height, false);
    if (!this.fixedSize) {
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
    }
    this.pipeline.resize();
  }

  /** Logical (CSS) size of the viewport. */
  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  get aspect(): number {
    return this.width / this.height;
  }

  getRenderScale(): number {
    return this.renderScale;
  }

  setRenderScale(scale: number): void {
    const clamped = Math.min(1, Math.max(0.25, scale));
    if (clamped === this.renderScale) return;
    this.renderScale = clamped;
    this.pipeline.setRenderScale(clamped);
  }

  getQuality(): QualitySettings {
    return this.quality;
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.three.shadowMap.enabled = quality.shadows;
    this.pipeline.setQuality(quality);
    this.dynamicResolution.configure({ floor: quality.dynamicResolutionFloor });
    this.dynamicResolution.setScale(quality.renderScale);
    this.setRenderScale(quality.renderScale);
  }

  /**
   * Enable the dynamic resolution controller. Callers must leave it off on a
   * fixed clock (`engine.config.fixedFrameDelta !== null`): stepped frames have
   * no meaningful frame time and captures must be deterministic.
   */
  setDynamicResolutionEnabled(enabled: boolean): void {
    if (this.dynamicResolution.enabled === enabled) return;
    this.dynamicResolution.enabled = enabled;
    this.dynamicResolution.reset(enabled ? this.renderScale : this.quality.renderScale);
    this.lastRenderTime = null;
    // Keep the upscale stage resident while the controller may move the scale,
    // so scale changes are target resizes, never graph rebuilds.
    this.pipeline.setDynamicScaling(enabled);
    if (!enabled) this.setRenderScale(this.quality.renderScale);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.disposed) return;
    const start = performance.now();
    this.beginFrame();
    this.pipeline.render(scene, camera);
    this.sampleGpuTime();
    if (this.dynamicResolution.enabled) {
      const end = performance.now();
      const dt = this.lastRenderTime === null ? 0 : (end - this.lastRenderTime) / 1000;
      this.lastRenderTime = end;
      const next = this.dynamicResolution.update(dt, this.lastGpuMs, end - start);
      if (next !== this.renderScale) this.setRenderScale(next);
    }
  }

  /**
   * What three's internal animation loop does before each frame
   * (src/renderers/common/Animation.js): reset per-frame counters, advance the
   * node frame id, publish it on `info`. The engine owns the loop, so it owns
   * these too. Without this, synchronous stepping (capture, tests) never
   * advances the frame id, so frame-gated work such as shadow map updates is
   * skipped and draw-call stats accumulate.
   */
  private beginFrame(): void {
    const three = this.three as unknown as {
      info: { reset(): void; frame: number };
      _nodes: { nodeFrame: { update(): void; frameId: number } };
    };
    three.info.reset();
    three._nodes.nodeFrame.update();
    three.info.frame = three._nodes.nodeFrame.frameId;
  }

  /** Resolve GPU timestamps in the background; result lands in `stats().gpuMs` a frame or two later. */
  private sampleGpuTime(): void {
    if (!this.capabilities.timestampQuery) return;
    // Resolve every frame: three's query pool coalesces concurrent resolves,
    // and skipping frames while one is pending lets the pool (2048 queries)
    // overflow during compile stalls, which three reports as a console warning.
    void this.three
      .resolveTimestampsAsync(THREE.TimestampQuery.RENDER)
      .then(() => {
        const ms = this.three.info.render.timestamp;
        if (typeof ms === 'number' && Number.isFinite(ms)) this.lastGpuMs = ms;
      })
      .catch(() => {
        this.lastGpuMs = null;
      });
  }

  stats(): RenderFrameStats {
    const info = this.three.info.render;
    const pipeline = this.pipeline.stats();
    const drawingWidth = this.three.domElement.width;
    const drawingHeight = this.three.domElement.height;
    return {
      drawCalls: info.drawCalls,
      triangles: info.triangles,
      points: info.points,
      lines: info.lines,
      gpuMs: this.lastGpuMs,
      width: drawingWidth,
      height: drawingHeight,
      sceneWidth: pipeline.sceneWidth,
      sceneHeight: pipeline.sceneHeight,
      pixelRatio: this.pixelRatio,
      renderScale: this.renderScale,
      postEffects: pipeline.active,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.pipeline.dispose();
    this.three.dispose();
    this.canvas.remove();
    this.log.debug('disposed');
  }
}
