import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { UI_COMPONENT_FRAME_PATH } from '@agnes/protocol/intelligent-ui'

export { UI_COMPONENT_FRAME_PATH, UI_COMPONENT_MODULE_BYTES } from '@agnes/protocol/intelligent-ui'

/** Bootstrap on either workbench origin. The URL and document carry no session capability. */
export function serveUiComponentFrame(request: IncomingMessage, response: ServerResponse): boolean {
  if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== UI_COMPONENT_FRAME_PATH) return false
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end()
    return true
  }
  const frame = uiComponentFrame()
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': frame.csp,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(request.method === 'HEAD' ? undefined : frame.body)
  return true
}

const lockdown = `for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker']) {
  Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false });
}`

function uiComponentFrame(): { body: string; csp: string } {
  const nonce = randomBytes(16).toString('base64')
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'; sandbox allow-scripts`
  const loadRenderers = `
    const renderers = await new Promise((resolve, reject) => {
      document.addEventListener('agnes-ui-renderers', (event) => resolve(event.detail), { once: true });
      const script = document.importNode(template.content.firstElementChild, true);
      script.nonce = nonce;
      script.addEventListener('error', reject, { once: true });
      script.textContent = event.data.source + "\\n;document.dispatchEvent(new CustomEvent('agnes-ui-renderers', { detail: renderers }));";
      document.body.append(script);
      // Inline CSP authorization happens on insertion. Module evaluation happens later.
      script.nonce = '';
      script.removeAttribute('nonce');
      script.remove();
    });`
  const bootstrap = `
;(() => {
const nonce = ${JSON.stringify(nonce)};
document.currentScript?.remove();
const style = document.querySelector('style');
style.nonce = '';
style.removeAttribute('nonce');
const template = document.getElementById('renderer-module'); template.remove();
${lockdown}
const send = (type, detail = {}) => parent.postMessage({ type, ...detail }, '*');
addEventListener('error', () => send('agnes-ui-error'));
addEventListener('unhandledrejection', () => send('agnes-ui-error'));
let dispose;
addEventListener('message', async function initialize(event) {
  if (event.source !== parent || event.data?.type !== 'agnes-ui-init' || typeof event.data.source !== 'string') return;
  removeEventListener('message', initialize);
  const { kind, props, theme, locale } = event.data;
  const mount = document.getElementById('mount');
  document.documentElement.style.colorScheme = theme;
  const api = Object.freeze({ emitAction: (id) => send('agnes-ui-action', { id }), readTheme: () => theme, readLocale: () => locale });
  try {
    ${loadRenderers}
    if (typeof renderers?.[kind] !== 'function') throw new Error('missing renderer');
    dispose = await renderers[kind](mount, props, api);
    send('agnes-ui-ready');
  } catch { send('agnes-ui-error'); }
});
addEventListener('pagehide', () => { try { dispose?.(); } catch {} });
send('agnes-ui-loaded');
})();
`
  const template = '<template id="renderer-module"><script type="module"></script></template>'
  return {
    csp,
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style nonce="${nonce}">@layer ui {body{margin:0;font:14px system-ui;color:CanvasText;background:Canvas}button{font:inherit}table{border-collapse:collapse;width:100%}th,td{text-align:start;padding:.4em}button:focus-visible{outline:2px solid Highlight}body{color-scheme:light dark}}</style></head><body><div id="mount"></div>${template}<script nonce="${nonce}">${bootstrap}</script></body></html>`,
  }
}
