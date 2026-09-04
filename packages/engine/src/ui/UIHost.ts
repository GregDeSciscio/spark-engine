import type * as THREE from 'three/webgpu';
import type { Disposable } from '../core/Disposable';
import { Transform } from '../ecs/components/Transform';
import type { Entity, EntityWorld } from '../ecs/EntityWorld';
import type { System } from '../ecs/System';
import { LAYER_NAMES, LAYER_SPECS, LayerPolicy, type LayerName } from './LayerPolicy';
import { createProjectedPoint, multiplyMatrices, projectPoint, type ProjectedPoint } from './Projection';
import { UI_THEME_DEFAULTS, ensureStylesheet } from './styles';
import { WorldLabels, type LabelHost, type WorldLabelsOptions } from './WorldLabels';

export interface UIHostOptions {
  /** The engine container; the overlay root is appended to it. */
  readonly container: HTMLElement;
  /** Source of the viewport size in CSS pixels. */
  readonly renderer: { readonly size: { readonly width: number; readonly height: number } };
  readonly entities: EntityWorld;
  /** Told to drop game input while a capturing layer is visible. */
  readonly input?: { setCaptured(captured: boolean): void } | undefined;
  /** Fallback camera when a scene has not called `setCamera()`. */
  readonly camera?: (() => THREE.Camera | null) | undefined;
  /** Root z-index. Default 100 (DebugStats sits at 1000). */
  readonly zIndex?: number | undefined;
  readonly labels?: WorldLabelsOptions | undefined;
}

export interface UIHostStats {
  readonly layers: Readonly<Record<LayerName, { visible: boolean; children: number }>>;
  readonly captured: boolean;
  readonly labels: ReturnType<WorldLabels['stats']>;
}

/**
 * The DOM overlay host (`engine.ui`). One root above the canvas, four stacked
 * layers (`world` < `hud` < `menu` < `modal`), a capture policy that hands
 * the pointer and keyboard to the DOM while a menu/modal is open, a world →
 * screen projector, and the pooled world-space labels. Theme through CSS
 * variables on the root (`setTheme`).
 */
export class UIHost implements Disposable, LabelHost {
  readonly root: HTMLElement;
  readonly labels: WorldLabels;

  private readonly layers = new Map<LayerName, HTMLElement>();
  private readonly policy = new LayerPolicy();
  private readonly renderer: UIHostOptions['renderer'];
  private readonly input: UIHostOptions['input'];
  private readonly cameraProvider: () => THREE.Camera | null;
  private camera: THREE.Camera | null = null;
  private readonly viewProj = new Float32Array(16);
  private viewProjValid = false;
  private readonly scratch = createProjectedPoint();
  private entities: EntityWorld;
  private disposed = false;

  constructor(options: UIHostOptions) {
    ensureStylesheet(options.container.ownerDocument);
    this.renderer = options.renderer;
    this.input = options.input;
    this.entities = options.entities;
    this.cameraProvider = options.camera ?? (() => null);
    const root = document.createElement('div');
    root.className = 'spark-ui-root';
    root.setAttribute('data-spark-ui', '');
    root.style.zIndex = String(options.zIndex ?? 100);
    for (const [key, value] of Object.entries(UI_THEME_DEFAULTS)) root.style.setProperty(key, value);
    for (const name of LAYER_NAMES) {
      const spec = LAYER_SPECS[name];
      const layer = document.createElement('div');
      layer.className = 'spark-ui-layer';
      layer.setAttribute('data-layer', name);
      layer.style.zIndex = String(spec.z);
      if (spec.capture) layer.setAttribute('data-capture', '');
      layer.hidden = !spec.defaultVisible;
      root.appendChild(layer);
      this.layers.set(name, layer);
    }
    options.container.appendChild(root);
    this.root = root;
    this.policy.onCaptureChange((captured) => this.input?.setCaptured(captured));
    this.labels = new WorldLabels(this, options.entities, options.labels);
  }

  // ---- layers ------------------------------------------------------------------

  layer(name: LayerName): HTMLElement {
    const el = this.layers.get(name);
    if (!el) throw new Error(`UIHost: unknown layer "${String(name)}"`);
    return el;
  }

  get worldLayer(): HTMLElement {
    return this.layer('world');
  }

  mount(name: LayerName, element: HTMLElement | { element: HTMLElement }): HTMLElement {
    const el = element instanceof HTMLElement ? element : element.element;
    this.layer(name).appendChild(el);
    return el;
  }

  unmount(element: HTMLElement | { element: HTMLElement }): void {
    const el = element instanceof HTMLElement ? element : element.element;
    if (el.parentElement && this.root.contains(el)) el.remove();
  }

  show(name: LayerName): void {
    if (this.policy.show(name)) this.layer(name).hidden = false;
  }

  hide(name: LayerName): void {
    if (this.policy.hide(name)) this.layer(name).hidden = true;
  }

  /** Returns the new visibility. */
  toggle(name: LayerName): boolean {
    const visible = this.policy.toggle(name);
    this.layer(name).hidden = !visible;
    return visible;
  }

  isVisible(name: LayerName): boolean {
    return this.policy.isVisible(name);
  }

  /** True while a menu/modal layer owns the pointer and game input is dropped. */
  get captured(): boolean {
    return this.policy.captured;
  }

  /** Override theme variables (`--spark-ui-accent`, …) on the root. */
  setTheme(vars: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(vars)) this.root.style.setProperty(key, value);
  }

  // ---- projection ----------------------------------------------------------------

  /** The camera `project()` and the labels use. Scenes with a rig set it; otherwise the live scene camera. */
  setCamera(camera: THREE.Camera | null): void {
    this.camera = camera;
    this.viewProjValid = false;
  }

  /** Recompute the cached view-projection. Returns false when there is no camera. */
  beginProjection(): boolean {
    const camera = this.camera ?? this.cameraProvider();
    if (!camera) {
      this.viewProjValid = false;
      return false;
    }
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    multiplyMatrices(camera.projectionMatrix.elements, camera.matrixWorldInverse.elements, this.viewProj);
    this.viewProjValid = true;
    return true;
  }

  /** Project through the matrix cached by `beginProjection()` (the labels system's path). */
  projectCached(x: number, y: number, z: number, out: ProjectedPoint): ProjectedPoint {
    if (!this.viewProjValid) {
      out.visible = false;
      out.depth = 0;
      out.x = out.y = 0;
      return out;
    }
    const size = this.renderer.size;
    return projectPoint(this.viewProj, size.width, size.height, x, y, z, out);
  }

  /**
   * World position (or an entity's Transform) → overlay CSS pixels, using the
   * camera as it is right now. Allocation-free when `out` is supplied.
   */
  project(target: Entity | { x: number; y: number; z: number }, out: ProjectedPoint = this.scratch): ProjectedPoint {
    if (!this.beginProjection()) {
      out.visible = false;
      out.depth = 0;
      out.x = out.y = 0;
      return out;
    }
    let x: number;
    let y: number;
    let z: number;
    if (typeof target === 'number') {
      const world = this.entities;
      if (!world.exists(target) || !world.has(target, Transform)) {
        out.visible = false;
        out.depth = 0;
        out.x = out.y = 0;
        return out;
      }
      const t = world.store(Transform);
      x = t.x[target] ?? 0;
      y = t.y[target] ?? 0;
      z = t.z[target] ?? 0;
    } else {
      x = target.x;
      y = target.y;
      z = target.z;
    }
    return this.projectCached(x, y, z, out);
  }

  /** Systems the engine registers: the world-label updater (late, after RenderSync). */
  createSystems(): readonly System[] {
    return [this.labels];
  }

  stats(): UIHostStats {
    const layers = Object.fromEntries(
      LAYER_NAMES.map((name) => [name, { visible: this.policy.isVisible(name), children: this.layer(name).childElementCount }]),
    ) as Record<LayerName, { visible: boolean; children: number }>;
    return { layers, captured: this.policy.captured, labels: this.labels.stats() };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.labels.dispose();
    for (const name of LAYER_NAMES) this.policy.hide(name);
    this.input?.setCaptured(false);
    this.root.remove();
    this.layers.clear();
  }
}
