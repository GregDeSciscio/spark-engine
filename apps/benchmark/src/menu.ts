import { QUALITY_PRESETS } from '@spark/engine';
import { SCENE_ENTRIES } from './scenes/registry';

/**
 * The launcher, shown at the bare root URL when no `scene` parameter is
 * present. Plain DOM and CSS with no engine dependency: nothing here boots a
 * renderer, so the page stays instant and the capture / perf / visual tools —
 * which always pass `scene=` explicitly — never reach it.
 */

const BACKENDS = [
  { value: 'auto', label: 'Auto' },
  { value: 'webgpu', label: 'WebGPU' },
  { value: 'webgl', label: 'WebGL2' },
] as const;

const CSS = `
.menu { position: absolute; inset: 0; overflow-y: auto; background: #05060a;
  color: #d8e0ff; font: 14px/1.6 ui-monospace, Consolas, monospace; padding: 48px 32px 64px; }
.menu-inner { max-width: 1080px; margin: 0 auto; }
.menu h1 { margin: 0; font-size: 28px; font-weight: 600; letter-spacing: 0.02em; }
.menu .tagline { margin: 8px 0 0; color: #9aa4bd; max-width: 60ch; }
.menu .warn { margin-top: 20px; padding: 12px 14px; border: 1px solid #6b4a1f;
  background: #1a1206; color: #f0c98a; border-radius: 6px; }
.menu .options { display: flex; flex-wrap: wrap; gap: 24px; margin: 28px 0 8px;
  padding: 16px 18px; border: 1px solid #1c2233; border-radius: 8px; background: #080a11; }
.menu .field { display: flex; flex-direction: column; gap: 6px; }
.menu .field > span { color: #9aa4bd; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; }
.menu select { font: inherit; color: #d8e0ff; background: #10141f; border: 1px solid #262d40;
  border-radius: 5px; padding: 7px 10px; min-width: 200px; cursor: pointer; }
.menu select:hover { border-color: #3a445e; }
.menu select:focus-visible { outline: 2px solid #5a7cff; outline-offset: 1px; }
.menu .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px; margin-top: 20px; }
.menu .card { display: flex; flex-direction: column; gap: 8px; text-align: left; cursor: pointer;
  font: inherit; color: inherit; text-decoration: none; padding: 0 0 18px; border: 1px solid #1c2233; border-radius: 8px;
  background: #0a0d15; overflow: hidden; transition: border-color 120ms, background 120ms, transform 120ms; }
.menu .card > :not(.thumb) { margin-left: 20px; margin-right: 20px; }
.menu .card > h2 { margin-top: 16px; }
.menu .thumb { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover;
  background: #06080e; border-bottom: 1px solid #1c2233; }
.menu .thumb[hidden] { display: none; }
.menu .card:hover { border-color: #3f4c6e; background: #0e1220; transform: translateY(-2px); }
.menu .card:focus-visible { outline: 2px solid #5a7cff; outline-offset: 2px; }
.menu .card.featured { grid-column: 1 / -1; background: linear-gradient(160deg, #2a1330 0%, #131a2e 45%, #0a0d15 80%);
  border-color: #4a2f5e; }
.menu .card.featured:hover { border-color: #7a4f8f; }
@media (min-width: 760px) {
  .menu .card.featured { display: grid; grid-template-columns: minmax(0, 420px) minmax(0, 1fr);
    grid-template-rows: repeat(2, auto); align-content: center; column-gap: 20px; padding: 0 20px 0 0; }
  .menu .card.featured > :not(.thumb) { grid-column: 2; margin-left: 0; margin-right: 0; }
  .menu .card.featured .thumb { grid-row: 1 / -1; height: 100%; border-bottom: none;
    border-right: 1px solid #2c3757; }
  .menu .card.featured > h2 { margin-top: 24px; align-self: end; }
  .menu .card.featured > p:last-child { margin-bottom: 24px; }
}
.menu .card h2 { margin: 0; font-size: 16px; font-weight: 600; }
.menu .card.featured h2 { font-size: 20px; }
.menu .badge { display: inline-block; margin-left: 10px; padding: 2px 8px; border-radius: 999px;
  font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #a8c0ff;
  background: #1b2440; border: 1px solid #2f3d63; vertical-align: 2px; }
.menu .card p { margin: 0; color: #9aa4bd; }
.menu footer { margin-top: 28px; color: #6f7b96; font-size: 12px; }
.menu a { color: #8fa6ff; }
@media (max-width: 640px) { .menu { padding: 28px 18px 48px; } }
`;

function field(label: string, select: HTMLSelectElement): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  wrap.append(span, select);
  return wrap;
}

function selector(options: readonly { value: string; label: string }[], initial: string): HTMLSelectElement {
  const select = document.createElement('select');
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    select.append(el);
  }
  select.value = initial;
  return select;
}

/** Render the launcher into `container`. Returns a teardown function. */
export function renderMenu(container: HTMLElement): () => void {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const root = document.createElement('div');
  root.className = 'menu';
  const inner = document.createElement('div');
  inner.className = 'menu-inner';
  root.append(inner);

  const title = document.createElement('h1');
  title.textContent = 'Spark Engine';
  const tagline = document.createElement('p');
  tagline.className = 'tagline';
  tagline.textContent = 'A WebGPU-first browser engine on Three.js.';
  inner.append(title, tagline);

  if (typeof navigator !== 'undefined' && !('gpu' in navigator)) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent =
      'This browser has no WebGPU. Scenes will fall back to WebGL2 with some effects disabled — Chrome or Edge 113+ shows them as intended.';
    inner.append(warn);
  }

  const presetSelect = selector(
    QUALITY_PRESETS.map((p) => ({ value: p, label: p })),
    'high',
  );
  const backendSelect = selector(BACKENDS, 'auto');
  const options = document.createElement('div');
  options.className = 'options';
  options.append(field('Quality preset', presetSelect), field('Backend', backendSelect));
  inner.append(options);

  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const entry of SCENE_ENTRIES) {
    // A scene card is a button that sets the URL; a link card (the showcase app) is an anchor.
    const card = entry.href ? document.createElement('a') : document.createElement('button');
    if (card instanceof HTMLAnchorElement) card.href = entry.href as string;
    else card.type = 'button';
    card.className = entry.featured ? 'card featured' : 'card';

    // Thumbnails are generated by `pnpm thumbnails`. If one is missing the card
    // still reads correctly, so a new scene is never blocked on regenerating them.
    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.src = `thumbs/${entry.key}.jpg`;
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.decoding = 'async';
    thumb.width = 640;
    thumb.height = 360;
    thumb.addEventListener('error', () => {
      thumb.hidden = true;
    });
    card.append(thumb);

    const heading = document.createElement('h2');
    heading.textContent = entry.title;
    if (entry.featured) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = entry.href ? 'Play it' : 'Start here';
      heading.append(badge);
    }

    const blurb = document.createElement('p');
    blurb.textContent = entry.blurb;

    card.append(heading, blurb);
    const definition = entry.definition;
    if (definition) {
      card.addEventListener('click', () => {
        const params = new URLSearchParams({
          scene: definition.name,
          preset: presetSelect.value,
        });
        if (backendSelect.value !== 'auto') params.set('backend', backendSelect.value);
        location.search = params.toString();
      });
    }
    grid.append(card);
  }
  inner.append(grid);

  const footer = document.createElement('footer');
  footer.textContent = 'F2 opens the inspector. Every option is also a URL parameter.';
  inner.append(footer);

  container.append(root);
  return () => {
    root.remove();
    style.remove();
  };
}
