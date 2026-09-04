/**
 * Tiny HUD building blocks. Plain DOM, styled by the injected stylesheet.
 * Deliberately minimal: game UI is built in the app; these are the shared
 * bits every HUD needs.
 */
export interface BarHandle {
  readonly element: HTMLElement;
  /** 0..1. */
  set(value: number): void;
  setLabel(text: string): void;
  get(): number;
}

export interface BarOptions {
  readonly label: string;
  /** Any CSS color. Default: the accent variable. */
  readonly color?: string | undefined;
  /** Render the numeric value (percent). Default true. */
  readonly showValue?: boolean | undefined;
}

export function createBar(options: BarOptions): BarHandle {
  const element = document.createElement('div');
  element.className = 'spark-bar';
  const label = document.createElement('div');
  label.className = 'spark-bar-label';
  label.textContent = options.label;
  const track = document.createElement('div');
  track.className = 'spark-bar-track';
  const fill = document.createElement('div');
  fill.className = 'spark-bar-fill';
  if (options.color) fill.style.setProperty('--spark-bar-color', options.color);
  track.appendChild(fill);
  const valueEl = document.createElement('div');
  valueEl.className = 'spark-bar-value';
  element.append(label, track, valueEl);
  const showValue = options.showValue ?? true;
  let current = -1;
  const handle: BarHandle = {
    element,
    set(value) {
      const v = value < 0 ? 0 : value > 1 ? 1 : Number.isFinite(value) ? value : 0;
      if (v === current) return;
      current = v;
      fill.style.transform = `scaleX(${v.toFixed(4)})`;
      if (showValue) valueEl.textContent = `${Math.round(v * 100)}%`;
    },
    setLabel(text) {
      label.textContent = text;
    },
    get: () => Math.max(0, current),
  };
  handle.set(1);
  return handle;
}

export interface TextHandle {
  readonly element: HTMLElement;
  set(text: string): void;
}

export function createText(text = '', options: { dim?: boolean | undefined } = {}): TextHandle {
  const element = document.createElement('div');
  element.className = 'spark-text';
  if (options.dim) element.setAttribute('data-dim', '');
  let current: string | null = null;
  const handle: TextHandle = {
    element,
    set(next) {
      if (next === current) return;
      current = next;
      element.textContent = next;
    },
  };
  handle.set(text);
  return handle;
}

export type PanelAnchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';

export interface PanelHandle {
  readonly element: HTMLElement;
  add(...children: Array<HTMLElement | { element: HTMLElement }>): PanelHandle;
}

export function createPanel(options: { title?: string | undefined; anchor?: PanelAnchor | undefined; className?: string | undefined } = {}): PanelHandle {
  const element = document.createElement('div');
  element.className = options.className ? `spark-panel ${options.className}` : 'spark-panel';
  element.setAttribute('data-anchor', options.anchor ?? 'top-left');
  if (options.title) {
    const title = document.createElement('div');
    title.className = 'spark-panel-title';
    title.textContent = options.title;
    element.appendChild(title);
  }
  const handle: PanelHandle = {
    element,
    add(...children) {
      for (const child of children) element.appendChild(child instanceof HTMLElement ? child : child.element);
      return handle;
    },
  };
  return handle;
}

/** A clickable row for menus. Pointer events reach it only on a capturing layer. */
export function createMenuItem(label: string, onSelect: () => void): HTMLElement {
  const item = document.createElement('div');
  item.className = 'spark-menu-item';
  item.textContent = label;
  item.addEventListener('click', onSelect);
  return item;
}
