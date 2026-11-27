import { initializePdfPreviewDocument } from '@agnes/web-ui/pdf-preview-document'
import { getDocument } from 'pdfjs-dist/build/pdf.mjs'
import { WorkerMessageHandler } from 'pdfjs-dist/build/pdf.worker.mjs'

initializePdfPreviewDocument()

globalThis.pdfjsWorker = { WorkerMessageHandler }
const decode = (base64) => Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
class OfflineBinaryData {
  async fetch({ kind, filename }) {
    const key = `${kind}/${filename}`
    if (!Object.hasOwn(__AGNES_PDF_RESOURCES__, key)) throw Error('unsupported PDF resource')
    return decode(__AGNES_PDF_RESOURCES__[key])
  }
}

const previous = document.getElementById('previous')
const next = document.getElementById('next')
const counter = document.getElementById('page')
const canvas = document.querySelector('canvas')
const error = document.getElementById('error')
let loading,
  pdf,
  labels,
  busy = false,
  current = 1,
  total = 0,
  started = false,
  disposed = false
const send = (type) => parent.postMessage({ type }, '*')
const release = () => {
  void loading?.destroy()
  loading = undefined
  pdf = undefined
}
const fail = () => {
  error.textContent = labels?.failure ?? ''
  error.hidden = false
  canvas.hidden = true
  previous.disabled = next.disabled = true
  send('agnes-pdf-error')
  release()
}
async function render(pageNumber) {
  if (busy || disposed || !pdf || pageNumber < 1 || pageNumber > total) return
  busy = true
  previous.disabled = next.disabled = true
  try {
    const page = await pdf.getPage(pageNumber)
    const { width, height } = page.getViewport({ scale: 1 })
    if (![width, height].every((value) => Number.isFinite(value) && value > 0)) throw Error('page size')
    const scale = Math.min(2, 2000 / Math.max(width, height))
    if (Math.floor(width * scale) < 1 || Math.floor(height * scale) < 1) throw Error('page size')
    const viewport = page.getViewport({ scale })
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, background: 'white' })
      .promise
    page.cleanup()
    if (disposed) return
    current = pageNumber
    counter.textContent = `${current} / ${total}`
    canvas.setAttribute('aria-label', `${labels.title} · ${current} / ${total}`)
    send('agnes-pdf-rendered')
  } catch {
    if (!disposed) fail()
  } finally {
    busy = false
    previous.disabled = !pdf || current <= 1
    next.disabled = !pdf || current >= total
  }
}
previous.addEventListener('click', () => {
  void render(current - 1)
})
next.addEventListener('click', () => {
  void render(current + 1)
})
addEventListener('pagehide', () => {
  disposed = true
  release()
})
addEventListener('message', async (event) => {
  if (event.source !== parent || event.data?.type !== 'agnes-pdf-data' || started) return
  started = true
  labels = event.data
  try {
    if (typeof labels.base64 !== 'string' || !labels.base64 || labels.base64.length > 1398104)
      throw Error('byte limit')
    const binary = atob(labels.base64)
    if (binary.length > 1024 * 1024 || !binary.slice(0, 1024).includes('%PDF-')) throw Error('format')
    const bytes = decode(labels.base64)
    loading = getDocument({
      data: bytes,
      BinaryDataFactory: OfflineBinaryData,
      useWorkerFetch: false,
      useWasm: false,
      isEvalSupported: false,
      useSystemFonts: true,
      disableWorkerRendering: true,
      maxImageSize: 4000000,
      canvasMaxAreaInBytes: 16000000,
      enableXfa: false,
      enableHWA: false,
    })
    pdf = await loading.promise
    if (disposed) {
      release()
      return
    }
    total = pdf.numPages
    if (!Number.isInteger(total) || total < 1 || total > 2000) throw Error('page limit')
    previous.setAttribute('aria-label', String(labels.previous))
    next.setAttribute('aria-label', String(labels.next))
    await render(1)
  } catch {
    if (!disposed) fail()
  }
})
send('agnes-pdf-ready')
