import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Input } from '../src/input/Input';

/**
 * Frame-coherent input. The engine's rule — read input in `update`, apply it in
 * the fixed step — only holds because `wasPressed` and `wasReleased` are stable
 * for a whole frame however many events arrive, and a key pressed and released
 * inside one frame still reports both. That is what is pinned here.
 *
 * There is no DOM in this environment, so window, document and the target are
 * stubbed down to what Input actually touches: listener registration and a
 * bounding rect.
 */

type Handler = (event: unknown) => void;

interface Harness {
  readonly input: Input;
  key(type: 'keydown' | 'keyup', code: string, repeat?: boolean): void;
  blur(): void;
  pointer(type: 'pointerdown' | 'pointerup' | 'pointermove', event: Record<string, unknown>): void;
  wheel(deltaY: number): void;
  enter(): void;
  leave(): void;
  /** Listener counts, to prove dispose cleans up. */
  counts(): { window: number; document: number; target: number };
  lockTo(element: unknown): void;
  readonly lockRequests: number;
}

function harness(options: { rect?: { left: number; top: number } } = {}): Harness {
  const win: Record<string, Handler[]> = {};
  const doc: Record<string, Handler[]> = {};
  const tgt: Record<string, Handler[]> = {};
  const bag = (map: Record<string, Handler[]>) => ({
    addEventListener: (type: string, fn: Handler) => {
      (map[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: Handler) => {
      const list = map[type];
      if (list) map[type] = list.filter((f) => f !== fn);
    },
  });
  const count = (map: Record<string, Handler[]>): number => Object.values(map).reduce((n, l) => n + l.length, 0);
  let lockRequests = 0;
  const documentStub = { ...bag(doc), pointerLockElement: null as unknown, exitPointerLock: () => {} };
  const target = {
    ...bag(tgt),
    getBoundingClientRect: () => ({ left: options.rect?.left ?? 0, top: options.rect?.top ?? 0 }),
    requestPointerLock: () => {
      lockRequests++;
      return undefined;
    },
  };
  (globalThis as { window?: unknown }).window = bag(win);
  (globalThis as { document?: unknown }).document = documentStub;
  const input = new Input(target as unknown as HTMLElement);
  const fire = (map: Record<string, Handler[]>, type: string, event: unknown): void => {
    for (const fn of map[type] ?? []) fn(event);
  };
  return {
    input,
    key: (type, code, repeat = false) => fire(win, type, { code, repeat }),
    blur: () => fire(win, 'blur', {}),
    pointer: (type, event) => fire(tgt, type, { button: 0, clientX: 0, clientY: 0, movementX: 0, movementY: 0, ...event }),
    wheel: (deltaY) => fire(tgt, 'wheel', { deltaY }),
    enter: () => fire(tgt, 'pointerenter', {}),
    leave: () => fire(tgt, 'pointerleave', {}),
    counts: () => ({ window: count(win), document: count(doc), target: count(tgt) }),
    lockTo: (element) => {
      documentStub.pointerLockElement = element === 'target' ? target : element;
      fire(doc, 'pointerlockchange', {});
    },
    get lockRequests() {
      return lockRequests;
    },
  };
}

describe('Input', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
    vi.restoreAllMocks();
  });

  it('holds a press for exactly one frame', () => {
    const h = harness();
    h.key('keydown', 'KeyW');
    // Nothing is visible until the frame commits.
    expect(h.input.wasPressed('KeyW')).toBe(false);
    expect(h.input.isDown('KeyW')).toBe(true);
    h.input.update();
    expect(h.input.wasPressed('KeyW')).toBe(true);
    // Stable for the whole frame, however often it is asked.
    expect(h.input.wasPressed('KeyW')).toBe(true);
    h.input.update();
    expect(h.input.wasPressed('KeyW')).toBe(false);
    expect(h.input.isDown('KeyW')).toBe(true);
  });

  it('reports a press and a release that happen inside one frame', () => {
    // A tap between two updates must not vanish: this is why the pending sets
    // exist rather than reading live state.
    const h = harness();
    h.key('keydown', 'Space');
    h.key('keyup', 'Space');
    h.input.update();
    expect(h.input.wasPressed('Space')).toBe(true);
    expect(h.input.wasReleased('Space')).toBe(true);
    expect(h.input.isDown('Space')).toBe(false);
  });

  it('ignores auto-repeat', () => {
    const h = harness();
    h.key('keydown', 'KeyE');
    h.input.update();
    expect(h.input.wasPressed('KeyE')).toBe(true);
    h.key('keydown', 'KeyE', true);
    h.key('keydown', 'KeyE', true);
    h.input.update();
    expect(h.input.wasPressed('KeyE')).toBe(false);
    expect(h.input.isDown('KeyE')).toBe(true);
  });

  it('reads an axis from a key pair', () => {
    const h = harness();
    expect(h.input.axis('KeyA', 'KeyD')).toBe(0);
    h.key('keydown', 'KeyD');
    expect(h.input.axis('KeyA', 'KeyD')).toBe(1);
    h.key('keydown', 'KeyA');
    expect(h.input.axis('KeyA', 'KeyD')).toBe(0);
    h.key('keyup', 'KeyD');
    expect(h.input.axis('KeyA', 'KeyD')).toBe(-1);
  });

  it('commits pointer buttons on the same schedule as keys', () => {
    const h = harness();
    h.pointer('pointerdown', { button: 0 });
    expect(h.input.isButtonDown(0)).toBe(true);
    expect(h.input.wasButtonPressed(0)).toBe(false);
    h.input.update();
    expect(h.input.wasButtonPressed(0)).toBe(true);
    h.pointer('pointerup', { button: 0 });
    h.input.update();
    expect(h.input.wasButtonReleased(0)).toBe(true);
    expect(h.input.isButtonDown(0)).toBe(false);
  });

  it('accumulates pointer movement between frames and clears it after', () => {
    const h = harness();
    h.pointer('pointermove', { movementX: 3, movementY: -2 });
    h.pointer('pointermove', { movementX: 4, movementY: 1 });
    // Deltas belong to the frame that commits them.
    expect(h.input.pointerDelta).toEqual({ x: 0, y: 0 });
    h.input.update();
    expect(h.input.pointerDelta).toEqual({ x: 7, y: -1 });
    h.input.update();
    expect(h.input.pointerDelta).toEqual({ x: 0, y: 0 });
  });

  it('accumulates wheel the same way', () => {
    const h = harness();
    h.wheel(100);
    h.wheel(-30);
    h.input.update();
    expect(h.input.wheelDelta).toBe(70);
    h.input.update();
    expect(h.input.wheelDelta).toBe(0);
  });

  it('reports the pointer relative to the target, and whether it is inside', () => {
    const h = harness({ rect: { left: 40, top: 12 } });
    h.pointer('pointermove', { clientX: 100, clientY: 50 });
    expect(h.input.pointer).toEqual({ x: 60, y: 38, inside: false });
    h.enter();
    expect(h.input.pointer.inside).toBe(true);
    h.leave();
    expect(h.input.pointer.inside).toBe(false);
  });

  it('releases everything held when the window loses focus', () => {
    // Alt-tabbing away with W held must not leave the operator sprinting.
    const h = harness();
    h.key('keydown', 'KeyW');
    h.pointer('pointerdown', { button: 0 });
    h.input.update();
    h.blur();
    h.input.update();
    expect(h.input.isDown('KeyW')).toBe(false);
    expect(h.input.wasReleased('KeyW')).toBe(true);
    expect(h.input.isButtonDown(0)).toBe(false);
    expect(h.input.wasButtonReleased(0)).toBe(true);
  });

  it('reports nothing while a UI layer has capture, except the passthrough keys', () => {
    const h = harness();
    h.key('keydown', 'KeyW');
    h.key('keydown', 'Escape');
    h.pointer('pointerdown', { button: 0 });
    h.input.update();
    h.input.setCaptured(true);
    expect(h.input.isDown('KeyW')).toBe(false);
    expect(h.input.wasPressed('KeyW')).toBe(false);
    expect(h.input.isButtonDown(0)).toBe(false);
    expect(h.input.wasButtonPressed(0)).toBe(false);
    // Escape passes through by default so a menu can be closed from gameplay code.
    expect(h.input.wasPressed('Escape')).toBe(true);
    expect(h.input.isCaptured).toBe(true);
  });

  it('keeps tracking under capture, so a key still held reads down again after', () => {
    const h = harness();
    h.input.setCaptured(true);
    h.key('keydown', 'KeyW');
    h.input.update();
    expect(h.input.isDown('KeyW')).toBe(false);
    h.input.setCaptured(false);
    expect(h.input.isDown('KeyW')).toBe(true);
  });

  it('takes a custom passthrough set', () => {
    const h = harness();
    h.input.setCaptured(true, ['Tab']);
    h.key('keydown', 'Tab');
    h.key('keydown', 'Escape');
    h.input.update();
    expect(h.input.wasPressed('Tab')).toBe(true);
    expect(h.input.wasPressed('Escape')).toBe(false);
  });

  it('flips isPointerLocked only when the browser confirms', () => {
    const h = harness();
    expect(h.input.isPointerLocked).toBe(false);
    h.input.requestPointerLock();
    expect(h.lockRequests).toBe(1);
    // Asking is not being granted.
    expect(h.input.isPointerLocked).toBe(false);
    h.lockTo('target');
    expect(h.input.isPointerLocked).toBe(true);
    // A second request while locked is not sent again.
    h.input.requestPointerLock();
    expect(h.lockRequests).toBe(1);
    h.lockTo(null);
    expect(h.input.isPointerLocked).toBe(false);
  });

  it('stops listening on dispose', () => {
    const h = harness();
    const before = h.counts();
    expect(before.window + before.document + before.target).toBeGreaterThan(0);
    h.input.dispose();
    expect(h.counts()).toEqual({ window: 0, document: 0, target: 0 });
    // And a late event changes nothing.
    h.key('keydown', 'KeyW');
    h.input.update();
    expect(h.input.isDown('KeyW')).toBe(false);
    h.input.dispose();
  });
});
