/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { settingsCatalog } from '../src/settings/locales.js'
import { type SchedulesApi, SchedulesPage } from '../src/settings/schedules.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const t = (key: string) => settingsCatalog.en[key] ?? key
const roots: Root[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
})

async function mount(node: ReturnType<typeof createElement>) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(node))
  return host
}

function must<T extends Element>(node: T | null, label: string): T {
  if (!node) throw new Error(label)
  return node
}

function fill(host: HTMLElement, testId: string, value: string) {
  const input = must(
    host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${testId}"]`),
    testId,
  )
  const prototype =
    input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const set = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!set) throw new Error(testId)
  set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const reminder = {
  id: 'sched_0123456789abcdef',
  sessionKey: 's1',
  title: 'Standup',
  prompt: 'Check mail',
  selector: { daily: { time: '09:00', timeZone: 'UTC' } },
  status: 'active',
  nextRunAt: Date.parse('2026-09-07T09:00:00Z'),
  revision: 1,
  deliveries: [{ at: Date.parse('2026-09-06T09:00:00Z'), reason: 'prompt' }],
}

it('shows the unavailable state without calling the daemon', async () => {
  const host = await mount(createElement(SchedulesPage, { t }))
  expect(host.querySelector('[data-testid="schedules-page"]')).not.toBeNull()
  expect(host.querySelector('[data-testid="schedules-error"]')?.textContent).toContain('unavailable')
  expect(host.querySelector('[data-testid="schedules-open-session"]')?.getAttribute('href')).toBe('/')
})

it('shows an empty list and a failed list', async () => {
  const empty: SchedulesApi = {
    sessionKey: () => 's1',
    list: async () => ({ schedules: [] }),
    upsert: async () => ({}),
    archive: async () => ({ deleted: false }),
  }
  const host = await mount(createElement(SchedulesPage, { api: empty, t }))
  expect(host.querySelector('[data-testid="schedules-empty"]')).not.toBeNull()
  const failed: SchedulesApi = { ...empty, list: async () => Promise.reject(new Error('offline')) }
  const errorHost = await mount(createElement(SchedulesPage, { api: failed, t }))
  expect(errorHost.querySelector('[data-testid="schedules-error"]')?.textContent).toContain('offline')
})

it('creates a reminder and archives it after confirmation', async () => {
  let rows = [] as unknown[]
  const api: SchedulesApi = {
    sessionKey: () => 's1',
    list: vi.fn(async () => ({ schedules: rows })),
    upsert: vi.fn(async () => {
      rows = [reminder]
      return reminder
    }),
    archive: vi.fn(async () => {
      rows = []
      return { deleted: true }
    }),
  }
  const host = await mount(createElement(SchedulesPage, { api, t }))
  expect(host.querySelector('[data-testid="schedules-empty"]')).not.toBeNull()
  await act(async () => {
    fill(host, 'schedules-title', 'Standup')
    fill(host, 'schedules-prompt', 'Check mail')
  })
  await act(async () => {
    must(host.querySelector('form'), 'form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
  })
  expect(api.upsert).toHaveBeenCalledWith({
    sessionKey: 's1',
    title: 'Standup',
    prompt: 'Check mail',
    selector: { daily: { time: '09:00', timeZone: 'UTC' } },
  })
  await vi.waitFor(() => expect(host.querySelector('[data-testid="schedules-row"]')).not.toBeNull())
  expect(host.querySelector('[data-testid="schedules-next"]')?.textContent).toContain(
    '2026-09-07T09:00:00.000Z',
  )
  expect(host.querySelector('[data-testid="schedules-history"]')).not.toBeNull()
  expect(host.querySelector('[data-testid="schedules-notice"]')?.getAttribute('role')).toBe('status')
  await act(async () =>
    must(host.querySelector<HTMLButtonElement>('[data-testid="schedules-archive"]'), 'archive').click(),
  )
  expect(host.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () =>
    must(
      host.querySelector<HTMLButtonElement>('[data-testid="schedules-archive-confirm"]'),
      'confirm',
    ).click(),
  )
  expect(api.archive).toHaveBeenCalledWith({ id: reminder.id })
  await vi.waitFor(() => expect(host.querySelector('[data-testid="schedules-empty"]')).not.toBeNull())
})
