import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const origin = process.env.AGNES_XMD_STREAM_ORIGIN || 'http://127.0.0.1:4196'
const debug = process.env.AGNES_XMD_STREAM_DEBUG || 'http://127.0.0.1:9231'
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
  console.log(JSON.stringify({ originClosed: true, chromeDebugClosed: true }))
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
const pending = new Map()
let nextId = 1
let events = []
socket.addEventListener('message', (event) => {
  const packet = JSON.parse(event.data)
  if (packet.id) {
    const slot = pending.get(packet.id)
    pending.delete(packet.id)
    if (packet.error) slot.reject(new Error(JSON.stringify(packet.error)))
    else slot.resolve(packet.result)
  } else events.push(packet)
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (fn, argument) => {
  const result = await send('Runtime.evaluate', {
    expression: `(${fn.toString()})(${JSON.stringify(argument) ?? ''})`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result?.value
}
console.log(JSON.stringify({ browser: await send('Browser.getVersion') }))
await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')
await send('Page.bringToFront')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
try {
  for (const page of ['/', '/admin/plugins', '/admin/resources']) {
    const response = await fetch(origin + page)
    const html = await response.text()
    assert.equal(response.status, 200)
    const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1]
    assert.ok(importMap)
    const hash = createHash('sha256').update(importMap).digest('base64')
    const csp = response.headers.get('content-security-policy')
    assert.ok(csp.includes(`'sha256-${hash}'`))
    assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'))
    events = []
    await send('Page.navigate', { url: origin + page })
    await evaluate(async () => {
      for (let i = 0; i < 80; i++) {
        if (window.__aghStreamingProbe) return true
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('Probe startup timeout')
    })
    const contextUsage = await evaluate(async () => {
      const api = window.__aghStreamingProbe
      const expect = (value, message) => {
        if (!value) throw new Error(message)
      }
      const host = () => document.querySelector('#session-usage')
      const rows = () =>
        [...host().querySelectorAll('dt')].map((term) => [
          term.textContent,
          term.nextElementSibling.textContent,
        ])
      expect(host().hidden, 'composer has no usage initially')
      const usage = {
        totals: { input: 9999, output: 500, cacheRead: 6000, cacheWrite: 0, reasoning: 20 },
        cost: { usdMicros: 125, source: 'estimated', subscription: false },
        credits: { amount: 0.000206, source: 'gateway', complete: true },
        context: { tokens: 1500, window: 128000, autoCompact: true, source: 'estimated' },
        model: { route: 'private-route', id: '<img src=x> **model**', thinking: 'high', maxTokens: 8192 },
      }
      await api.usage(usage)
      const details = host().querySelector('details'),
        summary = details.querySelector('summary'),
        first = details.querySelector('dt')
      expect(
        !host().hidden && summary.textContent === '上下文约 1.5K / 128.0K · 1.2%',
        'context visible with truthful summary',
      )
      summary.click()
      summary.focus()
      expect(details.open && document.activeElement === summary, 'native context disclosure focus')
      const popover = details.querySelector('.usage-popover'),
        ring = details.querySelector('.usage-ring')
      expect(
        getComputedStyle(popover).position === 'absolute' &&
          getComputedStyle(ring).backgroundImage.includes('conic-gradient'),
        'actual packaged panel and ring CSS',
      )
      const box = popover.getBoundingClientRect()
      expect(
        box.width > 200 && box.width < 400 && box.left >= 0 && box.right <= innerWidth,
        'panel fits viewport',
      )
      expect(
        JSON.stringify(rows()) ===
          JSON.stringify([
            ['上下文占用', '1,500 Token'],
            ['模型窗口', '128,000 Token'],
            ['最大输出上限', '8,192 Token'],
            ['自动整理上下文', '已启用'],
          ]),
        'only actual protocol rows',
      )
      for (const forbidden of ['9,999', '0.000206', '$', 'private-route', '<img', '缓存命中', '累计'])
        expect(!host().textContent.includes(forbidden), 'context excludes ' + forbidden)
      expect(!details.querySelector('img,a,script'), 'no parsed model data')
      for (const connected of [false, false, true]) {
        await api.usage({ ...usage, context: { ...usage.context, tokens: 100000 } }, connected)
        expect(
          host().querySelector('details') === details &&
            details.querySelector('summary') === summary &&
            details.querySelector('dt') === first,
          'context nodes retained',
        )
        expect(details.open && document.activeElement === summary, 'context expansion/focus retained')
        expect(
          host().textContent.includes('上次同步') === !connected && details.dataset.pressure === 'medium',
          'context connection/pressure update',
        )
      }
      popover.click()
      expect(details.open, 'inside click stays open')
      document.body.click()
      expect(!details.open, 'outside click closes')
      details.open = true
      await api.usage({ ...usage, context: { ...usage.context, tokens: 256000 } })
      expect(
        details.querySelector('.usage-context-value').textContent === '200.0%' &&
          ring.style.getPropertyValue('--usage-pct') === '100%' &&
          details.querySelector('.usage-bar > span').style.width === '100%',
        'truthful over-window ratio with capped visuals',
      )
      await api.clearUsageSession()
      expect(
        host().hidden &&
          !details.open &&
          rows().length === 0 &&
          summary.textContent === '' &&
          ring.style.getPropertyValue('--usage-pct') === '0%',
        'session clear resets context',
      )
      await api.usage({
        ...usage,
        context: { ...usage.context, tokens: 0, autoCompact: false },
        model: { route: 'local', id: 'other', thinking: 'off' },
      })
      expect(
        !host().hidden &&
          !details.open &&
          rows().length === 3 &&
          !host().textContent.includes('8,192') &&
          host().textContent.includes('未启用'),
        'next session zero/missing output',
      )
      await api.retireComposer()
      expect(!details.isConnected && !document.querySelector('#session-usage'), 'composer unmounted')
      details.open = true
      document.body.click()
      expect(details.open, 'retired context listener cleaned')
      await api.reset()
      return {
        initialHidden: true,
        protocolRows: true,
        ringCSS: true,
        viewport: true,
        identityFocusExpansion: true,
        connection: true,
        outsideDismiss: true,
        clearNextSession: true,
        cleanup: true,
      }
    })
    console.log(JSON.stringify({ page, contextUsage }))
    const cost = await evaluate(async () => {
      const api = window.__aghStreamingProbe
      const expect = (value, message) => {
        if (!value) throw new Error(message)
      }
      const call = {
        kind: 'cost',
        id: 'cost',
        seq: 2,
        source: 'estimated',
        purpose: 'inference',
        model: 'model',
        tokens: { input: 1234, output: 50, cacheRead: 600, cacheWrite: 0, reasoning: 20 },
        credits: 0.000206,
        billing: { usdMicros: 125, source: 'estimated', subscription: false },
        timing: { ttftMs: 0, durationMs: 2400 },
      }
      await api.cost(call)
      const article = () => document.querySelector('#transcript [data-node-id="cost"]')
      const details = article().querySelector('details')
      const summary = details.querySelector('summary')
      const inputRow = article().querySelector('dt')
      const rows = (host) =>
        [...host.querySelectorAll('dt')].map((term) => [
          term.textContent,
          term.nextElementSibling.textContent,
        ])
      expect(summary.textContent === '输入 1.2K · 输出 50 · $0.000125（估算）', 'compact cost summary')
      expect(
        rows(article()).length === 11 &&
          rows(article()).some(([key, value]) => key === '推理 Token（输出的子集）' && value === '20'),
        'complete detail values',
      )
      expect(
        JSON.stringify(rows(article())) ===
          JSON.stringify(rows(document.querySelector('#legacy-transcript [data-node-id="cost"]'))),
        'legacy and React complete cost parity',
      )
      summary.click()
      summary.focus()
      expect(details.open && document.activeElement === summary, 'native cost opens and takes focus')
      const gateway = {
        ...call,
        source: 'gateway',
        credits: 0,
        interrupted: true,
        model: '<img src=x onerror=alert(1)> **literal** [link](javascript:alert(1))',
        billing: { usdMicros: 0, source: 'gateway', subscription: true },
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }
      for (const next of [gateway, { ...gateway }]) {
        await api.cost(next, true)
        expect(
          article().querySelector('details') === details &&
            details.querySelector('summary') === summary &&
            article().querySelector('dt') === inputRow,
          'cost nodes stay identical',
        )
        expect(details.open && document.activeElement === summary, 'cost expansion and real focus retained')
        expect(
          summary.textContent === '输入 0 · 输出 0 · $0.00（网关记录） · 已中断',
          'zero gateway values and interrupted state',
        )
        expect(
          rows(article()).some(([key, value]) => key === '模型' && value === gateway.model),
          'literal model',
        )
        expect(!article().querySelector('img, a, strong, svg, script'), 'cost never parses HTML/Markdown')
        expect(
          JSON.stringify(rows(article())) ===
            JSON.stringify(rows(document.querySelector('#legacy-transcript [data-node-id="cost"]'))),
          'replacement parity',
        )
        expect(
          [...document.querySelectorAll('#transcript [data-node-id]')]
            .map((el) => el.dataset.nodeId)
            .join(',') === 'cost-user,cost',
          'cost order and no duplicate',
        )
      }
      await api.cost({ kind: 'cost', id: 'cost', seq: 2, source: 'estimated' })
      expect(
        summary.textContent === '费用未提供' &&
          rows(article()).length === 3 &&
          details.open &&
          document.activeElement === summary,
        'missing fields remove stale rows and keep interaction',
      )
      await api.cost({
        kind: 'cost',
        id: 'cost',
        seq: 2,
        source: 'estimated',
        credits: 0,
        purpose: '__proto__',
      })
      expect(rows(article())[0][1] === '单次费用记录', 'unknown prototype purpose is text scope')
      expect(
        summary.textContent === '0 credits（估算）' && !article().textContent.includes('$'),
        'credit-only zero never invents dollars',
      )
      const styles = getComputedStyle(details)
      expect(
        styles.display !== 'none' && getComputedStyle(summary).cursor === 'pointer',
        'shared cost styles present',
      )
      await api.render('cost retired', '', false)
      expect(!details.isConnected, 'removed cost subtree retired')
      await api.reset()
      return {
        parity: true,
        completeRows: 11,
        identityFocusExpansion: true,
        missingZeroInterrupted: true,
        literalModel: true,
      }
    })
    console.log(JSON.stringify({ page, cost }))
    const animation = await evaluate(async () => {
      const api = window.__aghStreamingProbe
      const expect = (value, message) => {
        if (!value) throw new Error(message)
      }
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const body = () => document.querySelector('[data-node-id="a1"] .node-body')
      await api.render('history', '', false)
      expect(!body().querySelector('.message-reveal-fragment'), 'history is immediate')
      await api.render('prefix')
      expect(!body().querySelector('.message-reveal-fragment'), 'replacement is immediate')
      const paragraph = body().querySelector('p')
      await api.render('prefix first')
      const first = body().querySelector('.message-reveal-fragment')
      expect(first?.textContent === ' first', 'only appended first suffix')
      const animation = first.getAnimations()[0]
      expect(animation?.effect.getTiming().duration === 480, 'actual animation lasts 480ms')
      await animation.ready
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const start = animation.startTime
      const time = animation.currentTime
      const opacity = Number(getComputedStyle(first).opacity)
      expect(opacity > 0.08 && opacity < 1, 'fade is actually in progress')
      await wait(50)
      await api.render('prefix first second')
      expect(
        body().querySelector('p') === paragraph && body().querySelector('.message-reveal-fragment') === first,
        'paragraph and first fragment keep identity',
      )
      expect(
        first.getAnimations()[0] === animation &&
          animation.startTime === start &&
          animation.currentTime > time,
        'old fragment never restarts its clock',
      )
      expect(
        [...body().querySelectorAll('.message-reveal-fragment')].map((node) => node.textContent).join('') ===
          ' first second',
        'only new suffix ranges',
      )
      const selection = document.getSelection()
      const range = document.createRange()
      range.selectNodeContents(paragraph)
      selection.addRange(range)
      const selected = selection.toString()
      await api.render('prefix first second backlog')
      expect(
        selection.toString() === selected && !body().textContent.includes('backlog'),
        'selection holds content and fragments',
      )
      selection.removeAllRanges()
      document.dispatchEvent(new Event('selectionchange'))
      await wait(30)
      expect(
        body().textContent.includes('backlog') && !body().querySelector('.message-reveal-fragment'),
        'selection backlog paints directly',
      )
      await api.render('prefix first second backlog live')
      expect(
        body().querySelector('.message-reveal-fragment')?.textContent === ' live',
        'next delta resumes animation',
      )
      await wait(510)
      expect(
        Number(getComputedStyle(body().querySelector('.message-reveal-fragment')).opacity) === 1,
        '480ms fade finishes',
      )
      await api.render('prefix first second backlog live done')
      expect(
        body().querySelectorAll('.message-reveal-fragment').length === 1 &&
          body().querySelector('.message-reveal-fragment').textContent === ' done',
        'retired ranges do not repeat',
      )
      api.legacyRender('legacy history', false)
      const legacy = document.querySelector('#legacy-transcript .node-body')
      expect(
        legacy.querySelector('p')?.textContent === 'legacy history' &&
          !legacy.querySelector('.message-reveal-fragment'),
        'legacy facade is synchronous and history immediate',
      )
      api.legacyRender('legacy history live')
      expect(
        legacy.querySelector('.message-reveal-fragment')?.textContent === ' live',
        'legacy facade injects streaming and shares suffix animation',
      )
      api.staticRender('| key | value |\n| :--- | ---: |\n| a | 1 |')
      const table = document.querySelector('#static-preview .table-scroll')
      expect(
        table?.tabIndex === 0 && table.getAttribute('aria-label') === '表格，可横向滚动',
        'table is keyboard accessible',
      )
      expect(
        table.querySelector('th').scope === 'col' &&
          getComputedStyle(table.querySelector('td:last-child')).textAlign === 'right',
        'table scope and alignment retained',
      )
      expect(
        !document.querySelector('#static-preview .message-reveal-fragment'),
        'document preview stays static',
      )
      await api.render('```ts\ncopy code\n```')
      const copy = body().querySelector('.code-copy')
      copy.focus()
      expect(document.activeElement === copy, 'copy is visible and focused')
      await api.render('```ts\ncopy code\n```\n\nbacklog')
      expect(!body().textContent.includes('backlog'), 'copy focus holds backlog')
      copy.blur()
      await wait(30)
      expect(
        body().textContent.includes('backlog') && !body().querySelector('.message-reveal-fragment'),
        'copy backlog paints directly',
      )
      await api.render('```ts\ncopy code\n```\n\nbacklog live')
      expect(
        !body().querySelector('.code-toolbar .message-reveal-fragment') &&
          body().querySelector('.message-reveal-fragment')?.textContent === ' live',
        'copy controls excluded from ranges',
      )
      await api.render(
        '<script>window.__unsafeReveal = true</script>\n\nFish &amp; Chips **safe** \\<img src="https://example.test/literal.png"> ![alt](https://example.test/blocked.png) [bad](java&#x73;cript:alert(1)) [good](https://example.test/docs)\n\n<agnes-reveal-root data-agnes-plan="broken">literal owner</agnes-reveal-root>',
        '',
        false,
      )
      expect(
        !body().querySelector('script,img,agnes-reveal-root') && !window.__unsafeReveal,
        'HTML and ownership tags remain inert',
      )
      expect(
        body().textContent.includes('<script>window.__unsafeReveal = true</script>') &&
          body().textContent.includes('Fish & Chips') &&
          body().textContent.includes('<img src="https://example.test/literal.png">') &&
          body().textContent.includes('literal owner'),
        'encoded parser data preserves literal text',
      )
      expect(
        body().querySelectorAll('a').length === 1 &&
          body().querySelector('a').href === 'https://example.test/docs' &&
          body().textContent.includes('[bad](java&#x73;cript:alert(1))'),
        'safe link policy remains effective in Chrome',
      )
      return {
        safety: true,
        durationMs: 480,
        suffixOnly: true,
        clockRetained: true,
        initialOpacity: opacity,
        selectionBacklog: true,
        focusBacklog: true,
        retiredRanges: true,
        legacyFacade: true,
        staticPreview: true,
      }
    })
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    const reduced = await evaluate(async () => {
      const api = window.__aghStreamingProbe
      await api.render('reduced')
      await api.render('reduced suffix')
      const body = document.querySelector('[data-node-id="a1"] .node-body')
      if (
        !matchMedia('(prefers-reduced-motion: reduce)').matches ||
        body.querySelector('.message-reveal-fragment') ||
        !body.textContent.includes('reduced suffix')
      )
        throw new Error('native reduced-motion gate')
      return true
    })
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    })
    await send('Emulation.setFocusEmulationEnabled', { enabled: false })
    const backgroundTarget = await send('Target.createTarget', { url: 'about:blank', background: false })
    let background
    try {
      await send('Target.activateTarget', { targetId: backgroundTarget.targetId })
      background = await evaluate(async () => {
        const api = window.__aghStreamingProbe
        if (document.visibilityState !== 'hidden') throw new Error('actual background tab must be hidden')
        await api.render('background')
        await api.render('background suffix')
        const body = document.querySelector('[data-node-id="a1"] .node-body')
        if (body.querySelector('.message-reveal-fragment') || !body.textContent.includes('background suffix'))
          throw new Error('native background gate')
        return { visibility: document.visibilityState, suffixImmediate: true }
      })
    } finally {
      await send('Target.closeTarget', { targetId: backgroundTarget.targetId })
      await send('Page.bringToFront')
      await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    }
    const results = await evaluate(async () => {
      const api = window.__aghStreamingProbe
      if (!document.hasFocus()) throw new Error('Chrome probe document must have focus')
      const expect = (condition, message) => {
        if (!condition) throw new Error(message)
      }
      const body = () => document.querySelector('[data-node-id="a1"] .node-body')
      const wait = () => new Promise((resolve) => setTimeout(resolve, 30))
      const select = (element) => {
        const selection = document.getSelection()
        const range = document.createRange()
        range.selectNodeContents(element)
        selection.removeAllRanges()
        selection.addRange(range)
      }
      const release = async () => {
        document.getSelection().removeAllRanges()
        document.dispatchEvent(new Event('selectionchange'))
        await wait()
      }
      await api.render('stable\n\n**open')
      const stable = body().querySelector('p')
      expect(!body().textContent.includes('**open'), 'incomplete emphasis buffered')
      await api.render('stable\n\n**opened**')
      expect(
        body().querySelector('p') === stable && body().querySelector('strong').textContent === 'opened',
        'stable prefix over syntax closure',
      )
      const source = '[doc][ref]\n\n```ts\nfixed code\n```'
      await api.render(source)
      const stableCopy = body().querySelector('.code-copy')
      const stablePre = body().querySelector('pre')
      await api.render(`${source}\n\n[ref]: https://example.test/docs`)
      expect(body().querySelector('a').href === 'https://example.test/docs', 'late reference resolves')
      expect(
        body().querySelector('pre') === stablePre && body().querySelector('.code-copy') === stableCopy,
        'late reference keeps code control',
      )
      await api.render('stable\n\nselected tail')
      const selected = body().querySelectorAll('p')[1]
      select(selected)
      await api.render('stable\n\nintermediate tail')
      await api.render('stable\n\nfinal **answer**', '', false, 'completed', true)
      expect(
        document.getSelection().toString() === 'selected tail' && selected.isConnected,
        'selected body retained at terminal',
      )
      expect(!body().textContent.includes('answer'), 'latest terminal held')
      await release()
      expect(body().querySelector('strong').textContent === 'answer', 'latest body flushes')
      window.__copied = []
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__copied.push(text)
          },
        },
      })
      await api.render('```ts\nold code\n```')
      const copy = body().querySelector('.code-copy')
      copy.focus()
      expect(document.activeElement === copy, 'copy focus starts in a visible control')
      copy.click()
      await wait()
      await api.render('```ts\nlatest code\n```', '', false, 'completed', true)
      expect(document.activeElement === copy && copy.isConnected, 'copy focus retained')
      expect(
        body().querySelector('code').textContent === 'old code\n' && copy.textContent === '已复制',
        'copy content/state retained',
      )
      copy.click()
      await wait()
      expect(window.__copied.at(-1) === 'old code', 'copies actual displayed old code')
      copy.blur()
      await wait()
      expect(
        body().querySelector('code').textContent === 'latest code\n' &&
          body().querySelector('.code-copy') === copy,
        'blur flushes code without remount',
      )
      await api.render('', 'selected thought')
      const thought = document.querySelector('[data-node-id="a1"] [data-conversation-markdown="thinking"]')
      select(thought.querySelector('p'))
      await api.render('final body', 'final thought', false, 'completed', true)
      expect(
        thought.isConnected && document.getSelection().toString() === 'selected thought',
        'thinking retained before handover',
      )
      expect(
        document.querySelectorAll('#transcript [data-conversation-markdown="thinking"]').length === 1,
        'one thought during handover',
      )
      await release()
      expect(
        document
          .querySelector('.turn-process [data-conversation-markdown="thinking"]')
          .textContent.includes('final thought'),
        'thinking moves after release',
      )
      await api.render('', '```ts\nold thought\n```')
      const thoughtCopy = document.querySelector('.thinking-content .code-copy')
      thoughtCopy.focus()
      expect(document.activeElement === thoughtCopy, 'thinking copy starts focused')
      await api.render('answer', '```ts\nfinal thought\n```', false, 'completed', true)
      expect(
        document.activeElement === thoughtCopy && thoughtCopy.isConnected,
        'thinking copy focus survives handover',
      )
      expect(
        document.querySelectorAll('#transcript [data-conversation-markdown="thinking"]').length === 1,
        'one focused thinking tree',
      )
      thoughtCopy.blur()
      await wait()
      expect(
        document.querySelector('.turn-process .thinking-content code').textContent === 'final thought\n',
        'thinking copy release hands over latest',
      )
      await api.render('', 'selected removable thought')
      const removable = document.querySelector('[data-node-id="a1"] [data-conversation-markdown="thinking"]')
      select(removable.querySelector('p'))
      await api.render('answer', '', false, 'completed', true)
      expect(
        removable.isConnected &&
          !removable.closest('[hidden]') &&
          document.getSelection().toString() === 'selected removable thought',
        'removed thinking stays visible until release',
      )
      await release()
      expect(
        document.querySelectorAll('#transcript [data-conversation-markdown="thinking"]').length === 0,
        'removed thinking clears after release',
      )
      for (const status of ['failed', 'cancelled']) {
        await api.render('selected process')
        const processBody = body()
        select(processBody.querySelector('p'))
        await api.render('terminal **partial', '', false, status)
        expect(
          !processBody.closest('[hidden]') && document.getSelection().toString() === 'selected process',
          `process remains visible at ${status}`,
        )
        await release()
        expect(
          processBody.textContent.includes('terminal **partial') &&
            !document.querySelector('.turn-process').open,
          `process flushes then folds at ${status}`,
        )
      }
      for (const status of ['completed', 'failed', 'cancelled']) {
        await api.render('body **unfinished', 'thought `unfinished', true)
        await api.render('body **unfinished', 'thought `unfinished', true, status)
        expect(body().textContent.includes('**unfinished'), `body cache flush at ${status}`)
        expect(
          document.querySelector('.thinking-content').textContent.includes('`unfinished'),
          `thinking cache flush at ${status}`,
        )
      }
      await api.reset()
      await api.preview('partial')
      const article = document.querySelector('[data-node-id="a1"]')
      const retained = body().querySelector('p')
      select(retained)
      await api.reconnect()
      expect(
        document.querySelector('[data-node-id="a1"]') === article &&
          body().querySelector('p') === retained &&
          document.getSelection().toString() === 'partial',
        'reconnect retains old preview/selection',
      )
      await release()
      await api.preview('restarted output')
      expect(
        body().textContent.includes('restarted output') && !body().textContent.includes('partial'),
        'first new preview replaces retained preview',
      )
      await api.preview(' done', 'restarted output'.length)
      await api.complete('restarted output done')
      expect(
        document.querySelector('[data-node-id="a1"]') === article &&
          body().textContent.includes('restarted output done'),
        'terminal sync keeps identity',
      )
      await api.next()
      await api.preview('second partial', 0, 'e2')
      await api.reconnect()
      expect(
        document.querySelector('[data-node-id="a2"]').textContent.includes('second partial'),
        'later request/reconnect retains output',
      )
      await api.complete('second answer', 2)
      await api.replay()
      expect(
        JSON.stringify(api.snapshot().ids) === JSON.stringify(['u1', 'a1', 'u2', 'a2']),
        'order/dedup after completion replay',
      )
      expect(
        document.querySelector('[data-node-id="a2"]').textContent.includes('second answer'),
        'final before fresh preview replaces retained output',
      )
      const recovery = api.snapshot()
      await api.switchSession()
      expect(
        document.querySelector('[data-node-id="a1"]') !== article &&
          document.querySelector('#transcript').textContent.includes('new session'),
        'session reset retires identity',
      )
      await api.dispose()
      const final = api.snapshot()
      expect(final.previewListeners === 0 && final.connectionListeners === 0, 'transport listeners cleaned')
      expect(document.querySelectorAll('[data-node-id]').length === 0, 'region cleaned')
      expect(final.errors.length === 0 && final.violations.length === 0, 'no projection/CSP errors')
      return {
        recovery: { ids: recovery.ids, counters: recovery.counters },
        selectedBody: true,
        focusedCopy: true,
        selectedThinking: true,
        focusedThinking: true,
        removedThinking: true,
        terminalVisibility: true,
        clipboard: 'synthetic writer',
        lateReferenceIdentity: true,
        terminals: ['completed', 'failed', 'cancelled'],
        cleanup: true,
        cspViolations: final.violations.length,
      }
    })
    const errors = events.filter(
      (event) =>
        event.method === 'Runtime.exceptionThrown' ||
        (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') ||
        (event.method === 'Log.entryAdded' && event.params.entry.level === 'error'),
    )
    const badScripts = events.filter(
      (event) =>
        event.method === 'Network.responseReceived' &&
        event.params.type === 'Script' &&
        event.params.response.status !== 200,
    )
    const unexpectedImages = events.filter(
      (event) =>
        event.method === 'Network.requestWillBeSent' &&
        /^https:\/\/example\.test\/.*\.png$/.test(event.params.request.url),
    )
    assert.deepEqual(unexpectedImages, [], 'No unrequested Markdown images')
    assert.deepEqual(errors, [], 'Chrome errors')
    assert.deepEqual(badScripts, [], 'Script responses')
    console.log(
      JSON.stringify({
        page,
        importMapHash: hash,
        animation,
        reduced,
        background,
        results,
        chromeErrors: errors.length,
        badScripts: badScripts.length,
      }),
    )
  }
} finally {
  socket.close()
}
