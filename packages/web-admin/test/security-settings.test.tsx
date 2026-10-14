/** @vitest-environment happy-dom */
import { SettingsSubpageFrame } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AutoReviewPanel } from '../src/settings/auto-review.js'
import { PermissionDefaults } from '../src/settings/permission-defaults.js'

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
  expect((writes.at(-1)?.overrides as { tool: string }[]).map((rule) => rule.tool)).toEqual(['write'])
  await click(host, '[data-testid="auto-review-clear-overrides"]')
  expect(writes.at(-1)?.overrides).toEqual([])
  expect(host.textContent).not.toMatch(/saved/i)
})

it('picks the default permission from three cards, confirms full access, and offers plugin presets in one row', async () => {
  const saves: unknown[] = []
  let defaults: Record<string, unknown> = { preset: 'workspace-write' }
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/admin/api/loops') return Response.json({ revision: 3, defaults, loops: [] })
    if (url === '/admin/api/composition') return Response.json({ preset: 'workspace-write' })
    if (url === '/admin/api/defaults') {
      const body = JSON.parse(String(init?.body))
      saves.push(body)
      defaults = body.defaults
      return Response.json({ revision: 4, defaults })
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
      available: ['read-only', 'workspace-write', 'full-access', 'ptc'],
      fetcher: fetcher as unknown as typeof fetch,
    }),
  )
  expect(host.querySelectorAll('.agnes-settings-modes input[type="radio"]')).toHaveLength(3)
  expect(
    host.querySelector<HTMLInputElement>('[data-testid="security-workspace-write"] input')?.checked,
  ).toBe(true)
  await click(host, '[data-testid="security-read-only"] input')
  expect(saves.at(-1)).toEqual({ revision: 3, defaults: { preset: 'read-only' } })
  // Full access asks first.
  await click(host, '[data-testid="security-full-access"] input')
  expect(saves).toHaveLength(1)
  await click(document, '[data-testid="security-full-confirm"]')
  expect(saves.at(-1)).toEqual({ revision: 4, defaults: { preset: 'full-access' } })
  // A plugin's own preset is chosen from 「更多预设」.
  await act(async () => {
    const more = host.querySelector<HTMLSelectElement>('[data-testid="security-more-presets"]')!
    more.value = 'ptc'
    more.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(saves.at(-1)).toEqual({ revision: 4, defaults: { preset: 'ptc' } })
})
