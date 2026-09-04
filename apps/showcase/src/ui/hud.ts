import type { UIHost } from '@spark/engine';
import type { Stance } from '../actors/Operator';

/**
 * The bare operator HUD: a crosshair that tightens while aiming, a stance and
 * speed readout, and the click-to-play prompt that pointer lock needs. Plain
 * DOM in the engine's `hud` layer; no game state lives here.
 */
export interface OperatorHud {
  setLocked(locked: boolean): void;
  setAiming(aiming: boolean): void;
  setStatus(stance: Stance, speed: number, grounded: boolean): void;
  dispose(): void;
}

const MONO = 'ui-monospace, Consolas, monospace';

export function createOperatorHud(ui: UIHost): OperatorHud {
  const crosshair = document.createElement('div');
  Object.assign(crosshair.style, {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: '6px',
    height: '6px',
    marginLeft: '-3px',
    marginTop: '-3px',
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.85)',
    boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
    transition: 'transform 120ms ease-out, opacity 120ms',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);

  const status = document.createElement('div');
  Object.assign(status.style, {
    position: 'absolute',
    left: '16px',
    bottom: '14px',
    font: `12px/1.5 ${MONO}`,
    color: '#9aa4bd',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);

  const prompt = document.createElement('div');
  prompt.textContent = 'click to take control · WASD move · Shift sprint · C crouch · X prone · Space jump · RMB aim · Esc release';
  Object.assign(prompt.style, {
    position: 'absolute',
    left: '50%',
    bottom: '48px',
    transform: 'translateX(-50%)',
    padding: '8px 14px',
    font: `12px/1.5 ${MONO}`,
    color: '#dfe6ff',
    background: 'rgba(8, 10, 16, 0.75)',
    border: '1px solid #1c2233',
    borderRadius: '4px',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);

  ui.mount('hud', crosshair);
  ui.mount('hud', status);
  ui.mount('hud', prompt);

  return {
    setLocked(locked) {
      prompt.hidden = locked;
      crosshair.style.opacity = locked ? '1' : '0.35';
    },
    setAiming(aiming) {
      crosshair.style.transform = aiming ? 'scale(0.6)' : 'scale(1)';
    },
    setStatus(stance, speed, grounded) {
      status.textContent = `${stance} · ${speed.toFixed(1)} m/s${grounded ? '' : ' · airborne'}`;
    },
    dispose() {
      ui.unmount(crosshair);
      ui.unmount(status);
      ui.unmount(prompt);
    },
  };
}
