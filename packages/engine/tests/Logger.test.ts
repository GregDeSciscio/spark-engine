import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/core/Logger';

/**
 * The record buffer is what `pnpm capture`, `pnpm visual` and `pnpm probe` mean
 * when they say a run was "clean", so its rules are load-bearing: warnings and
 * errors are always kept, whatever the console is set to, and nothing quieter
 * than a warning is kept at all.
 */

describe('Logger', () => {
  beforeEach(() => {
    Logger.clearRecords();
    Logger.setLevel('info');
  });

  afterEach(() => {
    Logger.clearRecords();
    Logger.setLevel('info');
    vi.restoreAllMocks();
  });

  it('records warnings and errors, and nothing quieter', () => {
    const log = new Logger('test');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(Logger.getRecords().map((r) => r.message)).toEqual(['c', 'd']);
    expect(Logger.getRecords().map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('keeps the scope and a timestamp on each record', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = Date.now();
    new Logger('physics').warn('body limit reached');
    const record = Logger.getRecords()[0];
    expect(record?.scope).toBe('physics');
    expect(record?.message).toBe('body limit reached');
    expect(record?.time).toBeGreaterThanOrEqual(before);
  });

  it('still records warnings when the console is silenced', () => {
    // The invariant the capture tools rest on: `?log=silent` quiets the console,
    // it does not hide problems from a headless run's verdict.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Logger.setLevel('silent');
    new Logger('audio').warn('cue missing');
    expect(warn).not.toHaveBeenCalled();
    expect(Logger.getRecords().map((r) => r.message)).toEqual(['cue missing']);
  });

  it('gates the console by level without touching the records', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Logger.setLevel('warn');
    const log = new Logger('scene');
    log.info('loading');
    log.warn('slow');
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe('[spark:scene] slow');
    expect(Logger.getRecords()).toHaveLength(1);
  });

  it('passes extra arguments through to the console', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    new Logger('assets').error('failed', { url: '/a.glb' }, 404);
    expect(error).toHaveBeenCalledWith('[spark:assets] failed', { url: '/a.glb' }, 404);
  });

  it('composes child scopes', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const child = new Logger('engine').child('physics').child('rapier');
    expect(child.scope).toBe('engine:physics:rapier');
    child.warn('step overran');
    expect(Logger.getRecords()[0]?.scope).toBe('engine:physics:rapier');
  });

  it('bounds the buffer and drops the oldest first', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = new Logger('spam');
    for (let i = 0; i < 520; i++) log.warn(`w${i}`);
    const records = Logger.getRecords();
    expect(records).toHaveLength(500);
    expect(records[0]?.message).toBe('w20');
    expect(records.at(-1)?.message).toBe('w519');
  });

  it('clears on request, so each capture starts from nothing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    new Logger('test').warn('old news');
    expect(Logger.getRecords()).toHaveLength(1);
    Logger.clearRecords();
    expect(Logger.getRecords()).toHaveLength(0);
  });

  it('reports the level it was set to', () => {
    Logger.setLevel('debug');
    expect(Logger.getLevel()).toBe('debug');
    Logger.setLevel('error');
    expect(Logger.getLevel()).toBe('error');
  });
});
