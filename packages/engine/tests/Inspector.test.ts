import { describe, expect, it } from 'vitest';
import {
  InspectorState,
  countScene,
  debugViewOptions,
  engineRows,
  formatCount,
  formatMs,
  postRows,
  sortComponentCounts,
  sphereOutline,
  sphereOutlineFloats,
  topSystems,
  type CountableObject,
} from '../src/debug/InspectorModel';
import type { DebugSnapshot } from '../src/debug/DebugStats';
import { DEBUG_VIEW_NAMES } from '../src/rendering/RenderPipeline';

describe('topSystems', () => {
  it('sorts slowest first, ties by name, and truncates', () => {
    const timings = new Map<string, number>([
      ['RenderSync', 0.2],
      ['Physics', 1.4],
      ['Animation', 0.9],
      ['Culling', 0.9],
    ]);
    expect(topSystems(timings, 3).map((s) => s.name)).toEqual(['Physics', 'Animation', 'Culling']);
    expect(topSystems(timings, 0)).toEqual([]);
    expect(topSystems({ a: 1, b: 2 }, 5).map((s) => s.name)).toEqual(['b', 'a']);
  });
});

describe('sortComponentCounts', () => {
  it('orders by count then name without mutating the input', () => {
    const input = [
      { name: 'Transform', count: 10 },
      { name: 'Cullable', count: 12 },
      { name: 'Animator', count: 10 },
    ];
    const sorted = sortComponentCounts(input);
    expect(sorted.map((c) => c.name)).toEqual(['Cullable', 'Animator', 'Transform']);
    expect(input[0]?.name).toBe('Transform');
  });
});

describe('formatting', () => {
  it('formats milliseconds and counts', () => {
    expect(formatMs(1.2345)).toBe('1.23 ms');
    expect(formatMs(null)).toBe('n/a');
    expect(formatMs(Number.NaN)).toBe('n/a');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(12_345)).toBe('12.3k');
    expect(formatCount(2_500_000)).toBe('2.50M');
  });
});

describe('engineRows', () => {
  const snapshot: DebugSnapshot = {
    backend: 'webgpu',
    preset: 'high',
    fps: 120,
    cpuMs: 3.2,
    renderMs: 2.1,
    systems: {},
    gpuMs: null,
    width: 1920,
    height: 1080,
    pixelRatio: 1,
    renderScale: 0.75,
    sceneWidth: 1440,
    sceneHeight: 810,
    postEffects: ['traa', 'bloom'],
    drawCalls: 120,
    triangles: 1_234_567,
    fixedSteps: 1,
    frame: 42,
    elapsed: 0.7,
  };

  it('describes the engine before the first frame', () => {
    const rows = engineRows(null, { state: 'ready', fixedStepHz: 60, adapter: null });
    expect(rows).toEqual([
      ['State', 'ready'],
      ['Backend', '-'],
      ['Adapter', 'n/a'],
      ['Fixed step', '60 Hz'],
    ]);
  });

  it('includes frame stats, scaled resolution and the post list from a snapshot', () => {
    const rows = new Map(engineRows(snapshot, { state: 'running', fixedStepHz: 60, adapter: 'nvidia ampere' }));
    expect(rows.get('Backend')).toBe('WEBGPU');
    expect(rows.get('FPS')).toBe('120');
    expect(rows.get('Frame time')).toBe('8.33 ms');
    expect(rows.get('GPU')).toBe('n/a');
    expect(rows.get('Resolution')).toBe('1920x1080 (1440x810)');
    expect(rows.get('Triangles')).toBe('1.23M');
    expect(rows.get('Post')).toBe('traa bloom');
  });
});

describe('postRows', () => {
  it('labels unavailable effects', () => {
    const rows = postRows([
      { name: 'bloom', enabled: true, available: true },
      { name: 'ssr', enabled: true, available: false },
    ]);
    expect(rows[0]?.label).toBe('bloom');
    expect(rows[1]?.label).toBe('ssr (unavailable)');
    expect(rows[1]?.enabled).toBe(true);
  });
});

describe('debug views', () => {
  it('lists none first and resolves unknown names to the normal image', () => {
    expect(debugViewOptions(['wireframe', 'depth'])).toEqual(['none', 'wireframe', 'depth']);
    const state = new InspectorState();
    expect(state.setDebugView('depth', DEBUG_VIEW_NAMES)).toBe('depth');
    expect(state.debugView).toBe('depth');
    expect(state.setDebugView('cascades', DEBUG_VIEW_NAMES)).toBeNull();
    expect(state.debugView).toBe('none');
    expect(state.setDebugView('none', DEBUG_VIEW_NAMES)).toBeNull();
  });
});

describe('sphereOutline', () => {
  it('writes three rings of line segments on the sphere surface and returns the new offset', () => {
    const segments = 8;
    const floats = sphereOutlineFloats(segments);
    expect(floats).toBe(segments * 3 * 2 * 3);
    const out = new Float32Array(floats * 2);
    const next = sphereOutline(1, 2, 3, 0.5, segments, out, 0);
    expect(next).toBe(floats);
    for (let i = 0; i < floats; i += 3) {
      const dx = (out[i] ?? 0) - 1;
      const dy = (out[i + 1] ?? 0) - 2;
      const dz = (out[i + 2] ?? 0) - 3;
      expect(Math.hypot(dx, dy, dz)).toBeCloseTo(0.5, 5);
    }
    // A second sphere appends after the first.
    expect(sphereOutline(0, 0, 0, 1, segments, out, next)).toBe(floats * 2);
    // Segments chain: the end of one is the start of the next within a ring.
    expect(out[3]).toBeCloseTo(out[6] ?? Number.NaN, 5);
    expect(out[4]).toBeCloseTo(out[7] ?? Number.NaN, 5);
    expect(out[5]).toBeCloseTo(out[8] ?? Number.NaN, 5);
  });
});

describe('countScene', () => {
  it('counts objects, meshes, lights and triangles including instances', () => {
    const geometry = { index: { count: 36 }, attributes: { position: { count: 24 } } };
    const root: CountableObject = {
      children: [
        { children: [], isMesh: true, geometry },
        { children: [], isMesh: true, isInstancedMesh: true, count: 10, geometry },
        { children: [], isLight: true },
        { children: [{ children: [], isMesh: true, geometry: { index: null, attributes: { position: { count: 9 } } } }] },
      ],
    };
    expect(countScene(root)).toEqual({ objects: 6, meshes: 3, lights: 1, triangles: 12 + 120 + 3 });
  });
});
