import type { SliceStats } from './scene';

/** The slice's readout: health, bots, weapon, the structures and the navmesh, and a line for checkpoints. */
export class Hud {
  private readonly root: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly note: HTMLDivElement;
  private noteTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.style.cssText = 'position:absolute;left:12px;top:12px;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;color:#f4f1ea;text-shadow:0 1px 2px #000a;pointer-events:none;white-space:pre';
    this.status = document.createElement('div');
    this.note = document.createElement('div');
    this.note.style.cssText = 'margin-top:8px;color:#ffd27a';
    const help = document.createElement('div');
    help.style.cssText = 'margin-top:8px;opacity:0.7';
    help.textContent = 'WASD move · Space jump · click to aim · LMB fire\n1 rocket · 2 rifle · 3 gas · F5 save · F9 load';
    this.root.append(this.status, this.note, help);
    const crosshair = document.createElement('div');
    crosshair.style.cssText = 'position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:#fff;box-shadow:0 0 2px #000;pointer-events:none';
    parent.append(this.root, crosshair);
    this.crosshair = crosshair;
  }

  private readonly crosshair: HTMLDivElement;

  render(s: SliceStats): void {
    const alive = s.bots.filter((b) => b.alive).length;
    const buildings = s.structures.map((x) => `${x.name} ${Math.round((100 * x.standing) / x.chunks)}%`).join('  ');
    this.status.textContent = [
      `health ${Math.max(0, Math.round(s.player.health))}   bots ${alive}/${s.bots.length}   ${s.weapon}`,
      buildings,
      `debris ${s.budgets.bodies}/${s.budgets.bodyLimit}   navmesh tiles waiting ${s.nav.pendingTiles}`,
    ].join('\n');
  }

  flash(text: string): void {
    this.note.textContent = text;
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => (this.note.textContent = ''), 2000);
  }

  dispose(): void {
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.root.remove();
    this.crosshair.remove();
  }
}
