import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import type { PackageCatalogPage, PackageOperation, PackagePreview, PackageSource } from '@agnes/protocol'
import type { Locator, Page, Request, TestInfo } from '@playwright/test'
import { test as base, expect } from './fixtures.js'
import { settled } from './quality.js'
import type { Runtime } from './runtime.js'
import { homePage } from './ui.js'

const profile = 'local-dev'
const timeZone = 'America/Los_Angeles'
const indexUrl = 'https://agnesai-labs.github.io/agh-plugin-market/index.json'
const apiRoot = '/admin/plugins/api/'
const effects = /^(install|update|enable|disable|trust|untrust|remove|rollback|consent|skills\/import)(\/|$)/
const forbiddenMethods = ['session/prompt', '_agnes/v1/submit', '_agnes/v1/config.test']
const observed = 'market-e2e/aurora-observer'
const missing = 'market-e2e/aurora-archive'
const undeclared = 'market-e2e/station-data'
const longSummary = 'Weather forecasts and measurements archived for offline station operators. '.repeat(12)
const source = (repository: string, sha: string): PackageSource => ({
  type: 'git',
  ref: `git:https://github.com/${repository}.git#${sha}`,
})
const defaultSha = '12'.repeat(20)
const selectedSha = '34'.repeat(20)
const missingSha = '56'.repeat(20)
const defaultVersion = { version: '2.1.0', source: source(observed, defaultSha) }
const selectedVersion = { version: '1.4.0', source: source(observed, selectedSha) }
const missingVersion = { version: '1.0.0', source: source(missing, missingSha) }
const defaultTime = 1_767_268_800
const selectedTime = 1_735_819_200
const excludedRange = '>=999.0.0'

type Snapshot = NonNullable<PackageCatalogPage['communityIndex']>
type CatalogItem = Snapshot['items'][number]
type CachedVersion = Pick<NonNullable<CatalogItem['versions']>[number], 'version' | 'source'> & {
  provides?: NonNullable<PackagePreview['provides']>
  publishTimestamp?: number
  aghEngine?: { kind: 'undeclared' | 'invalid' } | { kind: 'range'; range: string }
}

function item(fullName: string, title: { en: string; 'zh-CN': string }, versions: CachedVersion[]) {
  return { id: fullName, name: fullName, fullName, title, description: longSummary, versions }
}

const archiveTitle = { en: 'Aurora Archive', 'zh-CN': '极光档案' }
const stationTitle = { en: 'Station Data', 'zh-CN': '气象站数据' }
const observerTitle = { en: 'Aurora Observer', 'zh-CN': '极光观测' }
const cachedItems = {
  4: [item(missing, archiveTitle, [missingVersion])],
  5: [
    item(observed, observerTitle, [
      {
        ...defaultVersion,
        provides: ['tool', 'ui'],
        publishTimestamp: defaultTime,
        aghEngine: { kind: 'range', range: excludedRange },
      },
      {
        ...selectedVersion,
        provides: ['mcp'],
        publishTimestamp: selectedTime,
        aghEngine: { kind: 'range', range: '*' },
      },
    ]),
    item(missing, archiveTitle, [{ ...missingVersion, aghEngine: { kind: 'invalid' } }]),
    item(undeclared, stationTitle, [
      {
        version: '2.0.0',
        source: source(undeclared, '78'.repeat(20)),
        provides: ['tool'],
        aghEngine: { kind: 'undeclared' },
      },
    ]),
  ],
}
const cachePath = (home: string) => join(home, 'profiles', profile, 'community-discovery-cache.json')

type BrowserTraffic = {
  requests: string[]
  checks: { method: string; body: unknown }[]
  beginInteraction: () => Promise<number>
}

type DaemonProxy = {
  url: string
  beginMarketplace: () => void
}

const test = base.extend<{
  cacheVersion: 4 | 5
  daemonProxy: DaemonProxy
  browserTraffic: BrowserTraffic
}>({
  cacheVersion: [5, { option: true }],
  // biome-ignore lint/correctness/noEmptyPattern: Playwright inspects the fixture dependencies.
  daemonProxy: async ({}, use, info) => {
    const beforeMarketplace: string[] = []
    const duringMarketplace: string[] = []
    let attempts = beforeMarketplace
    const server = createServer((request, response) => {
      attempts.push(`${request.method} ${request.url}`)
      response.writeHead(403).end()
    })
    server.on('connect', (request, socket) => {
      attempts.push(`CONNECT ${request.url}`)
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    })
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const bound = server.address()
      if (!bound || typeof bound === 'string') throw new Error('Missing loopback proxy port')
      await use({
        url: `http://127.0.0.1:${bound.port}`,
        beginMarketplace: () => {
          attempts = duringMarketplace
        },
      })
    } finally {
      const closed = once(server, 'close')
      server.close()
      await closed
      // The bundled browser can attempt its startup download after the Marketplace opens.
      const marketplaceRelevant = [...beforeMarketplace, ...duringMarketplace].filter(
        (attempt) => attempt !== 'CONNECT cdn.playwright.dev:443',
      )
      await info.attach('daemon-outbound-requests.json', {
        body: JSON.stringify({ beforeMarketplace, duringMarketplace, marketplaceRelevant }, null, 2),
        contentType: 'application/json',
      })
      expect(marketplaceRelevant, 'No marketplace traffic reaches the daemon outbound proxy').toEqual([])
    }
  },
  runtimeSetup: async ({ cacheVersion, daemonProxy }, use) => {
    await use({
      localExamples: cacheVersion === 5,
      extraEnv: {
        HTTP_PROXY: daemonProxy.url,
        HTTPS_PROXY: daemonProxy.url,
        NO_PROXY: '127.0.0.1,localhost',
      },
      prepare: async (runtime) => {
        // The CLI initializes a fresh, private home without starting a daemon or worker.
        await runtime.cli(['profile', 'list'])
        const items = cachedItems[cacheVersion]
        const now = Date.now()
        await writeFile(
          cachePath(runtime.home),
          JSON.stringify({
            version: cacheVersion,
            fingerprint: `index-v${cacheVersion}|${indexUrl}`,
            snapshot: {
              state: 'ready',
              lastSuccessAt: new Date(now - 1000).toISOString(),
              nextAttemptAt: new Date(now + 6 * 60 * 60 * 1000).toISOString(),
              error: null,
              totalReported: items.length,
              items,
            },
          }),
          { mode: 0o600, flag: 'wx' },
        )
      },
    })
  },
  browserTraffic: async ({ page, runtime }, use, info) => {
    const requests: string[] = []
    const startupReads = new Set([
      `${apiRoot}catalog/list`,
      `${apiRoot}catalog/get`,
      `${apiRoot}overview`,
      `${apiRoot}candidates/list`,
      `${apiRoot}tree/list`,
      `${apiRoot}surfaces`,
      `${apiRoot}composition`,
      '/admin/api/runtime',
      '/admin/api/composition',
    ])
    const pendingReads = new Set<Request>()
    let catalogLoaded = false
    let lastRead = Date.now()
    const checks: BrowserTraffic['checks'] = []
    const external: string[] = []
    const writes: string[] = []
    const modelMethods: string[] = []
    const isPackageWrite = (url: URL) =>
      url.origin === runtime.url &&
      url.pathname.startsWith(apiRoot) &&
      effects.test(url.pathname.slice(apiRoot.length))
    page.on('request', (request) => {
      const url = new URL(request.url())
      const address = `${url.origin}${url.pathname}`
      requests.push(`${request.method()} ${address}`)
      if (url.origin !== runtime.url) external.push(address)
      else if (startupReads.has(url.pathname)) {
        pendingReads.add(request)
        lastRead = Date.now()
      }
      if (isPackageWrite(url)) writes.push(url.pathname)
    })
    const finishRead = (request: Request) => {
      if (pendingReads.delete(request)) lastRead = Date.now()
    }
    page.on('requestfinished', (request) => {
      if (request.url() === `${runtime.url}${apiRoot}catalog/list`) catalogLoaded = true
      finishRead(request)
    })
    page.on('requestfailed', finishRead)
    page.on('websocket', (socket) => {
      const { hostname, origin, pathname } = new URL(socket.url())
      // The real daemon may advertise a separate loopback port for its socket.
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) external.push(`${origin}${pathname}`)
      socket.on('framesent', ({ payload }) => {
        if (typeof payload !== 'string') return
        const message: unknown = JSON.parse(payload)
        if (
          message &&
          typeof message === 'object' &&
          'method' in message &&
          typeof message.method === 'string' &&
          forbiddenMethods.includes(message.method)
        )
          modelMethods.push(message.method)
      })
    })
    // A regression must fail without ever executing a package write on the daemon.
    await page.route(isPackageWrite, (route) => route.abort('blockedbyclient'))
    // Install the inspect boundary before navigation so even a premature check cannot download a plugin.
    const operationId = 'community-e2e-inspect'
    const integrity = `sha256-${'ab'.repeat(32)}`
    const now = new Date().toISOString()
    const operation = {
      operationId,
      profile,
      operation: 'inspect',
      state: 'completed',
      progress: 100,
      startedAt: now,
      updatedAt: now,
      preview: {
        id: observed,
        ...selectedVersion,
        integrity,
        license: 'MIT',
        provenance: { source: selectedVersion.source, integrity, signatureVerified: false },
        contributions: [],
        capabilityDiff: {
          added: [],
          removed: [],
          runtimeSupportRemoved: [],
          dependenciesAdded: [],
          serviceGrantsAdded: [],
        },
        dependencies: {},
        warnings: [],
        blockers: [],
      },
    } satisfies PackageOperation
    await page.route(`${runtime.url}${apiRoot}inspect`, async (route) => {
      const request = route.request()
      checks.push({ method: request.method(), body: request.postDataJSON() })
      await route.fulfill({ json: { operationId, profile } })
    })
    await page.route(`${runtime.url}${apiRoot}operation/get`, async (route) => {
      const body: unknown = route.request().postDataJSON()
      if (body && typeof body === 'object' && 'operationId' in body && body.operationId === operationId)
        await route.fulfill({ json: operation })
      else await route.fallback()
    })
    await use({
      requests,
      checks,
      beginInteraction: async () => {
        await settled(page)
        // Overview and runtime reads can schedule a second pass after the first cards render.
        lastRead = Date.now()
        await expect
          .poll(() => catalogLoaded && pendingReads.size === 0 && Date.now() - lastRead >= 500, {
            message: 'Initial Marketplace reads finish before measuring the interaction',
          })
          .toBe(true)
        return requests.length
      },
    })
    await info.attach('community-browser-requests.json', {
      body: JSON.stringify({ requests, checks, external, writes, modelMethods }, null, 2),
      contentType: 'application/json',
    })
    expect(external, 'Browsing and checking never contact an external origin').toEqual([])
    expect(writes, 'Checking never sends a package install, trust, consent or enable request').toEqual([])
    expect(modelMethods, 'No model test or conversation input was sent').toEqual([])
  },
})

const labels = {
  en: {
    source: 'Source',
    community: 'Community',
    capability: 'Capability',
    search: 'Search plugins',
    all: 'All capabilities',
    tool: 'Tool',
    ui: 'UI',
    mcp: 'MCP',
    unknownType: 'Unknown type',
    unknown: 'Unable to determine',
    compatible: 'Declared compatible',
    incompatible: 'Incompatible',
    undeclared: 'Not declared',
    time: 'Version commit time',
    notRecorded: 'Not recorded',
    close: 'Close details',
    view: 'View',
    check: 'Check installation',
  },
  'zh-CN': {
    source: '来源',
    community: '社区',
    capability: '能力',
    search: '搜索插件',
    all: '全部能力',
    tool: '工具',
    ui: '界面',
    mcp: 'MCP',
    unknownType: '类型未知',
    unknown: '无法判断',
    compatible: '声明兼容',
    incompatible: '明确不兼容',
    undeclared: '未声明',
    time: '版本提交时间',
    notRecorded: '未记录',
    close: '关闭详情',
    view: '查看',
    check: '检查安装条件',
  },
}
type Locale = keyof typeof labels

async function openMarket(page: Page, runtime: Runtime, daemonProxy: DaemonProxy) {
  // Serving the page does not mean the boot Host has assembled its plugins yet.
  const client = await runtime.connect('local', false)
  try {
    await expect
      .poll(
        async () => {
          const diagnostics = await client.call<{ logs: { name: string; text: string }[] }>(
            '_agnes/v1/diagnostics.collect',
            {},
          )
          return diagnostics.logs.find((log) => log.name === 'host.jsonl')?.text ?? ''
        },
        { message: 'The isolated daemon finished booting before browsing', timeout: 30_000 },
      )
      .toMatch(/"kind":"host\.ready".*"reason":"boot"/)
  } finally {
    await client.close()
  }
  await page.goto(runtime.url)
  const guide = page.getByTestId('first-run-guide')
  await expect(guide).toBeVisible()
  await page.getByTestId('first-run-skip').click()
  await expect(guide).toBeHidden()
  await expect(page.locator('#composer-workspace')).toHaveAttribute('title', runtime.workspace)
  daemonProxy.beginMarketplace()
  await homePage(page, 'plugins', 'market')
}

function actionRequestsSince(requests: string[], start: number, origin: string) {
  return requests.slice(start).filter((request) => {
    const address = request.slice(request.indexOf(' ') + 1)
    const prefix = `${origin}${apiRoot}`
    if (!address.startsWith(prefix)) return false
    const operation = address.slice(prefix.length)
    return (
      operation === 'catalog/list' ||
      operation === 'catalog/get' ||
      operation === 'inspect' ||
      operation === 'operation/get' ||
      effects.test(operation)
    )
  })
}

async function filterKind(page: Page, locale: Locale, name: string) {
  const button = page.getByTestId('plugin-filter')
  await button.click()
  await page.getByRole('combobox', { name: labels[locale].capability, exact: true }).click()
  await page.getByRole('option', { name, exact: true }).click()
  await button.click()
}

async function commitFacts(drawer: Locator, repository: string, sha: string) {
  const url = `https://github.com/${repository}`
  for (const href of [url, `${url}/releases`, `${url}/commit/${sha}`]) {
    const link = drawer.getByRole('link').and(drawer.locator(`a[href="${href}"]`))
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /\bnoopener\b.*\bnoreferrer\b|\bnoreferrer\b.*\bnoopener\b/)
  }
  await expect(drawer.getByRole('link', { name: sha, exact: true })).toHaveAttribute(
    'href',
    `${url}/commit/${sha}`,
  )
  await expect(drawer.getByText(repository, { exact: true })).toBeVisible()
}

async function commitTime(drawer: Locator, locale: Locale, seconds: number) {
  const time = drawer.locator('time')
  const date = new Date(seconds * 1000)
  await expect(drawer.getByText(labels[locale].time, { exact: true })).toBeVisible()
  await expect(time).toHaveAttribute('datetime', date.toISOString())
  await expect(time).toHaveText(
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date),
  )
}

async function captureDrawer(page: Page, drawer: Locator, info: TestInfo, name: string) {
  await info.attach(`${name}.aria.txt`, { body: await drawer.ariaSnapshot(), contentType: 'text/plain' })
  await info.attach(`${name}.png`, {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
  expect(await drawer.evaluate((panel) => panel.scrollWidth - panel.clientWidth)).toBeLessThanOrEqual(1)
}

async function checkSelectedVersion(
  page: Page,
  runtime: Runtime,
  drawer: Locator,
  locale: Locale,
  checks: BrowserTraffic['checks'],
  info: TestInfo,
) {
  const client = await runtime.connect('local', false)
  const inventory = async () =>
    (await client.packages.list({ profile })).packages.map(
      ({ id, version, source, integrity, trusted, desired }) => ({
        id,
        version,
        source,
        integrity,
        trusted,
        desired,
      }),
    )
  const before = await inventory()
  try {
    expect(checks, 'Browsing did not start a check').toEqual([])
    await drawer.getByRole('button', { name: labels[locale].check, exact: true }).click()
    const review = page.getByTestId('install-review')
    await expect(review).toBeVisible()
    expect(checks).toEqual([
      { method: 'POST', body: expect.objectContaining({ source: selectedVersion.source }) },
    ])
    await expect(review.getByTestId('install-review-source')).toContainText(selectedVersion.source.ref)
    await expect(review.getByTestId('install-review-unverified')).toBeVisible()
    await expect(review.getByTestId('install-review-confirm')).toBeEnabled()
    await review.getByTestId('install-review-cancel').click()
    await expect(review).toBeHidden()
  } finally {
    const after = await inventory()
    await info.attach('community-inspect-and-inventory.json', {
      body: JSON.stringify({ before, after }, null, 2),
      contentType: 'application/json',
    })
    expect(after).toEqual(before)
    expect((await client.session.list()).items).toEqual([])
  }
}

for (const locale of ['en', 'zh-CN'] as const) {
  const text = labels[locale]
  test.describe(`community market ${locale}`, () => {
    test.use({ locale, timezoneId: timeZone })

    test('v5 filters card versions and reviews the selected pinned commit', async ({
      page,
      runtime,
      daemonProxy,
      browserTraffic,
    }, info) => {
      test.setTimeout(120_000)
      const { requests, checks, beginInteraction } = browserTraffic
      const cached = await readFile(cachePath(runtime.home), 'utf8')
      await openMarket(page, runtime, daemonProxy)
      const cards = page.getByTestId('community-card')
      const names = cards.getByRole('heading')
      const sourceFilter = page.getByRole('combobox', { name: text.source, exact: true })
      const official = page.getByTestId('market-card').and(page.locator('[data-plugin-id="@agnes/browser"]'))
      const local = page
        .getByTestId('market-card')
        .and(page.locator('[data-plugin-id="@agnes-examples/client-multi-panel"]'))
      await expect(official).toBeVisible()
      await sourceFilter.selectOption('local')
      await expect(local).toBeVisible()
      await expect(official).toHaveCount(0)
      await expect(cards).toHaveCount(0)
      await sourceFilter.selectOption('official')
      await expect(official).toBeVisible()
      await expect(local).toHaveCount(0)
      await expect(cards).toHaveCount(0)
      await sourceFilter.selectOption('community')
      await expect(names).toHaveText([observerTitle[locale], archiveTitle[locale], stationTitle[locale]])
      await expect(page.getByTestId('market-card')).toHaveCount(0)
      const browseStart = await beginInteraction()
      await filterKind(page, locale, text.tool)
      await expect(names).toHaveText([observerTitle[locale], stationTitle[locale]])
      await filterKind(page, locale, text.ui)
      await expect(names).toHaveText([observerTitle[locale]])
      await filterKind(page, locale, text.mcp)
      await expect(cards).toHaveCount(0)
      await filterKind(page, locale, text.unknownType)
      await expect(names).toHaveText([archiveTitle[locale]])
      expect(
        actionRequestsSince(requests, browseStart, runtime.url),
        'Capability filters read only the displayed cache',
      ).toEqual([])

      await filterKind(page, locale, text.tool)
      const search = page.getByRole('searchbox', { name: text.search, exact: true })
      await search.fill(locale === 'en' ? 'Aurora' : '极光')
      await expect(names).toHaveText([observerTitle[locale]])
      await sourceFilter.selectOption('official')
      await expect(cards).toHaveCount(0)
      await sourceFilter.selectOption('community')
      await expect(names).toHaveText([observerTitle[locale]])
      await search.fill('')
      await expect(names).toHaveText([observerTitle[locale], stationTitle[locale]])
      await filterKind(page, locale, text.all)
      await expect(names).toHaveText([observerTitle[locale], archiveTitle[locale], stationTitle[locale]])

      await page.setViewportSize({ width: 390, height: 844 })
      const detailStart = await beginInteraction()
      const card = (name: string) => cards.filter({ has: page.getByRole('heading', { name, exact: true }) })
      const trigger = card(observerTitle[locale]).getByRole('button', { name: text.view, exact: true })
      const drawer = page.getByRole('dialog', { name: observerTitle[locale], exact: true })
      await trigger.click()
      await expect(drawer.getByText(text.community, { exact: true })).toBeVisible()
      await expect(drawer.getByText(`${text.tool} · ${text.ui}`, { exact: true })).toBeVisible()
      await expect(drawer.getByText(text.incompatible, { exact: true })).toBeVisible()
      await expect(drawer.getByText(excludedRange, { exact: true })).toBeVisible()
      await expect(drawer.getByRole('button', { name: text.check, exact: true })).toBeEnabled()
      await commitTime(drawer, locale, defaultTime)
      await commitFacts(drawer, observed, defaultSha)
      await captureDrawer(page, drawer, info, 'community-default-version')

      const picker = drawer.getByTestId('community-version-picker').getByRole('combobox')
      await picker.click()
      await expect(drawer.getByRole('option')).toHaveText([defaultVersion.version, selectedVersion.version])
      await drawer.getByRole('option', { name: selectedVersion.version, exact: true }).click()
      await expect(drawer.getByText(text.mcp, { exact: true })).toBeVisible()
      await expect(drawer.getByText(`${text.tool} · ${text.ui}`, { exact: true })).toHaveCount(0)
      await expect(drawer.getByText(text.incompatible, { exact: true })).toHaveCount(0)
      await expect(drawer.getByText(excludedRange, { exact: true })).toHaveCount(0)
      await expect(drawer.getByText(text.compatible, { exact: true })).toBeVisible()
      await commitTime(drawer, locale, selectedTime)
      await commitFacts(drawer, observed, selectedSha)
      await expect(drawer.getByRole('link', { name: defaultSha, exact: true })).toHaveCount(0)
      await captureDrawer(page, drawer, info, 'community-selected-version')

      await drawer.getByRole('button', { name: text.close, exact: true }).click()
      await expect(drawer).toBeHidden()
      await expect(trigger).toBeFocused()
      await expect(card(observerTitle[locale])).toContainText(defaultVersion.version)
      await filterKind(page, locale, text.mcp)
      await expect(cards).toHaveCount(0)
      await filterKind(page, locale, text.all)
      await expect(names).toHaveText([observerTitle[locale], archiveTitle[locale], stationTitle[locale]])
      for (const [title, compatibility] of [
        [archiveTitle, text.unknown],
        [stationTitle, text.undeclared],
      ] as const) {
        await card(title[locale]).getByRole('button', { name: text.view, exact: true }).click()
        const other = page.getByRole('dialog', { name: title[locale], exact: true })
        await expect(other.getByText(compatibility, { exact: true })).toBeVisible()
        await expect(other.locator('time')).toHaveCount(0)
        await expect(other.getByText(text.time, { exact: true })).toBeVisible()
        await expect(other.getByText(text.notRecorded, { exact: true })).toBeVisible()
        await expect(other.getByRole('link', { name: selectedSha, exact: true })).toHaveCount(0)
        await other.getByRole('button', { name: text.close, exact: true }).click()
        await expect(other).toBeHidden()
      }
      await trigger.click()
      await commitFacts(drawer, observed, selectedSha)
      expect(
        actionRequestsSince(requests, detailStart, runtime.url),
        'Opening and switching cached versions require no catalog requests or package actions',
      ).toEqual([])
      await checkSelectedVersion(page, runtime, drawer, locale, checks, info)

      await homePage(page, 'plugins', 'plugins')
      await page.getByTestId('plugin-filter').click()
      await page.getByRole('combobox', { name: text.capability, exact: true }).click()
      await expect(page.getByRole('option', { name: text.tool, exact: true })).toBeVisible()
      await expect(page.getByRole('option', { name: text.unknownType, exact: true })).toHaveCount(0)
      expect(await readFile(cachePath(runtime.home), 'utf8')).toBe(cached)
    })

    test.describe('legacy cache', () => {
      test.use({ cacheVersion: 4 })
      test('v4 restores an offline pinned version without inventing an engine declaration', async ({
        page,
        runtime,
        daemonProxy,
        browserTraffic,
      }, info) => {
        test.setTimeout(90_000)
        const { requests, checks, beginInteraction } = browserTraffic
        const cached = await readFile(cachePath(runtime.home), 'utf8')
        await openMarket(page, runtime, daemonProxy)
        await page.getByRole('combobox', { name: text.source, exact: true }).selectOption('community')
        const card = page.getByTestId('community-card')
        await expect(card.getByRole('heading')).toHaveText(archiveTitle[locale])
        await page.setViewportSize({ width: 390, height: 844 })
        const start = await beginInteraction()
        await filterKind(page, locale, text.unknownType)
        await card.getByRole('button', { name: text.view, exact: true }).click()
        const drawer = page.getByRole('dialog', { name: archiveTitle[locale], exact: true })
        await expect(drawer.getByText(text.unknown, { exact: true })).toBeVisible()
        await expect(drawer.getByText(text.undeclared, { exact: true })).toHaveCount(0)
        await expect(drawer.locator('time')).toHaveCount(0)
        await expect(drawer.getByText(text.time, { exact: true })).toBeVisible()
        await expect(drawer.getByText(text.notRecorded, { exact: true })).toBeVisible()
        await commitFacts(drawer, missing, missingSha)
        await captureDrawer(page, drawer, info, 'community-v4-unknown')
        expect(actionRequestsSince(requests, start, runtime.url)).toEqual([])
        expect(checks).toEqual([])
        expect(await readFile(cachePath(runtime.home), 'utf8')).toBe(cached)
      })
    })
  })
}
