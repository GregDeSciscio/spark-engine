/** The one stylesheet the UI module injects. Themed through CSS variables on the root. */
export const UI_STYLE_ID = 'spark-ui-style';

export const UI_THEME_DEFAULTS: Readonly<Record<string, string>> = {
  '--spark-ui-font': '12px/1.45 ui-monospace, Menlo, Consolas, monospace',
  '--spark-ui-fg': '#e6ecff',
  '--spark-ui-fg-dim': 'rgba(230, 236, 255, 0.6)',
  '--spark-ui-bg': 'rgba(8, 10, 16, 0.72)',
  '--spark-ui-border': 'rgba(255, 255, 255, 0.12)',
  '--spark-ui-accent': '#6fc3ff',
  '--spark-ui-health': '#ff5a3a',
  '--spark-ui-stamina': '#9dff6b',
  '--spark-ui-radius': '4px',
  '--spark-ui-scrim': 'rgba(4, 6, 12, 0.6)',
};

export const UI_STYLESHEET = `
.spark-ui-root { position: absolute; inset: 0; overflow: hidden; pointer-events: none; font: var(--spark-ui-font); color: var(--spark-ui-fg); user-select: none; -webkit-user-select: none; }
.spark-ui-layer { position: absolute; inset: 0; pointer-events: none; }
.spark-ui-layer[data-capture] { pointer-events: auto; }
.spark-ui-layer[hidden] { display: none !important; }
.spark-ui-layer[data-layer="menu"], .spark-ui-layer[data-layer="modal"] { background: var(--spark-ui-scrim); }

.spark-panel { position: absolute; padding: 10px 12px; background: var(--spark-ui-bg); border: 1px solid var(--spark-ui-border); border-radius: var(--spark-ui-radius); min-width: 160px; }
.spark-panel[data-anchor="top-left"] { top: 12px; left: 12px; }
.spark-panel[data-anchor="top-right"] { top: 12px; right: 12px; }
.spark-panel[data-anchor="bottom-left"] { bottom: 12px; left: 12px; }
.spark-panel[data-anchor="bottom-right"] { bottom: 12px; right: 12px; }
.spark-panel[data-anchor="center"] { top: 50%; left: 50%; transform: translate(-50%, -50%); }
.spark-panel-title { font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; font-size: 11px; color: var(--spark-ui-fg-dim); margin-bottom: 8px; }
.spark-panel > * + * { margin-top: 6px; }

.spark-text { white-space: pre; }
.spark-text[data-dim] { color: var(--spark-ui-fg-dim); }

.spark-bar { display: grid; grid-template-columns: 64px 1fr 40px; align-items: center; gap: 8px; }
.spark-bar-label { color: var(--spark-ui-fg-dim); }
.spark-bar-track { position: relative; height: 8px; background: rgba(255,255,255,0.08); border-radius: 4px; overflow: hidden; }
.spark-bar-fill { position: absolute; inset: 0; transform-origin: left center; background: var(--spark-bar-color, var(--spark-ui-accent)); transition: transform 80ms linear; }
.spark-bar-value { text-align: right; font-variant-numeric: tabular-nums; }

.spark-label { position: absolute; left: 0; top: 0; will-change: transform; white-space: nowrap; text-align: center; }
.spark-label[hidden] { display: none !important; }
.spark-label-name { font-size: 11px; color: var(--spark-ui-fg); text-shadow: 0 1px 2px rgba(0,0,0,0.9); }
.spark-label-track { width: 48px; height: 5px; margin: 2px auto 0; background: rgba(0,0,0,0.6); border: 1px solid rgba(0,0,0,0.6); border-radius: 3px; overflow: hidden; }
.spark-label-fill { height: 100%; transform-origin: left center; background: var(--spark-ui-health); }
.spark-label-text { font-size: 12px; text-shadow: 0 1px 2px rgba(0,0,0,0.9); }
.spark-popup { font-weight: 700; font-size: 16px; text-shadow: 0 1px 3px rgba(0,0,0,0.9); animation: spark-popup-fade linear forwards; }
@keyframes spark-popup-fade { 0% { opacity: 0; } 10% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; } }

.spark-menu { display: grid; gap: 8px; min-width: 240px; }
.spark-menu-item { padding: 8px 12px; background: rgba(255,255,255,0.06); border: 1px solid var(--spark-ui-border); border-radius: var(--spark-ui-radius); cursor: pointer; }
.spark-menu-item:hover { background: rgba(255,255,255,0.12); border-color: var(--spark-ui-accent); }
`;

/** Insert the stylesheet once per document. */
export function ensureStylesheet(doc: Document = document): HTMLStyleElement {
  const existing = doc.getElementById(UI_STYLE_ID);
  if (existing instanceof HTMLStyleElement) return existing;
  const style = doc.createElement('style');
  style.id = UI_STYLE_ID;
  style.textContent = UI_STYLESHEET;
  doc.head.appendChild(style);
  return style;
}
