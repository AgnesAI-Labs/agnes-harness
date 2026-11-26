import type { IncomingMessage, ServerResponse } from 'node:http'

export const PDF_PREVIEW_PATH = '/__agnes/pdf-preview'

/** Trusted offline PDF.js in an opaque frame; PDF bytes arrive only from the authorized parent. */
export function pdfPreviewFrame(): { body: string; csp: string } {
  return {
    csp:
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; font-src blob: data:; img-src blob: data:; " +
      "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'; sandbox allow-scripts",
    body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body><script src="/vendor/pdf-preview.js"></script></body></html>',
  }
}

export function servePdfPreview(request: IncomingMessage, response: ServerResponse): boolean {
  if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== PDF_PREVIEW_PATH) return false
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end()
    return true
  }
  const frame = pdfPreviewFrame()
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
