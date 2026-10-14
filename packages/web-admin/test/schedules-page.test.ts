/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { automationCatalog } from '../src/settings/automation-locale.js'
import { settingsCatalog } from '../src/settings/locales.js'
import {
  draftOf,
  emptyDraft,
  MIN_EVERY_SECONDS,
  presetName,
  selectorOf,
  targetOf,
} from '../src/settings/schedule-form.js'
import { rowsOf, scheduleChoices } from '../src/settings/schedule-model.js'
import {
  SCHEDULE_ACTIVE_REFRESH_MS,
  SCHEDULE_IDLE_REFRESH_MS,
  schedulesActive,
} from '../src/settings/schedule-refresh.js'
import { nextRun } from '../src/settings/schedule-text.js'
import {
  describeSchedule,
  localTimeZone,
  type SchedulesApi,
  SchedulesPage,
  SessionSchedules,
} from '../src/settings/schedules.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const t = (key: string) => settingsCatalog.en[key] ?? key
const ux = (key: string, vars?: Record<string, string | number>) =>
  Object.entries(vars ?? {}).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    automationCatalog.en[key] ?? key,
  )
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

function fill(testId: string, value: string) {
  const input = must(
    document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      `[data-testid="${testId}"]`,
    ),
    testId,
  )
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
  const set = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!set) throw new Error(testId)
  set.call(input, value)
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

const click = (testId: string, root: ParentNode = document) =>
  act(async () => must(root.querySelector<HTMLElement>(`[data-testid="${testId}"]`), testId).click())

const submit = () =>
  act(async () => {
    must(document.querySelector('form#schedules-editor'), 'form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
  })

const standup = {
  id: 'sched_0123456789abcdef',
  title: 'Standup',
  prompt: 'Check mail',
  selector: { weekly: { time: '14:30', timeZone: 'Asia/Shanghai', weekdays: [2, 4] } },
  target: { kind: 'session', sessionKey: 's1' },
  origin: 's1',
  status: 'active',
  nextRunAt: Date.parse('2026-09-07T09:00:00Z'),
  revision: 1,
  runs: [
    {
      at: Date.parse('2026-09-06T09:00:00Z'),
      outcome: 'ran',
      sessionKey: 's1',
      endedAt: Date.parse('2026-09-06T09:00:42Z'),
    },
  ],
}
const report = {
  ...standup,
  id: 'sched_00000000000000aa',
  title: 'Daily report',
  selector: { daily: { time: '09:00', timeZone: localTimeZone() } },
  target: { kind: 'new-session', cwd: '/work/app' },
  runs: [],
}

function api(rows: unknown[] = [], extra: Partial<SchedulesApi> = {}): SchedulesApi {
  return {
    sessionKey: () => 's1',
    list: vi.fn(async () => ({ schedules: rows })),
    upsert: vi.fn(async () => standup),
    archive: vi.fn(async () => ({ deleted: true })),
    control: vi.fn(async () => standup),
    workspaces: async () => ({
      items: [{ path: '/work/app', name: 'app', lastUsedAt: null, sessionCount: 1, available: true }],
    }),
    sessions: async () => ({
      items: [
        { sessionId: 's1', title: 'Billing review', cwd: '/work/app', createdAt: '2026-09-01T00:00:00Z' },
      ],
    }),
    ...extra,
  }
}

it('shows the unavailable state without calling the daemon', async () => {
  const host = await mount(createElement(SchedulesPage, { t }))
  expect(host.querySelector('[data-testid="schedules-page"]')).not.toBeNull()
  expect(host.querySelector('[data-testid="schedules-error"]')?.textContent).toContain('unavailable')
})

it('shows an empty list and a failed list', async () => {
  const host = await mount(createElement(SchedulesPage, { api: api(), t }))
  await vi.waitFor(() => expect(host.querySelector('[data-testid="schedules-empty"]')).not.toBeNull())
  const failed = api([], { list: async () => Promise.reject(new Error('offline')) })
  const errorHost = await mount(createElement(SchedulesPage, { api: failed, t }))
  await vi.waitFor(() =>
    expect(errorHost.querySelector('[data-testid="schedules-error"]')?.textContent).toContain(
      t('schedulesError'),
    ),
  )
})

it('creates a new-session task in the workspace of the session the user came from', async () => {
  const daemon = api()
  const host = await mount(createElement(SchedulesPage, { api: daemon, t }))
  await click('schedules-new', host)
  // A new task runs in a new session by default, in this session's workspace.
  expect(document.querySelector('[data-testid="schedules-target"]')?.textContent).toContain(ux('targetNew'))
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLSelectElement>('[data-testid="schedules-workspace"]')?.value).toBe(
      '/work/app',
    ),
  )
  await act(async () => {
    fill('schedules-title', 'Daily report')
    fill('schedules-prompt', 'Write the report')
  })
  expect(document.querySelector('[data-testid="schedules-preview"]')?.textContent).toMatch(
    /Next run: (today|tomorrow) 09:00/,
  )
  await submit()
  expect(daemon.upsert).toHaveBeenCalledWith({
    title: 'Daily report',
    prompt: 'Write the report',
    selector: { daily: { time: '09:00', timeZone: localTimeZone() } },
    target: { kind: 'new-session', cwd: '/work/app' },
  })
  expect(host.querySelector('[data-testid="schedules-notice"]')?.textContent).toBe(t('schedulesCreated'))
})

it('creates a reminder on the session the user came from', async () => {
  const daemon = api()
  const host = await mount(createElement(SchedulesPage, { api: daemon, t }))
  await click('schedules-new', host)
  await click('schedules-target-session')
  expect(document.querySelector('[data-testid="schedules-workspace"]')).toBeNull()
  expect(document.querySelector('[data-testid="schedules-session-picker"]')).not.toBeNull()
  await click('schedules-kind-every')
  await act(async () => {
    fill('schedules-title', 'Ping')
    fill('schedules-prompt', 'Continue')
    fill('schedules-when', '2')
    fill('schedules-unit', 'hours')
  })
  await submit()
  expect(daemon.upsert).toHaveBeenCalledWith({
    title: 'Ping',
    prompt: 'Continue',
    selector: { every_seconds: 7200 },
    target: { kind: 'session', sessionKey: 's1' },
  })
})

it('words a refused save by its code', async () => {
  const daemon = api([], {
    upsert: vi.fn(async () => Promise.reject({ data: { code: 'workspace_missing' } })),
  })
  const host = await mount(createElement(SchedulesPage, { api: daemon, t }))
  await click('schedules-new', host)
  await act(async () => {
    fill('schedules-title', 'Daily report')
    fill('schedules-prompt', 'Write the report')
  })
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLSelectElement>('[data-testid="schedules-workspace"]')?.value).toBe(
      '/work/app',
    ),
  )
  await submit()
  expect(document.querySelector('[data-testid="schedules-form-error"]')?.textContent).toBe(
    ux('reason.workspace_missing'),
  )
})

it('lists where each task runs, filters by target, and links a session target', async () => {
  const host = await mount(createElement(SchedulesPage, { api: api([standup, report]), t }))
  await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="schedules-row"]')).toHaveLength(2))
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="schedules-target-link"]')?.textContent).toBe(
      'Session · Billing review',
    ),
  )
  expect(host.querySelector('[data-testid="schedules-target-link"]')?.getAttribute('href')).toBe(
    '/?session=s1',
  )
  expect(host.querySelector('[data-testid="schedules-target-text"]')?.textContent).toBe('New session · app')
  expect(host.querySelector('[data-testid="schedules-row"]')?.textContent).toContain('Weekly Tue, Thu 14:30')
  await click('schedules-scope-new-session', host)
  expect(
    [...host.querySelectorAll('[data-testid="schedules-row"]')].map((row) => row.getAttribute('data-target')),
  ).toEqual(['new-session'])
  await click('schedules-scope-session', host)
  expect(
    [...host.querySelectorAll('[data-testid="schedules-row"]')].map((row) => row.getAttribute('data-target')),
  ).toEqual(['session'])
})

it('shows each run outcome in plain words, never a started turn as a failure', async () => {
  const at = Date.parse('2026-09-06T09:00:00Z')
  const runs = [
    { at, outcome: 'ran', sessionKey: 'r1', endedAt: at + 42_000 },
    { at: at + 1, outcome: 'delivered', sessionKey: 's1' },
    { at: at + 2, outcome: 'failed', reason: 'bundle_unavailable' },
    { at: at + 3, outcome: 'waiting_approval', sessionKey: 'r4' },
  ]
  const host = await mount(createElement(SchedulesPage, { api: api([{ ...report, runs }]), t }))
  await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="schedules-delivery"]')).toHaveLength(4))
  // The newest run is the row's status.
  expect(
    host.querySelector('[data-testid="schedules-row"] [data-testid="schedules-outcome"]')?.textContent,
  ).toBe(ux('outcome.waiting_approval'))
  const items = [...host.querySelectorAll('[data-testid="schedules-delivery"]')]
  expect(items.map((item) => item.getAttribute('data-outcome'))).toEqual([
    'waiting_approval',
    'failed',
    'delivered',
    'ran',
  ])
  expect(items[0]?.querySelector('a')?.textContent).toBe(ux('approve'))
  expect(items[0]?.querySelector('a')?.getAttribute('href')).toBe('/?session=r4')
  expect(items[1]?.getAttribute('data-failed')).toBe('true')
  expect(items[1]?.textContent).toContain(ux('reason.bundle_unavailable'))
  expect(items[2]?.getAttribute('data-failed')).toBeNull()
  expect(items[3]?.textContent).toContain('42 s')
  expect(items[3]?.querySelector('a')?.getAttribute('href')).toBe('/?session=r1')
})

it('pauses, resumes and runs a task now through the daemon', async () => {
  const daemon = api([standup, { ...report, status: 'paused', nextRunAt: null }])
  const host = await mount(createElement(SchedulesPage, { api: daemon, t }))
  await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="schedules-enabled"]')).toHaveLength(2))
  const switches = host.querySelectorAll<HTMLElement>('[data-testid="schedules-enabled"]')
  expect(switches[0]?.getAttribute('aria-checked')).toBe('true')
  expect(switches[1]?.getAttribute('aria-checked')).toBe('false')
  expect(host.querySelectorAll('[data-testid="schedules-status"]')[0]?.textContent).toBe(ux('status.paused'))
  await act(async () => switches[0]?.click())
  expect(daemon.control).toHaveBeenCalledWith({ id: standup.id, action: 'pause' })
  await act(async () => host.querySelectorAll<HTMLElement>('[data-testid="schedules-enabled"]')[1]?.click())
  expect(daemon.control).toHaveBeenCalledWith({ id: report.id, action: 'resume' })
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="schedules-notice"]')?.textContent).toBe(ux('noticeResumed')),
  )
})

it('opens a saved task with its values and archives it after confirmation', async () => {
  let rows: unknown[] = [standup]
  const daemon = api([], {
    list: vi.fn(async () => ({ schedules: rows })),
    archive: vi.fn(async () => {
      rows = []
      return { deleted: true }
    }),
  })
  const host = await mount(createElement(SchedulesPage, { api: daemon, t }))
  await vi.waitFor(() => expect(host.querySelector('[data-testid="schedules-row"]')).not.toBeNull())
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="schedules-row"] button')?.click(),
  )
  expect(document.querySelector<HTMLInputElement>('[data-testid="schedules-kind-weekly"]')?.checked).toBe(
    true,
  )
  expect(document.querySelector<HTMLInputElement>('[data-testid="schedules-when"]')?.value).toBe('14:30')
  expect(document.querySelector<HTMLInputElement>('[data-testid="schedules-zone"]')?.value).toBe(
    'Asia/Shanghai',
  )
  expect(document.querySelector('[data-testid="schedules-session-picker"]')).not.toBeNull()
  await submit()
  expect(daemon.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      id: standup.id,
      selector: { weekly: { time: '14:30', timeZone: 'Asia/Shanghai', weekdays: [2, 4] } },
      target: { kind: 'session', sessionKey: 's1' },
    }),
  )
  await click('schedules-actions', host)
  await vi.waitFor(() => expect(document.querySelector('[data-testid="schedules-archive"]')).not.toBeNull())
  await click('schedules-archive')
  await click('schedules-archive-confirm')
  expect(daemon.archive).toHaveBeenCalledWith({ id: standup.id })
  await vi.waitFor(() => expect(host.querySelector('[data-testid="schedules-empty"]')).not.toBeNull())
})

it('describes a schedule rule in words, and hosts its primary action where the page asks', async () => {
  const words = (key: string, vars?: Record<string, string | number>) =>
    `${key}${vars ? `(${Object.values(vars).join(',')})` : ''}`
  expect(describeSchedule({ daily: { time: '09:00', timeZone: 'UTC' } }, t, words)).toBe('Daily 09:00')
  expect(describeSchedule({ weekly: { time: '17:30', weekdays: [5] } }, t, words)).toBe('Weekly Fri 17:30')
  expect(describeSchedule({ cron: { expr: '0 9 * * 1-5' } }, t, words)).toBe('Cron 0 9 * * 1-5')
  expect(describeSchedule({ every_seconds: 1800 }, t, words)).toBe('ruleEvery(minutes(30))')
  expect(describeSchedule({ after_seconds: 7200 }, t, words)).toBe('ruleAfter(hours(2))')
  const slot = document.createElement('div')
  document.body.append(slot)
  const host = await mount(createElement(SchedulesPage, { api: api([standup]), t, actionsHost: slot }))
  expect(slot.querySelector('[data-testid="schedules-new"]')).not.toBeNull()
  expect(host.querySelector('[data-testid="schedules-new"]')).toBeNull()
})

it('round-trips a task through the form and orders Agnes AI models first', () => {
  const choices = scheduleChoices({
    loops: [
      { id: 'react', version: '1', label: 'ReAct', sourcePackage: '@agnes/base' },
      { id: 'report', version: '2', label: 'Data report', sourcePackage: '@agnes-fde/data-report' },
    ],
    presets: ['default', 'review'],
    bundles: [{ id: 'report#bundle', sourcePackage: '@agnes-fde/data-report' }],
    adapters: [
      { id: 'openai', label: 'OpenAI', models: [{ id: 'gpt', route: 'openai' }] },
      {
        id: 'agnes',
        label: 'Agnes AI',
        models: [{ id: 'agnes-1', route: 'agnes' }, { id: 'no-route' }, { id: 'unsaved', route: 'other' }],
      },
    ],
    accounts: [
      { route: 'openai', label: 'Work OpenAI', providerId: 'openai' },
      {
        route: 'agnes',
        label: 'My Agnes',
        providerId: 'agnes',
        models: [{ id: 'agnes-1', name: 'Agnes 1' }],
      },
    ],
  })
  // Only saved accounts' models, named by the account; Agnes AI first.
  expect(choices.models.map((model) => model.label)).toEqual(['Agnes 1 · My Agnes', 'gpt · Work OpenAI'])
  expect(scheduleChoices({ adapters: [{ id: 'a', models: [{ id: 'm', route: 'r' }] }] }).models).toEqual([])
  expect(choices.modes.map((mode) => [mode.label, mode.businessAgent, mode.bundles])).toEqual([
    ['ReAct', false, []],
    ['Data report', true, ['report#bundle']],
  ])
  const target = {
    kind: 'new-session' as const,
    cwd: '/work/app',
    loop: { id: 'report', version: '2' },
    bundles: ['report#bundle'],
    preset: 'review',
    model: { route: 'agnes', model: 'agnes-1' },
  }
  const [row] = rowsOf({
    schedules: [{ ...report, target, selector: { cron: { expr: '*/5 * * * *', timeZone: 'UTC' } } }],
  })
  if (!row) throw new Error('row')
  const draft = draftOf(row, choices, Date.now())
  expect(draft).toMatchObject({ frequency: 'cron', cron: '*/5 * * * *', zone: 'UTC', preset: 'review' })
  expect(targetOf(draft, choices)).toEqual(target)
  expect(selectorOf(draft)).toEqual({ cron: { expr: '*/5 * * * *', timeZone: 'UTC' } })
  // A create-only "after N seconds" reminder edits as a one-time task at its next run.
  const [later] = rowsOf({
    schedules: [
      { ...standup, selector: { after_seconds: 600 }, nextRunAt: Date.parse('2030-01-01T10:00:00Z') },
    ],
  })
  if (!later) throw new Error('later')
  expect(selectorOf(draftOf(later, choices, Date.now()))).toEqual({ at: '2030-01-01T10:00:00.000Z' })
  // Rows of an unexpected shape are left out instead of breaking the list.
  expect(rowsOf({ schedules: [{ id: 'x' }, standup] })).toHaveLength(1)
  expect(emptyDraft({ now: 0 }).target).toBe('new-session')
})

it('keeps the saved loop, ordered bundles and model when only the title changes (B03)', async () => {
  const saved = {
    kind: 'new-session' as const,
    cwd: '/synthetic',
    loop: { id: 'agent', version: '1' },
    bundles: ['policy-b', 'policy-a'],
    model: { route: 'r', model: 'm' },
  }
  const [row] = rowsOf({ schedules: [{ ...report, target: saved }] })
  if (!row) throw new Error('row')
  // The catalog could not be read: nothing is rebuilt from an empty list.
  const none = scheduleChoices({})
  expect(targetOf({ ...draftOf(row, none, 0), title: 'Renamed' }, none)).toEqual(saved)
  // The catalog lists the loop with different default bundles: the saved order still wins.
  const catalog = scheduleChoices({
    loops: [{ id: 'agent', version: '1', label: 'Agent', sourcePackage: '@agnes-fde/agent' }],
    bundles: [{ id: 'catalog-default', sourcePackage: '@agnes-fde/agent' }],
    adapters: [{ id: 'x', models: [{ id: 'other', route: 'x' }] }],
    accounts: [{ route: 'x', label: 'X', providerId: 'x' }],
  })
  const draft = draftOf(row, catalog, 0)
  expect(targetOf(draft, catalog)).toEqual(saved)
  // Choosing the default on purpose clears the field; choosing another entry rebuilds it.
  const cleared = targetOf({ ...draft, mode: '', model: '' }, catalog)
  expect(cleared).toEqual({ kind: 'new-session', cwd: '/synthetic' })
  const other = catalog.models[0]
  if (!other) throw new Error('model')
  // Only a new-session target names a model; anything else here is a failure of its own.
  const rebuilt = targetOf({ ...draft, model: other.key }, catalog)
  if (rebuilt.kind !== 'new-session') throw new Error('expected a new-session target')
  expect(rebuilt.model).toEqual({ route: 'x', model: 'other' })
  expect(rebuilt).toEqual({ ...saved, model: { route: 'x', model: 'other' } })
  // End to end: a title-only edit sends the saved target back unchanged, even when choices fail.
  const upsert = vi.fn(async () => standup)
  const host = await mount(
    createElement(SchedulesPage, {
      api: api([{ ...report, target: saved }], {
        upsert,
        choices: async () => {
          throw new Error('catalog unavailable')
        },
      }),
      t,
    }),
  )
  await vi.waitFor(() => expect(host.querySelector('[data-testid="schedules-row"]')).not.toBeNull())
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="schedules-row"] button')?.click(),
  )
  expect(document.querySelector('[data-testid="schedules-mode-saved"]')?.textContent).toContain(
    'saved, not available now',
  )
  fill('schedules-title', 'Renamed')
  await submit()
  expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ title: 'Renamed', target: saved }))
})

it('keeps a period of seconds exact instead of rounding it to minutes (F03)', () => {
  const every = (seconds: number) => {
    const [row] = rowsOf({ schedules: [{ ...report, selector: { every_seconds: seconds } }] })
    if (!row) throw new Error('row')
    return draftOf(row, scheduleChoices({}), 0)
  }
  expect(every(90)).toMatchObject({ every: '90', unit: 'seconds' })
  expect(selectorOf({ ...every(90), title: 'Renamed' })).toEqual({ every_seconds: 90 })
  expect(selectorOf(every(120))).toEqual({ every_seconds: 120 })
  expect(every(120)).toMatchObject({ every: '2', unit: 'minutes' })
  expect(selectorOf(every(7200))).toEqual({ every_seconds: 7200 })
  expect(MIN_EVERY_SECONDS).toBe(60)
})

it('says the shortest period instead of saving one the service refuses (F03)', async () => {
  await mount(createElement(SchedulesPage, { api: api(), t }))
  await click('schedules-new')
  await click('schedules-kind-every')
  fill('schedules-unit', 'seconds')
  fill('schedules-when', '30')
  expect(document.body.textContent).toContain('Runs at most every 60 seconds.')
  expect(
    must(document.querySelector<HTMLButtonElement>('[data-testid="schedules-create"]'), 'create').disabled,
  ).toBe(true)
  fill('schedules-when', '90')
  expect(document.body.textContent).not.toContain('Runs at most every 60 seconds.')
})

it('names permission presets the way settings does, keeping unknown ones by id (S02)', async () => {
  const zh = (key: string) => settingsCatalog['zh-CN']?.[key] ?? key
  expect(presetName('workspace-write', zh)).toBe('可修改工作区')
  expect(presetName('read-only', t)).toBe('Read only')
  expect(presetName('acme-strict', zh)).toBe('acme-strict')
  await mount(
    createElement(SchedulesPage, {
      api: api([], { choices: async () => scheduleChoices({ presets: ['workspace-write', 'acme-strict'] }) }),
      t,
    }),
  )
  await click('schedules-new')
  const options = [...document.querySelectorAll('[data-testid="schedules-preset"] option')].map(
    (option) => option.textContent,
  )
  expect(options.slice(1)).toEqual(['Edit workspace', 'acme-strict'])
})

it('keeps run and approval states current while the page is open, and rests while it is hidden (F04)', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(Date.parse('2026-10-14T08:00:00Z'))
  let visibility: DocumentVisibilityState = 'visible'
  const visible = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  try {
    const idle = { ...report, nextRunAt: Date.parse('2026-10-15T08:00:00Z') }
    const running = { ...idle, runs: [{ at: Date.parse('2026-10-14T07:59:00Z'), outcome: 'running' }] }
    let rows: unknown[] = [running]
    const list = vi.fn(async () => ({ schedules: rows }))
    await mount(createElement(SchedulesPage, { api: api([], { list }), t }))
    expect(list).toHaveBeenCalledTimes(1)
    // A run in progress is re-read quickly, so «waiting for approval» or «done» shows on its own.
    await act(async () => vi.advanceTimersByTimeAsync(SCHEDULE_ACTIVE_REFRESH_MS))
    expect(list).toHaveBeenCalledTimes(2)
    rows = [{ ...running, runs: [{ ...running.runs[0], outcome: 'waiting_approval' }] }]
    await act(async () => vi.advanceTimersByTimeAsync(SCHEDULE_ACTIVE_REFRESH_MS))
    expect(document.body.textContent).toContain(ux('outcome.waiting_approval'))
    // Nothing happening: the list still refreshes, but slowly.
    rows = [idle]
    await act(async () => vi.advanceTimersByTimeAsync(SCHEDULE_ACTIVE_REFRESH_MS))
    const settled = list.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(SCHEDULE_ACTIVE_REFRESH_MS))
    expect(list).toHaveBeenCalledTimes(settled)
    await act(async () => vi.advanceTimersByTimeAsync(SCHEDULE_IDLE_REFRESH_MS))
    expect(list).toHaveBeenCalledTimes(settled + 1)
    // Hidden pages do not poll; coming back reads at once.
    visibility = 'hidden'
    await act(async () => vi.advanceTimersByTimeAsync(SCHEDULE_IDLE_REFRESH_MS * 3))
    expect(list).toHaveBeenCalledTimes(settled + 1)
    visibility = 'visible'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(list).toHaveBeenCalledTimes(settled + 2)
    // «Run now» polls quickly until the run shows, even before the list says it is running.
    await click('schedules-actions')
    await click('schedules-run-now')
    const afterRun = list.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(SCHEDULE_ACTIVE_REFRESH_MS))
    expect(list).toHaveBeenCalledTimes(afterRun + 1)
  } finally {
    visible.mockRestore()
    vi.useRealTimers()
  }
})

it('counts a task as active while it runs, waits for approval or is about to run', () => {
  const now = Date.parse('2026-10-14T08:00:00Z')
  const [row] = rowsOf({ schedules: [{ ...report, nextRunAt: now + 3_600_000 }] })
  if (!row) throw new Error('row')
  expect(schedulesActive([row], now)).toBe(false)
  expect(schedulesActive([{ ...row, nextRunAt: now + 30_000 }], now)).toBe(true)
  expect(schedulesActive([{ ...row, status: 'paused', nextRunAt: now + 30_000 }], now)).toBe(false)
  expect(schedulesActive([{ ...row, runs: [{ at: now, outcome: 'waiting_approval' }] }], now)).toBe(true)
})

it('previews the next run in this computer’s time', () => {
  const now = new Date(2026, 9, 14, 10, 0).getTime()
  const zone = localTimeZone()
  expect(nextRun({ daily: { time: '09:00', timeZone: zone } }, now)).toBe(
    new Date(2026, 9, 15, 9, 0).getTime(),
  )
  expect(nextRun({ daily: { time: '11:30', timeZone: zone } }, now)).toBe(
    new Date(2026, 9, 14, 11, 30).getTime(),
  )
  // 2026-10-14 is a Wednesday; the next Monday is the 19th.
  expect(nextRun({ weekly: { time: '09:00', timeZone: zone, weekdays: [1] } }, now)).toBe(
    new Date(2026, 9, 19, 9, 0).getTime(),
  )
  expect(nextRun({ every_seconds: 600 }, now)).toBe(now + 600_000)
  expect(nextRun({ cron: { expr: '0 9 * * *' } }, now)).toBeUndefined()
  expect(
    nextRun({ daily: { time: '09:00', timeZone: zone === 'UTC' ? 'Asia/Tokyo' : 'UTC' } }, now),
  ).toBeUndefined()
})

it('lists this session’s tasks in the runtime dialog and links to the automation page', async () => {
  const list = vi.fn(async () => ({ schedules: [standup] }))
  const onManage = vi.fn()
  const host = await mount(createElement(SessionSchedules, { list, sessionKey: 's1', onManage }))
  await vi.waitFor(() =>
    expect(host.querySelectorAll('[data-testid="session-schedules-row"]')).toHaveLength(1),
  )
  expect(list).toHaveBeenCalledWith({ scope: 'session', sessionKey: 's1' })
  expect(host.querySelector('[data-testid="session-schedules-row"]')?.textContent).toContain('Standup')
  await click('session-schedules-manage', host)
  expect(onManage).toHaveBeenCalledOnce()
  // A daemon that cannot answer leaves the section out.
  const quiet = await mount(
    createElement(SessionSchedules, {
      list: async () => Promise.reject(new Error('x')),
      sessionKey: 's1',
      onManage,
    }),
  )
  expect(quiet.querySelector('[data-testid="session-schedules"]')).toBeNull()
})
