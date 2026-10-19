/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PermissionDefaults } from '../src/settings/permission-defaults.js'

import { securityUxCatalog } from '../src/settings/security-locale.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => document.body.replaceChildren())

it.each([false, true])(
  'saves revision-aware defaults, confirms full access and respects read-only=%s',
  async (readOnly) => {
    let snapshot = {
      revision: 4,
      defaults: {
        preset: 'workspace-write',
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
      if (String(url).endsWith('/context'))
        return Response.json({
          profile: 'local-dev',
          clientId: 'fixture',
          authScope: 'auth.fixture',
          permissions: ['packages.read', 'packages.activate'],
          readOnly,
        })
      if (String(url).endsWith('/composition')) return Response.json({ preset: 'workspace-write' })
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
        root.render(
          createElement(PermissionDefaults, {
            available: ['read-only', 'workspace-write', 'full-access'],
            fetcher,
          }),
        ),
      )
      const pick = (id: string) =>
        host.querySelector<HTMLInputElement>(`[data-testid="security-${id}"] input`)!
      expect(pick('workspace-write').checked).toBe(true)
      expect(pick('read-only').disabled).toBe(readOnly)
      expect(host.textContent).toContain('Only affects new sessions.')
      // A locked block says why instead of only greying out.
      expect(host.querySelector('[data-testid="security-default-locked"]')?.textContent ?? null).toBe(
        readOnly ? securityUxCatalog.en?.lockedReadOnly : null,
      )
      expect(host.querySelector('[data-testid="security-full-exceptions-toggle"]')).toBeNull()
      expect(host.textContent).toContain('Everything is allowed automatically; no approval prompts')
      expect(pick('full-access').checked).toBe(false)
      expect(document.querySelector('[data-testid="security-full-confirm"]')).toBeNull()
      expect(writes).toEqual([])
      await act(async () => pick('read-only').click())
      if (readOnly) {
        expect(writes).toEqual([])
        expect(notified).not.toHaveBeenCalled()
        return
      }
      expect(writes).toEqual([{ revision: 4, defaults: { ...snapshot.defaults, preset: 'read-only' } }])
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
          preset: 'full-access',
          providers: {
            loop: { provider: 'default-loop', version: '1.0.0' },
            'model-adapter': { provider: 'default-model', version: '1.0.0' },
          },
          model: 'test',
        },
      })
      expect(pick('full-access').checked).toBe(true)
      expect(notified).toHaveBeenCalledTimes(2)
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
  expect(copy?.['full-accessHelp']).toContain(locale === 'en' ? 'no approval prompts' : '不再弹出审批')
})

it.each(['pending', 'failed'])(
  'shows saved defaults while composition is %s without loading loops',
  async (status) => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/context'))
        return Response.json({
          profile: 'local-dev',
          clientId: 'fixture',
          authScope: 'auth.fixture',
          permissions: ['packages.read', 'packages.activate'],
          readOnly: false,
        })
      if (url === '/admin/api/defaults')
        return Response.json({ revision: 4, defaults: { preset: 'workspace-write' } })
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
        root.render(
          createElement(PermissionDefaults, {
            available: ['read-only', 'workspace-write', 'full-access'],
            fetcher,
          }),
        ),
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
const all = ['read-only', 'workspace-write', 'full-access']

it.each([
  [undefined, 'Isolation status unknown'],
  [status('full'), 'Command isolation · In effect'],
  [status('partial'), 'Command isolation · Partly in effect'],
  [status('unavailable'), 'Command isolation · Unavailable'],
] as const)('states command isolation under each card (%#)', async (security, workspace) => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/context')
      ? context()
      : Response.json({ revision: 1, defaults: { preset: 'workspace-write' } }),
  )
  const { host, unmount } = await render({ available: all, fetcher, ...(security ? { security } : {}) })
  const foot = (id: string) => host.querySelector(`[data-testid="security-${id}-isolation"]`)?.textContent
  expect(foot('read-only')).toBe('No commands')
  expect(foot('workspace-write')).toBe(workspace)
  expect(foot('full-access')).toBe('Commands not isolated')
  await unmount()
})

it('returns to the stored value when a save fails, names both, and retries the same choice', async () => {
  const writes: string[] = []
  let fail = true
  let stored = { revision: 1, defaults: { preset: 'workspace-write' } }
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/context')) return context()
    if (init?.method === 'PUT') {
      const preset = JSON.parse(String(init.body)).defaults.preset
      writes.push(preset)
      if (fail) return Response.json({ error: 'boom' }, { status: 500 })
      stored = { revision: 2, defaults: { preset } }
    }
    return Response.json(stored)
  })
  const { host, unmount } = await render({ available: all, fetcher })
  const pick = (id: string) => host.querySelector<HTMLInputElement>(`[data-testid="security-${id}"] input`)!
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
  ['ptc', true, 'New sessions use the “Programmatic tools” profile'],
  ['standard', false, 'New sessions use the “Standard permissions” profile'],
  ['workspace-write', true, null],
] as const)('names a stored %s profile above the cards', async (preset, offered, note) => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/context') ? context() : Response.json({ revision: 1, defaults: { preset } }),
  )
  const { host, unmount } = await render({ available: offered ? [...all, 'ptc'] : all, fetcher })
  const shown = host.querySelector('[data-testid="security-default-other"]')?.textContent ?? null
  if (note === null) expect(shown).toBeNull()
  else expect(shown).toContain(note)
  expect(host.querySelectorAll('.agnes-settings-modes input:checked')).toHaveLength(note ? 0 : 1)
  await unmount()
})

it('marks a card this profile does not offer and keeps its description', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/context')
      ? context(false, ['packages.read'])
      : Response.json({ revision: 1, defaults: { preset: 'workspace-write' } }),
  )
  const { host, unmount } = await render({ available: ['read-only', 'workspace-write'], fetcher })
  const card = host.querySelector('[data-testid="security-full-access"]')!
  expect(card.textContent).toContain(securityUxCatalog.en?.['full-accessHelp'])
  expect(card.textContent).toContain('Unavailable in this profile')
  expect(host.querySelector('[data-testid="security-default-locked"]')?.textContent).toBe(
    securityUxCatalog.en?.lockedPermission,
  )
  await unmount()
})
