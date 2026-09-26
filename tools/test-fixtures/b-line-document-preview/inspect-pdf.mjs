import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

const origin = 'http://127.0.0.1:4198'
const debug = 'http://127.0.0.1:9234'
if (process.argv.includes('--closed')) {
  for (const endpoint of [origin, debug]) {
    let closed = false
    try {
      await fetch(endpoint, { signal: AbortSignal.timeout(1000) })
    } catch (error) {
      closed = error.cause?.code === 'ECONNREFUSED'
    }
    assert.ok(closed, `Probe endpoint still accepts connections: ${endpoint}`)
  }
  console.log(JSON.stringify({ serverClosed: true, chromeClosed: true }))
  process.exit(0)
}
const targets = await (await fetch(`${debug}/json/list`)).json()
const target = targets.find((item) => item.type === 'page')
assert.ok(target?.webSocketDebuggerUrl)
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let id = 0
const pending = new Map()
const events = []
socket.addEventListener('message', (event) => {
  const packet = JSON.parse(event.data)
  if (!packet.id) events.push(packet)
  else {
    const slot = pending.get(packet.id)
    pending.delete(packet.id)
    packet.error ? slot.reject(new Error(JSON.stringify(packet.error))) : slot.resolve(packet.result)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const next = ++id
    pending.set(next, { resolve, reject })
    socket.send(JSON.stringify({ id: next, method, params }))
  })
const evaluate = async (fn, argument) => {
  const result = await send('Runtime.evaluate', {
    expression: `(${fn.toString()})(${JSON.stringify(argument) ?? 'undefined'})`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}
try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Log.enable')
  await send('Log.clear')
  events.length = 0
  await send('Page.navigate', { url: origin })
  await evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      if (window.__documentPreviewProbe) break
      await new Promise((r) => setTimeout(r, 20))
    }
    const api = window.__documentPreviewProbe
    api.show('pdf')
    for (let i = 0; i < 100; i++) {
      if (document.querySelector('#rightbar-panel iframe')?.src.startsWith('blob:')) break
      await new Promise((r) => setTimeout(r, 20))
    }
    const url = document.querySelector('#rightbar-panel iframe').src
    const variants = [undefined, '', 'allow-same-origin', 'allow-scripts', 'allow-scripts allow-same-origin']
    const grid = document.createElement('div')
    grid.id = 'pdf-matrix'
    grid.style =
      'position:fixed;z-index:100000;inset:0;background:white;color:black;display:flex;gap:8px;padding:8px'
    for (const sandbox of variants) {
      const col = document.createElement('section')
      col.style = 'flex:1'
      const label = document.createElement('h3')
      label.textContent = sandbox === undefined ? 'no sandbox' : sandbox || 'empty sandbox'
      const frame = document.createElement('iframe')
      frame.title = label.textContent
      frame.src = url
      frame.style = 'width:100%;height:700px'
      if (sandbox !== undefined) frame.setAttribute('sandbox', sandbox)
      col.append(label, frame)
      grid.append(col)
    }
    document.body.append(grid)
    await new Promise((r) => setTimeout(r, 1500))
  })
  const picture = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile('/private/tmp/agh-w6b2-pdf-matrix.png', Buffer.from(picture.data, 'base64'))
  const tree = await send('Page.getFrameTree')
  const dom = await send('DOM.getDocument', { depth: -1, pierce: true })
  await writeFile('/private/tmp/agh-w6b2/pdf-matrix.json', JSON.stringify({ tree, dom, events }, null, 2))
  console.log(
    JSON.stringify({
      frames: tree.frameTree.childFrames?.map((f) => ({
        url: f.frame.url,
        mime: f.frame.mimeType,
        securityOrigin: f.frame.securityOrigin,
      })),
      failed: events.filter((e) => e.method === 'Network.loadingFailed'),
    }),
  )
  await evaluate(async () => {
    document.getElementById('pdf-matrix')?.remove()
    await window.__documentPreviewProbe.dispose()
  })
} finally {
  socket.close()
}
