import type { UIHost } from '@spark/engine';
import type { Stance } from '../actors/Operator';

/**
 * The bare operator HUD: a crosshair whose ring opens with the weapon's
 * spread and tightens on aim, an ammo counter with reload progress, a stance
 * and speed readout, and the click-to-play prompt that pointer lock needs.
 * Plain DOM in the engine's `hud` layer; no game state lives here.
 */
export interface OperatorHud {
  setLocked(locked: boolean): void;
  setAiming(aiming: boolean): void;
  /** Crosshair spread, degrees of cone half-angle. */
  setSpread(spreadDeg: number): void;
  setAmmo(ammo: number, reserve: number, reloading: boolean, reloadProgress: number): void;
  setStatus(stance: Stance, speed: number, grounded: boolean): void;
  setScore(hits: number, kills: number): void;
  dispose(): void;
}

const MONO = 'ui-monospace, Consolas, monospace';
/** Ring radius in px per degree of spread, on top of the base radius. */
const PX_PER_DEGREE = 26;
const RING_BASE_PX = 10;

export function createOperatorHud(ui: UIHost): OperatorHud {
  const dot = document.createElement('div');
  Object.assign(dot.style, {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: '4px',
    height: '4px',
    marginLeft: '-2px',
    marginTop: '-2px',
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.9)',
    boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);

  const ring = document.createElement('div');
  Object.assign(ring.style, {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: '20px',
    height: '20px',
    marginLeft: '-10px',
    marginTop: '-10px',
    borderRadius: '50%',
    border: '1px solid rgba(255,255,255,0.55)',
    boxShadow: '0 0 0 1px rgba(0,0,0,0.35)',
    transition: 'width 60ms linear, height 60ms linear, margin 60ms linear, opacity 120ms',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);

  const ammo = document.createElement('div');
  Object.assign(ammo.style, {
    position: 'absolute',
    right: '18px',
    bottom: '14px',
    font: `22px/1.2 ${MONO}`,
    color: '#dfe6ff',
    letterSpacing: '0.04em',
    textAlign: 'right',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  const ammoSub = document.createElement('div');
  Object.assign(ammoSub.style, { font: `11px/1.4 ${MONO}`, color: '#9aa4bd', letterSpacing: '0.08em', textTransform: 'uppercase' } satisfies Partial<CSSStyleDeclaration>);
  const ammoMain = document.createElement('div');
  ammo.append(ammoMain, ammoSub);

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

  const score = document.createElement('div');
  Object.assign(score.style, {
    position: 'absolute',
    right: '18px',
    top: '12px',
    font: `12px/1.5 ${MONO}`,
    color: '#9aa4bd',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);

  const prompt = document.createElement('div');
  prompt.textContent = 'click to take control · WASD move · Shift sprint · C crouch · X prone · Space jump · LMB fire · RMB aim · R reload · Esc release';
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

  for (const el of [dot, ring, ammo, status, score, prompt]) ui.mount('hud', el);

  let lastRadius = -1;
  return {
    setLocked(locked) {
      prompt.hidden = locked;
      const opacity = locked ? '1' : '0.35';
      dot.style.opacity = opacity;
      ring.style.opacity = opacity;
    },
    setAiming(aiming) {
      ring.style.borderColor = aiming ? 'rgba(255,214,102,0.8)' : 'rgba(255,255,255,0.55)';
    },
    setSpread(spreadDeg) {
      const radius = Math.round(RING_BASE_PX + spreadDeg * PX_PER_DEGREE);
      if (radius === lastRadius) return;
      lastRadius = radius;
      const size = `${radius * 2}px`;
      ring.style.width = size;
      ring.style.height = size;
      ring.style.marginLeft = `-${radius}px`;
      ring.style.marginTop = `-${radius}px`;
    },
    setAmmo(rounds, reserve, reloading, reloadProgress) {
      ammoMain.textContent = `${rounds} / ${reserve}`;
      ammoMain.style.color = rounds === 0 && !reloading ? '#ff6a4a' : '#dfe6ff';
      ammoSub.textContent = reloading ? `reloading ${Math.round(reloadProgress * 100)}%` : rounds === 0 ? 'press R' : 'M4A1';
    },
    setStatus(stance, speed, grounded) {
      status.textContent = `${stance} · ${speed.toFixed(1)} m/s${grounded ? '' : ' · airborne'}`;
    },
    setScore(hits, kills) {
      score.textContent = `hits ${hits} · down ${kills}`;
    },
    dispose() {
      for (const el of [dot, ring, ammo, status, score, prompt]) ui.unmount(el);
    },
  };
}
