/** @vitest-environment happy-dom */
import { type ChildEngineSettings, DISABLED_CHILD_ENGINES } from '@agnes/protocol'
import { installFeedbackSink, type OperationFeedback } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { type ChildEnginesClient, ChildEnginesPanel } from '../src/settings/child-engines.js'
import { settingsCatalog } from '../src/settings/locales.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
const outcomes: OperationFeedback[] = []
let releaseFeedback: (() => void) | undefined
beforeEach(() => {
  outcomes.length = 0
  releaseFeedback = installFeedbackSink({ publish: (result) => outcomes.push(result), resolve() {} })
})
afterEach(async () => {
  releaseFeedback?.()
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
})

function client(effect: 'new-sessions' | 'restart-required' = 'new-sessions'): ChildEnginesClient & {
  childEngines: ReturnType<typeof vi.fn>
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
  // An engine that is off is one row; its command, allowlist and capabilities open once it is on.
  expect(host.querySelector('[data-testid="child-engine-codex-allow"]')).toBeNull()
  expect(host.querySelector<HTMLButtonElement>('[data-testid="child-engine-save"]')?.disabled).toBe(true)
  const enabled = host.querySelector<HTMLButtonElement>('[data-testid="child-engine-codex-enabled"]')
  expect(enabled?.getAttribute('role')).toBe('switch')
  await act(async () => enabled?.click())
  expect(enabled?.getAttribute('aria-checked')).toBe('true')
  expect(host.querySelector('[data-testid="child-engine-codex-capabilities"]')?.textContent).toContain(
    'Continuable: No',
  )
  expect(host.querySelector('[data-testid="child-engine-codex-capabilities"]')?.textContent).toContain(
    'Interrupt: Yes',
  )
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
  expect(host.querySelector('[data-testid="child-engine-status"]')).toBeNull()
  expect(outcomes.at(-1)).toMatchObject({ scope: 'child-engines', outcome: 'success' })
  expect(api.saveChildEngines).toHaveBeenCalledTimes(1)
  const saved = api.saveChildEngines.mock.calls[0]?.[0] as { engines: ChildEngineSettings }
  expect(saved.engines.codex).toMatchObject({ enabled: true, allow: ['codex'] })
  expect(host.querySelector('[data-testid="child-engine-document"]')?.textContent).toContain('"enabled":true')
  expect(host.querySelector<HTMLButtonElement>('[data-testid="child-engine-save"]')?.disabled).toBe(true)
})

it('shows ACP as continuable and keeps a read-only panel disabled', async () => {
  const stored = client()
  stored.childEngines.mockResolvedValue({
    revision: 4,
    engines: { ...DISABLED_CHILD_ENGINES, sdk: { ...DISABLED_CHILD_ENGINES.sdk, enabled: true } },
  })
  const host = await mount(false, stored)
  expect(host.querySelector<HTMLButtonElement>('[data-testid="child-engine-save"]')?.disabled).toBe(true)
  const protocol = host.querySelector<HTMLSelectElement>('[data-testid="child-engine-sdk-protocol"]')
  expect(protocol?.disabled).toBe(true)
  const writable = await mount(true, client('restart-required'))
  await act(async () =>
    writable.querySelector<HTMLButtonElement>('[data-testid="child-engine-sdk-enabled"]')?.click(),
  )
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

it.each(['saved', 'failed'] as const)(
  'ignores a late child-engine %s after replacing the client',
  async (outcome) => {
    const first = client(),
      next = client()
    let resolve!: (value: unknown) => void
    let reject!: (reason: unknown) => void
    first.saveChildEngines.mockImplementation(
      () =>
        new Promise((ok, fail) => {
          resolve = ok
          reject = fail
        }),
    )
    const host = await mount(true, first)
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="child-engine-codex-enabled"]')?.click(),
    )
    await act(async () => {
      const allow = host.querySelector<HTMLTextAreaElement>('[data-testid="child-engine-codex-allow"]')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(allow, 'codex')
      allow.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="child-engine-save"]')?.click())
    expect(resolve).toBeTypeOf('function')
    await act(async () =>
      roots.at(-1)?.render(
        createElement(ChildEnginesPanel, {
          api: next,
          canSave: true,
          t: (key: string) => settingsCatalog.en[key] ?? key,
        }),
      ),
    )
    await act(async () =>
      outcome === 'saved'
        ? resolve({
            revision: 5,
            engines: first.saveChildEngines.mock.calls[0]?.[0].engines,
            effect: 'new-sessions',
          })
        : reject(new Error('old save')),
    )
    expect(
      host.querySelector('[data-testid="child-engine-codex-enabled"]')?.getAttribute('aria-checked'),
    ).toBe('false')
    expect(host.querySelector('[data-testid="child-engine-status"]')).toBeNull()
    expect(outcomes).toEqual([])
  },
)
