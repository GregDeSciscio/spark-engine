import type { UIHost } from '@spark/engine';
import type { Stance } from '../actors/Operator';

/**
 * The operator HUD, in the street's own look: glass panels with cut corners,
 * a cyan accent, icons where a word would do, numbers only where they matter.
 * A crosshair whose ring opens with the weapon's spread and flashes on a hit,
 * vitals (health, how lit you are) as thin bars beside their icons, the
 * stance as a figure, ammo as digits with a reload ring, the hostiles' loudest
 * awareness state as one icon that changes colour, the objective as an icon
 * with a distance chip and step dots, a key cap with a hold ring for
 * interactions, the click-to-play card, and the failed / complete bands.
 * Plain DOM in the engine's `hud` layer; no game state lives here.
 */
export type ObjectiveKind = 'reach' | 'plant' | 'eliminate';

export interface OperatorHud {
  /** `note` replaces the click-to-play card's hint when the browser refuses pointer lock. */
  setLocked(locked: boolean, note?: string | null): void;
  setAiming(aiming: boolean): void;
  /** Crosshair spread ring radius in CSS pixels (the scene projects the cone through the camera). */
  setSpread(radiusPx: number): void;
  /** Reticle position in CSS pixels from the centre (recoil), and whether the barrel is blocked. */
  setReticle(dx: number, dy: number, blocked: boolean): void;
  /** A round landed: flash the hit marker. */
  hit(): void;
  setAmmo(ammo: number, reserve: number, reloading: boolean, reloadProgress: number): void;
  /** 0..1 health and 0..1 vignette strength. */
  setHealth(health: number, hurt: number): void;
  /** 0..1 how lit the operator is: the stealth meter. */
  setVisibility(lit: number): void;
  setAlert(level: 'undetected' | 'suspicious' | 'alert'): void;
  setStatus(stance: Stance, speed: number, grounded: boolean): void;
  setScore(hits: number, kills: number, enemiesLeft: number): void;
  /** Current objective; `progress` 0..1 fills the hold ring, `prompt` shows the interact key. */
  setObjective(index: number, total: number, kind: ObjectiveKind | null, label: string | null, distance: number, progress: number, prompt: string | null): void;
  setFailed(visible: boolean): void;
  setComplete(visible: boolean): void;
  dispose(): void;
}

const RING_MIN_PX = 6;

/** Stroke icons, 24-unit grid, drawn in the current colour. */
const ICON = {
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  skull: '<path d="M12 2a8 8 0 0 0-8 8c0 3 1.5 5 4 6.5V20a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-3.5c2.5-1.5 4-3.5 4-6.5a8 8 0 0 0-8-8z"/><circle cx="9" cy="11" r="1.4"/><circle cx="15" cy="11" r="1.4"/><path d="M11 17h2"/>',
  people: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  flag: '<path d="M4 22V4"/><path d="M4 4h12l-2 4 2 4H4"/>',
  bomb: '<circle cx="11" cy="13" r="8"/><path d="M15.5 6.5 19 3"/><path d="M17 5l2 2"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  mag: '<path d="M8 3h8a1 1 0 0 1 1 1v15l-2 2H9l-2-2V4a1 1 0 0 1 1-1z"/><path d="M9 7h6"/><path d="M9 11h6"/>',
  stand: '<circle cx="12" cy="4" r="2"/><path d="M12 6v8"/><path d="M9 22l3-8 3 8"/><path d="M8 10h8"/>',
  crouch: '<circle cx="14" cy="6" r="2"/><path d="M14 8l-4 5h6l-2 6"/><path d="M8 13h9"/><path d="M10 13l-3 5"/>',
  prone: '<circle cx="4" cy="14" r="2"/><path d="M6 15h14"/><path d="M9 15l-1 4"/><path d="M17 15l1 4"/>',
  mouse: '<rect x="7" y="3" width="10" height="18" rx="5"/><path d="M12 3v6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
} as const;

function icon(name: keyof typeof ICON, size = 16, cls = ''): string {
  return `<svg class="hx-ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
}

function key(label: string): string {
  return `<kbd class="hx-key">${label}</kbd>`;
}

const ALERT = {
  undetected: { icon: 'eyeOff', color: '#6be3a0' },
  suspicious: { icon: 'eye', color: '#ffd166' },
  alert: { icon: 'alert', color: '#ff2b5a' },
} as const;

const OBJECTIVE_ICON: Record<ObjectiveKind, keyof typeof ICON> = { reach: 'flag', plant: 'bomb', eliminate: 'target' };

const STYLE = `
.spark-ui-root { --hx-cyan: #19c8d8; --hx-magenta: #ff2bd6; --hx-red: #ff2b5a; --hx-fg: #e6f0ff; --hx-dim: rgba(230,240,255,0.55);
  --hx-glass: linear-gradient(180deg, rgba(12,16,26,0.78), rgba(6,8,14,0.62)); --hx-line: rgba(25,200,216,0.28);
  --hx-cut: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
  --hx-font: 13px/1.3 "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif; --hx-mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
  --spark-ui-accent: var(--hx-cyan); --spark-ui-health: var(--hx-red); --spark-ui-bg: rgba(8,10,16,0.55); --spark-ui-border: var(--hx-line); }
.spark-label-track { width: 40px; height: 3px; border: none; background: rgba(0,0,0,0.55); border-radius: 0; }
.spark-label-name { font: 10px/1.2 var(--hx-font); letter-spacing: 0.12em; text-transform: uppercase; color: var(--hx-dim); }

.hx { position: absolute; pointer-events: none; color: var(--hx-fg); font: var(--hx-font); }
.hx[hidden] { display: none !important; }
.hx-ic { display: block; flex: none; }
.hx-panel { background: var(--hx-glass); border: 1px solid var(--hx-line); clip-path: var(--hx-cut); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.hx-panel::after { content: ""; position: absolute; left: 0; top: 0; width: 22px; height: 2px; background: var(--hx-cyan); opacity: 0.9; }
.hx-key { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 6px; border: 1px solid rgba(255,255,255,0.22); border-bottom-width: 2px; border-radius: 4px; background: rgba(255,255,255,0.06); font: 600 11px/1 var(--hx-mono); color: var(--hx-fg); }

.hx-dot { left: 50%; top: 50%; width: 4px; height: 4px; margin: -2px 0 0 -2px; border-radius: 50%; background: rgba(255,255,255,0.92); box-shadow: 0 0 0 1px rgba(0,0,0,0.6), 0 0 6px rgba(25,200,216,0.6); }
.hx-ring { left: 50%; top: 50%; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.55); box-shadow: 0 0 0 1px rgba(0,0,0,0.35); transition: width 60ms linear, height 60ms linear, margin 60ms linear, opacity 120ms, border-color 120ms; }
.hx-ring[data-aim="1"] { border-color: var(--hx-cyan); box-shadow: 0 0 0 1px rgba(0,0,0,0.35), 0 0 10px rgba(25,200,216,0.45); }
.hx-ring[data-blocked="1"] { border-color: var(--hx-red); }
.hx-hit { left: 50%; top: 50%; width: 0; height: 0; opacity: 0; }
.hx-hit span { position: absolute; width: 2px; height: 7px; background: #fff; box-shadow: 0 0 4px rgba(255,255,255,0.8); }
.hx-hit span:nth-child(1) { transform: translate(-1px, -15px) rotate(45deg); }
.hx-hit span:nth-child(2) { transform: translate(-1px, 8px) rotate(45deg); }
.hx-hit span:nth-child(3) { transform: translate(-12px, -4px) rotate(-45deg); }
.hx-hit span:nth-child(4) { transform: translate(10px, -4px) rotate(-45deg); }
.hx-hit[data-flash="1"] { animation: hx-hit 160ms ease-out; }
@keyframes hx-hit { 0% { opacity: 1; transform: scale(1.3); } 100% { opacity: 0; transform: scale(1); } }

.hx-vignette { inset: 0; box-shadow: inset 0 0 160px 50px rgba(255, 20, 40, 0.8); opacity: 0; }

.hx-vitals { left: 18px; bottom: 18px; display: grid; grid-template-columns: auto 150px; gap: 8px 10px; align-items: center; padding: 12px 16px 12px 14px; }
.hx-vitals .hx-ic { color: var(--hx-dim); }
.hx-vitals .hx-ic[data-hot="1"] { color: var(--hx-red); animation: hx-pulse 0.9s ease-in-out infinite; }
.hx-track { position: relative; height: 4px; background: rgba(255,255,255,0.09); overflow: hidden; }
.hx-fill { position: absolute; inset: 0; transform-origin: left center; transition: transform 90ms linear, background 200ms; }
.hx-track::after { content: ""; position: absolute; inset: 0; background: repeating-linear-gradient(90deg, transparent 0 14px, rgba(6,8,14,0.9) 14px 15px); }
.hx-fill[data-kind="health"] { background: linear-gradient(90deg, #ff2b5a, #ff6a4a); box-shadow: 0 0 8px rgba(255,43,90,0.5); }
.hx-fill[data-kind="lit"] { background: linear-gradient(90deg, #19c8d8, #b8f6ff); box-shadow: 0 0 8px rgba(25,200,216,0.45); }
@keyframes hx-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

.hx-stance { left: 226px; bottom: 18px; width: 44px; height: 68px; display: grid; place-items: center; color: var(--hx-dim); }
.hx-stance .hx-ic { color: var(--hx-fg); }

.hx-ammo { right: 18px; bottom: 18px; display: flex; align-items: center; gap: 12px; padding: 10px 16px 10px 12px; }
.hx-ammo-mag { position: relative; width: 40px; height: 40px; display: grid; place-items: center; color: var(--hx-dim); }
.hx-ammo-mag svg.hx-reload { position: absolute; inset: 0; transform: rotate(-90deg); }
.hx-ammo-mag .hx-reload circle { fill: none; stroke: var(--hx-cyan); stroke-width: 2; stroke-linecap: round; stroke-dasharray: 113; stroke-dashoffset: 113; transition: stroke-dashoffset 80ms linear; opacity: 0; }
.hx-ammo[data-reloading="1"] .hx-reload circle { opacity: 1; }
.hx-ammo-digits { font: 600 30px/1 var(--hx-mono); font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
.hx-ammo-reserve { font: 12px/1 var(--hx-mono); color: var(--hx-dim); margin-left: 6px; }
.hx-ammo[data-empty="1"] .hx-ammo-digits { color: var(--hx-red); animation: hx-pulse 0.8s ease-in-out infinite; }

.hx-alert { left: 50%; top: 16px; transform: translateX(-50%); width: 40px; height: 40px; display: grid; place-items: center; border-radius: 50%; border: 1px solid var(--hx-line); background: var(--hx-glass); backdrop-filter: blur(10px); transition: color 200ms, border-color 200ms, box-shadow 200ms; }
.hx-alert[data-level="alert"] { animation: hx-pulse 0.7s ease-in-out infinite; }

.hx-score { right: 18px; top: 16px; display: flex; gap: 14px; padding: 8px 14px; font: 600 14px/1 var(--hx-mono); font-variant-numeric: tabular-nums; }
.hx-score span { display: inline-flex; align-items: center; gap: 6px; }
.hx-score .hx-ic { color: var(--hx-dim); }

.hx-objective { left: 18px; top: 16px; display: flex; align-items: center; gap: 12px; padding: 10px 16px 10px 12px; min-width: 200px; }
.hx-objective .hx-ic { color: var(--hx-cyan); }
.hx-objective-label { font: 600 13px/1.2 var(--hx-font); letter-spacing: 0.04em; }
.hx-objective-steps { display: flex; gap: 5px; margin-top: 6px; }
.hx-objective-steps i { width: 14px; height: 3px; background: rgba(255,255,255,0.14); }
.hx-objective-steps i[data-done="1"] { background: var(--hx-cyan); box-shadow: 0 0 6px rgba(25,200,216,0.5); }
.hx-objective-steps i[data-now="1"] { background: var(--hx-fg); }
.hx-chip { margin-left: auto; padding: 3px 8px; border: 1px solid var(--hx-line); font: 600 11px/1.2 var(--hx-mono); color: var(--hx-cyan); white-space: nowrap; }

.hx-interact { left: 50%; top: 60%; transform: translateX(-50%); width: 56px; height: 56px; display: grid; place-items: center; }
.hx-interact svg.hx-hold { position: absolute; inset: 0; transform: rotate(-90deg); }
.hx-interact .hx-hold circle { fill: none; stroke-width: 2.5; stroke-linecap: round; }
.hx-interact .hx-hold .bg { stroke: rgba(255,255,255,0.14); }
.hx-interact .hx-hold .fg { stroke: var(--hx-cyan); stroke-dasharray: 163; stroke-dashoffset: 163; transition: stroke-dashoffset 80ms linear; filter: drop-shadow(0 0 4px rgba(25,200,216,0.7)); }
.hx-interact .hx-key { min-width: 26px; height: 26px; font-size: 13px; }

.hx-prompt { left: 50%; bottom: 110px; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 16px 22px 14px; }
.hx-prompt-title { display: flex; align-items: center; gap: 10px; font: 600 13px/1 var(--hx-font); letter-spacing: 0.22em; text-transform: uppercase; color: var(--hx-fg); }
.hx-prompt-title .hx-ic { color: var(--hx-cyan); }
.hx-legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 16px; max-width: 560px; }
.hx-legend span { display: inline-flex; align-items: center; gap: 6px; font: 11px/1 var(--hx-font); letter-spacing: 0.1em; text-transform: uppercase; color: var(--hx-dim); }
.hx-legend .hx-key + .hx-key { margin-left: -3px; }
.hx-note { font: 11px/1.4 var(--hx-font); color: var(--hx-dim); letter-spacing: 0.06em; text-align: center; max-width: 420px; }

.hx-band { left: 0; right: 0; top: 40%; transform: translateY(-50%); padding: 28px 0; text-align: center; background: linear-gradient(90deg, rgba(6,8,14,0) 0%, rgba(6,8,14,0.85) 20%, rgba(6,8,14,0.85) 80%, rgba(6,8,14,0) 100%); }
.hx-band::before, .hx-band::after { content: ""; position: absolute; left: 20%; right: 20%; height: 1px; background: linear-gradient(90deg, transparent, var(--hx-band-color), transparent); }
.hx-band::before { top: 0; } .hx-band::after { bottom: 0; }
.hx-band-title { display: flex; justify-content: center; align-items: center; gap: 16px; font: 600 28px/1 var(--hx-font); letter-spacing: 0.34em; text-transform: uppercase; color: var(--hx-band-color); text-shadow: 0 0 18px color-mix(in srgb, var(--hx-band-color) 60%, transparent); }
.hx-band-sub { margin-top: 14px; display: flex; justify-content: center; align-items: center; gap: 8px; font: 11px/1 var(--hx-font); letter-spacing: 0.18em; text-transform: uppercase; color: var(--hx-dim); }
.hx-band[data-kind="failed"] { --hx-band-color: var(--hx-red); }
.hx-band[data-kind="complete"] { --hx-band-color: #6be3a0; }
`;

function el(cls: string, html = ''): HTMLDivElement {
  const node = document.createElement('div');
  node.className = `hx ${cls}`;
  if (html) node.innerHTML = html;
  return node;
}

export function createOperatorHud(ui: UIHost): OperatorHud {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const vignette = el('hx-vignette');
  const dot = el('hx-dot');
  const ring = el('hx-ring');
  const hitMarker = el('hx-hit', '<span></span><span></span><span></span><span></span>');

  const vitals = el(
    'hx-vitals hx-panel',
    `${icon('heart', 16, 'hx-heart')}<div class="hx-track"><div class="hx-fill" data-kind="health"></div></div>` +
      `${icon('eye', 16)}<div class="hx-track"><div class="hx-fill" data-kind="lit"></div></div>`,
  );
  const heartIcon = vitals.querySelector('.hx-heart') as SVGElement;
  const healthFill = vitals.querySelector('[data-kind="health"]') as HTMLElement;
  const litFill = vitals.querySelector('[data-kind="lit"]') as HTMLElement;

  const stance = el('hx-stance hx-panel', icon('stand', 26));

  const ammo = el(
    'hx-ammo hx-panel',
    `<div class="hx-ammo-mag">${icon('mag', 20)}<svg class="hx-reload" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18"/></svg></div>` +
      `<div><span class="hx-ammo-digits">30</span><span class="hx-ammo-reserve">/ 120</span></div>`,
  );
  const ammoDigits = ammo.querySelector('.hx-ammo-digits') as HTMLElement;
  const ammoReserve = ammo.querySelector('.hx-ammo-reserve') as HTMLElement;
  const reloadArc = ammo.querySelector('.hx-reload circle') as SVGCircleElement;

  const alert = el('hx-alert', icon('eyeOff', 18));
  alert.style.color = ALERT.undetected.color;

  const score = el('hx-score hx-panel', `<span>${icon('skull', 15)}<b class="hx-kills">0</b></span><span>${icon('people', 15)}<b class="hx-left">0</b></span>`);
  const killsEl = score.querySelector('.hx-kills') as HTMLElement;
  const leftEl = score.querySelector('.hx-left') as HTMLElement;

  const objective = el('hx-objective hx-panel', `${icon('flag', 20, 'hx-obj-ic')}<div><div class="hx-objective-label"></div><div class="hx-objective-steps"></div></div><div class="hx-chip"></div>`);
  const objectiveIconSlot = objective.querySelector('.hx-obj-ic') as SVGElement;
  const objectiveLabel = objective.querySelector('.hx-objective-label') as HTMLElement;
  const objectiveSteps = objective.querySelector('.hx-objective-steps') as HTMLElement;
  const objectiveChip = objective.querySelector('.hx-chip') as HTMLElement;

  const interact = el('hx-interact', `<svg class="hx-hold" viewBox="0 0 56 56"><circle class="bg" cx="28" cy="28" r="26"/><circle class="fg" cx="28" cy="28" r="26"/></svg>${key('F')}`);
  const holdArc = interact.querySelector('.fg') as SVGCircleElement;
  interact.hidden = true;

  const prompt = el(
    'hx-prompt hx-panel',
    `<div class="hx-prompt-title">${icon('mouse', 18)}click to play</div>` +
      `<div class="hx-legend">` +
      `<span>${key('W')}${key('A')}${key('S')}${key('D')} move</span>` +
      `<span>${key('Shift')} sprint</span>` +
      `<span>${key('Space')} jump</span>` +
      `<span>${key('C')} crouch</span>` +
      `<span>${key('X')} prone</span>` +
      `<span>${key('LMB')} fire</span>` +
      `<span>${key('RMB')} aim</span>` +
      `<span>${key('R')} reload</span>` +
      `<span>${key('F')} interact</span>` +
      `</div><div class="hx-note" hidden></div>`,
  );
  const promptNote = prompt.querySelector('.hx-note') as HTMLElement;
  const promptTitle = prompt.querySelector('.hx-prompt-title') as HTMLElement;

  const failed = el('hx-band', `<div class="hx-band-title">${icon('skull', 28)}mission failed</div><div class="hx-band-sub">${key('Enter')} retry from checkpoint</div>`);
  failed.dataset['kind'] = 'failed';
  failed.hidden = true;
  const complete = el('hx-band', `<div class="hx-band-title">${icon('check', 28)}mission complete</div>`);
  complete.dataset['kind'] = 'complete';
  complete.hidden = true;

  const all = [vignette, dot, ring, hitMarker, vitals, stance, ammo, alert, score, objective, interact, prompt, failed, complete];
  for (const node of all) ui.mount('hud', node);

  let lastRadius = -1;
  let lastAlert = '';
  let lastStance = '';
  let lastX = 0;
  let lastY = 0;
  let lastAmmo = '';
  let lastObjective = '';
  let hitTimer = 0;

  return {
    setLocked(locked, note = null) {
      prompt.hidden = locked;
      const hasNote = note !== null;
      promptNote.hidden = !hasNote;
      if (hasNote && promptNote.textContent !== note) promptNote.textContent = note;
      promptTitle.style.display = hasNote ? 'none' : '';
      const opacity = locked ? '1' : '0.35';
      dot.style.opacity = opacity;
      ring.style.opacity = opacity;
    },
    setAiming(aiming) {
      ring.dataset['aim'] = aiming ? '1' : '0';
    },
    setReticle(dx, dy, blocked) {
      const x = Math.round(dx);
      const y = Math.round(dy);
      if (x !== lastX || y !== lastY) {
        lastX = x;
        lastY = y;
        const t = `translate(${x}px, ${y}px)`;
        dot.style.transform = t;
        ring.style.transform = t;
        hitMarker.style.transform = t;
      }
      const flag = blocked ? '1' : '0';
      if (ring.dataset['blocked'] !== flag) {
        ring.dataset['blocked'] = flag;
        dot.style.background = blocked ? '#ff2b5a' : 'rgba(255,255,255,0.92)';
      }
    },
    setSpread(radiusPx) {
      const radius = Math.max(RING_MIN_PX, Math.round(radiusPx));
      if (radius === lastRadius) return;
      lastRadius = radius;
      const size = `${radius * 2}px`;
      ring.style.width = size;
      ring.style.height = size;
      ring.style.margin = `-${radius}px 0 0 -${radius}px`;
    },
    hit() {
      // Restart the flash even when one is mid-way.
      hitMarker.dataset['flash'] = '0';
      window.clearTimeout(hitTimer);
      hitTimer = window.setTimeout(() => {
        hitMarker.dataset['flash'] = '1';
      }, 0);
    },
    setAmmo(rounds, reserve, reloading, reloadProgress) {
      const state = `${rounds}|${reserve}|${reloading ? 1 : 0}`;
      if (state !== lastAmmo) {
        lastAmmo = state;
        ammoDigits.textContent = String(rounds);
        ammoReserve.textContent = `/ ${reserve}`;
        ammo.dataset['empty'] = rounds === 0 && !reloading ? '1' : '0';
        ammo.dataset['reloading'] = reloading ? '1' : '0';
      }
      if (reloading) reloadArc.style.strokeDashoffset = String(113 * (1 - reloadProgress));
    },
    setHealth(value, hurt) {
      healthFill.style.transform = `scaleX(${Math.max(0, Math.min(1, value)).toFixed(3)})`;
      heartIcon.dataset['hot'] = value < 0.35 && value > 0 ? '1' : '0';
      vignette.style.opacity = hurt.toFixed(3);
    },
    setVisibility(lit) {
      litFill.style.transform = `scaleX(${Math.max(0, Math.min(1, lit)).toFixed(3)})`;
    },
    setAlert(level) {
      if (level === lastAlert) return;
      lastAlert = level;
      const spec = ALERT[level];
      alert.innerHTML = icon(spec.icon, 18);
      alert.style.color = spec.color;
      alert.style.borderColor = spec.color;
      alert.style.boxShadow = level === 'undetected' ? 'none' : `0 0 14px ${spec.color}66`;
      alert.dataset['level'] = level;
    },
    setStatus(stanceNow) {
      if (stanceNow === lastStance) return;
      lastStance = stanceNow;
      stance.innerHTML = icon(stanceNow === 'stand' ? 'stand' : stanceNow === 'crouch' ? 'crouch' : 'prone', 26);
    },
    setScore(_hits, kills, enemiesLeft) {
      killsEl.textContent = String(kills);
      leftEl.textContent = String(enemiesLeft);
    },
    setObjective(index, total, kind, label, distance, progress, promptText) {
      const state = `${index}|${total}|${kind}|${label}`;
      if (state !== lastObjective) {
        lastObjective = state;
        objectiveIconSlot.outerHTML = icon(label && kind ? OBJECTIVE_ICON[kind] : 'check', 20, 'hx-obj-ic');
        objectiveLabel.textContent = label ?? 'complete';
        objectiveSteps.innerHTML = Array.from({ length: total }, (_, i) => `<i${i < index || !label ? ' data-done="1"' : i === index ? ' data-now="1"' : ''}></i>`).join('');
      }
      objectiveChip.textContent = label ? `${distance.toFixed(0)} m` : '';
      objectiveChip.hidden = !label;
      interact.hidden = promptText === null;
      if (promptText !== null) holdArc.style.strokeDashoffset = String(163 * (1 - progress));
    },
    setFailed(visible) {
      failed.hidden = !visible;
    },
    setComplete(visible) {
      complete.hidden = !visible;
    },
    dispose() {
      window.clearTimeout(hitTimer);
      for (const node of all) ui.unmount(node);
      style.remove();
    },
  };
}
