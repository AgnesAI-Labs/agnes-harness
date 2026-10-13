/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { settingsCatalog } from '../src/settings/locales.js'
import {
  describeSchedule,
  localTimeZone,
  type SchedulesApi,
  SchedulesPage,
} from '../src/settings/schedules.js'

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
  selector: { weekly: { time: '14:30', timeZone: 'Asia/Shanghai', weekdays: [2, 4] } },
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
  expect(errorHost.querySelector('[data-testid="schedules-error"]')?.textContent).toContain(
    t('schedulesError'),
  )
})

it('creates a reminder and archives it after confirmation', async () => {
  let rows = [] as unknown[]
  let refuseArchive = true
  const api: SchedulesApi = {
    sessionKey: () => 's1',
    list: vi.fn(async () => ({ schedules: rows })),
    upsert: vi.fn(async () => {
      rows = [reminder]
      return reminder
    }),
    archive: vi.fn(async () => {
      if (refuseArchive) return { deleted: false }
      rows = []
      return { deleted: true }
    }),
  }
  const host = await mount(createElement(SchedulesPage, { api, t }))
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="schedules-new"]')?.click())
  expect(host.querySelector('[data-testid="schedules-empty"]')).not.toBeNull()
  await act(async () => {
    fill(document.body, 'schedules-title', 'Standup')
    fill(document.body, 'schedules-prompt', 'Check mail')
  })
  await act(async () => {
    must(document.querySelector('form#schedules-editor'), 'form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
  })
  expect(api.upsert).toHaveBeenCalledWith({
    sessionKey: 's1',
    title: 'Standup',
    prompt: 'Check mail',
    // The reminder runs in this computer's time zone unless the user names another.
    selector: { daily: { time: '09:00', timeZone: localTimeZone() } },
  })
  await vi.waitFor(() => expect(host.querySelector('[data-testid="schedules-row"]')).not.toBeNull())
  expect(host.querySelector('[data-testid="schedules-next"]')?.textContent).toContain(
    // Minutes are enough for a reminder; seconds are noise.
    new Date(reminder.nextRunAt).toLocaleString(document.documentElement.lang || 'en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
  )
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="schedules-row"] button')?.click(),
  )
  expect(document.querySelector<HTMLSelectElement>('[data-testid="schedules-kind"]')?.value).toBe('weekly')
  expect(document.querySelector<HTMLInputElement>('[data-testid="schedules-when"]')?.value).toBe('14:30')
  expect(document.querySelector<HTMLInputElement>('[data-testid="schedules-zone"]')?.value).toBe(
    'Asia/Shanghai',
  )
  expect(host.querySelector('[data-testid="schedules-history"]')).not.toBeNull()
  expect(host.querySelector('[data-testid="schedules-notice"]')?.getAttribute('role')).toBe('status')
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[data-testid="schedules-editor"]')
      ?.closest('[role="dialog"]')
      ?.querySelector<HTMLButtonElement>('.ant-modal-close')
      ?.click(),
  )
  await act(async () =>
    must(host.querySelector<HTMLButtonElement>('[data-testid="schedules-archive"]'), 'archive').click(),
  )
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () =>
    must(
      document.querySelector<HTMLButtonElement>('[data-testid="schedules-archive-confirm"]'),
      'confirm',
    ).click(),
  )
  expect(api.archive).toHaveBeenCalledWith({ id: reminder.id })
  expect(host.querySelector('[data-testid="schedules-row"]')).not.toBeNull()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(t('schedulesError'))
  refuseArchive = false
  await act(async () =>
    must(
      document.querySelector<HTMLButtonElement>('[data-testid="schedules-archive-confirm"]'),
      'retry archive',
    ).click(),
  )
  await vi.waitFor(() => expect(host.querySelector('[data-testid="schedules-empty"]')).not.toBeNull())
})

it('describes a schedule rule in words, and hosts its primary action where the page asks', async () => {
  const ux = (key: string, vars?: Record<string, string | number>) =>
    `${key}${vars ? `(${Object.values(vars).join(',')})` : ''}`
  expect(describeSchedule({ daily: { time: '09:00', timeZone: 'UTC' } }, t, ux)).toBe('Daily 09:00')
  expect(describeSchedule({ weekly: { time: '17:30', weekdays: [5] } }, t, ux)).toBe('Weekly Fri 17:30')
  expect(describeSchedule({ cron: { expr: '0 9 * * 1-5' } }, t, ux)).toBe('Cron 0 9 * * 1-5')
  expect(describeSchedule({ every_seconds: 1800 }, t, ux)).toBe('ruleEvery(minutes(30))')
  expect(describeSchedule({ after_seconds: 7200 }, t, ux)).toBe('ruleAfter(hours(2))')
  expect(describeSchedule({ after_seconds: 45 }, t, ux)).toBe('ruleAfter(seconds(45))')

  const api: SchedulesApi = {
    sessionKey: () => 's1',
    list: async () => ({ schedules: [reminder] }),
    upsert: async () => ({}),
    archive: async () => ({ deleted: true }),
  }
  const slot = document.createElement('div')
  document.body.append(slot)
  const host = await mount(createElement(SchedulesPage, { api, t, actionsHost: slot }))
  // The page header owns the action; the list does not repeat it or its own description.
  expect(slot.querySelector('[data-testid="schedules-new"]')).not.toBeNull()
  expect(host.querySelector('[data-testid="schedules-new"]')).toBeNull()
  await vi.waitFor(() => expect(host.querySelector('[data-testid="schedules-row"]')).not.toBeNull())
  expect(host.querySelector('[data-testid="schedules-row"]')?.textContent).toContain('Weekly Tue')
})

it('keeps time zone and Cron under advanced options, opened when a schedule uses them', async () => {
  const cron = { ...reminder, id: 'sched_cron', selector: { cron: { expr: '*/5 * * * *', timeZone: 'UTC' } } }
  const upsert = vi.fn(async () => ({}))
  const api: SchedulesApi = {
    sessionKey: () => 's1',
    list: async () => ({ schedules: [cron] }),
    upsert,
    archive: async () => ({ deleted: true }),
  }
  const host = await mount(createElement(SchedulesPage, { api, t }))
  await vi.waitFor(() => expect(host.querySelector('[data-testid="schedules-row"]')).not.toBeNull())
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="schedules-new"]')?.click())
  // A new reminder offers everyday rules only; Cron is not one of the choices.
  const kinds = [...document.querySelectorAll('[data-testid="schedules-kind"] option')].map(
    (option) => (option as HTMLOptionElement).value,
  )
  expect(kinds).toEqual(['daily', 'weekly', 'at', 'after_seconds', 'every_seconds'])
  expect(document.querySelector('[data-testid="schedules-advanced"]')?.getAttribute('data-open')).not.toBe(
    'true',
  )
  await act(async () =>
    document
      .querySelector('form#schedules-editor')
      ?.closest('[role="dialog"]')
      ?.querySelector<HTMLButtonElement>('.ant-modal-close')
      ?.click(),
  )
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="schedules-row"] button')?.click(),
  )
  expect(document.querySelector('[data-testid="schedules-advanced"]')?.getAttribute('data-open')).toBe('true')
  expect(document.querySelector<HTMLInputElement>('[data-testid="schedules-cron"]')?.value).toBe(
    '*/5 * * * *',
  )
  expect(document.querySelector('[data-testid="schedules-kind"]')).toBeNull()
  await act(async () => {
    must(document.querySelector('form#schedules-editor'), 'form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
  })
  expect(upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'sched_cron',
      selector: { cron: { expr: '*/5 * * * *', timeZone: 'UTC' } },
    }),
  )
})
