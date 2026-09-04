import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Disposable } from '../core/Disposable';
import { Logger } from '../core/Logger';
import type { SparkRenderer } from '../rendering/Renderer';
import { AssetCache, AssetLoadAbortedError, type AssetCacheStats, type CachedAsset } from './AssetCache';
import { LoadingProgress, type LoadingSnapshot } from './LoadingProgress';
import { ModelAsset, estimateTextureBytes } from './ModelAsset';

export interface AssetManagerOptions {
  renderer: SparkRenderer;
  /**
   * URL prefix (with trailing slash) where `basis_transcoder.js` / `.wasm` are
   * served from. The asset pipeline copies them into the benchmark app's
   * `public/libs/basis/`. Default `/libs/basis/`.
   */
  basisTranscoderPath?: string | undefined;
  /** Web workers used for KTX2 transcoding. Default 4. */
  ktx2WorkerLimit?: number | undefined;
}

/** Which GPU-compressed formats KTX2 textures can be transcoded to on this device. */
export interface KTX2Support {
  readonly astc: boolean;
  readonly etc1: boolean;
  readonly etc2: boolean;
  readonly s3tc: boolean;
  readonly bptc: boolean;
  readonly pvrtc: boolean;
  /** At least one GPU format is available; otherwise KTX2 falls back to uncompressed RGBA. */
  readonly any: boolean;
}

export type TextureAssetKind = 'texture' | 'hdr';

/** A standalone texture (2D image, KTX2, or HDR equirect) held in the cache. */
export class TextureAsset implements CachedAsset {
  readonly geometryBytes = 0;
  readonly textureBytes: number;
  private disposed = false;

  constructor(
    readonly url: string,
    readonly kind: TextureAssetKind,
    readonly texture: THREE.Texture,
  ) {
    this.textureBytes = estimateTextureBytes(texture);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.texture.dispose();
  }
}

export type AnyAsset = ModelAsset | TextureAsset;

export interface LoadTextureOptions {
  /** Treat the image as sRGB colour data (default true). Pass false for data maps (normal, roughness, ...). */
  srgb?: boolean | undefined;
}

export interface AssetManagerStats extends AssetCacheStats {
  progress: LoadingSnapshot;
}

/** Signal fed to a three loader; `undefined` when the loader cannot report bytes. */
type ProgressCallback = (event: ProgressEvent) => void;

/**
 * Engine-owned facade over three's loaders. One instance per engine; scenes
 * reach it through `SceneContext.assets`.
 *
 * Every `load*` call takes one reference on the URL (`release(url)` gives it
 * back); repeated requests for the same URL return the same asset object and
 * join an in-flight load instead of fetching twice.
 */
export class AssetManager implements Disposable {
  readonly progress = new LoadingProgress();
  readonly ktx2Support: KTX2Support;
  readonly basisTranscoderPath: string;

  private readonly cache = new AssetCache<AnyAsset>();
  private readonly ktx2: KTX2Loader;
  private readonly log = new Logger('assets');
  private disposed = false;

  constructor(options: AssetManagerOptions) {
    this.basisTranscoderPath = options.basisTranscoderPath ?? '/libs/basis/';
    this.ktx2 = new KTX2Loader().setTranscoderPath(this.basisTranscoderPath).setWorkerLimit(options.ktx2WorkerLimit ?? 4);
    // `detectSupportAsync()` is deprecated in r181+ and logs a console warning,
    // which would fail the clean-console check. The renderer is already
    // initialised (SparkRenderer.create awaits `init()`), so the synchronous
    // form is exactly equivalent here.
    this.ktx2.detectSupport(options.renderer.three);
    this.ktx2Support = readKTX2Support(this.ktx2);
    const s = this.ktx2Support;
    this.log.info(
      `ktx2 transcode targets: astc=${s.astc} bptc=${s.bptc} s3tc=${s.s3tc} etc2=${s.etc2} etc1=${s.etc1} pvrtc=${s.pvrtc} (meshopt decoder ${MeshoptDecoder.supported ? 'wasm' : 'unsupported'})`,
    );
  }

  // ---- loading -------------------------------------------------------------

  /** Load a GLB/glTF (Meshopt + KTX2 aware). Returns the cached `ModelAsset`; call `instantiate()` to place it. */
  loadModel(url: string): Promise<ModelAsset> {
    return this.acquire(url, 'model', (signal) => this.fetchModel(url, signal));
  }

  /** Load a 2D texture. `.ktx2` goes through the Basis transcoder, `.hdr` through the HDR loader. */
  loadTexture(url: string, options: LoadTextureOptions = {}): Promise<TextureAsset> {
    const lower = url.toLowerCase();
    if (lower.endsWith('.hdr')) return this.loadHDR(url);
    if (lower.endsWith('.ktx2')) return this.acquire(url, 'texture', (signal) => this.fetchKTX2(url, signal, options));
    return this.acquire(url, 'texture', (signal) => this.fetchImage(url, signal, options));
  }

  /** Load a Radiance `.hdr` as an equirectangular environment texture (half float). */
  loadHDR(url: string): Promise<TextureAsset> {
    return this.acquire(url, 'hdr', (signal) => this.fetchHDR(url, signal));
  }

  // ---- cache access ---------------------------------------------------------

  /** An already-loaded asset, or undefined. Does not change reference counts. */
  get(url: string): AnyAsset | undefined {
    return this.cache.get(url);
  }

  getModel(url: string): ModelAsset | undefined {
    const asset = this.cache.get(url);
    return asset instanceof ModelAsset ? asset : undefined;
  }

  getTexture(url: string): TextureAsset | undefined {
    const asset = this.cache.get(url);
    return asset instanceof TextureAsset ? asset : undefined;
  }

  has(url: string): boolean {
    return this.cache.has(url);
  }

  isLoading(url: string): boolean {
    return this.cache.isLoading(url);
  }

  refCount(url: string): number {
    return this.cache.refCount(url);
  }

  /** Give back one reference. The asset is disposed (or its load aborted) at zero. */
  release(url: string): boolean {
    return this.cache.release(url);
  }

  /** Dispose everything and abort every in-flight load, ignoring reference counts. */
  releaseAll(): void {
    this.cache.releaseAll();
  }

  stats(): AssetManagerStats {
    return { ...this.cache.stats(), progress: this.progress.snapshot() };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cache.dispose();
    this.ktx2.dispose();
    this.progress.dispose();
    this.log.debug('disposed');
  }

  // ---- internals ------------------------------------------------------------

  private acquire<T extends AnyAsset>(url: string, kind: ModelAsset['kind'] | TextureAssetKind, loader: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('AssetManager: load after dispose'));
    const existing = this.cache.get(url);
    if (existing && existing.kind !== kind) {
      return Promise.reject(new Error(`AssetManager: "${url}" is cached as ${existing.kind}, requested as ${kind}`));
    }
    return this.cache.acquire(url, loader) as Promise<T>;
  }

  private async fetchModel(url: string, signal: AbortSignal): Promise<ModelAsset> {
    const manager = new THREE.LoadingManager();
    const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(this.ktx2);
    const gltf = await this.track<GLTF>(
      url,
      signal,
      (onProgress) => new Promise((resolve, reject) => loader.load(url, resolve, onProgress, (e) => reject(toError(e)))),
      () => manager.abort(),
    );
    const asset = new ModelAsset(url, gltf);
    const i = asset.info;
    this.log.debug(
      `model ${url}: meshes=${i.meshes} tris=${i.triangles} materials=${i.materials} textures=${i.textures} clips=${i.animations} spark-nodes=${asset.sparkNodes.length} collision=${asset.collisionNodes.length}`,
    );
    return asset;
  }

  private async fetchImage(url: string, signal: AbortSignal, options: LoadTextureOptions): Promise<TextureAsset> {
    const manager = new THREE.LoadingManager();
    const loader = new THREE.TextureLoader(manager);
    // ImageLoader has no byte progress and cannot be aborted; an aborted result is disposed by the cache.
    const texture = await this.track<THREE.Texture>(
      url,
      signal,
      () => new Promise((resolve, reject) => loader.load(url, resolve, undefined, (e) => reject(toError(e)))),
      () => manager.abort(),
    );
    texture.colorSpace = options.srgb === false ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
    return new TextureAsset(url, 'texture', texture);
  }

  private async fetchKTX2(url: string, signal: AbortSignal, options: LoadTextureOptions): Promise<TextureAsset> {
    const ktx2 = this.ktx2;
    const texture = await this.track<THREE.CompressedTexture>(
      url,
      signal,
      (onProgress) => new Promise((resolve, reject) => ktx2.load(url, resolve, onProgress, (e) => reject(toError(e)))),
      // KTX2Loader shares the default LoadingManager; aborting it would cancel unrelated loads.
      () => undefined,
    );
    if (options.srgb === false) texture.colorSpace = THREE.LinearSRGBColorSpace;
    return new TextureAsset(url, 'texture', texture);
  }

  private async fetchHDR(url: string, signal: AbortSignal): Promise<TextureAsset> {
    const manager = new THREE.LoadingManager();
    const loader = new HDRLoader(manager);
    const texture = await this.track<THREE.DataTexture>(
      url,
      signal,
      (onProgress) => new Promise((resolve, reject) => loader.load(url, resolve, onProgress, (e) => reject(toError(e)))),
      () => manager.abort(),
    );
    texture.mapping = THREE.EquirectangularReflectionMapping;
    return new TextureAsset(url, 'hdr', texture);
  }

  /** Run one loader call under progress tracking and abort wiring. */
  private async track<T>(url: string, signal: AbortSignal, start: (onProgress: ProgressCallback) => Promise<T>, abort: () => void): Promise<T> {
    this.progress.begin(url);
    const onAbort = (): void => abort();
    signal.addEventListener('abort', onAbort);
    try {
      const value = await start((event) => {
        this.progress.update(url, event.loaded, event.lengthComputable ? event.total : undefined);
      });
      if (signal.aborted) throw new AssetLoadAbortedError(url);
      this.progress.finish(url);
      return value;
    } catch (error) {
      this.progress.fail(url, error);
      if (signal.aborted) throw new AssetLoadAbortedError(url);
      this.log.error(`failed to load ${url}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (value && typeof value === 'object' && 'message' in value) return new Error(String((value as { message: unknown }).message));
  return new Error(String(value));
}

function readKTX2Support(loader: KTX2Loader): KTX2Support {
  const config = (loader as unknown as { workerConfig: Record<string, boolean> | null }).workerConfig ?? {};
  const astc = config.astcSupported === true;
  const etc1 = config.etc1Supported === true;
  const etc2 = config.etc2Supported === true;
  const s3tc = config.dxtSupported === true;
  const bptc = config.bptcSupported === true;
  const pvrtc = config.pvrtcSupported === true;
  return { astc, etc1, etc2, s3tc, bptc, pvrtc, any: astc || etc1 || etc2 || s3tc || bptc || pvrtc };
}
