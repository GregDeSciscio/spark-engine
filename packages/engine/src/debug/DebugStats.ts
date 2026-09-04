import type { Disposable } from '../core/Disposable';
import type { LightingStats } from '../rendering/LightingSystem';
import type { RenderFrameStats } from '../rendering/Renderer';

export interface DebugSnapshot {
  backend: string;
  preset: string;
  fps: number;
  /** Whole-frame main-thread time (input → render), averaged. */
  cpuMs: number;
  /** The render call alone, averaged. */
  renderMs: number;
  /** Simulation (fixed + update + late systems) wall time this frame, ms, per system. */
  systems: Record<string, number>;
  gpuMs: number | null;
  width: number;
  height: number;
  pixelRatio: number;
  renderScale: number;
  /** Internal scene-pass size (drawing buffer × renderScale). */
  sceneWidth: number;
  sceneHeight: number;
  /** Post effects actually rendering, in graph order. */
  postEffects: string[];
  /** GPU pipelines / shader programs created so far (each new one is a compile; see docs/performance/cold-start.md). */
  pipelines: number;
  programs: number;
  drawCalls: number;
  triangles: number;
  fixedSteps: number;
  frame: number;
  elapsed: number;
  /** Light budget / clustered lighting counts (`LightingSystem.getStats`), null before a scene is lit. */
  lights: LightingStats | null;
}

export interface DebugStatsSource {
  backend: string;
  preset: string;
  frame: number;
  elapsed: number;
  cpuMs: number;
  renderMs: number;
  systemMs: ReadonlyMap<string, number>;
  fixedSteps: number;
  render: RenderFrameStats;
  lights?: LightingStats | undefined;
}

/**
 * The always-on developer overlay. Reads a snapshot each frame, averages over
 * a short window, and repaints the DOM at a fixed cadence so the overlay itself
 * does not become a frame-time cost.
 */
export class DebugStats implements Disposable {
  private readonly root: HTMLElement;
  private readonly lines = new Map<string, HTMLElement>();
  private frameTimes: number[] = [];
  private cpuTimes: number[] = [];
  private renderTimes: number[] = [];
  private lastPaint = 0;
  private lastFrameTime: number | null = null;
  private latest: DebugSnapshot | null = null;
  private visible: boolean;

  constructor(container: HTMLElement, visible = true) {
    this.visible = visible;
    this.root = document.createElement('div');
    this.root.setAttribute('data-spark-debug', '');
    Object.assign(this.root.style, {
      position: 'absolute',
      top: '8px',
      left: '8px',
      padding: '8px 10px',
      background: 'rgba(0,0,0,0.6)',
      color: '#d8e4ff',
      font: '12px/1.45 ui-monospace, Menlo, Consolas, monospace',
      borderRadius: '4px',
      pointerEvents: 'none',
      zIndex: '1000',
      whiteSpace: 'pre',
      display: visible ? 'block' : 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    container.appendChild(this.root);
    for (const key of [
      'Renderer',
      'FPS',
      'Frame',
      'CPU',
      'Render',
      'Systems',
      'GPU',
      'Resolution',
      'Pixel Ratio',
      'Scale',
      'Draw Calls',
      'Triangles',
      'Fixed Steps',
      'Preset',
      'Post',
      'Pipelines',
      'Lights',
    ]) {
      const el = document.createElement('div');
      this.lines.set(key, el);
      this.root.appendChild(el);
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.style.display = visible ? 'block' : 'none';
  }

  /** Call once per frame with the wall-clock time and the frame's stats. */
  update(nowMs: number, source: DebugStatsSource): void {
    if (this.lastFrameTime !== null) {
      this.frameTimes.push(nowMs - this.lastFrameTime);
      if (this.frameTimes.length > 60) this.frameTimes.shift();
    }
    this.lastFrameTime = nowMs;
    this.cpuTimes.push(source.cpuMs);
    if (this.cpuTimes.length > 60) this.cpuTimes.shift();
    this.renderTimes.push(source.renderMs);
    if (this.renderTimes.length > 60) this.renderTimes.shift();
    const systems: Record<string, number> = {};
    for (const [name, ms] of source.systemMs) systems[name] = ms;

    const avgFrame = average(this.frameTimes);
    this.latest = {
      backend: source.backend,
      preset: source.preset,
      fps: avgFrame > 0 ? 1000 / avgFrame : 0,
      cpuMs: average(this.cpuTimes),
      renderMs: average(this.renderTimes),
      systems,
      gpuMs: source.render.gpuMs,
      width: source.render.width,
      height: source.render.height,
      pixelRatio: source.render.pixelRatio,
      renderScale: source.render.renderScale,
      sceneWidth: source.render.sceneWidth,
      sceneHeight: source.render.sceneHeight,
      postEffects: source.render.postEffects,
      pipelines: source.render.pipelines,
      programs: source.render.programs,
      drawCalls: source.render.drawCalls,
      triangles: source.render.triangles,
      fixedSteps: source.fixedSteps,
      frame: source.frame,
      elapsed: source.elapsed,
      lights: source.lights ?? null,
    };

    if (this.visible && nowMs - this.lastPaint > 250) {
      this.lastPaint = nowMs;
      this.paint(this.latest, avgFrame);
    }
  }

  snapshot(): DebugSnapshot | null {
    return this.latest;
  }

  private paint(s: DebugSnapshot, avgFrameMs: number): void {
    this.set('Renderer', s.backend.toUpperCase());
    this.set('FPS', s.fps.toFixed(0));
    this.set('Frame', `${avgFrameMs.toFixed(2)} ms`);
    this.set('CPU', `${s.cpuMs.toFixed(2)} ms`);
    this.set('Render', `${s.renderMs.toFixed(2)} ms`);
    let systemsTotal = 0;
    for (const ms of Object.values(s.systems)) systemsTotal += ms;
    this.set('Systems', `${systemsTotal.toFixed(2)} ms`);
    this.set('GPU', s.gpuMs === null ? 'n/a' : `${s.gpuMs.toFixed(2)} ms`);
    this.set('Resolution', s.sceneWidth && s.sceneWidth !== s.width ? `${s.width}×${s.height} (${s.sceneWidth}×${s.sceneHeight})` : `${s.width}×${s.height}`);
    this.set('Pixel Ratio', s.pixelRatio.toFixed(2));
    this.set('Scale', s.renderScale.toFixed(2));
    this.set('Draw Calls', String(s.drawCalls));
    this.set('Triangles', formatCount(s.triangles));
    this.set('Fixed Steps', String(s.fixedSteps));
    this.set('Preset', s.preset);
    this.set('Post', s.postEffects.length ? s.postEffects.join(' ') : 'none');
    this.set('Pipelines', `${s.pipelines} (${s.programs} programs)`);
    const l = s.lights;
    this.set('Lights', l ? `${l.active}/${l.registered} (${l.clusteredPath ? `clustered ${l.clustered}, ` : ''}unrolled ${l.unrolled}, culled ${l.culled}) budget ${l.budget}` : 'n/a');
  }

  private set(key: string, value: string): void {
    const el = this.lines.get(key);
    if (el) el.textContent = `${key.padEnd(12)} ${value}`;
  }

  dispose(): void {
    this.root.remove();
    this.lines.clear();
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
