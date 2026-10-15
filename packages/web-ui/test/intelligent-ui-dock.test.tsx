/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import type { UiSurface, UiSurfaceRecord } from '@agnes/protocol/gen/intelligent-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import {
  IntelligentCatalog,
  IntelligentSurfaceChip,
  intelligentUiCatalog,
} from '../src/intelligent-ui/index.js'
import {
  columnLabel,
  docksInConversation,
  isTextOnly,
  rendersInAnswer,
  stateLabel,
  surfaceDockSummary,
  surfaceTitle,
  uiInstant,
} from '../src/intelligent-ui/summary.js'
import { type UiLocale, UiLocaleProvider, type UiLocaleSource } from '../src/ui-locale.js'

const translator = (locale: UiLocale) => (key: string, vars?: Record<string, string | number>) =>
  (intelligentUiCatalog[locale][key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? ''))
const source = (locale: UiLocale): UiLocaleSource => ({
  getSnapshot: () => locale,
  getVersion: () => 0,
  subscribe: () => () => {},
  t: translator(locale),
  bind: () => translator(locale),
})

const now = Date.parse('2026-10-12T07:40:00.000Z')
const schedule = (rows: { c0: string; c1: string; c2: string }[]): UiSurface => ({
  id: 'card-schedule',
  revision: 1,
  title: 'Reminders',
  titleKey: 'ui.schedule',
  placement: { inline: true, workbench: true, preferred: 'inline' },
  components: [
    {
      id: 'rows',
      kind: 'table',
      dataKey: 'rows',
      rowKey: 'id',
      selection: 'none',
      columns: [
        { key: 'c0', label: 'Title' },
        { key: 'c1', label: 'Next', format: 'date' },
        { key: 'c2', label: 'Status', format: 'status' },
      ],
    },
  ],
  data: { rows: rows.map((row, i) => ({ id: String(i), ...row })) },
  actions: [],
})
const one = schedule([{ c0: 'Report the time', c1: '2026-10-12T07:43:00.000Z', c2: 'active' }])

describe('docked surface summary', () => {
  it('localizes titles, shared column labels and lifecycle states, keeping unknown text literal', () => {
    const zh = translator('zh-CN')
    expect(surfaceTitle(one, zh)).toBe('提醒')
    expect(surfaceTitle({ title: 'Ledger', titleKey: 'finance.unknown' }, zh)).toBe('Ledger')
    expect(columnLabel('Next', zh)).toBe('下次')
    expect(columnLabel('USD cents', zh)).toBe('USD cents')
    expect(stateLabel('active', zh)).toBe('运行中')
    expect(stateLabel('needs-review', zh)).toBe('needs-review')
  })

  it('reads a full timestamp as a local time with a relative hint and leaves bare dates alone', () => {
    const instant = uiInstant('2026-10-12T07:43:00.000Z', 'en', now)
    expect(instant?.relative).toBe('in 3 minutes')
    expect(instant?.iso).toBe('2026-10-12T07:43:00.000Z')
    expect(instant?.time).toMatch(/\d{1,2}:\d{2}/)
    expect(uiInstant('2026-10-12', 'en', now)).toBeUndefined()
    expect(uiInstant('', 'en', now)).toBeUndefined()
  })

  it('derives one useful line from the data a surface already carries', () => {
    const options = { t: translator('zh-CN'), locale: 'zh-CN', now, actionable: true }
    const single = surfaceDockSummary(one, options)
    expect(single).toMatch(/^下次 .+（3分钟后） · Report the time$/)
    const many = schedule([
      { c0: 'Later', c1: '2026-10-12T09:40:00.000Z', c2: 'active' },
      { c0: 'Sooner', c1: '2026-10-12T07:45:00.000Z', c2: 'active' },
    ])
    expect(surfaceDockSummary(many, options)).toMatch(/（5分钟后） · 2 条记录$/)
    expect(surfaceDockSummary({ ...one, summary: 'Author line' }, options)).toBe('Author line')
    // Nothing to say is better than "0 available actions".
    expect(surfaceDockSummary(schedule([]), options)).toBeUndefined()
  })

  it('shows inline views inside the answer and docks only workbench-preferred ones as chips', () => {
    const workbench = { inline: true, workbench: true, preferred: 'workbench' } as const
    expect(rendersInAnswer(one)).toBe(true)
    expect(docksInConversation(one)).toBe(false)
    expect(docksInConversation({ ...one, placement: workbench })).toBe(true)
    expect(rendersInAnswer({ ...one, placement: workbench })).toBe(false)
    expect(docksInConversation({ ...one, placement: { inline: false, workbench: true } })).toBe(true)
    // Words with nothing to act on read in the answer when they may show inline; placement still decides.
    const note = {
      ...one,
      placement: { inline: false, workbench: true },
      components: [{ id: 'note', kind: 'text', dataKey: 'note' }],
      data: { note: 'D1 新街口 | D2 玄武湖' },
    } as typeof one
    expect(isTextOnly(note)).toBe(true)
    expect(rendersInAnswer(note)).toBe(false)
    expect(docksInConversation(note)).toBe(true)
    const inlineNote = {
      ...note,
      placement: { inline: true, workbench: true, preferred: 'workbench' },
    } as typeof one
    expect(rendersInAnswer(inlineNote)).toBe(true)
    expect(docksInConversation(inlineNote)).toBe(false)
    const files = {
      ...one,
      components: [{ id: 'file', kind: 'artifact-file', dataKey: 'file' }],
    } as typeof one
    expect(docksInConversation(files)).toBe(false)
    expect(rendersInAnswer(files)).toBe(false)
    const question = { ...one, data: { ...one.data, question: { kind: 'ask_user_question', deadline: 0 } } }
    expect(
      rendersInAnswer({
        ...question,
        components: [
          {
            id: 'a',
            kind: 'form',
            dataKey: 'd',
            schema: { type: 'object', properties: { x: { type: 'string' } } },
            actionIds: ['s'],
          },
        ],
        actions: [
          { id: 's', label: 'Submit', tool: 'ui_submit', argsTemplate: {}, paramsSchema: { type: 'object' } },
        ],
      } as typeof one),
    ).toBe(false)
  })
})

describe('docked surface chip', () => {
  const record = { surface: one, status: 'open', owner: 'agnes/schedule' } as unknown as UiSurfaceRecord
  const mount = async (props: Partial<Parameters<typeof IntelligentSurfaceChip>[0]> = {}) => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const onExpand = vi.fn()
    await act(async () =>
      root.render(
        createElement(
          UiLocaleProvider,
          { source: source('zh-CN') },
          createElement(IntelligentSurfaceChip, {
            record,
            locked: false,
            needsReview: false,
            pendingApproval: false,
            onExpand,
            ...props,
          }),
        ),
      ),
    )
    return { host, onExpand, unmount: () => act(async () => root.unmount()) }
  }

  it('is one labelled button that opens the workbench, with no status badge', async () => {
    const { host, onExpand, unmount } = await mount()
    const chip = host.querySelector('[data-testid="ui-surface-card-schedule"]')!
    const main = chip.querySelector<HTMLButtonElement>('[data-testid="ui-expand"]')!
    expect(main.type).toBe('button')
    expect(main.textContent).toContain('提醒')
    expect(main.querySelector('[data-testid="ui-summary"]')?.textContent).toContain('下次')
    expect(chip.textContent).not.toContain('可操作')
    expect(main.getAttribute('aria-pressed')).toBe('false')
    expect(chip.querySelector('button[aria-label="更多操作"]')).toBeTruthy()
    await act(async () => main.click())
    expect(onExpand).toHaveBeenCalledOnce()
    await unmount()
  })

  it('shows a quiet state instead of a second button while the workbench shows the surface', async () => {
    const { host, unmount } = await mount({ workbenchOpen: true })
    const chip = host.querySelector('[data-testid="ui-surface-card-schedule"]')!
    expect(chip.hasAttribute('data-active')).toBe(true)
    expect(chip.querySelector('[data-testid="ui-expand"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(chip.textContent).toContain('在工作台中')
    expect(chip.querySelectorAll('button')).toHaveLength(2)
    await unmount()
  })
})

it('renders schedule rows with localized headers, a local time with ISO tooltip and a state badge', async () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  const noop = () => {}
  await act(async () =>
    root.render(
      createElement(
        UiLocaleProvider,
        { source: source('zh-CN') },
        createElement(IntelligentCatalog, {
          surface: one,
          instance: 'workbench',
          input: {},
          selection: {},
          disabled: false,
          invalid: false,
          onInput: noop,
          onSelection: noop,
          onInvalid: noop,
          onAction: noop,
        }),
      ),
    ),
  )
  expect([...host.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['标题', '下次', '状态'])
  const time = host.querySelector('time')!
  expect(time.getAttribute('datetime')).toBe('2026-10-12T07:43:00.000Z')
  expect(time.getAttribute('title')).toBe('2026-10-12T07:43:00.000Z')
  expect(time.textContent).not.toContain('T07:43')
  expect(time.textContent).toMatch(/（.+）$/)
  const badge = host.querySelector('.agnes-intelligent-tag')!
  expect(badge.textContent).toBe('运行中')
  expect(badge.getAttribute('data-tone')).toBe('success')
  await act(async () => root.unmount())
})
