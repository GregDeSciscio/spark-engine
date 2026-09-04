import type { DebugSnapshot } from './DebugStats';
import type { PostEffectState } from '../rendering/RenderPipeline';

/**
 * The pure part of the engine inspector: everything the panels display is
 * computed here from plain data, so it is unit-testable without a DOM, a
 * renderer, or three's Inspector addon (`Inspector.ts` only paints it).
 */

export interface SystemTiming {
  readonly name: string;
  readonly ms: number;
}

/** The `n` slowest systems from the registry's last timings, slowest first; ties by name. */
export function topSystems(timings: ReadonlyMap<string, number> | Readonly<Record<string, number>>, n: number): SystemTiming[] {
  const entries: SystemTiming[] = [];
  const iterable: Iterable<[string, number]> = timings instanceof Map ? timings : Object.entries(timings);
  for (const [name, ms] of iterable) entries.push({ name, ms });
  entries.sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name));
  return entries.slice(0, Math.max(0, n));
}

export interface ComponentCount {
  readonly name: string;
  readonly count: number;
}

/** Most-populated component first; ties by name so the list is stable frame to frame. */
export function sortComponentCounts(counts: readonly ComponentCount[]): ComponentCount[] {
  return [...counts].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'n/a';
  return `${ms.toFixed(2)} ms`;
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export type LabelValue = readonly [label: string, value: string];

export interface EngineRowsInput {
  readonly state: string;
  readonly fixedStepHz: number;
  readonly adapter: string | null;
}

/** The Engine panel's read-only rows. Null snapshot = before the first frame. */
export function engineRows(snapshot: DebugSnapshot | null, input: EngineRowsInput): LabelValue[] {
  const rows: LabelValue[] = [
    ['State', input.state],
    ['Backend', snapshot ? snapshot.backend.toUpperCase() : '-'],
    ['Adapter', input.adapter ?? 'n/a'],
    ['Fixed step', `${input.fixedStepHz} Hz`],
  ];
  if (!snapshot) return rows;
  rows.push(
    ['Frame', String(snapshot.frame)],
    ['FPS', snapshot.fps.toFixed(0)],
    ['Frame time', formatMs(snapshot.fps > 0 ? 1000 / snapshot.fps : null)],
    ['CPU', formatMs(snapshot.cpuMs)],
    ['Render', formatMs(snapshot.renderMs)],
    ['GPU', formatMs(snapshot.gpuMs)],
    ['Draw calls', String(snapshot.drawCalls)],
    ['Triangles', formatCount(snapshot.triangles)],
    ['Fixed steps', String(snapshot.fixedSteps)],
    [
      'Resolution',
      snapshot.sceneWidth && snapshot.sceneWidth !== snapshot.width
        ? `${snapshot.width}x${snapshot.height} (${snapshot.sceneWidth}x${snapshot.sceneHeight})`
        : `${snapshot.width}x${snapshot.height}`,
    ],
    ['Post', snapshot.postEffects.length ? snapshot.postEffects.join(' ') : 'none'],
  );
  return rows;
}

export interface PostRow {
  readonly name: string;
  readonly enabled: boolean;
  readonly available: boolean;
  /** Human label: the effect name plus why it cannot run, if it cannot. */
  readonly label: string;
}

export function postRows(effects: readonly PostEffectState[]): PostRow[] {
  return effects.map((e) => ({
    name: e.name,
    enabled: e.enabled,
    available: e.available,
    label: e.available ? e.name : `${e.name} (unavailable)`,
  }));
}

/** Options for the debug-view select: 'none' first, then whatever the pipeline can show. */
export function debugViewOptions(available: readonly string[]): string[] {
  return ['none', ...available];
}

/**
 * Bounding-sphere outline: three axis-aligned great circles as line segments.
 * Writes `segments * 3 * 2` vertices (x, y, z each) into `out` at `offset`
 * and returns the new offset. Pure so the line-pool layout is testable.
 */
export function sphereOutline(cx: number, cy: number, cz: number, radius: number, segments: number, out: Float32Array, offset: number): number {
  let o = offset;
  const step = (Math.PI * 2) / segments;
  for (let axis = 0; axis < 3; axis++) {
    for (let i = 0; i < segments; i++) {
      const a0 = i * step;
      const a1 = (i + 1) * step;
      const c0 = Math.cos(a0) * radius;
      const s0 = Math.sin(a0) * radius;
      const c1 = Math.cos(a1) * radius;
      const s1 = Math.sin(a1) * radius;
      if (axis === 0) {
        // Ring in the YZ plane.
        out[o++] = cx;
        out[o++] = cy + c0;
        out[o++] = cz + s0;
        out[o++] = cx;
        out[o++] = cy + c1;
        out[o++] = cz + s1;
      } else if (axis === 1) {
        // Ring in the XZ plane.
        out[o++] = cx + c0;
        out[o++] = cy;
        out[o++] = cz + s0;
        out[o++] = cx + c1;
        out[o++] = cy;
        out[o++] = cz + s1;
      } else {
        // Ring in the XY plane.
        out[o++] = cx + c0;
        out[o++] = cy + s0;
        out[o++] = cz;
        out[o++] = cx + c1;
        out[o++] = cy + s1;
        out[o++] = cz;
      }
    }
  }
  return o;
}

/** Floats one `sphereOutline` writes. */
export function sphereOutlineFloats(segments: number): number {
  return segments * 3 * 2 * 3;
}

export interface SceneCounts {
  objects: number;
  meshes: number;
  lights: number;
  /** Sum of index or position counts / 3 over meshes with geometry; instanced meshes count once per instance. */
  triangles: number;
}

export interface CountableObject {
  readonly children: readonly CountableObject[];
  readonly isMesh?: boolean;
  readonly isLight?: boolean;
  readonly isInstancedMesh?: boolean;
  readonly count?: number;
  readonly geometry?: { readonly index: { readonly count: number } | null; readonly attributes: { readonly position?: { readonly count: number } } } | undefined;
}

/** Walk a three-like hierarchy and count what the Scene panel summarises. */
export function countScene(root: CountableObject): SceneCounts {
  const counts: SceneCounts = { objects: 0, meshes: 0, lights: 0, triangles: 0 };
  const walk = (o: CountableObject): void => {
    counts.objects++;
    if (o.isLight) counts.lights++;
    if (o.isMesh) {
      counts.meshes++;
      const g = o.geometry;
      if (g) {
        const vertices = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
        const instances = o.isInstancedMesh ? (o.count ?? 1) : 1;
        counts.triangles += Math.floor(vertices / 3) * instances;
      }
    }
    for (const child of o.children) walk(child);
  };
  walk(root);
  return counts;
}

/**
 * Inspector UI state that does not depend on the DOM: which overlays are on,
 * which buffer view is shown, which entity is selected. Toggles are explicit
 * so a panel and a hotkey cannot disagree about the state.
 */
export class InspectorState {
  debugView: string = 'none';
  colliders = false;
  bounds = false;
  selected: number | null = null;

  /** Apply a select value; unknown names fall back to 'none'. Returns the resolved view (null = normal image). */
  setDebugView(name: string, available: readonly string[]): string | null {
    this.debugView = available.includes(name) ? name : 'none';
    return this.debugView === 'none' ? null : this.debugView;
  }
}
