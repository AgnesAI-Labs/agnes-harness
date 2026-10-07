/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { ChildEnginesPanel } from '../src/settings/child-engines.js'
import { settingsCatalog } from '../src/settings/locales.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
afterEach(async () => {
  sessionStorage.clear()
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
})

async function mount(canSave: boolean) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  const t = (key: string) => settingsCatalog.en[key] ?? key
  await act(async () => root.render(createElement(ChildEnginesPanel, { canSave, t })))
  return host
}

it('requires an exact allowlist entry before enabling an engine', async () => {
  const host = await mount(true)
  expect(host.querySelector('[data-testid="child-engine-codex-enabled"]')).not.toBeNull()
  expect(host.querySelector('[data-testid="child-engine-codex-capabilities"]')?.textContent).toContain(
    'Continuable: No',
  )
  expect(host.querySelector('[data-testid="child-engine-codex-capabilities"]')?.textContent).toContain(
    'Interrupt: Yes',
  )
  const enabled = host.querySelector<HTMLInputElement>('[data-testid="child-engine-codex-enabled"]')
  await act(async () => enabled?.click())
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="child-engine-save"]')?.click())
  expect(host.querySelector('[data-testid="child-engine-status"]')?.getAttribute('role')).toBe('alert')
  expect(sessionStorage.getItem('agnes.child-engines')).toBeNull()
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
  const saved = JSON.parse(sessionStorage.getItem('agnes.child-engines') ?? '{}') as {
    codex: { enabled: boolean; allow: string[] }
  }
  expect(saved.codex).toMatchObject({ enabled: true, allow: ['codex'] })
  expect(host.querySelector('[data-testid="child-engine-document"]')?.textContent).toContain('"enabled":true')
})

it('shows ACP as continuable and keeps a read-only panel disabled', async () => {
  const host = await mount(false)
  expect(host.querySelector<HTMLButtonElement>('[data-testid="child-engine-save"]')?.disabled).toBe(true)
  const protocol = host.querySelector<HTMLSelectElement>('[data-testid="child-engine-sdk-protocol"]')
  expect(protocol?.disabled).toBe(true)
  const writable = await mount(true)
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
