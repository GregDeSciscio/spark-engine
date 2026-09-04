import type { Disposable } from '../core/Disposable';

export type PointerButton = 0 | 1 | 2;

/**
 * Frame-coherent input state. Browser events are recorded as they arrive;
 * `update()` at the top of each frame commits them so that `wasPressed` and
 * `wasReleased` are stable for the whole frame.
 *
 * Keys are `KeyboardEvent.code` values (`KeyW`, `Space`, `ShiftLeft`).
 */
export class Input implements Disposable {
  private readonly target: HTMLElement;
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly released = new Set<string>();
  private readonly pendingPressed = new Set<string>();
  private readonly pendingReleased = new Set<string>();

  private readonly buttonsDown = new Set<number>();
  private readonly buttonsPressed = new Set<number>();
  private readonly buttonsReleased = new Set<number>();
  private readonly pendingButtonsPressed = new Set<number>();
  private readonly pendingButtonsReleased = new Set<number>();

  private pointerX = 0;
  private pointerY = 0;
  private pendingDeltaX = 0;
  private pendingDeltaY = 0;
  private deltaX = 0;
  private deltaY = 0;
  private pendingWheel = 0;
  private wheel = 0;
  private pointerInside = false;
  private pointerLocked = false;
  private captured = false;
  private readonly passthrough = new Set<string>(['Escape']);
  private disposed = false;

  constructor(target: HTMLElement) {
    this.target = target;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    target.addEventListener('pointerdown', this.onPointerDown);
    target.addEventListener('pointerup', this.onPointerUp);
    target.addEventListener('pointermove', this.onPointerMove);
    target.addEventListener('pointerenter', this.onPointerEnter);
    target.addEventListener('pointerleave', this.onPointerLeave);
    target.addEventListener('wheel', this.onWheel, { passive: true });
    target.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  /**
   * Lock the pointer to the target so mouse motion arrives as deltas with no
   * cursor. Browsers only honour this inside a user gesture (a click handler).
   * `isPointerLocked` flips when the browser confirms; Escape releases it.
   */
  requestPointerLock(): void {
    if (this.disposed || this.pointerLocked) return;
    const result = this.target.requestPointerLock() as unknown;
    if (result instanceof Promise) result.catch(() => {});
  }

  exitPointerLock(): void {
    if (document.pointerLockElement === this.target) document.exitPointerLock();
  }

  get isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  /** Commit pending events for this frame. Called by the engine loop's input phase. */
  update(): void {
    this.pressed.clear();
    this.released.clear();
    for (const k of this.pendingPressed) this.pressed.add(k);
    for (const k of this.pendingReleased) this.released.add(k);
    this.pendingPressed.clear();
    this.pendingReleased.clear();

    this.buttonsPressed.clear();
    this.buttonsReleased.clear();
    for (const b of this.pendingButtonsPressed) this.buttonsPressed.add(b);
    for (const b of this.pendingButtonsReleased) this.buttonsReleased.add(b);
    this.pendingButtonsPressed.clear();
    this.pendingButtonsReleased.clear();

    this.deltaX = this.pendingDeltaX;
    this.deltaY = this.pendingDeltaY;
    this.pendingDeltaX = 0;
    this.pendingDeltaY = 0;
    this.wheel = this.pendingWheel;
    this.pendingWheel = 0;
  }

  /**
   * While captured (a UI layer owns the pointer, see `UIHost`), every query
   * reports "nothing" except the passthrough codes (default `Escape`, so a
   * menu can be closed from gameplay code). Raw state keeps tracking, so a key
   * still held when capture ends reads as down again.
   */
  setCaptured(captured: boolean, passthrough: readonly string[] = ['Escape']): void {
    this.captured = captured;
    this.passthrough.clear();
    for (const code of passthrough) this.passthrough.add(code);
  }

  get isCaptured(): boolean {
    return this.captured;
  }

  private blocked(code: string): boolean {
    return this.captured && !this.passthrough.has(code);
  }

  isDown(code: string): boolean {
    return !this.blocked(code) && this.down.has(code);
  }

  wasPressed(code: string): boolean {
    return !this.blocked(code) && this.pressed.has(code);
  }

  wasReleased(code: string): boolean {
    return !this.blocked(code) && this.released.has(code);
  }

  /** -1, 0 or 1 from a negative/positive key pair, e.g. `axis('KeyA', 'KeyD')`. */
  axis(negative: string, positive: string): number {
    return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
  }

  isButtonDown(button: PointerButton): boolean {
    return !this.captured && this.buttonsDown.has(button);
  }

  wasButtonPressed(button: PointerButton): boolean {
    return !this.captured && this.buttonsPressed.has(button);
  }

  wasButtonReleased(button: PointerButton): boolean {
    return !this.captured && this.buttonsReleased.has(button);
  }

  /** Pointer position in CSS pixels relative to the target's top-left. */
  get pointer(): { x: number; y: number; inside: boolean } {
    return { x: this.pointerX, y: this.pointerY, inside: this.pointerInside };
  }

  /** Pointer movement this frame in CSS pixels. */
  get pointerDelta(): { x: number; y: number } {
    return { x: this.deltaX, y: this.deltaY };
  }

  /** Wheel delta this frame, positive = scroll down. */
  get wheelDelta(): number {
    return this.wheel;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    if (!this.down.has(e.code)) this.pendingPressed.add(e.code);
    this.down.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (this.down.has(e.code)) this.pendingReleased.add(e.code);
    this.down.delete(e.code);
  };

  private readonly onBlur = (): void => {
    for (const code of this.down) this.pendingReleased.add(code);
    this.down.clear();
    for (const b of this.buttonsDown) this.pendingButtonsReleased.add(b);
    this.buttonsDown.clear();
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.buttonsDown.add(e.button);
    this.pendingButtonsPressed.add(e.button);
    this.updatePointer(e);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.buttonsDown.delete(e.button);
    this.pendingButtonsReleased.add(e.button);
    this.updatePointer(e);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    this.pendingDeltaX += e.movementX;
    this.pendingDeltaY += e.movementY;
    this.updatePointer(e);
  };

  private readonly onPointerEnter = (): void => {
    this.pointerInside = true;
  };

  private readonly onPointerLeave = (): void => {
    this.pointerInside = false;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    this.pendingWheel += e.deltaY;
  };

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private readonly onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.target;
  };

  private updatePointer(e: PointerEvent): void {
    const rect = this.target.getBoundingClientRect();
    this.pointerX = e.clientX - rect.left;
    this.pointerY = e.clientY - rect.top;
  }

  dispose(): void {
    if (this.disposed) return;
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('pointerdown', this.onPointerDown);
    this.target.removeEventListener('pointerup', this.onPointerUp);
    this.target.removeEventListener('pointermove', this.onPointerMove);
    this.target.removeEventListener('pointerenter', this.onPointerEnter);
    this.target.removeEventListener('pointerleave', this.onPointerLeave);
    this.target.removeEventListener('wheel', this.onWheel);
    this.target.removeEventListener('contextmenu', this.onContextMenu);
  }
}
