import { Transform } from '../ecs/components/Transform';
import type { Entity, EntityWorld } from '../ecs/EntityWorld';
import { SideTable } from '../ecs/SideTable';
import type { System } from '../ecs/System';
import { LabelPool } from './LabelPool';
import { createProjectedPoint, distanceScale, type ProjectedPoint } from './Projection';

export type LabelKind = 'healthbar' | 'text';

export interface LabelOptions {
  readonly kind: LabelKind;
  /** Name above a health bar, or the text of a text label. */
  readonly text?: string | undefined;
  /** Fill / text color. Default: the theme health / foreground color. */
  readonly color?: string | undefined;
  /** World units above the entity's Transform. Default 2. */
  readonly offsetY?: number | undefined;
  /** Hide beyond this view depth. Default: the system's `maxDistance`. */
  readonly maxDistance?: number | undefined;
  /** Shrink with distance (default: the system's setting). */
  readonly scaleWithDistance?: boolean | undefined;
}

export interface PopupOptions {
  /** Seconds on screen. Default 1. */
  readonly life?: number | undefined;
  readonly color?: string | undefined;
  /** World units risen over the lifetime. Default 1. */
  readonly rise?: number | undefined;
  /** Font size in px. Default 16. */
  readonly size?: number | undefined;
}

export interface WorldLabelsOptions {
  /** Hard pool cap: DOM nodes ever created. Default 256. */
  readonly capacity?: number | undefined;
  /** Default hide distance (view depth, world units). Default 40. */
  readonly maxDistance?: number | undefined;
  /** Depth at which scale is 1. Default 8. */
  readonly referenceDistance?: number | undefined;
  readonly scaleWithDistance?: boolean | undefined;
}

export interface WorldLabelsStats {
  readonly active: number;
  readonly visible: number;
  readonly popups: number;
  readonly capacity: number;
  readonly nodes: number;
  readonly refused: number;
}

/** What the label system needs from the host: a parent for its nodes and a per-frame projector. */
export interface LabelHost {
  readonly worldLayer: HTMLElement;
  /** Prepare the cached view-projection for this frame. */
  beginProjection(): boolean;
  projectCached(x: number, y: number, z: number, out: ProjectedPoint): ProjectedPoint;
}

interface Slot {
  readonly element: HTMLElement;
  kind: LabelKind | 'popup' | null;
  fill: HTMLElement | null;
  textEl: HTMLElement | null;
  eid: Entity;
  x: number;
  y: number;
  z: number;
  offsetY: number;
  maxDistance: number;
  scale: boolean;
  /** Popups only. */
  life: number;
  age: number;
  rise: number;
  shown: boolean;
  lastX: number;
  lastY: number;
  lastScale: number;
  value: number;
}

/**
 * Pooled DOM labels anchored to entities or world positions: health bars,
 * names, damage numbers. A `late` system after RenderSync projects each label
 * through the host's cached camera, hides those behind the camera or beyond
 * their distance, and scales by depth. Hard-capped; slots are reused.
 */
export class WorldLabels implements System {
  readonly name = 'WorldLabels';
  readonly stage = 'late' as const;
  readonly order = 1200;

  private readonly pool: LabelPool;
  private readonly slots: Slot[] = [];
  private readonly byEntity: SideTable<number>;
  private readonly maxDistance: number;
  private readonly referenceDistance: number;
  private readonly scaleByDefault: boolean;
  private readonly projected = createProjectedPoint();
  private readonly entities: EntityWorld;
  private visibleCount = 0;
  private popupCount = 0;
  private disposed = false;

  constructor(
    private readonly host: LabelHost,
    entities: EntityWorld,
    options: WorldLabelsOptions = {},
  ) {
    this.pool = new LabelPool(options.capacity ?? 256);
    this.maxDistance = options.maxDistance ?? 40;
    this.referenceDistance = options.referenceDistance ?? 8;
    this.scaleByDefault = options.scaleWithDistance ?? true;
    this.entities = entities;
    this.byEntity = new SideTable<number>(entities, (index) => this.releaseSlot(index));
  }

  // ---- entity labels -------------------------------------------------------

  /** Bind a label to an entity (replacing any existing one). False when the pool is full. */
  attach(eid: Entity, options: LabelOptions): boolean {
    this.byEntity.delete(eid);
    const index = this.acquireSlot(options.kind);
    if (index === -1) return false;
    const slot = this.slots[index] as Slot;
    slot.eid = eid;
    slot.offsetY = options.offsetY ?? 2;
    slot.maxDistance = options.maxDistance ?? this.maxDistance;
    slot.scale = options.scaleWithDistance ?? this.scaleByDefault;
    if (options.kind === 'healthbar') {
      if (slot.textEl) slot.textEl.textContent = options.text ?? '';
      if (slot.fill) slot.fill.style.background = options.color ?? '';
      this.setSlotValue(slot, 1);
    } else {
      if (slot.textEl) {
        slot.textEl.textContent = options.text ?? '';
        slot.textEl.style.color = options.color ?? '';
      }
    }
    this.byEntity.set(eid, index);
    return true;
  }

  detach(eid: Entity): boolean {
    return this.byEntity.delete(eid);
  }

  has(eid: Entity): boolean {
    return this.byEntity.has(eid);
  }

  /** Health-bar fill, 0..1. */
  setValue(eid: Entity, value: number): void {
    const index = this.byEntity.get(eid);
    if (index === undefined) return;
    this.setSlotValue(this.slots[index] as Slot, value);
  }

  setText(eid: Entity, text: string): void {
    const index = this.byEntity.get(eid);
    if (index === undefined) return;
    const slot = this.slots[index] as Slot;
    if (slot.textEl && slot.textEl.textContent !== text) slot.textEl.textContent = text;
  }

  // ---- popups ----------------------------------------------------------------

  /** A rising, fading number/text at a world position or above an entity. False when the pool is full. */
  popup(target: Entity | { x: number; y: number; z: number }, text: string, options: PopupOptions = {}): boolean {
    const index = this.acquireSlot('popup');
    if (index === -1) return false;
    const slot = this.slots[index] as Slot;
    slot.eid = -1;
    if (typeof target === 'number') {
      const t = this.entities.store(Transform);
      slot.x = t.x[target] ?? 0;
      slot.y = (t.y[target] ?? 0) + 2;
      slot.z = t.z[target] ?? 0;
    } else {
      slot.x = target.x;
      slot.y = target.y;
      slot.z = target.z;
    }
    slot.life = Math.max(0.05, options.life ?? 1);
    slot.age = 0;
    slot.rise = options.rise ?? 1;
    slot.scale = this.scaleByDefault;
    slot.maxDistance = this.maxDistance;
    const el = slot.element;
    el.textContent = text;
    el.style.color = options.color ?? '';
    el.style.fontSize = options.size ? `${options.size}px` : '';
    el.style.animationDuration = `${slot.life}s`;
    // Restart the CSS animation on a reused node.
    el.style.animationName = 'none';
    void el.offsetWidth;
    el.style.animationName = '';
    this.popupCount += 1;
    return true;
  }

  // ---- per frame ---------------------------------------------------------------

  run(world: EntityWorld, dt: number): void {
    if (this.disposed) return;
    const ready = this.host.beginProjection();
    const t = world.store(Transform);
    const p = this.projected;
    let visible = 0;
    // Deleting from a Set while iterating it is safe; nothing is added during the walk.
    for (const index of this.pool.entries()) {
      const slot = this.slots[index] as Slot;
      if (slot.kind === 'popup') {
        slot.age += dt;
        if (slot.age >= slot.life) {
          this.releaseSlot(index);
          continue;
        }
      } else {
        const eid = slot.eid;
        if (!world.exists(eid)) {
          this.byEntity.delete(eid);
          continue;
        }
        slot.x = t.x[eid] ?? 0;
        slot.y = (t.y[eid] ?? 0) + slot.offsetY;
        slot.z = t.z[eid] ?? 0;
      }
      if (!ready) {
        this.setShown(slot, false);
        continue;
      }
      const y = slot.kind === 'popup' ? slot.y + slot.rise * (slot.age / slot.life) : slot.y;
      this.host.projectCached(slot.x, y, slot.z, p);
      const show = p.visible && p.depth <= slot.maxDistance;
      this.setShown(slot, show);
      if (!show) continue;
      visible += 1;
      const s = slot.scale ? distanceScale(p.depth, this.referenceDistance) : 1;
      const x = Math.round(p.x);
      const py = Math.round(p.y);
      const sr = Math.round(s * 100) / 100;
      if (x !== slot.lastX || py !== slot.lastY || sr !== slot.lastScale) {
        slot.lastX = x;
        slot.lastY = py;
        slot.lastScale = sr;
        slot.element.style.transform = `translate(-50%, -100%) translate3d(${x}px, ${py}px, 0) scale(${sr})`;
      }
    }
    this.visibleCount = visible;
  }

  stats(): WorldLabelsStats {
    return {
      active: this.pool.active,
      visible: this.visibleCount,
      popups: this.popupCount,
      capacity: this.pool.capacity,
      nodes: this.pool.highWater,
      refused: this.pool.refused,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.byEntity.dispose();
    for (const slot of this.slots) slot.element.remove();
    this.slots.length = 0;
    this.pool.clear();
  }

  // ---- slots ---------------------------------------------------------------------

  private acquireSlot(kind: LabelKind | 'popup'): number {
    const index = this.pool.acquire();
    if (index === -1) return -1;
    let slot = this.slots[index];
    if (!slot) {
      const element = document.createElement('div');
      element.hidden = true;
      this.host.worldLayer.appendChild(element);
      slot = {
        element,
        kind: null,
        fill: null,
        textEl: null,
        eid: -1,
        x: 0,
        y: 0,
        z: 0,
        offsetY: 0,
        maxDistance: this.maxDistance,
        scale: true,
        life: 0,
        age: 0,
        rise: 0,
        shown: false,
        lastX: Number.NaN,
        lastY: Number.NaN,
        lastScale: Number.NaN,
        value: -1,
      };
      this.slots[index] = slot;
    }
    if (slot.kind !== kind) this.buildSlot(slot, kind);
    slot.lastX = slot.lastY = slot.lastScale = Number.NaN;
    return index;
  }

  /** Rebuild a node's children for a new kind (only when the kind changes, so churn of one kind is free). */
  private buildSlot(slot: Slot, kind: LabelKind | 'popup'): void {
    const el = slot.element;
    el.replaceChildren();
    el.style.cssText = '';
    slot.fill = null;
    slot.textEl = null;
    slot.value = -1;
    slot.kind = kind;
    if (kind === 'healthbar') {
      el.className = 'spark-label';
      const name = document.createElement('div');
      name.className = 'spark-label-name';
      const track = document.createElement('div');
      track.className = 'spark-label-track';
      const fill = document.createElement('div');
      fill.className = 'spark-label-fill';
      track.appendChild(fill);
      el.append(name, track);
      slot.textEl = name;
      slot.fill = fill;
    } else if (kind === 'text') {
      el.className = 'spark-label';
      const text = document.createElement('div');
      text.className = 'spark-label-text';
      el.appendChild(text);
      slot.textEl = text;
    } else {
      el.className = 'spark-label spark-popup';
    }
  }

  private releaseSlot(index: number): void {
    const slot = this.slots[index];
    if (!slot || !this.pool.release(index)) return;
    if (slot.kind === 'popup') this.popupCount = Math.max(0, this.popupCount - 1);
    this.setShown(slot, false);
    slot.eid = -1;
  }

  private setShown(slot: Slot, shown: boolean): void {
    if (slot.shown === shown) return;
    slot.shown = shown;
    slot.element.hidden = !shown;
  }

  private setSlotValue(slot: Slot, value: number): void {
    const v = value < 0 ? 0 : value > 1 ? 1 : Number.isFinite(value) ? value : 0;
    if (v === slot.value || !slot.fill) return;
    slot.value = v;
    slot.fill.style.transform = `scaleX(${v.toFixed(3)})`;
  }
}
