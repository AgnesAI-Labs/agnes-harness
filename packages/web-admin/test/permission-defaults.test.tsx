/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PermissionDefaults } from '../src/settings/permission-defaults.js'

import { securityUxCatalog } from '../src/settings/security-locale.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => document.body.replaceChildren())
const recipes = [
  { id: 'standard', isDefault: true },
  { id: 'minimal', isDefault: false },
  { id: 'ptc', isDefault: false },
]
const levels = [
  { id: 'read-only', isDefault: false },
  { id: 'workspace-write', isDefault: true },
  { id: 'full-access', isDefault: false },
]
const context = (readOnly = false, permissions = ['packages.read', 'packages.activate']) =>
  Response.json({
    profile: 'local-dev',
    clientId: 'fixture',
    authScope: 'auth.fixture',
    permissions,
    readOnly,
  })
const status = (level: 'full' | 'partial' | 'unavailable' | 'unprobed') => ({
  platform: { os: 'darwin', l1: { level, scope: level === 'full' ? ['file', 'process', 'network'] : [] } },
  presetPolicies: [],
  workspaces: [],
})
async function render(props: Parameters<typeof PermissionDefaults>[0]) {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  await act(async () => root.render(createElement(PermissionDefaults, props)))
  return { host, unmount: () => act(async () => root.unmount()) }
}
const pickIn = (host: ParentNode) => (id: string) =>
  host.querySelector<HTMLInputElement>(`[data-testid="security-${id}"] input`)!
const recipeSelect = (host: ParentNode) =>
  host.querySelector<HTMLSelectElement>('[data-testid="security-more-presets"]')
async function pickRecipe(host: ParentNode, value: string) {
  await act(async () => {
    const select = recipeSelect(host)
    if (!select) throw new Error('no preset select')
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it.each([false, true])(
  'saves the permission and the preset as separate fields, confirms full access and respects read-only=%s',
  async (readOnly) => {
    let snapshot: { revision: number; defaults: Record<string, unknown> } = {
      revision: 4,
      defaults: {
        preset: 'minimal',
        permission: 'workspace-write',
        providers: {
          loop: { provider: 'default-loop', version: '1.0.0' },
          'model-adapter': { provider: 'default-model', version: '1.0.0' },
        },
        model: 'test',
      },
    }
    const writes: unknown[] = []
    const notified = vi.fn()
    window.addEventListener('agnes:session-configuration-changed', notified)
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/context')) return context(readOnly)
      if (String(url).endsWith('/composition'))
        return Response.json({ preset: 'minimal', permission: 'workspace-write' })
      if (init?.method === 'PUT') {
        const input = JSON.parse(String(init.body))
        writes.push(input)
        snapshot = { revision: snapshot.revision + 1, defaults: input.defaults }
        return Response.json(snapshot)
      }
      return Response.json(snapshot)
    })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(createElement(PermissionDefaults, { presets: recipes, permissions: levels, fetcher })),
      )
      const pick = pickIn(host)
      expect(pick('workspace-write').checked).toBe(true)
      expect(recipeSelect(host)?.value).toBe('minimal')
      expect(pick('read-only').disabled).toBe(readOnly)
      expect(host.textContent).toContain('Only affects new sessions.')
      // A locked block says why instead of only greying out.
      expect(host.querySelector('[data-testid="security-default-locked"]')?.textContent ?? null).toBe(
        readOnly ? securityUxCatalog.en?.lockedReadOnly : null,
      )
      expect(host.querySelector('[data-testid="security-full-exceptions-toggle"]')).toBeNull()
      expect(host.textContent).toContain(
        'All actions are allowed automatically, including business sign-offs recorded as “Auto-confirmed under full access” with your identity. Questions that need your answer still ask.',
      )
      expect(pick('full-access').checked).toBe(false)
      expect(document.querySelector('[data-testid="security-full-confirm"]')).toBeNull()
      expect(writes).toEqual([])
      await act(async () => pick('read-only').click())
      if (readOnly) {
        expect(writes).toEqual([])
        expect(notified).not.toHaveBeenCalled()
        return
      }
      // The permission is its own field: the preset and the rest of the defaults are sent back as read.
      expect(writes).toEqual([
        { revision: 4, defaults: { ...snapshot.defaults, permission: 'read-only', preset: 'minimal' } },
      ])
      expect(pick('read-only').checked).toBe(true)
      await act(async () => pick('full-access').click())
      expect(writes).toHaveLength(1)
      expect(pick('full-access').checked).toBe(false)
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[data-testid="security-full-confirm"]')?.click(),
      )
      expect(writes[1]).toEqual({
        revision: 5,
        defaults: {
          preset: 'minimal',
          permission: 'full-access',
          providers: {
            loop: { provider: 'default-loop', version: '1.0.0' },
            'model-adapter': { provider: 'default-model', version: '1.0.0' },
          },
          model: 'test',
        },
      })
      expect(pick('full-access').checked).toBe(true)
      // The preset is chosen apart and keeps the permission; 「默认」 stores no preset at all.
      await pickRecipe(host, 'ptc')
      expect(writes[2]).toEqual({
        revision: 6,
        defaults: { ...(writes[1] as { defaults: object }).defaults, preset: 'ptc' },
      })
      await pickRecipe(host, '')
      const { preset: _cleared, ...unset } = (writes[1] as { defaults: Record<string, unknown> }).defaults
      expect(writes[3]).toEqual({ revision: 7, defaults: unset })
      expect(recipeSelect(host)?.value).toBe('')
      expect(pick('full-access').checked).toBe(true)
      expect(notified).toHaveBeenCalledTimes(4)
    } finally {
      window.removeEventListener('agnes:session-configuration-changed', notified)
      await act(async () => root.unmount())
    }
  },
)

it.each(['en', 'zh-CN'] as const)('describes default permission boundaries in %s', (locale) => {
  const copy = securityUxCatalog[locale]
  expect(copy?.['read-onlyHelp']).toContain(locale === 'en' ? 'public webpages' : '公开网页')
  expect(copy?.['workspace-writeHelp']).toContain(
    locale === 'en' ? 'Asks you before running commands' : '运行命令前先问你',
  )
  expect(copy?.['full-accessHelp']).toContain(
    locale === 'en' ? 'business sign-offs recorded as' : '完全访问下自动确认',
  )
})

it.each(['pending', 'failed'])(
  'shows saved defaults while composition is %s without loading loops',
  async (status) => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/context')) return context()
      if (url === '/admin/api/defaults')
        return Response.json({ revision: 4, defaults: { permission: 'workspace-write' } })
      if (url === '/admin/api/composition') {
        if (status === 'failed') throw new Error('catalog unavailable')
        return new Promise<Response>(() => {})
      }
      throw new Error('unexpected catalog request')
    })
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(createElement(PermissionDefaults, { presets: recipes, permissions: levels, fetcher })),
      )
      const choice = host.querySelector<HTMLInputElement>('[data-testid="security-workspace-write"] input')!
      expect(choice.checked).toBe(true)
      expect(choice.disabled).toBe(false)
      expect(fetcher.mock.calls.some(([url]) => url === '/admin/api/loops')).toBe(false)
    } finally {
      await act(async () => root.unmount())
    }
  },
)

it('keeps the selected recipe and permission independent when saving', async () => {
  const writes: unknown[] = []
  // Current saved defaults name both axes.
  let snapshot: { revision: number; defaults: Record<string, unknown> } = {
    revision: 2,
    defaults: { preset: 'standard', permission: 'read-only' },
  }
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/context')) return context()
    if (String(url).endsWith('/composition')) return Response.json({})
    if (init?.method === 'PUT') {
      const input = JSON.parse(String(init.body))
      writes.push(input)
      snapshot = { revision: snapshot.revision + 1, defaults: input.defaults }
      return Response.json(snapshot)
    }
    return Response.json(snapshot)
  })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        createElement(PermissionDefaults, {
          permissions: levels,
          presets: [
            { id: 'standard', isDefault: true },
            { id: 'minimal', isDefault: false },
          ],
          fetcher,
        }),
      ),
    )
    const pick = pickIn(host)
    expect(pick('read-only').checked).toBe(true)
    expect([...(recipeSelect(host)?.options ?? [])].map((option) => [option.value, option.text])).toEqual([
      ['', 'Default (Standard)'],
      ['minimal', 'Minimal tools'],
    ])
    expect(host.textContent).toContain('Every tool the permission allows')
    await pickRecipe(host, 'minimal')
    expect(writes).toEqual([{ revision: 2, defaults: { permission: 'read-only', preset: 'minimal' } }])
    expect(host.textContent).toContain('Read tools only')
  } finally {
    await act(async () => root.unmount())
  }
})

it.each([
  ['the permission catalog', [{ id: 'standard', isDefault: true }], levels.slice(0, 2), ['full-access']],
  [
    'a missing permission catalog',
    [{ id: 'standard', isDefault: true }],
    undefined,
    ['read-only', 'workspace-write', 'full-access'],
  ],
] as const)('disables levels absent from %s', async (_source, presets, permissions, refused) => {
  const writes: unknown[] = []
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/context')) return context()
    if (String(url).endsWith('/composition')) return Response.json({})
    if (init?.method === 'PUT') writes.push(JSON.parse(String(init.body)))
    return Response.json({ revision: 1, defaults: {} })
  })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(PermissionDefaults, { presets, permissions, fetcher })))
    const pick = pickIn(host)
    for (const level of ['read-only', 'workspace-write', 'full-access'])
      expect(pick(level).disabled, level).toBe(refused.includes(level as never))
    // Only the catalog's default level reads as chosen when nothing is saved.
    expect(pick('workspace-write').checked).toBe(!!permissions)
    // A preset list with only the default recipe has nothing else to offer.
    expect(recipeSelect(host)).toBeNull()
    expect(writes).toEqual([])
  } finally {
    await act(async () => root.unmount())
  }
})

it.each([
  [undefined, 'Isolation status unknown'],
  [status('full'), 'Command isolation · In effect'],
  [status('partial'), 'Command isolation · Partly in effect'],
  [status('unavailable'), 'Command isolation · Unavailable'],
] as const)('states command isolation under each card (%#)', async (security, workspace) => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/context')
      ? context()
      : String(url).endsWith('/composition')
        ? Response.json({})
        : Response.json({ revision: 1, defaults: { permission: 'workspace-write' } }),
  )
  const { host, unmount } = await render({
    presets: recipes,
    permissions: levels,
    fetcher,
    ...(security ? { security } : {}),
  })
  const foot = (id: string) => host.querySelector(`[data-testid="security-${id}-isolation"]`)?.textContent
  expect(foot('read-only')).toBe('No commands')
  expect(foot('workspace-write')).toBe(workspace)
  expect(foot('full-access')).toBe('Commands not isolated')
  await unmount()
})

it('returns to the stored value when a save fails, names both, and retries the same choice', async () => {
  const writes: string[] = []
  let fail = true
  let stored = { revision: 1, defaults: { permission: 'workspace-write' } }
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/context')) return context()
    if (String(url).endsWith('/composition')) return Response.json({})
    if (init?.method === 'PUT') {
      const permission = JSON.parse(String(init.body)).defaults.permission
      writes.push(permission)
      if (fail) return Response.json({ error: 'boom' }, { status: 500 })
      stored = { revision: 2, defaults: { permission } }
    }
    return Response.json(stored)
  })
  const { host, unmount } = await render({ presets: recipes, permissions: levels, fetcher })
  const pick = pickIn(host)
  await act(async () => pick('read-only').click())
  expect(pick('workspace-write').checked).toBe(true)
  expect(pick('read-only').checked).toBe(false)
  const error = host.querySelector('[data-testid="security-default-failed"]')
  expect(error?.textContent).toContain('Couldn’t switch to “Read only”; it is still “Edit workspace”.')
  fail = false
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="security-default-retry"]')?.click(),
  )
  expect(writes).toEqual(['read-only', 'read-only'])
  expect(pick('read-only').checked).toBe(true)
  expect(host.querySelector('[data-testid="security-default-failed"]')).toBeNull()
  await unmount()
})

it.each([
  ['ghost', 'New sessions use the “ghost” profile'],
  ['ptc', null],
  ['default', 'New sessions use the “default” profile'],
] as const)(
  'names a stored %s preset above the cards only when the catalog lacks it',
  async (preset, note) => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/context')
        ? context()
        : String(url).endsWith('/composition')
          ? Response.json({})
          : Response.json({ revision: 1, defaults: { preset } }),
    )
    const { host, unmount } = await render({ presets: recipes, permissions: levels, fetcher })
    const shown = host.querySelector('[data-testid="security-default-other"]')?.textContent ?? null
    if (note === null) expect(shown).toBeNull()
    else expect(shown).toContain(note)
    await unmount()
  },
)

it('marks a card this profile does not offer and keeps its description', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/context')
      ? context(false, ['packages.read'])
      : String(url).endsWith('/composition')
        ? Response.json({})
        : Response.json({ revision: 1, defaults: { permission: 'workspace-write' } }),
  )
  const { host, unmount } = await render({
    presets: recipes,
    permissions: levels.slice(0, 2),
    fetcher,
  })
  const card = host.querySelector('[data-testid="security-full-access"]')!
  expect(card.textContent).toContain(securityUxCatalog.en?.['full-accessHelp'])
  expect(card.textContent).toContain('Unavailable in this profile')
  expect(host.querySelector('[data-testid="security-default-locked"]')?.textContent).toBe(
    securityUxCatalog.en?.lockedPermission,
  )
  await unmount()
})

it.each(['saved', 'failed', 'conflict'] as const)(
  'ignores a late %s save, including its cleanup, after a defaults refresh',
  async (outcome) => {
    let finishSave!: (response: Response) => void
    let finishRead!: (response: Response) => void
    let refresh = false
    let reads = 0
    let saveSignal: AbortSignal | null | undefined
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/context')) return context()
      if (String(url).endsWith('/composition')) return Response.json({})
      if (init?.method === 'PUT') {
        saveSignal = init.signal
        return new Promise((resolve) => {
          finishSave = resolve
        })
      }
      reads++
      if (refresh)
        return new Promise((resolve) => {
          finishRead = resolve
        })
      return Response.json({ revision: 4, defaults: { permission: 'workspace-write' } })
    }
    const { host, unmount } = await render({ presets: recipes, permissions: levels, fetcher })
    const notified = vi.fn()
    window.addEventListener('agnes:session-configuration-changed', notified)
    try {
      await act(async () => pickIn(host)('read-only').click())
      refresh = true
      await act(async () => window.dispatchEvent(new Event('agnes:session-configuration-changed')))
      notified.mockClear()
      expect(saveSignal?.aborted).toBe(true)
      await act(async () =>
        finishSave(
          outcome === 'saved'
            ? Response.json({ revision: 5, defaults: { permission: 'read-only' } })
            : Response.json({}, { status: outcome === 'conflict' ? 409 : 500 }),
        ),
      )
      expect(
        host.querySelector('[data-testid="security-default-permissions"]')?.getAttribute('aria-busy'),
      ).toBe('true')
      expect(host.querySelector('[data-testid="security-default-failed"]')).toBeNull()
      expect(notified).not.toHaveBeenCalled()
      expect(reads).toBe(2)
      await act(async () =>
        finishRead(Response.json({ revision: 6, defaults: { permission: 'full-access' } })),
      )
      expect(pickIn(host)('full-access').checked).toBe(true)
      expect(pickIn(host)('read-only').disabled).toBe(false)
    } finally {
      window.removeEventListener('agnes:session-configuration-changed', notified)
      await unmount()
    }
  },
)

it('locks refreshed defaults when the new permission check fails and an old save settles later', async () => {
  let refresh = false
  let denyContext = false
  let finish!: (response: Response) => void
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/context')) {
      if (denyContext) throw new Error('permission context unavailable')
      return context()
    }
    if (String(url).endsWith('/composition')) return Response.json({})
    if (init?.method === 'PUT')
      return new Promise((resolve) => {
        finish = resolve
      })
    return Response.json({ revision: refresh ? 6 : 4, defaults: { permission: 'workspace-write' } })
  }
  const { host, unmount } = await render({ presets: recipes, permissions: levels, fetcher })
  try {
    await act(async () => pickIn(host)('read-only').click())
    refresh = true
    denyContext = true
    await act(async () => window.dispatchEvent(new Event('agnes:session-configuration-changed')))
    expect(pickIn(host)('read-only').disabled).toBe(true)
    expect(host.querySelector('[data-testid="loadable-retry"]')).not.toBeNull()
    await act(async () => finish(Response.json({ revision: 5, defaults: { permission: 'read-only' } })))
    expect(pickIn(host)('read-only').disabled).toBe(true)
    expect(pickIn(host)('workspace-write').checked).toBe(true)
    expect(host.querySelector('[data-testid="security-default-failed"]')).toBeNull()
    denyContext = false
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="loadable-retry"]')?.click())
    expect(pickIn(host)('read-only').disabled).toBe(false)
    expect(host.querySelector('[data-testid="loadable-error"]')).toBeNull()
  } finally {
    await unmount()
  }
})
