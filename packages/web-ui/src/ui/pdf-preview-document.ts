import { documentHtmlTemplate } from '../conversation/document-preview-policy.js'

/** Mount only this fixed UI in the opaque offline viewer, never authored HTML. */
export function initializePdfPreviewDocument(): void {
  const template = documentHtmlTemplate(
    '<style>[hidden]{display:none!important}body{margin:0;background:#eee;color:#222;font:14px system-ui}nav{position:sticky;top:0;display:flex;justify-content:center;align-items:center;gap:12px;padding:8px;background:#eee}button{font:inherit;padding:4px 12px}canvas{display:block;max-width:100%;height:auto;margin:auto;background:white}p{padding:12px}</style><nav><button id="previous" disabled>←</button><span id="page" role="status"></span><button id="next" disabled>→</button></nav><canvas role="img"></canvas><p id="error" role="alert" hidden></p>',
  )
  document.body.replaceChildren(template.content)
}
