import { SlotOutlet } from '@agnes/web-client'
import { createElement, useState } from 'react'
import { flushSync } from 'react-dom'
import { startClientModules } from '../../../packages/web/src/client-modules/boot.ts'

const host = document.getElementById('rightbar-panel')
const documents = new Map()
const requests = []
const held = new Set()
const pending = new Map()
const created = []
const blobMetadata = []
const revoked = []
const createUrl = URL.createObjectURL.bind(URL)
const revokeUrl = URL.revokeObjectURL.bind(URL)
URL.createObjectURL = (blob) => {
  const url = createUrl(blob)
  created.push(url)
  const metadata = { url, mime: blob.type, size: blob.size }
  blobMetadata.push(metadata)
  void blob.arrayBuffer().then((bytes) => {
    metadata.signature = new TextDecoder().decode(bytes.slice(0, 8))
  })
  return url
}
URL.revokeObjectURL = (url) => {
  revoked.push(url)
  revokeUrl(url)
}
const encode = (bytes) => btoa(String.fromCharCode(...bytes))
async function add(id, kind, bytes, mime, status = 200) {
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
  const artifact = { sha256, size: bytes.length, mime }
  const document = { id, kind, title: `Fixture ${id}`, laneId: 'fixture-lane', artifact }
  // Failure fixtures use a separate reference so a successful document retains its response.
  if (status !== 200) artifact.sha256 = `${status}`.padEnd(64, '0')
  documents.set(id, {
    document,
    result:
      status === 200
        ? {
            ok: true,
            status,
            artifact,
            contentLength: bytes.length,
            acceptRanges: 'bytes',
            etag: `"${artifact.sha256}"`,
            base64: encode(bytes),
          }
        : {
            ok: false,
            status,
            code: status === 410 ? 'artifact_reclaimed' : 'synthetic-private-credential/path',
          },
  })
}
const text = new TextEncoder()
await add(
  'markdown',
  'markdown',
  text.encode('# Preview\n\n[Jump](#section)\n\n## Section\n\n```js\nconst answer = 42\n```'),
  'text/markdown',
)
await add('text', 'text', text.encode('Literal <safe> content'), 'text/plain')
await add('empty', 'text', new Uint8Array(), 'text/plain')
await add(
  'html',
  'html',
  text.encode('<strong>Safe HTML</strong><img src="https://invalid.test/secret"><script>literal</script>'),
  'text/html',
)
const png = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII='),
  (c) => c.charCodeAt(0),
)
await add('image', 'image', png, 'image/png')
const pdfObjects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
]
const stream = 'BT /F1 16 Tf 30 240 Td (Synthetic PDF preview) Tj ET'
pdfObjects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
let pdf = '%PDF-1.4\n'
const offsets = [0]
for (let i = 0; i < pdfObjects.length; i++) {
  offsets.push(pdf.length)
  pdf += `${i + 1} 0 obj\n${pdfObjects[i]}\nendobj\n`
}
const xref = pdf.length
pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
await add('pdf', 'pdf', text.encode(pdf), 'application/pdf')
for (const status of [401, 403, 410, 500]) await add(`error-${status}`, 'image', png, 'image/png', status)
const call = async (method, input) => {
  if (method !== '_agnes/v1/artifact.read') throw new Error('unexpected fixture method')
  const row = [...documents.values()].find(
    (entry) => entry.document.artifact.sha256 === input.artifact.sha256,
  )
  if (!row || !['fixture-a', 'fixture-b'].includes(input.sessionId) || input.laneId !== 'fixture-lane')
    throw new Error('fixture refuses unknown resource scope')
  requests.push({ method, sessionId: input.sessionId, laneId: input.laneId, documentId: row.document.id })
  if (held.has(row.document.id))
    return new Promise((resolve) => {
      const list = pending.get(row.document.id) ?? []
      list.push(() => resolve(row.result))
      pending.set(row.document.id, list)
    })
  return row.result
}
let runtime
let current = documents.get('markdown').document
let update
let removeShadow
async function start() {
  runtime = await startClientModules({
    agnes: { call },
    rosterSource: { list: async () => ({ revision: '', modules: [], statuses: [] }) },
    rightbarContainer: host,
  })
  runtime.session.setSession('fixture-a')
  function Owner() {
    const [document, setDocument] = useState(current)
    update = setDocument
    return createElement(SlotOutlet, {
      name: 'sidebar.right.tab.document',
      entryKey: document.kind,
      props: { owner: document },
    })
  }
  runtime.registry.register(
    { name: 'sidebar.right.pane.tab', key: 'document', id: 'fixture-owner', owner: 'fixture', priority: -1 },
    Owner,
  )
}
await start()
window.__documentPreviewProbe = {
  requests,
  created,
  revoked,
  blobMetadata,
  show(id) {
    current = documents.get(id).document
    flushSync(() => update(current))
  },
  updateTitle(title) {
    current = { ...current, title }
    flushSync(() => update(current))
  },
  hold(id) {
    held.add(id)
  },
  release(id) {
    held.delete(id)
    for (const finish of pending.get(id) ?? []) finish()
    pending.delete(id)
  },
  setSession(id) {
    runtime.session.setSession(id)
  },
  shadow(name = 'sidebar.right.tab.document') {
    removeShadow = runtime.registry.register(
      {
        name,
        ...(name === 'sidebar.right.tab.document' ? { key: current.kind } : {}),
        id: 'fixture-shadow',
        owner: 'fixture',
        priority: -1,
      },
      () =>
        createElement(
          'button',
          { id: 'preview-return', type: 'button', onClick: () => this.restore() },
          'Return to document',
        ),
    )
  },
  restore() {
    removeShadow?.()
    removeShadow = undefined
  },
  async remount() {
    this.restore()
    await runtime.dispose()
    await start()
  },
  async dispose() {
    this.restore()
    await runtime.dispose()
    URL.createObjectURL = createUrl
    URL.revokeObjectURL = revokeUrl
  },
}
