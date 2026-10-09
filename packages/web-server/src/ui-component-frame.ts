import { randomBytes } from 'node:crypto'

export const UI_COMPONENT_MODULE_BYTES = 262144

/** A separate opaque-origin document; the workbench's CSP is never relaxed. */
export function uiComponentFrame(source: string): { body: string; csp: string } {
  const nonce = randomBytes(16).toString('base64')
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; sandbox allow-scripts`
  const bootstrap = `
;(() => {
const send = (type, detail = {}) => parent.postMessage({ type, ...detail }, '*');
addEventListener('error', () => send('agnes-ui-error'));
addEventListener('unhandledrejection', () => send('agnes-ui-error'));
let dispose;
let started = false;
addEventListener('message', async (event) => {
  if (event.source !== parent || event.data?.type !== 'agnes-ui-init' || started) return;
  started = true;
  const { kind, props, theme, locale } = event.data;
  const mount = document.getElementById('mount');
  document.documentElement.style.colorScheme = theme;
  const api = Object.freeze({ emitAction: (id) => send('agnes-ui-action', { id }), readTheme: () => theme, readLocale: () => locale });
  try {
    if (typeof renderers?.[kind] !== 'function') throw new Error('missing renderer');
    dispose = await renderers[kind](mount, props, api);
    send('agnes-ui-ready');
  } catch { send('agnes-ui-error'); }
});
addEventListener('pagehide', () => { try { dispose?.(); } catch {} });
send('agnes-ui-loaded');
})();
`
  // Source is immutable reviewed code, never model data. Escaping prevents a JS string/comment
  // containing an HTML end tag from terminating the script element.
  const lockdown = `;(() => {
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker']) {
      Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false });
    }
  })();
`
  const code = (lockdown + source + bootstrap).replace(/<\/script/gi, '<\\/script')
  return {
    csp,
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style nonce="${nonce}">body{margin:0;font:14px system-ui;color:CanvasText;background:Canvas}button{font:inherit}table{border-collapse:collapse;width:100%}th,td{text-align:start;padding:.4em}button:focus-visible{outline:2px solid Highlight}body{color-scheme:light dark}</style></head><body><div id="mount"></div><script type="module" nonce="${nonce}">${code}</script></body></html>`,
  }
}
