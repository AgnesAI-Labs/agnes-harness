import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, root as it, test } from './fixtures.js'
import { accessible, translated } from './quality.js'
import {
  chooseView,
  chooseWorkspace,
  closeSettings,
  expand,
  fresh,
  homePage,
  preferences,
  section,
  settings,
  sidebar,
  turn,
} from './ui.js'

test('permissions never flash a fallback selection when returning from application settings', async ({
  page,
  runtime,
}) => {
  const client = await runtime.connect()
  const saved = await client.sessionSelection.getDefaults()
  await client.sessionSelection.saveDefaults({
    ...saved,
    defaults: { ...saved.defaults, permission: 'full-access' },
  })
  await preferences(page)
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime)
  await settings(page)
  await section(page, 'application')
  for (let visit = 0; visit < 2; visit++) {
    const requested = page.waitForRequest('**/admin/api/defaults')
    let release: () => void = () => undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/admin/api/defaults', async (route) => {
      await pending
      await route.continue()
    })
    try {
      await section(page, 'security')
      await requested
      const cards = page.getByTestId('security-default-permissions')
      await expect(cards.locator('p.agnes-settings-note')).toHaveCSS('margin-block-end', '12px')
      await expect(cards.locator('input[type="radio"]')).toHaveCount(3)
      await expect(cards.locator('input[type="radio"]:checked')).toHaveCount(0)
      await expect(cards.locator('input[type="radio"]:enabled')).toHaveCount(0)
      release()
      await expect(page.getByTestId('security-full-access').getByRole('radio')).toBeChecked()
    } finally {
      release()
      await page.unroute('**/admin/api/defaults')
    }
    await section(page, 'application')
  }
})

it('v3 home entries, deep links and browser back/forward retain the selected page', async ({
  page,
  runtime,
}) => {
  test.setTimeout(180_000)
  await preferences(page)
  const client = await runtime.connect()
  const session = await client.session.new({
    sessionKey: randomUUID(),
    cwd: runtime.workspace,
    preset: 'standard',
    permission: 'full-access',
  })
  const local = page
  const localTab = local.getByRole('tab', { name: 'Local', exact: true })
  const query = (name: string) => new URL(page.url()).searchParams.get(name)
  const automation = local.getByTestId('schedules-new')
  const rsi = local.getByTestId('refinement-saved-skills')
  const model = local.locator('#model-settings-pane')
  for (const [name, value, surface] of [
    ['page', 'rsi', rsi],
    ['page', 'automation', automation],
    ['settings', 'model', model],
  ] as const) {
    const selected = name === 'settings' ? `&session=${encodeURIComponent(session.id)}` : ''
    await page.goto(`${runtime.url}/?${name}=${value}${selected}`)
    await expect(surface).toBeVisible()
    // Let the frame publish its sidebar snapshot before checking that it kept the deep link.
    await expect(localTab).toBeVisible()
    expect(query(name)).toBe(value)
    await page.reload()
    await expect(surface).toBeVisible()
    await expect(localTab).toBeVisible()
    expect(query(name)).toBe(value)
  }

  await local.locator('#config-close').click()
  await expect.poll(() => query('settings')).toBeNull()
  expect(query('session')).toBe(session.id)
  await page.reload()
  await expect(localTab).toBeVisible()
  await expect(model).toBeHidden()
  for (const id of ['agents', 'plugins', 'automation', 'rsi']) {
    await local.getByTestId(`home-entry-${id}`).click()
    await expect(local.getByTestId(`home-page-${id}`)).toBeVisible()
    await expect.poll(() => query('page')).toBe(id)
    if (id === 'rsi' || id === 'automation') {
      await page.reload()
      await expect(local.getByTestId(`home-page-${id}`)).toBeVisible()
    }
  }
  await page.goBack()
  await expect(automation).toBeVisible()
  expect(query('page')).toBe('automation')
  await page.goBack()
  await expect(local.getByTestId('home-page-plugins')).toBeVisible()
  await page.goForward()
  await expect(automation).toBeVisible()
  await local.locator('#settings').click()
  await expect(model).toBeVisible()
  await expect.poll(() => query('settings')).toBe('model')
  expect(query('page')).toBe('automation')
  await page.reload()
  await expect(model).toBeVisible()
  await local.locator('#config-close').click()
  await expect.poll(() => query('settings')).toBeNull()
  await expect(automation).toBeVisible()

  await page.goto(`${runtime.url}/?page=automation&tab=triggers`)
  // The automation page intentionally exposes schedules only, including legacy trigger links.
  await expect(automation).toBeVisible()
  await expect(local.getByRole('tab', { name: 'Triggers', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(automation).toBeVisible()
  await expect(local.getByRole('tab', { name: 'Triggers', exact: true })).toHaveCount(0)

  await local.getByTestId('home-entry-rsi').click()
  await expect(local.getByRole('heading', { name: 'RSI', exact: true })).toBeVisible()
  for (const note of ['allows-install', 'allows-undo', 'approvals', 'cost']) {
    await expect(local.getByTestId(`refinement-${note}`)).toHaveCSS('margin-block-end', '0px')
  }
  await expect(rsi).toBeVisible()
  await page.goto(`${runtime.url}/?settings=refinement`)
  await expect.poll(() => query('page'), { timeout: 30_000 }).toBe('rsi')
  expect(query('settings')).toBeNull()
  await expect(rsi).toBeVisible()

  await local.locator('#settings').click()
  await local.getByTestId('settings-nav-general').click()
  await expect(local.locator('#settings-section-tabs').getByRole('tab')).toHaveText(['General', 'Voice'])
  await expect(local.getByTestId('settings-nav-refinement-tab')).toHaveCount(0)
})

it('v3 home entries preserve local routes across cloud and session switches', async ({ page, runtime }) => {
  test.setTimeout(180_000)
  await preferences(page)
  const client = await runtime.connect()
  const alternateWorkspace = join(dirname(runtime.workspace), 'alternate-workspace')
  await mkdir(alternateWorkspace)
  const { workspace: alternate } = await client.workspace.add(alternateWorkspace)
  const newSession = () =>
    client.session.new({
      sessionKey: randomUUID(),
      cwd: runtime.workspace,
      preset: 'standard',
      permission: 'full-access',
    })
  const older = await newSession()
  const newer = await newSession()
  const link = (session: string) => `${runtime.url}/?session=${encodeURIComponent(session)}`
  const query = (name: string) => new URL(page.url()).searchParams.get(name)
  const local = page
  const cloudFrame = page.getByTestId('backend-frame-cloud')
  const cloud = cloudFrame.contentFrame()
  const tabs = local.locator('.backend-session-tabs')
  const cloudTab = tabs.getByRole('tab', { name: /^Cloud\b/ })
  const localTab = tabs.getByRole('tab', { name: 'Local', exact: true })
  let holdSettings = false
  let releaseSettings: (() => void) | undefined
  await page.routeWebSocket('**', (socket) => {
    const server = socket.connectToServer()
    const held = new Set()
    socket.onMessage((raw) => {
      const message = JSON.parse(raw.toString())
      if (holdSettings && message.method === '_agnes/v1/config.providers') held.add(message.id)
      server.send(raw)
    })
    server.onMessage((raw) => {
      const message = JSON.parse(raw.toString())
      if (held.delete(message.id)) releaseSettings = () => socket.send(raw)
      else socket.send(raw)
    })
  })
  await page.goto(`${link(older.id)}&page=rsi`)
  await expect(local.getByTestId('home-page-rsi')).toBeVisible()
  await expect(localTab).toBeVisible({ timeout: 30_000 })
  const cloudOrigin = await page.locator('#agnes-config').getAttribute('data-cloud-origin')
  const remote = 'http://127.0.0.1:1'
  let cloudLoads = 0
  let holdCloudStartup = false
  // Use the real isolated cloud origin with a synthetic session projection. This exercises
  // Window/origin checks in Chromium without a cloud credential or a deployed backend.
  await page.route(
    (url) => url.origin === cloudOrigin && url.searchParams.has('remote'),
    async (route) => {
      cloudLoads++
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><button id="report">Report local route</button>
        <button id="disconnect">Disconnect on next selection</button>
        <button id="resume">Complete cloud startup</button><output></output><script>
        const origin = ${JSON.stringify(runtime.url)}
        const post = (message) => parent.postMessage({ type: 'agh.backend.frame/v1', ...message }, origin)
        const rows = [
          { sessionId: 'cloud-a', title: 'Cloud conversation A' },
          { sessionId: 'cloud-b', title: 'Cloud conversation B' }
        ]
        const boot = new URL(location.href).searchParams
        let selected = boot.get('new') === '1' ? undefined : boot.get('session') ?? 'cloud-a'
        let connected = ${!holdCloudStartup}
        let advertised = connected ? selected : undefined
        let disconnectOnSelection = false
        const snapshot = () => {
          document.querySelector('output').textContent = selected ?? 'New conversation'
          post({ kind: 'state', snapshot: {
            ready: true, connected, selected: advertised, page: 'agents', rows, activity: [], more: false
          } })
        }
        const completed = new Set()
        window.addEventListener('message', ({ origin: sender, source, data }) => {
          if (sender !== origin || source !== parent || data?.type !== 'agh.backend.command/v1') return
          if (data.kind !== 'session' && data.kind !== 'new') return
          if (!completed.has(data.commandId)) {
            // An old selection may be projected while the cloud is still processing the command.
            snapshot()
            selected = data.kind === 'session' ? data.sessionId : undefined
            const url = new URL(location.href)
            if (selected) {
              url.searchParams.set('session', selected)
              url.searchParams.delete('new')
            } else {
              url.searchParams.delete('session')
              url.searchParams.set('new', '1')
            }
            history.replaceState({}, '', url)
            completed.add(data.commandId)
            if (disconnectOnSelection) connected = false
            if (connected) advertised = selected
          }
          post({ kind: 'ack', commandId: data.commandId })
          snapshot()
        })
        document.querySelector('#resume').onclick = () => {
          connected = true
          advertised = selected
          snapshot()
        }
        document.querySelector('#disconnect').onclick = () => { disconnectOnSelection = true }
        document.querySelector('#report').onclick = () => {
          history.replaceState({}, '', '/?page=agents')
          post({ kind: 'local-route', operation: 'push', route: '/?page=agents&settings=model' })
          snapshot()
        }
        snapshot()
      </script>`,
      })
    },
  )
  await page.evaluate((origin) => localStorage.setItem('agnes.cloud.origin.v1', origin), remote)
  holdCloudStartup = true
  await page.reload()
  await expect(cloudTab).toBeVisible({ timeout: 30_000 })
  await page.evaluate((origin) => {
    window.addEventListener('message', (event) => {
      if (event.origin === origin && event.data?.kind === 'local-route')
        document.body.dataset.cloudRouteAttempt = 'received'
    })
  }, cloudOrigin)
  await cloudTab.click()
  await expect(tabs.getByTestId('cloud-connection-status')).toHaveAttribute('data-state', 'disconnected')
  expect(query('remote')).toBe(remote)
  expect(query('session')).toBeNull()
  expect(query('new')).toBeNull()
  await localTab.click()
  await expect(cloudFrame).toBeHidden()
  await page.goBack()
  await expect(cloudFrame).toBeVisible()
  expect(query('session')).toBeNull()
  expect(query('new')).toBeNull()
  await page.goForward()
  await expect(cloudFrame).toBeHidden()
  holdCloudStartup = false
  await cloud.locator('#resume').evaluate((button: HTMLButtonElement) => button.click())
  await expect(tabs.getByTestId('cloud-connection-status')).toHaveAttribute('data-state', 'ready')
  await page.goBack()
  await expect(cloud.locator('output')).toHaveText('cloud-a')
  await expect.poll(() => query('session')).toBe('cloud-a')
  expect(query('new')).toBeNull()
  await page.goForward()
  await expect(local.getByTestId('home-page-rsi')).toBeVisible()
  await expect(cloudFrame).toBeHidden()
  await page.goBack()

  await expect(cloud.getByRole('button', { name: 'Report local route' })).toBeVisible()
  await expect.poll(() => query('session')).toBe('cloud-a')
  await cloud.getByRole('button', { name: 'Report local route' }).click()
  await expect(page.locator('body')).toHaveAttribute('data-cloud-route-attempt', 'received')
  expect(query('remote')).toBe(remote)
  expect(query('page')).toBeNull()
  expect(query('settings')).toBeNull()
  // One click from Cloud to local Settings adds exactly one browser-history entry.
  holdSettings = true
  try {
    await local.locator('#settings').click()
    await expect.poll(() => typeof releaseSettings).toBe('function')
    await expect(cloudFrame).toBeHidden()
    await expect(local.locator('#model-settings-pane')).toBeVisible()
    await expect.poll(() => query('settings')).toBe('model')
    await page.goBack()
    await expect(cloudFrame).toBeVisible()
    await expect(cloud.locator('output')).toHaveText('cloud-a')
  } finally {
    holdSettings = false
    releaseSettings?.()
  }
  expect(query('session')).toBe('cloud-a')
  await page.goBack()
  await expect(cloudFrame).toBeHidden()
  await expect(local.getByTestId('home-page-rsi')).toBeVisible()
  await expect(local.locator('#config[open]')).toHaveCount(0)
  expect(query('session')).toBe(older.id)
  await page.goForward()
  await expect(cloudFrame).toBeVisible()
  expect(query('remote')).toBe(remote)
  await localTab.click()
  await expect(cloudFrame).toBeHidden()
  await expect(local.getByTestId('home-page-rsi')).toBeVisible()
  expect(query('page')).toBe('rsi')
  expect(query('remote')).toBeNull()

  await cloudTab.click()
  await expect(cloudFrame).toBeVisible()
  await local.getByTestId('backend-session-cloud').filter({ hasText: 'Cloud conversation B' }).click()
  await expect(cloud.locator('output')).toHaveText('cloud-b')
  holdCloudStartup = true
  await page.reload()
  await expect(cloudTab.getByTestId('cloud-connection-status')).toHaveAttribute(
    'data-state',
    'disconnected',
    {
      timeout: 30_000,
    },
  )
  expect(query('session')).toBe('cloud-b')
  holdCloudStartup = false
  await cloud.getByRole('button', { name: 'Complete cloud startup' }).click()
  await expect(cloud.locator('output')).toHaveText('cloud-b')
  // Reloading Cloud must also retain the local destination, without relying on its history URL.
  await localTab.click()
  await expect(local.getByTestId('home-page-rsi')).toBeVisible()
  await expect.poll(() => query('page')).toBe('rsi')
  await page.goBack()
  await expect(cloud.locator('output')).toHaveText('cloud-b')
  await page.goBack()
  await expect(cloud.locator('output')).toHaveText('cloud-a')
  expect(query('session')).toBe('cloud-a')
  await page.goForward()
  await expect(cloud.locator('output')).toHaveText('cloud-b')
  expect(query('session')).toBe('cloud-b')
  await page.goBack()
  await expect(cloud.locator('output')).toHaveText('cloud-a')
  await page.goBack()
  await expect(cloudFrame).toBeHidden()
  await expect(local.getByTestId('home-page-rsi')).toBeVisible()

  await page.reload()
  await expect(local.getByTestId('home-page-rsi')).toBeVisible()
  await cloudTab.click()
  await expect(cloud.locator('output')).toHaveText('cloud-a')
  await cloud.getByRole('button', { name: 'Disconnect on next selection' }).click()
  await local.getByTestId('backend-session-cloud').filter({ hasText: 'Cloud conversation B' }).click()
  await expect(cloud.locator('output')).toHaveText('cloud-b')
  await expect.poll(() => query('session')).toBe('cloud-b')
  await local.locator('#settings').click()
  await expect(local.locator('#model-settings-pane')).toBeVisible()
  await local.getByTestId('settings-nav-cloud-connection').click()
  const previousCloudLoads = cloudLoads
  await local.getByRole('button', { name: 'Reconnect', exact: true }).click()
  await expect.poll(() => cloudLoads).toBeGreaterThan(previousCloudLoads)
  await local.locator('#config-close').click()
  await cloudTab.click()
  await expect(cloud.locator('output')).toHaveText('cloud-b')
  expect(query('session')).toBe('cloud-b')
  await localTab.click()
  await expect(local.getByTestId('home-page-rsi')).toBeVisible()

  await local.locator(`.session[data-session="${newer.id}"]`).click()
  await expect.poll(() => query('session')).toBe(newer.id)
  await expect(local.getByTestId('home-page-rsi')).toBeHidden()
  expect(query('page')).toBeNull()
  await local.locator(`.session[data-session="${older.id}"]`).click()
  await expect.poll(() => query('session')).toBe(older.id)
  await local.locator('#new').click()
  await expect.poll(() => query('new')).toBe('1')
  expect(query('session')).toBeNull()
  await page.goto(`${runtime.url}/?new=1&workspaceId=${alternate.workspaceId}`)
  const workspaceChip = local.locator('#composer-workspace')
  const alternatePath = await realpath(alternateWorkspace)
  await expect(workspaceChip).toHaveAttribute('title', alternatePath)
  await local.getByTestId('home-entry-rsi').click()
  await expect.poll(() => query('page')).toBe('rsi')
  await page.reload()
  await expect(local.getByTestId('home-page-rsi')).toBeVisible()
  await expect(localTab).toBeVisible({ timeout: 30_000 })
  await expect(workspaceChip).toHaveAttribute('title', alternatePath)
  expect(query('new')).toBe('1')
  expect(query('workspaceId')).toBe(alternate.workspaceId)
  expect(query('session')).toBeNull()

  await cloudTab.click()
  await expect(cloud.locator('output')).toHaveText('cloud-a')
  await expect.poll(() => query('session')).toBe('cloud-a')
  await local.getByRole('button', { name: 'New cloud conversation', exact: true }).click()
  await expect(cloud.locator('output')).toHaveText('New conversation')
  await expect.poll(() => query('new')).toBe('1')
  expect(query('session')).toBeNull()
  expect(query('workspaceId')).toBeNull()
  await page.reload()
  await expect(cloud.locator('output')).toHaveText('New conversation')
  await page.goBack()
  await expect(cloud.locator('output')).toHaveText('cloud-a')
  expect(query('new')).toBeNull()
  await page.goForward()
  await expect(cloud.locator('output')).toHaveText('New conversation')
  expect(query('new')).toBe('1')

  await localTab.click()
  await expect(local.getByTestId('home-page-rsi')).toBeVisible()
  await expect.poll(() => query('page')).toBe('rsi')
  expect(query('workspaceId')).toBe(alternate.workspaceId)
})

it('v3 home entries restore the draft when Back interrupts a pending session load', async ({
  page,
  runtime,
}) => {
  test.setTimeout(180_000)
  await preferences(page)
  const client = await runtime.connect()
  const session = await client.session.new({
    sessionKey: randomUUID(),
    cwd: runtime.workspace,
    preset: 'standard',
    permission: 'full-access',
  })
  const local = page
  const query = (key: string) => new URL(page.url()).searchParams.get(key)
  let release: (() => void) | undefined
  let cancelled = false
  await page.routeWebSocket('**', (socket) => {
    const server = socket.connectToServer()
    const pending = new Set()
    socket.onMessage((raw) => {
      const message = JSON.parse(raw.toString())
      if (message.params?.sessionId === session.id) {
        if (message.method === '_agnes/v1/session.open') pending.add(message.id)
        if (message.method === '_agnes/v1/session.loadingCancel') cancelled = true
      }
      server.send(raw)
    })
    server.onMessage((raw) => {
      const message = JSON.parse(raw.toString())
      if (pending.delete(message.id)) release = () => socket.send(raw)
      else socket.send(raw)
    })
  })
  await page.goto(`${runtime.url}/?new=1`)
  await expect(local.getByRole('tab', { name: 'Local', exact: true })).toBeVisible({ timeout: 30_000 })
  await local.getByTestId('home-entry-rsi').click()
  await expect.poll(() => query('page')).toBe('rsi')
  await local.locator(`.session[data-session="${session.id}"]`).click()
  await expect.poll(() => typeof release).toBe('function')
  await expect.poll(() => query('page')).toBeNull()
  await page.goBack()
  await expect(local.getByTestId('home-page-rsi')).toBeVisible()
  await expect.poll(() => cancelled).toBe(true)
  release?.()
  await expect(local.locator('#new')).toBeEnabled()
  expect(query('new')).toBe('1')
  expect(query('session')).toBeNull()
  expect(query('page')).toBe('rsi')
})

test('v3 command-K searches durable session text and opens the matching session', async ({
  page,
  runtime,
}) => {
  await preferences(page)
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime)
  await fresh(page)
  await turn(page, 'REG5_SEARCH_NEEDLE')
  const id = new URL(page.url()).searchParams.get('session')!
  await fresh(page)
  await page.keyboard.press('Meta+k')
  const search = page.getByTestId('session-search')
  await expect(search).toBeVisible()
  await search.getByTestId('session-search-input').fill('REG5_SEARCH_NEEDLE')
  const hit = search.getByTestId('session-search-option').filter({ hasText: 'REG5_SEARCH_NEEDLE' })
  await expect(hit).toHaveCount(1)
  await search.getByTestId('session-search-filters').click()
  const workspace = search.getByTestId('session-search-workspace')
  await workspace.fill(runtime.workspace.split('/').at(-2)!.toUpperCase())
  await expect(hit).toHaveCount(1)
  await workspace.fill('%missing_')
  await expect(search.getByTestId('session-search-option')).toHaveCount(0)
  await expect(search.getByText('Search is temporarily unavailable', { exact: false })).toHaveCount(0)
  await workspace.fill(runtime.workspace)
  await expect(hit).toHaveCount(1)
  await hit.click()
  await expect(search).toBeHidden()
  await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(id)
  await expect(page.getByTestId('conversation-turn')).toContainText('REG5_SEARCH_NEEDLE')
})

test('v3 archive filter restores the same session and its conversation', async ({ page, runtime }) => {
  await preferences(page, 'zh-CN')
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime, 'zh-CN')
  await fresh(page, 'zh-CN')
  const input = page.getByRole('textbox', { name: '任务内容', exact: true })
  await input.fill('REG5_ARCHIVE_CONTENT')
  await input.press('Enter')
  await expect(page.getByTestId('conversation-turn')).toHaveAttribute('data-status', 'completed')
  const id = new URL(page.url()).searchParams.get('session')!
  await page.locator(`.session[data-session="${id}"]`).hover()
  await page.locator(`[data-session-action-id="${id}"]`).click()
  await page.getByRole('menuitem', { name: '归档会话', exact: true }).click()
  const client = await runtime.connect()
  await expect
    .poll(async () => (await client.session.list()).items.find((row) => row.sessionId === id)?.archived)
    .toBe(true)
  await chooseView(page, 'archived')
  // The row's open button carries the session id; the restore action sits beside it in the same row.
  const row = page
    .getByTestId('session-inventory')
    .locator('.session-row')
    .filter({ has: page.locator(`[data-session="${id}"]`) })
  await expect(row).toBeVisible()
  // The restore action appears when the row is pointed at.
  await row.hover()
  await row.getByTestId('archived-restore').click()
  await expect
    .poll(async () => (await client.session.list()).items.find((row) => row.sessionId === id)?.archived)
    .toBe(false)
  await chooseView(page, 'active')
  await page.locator(`.session[data-session="${id}"]`).click()
  await expect(page.getByTestId('conversation-turn')).toContainText('REG5_ARCHIVE_CONTENT')
})

it('v3 settings exposes four everyday pages, persistent advanced settings and legacy plugin redirects', async ({
  page,
  runtime,
}) => {
  test.setTimeout(180_000)
  await preferences(page, 'zh-CN')
  const client = await runtime.connect()
  const session = await client.session.new({
    sessionKey: randomUUID(),
    cwd: runtime.workspace,
    preset: 'standard',
    permission: 'full-access',
  })
  const local = page
  const setSection = (id: string) => local.getByTestId(`settings-nav-${id}`).click()
  const route = () => new URL(page.url()).searchParams.get('settings')
  const advancedGroup = local.getByTestId('settings-advanced')
  const advancedSwitch = local.getByTestId('settings-advanced-switch')
  await page.goto(`${runtime.url}/?session=${session.id}&settings=model`)
  // A browser that never chose shows the advanced group; turning it off is remembered.
  expect(await page.evaluate(() => localStorage.getItem('agnes.settings.advanced'))).toBeNull()
  await expect(advancedGroup).toBeVisible()
  await setSection('general')
  await advancedSwitch.click()
  await expect(advancedSwitch).toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate(() => localStorage.getItem('agnes.settings.advanced'))).toBe('0')
  await page.reload()
  // A persisted settings URL restores its dialog after the session binding finishes.
  await expect(local.locator('#config[open]')).toBeVisible()
  await expect(local.getByTestId('settings-navigation').locator('[data-settings-section]')).toHaveCount(4)
  await expect(advancedGroup).toHaveCount(0)
  for (const id of ['general', 'model', 'security', 'application']) {
    await setSection(id)
    await expect.poll(route).toBe(id)
  }
  await expect(local.getByTestId('auto-review-customize')).toHaveCount(0)
  await setSection('general')
  await advancedSwitch.click()
  await expect(advancedGroup).toBeVisible()
  await setSection('security')
  await expand(local.getByTestId('auto-review-customize'))
  const reviewTools = local.getByTestId('auto-review-tools')
  await expect(reviewTools).toBeVisible()
  await expect.poll(route).toBe('security/auto-review')
  expect(await page.evaluate(() => localStorage.getItem('agnes.settings.advanced'))).toBe('1')
  const subpage = page.url()
  await page.goBack()
  await expect(reviewTools).toBeHidden()
  expect(route()).toBe('security')
  await page.goForward()
  await expect(reviewTools).toBeVisible()
  await page.reload()
  await expect(reviewTools).toBeVisible()
  expect(page.url()).toBe(subpage)
  await page.goto(subpage)
  await expect(reviewTools).toBeVisible()
  await page.reload()
  await expect(reviewTools).toBeVisible()
  await local.getByTestId('settings-subpage-header').getByRole('button').first().click()
  await expect(advancedGroup).toBeVisible()
  await local.locator('#config-close').click()
  await expect.poll(route).toBeNull()
  await page.goto(`${runtime.url}/?settings=plugins`)
  await expect(local.getByTestId('home-page-plugins')).toBeVisible()
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('plugins')
  expect(route()).toBeNull()
  await page.goto(`${runtime.url}/?settings=model/add-account`)
  const addAccount = local.getByTestId('account-page-add')
  await expect(addAccount).toBeVisible()
  await local.locator('#config-account-cancel').click()
  await expect(local.locator('#config-account-discard')).toBeVisible()
  await local.locator('#config-account-discard-confirm').click()
  await expect.poll(route).toBe('model')
  await expect(addAccount).toHaveCount(0)
  await page.reload()
  await expect(local.locator('#model-settings-pane')).toBeVisible()
  await expect(addAccount).toHaveCount(0)
  await local.locator('.config-accounts-welcome [data-provider="deepseek"]').click()
  await expect(addAccount).toBeVisible()
  await page.goBack()
  await expect.poll(route).toBe('model')
  await expect(addAccount).toHaveCount(0)
})

for (const locale of ['en', 'zh-CN'])
  for (const theme of ['light', 'dark']) {
    test(`v3 every home page and capability locale/theme and 390px smoke ${locale}/${theme}`, async ({
      page,
      runtime,
    }, info) => {
      test.setTimeout(150_000)
      await preferences(page, locale, theme)
      await page.goto(runtime.url)
      await chooseWorkspace(page, runtime, locale)
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 })
        for (const id of ['agents', 'plugins', 'automation']) {
          await homePage(page, id)
          await translated(page)
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            `${id}/${width}`,
          ).toBe(true)
          await accessible(page, info, `${id}-${width}`)
        }
        for (const tab of ['skills', 'mcp', 'review', 'market']) {
          await homePage(page, 'plugins', tab)
          await translated(page)
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            `${tab}/${width}`,
          ).toBe(true)
          await accessible(page, info, `${tab}-${width}`)
        }
        for (const capability of ['search', 'computer-use', 'subagents']) {
          await homePage(page, 'plugins')
          const label = {
            search: /^(Web search|网页搜索)/,
            'computer-use': /^(Computer use|电脑操作)/,
            subagents: /^(Subagents|子代理)/,
          }[capability]!
          await page.getByTestId('plugin-capability-settings').getByRole('button', { name: label }).click()
          await expect(page.getByTestId(`home-page-plugins-${capability}`)).toBeVisible()
          await translated(page)
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            `${capability}/${width}`,
          ).toBe(true)
          await accessible(page, info, `${capability}-${width}`)
        }
        await sidebar(page)
        await settings(page, locale)
        for (const id of ['general', 'model', 'security', 'application']) {
          await section(page, id)
          await translated(page)
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            `${id}/${width}`,
          ).toBe(true)
          await accessible(page, info, `${id}-${width}`)
        }
        await closeSettings(page, locale)
      }
    })
  }

test('browser locale initializes the shell and a saved choice wins after reload', async ({
  browser,
  runtime,
}, info) => {
  for (const locale of ['zh-CN', 'fr-FR']) {
    const context = await browser.newContext({ locale })
    const page = await context.newPage()
    try {
      await page.goto(runtime.url)
      await expect(page.locator('html')).toHaveAttribute('lang', locale === 'zh-CN' ? 'zh-CN' : 'en')
      expect(await page.evaluate(() => navigator.language)).toBe(locale)
      expect(await page.evaluate(() => localStorage.getItem('agnes-locale'))).toBeNull()
      if (locale === 'zh-CN') {
        const local = page
        await expect(local.locator('#new')).toContainText('新对话')
        await info.attach('browser-zh-CN.png', { body: await page.screenshot(), contentType: 'image/png' })
        await info.attach('browser-locale.json', {
          body: JSON.stringify(
            await page.evaluate(() => ({
              browser: navigator.language,
              document: document.documentElement.lang,
              saved: localStorage.getItem('agnes-locale'),
            })),
          ),
          contentType: 'application/json',
        })
        await page.evaluate(() => localStorage.setItem('agnes-locale', 'en'))
        await page.reload()
        await expect(page.locator('html')).toHaveAttribute('lang', 'en')
        await expect(local.locator('html')).toHaveAttribute('lang', 'en')
      }
    } finally {
      await context.close()
    }
  }
})
