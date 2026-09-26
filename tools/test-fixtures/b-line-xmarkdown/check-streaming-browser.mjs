import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const origin = process.env.AGNES_XMD_STREAM_ORIGIN || 'http://127.0.0.1:4196'
const debug = process.env.AGNES_XMD_STREAM_DEBUG || 'http://127.0.0.1:9231'
if (process.argv.includes('--closed')) {
  for (const endpoint of [origin, debug]) {
    let closed = false
    try { await fetch(endpoint, { signal: AbortSignal.timeout(1000) }) }
    catch (error) { closed = error.cause?.code === 'ECONNREFUSED' }
    assert.ok(closed, `Probe endpoint still accepts connections: ${endpoint}`)
  }
  console.log(JSON.stringify({ originClosed: true, chromeDebugClosed: true }))
  process.exit(0)
}
const targets = await (await fetch(`${debug}/json/list`)).json()
const target = targets.find((item) => item.type === 'page')
assert.ok(target?.webSocketDebuggerUrl)
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
const pending = new Map()
let nextId = 1
let events = []
socket.addEventListener('message', (event) => {
  const packet = JSON.parse(event.data)
  if (packet.id) { const slot = pending.get(packet.id); pending.delete(packet.id); if (packet.error) slot.reject(new Error(JSON.stringify(packet.error))); else slot.resolve(packet.result) }
  else events.push(packet)
})
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
const evaluate = async (fn, argument) => {
  const result = await send('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(argument) ?? ''})`, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable'); await send('Page.bringToFront'); await send('Emulation.setFocusEmulationEnabled', { enabled: true })
try {
  for (const page of ['/', '/admin/plugins', '/admin/resources']) {
    const response = await fetch(origin + page)
    const html = await response.text()
    assert.equal(response.status, 200)
    const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1]
    assert.ok(importMap)
    const hash = createHash('sha256').update(importMap).digest('base64')
    const csp = response.headers.get('content-security-policy')
    assert.ok(csp.includes(`'sha256-${hash}'`)); assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'))
    events = []
    await send('Page.navigate', { url: origin + page })
    await evaluate(async () => { for (let i = 0; i < 80; i++) { if (window.__aghStreamingProbe) return true; await new Promise((resolve) => setTimeout(resolve, 25)) } throw new Error('Probe startup timeout') })
    const results = await evaluate(async () => {
      const api = window.__aghStreamingProbe
      if (!document.hasFocus()) throw new Error('Chrome probe document must have focus')
      const expect = (condition, message) => { if (!condition) throw new Error(message) }
      const body = () => document.querySelector('[data-node-id="a1"] .node-body')
      const wait = () => new Promise((resolve) => setTimeout(resolve, 30))
      const select = (element) => { const selection = document.getSelection(); const range = document.createRange(); range.selectNodeContents(element); selection.removeAllRanges(); selection.addRange(range) }
      const release = async () => { document.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); await wait() }
      await api.render('stable\n\n**open')
      const stable = body().querySelector('p')
      expect(!body().textContent.includes('**open'), 'incomplete emphasis buffered')
      await api.render('stable\n\n**opened**')
      expect(body().querySelector('p') === stable && body().querySelector('strong').textContent === 'opened', 'stable prefix over syntax closure')
      const source = '[doc][ref]\n\n```ts\nfixed code\n```'
      await api.render(source)
      const stableCopy = body().querySelector('.code-copy')
      const stablePre = body().querySelector('pre')
      await api.render(`${source}\n\n[ref]: https://example.test/docs`)
      expect(body().querySelector('a').href === 'https://example.test/docs', 'late reference resolves')
      expect(body().querySelector('pre') === stablePre && body().querySelector('.code-copy') === stableCopy, 'late reference keeps code control')
      await api.render('stable\n\nselected tail')
      const selected = body().querySelectorAll('p')[1]
      select(selected)
      await api.render('stable\n\nintermediate tail')
      await api.render('stable\n\nfinal **answer**', '', false, 'completed', true)
      expect(document.getSelection().toString() === 'selected tail' && selected.isConnected, 'selected body retained at terminal')
      expect(!body().textContent.includes('answer'), 'latest terminal held')
      await release()
      expect(body().querySelector('strong').textContent === 'answer', 'latest body flushes')
      window.__copied = []
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied.push(text) } } })
      await api.render('```ts\nold code\n```')
      const copy = body().querySelector('.code-copy')
      copy.focus();
      expect(document.activeElement === copy, 'copy focus starts in a visible control');
      copy.click(); await wait()
      await api.render('```ts\nlatest code\n```', '', false, 'completed', true)
      expect(document.activeElement === copy && copy.isConnected, 'copy focus retained')
      expect(body().querySelector('code').textContent === 'old code\n' && copy.textContent === '已复制', 'copy content/state retained')
      copy.click(); await wait()
      expect(window.__copied.at(-1) === 'old code', 'copies actual displayed old code')
      copy.blur(); await wait()
      expect(body().querySelector('code').textContent === 'latest code\n' && body().querySelector('.code-copy') === copy, 'blur flushes code without remount')
      await api.render('', 'selected thought')
      const thought = document.querySelector('[data-node-id="a1"] [data-conversation-markdown="thinking"]')
      select(thought.querySelector('p'))
      await api.render('final body', 'final thought', false, 'completed', true)
      expect(thought.isConnected && document.getSelection().toString() === 'selected thought', 'thinking retained before handover')
      expect(document.querySelectorAll('[data-conversation-markdown="thinking"]').length === 1, 'one thought during handover')
      await release()
      expect(document.querySelector('.turn-process [data-conversation-markdown="thinking"]').textContent.includes('final thought'), 'thinking moves after release')
      await api.render('', '```ts\nold thought\n```')
      const thoughtCopy = document.querySelector('.thinking-content .code-copy')
      thoughtCopy.focus()
      expect(document.activeElement === thoughtCopy, 'thinking copy starts focused')
      await api.render('answer', '```ts\nfinal thought\n```', false, 'completed', true)
      expect(document.activeElement === thoughtCopy && thoughtCopy.isConnected, 'thinking copy focus survives handover')
      expect(document.querySelectorAll('[data-conversation-markdown="thinking"]').length === 1, 'one focused thinking tree')
      thoughtCopy.blur(); await wait()
      expect(document.querySelector('.turn-process .thinking-content code').textContent === 'final thought\n', 'thinking copy release hands over latest')
      await api.render('', 'selected removable thought')
      const removable = document.querySelector('[data-node-id="a1"] [data-conversation-markdown="thinking"]')
      select(removable.querySelector('p'))
      await api.render('answer', '', false, 'completed', true)
      expect(removable.isConnected && !removable.closest('[hidden]') && document.getSelection().toString() === 'selected removable thought', 'removed thinking stays visible until release')
      await release()
      expect(document.querySelectorAll('[data-conversation-markdown="thinking"]').length === 0, 'removed thinking clears after release')
      for (const status of ['failed', 'cancelled']) {
        await api.render('selected process')
        const processBody = body()
        select(processBody.querySelector('p'))
        await api.render('terminal **partial', '', false, status)
        expect(!processBody.closest('[hidden]') && document.getSelection().toString() === 'selected process', `process remains visible at ${status}`)
        await release()
        expect(processBody.textContent.includes('terminal **partial') && !document.querySelector('.turn-process').open, `process flushes then folds at ${status}`)
      }
      for (const status of ['completed', 'failed', 'cancelled']) {
        await api.render('body **unfinished', 'thought `unfinished', true)
        await api.render('body **unfinished', 'thought `unfinished', true, status)
        expect(body().textContent.includes('**unfinished'), `body cache flush at ${status}`)
        expect(document.querySelector('.thinking-content').textContent.includes('`unfinished'), `thinking cache flush at ${status}`)
      }
      await api.reset()
      await api.preview('partial')
      const article = document.querySelector('[data-node-id="a1"]')
      const retained = body().querySelector('p')
      select(retained)
      await api.reconnect()
      expect(document.querySelector('[data-node-id="a1"]') === article && body().querySelector('p') === retained && document.getSelection().toString() === 'partial', 'reconnect retains old preview/selection')
      await release()
      await api.preview('restarted output')
      expect(body().textContent.includes('restarted output') && !body().textContent.includes('partial'), 'first new preview replaces retained preview')
      await api.preview(' done', 'restarted output'.length)
      await api.complete('restarted output done')
      expect(document.querySelector('[data-node-id="a1"]') === article && body().textContent.includes('restarted output done'), 'terminal sync keeps identity')
      await api.next(); await api.preview('second partial', 0, 'e2'); await api.reconnect()
      expect(document.querySelector('[data-node-id="a2"]').textContent.includes('second partial'), 'later request/reconnect retains output')
      await api.complete('second answer', 2)
      await api.replay()
      expect(JSON.stringify(api.snapshot().ids) === JSON.stringify(['u1', 'a1', 'u2', 'a2']), 'order/dedup after completion replay')
      expect(document.querySelector('[data-node-id="a2"]').textContent.includes('second answer'), 'final before fresh preview replaces retained output')
      const recovery = api.snapshot()
      await api.switchSession()
      expect(document.querySelector('[data-node-id="a1"]') !== article && document.querySelector('#transcript').textContent.includes('new session'), 'session reset retires identity')
      await api.dispose()
      const final = api.snapshot()
      expect(final.previewListeners === 0 && final.connectionListeners === 0, 'transport listeners cleaned')
      expect(document.querySelectorAll('[data-node-id]').length === 0, 'region cleaned')
      expect(final.errors.length === 0 && final.violations.length === 0, 'no projection/CSP errors')
      return { recovery: { ids: recovery.ids, counters: recovery.counters }, selectedBody: true, focusedCopy: true, selectedThinking: true, focusedThinking: true, removedThinking: true, terminalVisibility: true, clipboard: 'synthetic writer', lateReferenceIdentity: true, terminals: ['completed', 'failed', 'cancelled'], cleanup: true, cspViolations: final.violations.length }
    })
    const errors = events.filter((event) => event.method === 'Runtime.exceptionThrown' || event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error' || event.method === 'Log.entryAdded' && event.params.entry.level === 'error')
    const badScripts = events.filter((event) => event.method === 'Network.responseReceived' && event.params.type === 'Script' && event.params.response.status !== 200)
    assert.deepEqual(errors, [], 'Chrome errors'); assert.deepEqual(badScripts, [], 'Script responses')
    console.log(JSON.stringify({ page, importMapHash: hash, results, chromeErrors: errors.length, badScripts: badScripts.length }))
  }
} finally { socket.close() }
