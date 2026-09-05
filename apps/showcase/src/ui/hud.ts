import { createBar, type UIHost } from '@spark/engine';
import type { Stance } from '../actors/Operator';

/**
 * The operator HUD: a crosshair whose ring opens with the weapon's spread,
 * ammo with reload progress, health with a damage vignette, the enemies'
 * loudest awareness state, stance and speed, a score line, the click-to-play
 * prompt pointer lock needs, and the mission-failed card. Plain DOM in the
 * engine's `hud` layer; no game state lives here.
 */
export interface OperatorHud {
  setLocked(locked: boolean): void;
  setAiming(aiming: boolean): void;
  /** Crosshair spread, degrees of cone half-angle. */
  setSpread(spreadDeg: number): void;
  setAmmo(ammo: number, reserve: number, reloading: boolean, reloadProgress: number): void;
  /** 0..1 health and 0..1 vignette strength. */
  setHealth(health: number, hurt: number): void;
  setAlert(level: 'undetected' | 'suspicious' | 'alert'): void;
  setStatus(stance: Stance, speed: number, grounded: boolean): void;
  setScore(hits: number, kills: number, enemiesLeft: number): void;
  /** Current objective line; `progress` 0..1 fills the hold bar, `prompt` shows the interact hint. */
  setObjective(index: number, total: number, label: string | null, distance: number, progress: number, prompt: string | null): void;
  setFailed(visible: boolean): void;
  setComplete(visible: boolean): void;
  dispose(): void;
}

const MONO = 'ui-monospace, Consolas, monospace';
/** Ring radius in px per degree of spread, on top of the base radius. */
const PX_PER_DEGREE = 26;
const RING_BASE_PX = 10;

const ALERT_STYLE = {
  undetected: { text: 'undetected', color: '#8fd3a5' },
  suspicious: { text: 'suspicious', color: '#ffd166' },
  alert: { text: 'ALERT', color: '#ff5a5a' },
} as const;

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

  const vignette = document.createElement('div');
  Object.assign(vignette.style, {
    position: 'absolute',
    inset: '0',
    boxShadow: 'inset 0 0 140px 40px rgba(255, 24, 24, 0.85)',
    opacity: '0',
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

  const healthWrap = document.createElement('div');
  Object.assign(healthWrap.style, {
    position: 'absolute',
    left: '16px',
    bottom: '40px',
    width: '200px',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  const health = createBar({ label: 'health', color: '#ff5a5a' });
  healthWrap.appendChild(health.element);

  const alert = document.createElement('div');
  Object.assign(alert.style, {
    position: 'absolute',
    left: '50%',
    top: '14px',
    transform: 'translateX(-50%)',
    font: `12px/1.5 ${MONO}`,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    color: ALERT_STYLE.undetected.color,
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
  prompt.textContent = 'click to take control · WASD move · Shift sprint · C crouch · X prone · Space jump · LMB fire · RMB aim · R reload · F4 navmesh · Esc release';
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

  const objective = document.createElement('div');
  Object.assign(objective.style, {
    position: 'absolute',
    left: '16px',
    bottom: '96px',
    font: `12px/1.6 ${MONO}`,
    color: '#dfe6ff',
    letterSpacing: '0.06em',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  const objectiveHead = document.createElement('div');
  Object.assign(objectiveHead.style, { color: '#9aa4bd', textTransform: 'uppercase', fontSize: '11px', letterSpacing: '0.12em' } satisfies Partial<CSSStyleDeclaration>);
  const objectiveLabel = document.createElement('div');
  const objectiveMeta = document.createElement('div');
  Object.assign(objectiveMeta.style, { color: '#9aa4bd', fontSize: '11px' } satisfies Partial<CSSStyleDeclaration>);
  objective.append(objectiveHead, objectiveLabel, objectiveMeta);

  const interact = document.createElement('div');
  Object.assign(interact.style, {
    position: 'absolute',
    left: '50%',
    top: '58%',
    transform: 'translateX(-50%)',
    width: '220px',
    font: `12px/1.5 ${MONO}`,
    color: '#dfe6ff',
    letterSpacing: '0.08em',
    textAlign: 'center',
    textTransform: 'uppercase',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  const interactText = document.createElement('div');
  const interactTrack = document.createElement('div');
  Object.assign(interactTrack.style, { marginTop: '6px', height: '4px', background: 'rgba(255,255,255,0.15)', borderRadius: '2px', overflow: 'hidden' } satisfies Partial<CSSStyleDeclaration>);
  const interactFill = document.createElement('div');
  Object.assign(interactFill.style, { height: '100%', width: '0%', background: '#4dd2ff' } satisfies Partial<CSSStyleDeclaration>);
  interactTrack.appendChild(interactFill);
  interact.append(interactText, interactTrack);
  interact.hidden = true;

  const complete = document.createElement('div');
  complete.innerHTML = '<div style="font-size:26px;letter-spacing:0.3em;color:#8fd3a5">MISSION COMPLETE</div><div style="margin-top:10px;color:#9aa4bd;letter-spacing:0.08em">charge set, operator extracted</div>';
  Object.assign(complete.style, {
    position: 'absolute',
    left: '50%',
    top: '42%',
    transform: 'translate(-50%, -50%)',
    padding: '22px 36px',
    font: `13px/1.5 ${MONO}`,
    textAlign: 'center',
    textTransform: 'uppercase',
    background: 'rgba(8, 10, 16, 0.85)',
    border: '1px solid #1c3a26',
    borderRadius: '4px',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  complete.hidden = true;

  const failed = document.createElement('div');
  failed.innerHTML = '<div style="font-size:26px;letter-spacing:0.3em;color:#ff5a5a">MISSION FAILED</div><div style="margin-top:10px;color:#9aa4bd;letter-spacing:0.08em">press Enter to retry from the checkpoint</div>';
  Object.assign(failed.style, {
    position: 'absolute',
    left: '50%',
    top: '42%',
    transform: 'translate(-50%, -50%)',
    padding: '22px 36px',
    font: `13px/1.5 ${MONO}`,
    textAlign: 'center',
    textTransform: 'uppercase',
    background: 'rgba(8, 10, 16, 0.85)',
    border: '1px solid #3a1c22',
    borderRadius: '4px',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  failed.hidden = true;

  const all = [vignette, dot, ring, ammo, healthWrap, alert, status, score, objective, interact, prompt, failed, complete];
  for (const el of all) ui.mount('hud', el);

  let lastRadius = -1;
  let lastAlert = '';
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
    setHealth(value, hurt) {
      health.set(value);
      vignette.style.opacity = hurt.toFixed(3);
    },
    setAlert(level) {
      if (level === lastAlert) return;
      lastAlert = level;
      alert.textContent = ALERT_STYLE[level].text;
      alert.style.color = ALERT_STYLE[level].color;
    },
    setStatus(stance, speed, grounded) {
      status.textContent = `${stance} · ${speed.toFixed(1)} m/s${grounded ? '' : ' · airborne'}`;
    },
    setScore(hits, kills, enemiesLeft) {
      score.textContent = `hits ${hits} · down ${kills} · hostiles ${enemiesLeft}`;
    },
    setObjective(index, total, label, distance, progress, promptText) {
      objectiveHead.textContent = label ? `objective ${index + 1} / ${total}` : 'mission';
      objectiveLabel.textContent = label ?? 'complete';
      objectiveMeta.textContent = label ? `${distance.toFixed(0)} m` : '';
      interact.hidden = promptText === null;
      if (promptText !== null) {
        interactText.textContent = promptText;
        interactFill.style.width = `${Math.round(progress * 100)}%`;
      }
    },
    setFailed(visible) {
      failed.hidden = !visible;
    },
    setComplete(visible) {
      complete.hidden = !visible;
    },
    dispose() {
      for (const el of all) ui.unmount(el);
    },
  };
}
