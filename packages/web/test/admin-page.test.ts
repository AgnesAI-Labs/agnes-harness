/** @vitest-environment happy-dom */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PackageOperation,
  PackagePreview,
  RuntimePinDescriptor,
} from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { ADMIN_FEATURES } from '../src/admin/plugins/types.js'
import type { PluginRuntimeState } from '../src/client-modules/runtime-status.js'

type RuntimeFixture = Readonly<{
  snapshot(): ReadonlyMap<string, PluginRuntimeState>
  subscribe(listener: (state: PluginRuntimeState) => void): () => void
  reconcileNow(): Promise<void>
  invalidate(): Promise<void>
}>

/** Mounts the surface the way a host does; importing the module alone must have no effect on the DOM. */
async function mountAdmin(
  options: { actualSlots?: (packageId: string) => readonly string[]; runtime?: RuntimeFixture } = {},
): Promise<{ reload(): Promise<void>; dispose(): void }> {
  const { mountPluginAdmin } = await import('../src/admin/plugins/admin.js')
  return mountPluginAdmin(options)
}

const html = readFileSync(join(process.cwd(), 'packages/web/public/admin.html'), 'utf8')
const timestamp = '2026-09-13T00:00:00.000Z'
const capabilityHash = 'c'.repeat(64)
const families = [
  ['hot-tool', 'examples/hot-tool'],
  ['agent-automation', 'examples/agent-automation'],
  ['compaction-policy', 'examples/compaction-policy'],
] as const

function catalog(): PackageCatalogDescriptor[] {
  let digest = 0
  return families.flatMap(([family, extensionId]) =>
    [
      ['v1', '1.0.0'],
      ['v2', '1.1.0'],
    ].map(([release, version]) => ({
      id: `@agnes-examples/${family}`,
      version,
      source: { type: 'file', ref: `file:./examples/packages/${family}/${release}` },
      integrity: `sha256-${(++digest).toString(16).padStart(64, '0')}`,
      license: 'MIT',
      contributions: [
        {
          kind: 'extension',
          id: extensionId,
          path: './extensions/main/agnes.extension.json',
          apiRange: '^1.0',
          capabilities: {},
          runtimeSupports: ['in-process'],
        },
      ],
      compatibility: 'supported',
      sourceId: 'local-examples',
      retrievedAt: timestamp,
    })),
  ) as PackageCatalogDescriptor[]
}

function preview(selected: PackageCatalogDescriptor): PackagePreview {
  return {
    id: selected.id,
    version: selected.version,
    source: selected.source,
    integrity: selected.integrity,
    license: selected.license,
    provenance: {
      source: selected.source,
      integrity: selected.integrity,
      signatureVerified: false,
    },
    contributions: selected.contributions,
    capabilityDiff: {
      added: ['tools:demo_text_stats'],
      removed: [],
      runtimeSupportRemoved: [],
      dependenciesAdded: [],
      serviceGrantsAdded: [],
    },
    dependencies: {},
    warnings: [{ code: 'unverified-provenance', safeMessage: '本地示例来源尚未独立签名。' }],
    blockers: [],
    capabilityHash,
  }
}

function operation(
  operationId: string,
  kind: 'inspect' | 'install' | 'trust' | 'untrust' | 'enable' | 'disable' | 'update',
  fields: Partial<PackageOperation>,
): PackageOperation {
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
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
  document.documentElement.replaceChildren()
})

it('renders all real local releases and carries a selected catalog source through preview and install', async () => {
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin.js"></script>', '')
  history.replaceState(null, '', '/admin/plugins#local-admin-token')
  const entries = catalog()
  let installed: PackageInstalledDescriptor[] = []
  const initialSelection = entries[1]
  if (!initialSelection) throw new Error('missing catalog fixture')
  let selected: PackageCatalogDescriptor = initialSelection
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    if (url.endsWith('/session')) return new Response('{}', { status: 200 })
    if (url.endsWith('/context'))
      return Response.json({
        profile: 'local-dev',
        clientId: 'admin-page-test',
        permissions: [
          'packages.read',
          'packages.install',
          'packages.trust',
          'packages.activate',
          'packages.remove',
        ],
        readOnly: false,
        authScope: 'auth.admin-page-test',
        features: Object.values(ADMIN_FEATURES),
      })
    if (url.endsWith('/catalog/list')) return Response.json({ items: entries, nextCursor: null })
    if (url.endsWith('/list')) return Response.json({ packages: installed })
    if (url.endsWith('/inspect')) {
      selected =
        entries.find((entry) => entry.source.ref === (body.source as { ref?: string } | undefined)?.ref) ??
        selected
      return Response.json({ operationId: 'inspect-local-example', profile: 'local-dev' })
    }
    if (url.endsWith('/install'))
      return Response.json({ operationId: 'install-local-example', profile: 'local-dev' })
    if (url.endsWith('/trust'))
      return Response.json({ operationId: 'trust-local-example', profile: 'local-dev' })
    if (url.endsWith('/untrust')) {
      expect(body.id).toBe(selected.id)
      expect(body.expectedIntegrity).toBe(selected.integrity)
      expect(body.capabilityHash).toBe(capabilityHash)
      return Response.json({ operationId: 'untrust-local-example', profile: 'local-dev' })
    }
    if (url.endsWith('/operation/get')) {
      if (body.operationId === 'inspect-local-example')
        return Response.json(
          operation('inspect-local-example', 'inspect', {
            packageId: selected.id,
            preview: preview(selected),
          }),
        )
      if (body.operationId === 'trust-local-example') {
        const trustedInstalled: PackageInstalledDescriptor = {
          ...(installed[0] as PackageInstalledDescriptor),
          trusted: true,
          desired: 'installed-disabled',
          actual: 'not-running',
        }
        installed = [trustedInstalled]
        return Response.json(
          operation('trust-local-example', 'trust', {
            packageId: selected.id,
            installed: trustedInstalled,
          }),
        )
      }
      if (body.operationId === 'untrust-local-example') {
        const untrustedInstalled: PackageInstalledDescriptor = {
          ...(installed[0] as PackageInstalledDescriptor),
          trusted: false,
          desired: 'installed-disabled',
          actual: 'not-running',
        }
        installed = [untrustedInstalled]
        return Response.json(
          operation('untrust-local-example', 'untrust', {
            packageId: selected.id,
            installed: untrustedInstalled,
          }),
        )
      }
      const completed: PackageInstalledDescriptor = {
        id: selected.id,
        version: selected.version,
        source: selected.source,
        integrity: selected.integrity,
        trusted: false,
        desired: 'installed-disabled',
        actual: 'not-running',
        cleanupPending: false,
        rollbackTarget: null,
        contributions: selected.contributions,
        blockers: [],
        capabilityHash,
      }
      installed = [completed]
      return Response.json(
        operation('install-local-example', 'install', {
          packageId: selected.id,
          installed: completed,
        }),
      )
    }
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetcher)

  await mountAdmin()
  await vi.waitFor(() => expect(document.querySelector('.plugin-empty')?.textContent).toContain('尚未安装'))
  expect(document.querySelector('.plugin-empty')?.classList.contains('admin-empty-state')).toBe(true)
  expect(document.querySelector('.plugin-empty .admin-empty-state-mark')).not.toBeNull()
  document.getElementById('discover-tab')?.click()
  await vi.waitFor(() => expect(document.querySelectorAll('.plugin-row')).toHaveLength(6))

  const listText = document.getElementById('plugin-list')?.textContent ?? ''
  expect(listText).toContain('@agnes-examples/hot-tool')
  expect(listText).toContain('@agnes-examples/agent-automation')
  expect(listText).toContain('@agnes-examples/compaction-policy')
  expect(listText).toContain('1.0.0')
  expect(listText).toContain('1.1.0')
  expect(listText).not.toContain('1.2.0')

  const v2 = [...document.querySelectorAll<HTMLElement>('.plugin-row')].find(
    (row) => row.textContent.includes('@agnes-examples/hot-tool') && row.textContent.includes('1.1.0'),
  )
  expect(v2).toBeDefined()
  v2?.click()
  expect(document.getElementById('plugin-detail')?.textContent).toContain('版本 1.1.0')
  const check = [...document.querySelectorAll<HTMLButtonElement>('#plugin-detail button')].find(
    (candidate) => candidate.textContent === '检查安装内容',
  )
  check?.click()
  await vi.waitFor(() =>
    expect(document.getElementById('plugin-confirm-title')?.textContent).toContain('安装预览'),
  )
  expect(document.getElementById('plugin-confirm-preview')?.textContent).toContain(selected.integrity)
  expect(document.getElementById('plugin-confirm-preview')?.textContent).toContain('examples/hot-tool')

  document.getElementById('plugin-confirm-action')?.click()
  await vi.waitFor(() => expect(installed).toHaveLength(1))
  document.getElementById('installed-tab')?.click()
  await vi.waitFor(() => expect(document.querySelectorAll('.plugin-row')).toHaveLength(1))
  const installedText = document.getElementById('plugin-list')?.textContent ?? ''
  expect(installedText).toContain('@agnes-examples/hot-tool')
  expect(installedText).toContain('1.1.0')
  // 状态 chip 换成了红绿灯：列表行只留标签与值，完整语义（"标签：值"）挂在 title 上。
  const lightTitles = [...document.querySelectorAll('#plugin-list .state-light')].map((light) =>
    light.getAttribute('title'),
  )
  expect(lightTitles).toContain('信任：未信任')
  expect(lightTitles).toContain('期望：停用')
  expect(lightTitles).toContain('实际：未运行')
  expect(document.querySelector('.plugin-row-trust')?.textContent).toBe('信任')
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/install'))).toBe(true)
  expect(document.querySelector('.plugin-detail-close')?.textContent).toBe('关闭详情')
  document.querySelector<HTMLButtonElement>('.plugin-detail-close')?.click()
  await vi.waitFor(() => expect(document.getElementById('plugin-detail')?.hasAttribute('open')).toBe(false))

  // 回归：未信任的已装插件在列表行直接给"信任"动作（此前只有永远置灰的 Switch，
  // 新装插件在 Web UI 没有任何路径走到信任确认）。
  const trust = [...document.querySelectorAll<HTMLButtonElement>('#plugin-list button')].find(
    (candidate) => candidate.textContent === '信任',
  )
  expect(trust).toBeDefined()
  trust?.click()
  await vi.waitFor(() =>
    expect(document.getElementById('plugin-confirm-title')?.textContent).toContain('信任'),
  )
  expect(document.getElementById('plugin-confirm-preview')?.textContent).toContain(capabilityHash)
  document.getElementById('plugin-confirm-action')?.click()
  await vi.waitFor(() => expect(installed[0]?.trusted).toBe(true))
  // 信任不会自动启用，第三列仍显示停用状态的启用动作。
  await vi.waitFor(() => expect(document.querySelector('#plugin-list button[role="switch"]')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('#plugin-list button[role="switch"]')?.click()
  await vi.waitFor(() =>
    expect(document.getElementById('plugin-confirm-title')?.textContent).toContain('请求启用'),
  )
  expect(document.getElementById('plugin-confirm-description')?.textContent).toContain(
    '请求启用只提交期望状态',
  )
  document.getElementById('plugin-confirm-cancel')?.click()

  // 撤信任不同于卸载：它以已安装摘要和能力摘要为 CAS 基线，恢复为未信任、停用状态。
  document.querySelector<HTMLElement>('.plugin-row')?.click()
  await vi.waitFor(() => expect(document.getElementById('plugin-detail')?.hasAttribute('open')).toBe(true))
  const untrust = [...document.querySelectorAll<HTMLButtonElement>('#plugin-detail button')].find(
    (candidate) => candidate.textContent === '撤销信任并停用',
  )
  expect(untrust?.disabled).toBe(false)
  untrust?.click()
  await vi.waitFor(() =>
    expect(document.getElementById('plugin-confirm-title')?.textContent).toContain('撤销信任'),
  )
  expect(document.getElementById('plugin-confirm-preview')?.textContent).toContain('恢复与回滚候选')
  document.getElementById('plugin-confirm-action')?.click()
  await vi.waitFor(() => expect(installed[0]?.trusted).toBe(false))
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/untrust'))).toBe(true)
})

it('links a live Surface mount without treating the link as qualified actual', async () => {
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin.js"></script>', '')
  history.replaceState(null, '', '/admin/plugins#local-admin-token')
  const surfacePackage: PackageInstalledDescriptor = {
    id: 'agnes/demo-surface',
    version: '1.0.0',
    source: { type: 'file', ref: 'file:./examples/packages/demo-surface' },
    integrity: `sha256-${'d'.repeat(64)}`,
    trusted: true,
    desired: 'enabled',
    actual: 'not-running',
    cleanupPending: false,
    rollbackTarget: null,
    blockers: [],
    contributions: [
      {
        kind: 'surface',
        id: 'demo',
        descriptor: {
          id: 'demo',
          apiRange: '*',
          artifact: { kind: 'node', entry: './dist/server.mjs' },
          healthPath: '/health',
          requires: { services: [] },
        },
      },
    ],
  }
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith('/session')) return Response.json({ authenticated: true })
    if (url.endsWith('/context'))
      return Response.json({
        profile: 'local-dev',
        clientId: 'admin-page-surface-test',
        permissions: ['packages.read'],
        readOnly: false,
        authScope: 'auth.admin-page-surface-test',
        features: Object.values(ADMIN_FEATURES),
      })
    if (url.endsWith('/list')) return Response.json({ packages: [surfacePackage] })
    if (url.endsWith('/surfaces'))
      return Response.json({
        surfaces: [{ packageId: surfacePackage.id, surfaceId: 'demo', mount: '/demo' }],
      })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans: [] })
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetcher)

  await mountAdmin()
  await vi.waitFor(() => expect(document.querySelectorAll('.plugin-row')).toHaveLength(1))
  const row = document.querySelector<HTMLElement>('.plugin-row')
  const stateTitles = [...document.querySelectorAll('#plugin-list .state-light')].map((light) =>
    light.getAttribute('title'),
  )
  expect(stateTitles).toContain('实际：未运行')
  const listLink = row?.querySelector<HTMLAnchorElement>('.plugin-surface-link')
  expect(listLink?.getAttribute('href')).toBe('/demo')
  expect(listLink?.textContent).toBe('打开页面 · /demo')
  expect(listLink?.target).toBe('_blank')

  row?.click()
  const detailLinks = document.querySelectorAll<HTMLAnchorElement>(
    '#plugin-detail .plugin-surface-link[href="/demo"]',
  )
  expect(detailLinks).toHaveLength(1)
  expect(document.getElementById('plugin-detail')?.textContent).toContain('未运行')
})

it('keeps backend actual and browser UI runtime failure visible as separate states', async () => {
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin-standalone.js"></script>', '')
  history.replaceState(null, '', '/admin/plugins#runtime-status-token')
  const installed: PackageInstalledDescriptor = {
    id: 'acme/ui-plugin',
    version: '1.0.0',
    source: { type: 'file', ref: 'file:./ui-plugin' },
    integrity: `sha256-${'f'.repeat(64)}`,
    trusted: true,
    desired: 'enabled',
    actual: 'running',
    actualVersion: '1.0.0',
    actualIntegrity: `sha256-${'f'.repeat(64)}`,
    cleanupPending: false,
    rollbackTarget: null,
    contributions: [
      {
        kind: 'extension',
        id: 'acme/stale-ui-plugin',
        path: './extensions/main/agnes.extension.json',
        apiRange: '^1.0',
        capabilities: { ui: ['client'] },
        runtimeSupports: ['in-process'],
        client: { entry: './client/index.js', slots: ['ui:sidebar'] },
      },
    ],
    blockers: [],
  }
  let runtime: PluginRuntimeState = {
    packageId: installed.id,
    revision: 'r1',
    phase: 'failed',
    error: { code: 'CLIENT_MODULE_IMPORT_FAILED', message: '插件 UI 入口加载失败，可重试' },
  }
  const invalidate = vi.fn(async () => undefined)
  const listeners = new Set<(state: PluginRuntimeState) => void>()
  const runtimeSource: RuntimeFixture = {
    snapshot: () => new Map([['web:acme/ui-plugin', runtime]]),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reconcileNow: async () => undefined,
    invalidate,
  }
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith('/session')) return Response.json({ authenticated: true })
    if (url.endsWith('/context'))
      return Response.json({
        profile: 'local-dev',
        clientId: 'runtime-status-test',
        permissions: ['packages.read', 'packages.activate'],
        readOnly: false,
        authScope: 'auth.runtime-status-test',
        features: Object.values(ADMIN_FEATURES),
      })
    if (url.endsWith('/list')) return Response.json({ packages: [installed] })
    if (url.endsWith('/tree/list')) return Response.json({ actual: true, pending: false })
    if (url.endsWith('/surfaces')) return Response.json({ surfaces: [] })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans: [] })
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetcher)

  await mountAdmin({ runtime: runtimeSource })
  await vi.waitFor(() => expect(document.querySelectorAll('.plugin-row')).toHaveLength(1))
  expect(
    [...document.querySelectorAll('#plugin-list .state-light')].map((light) => light.getAttribute('title')),
  ).toContain('浏览器 UI：加载失败，可重试')
  expect(document.getElementById('plugin-list')?.textContent).toContain('运行中')
  expect(document.querySelector('#plugin-list button[role="switch"]')).not.toBeNull()
  const retry = [...document.querySelectorAll<HTMLButtonElement>('#plugin-list button')].find(
    (candidate) => candidate.textContent === '重试 UI',
  )
  expect(retry).toBeDefined()
  retry?.click()
  await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1))

  runtime = { packageId: installed.id, revision: 'r1', phase: 'active' }
  for (const listener of listeners) listener(runtime)
  await vi.waitFor(() => expect(document.getElementById('plugin-list')?.textContent).toContain('已加载'))
})

it('does not confirm enable while the browser runtime is still running the old revision', async () => {
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin-standalone.js"></script>', '')
  history.replaceState(null, '', '/admin/plugins#stale-runtime-token')
  const installedIntegrity = `sha256-${'2'.repeat(64)}`
  const installed: PackageInstalledDescriptor = {
    id: 'acme/stale-ui-plugin',
    version: '2.0.0',
    source: { type: 'file', ref: 'file:./stale-ui-plugin-v2' },
    integrity: installedIntegrity,
    trusted: true,
    desired: 'installed-disabled',
    actual: 'not-running',
    cleanupPending: false,
    rollbackTarget: null,
    contributions: [
      {
        kind: 'extension',
        id: 'acme/stale-ui-plugin',
        path: './extensions/main/agnes.extension.json',
        apiRange: '^1.0',
        capabilities: { ui: ['client'] },
        runtimeSupports: ['in-process'],
        client: { entry: './client/index.js', slots: ['ui:sidebar'] },
      },
    ],
    blockers: [],
  }
  let currentInstalled = installed
  const invalidate = vi.fn(async () => undefined)
  const runtimeSource: RuntimeFixture = {
    snapshot: () =>
      new Map([
        ['web:acme/stale-ui-plugin', { packageId: installed.id, revision: 'sha256-old', phase: 'active' }],
      ]),
    subscribe: () => () => undefined,
    reconcileNow: async () => undefined,
    invalidate,
  }
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    if (url.endsWith('/session')) return Response.json({ authenticated: true })
    if (url.endsWith('/context'))
      return Response.json({
        profile: 'local-dev',
        clientId: 'stale-runtime-test',
        permissions: ['packages.read', 'packages.activate'],
        readOnly: false,
        authScope: 'auth.stale-runtime-test',
        features: Object.values(ADMIN_FEATURES),
      })
    if (url.endsWith('/list')) return Response.json({ packages: [currentInstalled] })
    if (url.endsWith('/tree/list')) return Response.json({ actual: true, pending: false })
    if (url.endsWith('/surfaces')) return Response.json({ surfaces: [] })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans: [] })
    if (url.endsWith('/enable')) return Response.json({ operationId: 'enable-stale', profile: 'local-dev' })
    if (url.endsWith('/operation/get')) {
      expect(body.operationId).toBe('enable-stale')
      currentInstalled = { ...installed, desired: 'enabled', actual: 'running' }
      return Response.json(
        operation('enable-stale', 'enable', {
          packageId: installed.id,
          installed: currentInstalled,
        }),
      )
    }
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetcher)

  await mountAdmin({ runtime: runtimeSource })
  await vi.waitFor(() => expect(document.querySelectorAll('.plugin-row')).toHaveLength(1))
  document.querySelector<HTMLButtonElement>('#plugin-list button[role="switch"]')?.click()
  await vi.waitFor(() =>
    expect(document.getElementById('plugin-confirm-title')?.textContent).toContain('请求启用'),
  )
  document.getElementById('plugin-confirm-action')?.click()

  await vi.waitFor(
    () => expect(document.getElementById('admin-notice')?.textContent).toContain('浏览器 UI 状态待确认'),
    { timeout: 5_000 },
  )
  expect(invalidate).toHaveBeenCalledTimes(1)
}, 12_000)

it('allows a checked enable for an inactive client-only package while backend actual is starting', async () => {
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin-standalone.js"></script>', '')
  history.replaceState(null, '', '/admin/plugins#client-only-enable-token')
  const installedIntegrity = `sha256-${'a'.repeat(64)}`
  const installed: PackageInstalledDescriptor = {
    id: '@agnes-examples/dsh-tool-view',
    version: '1.0.0',
    source: { type: 'file', ref: 'file:./examples/packages/dsh-tool-view/v1' },
    integrity: installedIntegrity,
    trusted: true,
    desired: 'installed-disabled',
    actual: 'starting',
    cleanupPending: false,
    rollbackTarget: null,
    contributions: [
      {
        kind: 'extension',
        id: 'examples/dsh-tool-view',
        path: './extensions/main/agnes.extension.json',
        apiRange: '^1.1',
        capabilities: { ui: ['client'] },
        runtimeSupports: ['in-process'],
        client: {
          entry: './client/index.js',
          slots: ['tool.call.toolview'],
          slotCatalogVersion: 'dsh-client-slots/v1',
        },
      },
    ],
    blockers: [],
  }
  let currentInstalled = installed
  let enableBody: Record<string, unknown> | undefined
  let runtimeState: PluginRuntimeState | undefined
  let registeredSlots: readonly string[] = []
  const runtimeListeners = new Set<(state: PluginRuntimeState) => void>()
  const runtime: RuntimeFixture = {
    snapshot: () => new Map(runtimeState ? [[`web:${installed.id}`, runtimeState]] : []),
    subscribe: (listener) => {
      runtimeListeners.add(listener)
      return () => runtimeListeners.delete(listener)
    },
    reconcileNow: async () => undefined,
    invalidate: async () => undefined,
  }
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    if (url.endsWith('/session')) return Response.json({ authenticated: true })
    if (url.endsWith('/context'))
      return Response.json({
        profile: 'local-dev',
        clientId: 'client-only-enable-test',
        permissions: ['packages.read', 'packages.activate'],
        readOnly: false,
        authScope: 'auth.client-only-enable-test',
        features: Object.values(ADMIN_FEATURES),
      })
    if (url.endsWith('/list')) return Response.json({ packages: [currentInstalled] })
    if (url.endsWith('/tree/list')) return Response.json({ actual: true, pending: false })
    if (url.endsWith('/surfaces')) return Response.json({ surfaces: [] })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans: [] })
    if (url.endsWith('/enable')) {
      enableBody = body
      return Response.json({ operationId: 'enable-client-only', profile: 'local-dev' })
    }
    if (url.endsWith('/operation/get')) {
      currentInstalled = { ...installed, desired: 'enabled', actual: 'starting' }
      return Response.json(
        operation('enable-client-only', 'enable', {
          packageId: installed.id,
          installed: currentInstalled,
        }),
      )
    }
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetcher)

  const page = await mountAdmin({ actualSlots: () => registeredSlots, runtime })
  await vi.waitFor(() => expect(document.querySelectorAll('.plugin-row')).toHaveLength(1))
  const enable = document.querySelector<HTMLButtonElement>('#plugin-list button[role="switch"]')
  expect(enable?.disabled).toBe(false)
  enable?.click()
  await vi.waitFor(() =>
    expect(document.getElementById('plugin-confirm-title')?.textContent).toContain('请求启用'),
  )

  runtimeState = { packageId: installed.id, revision: installedIntegrity, phase: 'loading' }
  for (const listener of runtimeListeners) listener(runtimeState)
  document.getElementById('plugin-confirm-action')?.click()
  await vi.waitFor(() =>
    expect(document.getElementById('admin-notice')?.textContent).toContain('实际运行摘要尚未确认'),
  )
  await vi.waitFor(() => expect(document.getElementById('plugin-confirm')?.hasAttribute('open')).toBe(false))
  expect(enableBody).toBeUndefined()

  runtimeState = { packageId: installed.id, revision: installedIntegrity, phase: 'idle' }
  for (const listener of runtimeListeners) listener(runtimeState)
  registeredSlots = ['tool.call.toolview']
  document.querySelector<HTMLButtonElement>('#plugin-list button[role="switch"]')?.click()
  await vi.waitFor(() =>
    expect(document.getElementById('admin-notice')?.textContent).toContain('实际运行摘要尚未确认'),
  )
  expect(document.getElementById('plugin-confirm')?.hasAttribute('open')).toBe(false)
  expect(enableBody).toBeUndefined()

  registeredSlots = []
  const clientContribution = installed.contributions[0]
  if (clientContribution?.kind !== 'extension') throw new Error('missing client extension fixture')
  currentInstalled = {
    ...installed,
    contributions: [{ ...clientContribution, capabilities: { ui: ['client'], tools: { prefix: 'test_' } } }],
  }
  await page.reload()
  document.querySelector<HTMLButtonElement>('#plugin-list button[role="switch"]')?.click()
  await vi.waitFor(() =>
    expect(document.getElementById('admin-notice')?.textContent).toContain('实际运行摘要尚未确认'),
  )
  expect(document.getElementById('plugin-confirm')?.hasAttribute('open')).toBe(false)
  expect(enableBody).toBeUndefined()

  currentInstalled = installed
  await page.reload()
  document.querySelector<HTMLButtonElement>('#plugin-list button[role="switch"]')?.click()
  await vi.waitFor(() =>
    expect(document.getElementById('plugin-confirm-title')?.textContent).toContain('请求启用'),
  )
  document.getElementById('plugin-confirm-action')?.click()

  await vi.waitFor(() =>
    expect(enableBody).toMatchObject({
      id: installed.id,
      expectedInstalledIntegrity: installedIntegrity,
      expectedActiveIntegrity: null,
    }),
  )
  await vi.waitFor(() =>
    expect(document.getElementById('admin-notice')?.textContent).toContain('启用：已完成'),
  )
  page.dispose()
})

function pinsContext(): Record<string, unknown> {
  return {
    profile: 'local-dev',
    clientId: 'admin-page-pins-test',
    permissions: [
      'packages.read',
      'packages.install',
      'packages.trust',
      'packages.activate',
      'packages.remove',
    ],
    readOnly: false,
    authScope: 'auth.admin-page-pins-test',
    features: Object.values(ADMIN_FEATURES),
  }
}

function orphanPin(): RuntimePinDescriptor {
  return {
    pinId: 'pin-1',
    purpose: 'candidate',
    packageId: 'acme/plugin',
    version: '1.0.0',
    snapshotId: 'snap-1',
    operationId: 'op-1',
  }
}

it('hides the orphan pins section when packages.pins.inspect reports no orphans', async () => {
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin.js"></script>', '')
  history.replaceState(null, '', '/admin/plugins#pins-empty-token')
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith('/session')) return new Response('{}', { status: 200 })
    if (url.endsWith('/context')) return Response.json(pinsContext())
    if (url.endsWith('/list')) return Response.json({ packages: [] })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans: [] })
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetcher)
  vi.resetModules()

  await mountAdmin()
  await vi.waitFor(() => expect(document.querySelector('.plugin-empty')?.textContent).toContain('尚未安装'))

  expect(document.getElementById('orphan-pins')).toHaveProperty('hidden', true)
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/pins/inspect'))).toBe(true)
})

// Finding 5 of the whole-branch review: refresh() used to swallow a pins/inspect failure with no
// visible signal and no clearing of a previously-shown (now unverified) orphan list.
it('surfaces a status message and clears a stale list when packages.pins.inspect fails', async () => {
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin.js"></script>', '')
  history.replaceState(null, '', '/admin/plugins#pins-inspect-fail-token')
  const pin = orphanPin()
  let inspectCalls = 0
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith('/session')) return new Response('{}', { status: 200 })
    if (url.endsWith('/context')) return Response.json(pinsContext())
    if (url.endsWith('/list')) return Response.json({ packages: [] })
    if (url.endsWith('/pins/inspect')) {
      inspectCalls++
      // First refresh (on start()) succeeds with one orphan; a later refresh fails and must not
      // leave that stale orphan showing as current.
      if (inspectCalls === 1) return Response.json({ orphans: [pin] })
      return Response.json(
        { error: { code: 'ADMIN_UNAVAILABLE', message: '暂时无法读取孤儿 pin。' } },
        { status: 500 },
      )
    }
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetcher)
  vi.resetModules()

  const admin = await mountAdmin()
  await vi.waitFor(() => expect(document.getElementById('orphan-pins')).toHaveProperty('hidden', false))
  expect(document.getElementById('orphan-pins-list')?.textContent).toContain('acme/plugin@1.0.0')

  await admin.reload()

  await vi.waitFor(() =>
    expect(document.getElementById('orphan-pins-status')?.textContent).toContain('暂时无法读取孤儿 pin。'),
  )
  expect(document.getElementById('orphan-pins')).toHaveProperty('hidden', false)
  expect(document.getElementById('orphan-pins-list')?.textContent ?? '').not.toContain('acme/plugin@1.0.0')
})

it('shows orphaned pins and removes a released one after confirming', async () => {
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin.js"></script>', '')
  history.replaceState(null, '', '/admin/plugins#pins-release-token')
  const pin = orphanPin()
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/session')) return new Response('{}', { status: 200 })
    if (url.endsWith('/context')) return Response.json(pinsContext())
    if (url.endsWith('/list')) return Response.json({ packages: [] })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans: [pin] })
    if (url.endsWith('/pins/release')) {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      expect(body.pinIds).toEqual([pin.pinId])
      expect(body.clientId).toBe('admin-page-pins-test')
      return Response.json({ results: [{ pinId: pin.pinId, outcome: 'released' }] })
    }
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetcher)
  vi.resetModules()

  await mountAdmin()
  await vi.waitFor(() => expect(document.getElementById('orphan-pins')).toHaveProperty('hidden', false))
  expect(document.getElementById('orphan-pins-list')?.textContent).toContain('acme/plugin@1.0.0')

  document.querySelector<HTMLButtonElement>(`[data-pin-id="${pin.pinId}"] button`)?.click()
  await vi.waitFor(() =>
    expect(document.getElementById('plugin-confirm-title')?.textContent).toContain(pin.pinId),
  )
  document.getElementById('plugin-confirm-action')?.click()

  await vi.waitFor(() => expect(document.getElementById('orphan-pins')).toHaveProperty('hidden', true))
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/pins/release'))).toBe(true)
})

it('keeps a failed release in the list and shows its error message', async () => {
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin.js"></script>', '')
  history.replaceState(null, '', '/admin/plugins#pins-fail-token')
  const pin = orphanPin()
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith('/session')) return new Response('{}', { status: 200 })
    if (url.endsWith('/context')) return Response.json(pinsContext())
    if (url.endsWith('/list')) return Response.json({ packages: [] })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans: [pin] })
    if (url.endsWith('/pins/release'))
      return Response.json({
        results: [
          {
            pinId: pin.pinId,
            outcome: 'failed',
            error: { code: 'E_PACKAGE_STATE', safeMessage: '快照仍被引用，无法释放。', blockers: [] },
          },
        ],
      })
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetcher)
  vi.resetModules()

  await mountAdmin()
  await vi.waitFor(() => expect(document.getElementById('orphan-pins')).toHaveProperty('hidden', false))

  document.querySelector<HTMLButtonElement>(`[data-pin-id="${pin.pinId}"] button`)?.click()
  await vi.waitFor(() =>
    expect(document.getElementById('plugin-confirm-title')?.textContent).toContain(pin.pinId),
  )
  document.getElementById('plugin-confirm-action')?.click()

  await vi.waitFor(() =>
    expect(document.getElementById('orphan-pins-list')?.textContent).toContain('快照仍被引用，无法释放。'),
  )
  expect(document.getElementById('orphan-pins')).toHaveProperty('hidden', false)
  expect(document.querySelector(`[data-pin-id="${pin.pinId}"]`)).not.toBeNull()
})

// PackagePinsReleaseParams.pinIds caps at 64 (packages/protocol/schema/package-admin.json); "release
// all" must not hand every orphan to a single call once there are more orphans than that.
it('release-all batches more than 64 orphaned pins into multiple pins/release calls', async () => {
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin.js"></script>', '')
  history.replaceState(null, '', '/admin/plugins#pins-batch-token')
  const orphans: RuntimePinDescriptor[] = Array.from({ length: 65 }, (_, index) => ({
    pinId: `pin-${index}`,
    purpose: 'candidate',
    packageId: 'acme/plugin',
    version: '1.0.0',
    snapshotId: `snap-${index}`,
    operationId: `op-${index}`,
  }))
  const releaseCalls: string[][] = []
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/session')) return new Response('{}', { status: 200 })
    if (url.endsWith('/context')) return Response.json(pinsContext())
    if (url.endsWith('/list')) return Response.json({ packages: [] })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans })
    if (url.endsWith('/pins/release')) {
      const body = init?.body ? (JSON.parse(String(init.body)) as { pinIds: string[] }) : { pinIds: [] }
      releaseCalls.push(body.pinIds)
      return Response.json({
        results: body.pinIds.map((pinId) => ({ pinId, outcome: 'released' as const })),
      })
    }
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetcher)
  vi.resetModules()

  await mountAdmin()
  await vi.waitFor(() => expect(document.getElementById('orphan-pins')).toHaveProperty('hidden', false))

  document.getElementById('orphan-pins-release-all')?.click()
  await vi.waitFor(() =>
    expect(document.getElementById('plugin-confirm-title')?.textContent).toContain('全部孤儿 pin'),
  )
  document.getElementById('plugin-confirm-action')?.click()

  await vi.waitFor(() => expect(document.getElementById('orphan-pins')).toHaveProperty('hidden', true))
  expect(releaseCalls).toHaveLength(2)
  const [first, second] = releaseCalls
  expect(first).toHaveLength(64)
  expect(second).toHaveLength(1)
  expect(new Set([...(first ?? []), ...(second ?? [])])).toEqual(new Set(orphans.map((p) => p.pinId)))
})

// Regression: a later batch's network-level failure must not discard the UI update for batches that
// already succeeded (non-transactional, per-pinId release).
it('keeps an earlier successfully-released batch reflected in the UI when a later batch call fails', async () => {
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin.js"></script>', '')
  history.replaceState(null, '', '/admin/plugins#pins-batch-partial-fail-token')
  const orphans: RuntimePinDescriptor[] = Array.from({ length: 65 }, (_, index) => ({
    pinId: `pin-${index}`,
    purpose: 'candidate',
    packageId: 'acme/plugin',
    version: '1.0.0',
    snapshotId: `snap-${index}`,
    operationId: `op-${index}`,
  }))
  let releaseCallCount = 0
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/session')) return new Response('{}', { status: 200 })
    if (url.endsWith('/context')) return Response.json(pinsContext())
    if (url.endsWith('/list')) return Response.json({ packages: [] })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans })
    if (url.endsWith('/pins/release')) {
      releaseCallCount++
      const body = init?.body ? (JSON.parse(String(init.body)) as { pinIds: string[] }) : { pinIds: [] }
      // First batch (64 pins) succeeds on the backend. Second batch (the 65th pin) fails at the
      // network/transport level -- a call that rejects outright, not a per-pinId `outcome: 'failed'`.
      if (releaseCallCount === 1) {
        return Response.json({
          results: body.pinIds.map((pinId) => ({ pinId, outcome: 'released' as const })),
        })
      }
      throw new Error('network error')
    }
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetcher)
  vi.resetModules()

  await mountAdmin()
  await vi.waitFor(() => expect(document.getElementById('orphan-pins')).toHaveProperty('hidden', false))

  document.getElementById('orphan-pins-release-all')?.click()
  await vi.waitFor(() =>
    expect(document.getElementById('plugin-confirm-title')?.textContent).toContain('全部孤儿 pin'),
  )
  document.getElementById('plugin-confirm-action')?.click()

  await vi.waitFor(() => expect(releaseCallCount).toBe(2))
  await vi.waitFor(() => expect(document.getElementById('admin-notice')?.dataset.kind).toBe('error'))

  // The 64 pins in the first batch were genuinely released on the backend; they must be reflected
  // as released in the UI regardless of the second batch's failure.
  expect(document.getElementById('orphan-pins-list')?.textContent ?? '').not.toContain('pin-0')
  expect(document.getElementById('plugin-confirm-action')).toHaveProperty('disabled', false)
})

// Preservation: when the very first batch call fails outright, nothing has been released yet, so
// nothing should be removed from the list, and the failure must surface as an error.
it('removes nothing and surfaces the error when the first batch call fails outright', async () => {
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin.js"></script>', '')
  history.replaceState(null, '', '/admin/plugins#pins-batch-first-fail-token')
  const orphans: RuntimePinDescriptor[] = Array.from({ length: 65 }, (_, index) => ({
    pinId: `pin-${index}`,
    purpose: 'candidate',
    packageId: 'acme/plugin',
    version: '1.0.0',
    snapshotId: `snap-${index}`,
    operationId: `op-${index}`,
  }))
  let releaseCallCount = 0
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith('/session')) return new Response('{}', { status: 200 })
    if (url.endsWith('/context')) return Response.json(pinsContext())
    if (url.endsWith('/list')) return Response.json({ packages: [] })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans })
    if (url.endsWith('/pins/release')) {
      releaseCallCount++
      throw new Error('network error')
    }
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetcher)
  vi.resetModules()

  await mountAdmin()
  await vi.waitFor(() => expect(document.getElementById('orphan-pins')).toHaveProperty('hidden', false))

  document.getElementById('orphan-pins-release-all')?.click()
  await vi.waitFor(() =>
    expect(document.getElementById('plugin-confirm-title')?.textContent).toContain('全部孤儿 pin'),
  )
  document.getElementById('plugin-confirm-action')?.click()

  await vi.waitFor(() => expect(releaseCallCount).toBe(1))
  await vi.waitFor(() => expect(document.getElementById('admin-notice')?.dataset.kind).toBe('error'))

  expect(document.getElementById('orphan-pins')).toHaveProperty('hidden', false)
  expect(document.getElementById('orphan-pins-list')?.textContent ?? '').toContain('pin-0')
  expect(document.getElementById('orphan-pins-list')?.textContent ?? '').toContain('pin-64')
  expect(document.getElementById('plugin-confirm-action')).toHaveProperty('disabled', false)
})

// Preservation: the "N pins no longer orphaned" notice must total skips across every batch of a
// release-all run, not just the last batch applied -- otherwise fixing the accumulation bug above
// by applying each chunk's results immediately would silently regress this aggregate count.
it('aggregates skipped-no-longer-orphaned counts across successful batches into one notice', async () => {
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin.js"></script>', '')
  history.replaceState(null, '', '/admin/plugins#pins-batch-skip-token')
  const orphans: RuntimePinDescriptor[] = Array.from({ length: 65 }, (_, index) => ({
    pinId: `pin-${index}`,
    purpose: 'candidate',
    packageId: 'acme/plugin',
    version: '1.0.0',
    snapshotId: `snap-${index}`,
    operationId: `op-${index}`,
  }))
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/session')) return new Response('{}', { status: 200 })
    if (url.endsWith('/context')) return Response.json(pinsContext())
    if (url.endsWith('/list')) return Response.json({ packages: [] })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans })
    if (url.endsWith('/pins/release')) {
      const body = init?.body ? (JSON.parse(String(init.body)) as { pinIds: string[] }) : { pinIds: [] }
      // Each chunk contributes exactly one skip (its first pin); the rest release normally.
      return Response.json({
        results: body.pinIds.map((pinId, index) => ({
          pinId,
          outcome: index === 0 ? ('skipped-no-longer-orphaned' as const) : ('released' as const),
        })),
      })
    }
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetcher)
  vi.resetModules()

  await mountAdmin()
  await vi.waitFor(() => expect(document.getElementById('orphan-pins')).toHaveProperty('hidden', false))

  document.getElementById('orphan-pins-release-all')?.click()
  await vi.waitFor(() =>
    expect(document.getElementById('plugin-confirm-title')?.textContent).toContain('全部孤儿 pin'),
  )
  document.getElementById('plugin-confirm-action')?.click()

  await vi.waitFor(() =>
    expect(document.getElementById('orphan-pins-status')?.textContent).toContain('2 个 pin 已不再是孤儿'),
  )
})

it('shows qualified tree desired vs actual and does not treat diagnostics as actual', async () => {
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin-standalone.js"></script>', '')
  history.replaceState(null, '', '/admin/plugins#tree-actual-token')
  const digest = `sha256-${'a'.repeat(64)}`
  let actual = false
  const reloads: string[] = []
  const originalReload = location.reload.bind(location)
  Object.defineProperty(location, 'reload', {
    configurable: true,
    value: () => {
      reloads.push('reload')
    },
  })
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith('/session')) return new Response('{}', { status: 200 })
    if (url.endsWith('/context'))
      return Response.json({
        profile: 'local-dev',
        clientId: 'tree-page-test',
        permissions: ['packages.read'],
        readOnly: false,
        authScope: 'auth.tree-page-test',
        features: Object.values(ADMIN_FEATURES),
      })
    if (url.endsWith('/tree/list'))
      return Response.json({
        actual,
        pending: !actual,
        desiredDigest: digest,
        failurePhase: actual ? undefined : 'health',
      })
    if (url.endsWith('/list')) return Response.json({ packages: [] })
    if (url.endsWith('/surfaces')) return Response.json({ surfaces: [] })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans: [] })
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetcher)
  const mounted = await mountAdmin()
  await vi.waitFor(() =>
    expect(document.getElementById('plugin-tree-status')?.textContent).toContain('实际待资格化'),
  )
  const first = document.getElementById('plugin-tree-status')?.textContent ?? ''
  expect(first).toContain(`期望 ${digest}`)
  expect(first).toContain('诊断阶段 health')
  expect(first).not.toContain('实际已对齐')
  actual = true
  await mounted.reload()
  await vi.waitFor(() =>
    expect(document.getElementById('plugin-tree-status')?.textContent).toContain('实际已对齐'),
  )
  expect(document.getElementById('plugin-tree-status')?.textContent).not.toContain('诊断阶段')
  expect(reloads).toEqual([])
  Object.defineProperty(location, 'reload', { configurable: true, value: originalReload })
})

it('recovers a dropped tree_changed notice by polling tree/list without a page reload', async () => {
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin-standalone.js"></script>', '')
  history.replaceState(null, '', '/admin/plugins#tree-poll-token')
  const digest = `sha256-${'b'.repeat(64)}`
  let treeCalls = 0
  const reloads: string[] = []
  const originalReload = location.reload.bind(location)
  Object.defineProperty(location, 'reload', {
    configurable: true,
    value: () => {
      reloads.push('reload')
    },
  })
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith('/session')) return new Response('{}', { status: 200 })
    if (url.endsWith('/context'))
      return Response.json({
        profile: 'local-dev',
        clientId: 'tree-poll-test',
        permissions: ['packages.read'],
        readOnly: false,
        authScope: 'auth.tree-poll-test',
        features: Object.values(ADMIN_FEATURES),
      })
    if (url.endsWith('/tree/list')) {
      treeCalls += 1
      const actual = treeCalls > 1
      return Response.json({
        actual,
        pending: !actual,
        desiredDigest: digest,
        failurePhase: actual ? undefined : 'health',
      })
    }
    if (url.endsWith('/list')) return Response.json({ packages: [] })
    if (url.endsWith('/surfaces')) return Response.json({ surfaces: [] })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans: [] })
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetcher)
  await mountAdmin()
  await vi.waitFor(() =>
    expect(document.getElementById('plugin-tree-status')?.textContent).toContain('实际待资格化'),
  )
  expect(document.getElementById('plugin-tree-status')?.textContent).toContain('诊断阶段 health')
  await vi.waitFor(
    () => expect(document.getElementById('plugin-tree-status')?.textContent).toContain('实际已对齐'),
    { timeout: 4_000 },
  )
  expect(document.getElementById('plugin-tree-status')?.textContent).not.toContain('诊断阶段')
  expect(treeCalls).toBeGreaterThan(1)
  expect(reloads).toEqual([])
  Object.defineProperty(location, 'reload', { configurable: true, value: originalReload })
})

it('closes an open detail dialog so disable and rollback confirms can show', async () => {
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin-standalone.js"></script>', '')
  history.replaceState(null, '', '/admin/plugins#disable-confirm-token')
  const integrity = `sha256-${'c'.repeat(64)}`
  const installed: PackageInstalledDescriptor = {
    id: '@agnes-examples/hot-tool',
    version: '1.0.0',
    source: { type: 'file', ref: 'file:./plugin-v1' },
    integrity,
    trusted: true,
    desired: 'enabled',
    actual: 'running',
    actualVersion: '1.0.0',
    actualIntegrity: integrity,
    cleanupPending: false,
    rollbackTarget: {
      version: '0.9.0',
      integrity: `sha256-${'d'.repeat(64)}`,
      capabilityHash: 'e'.repeat(64),
    },
    contributions: [],
    blockers: [],
    capabilityHash: 'e'.repeat(64),
  }
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith('/session')) return new Response('{}', { status: 200 })
    if (url.endsWith('/context'))
      return Response.json({
        profile: 'local-dev',
        clientId: 'disable-confirm-test',
        permissions: [
          'packages.read',
          'packages.install',
          'packages.trust',
          'packages.activate',
          'packages.remove',
        ],
        readOnly: false,
        authScope: 'auth.disable-confirm-test',
        features: Object.values(ADMIN_FEATURES),
      })
    if (url.endsWith('/list')) return Response.json({ packages: [installed] })
    if (url.endsWith('/tree/list')) return Response.json({ actual: true, pending: false })
    if (url.endsWith('/surfaces')) return Response.json({ surfaces: [] })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans: [] })
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetcher)
  await mountAdmin()
  await vi.waitFor(() => expect(document.querySelector('#plugin-list button[role="switch"]')).not.toBeNull())
  document.querySelector<HTMLElement>('.plugin-row')?.click()
  await vi.waitFor(() => expect(document.getElementById('plugin-detail')?.hasAttribute('open')).toBe(true))
  const rollback = [...document.querySelectorAll<HTMLButtonElement>('#plugin-detail button')].find((button) =>
    button.textContent?.startsWith('回滚到'),
  )
  expect(rollback?.disabled).toBe(false)
  document.querySelector<HTMLButtonElement>('#plugin-list button[role="switch"]')?.click()
  await vi.waitFor(() => expect(document.getElementById('plugin-confirm')?.hasAttribute('open')).toBe(true))
  expect(document.getElementById('plugin-confirm-title')?.textContent).toContain('请求停用')
  expect(document.getElementById('plugin-detail')?.hasAttribute('open')).toBe(false)
})
