import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const origin = 'http://127.0.0.1:4198'
const debug = 'http://127.0.0.1:9234'
const expectBlobBlocked = process.argv.includes('--expect-blob-blocked')
const expectPdfBlocked = process.argv.includes('--expect-pdf-blocked')
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
  const browser = await send('Browser.getVersion')
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Log.enable')
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const response = await fetch(origin)
  const html = await response.text()
  const csp = response.headers.get('content-security-policy')
  const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1]
  assert.equal(response.status, 200)
  assert.ok(csp.includes(`'sha256-${createHash('sha256').update(importMap).digest('base64')}'`))
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp))
  const assets = []
  for (const path of [
    '/style.css',
    '/tokens.css',
    '/antd.css',
    ...Object.values(JSON.parse(importMap).imports),
  ]) {
    const resource = await fetch(origin + path)
    assert.equal(resource.status, 200, path)
    const mime = resource.headers.get('content-type') ?? ''
    assert.match(mime, path.endsWith('.css') ? /^text\/css/ : /^text\/javascript/)
    assets.push({ path, mime })
  }
  await send('Log.clear')
  events.length = 0
  await send('Page.navigate', { url: origin })
  await evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      if (
        window.__documentPreviewProbe &&
        document.querySelector('#rightbar-panel h1')?.textContent === 'Preview'
      )
        return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('startup timeout')
  })
  const markdown = await evaluate(() => {
    const host = document.getElementById('rightbar-panel')
    const copy = host.querySelector('.code-copy')
    if (!copy || host.hidden) throw new Error('visible Markdown/code control missing')
    copy.focus()
    window.__previewCopyNode = copy
    window.__documentPreviewProbe.updateTitle('Updated title')
    return {
      title: host.querySelector('[data-document-preview]')?.getAttribute('aria-label'),
      heading: host.querySelector('h1')?.textContent,
    }
  })
  await evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      if (document.querySelector('[data-document-preview]')?.getAttribute('aria-label') === 'Updated title')
        break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (
      document.activeElement !== window.__previewCopyNode ||
      document.querySelector('.code-copy') !== window.__previewCopyNode
    )
      throw new Error('title update lost code control/focus')
    const anchor = document.querySelector('#rightbar-panel a')
    anchor.focus()
    window.__previewAnchor = anchor
  })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  assert.equal(
    await evaluate(() => document.activeElement.classList.contains('code-copy')),
    true,
    'Tab into code control',
  )
  const behavior = await evaluate(
    async ({ expectBlobBlocked }) => {
      const api = window.__documentPreviewProbe
      const host = document.getElementById('rightbar-panel')
      const wait = async (fn) => {
        for (let i = 0; i < 100; i++) {
          if (fn()) return
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        throw new Error('behavior timeout')
      }
      const expect = (condition, message) => {
        if (!condition) throw new Error(message)
      }
      api.show('text')
      await wait(() => host.querySelector('pre')?.textContent === 'Literal <safe> content')
      expect(!host.querySelector('safe'), 'text parsed as markup')
      api.show('empty')
      await wait(() => host.querySelector('pre')?.textContent === '')
      api.show('html')
      await wait(() => host.querySelector('strong')?.textContent === 'Safe HTML')
      expect(!host.querySelector('img,script,iframe'), 'unsafe HTML structure survived')
      api.show('image')
      await wait(
        () =>
          host.querySelector('img')?.complete &&
          host.querySelector('img')?.naturalWidth === (expectBlobBlocked ? 0 : 1),
      )
      const image = host.querySelector('img')
      const oldUrl = image.src
      expect(
        image.alt === 'Fixture image' && getComputedStyle(image).maxWidth === '100%',
        'image metadata/layout',
      )
      api.hold('image')
      api.show('text')
      await wait(() => host.querySelector('pre')?.textContent === 'Literal <safe> content')
      expect(api.revoked.includes(oldUrl), 'loaded image not released')
      api.show('image')
      expect(!host.querySelector('img'), 'revoked URL reused on return')
      await wait(() => api.requests.at(-1)?.documentId === 'image')
      api.show('text')
      await wait(() => host.querySelector('pre')?.textContent === 'Literal <safe> content')
      const acquiredBeforeLate = api.created.length
      api.release('image')
      await wait(() => api.created.length === acquiredBeforeLate + 1)
      expect(api.revoked.includes(api.created.at(-1)), 'late acquired URL not released')
      expect(
        host.querySelector('pre')?.textContent === 'Literal <safe> content' && !host.querySelector('img'),
        'late image wrote into B',
      )
      for (const status of [401, 403, 410, 500]) {
        api.show(`error-${status}`)
        await wait(
          () =>
            host.querySelector('pre')?.textContent ===
            (status === 410 ? '截图已按保留策略清理' : '文档资源暂不可用'),
        )
        expect(!host.textContent.includes('synthetic-private'), 'raw failure leaked')
      }
      api.show('pdf')
      await wait(() => host.querySelector('iframe')?.src.startsWith('blob:'))
      const frame = host.querySelector('iframe')
      await new Promise((resolve) => setTimeout(resolve, 500))
      const metadata = api.blobMetadata.find((entry) => entry.url === frame.src)
      await wait(() => metadata?.signature === '%PDF-1.4')
      expect(metadata.mime === 'application/pdf', 'PDF Blob MIME')
      expect(
        frame.title === 'Fixture pdf' &&
          frame.getAttribute('sandbox') === '' &&
          frame.getBoundingClientRect().height >= 384,
        'PDF sandbox/title/layout',
      )
      const pdf = {
        url: frame.src,
        width: frame.getBoundingClientRect().width,
        height: frame.getBoundingClientRect().height,
        byteLength: metadata.size,
      }
      api.show('markdown')
      await wait(() => host.querySelector('h1')?.textContent === 'Preview')
      api.shadow()
      await wait(() => !!document.getElementById('preview-return'))
      document.getElementById('preview-return').focus()
      window.__previewPdf = pdf
      return {
        literalText: true,
        empty: true,
        sanitizedHtml: true,
        imageDecoded: !expectBlobBlocked,
        oldUrlRejected: true,
        lateUrlReleased: true,
        failures: [401, 403, 410, 500],
        pdf,
      }
    },
    { expectBlobBlocked },
  )
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    text: '\r',
    unmodifiedText: '\r',
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  })
  await evaluate(
    async ({ expectBlobBlocked }) => {
      const api = window.__documentPreviewProbe
      const host = document.getElementById('rightbar-panel')
      const wait = async (fn) => {
        for (let i = 0; i < 100; i++) {
          if (fn()) return
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        throw new Error('replacement timeout')
      }
      await wait(() => host.querySelector('h1')?.textContent === 'Preview')
      if (document.getElementById('preview-return'))
        throw new Error('keyboard return did not withdraw plugin')
      api.shadow('rightbar.session')
      await wait(() => !!document.getElementById('preview-return'))
      api.restore()
      await wait(() => host.querySelector('h1')?.textContent === 'Preview')
      await api.remount()
      await wait(() => host.querySelector('h1')?.textContent === 'Preview')
      api.hold('image')
      api.show('image')
      await wait(() => api.requests.at(-1)?.documentId === 'image')
      api.setSession('fixture-b')
      await wait(() => api.requests.at(-1)?.sessionId === 'fixture-b')
      api.release('image')
      await wait(() => host.querySelector('img')?.naturalWidth === (expectBlobBlocked ? 0 : 1))
      api.setSession(undefined)
      await wait(() => !host.querySelector('img'))
      api.setSession('fixture-a')
      await wait(() => host.querySelector('img')?.naturalWidth === (expectBlobBlocked ? 0 : 1))
      api.show('markdown')
      await wait(() => host.querySelector('h1')?.textContent === 'Preview')
    },
    { expectBlobBlocked },
  )
  const themes = []
  for (const dark of [false, true]) {
    const styles = await evaluate(
      new Function(
        `document.documentElement.classList.toggle('dark', ${dark}); const host=document.getElementById('rightbar-panel'); return {color:getComputedStyle(host).color,token:getComputedStyle(host).getPropertyValue('--agnes-text-primary'),width:host.getBoundingClientRect().width,headingColor:getComputedStyle(host.querySelector('h1')).color}`,
      ),
    )
    assert.ok(styles.width > 200)
    themes.push(styles)
    const screenshot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(
      `/private/tmp/agh-w6b2-${dark ? 'dark' : 'light'}.png`,
      Buffer.from(screenshot.data, 'base64'),
    )
  }
  assert.notEqual(themes[0].token, themes[1].token)
  assert.notEqual(themes[0].headingColor, themes[1].headingColor)
  await evaluate(async () => {
    window.__documentPreviewProbe.show('pdf')
    for (let i = 0; i < 100; i++) {
      if (document.querySelector('#rightbar-panel iframe')?.src.startsWith('blob:')) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
  })
  const pdfScreenshot = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile('/private/tmp/agh-w6b2-pdf.png', Buffer.from(pdfScreenshot.data, 'base64'))
  const pdfFrameTree = await send('Page.getFrameTree')
  const cleanup = await evaluate(async () => {
    const api = window.__documentPreviewProbe
    await api.dispose()
    const count = api.requests.length
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (api.requests.length !== count || document.querySelector('#rightbar-panel [data-document-preview]'))
      throw new Error('retired work survived')
    if (api.created.length !== api.revoked.length || new Set(api.revoked).size !== api.created.length)
      throw new Error('URL acquisition/release mismatch')
    return { requestCount: count, acquired: api.created.length, released: api.revoked.length, retired: true }
  })
  const errors = events.filter(
    (e) =>
      e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && /Content Security Policy|Refused to/i.test(e.params.entry.text)),
  )
  const resourceFailures = events.filter(
    (e) =>
      e.method === 'Network.loadingFailed' ||
      (e.method === 'Network.responseReceived' && e.params.response.status >= 400),
  )
  if (expectBlobBlocked) {
    assert.ok(
      errors.some((e) => /Loading the image.*blob:/.test(e.params?.entry?.text ?? '')),
      'observed image CSP rejection',
    )
    assert.ok(
      errors.some((e) => /Framing.*blob:/.test(e.params?.entry?.text ?? '')),
      'observed PDF CSP rejection',
    )
    assert.deepEqual(
      errors.filter((e) => e.method === 'Runtime.exceptionThrown'),
      [],
      'application errors',
    )
    assert.deepEqual(
      resourceFailures.filter(
        (e) => e.params?.blockedReason !== 'csp' && e.params?.errorText !== 'net::ERR_BLOCKED_BY_CSP',
      ),
      [],
      'non-CSP resource failures',
    )
  } else if (expectPdfBlocked) {
    assert.deepEqual(errors, [], 'application/CSP errors')
    const requests = new Map(
      events
        .filter((e) => e.method === 'Network.requestWillBeSent')
        .map((e) => [e.params.requestId, e.params.request.url]),
    )
    assert.ok(resourceFailures.length > 0, 'native sandboxed PDF refusal observed')
    for (const failure of resourceFailures) {
      assert.equal(failure.method, 'Network.loadingFailed')
      assert.equal(failure.params.type, 'Document')
      assert.equal(failure.params.errorText, 'net::ERR_BLOCKED_BY_CLIENT')
      assert.ok(
        requests.get(failure.params.requestId)?.startsWith('blob:'),
        'only Blob PDF navigation refused',
      )
    }
    const previewFrame = pdfFrameTree.frameTree.childFrames?.find(
      (item) => item.frame.url === 'chrome-error://chromewebdata/',
    )
    assert.ok(previewFrame, 'browser error frame instead of native PDF viewer')
  } else {
    assert.deepEqual(errors, [], 'application/CSP errors')
    assert.deepEqual(resourceFailures, [], 'resource failures')
  }
  const pdfResponses = events
    .filter((e) => e.method === 'Network.responseReceived' && e.params.response.url === behavior.pdf.url)
    .map((e) => ({ status: e.params.response.status, mime: e.params.response.mimeType, type: e.params.type }))
  if (!expectBlobBlocked && !expectPdfBlocked)
    assert.ok(
      pdfResponses.some((r) => r.status === 200 && r.mime === 'application/pdf'),
      'actual PDF response',
    )
  const manifestPath = '/private/tmp/agh-w6b2-runtime-manifest.json'
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  Object.assign(manifest, {
    browser,
    origin,
    server: 'current packages/web/src/serve-entry.ts; Node/tsx',
    assets,
    markdown,
    behavior,
    themes,
    cleanup,
    pdfResponses,
    pdfFrameTree,
    applicationErrors: 0,
    cspErrors: errors.length,
    resourceFailures: resourceFailures.length,
    expectedBlobBlocked: expectBlobBlocked,
    expectedPdfBlocked: expectPdfBlocked,
    acceptanceComplete: !expectBlobBlocked && !expectPdfBlocked,
  })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(
    JSON.stringify({
      browser: browser.product,
      markdown,
      behavior,
      themes,
      cleanup,
      pdfResponses,
      applicationErrors: 0,
      cspErrors: errors.length,
      resourceFailures: resourceFailures.length,
      expectedBlobBlocked: expectBlobBlocked,
      expectedPdfBlocked: expectPdfBlocked,
      acceptanceComplete: !expectBlobBlocked && !expectPdfBlocked,
    }),
  )
} catch (error) {
  console.log(
    JSON.stringify(
      await evaluate(() => ({
        rightbar: document.getElementById('rightbar-panel')?.innerHTML,
        requests: window.__documentPreviewProbe?.requests,
        created: window.__documentPreviewProbe?.created,
        revoked: window.__documentPreviewProbe?.revoked,
      })),
    ),
  )
  console.log(
    JSON.stringify(
      events.filter((e) => e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded'),
    ),
  )
  throw error
} finally {
  socket.close()
}
