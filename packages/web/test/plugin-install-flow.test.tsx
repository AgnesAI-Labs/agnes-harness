/** @vitest-environment happy-dom */

import type {
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PackageOperation,
  PackagePreview,
} from '@agnes/protocol'
import { ADMIN_FEATURES } from '@agnes/web-admin/admin/plugins/types'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// Every case starts from fresh module state, so the page and the controller share one instance.
beforeEach(() => vi.resetModules())

const timestamp = '2026-10-15T00:00:00.000Z'
const integrity = `sha256-${'7a'.repeat(32)}`
const capabilityHash = 'e3'.repeat(32)
const ID = '@agnes-examples/dag-loop'
const ABSOLUTE = '/opt/agnes/bundled-examples/loops/dag-loop'

const entry: PackageCatalogDescriptor = {
  id: ID,
  version: '1.0.0',
  source: { type: 'file', ref: `file:${ABSOLUTE}` },
  integrity,
  license: 'Apache-2.0',
  contributions: [],
  compatibility: 'supported',
  sourceId: 'official-examples',
  retrievedAt: timestamp,
  provides: ['loop'],
  presentation: { origin: 'example', rows: [] },
  metadata: {
    displayName: 'Task graph Loop',
    summary: 'Runs a checked task graph.',
    description: 'Runs independent tools of a checked task graph in parallel.',
  },
} as unknown as PackageCatalogDescriptor

const preview: PackagePreview = {
  id: ID,
  version: '1.0.0',
  provides: ['loop'],
  source: entry.source,
  integrity,
  license: 'Apache-2.0',
  provenance: { source: entry.source, integrity, signatureVerified: false },
  contributions: [],
  capabilityDiff: {
    added: [],
    removed: [],
    runtimeSupportRemoved: [],
    dependenciesAdded: [],
    serviceGrantsAdded: [],
  },
  dependencies: {},
  warnings: [
    { code: 'unverified-provenance', safeMessage: 'Unverified publisher.' },
    { code: 'capability-change', safeMessage: 'Capabilities changed.' },
  ],
  blockers: [],
  capabilityHash,
  metadata: entry.metadata,
  presentation: { origin: 'example', rows: [] },
} as unknown as PackagePreview

const installedRow: PackageInstalledDescriptor = {
  id: ID,
  version: '1.0.0',
  source: entry.source,
  integrity,
  trusted: false,
  desired: 'installed-disabled',
  actual: 'not-running',
  cleanupPending: false,
  rollbackTarget: null,
  contributions: [],
  blockers: [],
  capabilityHash,
  metadata: entry.metadata,
} as unknown as PackageInstalledDescriptor

function operation(
  operationId: string,
  kind: PackageOperation['operation'],
  fields: Partial<PackageOperation>,
) {
  return {
    operationId,
    profile: 'local-dev',
    operation: kind,
    state: 'completed',
    progress: 100,
    startedAt: timestamp,
    updatedAt: timestamp,
    cancellable: false,
    retryable: false,
    ...fields,
  } as PackageOperation
}

type Outcome = 'completed' | 'failed' | 'running'
/** A ready backend with one catalog entry; each case decides how its check and install end. */
function backend(options: { inspect?: Outcome; install?: Outcome } = {}) {
  const outcome = { inspect: options.inspect ?? 'completed', install: options.install ?? 'completed' }
  let installed: PackageInstalledDescriptor[] = []
  const calls: string[] = []
  const failure = (message: string) => ({
    state: 'failed' as const,
    error: { code: 'E_PACKAGE_SOURCE' as const, safeMessage: message, blockers: [] },
  })
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    if (url.endsWith('/session')) return new Response('{}', { status: 200 })
    if (url.endsWith('/overview'))
      return Response.json({
        context: {
          profile: 'local-dev',
          clientId: 'install-flow-test',
          permissions: ['packages.read', 'packages.install', 'packages.trust', 'packages.activate'],
          readOnly: false,
          authScope: 'auth.install-flow-test',
          features: Object.values(ADMIN_FEATURES),
        },
        inventory: { packages: installed },
      })
    if (url.endsWith('/catalog/list')) return Response.json({ items: [entry], nextCursor: null })
    if (url.endsWith('/list')) return Response.json({ packages: installed })
    if (url.endsWith('/tree/list')) return Response.json({ desiredDigest: 'sha256-x', actual: true })
    if (url.endsWith('/surfaces')) return Response.json({ surfaces: [] })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans: [] })
    if (url.endsWith('/inspect')) {
      calls.push('inspect')
      return Response.json({ operationId: 'inspect-1', profile: 'local-dev' })
    }
    if (url.endsWith('/install')) {
      calls.push('install')
      return Response.json({ operationId: 'install-1', profile: 'local-dev' })
    }
    if (url.endsWith('/operation/get')) {
      if (body.operationId === 'inspect-1') {
        if (outcome.inspect === 'running')
          return Response.json(operation('inspect-1', 'inspect', { state: 'inspecting', progress: 10 }))
        return Response.json(
          outcome.inspect === 'failed'
            ? operation('inspect-1', 'inspect', failure('The source folder could not be read.'))
            : operation('inspect-1', 'inspect', { preview }),
        )
      }
      if (outcome.install === 'running')
        return Response.json(
          operation('install-1', 'install', { packageId: ID, state: 'installing', progress: 10 }),
        )
      if (outcome.install === 'failed')
        return Response.json(
          operation('install-1', 'install', { packageId: ID, ...failure('Disk is full.') }),
        )
      installed = [installedRow]
      return Response.json(operation('install-1', 'install', { packageId: ID, installed: installedRow }))
    }
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  return { fetcher, calls, outcome }
}

let host: Awaited<ReturnType<typeof import('./web-dom-fixture.js').mountRenderedIndex>> | undefined
let root: Root | undefined
let releaseFeedback: (() => void) | undefined

/** The plugins page's marketplace with its pushed pages, over the real plugin controller. */
async function mountMarket(fetcher: ReturnType<typeof backend>['fetcher'], page?: string) {
  const { mountRenderedIndex } = await import('./web-dom-fixture.js')
  host = await mountRenderedIndex()
  document.documentElement.lang = 'zh-CN'
  history.replaceState(null, '', `/?page=plugins&tab=market${page ? `&view=${page}` : ''}#install-flow-token`)
  vi.stubGlobal('fetch', fetcher)
  const web = await import('@agnes/web-ui')
  const { createOperationFeedback } = await import('../src/operation-feedback.js')
  const feedback = createOperationFeedback()
  releaseFeedback = web.installFeedbackSink(feedback.sink)
  const { usePluginAdmin } = await import('../src/pages/plugins/admin-view.js')
  const { MarketTab } = await import('../src/pages/plugins/market-tab.js')
  const { PluginStatus } = await import('../src/pages/plugins/plugins-tab.js')
  const { PluginPages } = await import('../src/pages/plugins/plugin-pages.js')
  const { InstallReviewPage } = await import('../src/pages/plugins/install-page.js')
  const { pluginsPageCatalog } = await import('../src/pages/plugins/page-locale.js')
  const zh = pluginsPageCatalog['zh-CN'] ?? {}
  const t = (key: string, vars: Readonly<Record<string, string | number>> = {}) =>
    Object.entries(vars).reduce(
      (text, [name, value]) => text.replace(`{${name}}`, String(value)),
      zh[key] ?? key,
    )
  function Market() {
    const snapshot = web.useStoreSelector(feedback.store, (value) => value)
    const { host: controllerHost, view } = usePluginAdmin({})
    const selectTab = view?.selectTab
    const ready = !!view && !view.state.loading && !!view.state.context
    useEffect(() => {
      if (ready && selectTab) queueMicrotask(() => void selectTab('discover'))
    }, [ready, selectTab])
    const page = createElement(
      web.PushStack,
      { rootTitle: '插件', route: web.searchParamRoute('view') },
      view && createElement(PluginStatus, { view, t, data: { openSettings() {} } as never }),
      view && createElement(MarketTab, { view, t }),
      createElement(PluginPages, { view }),
      createElement(InstallReviewPage, { view }),
    )
    return createElement(
      'div',
      null,
      createElement('div', { ref: controllerHost, hidden: true }),
      createElement(web.FeedbackHost, { snapshot, onDismiss: feedback.dismiss }),
      // The workbench draws its pages in the reader's language, as the controller does.
      view ? createElement(web.UiLocaleProvider, { source: view.locale }, page) : page,
    )
  }
  const container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root?.render(createElement(Market)))
  await vi.waitFor(() => expect(installButton()).not.toBeNull(), { timeout: 5000 })
  await vi.waitFor(() => expect(installButton()?.disabled).toBe(false), { timeout: 5000 })
  return container
}

const installButton = () => document.querySelector<HTMLButtonElement>('[data-testid="market-install"]')
const review = () => document.querySelector<HTMLElement>('[data-testid="install-review"]')
const view = () => new URL(location.href).searchParams.get('view')
const click = (selector: string) => act(async () => document.querySelector<HTMLElement>(selector)?.click())
/** No dialog anywhere: neither a role nor an open modal host. */
function expectNoDialog() {
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect((document.getElementById('plugin-confirm') as HTMLDialogElement).open).toBe(false)
  expect((document.getElementById('plugin-detail') as HTMLDialogElement).open).toBe(false)
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  releaseFeedback?.()
  releaseFeedback = undefined
  await host?.dispose()
  host = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
  history.replaceState(null, '', '/')
  document.documentElement.lang = 'en'
  document.documentElement.replaceChildren()
})

it('checks in place on the card: the button is busy, nothing navigates and no notice appears', async () => {
  const kit = backend({ inspect: 'running' })
  await mountMarket(kit.fetcher)
  await click('[data-testid="market-install"]')
  await vi.waitFor(() => expect(installButton()?.textContent).toContain('检查中…'))
  expect(installButton()?.disabled).toBe(true)
  expect(installButton()?.getAttribute('aria-busy')).toBe('true')
  expect(kit.calls).toEqual(['inspect'])
  // Still the marketplace: no pushed page, no 插件操作 page, no page-level notice.
  expect(view()).toBeNull()
  expect(document.querySelector('[data-testid="plugin-notice"]')).toBeNull()
  expect(document.body.textContent).not.toContain('正在检查来源')
  expect(document.body.textContent).not.toContain('插件操作')
  expectNoDialog()
}, 60_000)

it('pushes the review page when the check is done, with the hashes under collapsed 技术详情', async () => {
  const kit = backend()
  await mountMarket(kit.fetcher)
  await click('[data-testid="market-install"]')
  await vi.waitFor(() => expect(review()).not.toBeNull(), { timeout: 5000 })
  expect(view()).toBe(`install:${ID}`)
  const crumbs = [...document.querySelectorAll('.agh-push-stack .agh-push-crumbs li')].map(
    (item) => item.textContent,
  )
  expect(crumbs).toEqual(['插件', '安装「Task graph Loop」'])
  expectNoDialog()
  const page = review() as HTMLElement
  // Up front: who it is, what it gets, and whether its source is verified, in short words.
  expect(page.querySelector('[data-testid="install-review-meta"]')?.textContent).toBe(
    '运行方式 · 1.0.0 · 示例',
  )
  expect(page.querySelector('[data-testid="install-review-gets"]')?.textContent).toContain(
    '未声明（运行中的未声明活动会被记录）',
  )
  expect(page.querySelector('[data-testid="install-review-gets"]')?.textContent).toContain('沿用当前策略')
  expect(page.querySelectorAll('[data-testid="install-review-unverified"]')).toHaveLength(1)
  expect(page.querySelector('[data-testid="install-review-warnings"]')).toBeNull()
  expect(page.textContent).not.toContain('。；')
  expect(page.querySelector('[data-testid=install-review-unverified]')?.textContent).not.toContain(
    'Unverified publisher.',
  )
  expect(page.querySelector('[data-testid="install-review-source"]')?.textContent).toContain(
    '示例 · dag-loop',
  )
  // The technical record is there, collapsed: hashes and the path are not shown up front.
  const technical = page.querySelector('[data-testid="install-review-technical"]') as HTMLElement
  expect(technical.getAttribute('data-open')).toBe('false')
  expect(technical.textContent).toContain(integrity)
  expect(technical.textContent).toContain(capabilityHash)
  expect(technical.textContent).toContain('Apache-2.0')
  const upFront = page.textContent?.replace(technical.textContent ?? '', '') ?? ''
  expect(upFront).not.toContain(integrity)
  expect(upFront).not.toContain(ABSOLUTE)
  // Both choices the confirmation offered are still here.
  expect(page.querySelector('[data-testid="install-review-confirm"]')?.textContent).toBe('安装并启用')
  expect(page.querySelector('[data-testid="install-review-secondary"]')?.textContent).toBe('只安装')
  expect(page.querySelector('[data-testid="install-review-cancel"]')?.textContent).toBe('取消')
  expect(kit.calls).toEqual(['inspect'])
})

it('installs from the review page and returns to the marketplace with 已安装 and a toast', async () => {
  const kit = backend()
  await mountMarket(kit.fetcher)
  await click('[data-testid="market-install"]')
  await vi.waitFor(() => expect(review()).not.toBeNull(), { timeout: 5000 })
  await click('[data-testid="install-review-secondary"]')
  await vi.waitFor(() => expect(review()).toBeNull(), { timeout: 5000 })
  expect(kit.calls).toEqual(['inspect', 'install'])
  await vi.waitFor(() => expect(view()).toBeNull())
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="market-card"]')?.textContent).toContain('已安装'),
  )
  await vi.waitFor(() =>
    expect(document.querySelector('.agh-toast')?.textContent).toBe('插件「Task graph Loop」已安装。'),
  )
  const notice = document.querySelector('[data-testid="operation-notice"]')
  expect(notice?.textContent).toContain('启用插件后可使用。')
  expect(notice?.querySelector('button')?.textContent).toBe('去启用')
  expectNoDialog()
})

it('keeps the review page busy while installing, and shows a failure there with a retry', async () => {
  const kit = backend({ install: 'running' })
  await mountMarket(kit.fetcher)
  await click('[data-testid="market-install"]')
  await vi.waitFor(() => expect(review()).not.toBeNull(), { timeout: 5000 })
  await click('[data-testid="install-review-confirm"]')
  const confirm = () => document.querySelector<HTMLButtonElement>('[data-testid="install-review-confirm"]')
  await vi.waitFor(() => expect(confirm()?.getAttribute('aria-busy')).toBe('true'))
  expect(confirm()?.disabled).toBe(true)
  kit.outcome.install = 'failed'
  await vi.waitFor(
    () => expect(document.querySelector('[data-testid="install-review-error"]')).not.toBeNull(),
    {
      timeout: 5000,
    },
  )
  expect(document.querySelector('[data-testid="install-review-error"]')?.textContent).toContain(
    'Disk is full.',
  )
  expect(confirm()?.disabled).toBe(false)
  expect(view()).toBe(`install:${ID}`)
  kit.outcome.install = 'completed'
  await click('[data-testid="install-review-retry"]')
  await vi.waitFor(() => expect(review()).toBeNull(), { timeout: 5000 })
  expect(kit.calls).toEqual(['inspect', 'install', 'install'])
})

it('shows a failed check under the card with a retry, without leaving the marketplace', async () => {
  const kit = backend({ inspect: 'failed' })
  await mountMarket(kit.fetcher)
  await click('[data-testid="market-install"]')
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="market-install-error"]')?.textContent).toContain(
      'The source folder could not be read.',
    ),
  )
  expect(installButton()?.disabled).toBe(false)
  expect(installButton()?.textContent).toBe('安装')
  expect(view()).toBeNull()
  expect(document.querySelector('[data-testid="plugin-notice"]')).toBeNull()
  expectNoDialog()
  kit.outcome.inspect = 'completed'
  await click('[data-testid="market-install-retry"]')
  await vi.waitFor(() => expect(review()).not.toBeNull(), { timeout: 5000 })
  expect(document.querySelector('[data-testid="market-install-error"]')).toBeNull()
  expect(kit.calls).toEqual(['inspect', 'inspect'])
})

it('cancels from the breadcrumb without installing', async () => {
  const kit = backend()
  await mountMarket(kit.fetcher)
  await click('[data-testid="market-install"]')
  await vi.waitFor(() => expect(review()).not.toBeNull(), { timeout: 5000 })
  await click('[data-testid="push-back"]')
  await vi.waitFor(() => expect(review()).toBeNull())
  await vi.waitFor(() => expect(view()).toBeNull())
  expect(kit.calls).toEqual(['inspect'])
  expect(installButton()?.disabled).toBe(false)
})

it('never opens 插件操作 by itself; a running install is reachable from the activity line', async () => {
  const kit = backend({ install: 'running' })
  await mountMarket(kit.fetcher)
  await click('[data-testid="market-install"]')
  await vi.waitFor(() => expect(review()).not.toBeNull(), { timeout: 5000 })
  await click('[data-testid="install-review-confirm"]')
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="install-review-confirm"]')?.getAttribute('aria-busy')).toBe(
      'true',
    ),
  )
  // Leaving the review leaves the install running in the background, and the page where it was.
  await click('[data-testid="push-back"]')
  await vi.waitFor(() => expect(view()).toBeNull())
  const indicator = () => document.querySelector('[data-testid="plugin-operations-indicator"]')
  await vi.waitFor(() => expect(indicator()?.textContent).toContain('1 个插件操作进行中'))
  expect(view()).toBeNull()
  expectNoDialog()
  await click('[data-testid="plugin-operations-open"]')
  await vi.waitFor(() => expect(view()).toBe('operations'))
})

/** React tracks field values itself: write through the native setter, then announce the change. */
function setNativeValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(element, value)
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
  )
}

it('sends 添加插件 through the same review page, which takes the form’s place', async () => {
  const kit = backend({ inspect: 'running' })
  await mountMarket(kit.fetcher, 'add-plugin')
  const form = () => document.getElementById('source-ref') as HTMLInputElement | null
  await vi.waitFor(() => expect(form()).not.toBeNull(), { timeout: 5000 })
  await act(async () => {
    setNativeValue(document.getElementById('source-type') as HTMLSelectElement, 'url')
    setNativeValue(form() as HTMLInputElement, 'https://example.com/dag-loop.tgz')
  })
  // A controlled field must keep what was typed (it used to snap back to empty).
  expect(form()?.value).toBe('https://example.com/dag-loop.tgz')
  await click('#source-form .dialog-actions button:not(#source-cancel)')
  await vi.waitFor(() => expect(kit.calls).toEqual(['inspect']))
  // The form waits, busy, for the check: no page jump in between.
  expect(view()).toBe('add-plugin')
  kit.outcome.inspect = 'completed'
  await vi.waitFor(() => expect(review()).not.toBeNull(), { timeout: 10_000 })
  expect(view()).toBe(`install:${ID}`)
  const crumbs = [...document.querySelectorAll('.agh-push-stack .agh-push-crumbs li')].map(
    (item) => item.textContent,
  )
  expect(crumbs).toEqual(['插件', '安装「Task graph Loop」'])
  expectNoDialog()
  await click('[data-testid="push-back"]')
  await vi.waitFor(() => expect(view()).toBeNull())
  expect(kit.calls).toEqual(['inspect'])
})
