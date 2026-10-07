import { parentPort, workerData } from 'node:worker_threads'

// The shipped engine and language data are local; a parser must never fetch a URL from a document.
globalThis.fetch = async () => {
  throw new Error('Document parsing is offline.')
}
try {
  const { parseDocument } = await import('./runtime/engine.mjs')
  const result = await parseDocument(
    new Uint8Array(workerData.bytes),
    workerData.args,
    new URL('./runtime/assets/', import.meta.url),
  )
  parentPort.postMessage({ ok: true, result }, result.image ? [result.image.buffer] : [])
} catch (error) {
  parentPort.postMessage({
    ok: false,
    code:
      error?.code === 'ERR_MODULE_NOT_FOUND'
        ? 'DOCUMENT_RUNTIME_UNAVAILABLE'
        : (error?.code ?? 'DOCUMENT_UNREADABLE'),
    message: (error?.code === 'ERR_MODULE_NOT_FOUND'
      ? 'Document parser payload is missing. Use the normal development entry point or reinstall the release plugin.'
      : String(error?.message ?? error)
    )
      // biome-ignore lint/suspicious/noControlCharactersInRegex: sanitize parser diagnostics for tool output.
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .slice(0, 300),
  })
}
