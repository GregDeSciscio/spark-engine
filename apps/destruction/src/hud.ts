import type { SandboxStats } from './scene';

/** A plain DOM readout of the solver and debris counters, plus the crosshair. */
export class Hud {
  private readonly root: HTMLDivElement;
  private readonly text: HTMLPreElement;
  private readonly cross: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.style.cssText =
      'position:absolute;left:12px;bottom:12px;padding:10px 12px;background:rgba(14,18,24,.72);color:#e9eef3;font:12px/1.45 ui-monospace,Consolas,monospace;border-radius:6px;pointer-events:none;white-space:pre;z-index:5';
    this.text = document.createElement('pre');
    this.text.style.margin = '0';
    this.root.append(this.text);
    this.cross = document.createElement('div');
    this.cross.style.cssText =
      'position:absolute;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;border:2px solid rgba(255,255,255,.85);border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.35);pointer-events:none;z-index:5';
    parent.append(this.root, this.cross);
  }

  /** The controls line always; the solver and debris counters with the engine's stats panel (the backquote key). */
  render(s: SandboxStats, weapon: string, locked: boolean, counters: boolean): void {
    const ms = (v: number | undefined): string => (v === undefined ? '–' : `${v.toFixed(1)} ms`);
    const t = s.last?.timing;
    const controls = `${weapon}    ${locked ? 'mouse look (F to leave)' : 'click fires at the cursor · right-drag looks · F mouse look'}    heat ${s.heat ? 'ON' : 'off'} (H)    \` stats`;
    if (!counters) {
      this.text.textContent = controls;
      this.cross.style.display = locked ? 'block' : 'none';
      return;
    }
    this.text.textContent = [
      controls,
      `chunks ${s.standing}/${s.chunks} standing · ${s.contacts} contacts · ${s.dof} DOF · strain in ${s.strainMode}`,
      `first solve ${ms(s.init?.timing.totalMs)} (order ${ms(s.init?.timing.orderMs)}, factor ${ms(s.init?.timing.factorMs)})`,
      `last step  ${ms(t?.totalMs)} ${s.last?.mode ?? ''} ${s.last?.region ?? 0} chunks (factor ${ms(t?.factorMs)}) · broke ${s.last?.broken.length ?? 0} · worst ${(s.last?.worst ?? 0).toFixed(2)}`,
      `cascade    ${s.cascading ? 'RUNNING' : 'at rest'} · ${s.cascadeSteps} steps · ${s.cascadeMs.toFixed(0)} ms solving`,
      `debris     ${s.bodies} loose (${s.sleeping} asleep) · made ${s.debris.created} · shattered ${s.debris.shattered} · settled ${s.debris.piled} · cleared ${s.debris.cleared}`,
      `hinges     ${s.hinges.links} holding (${s.hinges.live} live) · formed ${s.hinges.formed} · torn ${s.hinges.torn} · ropes ${s.ropes}/2`,
      `smoke      ${s.smoke.clouds} clouds · ${s.smoke.voxels} voxels`,
    ].join('\n');
    // The crosshair only means something in mouse look; otherwise the cursor aims.
    this.cross.style.display = locked ? 'block' : 'none';
  }

  dispose(): void {
    this.root.remove();
    this.cross.remove();
  }
}
