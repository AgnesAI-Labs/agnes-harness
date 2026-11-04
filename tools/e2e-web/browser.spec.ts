import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_STREAM_OPEN_PATH, PLUGIN_STREAM_PATH, rpcError } from '@agnes/protocol'
import { expect, test } from './fixtures.js'
import { complete, prompt, toolResult } from './sdk.js'
import { closeSettings, homePage, preferences, settings, workbenchTab } from './ui.js'

const archive = process.env.AGH_BROWSER_TEST_ARCHIVE
test.skip(
  !archive || !existsSync(archive),
  'Provision the reviewed native archive with AGH_BROWSER_TEST_ARCHIVE.',
)
test.describe.configure({ timeout: 480_000 })

test('built-in browser displays the agent page, admits human input and refuses cross-session or forged control', async ({
  page,
  runtime,
  expectedBrowserErrors,
}) => {
  const failures: Promise<unknown>[] = []
  const reads: { service: string; started: number; durationMs?: number; status?: number }[] = []
  const timings: typeof reads = []
  const pendingReads = new Map<import('@playwright/test').Request, (typeof reads)[number]>()
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (
      ![
        '/api/client-modules/profile',
        '/api/client-modules/service',
        '/api/client-modules/effect',
        PLUGIN_STREAM_OPEN_PATH,
      ].includes(path)
    )
      return
    const body = request.postDataJSON() as { service?: string; name?: string }
    const service = body?.service ?? body?.name
    if (!service?.startsWith('browser.')) return
    const entry = {
      service: path === PLUGIN_STREAM_OPEN_PATH ? `stream:${service}` : service,
      started: performance.now(),
    }
    timings.push(entry)
    if (path === '/api/client-modules/profile' || path === '/api/client-modules/service') reads.push(entry)
    pendingReads.set(request, entry)
  })
  page.on('response', (response) => {
    const entry = pendingReads.get(response.request())
    if (entry) {
      entry.durationMs = performance.now() - entry.started
      entry.status = response.status()
      pendingReads.delete(response.request())
    }
    const path = new URL(response.url()).pathname
    if (
      response.status() < 400 ||
      !(path.startsWith('/api/client-modules/') || path === PLUGIN_STREAM_OPEN_PATH)
    )
      return
    failures.push(
      response
        .text()
        .then((body) => ({
          url: response.url(),
          status: response.status(),
          request: response.request().postDataJSON(),
          body,
        }))
        .catch((error) => ({ url: response.url(), error: String(error) })),
    )
  })
  const received: string[] = []
  const scrolls: number[] = []
  const site = createServer((req, res) => {
    const target = new URL(req.url ?? '/', 'http://fixture.test')
    if (target.pathname === '/scroll') {
      scrolls.push(Number(target.searchParams.get('y')))
      res.end('ok')
      return
    }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        received.push(body)
        res.end('ok')
      })
      return
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(
      '<!doctype html><meta charset="utf-8"><style>body{margin:0;min-height:1800px}input{position:absolute;top:80px;left:16px;width:240px;height:32px}button{position:absolute;top:130px;left:16px}</style>' +
        "<h1>One shared page</h1><input placeholder=\"Name\"><button onclick=\"fetch('/submit',{method:'POST',body:document.querySelector('input').value});document.querySelector('#result').textContent=document.querySelector('input').value\">Confirm</button><p id=\"result\"></p><script>addEventListener('scroll',()=>fetch('/scroll?y='+scrollY))</script>",
    )
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  const address = site.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not start')
  const url = 'http://127.0.0.1:' + address.port
  try {
    const client = await runtime.connect()
    let row: Awaited<ReturnType<typeof client.clientModules.list>>['rows'][number] | undefined
    await expect
      .poll(
        async () => {
          const roster = await client.clientModules.list('local-dev')
          row = roster.rows.find((entry) => entry.packageId === '@agnes/browser')
          return row?.phase ?? JSON.stringify(roster.statuses)
        },
        { timeout: 60_000 },
      )
      .toBe('ready')
    const session = await client.session.new({
      sessionKey: randomUUID(),
      cwd: runtime.workspace,
      preset: 'standard',
      permission: 'full-access',
    })
    await preferences(page)
    const skip = page.getByTestId('first-run-skip')
    await page.addLocatorHandler(
      skip,
      async () => {
        await skip.click()
      },
      { times: 1 },
    )
    await page.goto(runtime.url + '/?session=' + session.id)
    await expect(page.locator('#settings')).toBeVisible({ timeout: 60_000 })
    await settings(page)
    await expect(page.getByTestId('settings-nav-browser')).toHaveCount(0)
    await expect(page.locator('.agh-browser-settings')).toHaveCount(0)
    await closeSettings(page)
    // Leaving Settings may return to a draft; explicitly resume the session under test.
    await page.locator(`.session[data-session="${session.id}"]`).click()
    await prompt(session, 'hello')
    await expect(page.getByTestId('workbench-right-toggle')).toBeVisible({ timeout: 30_000 })
    // An ordinary greeting must not open the user's dock.
    await expect(page.getByTestId('workbench-right-toggle')).toHaveAttribute('aria-expanded', 'false')
    await prompt(session, 'call present {"files":[{"path":"report.md","name":"Delivery report.md"}]}')
    const delivered = page.getByTestId('turn-deliverables').last()
    await expect(delivered).toBeVisible()
    await expect(page.getByTestId('workbench-right-toggle')).toHaveAttribute('aria-expanded', 'false')
    await delivered.locator('.agh-list-row-title').click()
    await expect(page.getByTestId('workbench-deliverables')).toBeVisible()
    await expect(page.locator('.deliverable-preview')).toContainText('Synthetic delivery')
    await expect(page.locator('.agh-browser-panel')).toHaveCount(0)
    await page.getByTestId('workbench-right-toggle').click()
    await workbenchTab(page, 'browser')
    await expect(page.locator('.agh-browser-panel')).toBeVisible({ timeout: 60_000 })
    const address = page.getByRole('textbox', { name: 'URL or file path on the AGH runtime' })
    await expect(address).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open', exact: true })).toBeEnabled({ timeout: 60_000 })
    await expect(page.getByRole('button', { name: 'Load browser', exact: true })).toHaveCount(0)
    expect(timings.filter((entry) => entry.service === 'browser.connect')).toHaveLength(0)
    await address.fill(runtime.url)
    await address.press('Enter')
    await expect(page.getByRole('alert')).toHaveText('AGH management and cloud metadata URLs are blocked.', {
      timeout: 30_000,
    })
    await expect(page.getByRole('button', { name: 'Check previous action', exact: true })).toHaveCount(0)
    const callBrowser = async (input: Record<string, unknown>) => {
      await prompt(session, 'call browser ' + JSON.stringify(input))
      const result = await toolResult(session, 'browser')
      const text = result?.content?.find((item) => item.type === 'text')
      if (!text || text.type !== 'text') throw new Error('Missing browser result')
      return JSON.parse(text.text)
    }
    await page.getByTestId('workbench-right-toggle').click()
    await expect(page.getByTestId('workbench-right-toggle')).toHaveAttribute('aria-expanded', 'false')
    await prompt(session, 'call tool_describe {"name":"browser"}')
    const opened = await callBrowser({ action: 'open', url })
    await expect(page.getByTestId('workbench-right-toggle')).toHaveAttribute('aria-expanded', 'false')
    const hiddenRequests = timings.length
    await page.waitForTimeout(3500)
    expect(timings).toHaveLength(hiddenRequests)
    // Empty history has no input admission. Refuse it only when a real page is shown.
    expectedBrowserErrors.push(
      'console: Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
    )
    await page.route(
      '**/api/client-modules/effect',
      (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: rpcError('CAPABILITY_DENIED') }),
        }),
      { times: 1 },
    )
    const refused = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/client-modules/effect') &&
        response.request().postDataJSON()?.service === 'browser.connect' &&
        response.status() === 503,
    )
    await workbenchTab(page, 'browser')
    await refused
    await expect(page.locator('.agh-browser-panel')).toBeVisible()
    await expect(page.locator('.agh-browser-screen')).toContainText('Live', { timeout: 30_000 })
    await page.reload()
    await expect(page.locator('.agh-browser-screen')).toContainText('Live')
    await expect(page.getByRole('button', { name: 'Load browser', exact: true })).toHaveCount(0)
    await expect(page.locator('.agh-browser-panel [role="alert"]')).toHaveCount(0)
    // This flow measures legacy desktop-sized coordinates. Adaptive sizing is
    // the default and is exercised by the selection and multi-tab flows below.
    await page.getByRole('button', { name: 'Browser options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Use fixed desktop size (1280 × 800)', exact: true }).click()
    let observed = await callBrowser({ action: 'inspect', pageId: opened.pageId })
    const input = observed.elements.find((entry: { label: string }) => entry.label === 'Name')
    await callBrowser({
      action: 'fill',
      pageId: opened.pageId,
      pageEpoch: observed.pageEpoch,
      ref: input.ref,
      text: 'from-agent',
    })
    observed = await callBrowser({ action: 'inspect', pageId: opened.pageId })
    const confirm = observed.elements.find((entry: { label: string }) => entry.label === 'Confirm')
    await callBrowser({
      action: 'click',
      pageId: opened.pageId,
      pageEpoch: observed.pageEpoch,
      ref: confirm.ref,
    })
    await expect.poll(() => received).toContain('from-agent')
    const idleStart = performance.now()
    const idleOffset = reads.length
    // Observe an actual idle window; live streams must replace periodic browser HTTP reads.
    await page.waitForTimeout(10_000)
    const idleReads = reads.slice(idleOffset)
    await test.info().attach('browser-idle-requests.json', {
      body: JSON.stringify({
        build: process.env.AGH_WEB_TEST_ENTRY ?? 'packages/cli/dist/local/agnes.mjs',
        durationMs: performance.now() - idleStart,
        requests: idleReads,
      }),
      contentType: 'application/json',
    })
    expect(idleReads).toEqual([])
    await expect
      .poll(
        () =>
          page.locator('.agh-browser-screen canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width),
        { timeout: 10_000 },
      )
      .toBe(2560)
    const typing = page.getByRole('textbox', { name: 'Type into the web page', exact: true })
    const screen = page.locator('.agh-browser-screen')
    await expect(screen).toHaveAttribute('data-controlling', 'false')
    const canvas = page.getByRole('img', { name: 'Live browser page' })
    const box = await canvas.boundingBox()
    if (!box) throw new Error('Canvas is not visible')
    const takeoverStart = performance.now()
    await canvas.click({ position: { x: (box.width * 40) / 1280, y: (box.height * 96) / 800 } })
    // The first click requests native control. Type on the page, without targeting a separate editor.
    await expect(typing).toBeFocused({ timeout: 30_000 })
    await expect(screen).toHaveAttribute('data-controlling', 'true')
    await test.info().attach('browser-takeover-timing.json', {
      body: JSON.stringify({ firstClickToInputReadyMs: performance.now() - takeoverStart }),
      contentType: 'application/json',
    })
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('direct-keyboard')
    await canvas.click({ position: { x: (box.width * 45) / 1280, y: (box.height * 140) / 800 } })
    await expect.poll(() => received).toContain('direct-keyboard')
    await canvas.click({ position: { x: (box.width * 40) / 1280, y: (box.height * 96) / 800 } })
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.insertText('人工接管')
    await canvas.click({ position: { x: (box.width * 45) / 1280, y: (box.height * 140) / 800 } })
    await expect.poll(() => received).toContain('人工接管')
    const same = await callBrowser({ action: 'inspect', pageId: opened.pageId })
    expect(same.pageId).toBe(opened.pageId)
    expect(same.text).toContain('人工接管')
    await page.keyboard.press('Escape')
    await expect(typing).toBeFocused()
    await test.info().attach('shared-page.png', { body: await page.screenshot(), contentType: 'image/png' })
    await canvas.hover()
    await page.mouse.wheel(0, 240)
    await expect.poll(() => scrolls.at(-1) ?? 0).toBeGreaterThan(0)
    await page.mouse.wheel(0, -400)
    await expect.poll(() => scrolls.at(-1)).toBe(0)
    const other = await client.session.new({
      sessionKey: randomUUID(),
      cwd: runtime.workspace,
      preset: 'standard',
      permission: 'full-access',
    })
    expect(other.id).not.toBe(session.id)
    const open = async (
      sessionId: string,
      name: string,
      input: Record<string, unknown>,
      operationId?: string,
    ) =>
      fetch(runtime.url + PLUGIN_STREAM_OPEN_PATH, {
        method: 'POST',
        headers: { Origin: runtime.url, 'content-type': 'application/json', 'x-agnes-stream-open': '1' },
        body: JSON.stringify({
          owner: row!.moduleName,
          name,
          client: { rowId: row!.rowId, revision: row!.revision, contentDigest: row!.contentDigest },
          scope: { kind: 'session', profileId: 'local-dev', sessionId, laneId: 'main' },
          input,
          ...(operationId ? { controlOperationId: operationId } : {}),
        }),
      })
    expect((await open(other.id, 'browser.frames', { pageId: opened.pageId })).status).toBe(403)
    expect(
      (await open(session.id, 'browser.input', { pageId: opened.pageId, mode: 'human' }, 'forged')).status,
    ).toBe(403)
    // Modern input shares the page after an idle gap; no manual return is needed.
    const fresh = await callBrowser({ action: 'inspect', pageId: opened.pageId })
    const submissions = received.length
    await callBrowser({
      action: 'click',
      pageId: opened.pageId,
      pageEpoch: fresh.pageEpoch,
      ref: fresh.elements.find((entry: { label: string }) => entry.label === 'Confirm').ref,
    })
    await expect.poll(() => received.length).toBe(submissions + 1)
    const secondTab = await callBrowser({ action: 'open', url: url + '/second' })
    const tabs = page.locator('.agh-browser-tabs').getByRole('tab')
    await expect(tabs).toHaveCount(2)
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    await callBrowser({ action: 'inspect', pageId: secondTab.pageId })
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    await tabs.nth(1).click()
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.agh-browser-screen [data-connected="true"]')).toHaveCount(1)
    const displayOpens = timings.filter((entry) => entry.service === 'stream:browser.frames').length
    for (let index = 0; index < 12; index++) {
      await tabs.nth(index % 2).click()
      await expect(tabs.nth(index % 2)).toHaveAttribute('aria-selected', 'true')
      await expect(page.locator('.agh-browser-screen [data-connected="true"]')).toHaveCount(1)
    }
    expect(timings.filter((entry) => entry.service === 'stream:browser.frames')).toHaveLength(displayOpens)
    expect(timings.filter((entry) => entry.status === 429)).toEqual([])
    await canvas.click({ position: { x: 40, y: 40 } })
    await expect(screen).toHaveAttribute('data-controlling', 'true')
    await callBrowser({ action: 'inspect', pageId: opened.pageId })
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await tabs.nth(0).click()
    await expect(screen).toHaveAttribute('data-controlling', 'false')
    await canvas.click({ position: { x: 40, y: 40 } })
    await expect(screen).toHaveAttribute('data-controlling', 'true')
    await tabs.nth(1).click()
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(screen).toHaveAttribute('data-controlling', 'false')
    await page.setViewportSize({ width: 980, height: 900 })
    await expect
      .poll(() =>
        page.locator('.agh-browser-address').evaluate((node) => node.scrollWidth <= node.clientWidth),
      )
      .toBe(true)
    await expect(page.getByRole('combobox', { name: 'Browser tabs', exact: true })).toHaveCount(0)
    await test
      .info()
      .attach('browser-compact.png', { body: await page.screenshot(), contentType: 'image/png' })
    // Resizing can move the tab-overflow trigger under the stationary pointer.
    // Leave its hover menu before targeting the toolbar below it.
    await page.locator('#prompt').hover()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await page.getByRole('button', { name: 'Browser options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Show at 100%', exact: true }).click()
    await expect(page.locator('.agh-browser-screen')).toHaveAttribute('data-scale', 'actual')
    expect(
      await page
        .locator('.agh-browser-screen canvas')
        .evaluate((canvas) => canvas.getBoundingClientRect().width),
    ).toBe(1280)
    await expect(page.locator('.agh-browser-screen [data-connected="true"]')).toHaveCount(1, {
      timeout: 30_000,
    })
    await test.info().attach('browser-actual-size.png', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    })
    const restoredUrl = page.url()
    await page.goto('about:blank')
    await runtime.restart()
    const beforeRestartView = timings.length
    await page.goto(restoredUrl)
    // Use the existing cold-start readiness contract before checking a plugin panel.
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(address).toBeVisible()
    await expect(page.getByRole('button', { name: 'Load browser', exact: true })).toHaveCount(0)
    await page.waitForTimeout(3500)
    expect(timings.slice(beforeRestartView).map((entry) => entry.service)).not.toContain('browser.connect')
    expect(timings.slice(beforeRestartView).map((entry) => entry.service)).not.toContain(
      'stream:browser.frames',
    )
    await expect(page.locator('.agh-browser-screen')).toHaveCount(0)
    await expect(page.locator('.agh-browser-panel [role="alert"]')).toHaveCount(0)
    await test.info().attach('browser-restored-passive.png', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    })
    await expect(page.getByRole('button', { name: 'Open', exact: true })).toBeEnabled()
    const restored = await (await runtime.connect()).session.open(session.id, { cwd: runtime.workspace })
    await prompt(restored, 'call browser ' + JSON.stringify({ action: 'open', url }))
    await toolResult(restored, 'browser')
    await expect(page.locator('.agh-browser-screen')).toContainText('Live')
    await expect(page.locator('.agh-browser-panel [role="alert"]')).toHaveCount(0)
  } finally {
    let timer: ReturnType<typeof setTimeout> | undefined
    const details = await Promise.race([
      Promise.all(failures),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve([{ error: 'Response body collection timed out' }]), 2000)
      }),
    ])
    clearTimeout(timer)
    await test.info().attach('bff-failures.json', {
      body: JSON.stringify(details),
      contentType: 'application/json',
    })
    await test.info().attach('browser-request-timing.json', {
      body: JSON.stringify(timings),
      contentType: 'application/json',
    })
    site.closeAllConnections()
    await new Promise<void>((resolve) => site.close(() => resolve()))
  }
})

test('text-only tabs stay responsive through large pages, input and continuous frames without opening audio', async ({
  page,
  runtime,
}) => {
  const client = await runtime.connect()
  const session = await client.session.new({
    sessionKey: randomUUID(),
    cwd: runtime.workspace,
    preset: 'standard',
    permission: 'full-access',
  })
  await prompt(session, 'call tool_describe {"name":"browser"}')
  for (const count of [1, 100, 10000]) {
    const file = join(runtime.workspace, `buttons-${count}.html`)
    await writeFile(
      file,
      `<!doctype html><meta charset="utf-8"><style>body{margin:20px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px}button{height:30px}</style><h1>Buttons ${count}</h1><p id="status">Ready</p><div class="grid"></div><script>
      const grid=document.querySelector('.grid'),fragment=document.createDocumentFragment();
      for(let n=0;n<${count};n++){const button=document.createElement('button');button.textContent='Item '+n;fragment.append(button)}grid.append(fragment);
      grid.onclick=e=>{if(e.target.tagName==='BUTTON')document.querySelector('#status').textContent=e.target.textContent};
      let tick=0;setInterval(()=>document.title='Frame '+tick++,33);
      setInterval(()=>document.querySelector('h1').style.color=tick%2?'#111':'#333',100);
    </script>`,
    )
    await prompt(session, 'call browser ' + JSON.stringify({ action: 'open', url: pathToFileURL(file).href }))
    await toolResult(session, 'browser')
  }
  await page.addInitScript(() => {
    const state = { audioOpened: false, maxGap: 0, last: performance.now() }
    ;(window as unknown as { browserHealth: typeof state }).browserHealth = state
    const Context = window.AudioContext
    window.AudioContext = new Proxy(Context, {
      construct(target, args) {
        state.audioOpened = true
        return Reflect.construct(target, args)
      },
    })
    setInterval(() => {
      const now = performance.now()
      state.maxGap = Math.max(state.maxGap, now - state.last)
      state.last = now
    }, 100)
  })
  await preferences(page)
  const skip = page.getByTestId('first-run-skip')
  await page.addLocatorHandler(skip, () => skip.click(), { times: 1 })
  await page.goto(runtime.url + '/?session=' + session.id)
  await page.locator('#prompt').waitFor({ timeout: 60_000 })
  await workbenchTab(page, 'browser')
  const connected = page.locator('.agh-browser-connection[data-connected="true"]')
  await expect(connected).toHaveCount(1)
  await page.evaluate(() => {
    const state = (window as unknown as { browserHealth: { maxGap: number; last: number } }).browserHealth
    state.maxGap = 0
    state.last = performance.now()
  })
  for (let round = 0; round < 4; round++) {
    for (const count of [1, 100, 10000]) {
      // Keyboard selection also works when the native tabs overflow a narrow panel.
      const tab = page
        .locator('.agh-browser-tabs')
        .getByRole('tab')
        .filter({ hasText: `/buttons-${count}.html` })
      await tab.focus()
      await page.keyboard.press('Enter')
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      await expect(connected).toHaveCount(1)
      await page.locator('.agh-browser-screen canvas').click({ position: { x: 40, y: 40 } })
      await page.keyboard.press('ArrowDown')
      await page.mouse.wheel(0, 120)
      await page.locator('#prompt').fill(`responsive-${round}-${count}`)
      await expect(page.locator('#prompt')).toHaveValue(`responsive-${round}-${count}`)
      const health = await page.evaluate(
        () =>
          (window as unknown as { browserHealth: { audioOpened: boolean; maxGap: number } }).browserHealth,
      )
      expect(health.audioOpened).toBe(false)
      expect(health.maxGap).toBeLessThan(2000)
    }
  }
})

test('one plugin switch enables the browser, revokes old control, and stays off across restart', async ({
  page,
  runtime,
  expectedBrowserErrors,
}) => {
  // Three native publications and a Windows daemon restart exceeded the former eight-minute budget.
  test.setTimeout(600_000)
  let client = await runtime.connect()
  const session = await client.session.new({
    sessionKey: randomUUID(),
    cwd: runtime.workspace,
    preset: 'standard',
    permission: 'full-access',
  })
  let row: Awaited<ReturnType<typeof client.clientModules.list>>['rows'][number] | undefined
  await expect
    .poll(
      async () => {
        row = (await client.clientModules.list('local-dev')).rows.find(
          (entry) => entry.packageId === '@agnes/browser',
        )
        return row?.phase
      },
      { timeout: 60_000 },
    )
    .toBe('ready')
  const callBrowser = async (input: Record<string, unknown>) => {
    await prompt(session, 'call browser ' + JSON.stringify(input))
    const result = await toolResult(session, 'browser')
    const text = result?.content?.find((item) => item.type === 'text')
    if (!text || text.type !== 'text') throw new Error('Missing browser result')
    return JSON.parse(text.text)
  }
  let navigatingAway = false
  page.on('response', (response) => {
    if (
      !navigatingAway ||
      response.status() !== 503 ||
      !['/api/client-modules/profile', '/api/client-modules/service'].includes(
        new URL(response.url()).pathname,
      )
    )
      return
    const request = response.request().postDataJSON() as { rowId?: string; service?: string }
    if (
      request?.rowId !== row?.rowId ||
      !['browser.status', 'browser.pages', 'browser.events'].includes(request.service ?? '')
    )
      return
    // Only in-flight reads of this browser owner are expected to be refused as its view/owner leaves.
    expectedBrowserErrors.push(
      'console: Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
    )
  })
  await preferences(page)
  const skip = page.getByTestId('first-run-skip')
  await page.addLocatorHandler(
    skip,
    async () => {
      await skip.click()
    },
    { times: 1 },
  )
  await page.goto(runtime.url + '/?session=' + session.id)
  await expect(page.locator('#settings')).toBeVisible({ timeout: 60_000 })
  await prompt(session, 'call tool_describe {"name":"browser"}')
  await expect(page.getByTestId('workbench-right-toggle')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.agh-browser-panel')).toHaveCount(0)
  await workbenchTab(page, 'browser')
  await expect(page.locator('.agh-browser-panel')).toBeVisible({ timeout: 60_000 })
  // A local project page is real; it does not require an external website or personal browser.
  const site = createServer((_req, res) => {
    res.end('<!doctype html><h1>Plugin switch fixture</h1><input placeholder="Name">')
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  const address = site.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not start')
  const url = 'http://127.0.0.1:' + address.port
  try {
    const [interactionRequest, opened] = await Promise.all([
      page.waitForRequest(
        (request) =>
          request.url().endsWith(PLUGIN_STREAM_OPEN_PATH) &&
          request.postDataJSON()?.name === 'browser.interaction',
      ),
      callBrowser({ action: 'open', url }),
    ])
    await expect(page.locator('.agh-browser-screen')).toContainText('Live')
    await page.locator('.agh-browser-screen canvas').click({ position: { x: 40, y: 40 } })
    await expect(page.locator('.agh-browser-screen')).toHaveAttribute('data-controlling', 'true')
    const priorInteraction = interactionRequest.postDataJSON()
    const openOldInteraction = () =>
      fetch(runtime.url + PLUGIN_STREAM_OPEN_PATH, {
        method: 'POST',
        headers: { Origin: runtime.url, 'content-type': 'application/json', 'x-agnes-stream-open': '1' },
        // Replay the captured request unchanged. Replacing its client revision
        // would test a current client opening a transport, not a stale request.
        body: JSON.stringify(priorInteraction),
      })
    const plugin = page.locator('.plugin-row[data-plugin-id="@agnes/browser"]')
    const toggle = plugin.getByRole('switch')
    const switchPlugin = async (enabled: boolean) => {
      navigatingAway = true
      await homePage(page, 'plugins')
      await expect(toggle).toBeVisible({ timeout: 60_000 })
      await toggle.click()
      const submitted = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/admin/plugins/api/${enabled ? 'enable' : 'disable'}` &&
          response.request().method() === 'POST',
      )
      await page
        .getByRole('dialog', {
          name: enabled ? 'Enable “Built-in browser”' : 'Disable “Built-in browser”?',
          exact: true,
        })
        .getByRole('button', { name: enabled ? 'Enable' : 'Disable', exact: true })
        .click()
      const response = await submitted
      expect(response.ok()).toBe(true)
      const receipt = (await response.json()) as Awaited<ReturnType<typeof client.packages.enable>>
      // Track the actual native operation (and fail terminal errors), not only the UI poll interval.
      await complete(client, receipt, 120_000)
      await expect(toggle).toBeChecked({ checked: enabled, timeout: 60_000 })
      await expect
        .poll(
          async () =>
            (await client.packages.list({ profile: 'local-dev' })).packages.find(
              (entry) => entry.id === '@agnes/browser',
            )?.desired,
        )
        .toBe(enabled ? 'enabled' : 'installed-disabled')
    }
    await switchPlugin(false)
    expect((await openOldInteraction()).status).toBe(403)
    await page.locator(`.session[data-session="${session.id}"]`).click()
    await expect(page.getByTestId('workbench-tab-browser')).toHaveCount(0)
    const fallback = await client.session.new({
      sessionKey: randomUUID(),
      cwd: runtime.workspace,
      preset: 'standard',
      permission: 'full-access',
    })
    const tools = (await fallback.tools()).tools.map((tool) => tool.name)
    expect(tools).not.toContain('browser')
    const computerUse = (await fallback.capabilities())?.tools.find((tool) => tool.id === 'computer_use')
    expect(computerUse).toMatchObject({
      enabled: false,
      reasons: expect.arrayContaining([expect.objectContaining({ rule: 'model-input' })]),
    })
    await test.info().attach('fallback-capabilities.json', {
      body: JSON.stringify(computerUse),
      contentType: 'application/json',
    })
    await switchPlugin(true)
    row = (await client.clientModules.list('local-dev')).rows.find(
      (entry) => entry.packageId === '@agnes/browser',
    )
    expect(row?.phase).toBe('ready')
    await prompt(session, 'call browser ' + JSON.stringify({ action: 'inspect', pageId: opened.pageId }))
    const timeline = await session.projectUI(undefined, { surface: 'web' })
    const refused = timeline.nodes.findLast((node) => node.kind === 'tool' && node.name === 'browser')
    if (refused?.kind !== 'tool' || refused.resultSeq === undefined) throw new Error('Missing refusal')
    const detail = await session.readToolDetail(refused.seq, refused.resultSeq)
    expect(detail.result?.isError).toBe(true)
    const refusal = detail.result?.content?.find((item) => item.type === 'text')
    if (!refusal || refusal.type !== 'text') throw new Error('Missing refusal content')
    expect(JSON.parse(refusal.text)).toMatchObject({ code: 'PAGE_UNAVAILABLE' })
    await page.locator(`.session[data-session="${session.id}"]`).click()
    await workbenchTab(page, 'browser')
    await expect(page.locator('.agh-browser-panel')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('textbox', { name: 'Type into the web page', exact: true })).toHaveCount(0)
    const freshPage = await callBrowser({ action: 'open', url })
    expect(freshPage.pageId).not.toBe(opened.pageId)
    await expect(page.locator('.agh-browser-screen')).toContainText('Live')
    // HTTP admission issues a ticket before the plugin's channel handler runs.
    // Exercise the ticket and a real control request, not just its HTTP status.
    const stale = await page.evaluate(
      async ({ request, openPath, streamPath, target }) => {
        const response = await fetch(openPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-agnes-stream-open': '1' },
          body: JSON.stringify(request),
        })
        if (!response.ok) return { status: response.status }
        const grant = await response.json()
        const url = new URL(streamPath, location.href)
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
        return new Promise<{ code?: number; reply?: unknown }>((resolve, reject) => {
          const socket = new WebSocket(url)
          const timer = setTimeout(() => {
            socket.close()
            reject(new Error('Stale connection was not refused'))
          }, 5000)
          socket.onopen = () => socket.send(JSON.stringify({ ticket: grant.ticket }))
          socket.onmessage = (event) => {
            const frame = JSON.parse(event.data)
            if (frame.ready) {
              socket.send(
                JSON.stringify({
                  version: 1,
                  streamId: grant.streamId,
                  sequence: 0,
                  kind: 'json',
                  data: { id: 1, type: 'control', mode: 'human', ...target },
                }),
              )
            } else if (frame.data?.id === 1) {
              clearTimeout(timer)
              socket.close()
              resolve({ reply: frame.data })
            }
          }
          socket.onerror = () => {
            clearTimeout(timer)
            socket.close()
            reject(new Error('Stale-connection probe failed before refusal'))
          }
          socket.onclose = (event) => {
            clearTimeout(timer)
            resolve({ code: event.code })
          }
        })
      },
      {
        request: priorInteraction,
        openPath: PLUGIN_STREAM_OPEN_PATH,
        streamPath: PLUGIN_STREAM_PATH,
        target: { pageId: freshPage.pageId, pageEpoch: freshPage.pageEpoch },
      },
    )
    expect(stale).toEqual({ code: 1011 })
    await expect(page.locator('.agh-browser-screen')).toHaveAttribute('data-controlling', 'false')
    await page.locator('.agh-browser-screen canvas').click({ position: { x: 40, y: 40 } })
    await expect(page.locator('.agh-browser-screen')).toHaveAttribute('data-controlling', 'true')
    await test
      .info()
      .attach('single-plugin-switch.png', { body: await page.screenshot(), contentType: 'image/png' })
    await switchPlugin(false)
    await page.goto('about:blank')
    await runtime.restart()
    client = await runtime.connect()
    expect(
      (await client.packages.list({ profile: 'local-dev' })).packages.find(
        (entry) => entry.id === '@agnes/browser',
      )?.desired,
    ).toBe('installed-disabled')
    await page.goto(runtime.url + '/?page=plugins')
    await expect(page.locator('#settings')).toBeVisible({ timeout: 60_000 })
    await homePage(page, 'plugins')
    await expect(toggle).not.toBeChecked({ timeout: 60_000 })
    await test.info().attach('plugin-disabled-after-restart.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    })
  } finally {
    site.closeAllConnections()
    await new Promise<void>((resolve) => site.close(() => resolve()))
  }
})
