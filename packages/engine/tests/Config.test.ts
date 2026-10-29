import { describe, expect, it } from 'vitest';
import { configFromSearch, resolveConfig, DEFAULT_CONFIG } from '../src/core/Config';

const container = {} as HTMLElement;

describe('configFromSearch', () => {
  it('parses recognised params', () => {
    const c = configFromSearch('?backend=webgl&preset=Ultra&scale=0.5&dpr=1&seed=42&overlay=0&fixedclock=30&log=warn');
    expect(c).toEqual({
      backend: 'webgl',
      preset: 'ultra',
      renderScale: 0.5,
      maxPixelRatio: 1,
      seed: 42,
      debugOverlay: false,
      fixedFrameDelta: 1 / 30,
      logLevel: 'warn',
    });
  });

  it('ignores malformed values instead of throwing', () => {
    const c = configFromSearch('?backend=vulkan&preset=potato&scale=9&dpr=-1&seed=abc&fixedclock=nope');
    expect(c.backend).toBeUndefined();
    expect(c.preset).toBeUndefined();
    expect(c.renderScale).toBeUndefined();
    expect(c.maxPixelRatio).toBeUndefined();
    expect(c.seed).toBeUndefined();
    // fixedclock present but unparsable falls back to 60 Hz
    expect(c.fixedFrameDelta).toBeCloseTo(1 / 60);
  });

  it('keeps the stats panel off unless asked: ?stats=1, or ?overlay=1 as before', () => {
    expect(DEFAULT_CONFIG.showStats).toBe(false);
    expect(DEFAULT_CONFIG.debugOverlay).toBe(true);
    expect(configFromSearch('?stats=1')).toEqual({ showStats: true });
    expect(configFromSearch('?overlay=1')).toEqual({ debugOverlay: true, showStats: true });
    expect(configFromSearch('?overlay=0')).toEqual({ debugOverlay: false });
  });

  it('returns an empty object for an empty query', () => {
    expect(configFromSearch('')).toEqual({});
  });
});

describe('resolveConfig', () => {
  it('fills defaults', () => {
    const c = resolveConfig({ container });
    expect(c.backend).toBe(DEFAULT_CONFIG.backend);
    expect(c.fixedStepHz).toBe(60);
    expect(c.container).toBe(container);
  });

  it('rejects a non-integer fixed step', () => {
    expect(() => resolveConfig({ container, fixedStepHz: 59.5 })).toThrow();
    expect(() => resolveConfig({ container, fixedStepHz: 0 })).toThrow();
  });

  it('rejects an out-of-range render scale', () => {
    expect(() => resolveConfig({ container, renderScale: 0 })).toThrow();
    expect(() => resolveConfig({ container, renderScale: 1.5 })).toThrow();
  });
});

describe('inspector option', () => {
  it('is off by default and parsed from ?inspector=1', () => {
    expect(DEFAULT_CONFIG.inspector).toBe(false);
    expect(configFromSearch('?inspector=1').inspector).toBe(true);
    expect(configFromSearch('?inspector=true').inspector).toBe(true);
    expect(configFromSearch('?inspector=0').inspector).toBe(false);
    expect(configFromSearch('?scene=alley').inspector).toBeUndefined();
  });
});
