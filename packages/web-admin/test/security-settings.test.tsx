/** @vitest-environment happy-dom */
import { SettingsSubpageFrame } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginAdminApi } from '../src/admin/plugins/api.js'
import { SessionDefaultsPanel } from '../src/admin/plugins/session-defaults-panel.js'
import { AutoReviewPanel } from '../src/settings/auto-review.js'
import { settingsCatalog } from '../src/settings/locales.js'
import { PermissionDefaults } from '../src/settings/permission-defaults.js'
import { SecurityStatusPanel } from '../src/settings/security-status.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})
async function mount(element: ReturnType<typeof createElement>) {
  const host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root?.render(createElement(SettingsSubpageFrame, { header: null }, element)))
  await act(async () => {})
  return host
}
const click = async (host: ParentNode, selector: string) =>
  act(async () => host.querySelector<HTMLElement>(selector)?.click())

it('saves the auto review rules as chips, toggles, a segment and second presets, and removes approval rules', async () => {
  const hash = (char: string) => char.repeat(64)
  let stored: Record<string, unknown> = {
    enabled: false,
    overrides: [
      { tool: 'shell', scopeHash: hash('a'), decision: 'allow', risk: 'low' },
      { tool: 'write', scopeHash: hash('b'), decision: 'deny', risk: 'medium' },
    ],
  }
  const writes: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/auto-review') {
        if (init?.method === 'POST') {
          stored = JSON.parse(String(init.body))
          writes.push(stored)
        }
        return Response.json(stored)
      }
      if (url.includes('context'))
        return Response.json({ profile: 'local-dev', clientId: 'admin', permissions: [], readOnly: false })
      return Response.json({ revision: 1, slots: {}, modelAdapters: [] })
    }),
  )
  const host = await mount(createElement(AutoReviewPanel, { canSave: true }))
  await click(host, '[data-testid="auto-review-enabled"]')
  expect(writes.at(-1)).toMatchObject({ enabled: true })
  expect(host.querySelector('[data-testid="auto-review-overrides"]')?.textContent).toContain('2 rule(s)')
  await click(host, '[data-testid="auto-review-customize"]')
  const tool = host.querySelector<HTMLInputElement>('[data-testid="auto-review-tools"] input')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(tool, 'shell')
    tool?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => tool?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(writes.at(-1)).toMatchObject({ eligibleTools: ['shell'] })
  const [read] = host.querySelectorAll<HTMLButtonElement>('[data-testid="auto-review-categories"] button')
  await act(async () => read?.click())
  expect(writes.at(-1)).toMatchObject({ eligibleCategories: ['read'] })
  await click(host, '[data-testid="auto-review-risk"] input[value="medium"]')
  expect(writes.at(-1)).toMatchObject({ maxRisk: 'medium' })
  // The timeout is chosen in seconds and stored in milliseconds.
  await act(async () => {
    const timeout = host.querySelector<HTMLSelectElement>('[data-testid="auto-review-timeoutMs"]')!
    timeout.value = '30000'
    timeout.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(writes.at(-1)).toMatchObject({ timeoutMs: 30_000 })
  // Back, then into the approval rules: one removed, then all cleared.
  await click(host, '[data-testid="settings-subpage-back"]')
  await click(host, '[data-testid="auto-review-overrides"]')
  await click(host, '[data-testid="auto-review-remove-override"]')
  expect(writes.at(-1)?.overrides).toEqual([
    { tool: 'write', scopeHash: hash('b'), decision: 'deny', risk: 'medium' },
  ])
  await click(host, '[data-testid="auto-review-clear-overrides"]')
  expect(writes.at(-1)?.overrides).toEqual([])
  expect(host.textContent).not.toMatch(/saved/i)
})

const presets = [
  { id: 'standard', isDefault: true },
  { id: 'ptc', isDefault: false },
]
const permissions = ['read-only', 'workspace-write', 'full-access'].map((id) => ({
  id,
  isDefault: id === 'workspace-write',
}))

it.each(['read-only', 'full-access'])(
  'does not select a catalog or composition fallback while saved permission %s is loading',
  async (permission) => {
    let respond: (response: Response) => void = () => undefined
    const defaults = new Promise<Response>((resolve) => {
      respond = resolve
    })
    const fetcher = async (url: string) => {
      if (url === '/admin/api/defaults') return defaults
      if (url === '/admin/api/composition') return Response.json({ permission: 'workspace-write' })
      return Response.json({
        profile: 'local-dev',
        clientId: 'admin',
        permissions: ['packages.activate'],
        readOnly: false,
      })
    }
    const host = await mount(
      createElement(PermissionDefaults, {
        presets,
        permissions,
        fetcher: fetcher as typeof fetch,
      }),
    )
    expect(host.querySelectorAll('input[type="radio"]:checked')).toHaveLength(0)
    expect(host.querySelectorAll('input[type="radio"]:enabled')).toHaveLength(0)
    await act(async () => {
      respond(Response.json({ revision: 3, defaults: { permission } }))
    })
    expect(
      host.querySelector<HTMLInputElement>(`[data-testid="security-${permission}"] input`)?.checked,
    ).toBe(true)
    expect(host.querySelectorAll('input[type="radio"]:checked')).toHaveLength(1)
  },
)

it('picks the default permission from three cards, confirms full access, and offers plugin presets in one row', async () => {
  const saves: unknown[] = []
  let defaults: Record<string, unknown> = { permission: 'workspace-write' }
  let revision = 3
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/admin/api/defaults' && init?.method !== 'PUT')
      return Response.json({ revision, defaults, loops: [] })
    if (url === '/admin/api/composition') return Response.json({ preset: 'standard' })
    if (url === '/admin/api/defaults') {
      const body = JSON.parse(String(init?.body))
      saves.push(body)
      defaults = body.defaults
      revision = 4
      return Response.json({ revision, defaults })
    }
    return Response.json({
      profile: 'local-dev',
      clientId: 'admin',
      permissions: ['packages.activate'],
      readOnly: false,
    })
  })
  vi.stubGlobal('fetch', fetcher)
  const host = await mount(
    createElement(PermissionDefaults, {
      presets,
      permissions,
      fetcher: fetcher as unknown as typeof fetch,
    }),
  )
  expect(host.querySelectorAll('.agnes-settings-modes input[type="radio"]')).toHaveLength(3)
  expect(host.querySelector('.agnes-settings-modes .appearance-option-hint')?.textContent).toBe(
    'Can read files and view public webpages. Doesn’t change files or run commands.',
  )
  expect(
    host.querySelector<HTMLInputElement>('[data-testid="security-workspace-write"] input')?.checked,
  ).toBe(true)
  await click(host, '[data-testid="security-read-only"] input')
  expect(saves.at(-1)).toEqual({ revision: 3, defaults: { permission: 'read-only' } })
  // Full access asks first.
  await click(host, '[data-testid="security-full-access"] input')
  expect(saves).toHaveLength(1)
  await click(document, '[data-testid="security-full-confirm"]')
  expect(saves.at(-1)).toEqual({ revision: 4, defaults: { permission: 'full-access' } })
  // Another preset is chosen from 「更多预设」 and keeps the permission.
  await act(async () => {
    const more = host.querySelector<HTMLSelectElement>('[data-testid="security-more-presets"]')!
    more.value = 'ptc'
    more.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(saves.at(-1)).toEqual({ revision: 4, defaults: { permission: 'full-access', preset: 'ptc' } })
})

it('names an automatic fast reviewer instead of calling it unset, and still warns for an empty verifier', async () => {
  let auto: Record<string, unknown> = { modelSlot: 'fast' }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/auto-review') {
        if (init?.method === 'POST') auto = JSON.parse(String(init.body))
        return Response.json(auto)
      }
      if (url === '/admin/api/model-adapters') return Response.json({ modelAdapters: [] })
      if (url === '/admin/api/model-slots')
        return Response.json({
          revision: 1,
          slots: { verifier: null },
          // The fast slot is unset, so it follows the default account's model.
          auto: { fast: { accountId: 'agnes', route: 'agnes', model: 'agnes-pro' } },
          canSave: true,
        })
      return Response.json({ profile: 'local-dev', clientId: 'admin', permissions: [], readOnly: false })
    }),
  )
  const host = await mount(createElement(AutoReviewPanel, { canSave: true }))
  await click(host, '[data-testid="auto-review-customize"]')
  await act(async () => {})
  expect(host.querySelector('#auto-review-model option[value="fast"]')?.textContent).toContain(
    'Automatic · agnes-pro',
  )
  expect(host.querySelector('[data-testid="auto-review-slot-status"]')).toBeNull()
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>('#auto-review-model')!
    select.value = 'verifier'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  // The verifier is off (null): reviews come to the person, and the page says so.
  expect(host.querySelector('[data-testid="auto-review-slot-status"]')).not.toBeNull()
})

it('rereads the defaults on a revision conflict, shows the stored preset, and retries on the new revision', async () => {
  const saves: { revision: number; defaults: Record<string, unknown> }[] = []
  let revision = 3
  let conflictOnce = true
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/admin/api/defaults' && init?.method !== 'PUT')
      return Response.json({ revision, defaults: { permission: 'workspace-write' }, loops: [] })
    if (url === '/admin/api/composition') return Response.json({ preset: 'standard' })
    if (url === '/admin/api/defaults') {
      const body = JSON.parse(String(init?.body))
      saves.push(body)
      if (conflictOnce) {
        // Another window saved first.
        conflictOnce = false
        revision = 7
        return Response.json({ error: { code: 'CONFIG_REVISION_CONFLICT' } }, { status: 409 })
      }
      return Response.json({ revision: revision + 1, defaults: body.defaults })
    }
    return Response.json({
      profile: 'local-dev',
      clientId: 'admin',
      permissions: ['packages.activate'],
      readOnly: false,
    })
  })
  vi.stubGlobal('fetch', fetcher)
  const host = await mount(
    createElement(PermissionDefaults, {
      presets,
      permissions,
      fetcher: fetcher as unknown as typeof fetch,
    }),
  )
  await click(host, '[data-testid="security-read-only"] input')
  await act(async () => {})
  expect(saves.at(-1)?.revision).toBe(3)
  // The stored value stays selected; the note names it and the choice that was not saved.
  expect(host.querySelector('[data-testid="security-default-conflict"]')?.textContent).toContain(
    'Default permissions were just changed elsewhere to “Edit workspace”. Your choice “Read only” was not saved.',
  )
  expect(
    host.querySelector<HTMLInputElement>('[data-testid="security-workspace-write"] input')?.checked,
  ).toBe(true)
  expect(host.querySelector<HTMLInputElement>('[data-testid="security-read-only"] input')?.checked).toBe(
    false,
  )
  await click(host, '[data-testid="security-default-retry"]')
  expect(saves.at(-1)).toEqual({ revision: 7, defaults: { permission: 'read-only' } })
  expect(host.querySelector('[data-testid="security-default-conflict"]')).toBeNull()
  // Defaults saved elsewhere are read again.
  const reads = fetcher.mock.calls.filter(([url]) => url === '/admin/api/defaults').length
  await act(async () => window.dispatchEvent(new CustomEvent('agnes:session-configuration-changed')))
  await act(async () => {})
  expect(fetcher.mock.calls.filter(([url]) => url === '/admin/api/defaults').length).toBeGreaterThan(reads)
})

it('keeps the last auto review switch when an earlier save is slower (B01, one write at a time)', async () => {
  let stored: Record<string, unknown> = { enabled: false }
  const posts: Record<string, unknown>[] = []
  let releaseFirst: (() => void) | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/admin/api/auto-review') {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body))
          posts.push(body)
          // The first save is slow; nothing else may be sent until it returns.
          if (posts.length === 1) await new Promise<void>((resolve) => (releaseFirst = resolve))
          stored = body
        }
        return Response.json(stored)
      }
      return Response.json({ revision: 1, slots: {}, modelAdapters: [], canSave: true })
    }),
  )
  const host = await mount(createElement(AutoReviewPanel, { canSave: true }))
  await click(host, '[data-testid="auto-review-enabled"]')
  await click(host, '[data-testid="auto-review-enabled"]')
  expect(posts).toHaveLength(1)
  await act(async () => releaseFirst?.())
  await act(async () => {})
  await act(async () => {})
  // The newest choice (off) is written last and is what the server keeps.
  expect(posts.at(-1)).toMatchObject({ enabled: false })
  expect(stored).toMatchObject({ enabled: false })
  expect(
    host.querySelector<HTMLElement>('[data-testid="auto-review-enabled"]')?.getAttribute('aria-checked'),
  ).toBe('false')
})

const text = (key: string, params?: Record<string, string | number>) =>
  Object.entries(params ?? {}).reduce(
    (value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)),
    settingsCatalog.en?.[key] ?? key,
  )
const policy = (id: string, approvalPolicy: string, networkMode: 'deny' | 'unrestricted') => ({
  id,
  level: 'L1' as const,
  required: true,
  onUnavailable: 'deny' as const,
  approvalPolicy,
  networkMode,
})
it('lists permission levels apart from presets and shows each session’s permission beside its preset', async () => {
  const workspace = {
    sessionId: 'session-a',
    path: '/synthetic',
    preset: 'minimal',
    permission: 'full-access',
    provider: 'local',
    state: 'ready' as const,
  }
  const status = {
    platform: { os: 'linux' as const, l1: { level: 'full' as const, scope: ['file' as const] } },
    presetPolicies: [policy('standard', 'default', 'deny'), policy('inspect', 'read-only', 'deny')],
    permissionPolicies: [
      policy('read-only', 'read-only', 'deny'),
      policy('full-access', 'full-access', 'unrestricted'),
    ],
    workspaces: [workspace],
  }
  const details = await mount(createElement(SecurityStatusPanel, { status, t: text, view: 'details' }))
  const rows = (id: string) =>
    [...details.querySelectorAll(`[data-testid="${id}"] tbody tr`)].map((row) => row.firstChild?.textContent)
  expect(rows('permission-level-status')).toEqual(['Read only', 'Full access'])
  expect(details.querySelector('[data-testid="permission-level-status"]')?.textContent).toContain(
    text('network.unrestricted'),
  )
  // Recipe rows and permission rows have distinct names.
  expect(rows('permission-preset-status')).toEqual(['Standard', 'inspect'])
  expect(details.querySelector('[data-testid="workspace-permission"]')?.textContent).toBe('Full access')
  await act(async () => root?.unmount())
  const summary = await mount(createElement(SecurityStatusPanel, { status, t: text }))
  await click(summary, '[data-testid="sandbox-isolation"]')
  expect(
    summary.querySelector('[data-testid="workspace-sandbox-status"] .agnes-settings-item-description')
      ?.textContent,
  ).toBe('Minimal tools · Full access · Local sandbox')
  // An older Host reports no permission levels or session permission: the one table stays as it was.
  await act(async () => root?.unmount())
  const { permissionPolicies: _levels, ...older } = status
  const { permission: _level, ...olderWorkspace } = workspace
  const legacy = await mount(
    createElement(SecurityStatusPanel, {
      status: { ...older, workspaces: [olderWorkspace] },
      t: text,
      view: 'details',
    }),
  )
  expect(legacy.querySelector('[data-testid="permission-level-status"]')).toBeNull()
  expect(
    [...legacy.querySelectorAll('[data-testid="permission-preset-status"] tbody tr')].map(
      (row) => row.firstChild?.textContent,
    ),
  ).toEqual(['Standard', 'inspect'])
  expect(legacy.querySelector('[data-testid="workspace-permission"]')).toBeNull()
})

it('keeps the saved permission and preset when new-session defaults are saved', async () => {
  const loop = { id: 'workflow', version: '1.0.0', sourcePackage: '@acme/workflow', capabilities: [] }
  const adapter = {
    ...loop,
    id: 'adapter',
    wireApi: 'openai-chat',
    capabilities: { imageInput: false, tools: true, streaming: true },
    models: [{ id: 'model' }],
  }
  const defaults = {
    preset: 'minimal',
    permission: 'full-access',
    providers: {
      loop: { provider: loop.id, version: loop.version },
      'model-adapter': { provider: adapter.id, version: adapter.version },
    },
    model: 'model',
  }
  const saves: unknown[] = []
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/loops')) return Response.json({ loops: [loop], revision: 4, defaults })
    if (String(url).endsWith('/model-adapters')) return Response.json({ modelAdapters: [adapter] })
    if (String(url).endsWith('/composition')) return Response.json({})
    const body = JSON.parse(String(init?.body))
    saves.push(body)
    return Response.json({ revision: 5, defaults: body.defaults })
  })
  const api = new PluginAdminApi(
    { profile: 'local-dev', clientId: 'admin', permissions: ['packages.activate'], readOnly: false },
    fetcher,
  )
  const host = await mount(createElement(SessionDefaultsPanel, { api, canSave: true, t: text }))
  await click(host, '[data-testid="session-default-loop"]')
  await click(host, '[data-testid="session-loop-follow"]')
  await act(async () => {})
  const { loop: _loop, ...providers } = defaults.providers
  expect(saves).toEqual([{ revision: 4, defaults: { ...defaults, providers } }])
})
