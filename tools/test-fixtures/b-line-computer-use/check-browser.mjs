import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const origin = 'http://127.0.0.1:4197'
const debug = 'http://127.0.0.1:9233'
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
const evaluate = async (fn) => {
  const result = await send('Runtime.evaluate', {
    expression: `(${fn.toString()})()`,
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
  for (const path of [
    '/style.css',
    '/tokens.css',
    '/antd.css',
    ...Object.values(JSON.parse(importMap).imports),
  ]) {
    const resource = await fetch(origin + path)
    assert.equal(resource.status, 200, path)
    assert.match(
      resource.headers.get('content-type') ?? '',
      path.endsWith('.css') ? /^text\/css/ : /^text\/javascript/,
    )
  }
  await send('Page.navigate', { url: origin })
  await evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const refresh = document.getElementById('computer-use-refresh')
      if (window.__computerUseProbe && refresh && !refresh.disabled) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('startup timeout')
  })
  const initial = await evaluate(() => {
    const pane = document.getElementById('computer-use-settings-pane')
    if (pane.hidden || pane.querySelectorAll('.config-card').length !== 4)
      throw new Error('four visible sections missing')
    if (document.getElementById('computer-use-runtime').textContent !== '运行时：0 个活动会话')
      throw new Error('zero sessions lost')
    document.getElementById('computer-use-refresh').focus()
    return {
      cards: pane.querySelectorAll('.config-card').length,
      bounds: pane.getBoundingClientRect().toJSON(),
    }
  })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  assert.equal(await evaluate(() => document.activeElement.id), 'computer-use-permission-grant')
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
  const behavior = await evaluate(async () => {
    const api = window.__computerUseProbe
    const text = (id) => document.getElementById(`computer-use-${id}`)?.textContent
    const button = (id) => document.getElementById(`computer-use-${id}`)
    const expect = (condition, message) => {
      if (!condition) throw new Error(message)
    }
    const wait = async (fn) => {
      for (let i = 0; i < 100; i++) {
        if (fn()) return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error('behavior timeout')
    }
    await wait(() => text('permission-state') === '已授权')
    expect(
      api.requests.filter((r) => r.method.endsWith('permissions.grant')).length === 1,
      'keyboard grant duplicated',
    )
    api.hold('doctor')
    const oldDoctor = button('doctor-run')
    oldDoctor.focus()
    oldDoctor.click()
    await wait(() => text('doctor-state') === '正在检查')
    expect(button('doctor-run') === oldDoctor, 'pending doctor button replaced')
    await api.replace()
    await wait(() => document.getElementById('cu-replacement'))
    api.restore()
    await wait(() => text('state') === '运行中' && !button('refresh').disabled)
    expect(!document.getElementById('computer-use-settings-pane').hidden, 'active replacement hidden')
    api.release('doctor', { status: 'failed' })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(text('doctor-state') === '等待检查', 'retired doctor reply leaked')
    button('doctor-run').click()
    await wait(() => text('doctor-state') === '检查通过')
    button('update').click()
    button('update').click()
    await wait(() => text('operation-state') === '正在安装')
    expect(api.requests.filter((r) => r.method.endsWith('operation.start')).length === 1, 'start duplicated')
    expect(button('update').disabled && !button('operation-cancel').hidden, 'pending controls wrong')
    api.hide()
    expect(document.getElementById('computer-use-settings-pane').hidden, 'page switch did not hide')
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(
      api.requests.some(
        (r) => r.method.endsWith('operation.status') && r.params.operationId === 'cu-browser',
      ),
      'hidden polling stopped',
    )
    await api.replace()
    await wait(() => document.getElementById('cu-replacement'))
    api.show()
    api.restore()
    await wait(() => text('operation-state') === '正在安装')
    expect(!document.getElementById('computer-use-settings-pane').hidden, 'remount navigation lost')
    expect(
      api.requests.filter((r) => r.method.endsWith('operation.start')).length === 1,
      'remount replayed start',
    )
    button('operation-cancel').click()
    await wait(() => text('operation-state') === '已取消' && !button('update').disabled)
    expect(
      api.requests.filter((r) => r.method.endsWith('operation.cancel')).length === 1,
      'cancel duplicated',
    )
    expect(
      api.requests.find((r) => r.method.endsWith('operation.cancel')).params.operationId === 'cu-browser',
      'cancel ID lost',
    )
    const refresh = button('refresh')
    const focused = button('doctor-run')
    focused.focus()
    await api.refresh()
    await wait(() => !refresh.disabled)
    expect(button('refresh') === refresh && document.activeElement === focused, 'status refresh focus lost')
    api.configure({ fail: true })
    await api.refresh()
    await wait(() => text('state') === '无法读取')
    expect(
      text('runtime') === '' &&
        !document.getElementById('config').textContent.includes('synthetic-private-credential'),
      'unsafe error/details',
    )
    api.configure({
      report: {
        status: 'blocked',
        admission: { reason: 'runtime-unavailable' },
        blockers: ['driver-prepare-failed'],
      },
    })
    await api.refresh()
    await wait(() => !button('install').disabled)
    expect(text('state') === '准备失败' && button('update').disabled, 'retry gate wrong')
    api.configure({})
    await api.refresh()
    await wait(() => !button('update').disabled)
    button('update').click()
    await wait(() => text('operation-state') === '正在安装')
    api.configure({
      operation: {
        status: 'found',
        operationId: 'cu-browser',
        kind: 'update',
        state: 'succeeded',
        phase: 'complete',
      },
    })
    await wait(() => text('operation-state') === '操作完成' && !button('update').disabled)
    return {
      starts: 2,
      cancels: 1,
      retiredDoctorIgnored: true,
      hiddenPolling: true,
      remountRecovery: true,
      focus: true,
      safeFailure: true,
      retry: true,
    }
  })
  const themes = []
  for (const dark of [false, true]) {
    const styles = await evaluate(
      new Function(
        `document.documentElement.classList.toggle('dark', ${dark}); const pane=document.getElementById('computer-use-settings-pane'); return {color:getComputedStyle(pane).color,background:getComputedStyle(document.getElementById('config')).backgroundColor,token:getComputedStyle(pane).getPropertyValue('--agnes-text-primary'),width:pane.getBoundingClientRect().width}`,
      ),
    )
    assert.ok(styles.width > 300)
    themes.push(styles)
    const screenshot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(
      `/private/tmp/agh-w6a2-${dark ? 'dark' : 'light'}.png`,
      Buffer.from(screenshot.data, 'base64'),
    )
  }
  assert.notEqual(themes[0].token, themes[1].token)
  const cleanup = await evaluate(async () => {
    const api = window.__computerUseProbe
    await api.dispose()
    const count = api.requests.length
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (api.requests.length !== count || document.getElementById('computer-use-state'))
      throw new Error('retired work survived')
    return { retired: true, requestCount: count }
  })
  const errors = events.filter(
    (e) =>
      e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && /Content Security Policy|Refused to/i.test(e.params.entry.text)),
  )
  const requestsFailed = events.filter(
    (e) =>
      e.method === 'Network.loadingFailed' ||
      (e.method === 'Network.responseReceived' && e.params.response.status >= 400),
  )
  assert.deepEqual(errors, [], 'application/CSP errors')
  assert.deepEqual(requestsFailed, [], 'failed resources')
  const manifestPath = '/private/tmp/agh-w6a2-runtime-manifest.json'
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  Object.assign(manifest, {
    browser,
    origin,
    server: 'current packages/web/src/serve-entry.ts; Node/tsx',
    initial,
    behavior,
    themes,
    cleanup,
    applicationErrors: 0,
    cspErrors: 0,
    resourceFailures: 0,
  })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(
    JSON.stringify({
      browser: browser.product,
      initial,
      behavior,
      themes,
      cleanup,
      cspErrors: 0,
      applicationErrors: 0,
      resourceFailures: 0,
    }),
  )
} catch (error) {
  console.log(
    JSON.stringify(
      await evaluate(() => ({
        focus: document.activeElement.id,
        permission: document.getElementById('computer-use-permission-state')?.textContent,
        doctor: document.getElementById('computer-use-doctor-state')?.textContent,
        operation: document.getElementById('computer-use-operation-state')?.textContent,
        requests: window.__computerUseProbe?.requests,
      })),
    ),
  )
  throw error
} finally {
  socket.close()
}
