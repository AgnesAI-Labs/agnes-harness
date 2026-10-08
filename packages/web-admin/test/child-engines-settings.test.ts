/** @vitest-environment happy-dom */
import { type ChildEngineSettings, DISABLED_CHILD_ENGINES } from '@agnes/base/child-engines'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { type ChildEnginesClient, ChildEnginesPanel } from '../src/settings/child-engines.js'
import { settingsCatalog } from '../src/settings/locales.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
})

function client(effect: 'new-sessions' | 'restart-required' = 'new-sessions'): ChildEnginesClient & {
  saveChildEngines: ReturnType<typeof vi.fn>
} {
  const engines = structuredClone(DISABLED_CHILD_ENGINES)
  return {
    childEngines: vi.fn(async () => ({ revision: 4, engines })),
    saveChildEngines: vi.fn(async (input: { revision: number; engines: ChildEngineSettings }) => ({
      revision: input.revision + 1,
      engines: input.engines,
      effect,
    })),
  }
}

async function mount(canSave: boolean, api?: ChildEnginesClient) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  const t = (key: string) => settingsCatalog.en[key] ?? key
  await act(async () => root.render(createElement(ChildEnginesPanel, { api, canSave, t })))
  return host
}

it('requires an exact allowlist entry before enabling an engine', async () => {
  const api = client()
  const host = await mount(true, api)
  expect(host.querySelector('[data-testid="child-engine-codex-enabled"]')).not.toBeNull()
  expect(host.querySelector('[data-testid="child-engine-codex-capabilities"]')?.textContent).toContain(
    'Continuable: No',
  )
  expect(host.querySelector('[data-testid="child-engine-codex-capabilities"]')?.textContent).toContain(
    'Interrupt: Yes',
  )
  const enabled = host.querySelector<HTMLButtonElement>('[data-testid="child-engine-codex-enabled"]')
  expect(enabled?.getAttribute('role')).toBe('switch')
  await act(async () => enabled?.click())
  expect(enabled?.getAttribute('aria-checked')).toBe('true')
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="child-engine-save"]')?.click())
  expect(host.querySelector('[data-testid="child-engine-status"]')?.getAttribute('role')).toBe('alert')
  expect(api.saveChildEngines).not.toHaveBeenCalled()
  const allow = host.querySelector<HTMLTextAreaElement>('[data-testid="child-engine-codex-allow"]')
  await act(async () => {
    if (!allow) return
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    set?.call(allow, 'codex')
    allow.dispatchEvent(new Event('input', { bubbles: true }))
    allow.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="child-engine-save"]')?.click())
  expect(host.querySelector('[data-testid="child-engine-status"]')?.getAttribute('role')).toBe('status')
  expect(api.saveChildEngines).toHaveBeenCalledTimes(1)
  const saved = api.saveChildEngines.mock.calls[0]?.[0] as { engines: ChildEngineSettings }
  expect(saved.engines.codex).toMatchObject({ enabled: true, allow: ['codex'] })
  expect(host.querySelector('[data-testid="child-engine-document"]')?.textContent).toContain('"enabled":true')
})

it('shows ACP as continuable and keeps a read-only panel disabled', async () => {
  const host = await mount(false, client())
  expect(host.querySelector<HTMLButtonElement>('[data-testid="child-engine-save"]')?.disabled).toBe(true)
  const protocol = host.querySelector<HTMLSelectElement>('[data-testid="child-engine-sdk-protocol"]')
  expect(protocol?.disabled).toBe(true)
  const writable = await mount(true, client('restart-required'))
  const select = writable.querySelector<HTMLSelectElement>('[data-testid="child-engine-sdk-protocol"]')
  await act(async () => {
    if (!select) return
    select.value = 'acp'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(writable.querySelector('[data-testid="child-engine-sdk-capabilities"]')?.textContent).toContain(
    'Continuable: Yes',
  )
  for (const key of ['engines', 'engine.allowRequired', 'cap.toolFilter']) {
    expect(settingsCatalog.en[key]).toBeTruthy()
    expect(settingsCatalog['zh-CN'][key]).toBeTruthy()
  }
})
