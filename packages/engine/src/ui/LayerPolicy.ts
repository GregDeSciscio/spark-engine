/**
 * Layer stack + pointer-capture policy as a pure state machine. `UIHost`
 * mirrors it into the DOM and into `Input.setCaptured()`.
 */
export const LAYER_NAMES = ['world', 'hud', 'menu', 'modal'] as const;
export type LayerName = (typeof LAYER_NAMES)[number];

export interface UILayerSpec {
  /** Stacking order within the overlay root (higher on top). */
  readonly z: number;
  /** Captures pointer events and, while visible, tells `Input` to drop game input. */
  readonly capture: boolean;
  readonly defaultVisible: boolean;
}

export const LAYER_SPECS: Readonly<Record<LayerName, UILayerSpec>> = {
  world: { z: 1, capture: false, defaultVisible: true },
  hud: { z: 2, capture: false, defaultVisible: true },
  menu: { z: 3, capture: true, defaultVisible: false },
  modal: { z: 4, capture: true, defaultVisible: false },
};

export function isLayerName(value: string): value is LayerName {
  return (LAYER_NAMES as readonly string[]).includes(value);
}

export class LayerPolicy {
  private readonly visible = new Map<LayerName, boolean>();
  private captureListener: ((captured: boolean) => void) | null = null;
  private lastCaptured = false;

  constructor() {
    for (const name of LAYER_NAMES) this.visible.set(name, LAYER_SPECS[name].defaultVisible);
  }

  /** Called whenever the "any capturing layer visible" answer changes. */
  onCaptureChange(listener: ((captured: boolean) => void) | null): void {
    this.captureListener = listener;
  }

  isVisible(name: LayerName): boolean {
    return this.visible.get(name) ?? false;
  }

  setVisible(name: LayerName, visible: boolean): boolean {
    if (!isLayerName(name)) throw new Error(`UIHost: unknown layer "${String(name)}"`);
    const before = this.visible.get(name);
    if (before === visible) return false;
    this.visible.set(name, visible);
    this.notify();
    return true;
  }

  show(name: LayerName): boolean {
    return this.setVisible(name, true);
  }

  hide(name: LayerName): boolean {
    return this.setVisible(name, false);
  }

  toggle(name: LayerName): boolean {
    const next = !this.isVisible(name);
    this.setVisible(name, next);
    return next;
  }

  /** Any capturing layer is visible: the DOM owns the pointer and game input is dropped. */
  get captured(): boolean {
    for (const name of LAYER_NAMES) if (LAYER_SPECS[name].capture && this.isVisible(name)) return true;
    return false;
  }

  /** The topmost visible capturing layer, if any. */
  topCapturing(): LayerName | null {
    let top: LayerName | null = null;
    for (const name of LAYER_NAMES) {
      if (LAYER_SPECS[name].capture && this.isVisible(name) && (top === null || LAYER_SPECS[name].z > LAYER_SPECS[top].z)) top = name;
    }
    return top;
  }

  private notify(): void {
    const now = this.captured;
    if (now === this.lastCaptured) return;
    this.lastCaptured = now;
    this.captureListener?.(now);
  }
}
