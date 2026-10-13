export const DELIVERABLE_PREVIEW_PATH = '/__agnes/deliverable-preview'

/**
 * The document an HTML deliverable is shown in. A deliverable is a page the model wrote, with its
 * own styles and scripts, so it cannot be shown inside the workbench: the workbench's policy would
 * strip both, and relaxing that policy is not an option. This frame is a separate opaque-origin
 * document instead (`sandbox allow-scripts`, never `allow-same-origin`): the page runs, but it has no
 * cookies, no storage, no access to the workbench, and no network — every fetch directive is `'none'`
 * or limited to bytes the page already carries (`data:`, `blob:`).
 *
 * The frame holds no deliverable itself. The workbench hands it the page text once, by message, and
 * the bootstrap replaces the document with it; the policy stays with the document.
 */
export function deliverablePreviewFrame(): { body: string; csp: string } {
  const csp =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; " +
    "media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; " +
    "frame-src 'none'; object-src 'none'; sandbox allow-scripts"
  const bootstrap = `
addEventListener('message', function once(event) {
  if (event.source !== parent || event.data?.type !== 'agnes-preview-html' || typeof event.data.html !== 'string') return;
  removeEventListener('message', once);
  document.open();
  document.write(event.data.html);
  document.close();
});
parent.postMessage({ type: 'agnes-preview-ready' }, '*');
`
  return {
    csp,
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body><script>${bootstrap}</script></body></html>`,
  }
}
