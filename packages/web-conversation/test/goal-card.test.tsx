/** @vitest-environment happy-dom */
import type { UITimeline } from '@agnes/protocol'
import { setLocaleTranslator, tr } from '@agnes/web-foundation/locale-bridge'
import { webLocaleCatalog } from '@agnes/web-foundation/locale-catalog'
import { renderRegion, unmountRegion } from '@agnes/web-ui'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { goalSlot, renderGoalCard } from '../src/goal-card.js'
import { GoalPanel } from '../src/workbench/goal-panel.js'
import { workbenchLocaleCatalog } from '../src/workbench/locales.js'

const goal = {
  id: 'g',
  revision: 1,
  objective: 'Ship a patch',
  phase: 'blocked',
  reason: 'Need access',
  rounds: 2,
  maxRounds: 2,
  creditsUsed: 1,
} as const
let host: HTMLElement, panel: HTMLElement
function renderBoth(...args: Parameters<typeof renderGoalCard>) {
  renderGoalCard(...args)
  const [, timeline, disabled, command] = args
  renderRegion(panel, <GoalPanel context={{ t: tr, data: { timeline, disabled, command } }} />)
}
afterEach(() => {
  if (host) unmountRegion(host)
  if (panel) unmountRegion(panel)
  document.body.replaceChildren()
})
it('shows a localized durable goal and forwards human controls through slash input', async () => {
  setLocaleTranslator(
    (key) => webLocaleCatalog['zh-CN']?.[key] ?? workbenchLocaleCatalog['zh-CN']?.[key] ?? key,
  )
  const timeline = {
    sessionId: 'session-a',
    nodes: [
      {
        kind: 'slot',
        fill: {
          extId: 'agnes/goal',
          slot: 'status.line',
          payload: { text: 'Goal blocked', level: 'warn', goal },
        },
      },
    ],
  } as unknown as UITimeline
  expect(goalSlot(timeline)?.goal).toEqual(goal)
  const live = {
    ...timeline,
    nodes: [],
    slots: [
      {
        extId: 'agnes/goal',
        slot: 'status.line' as const,
        payload: { text: 'Goal blocked', level: 'warn', goal },
      },
    ],
  }
  expect(goalSlot(live)?.goal).toEqual(goal)
  host = document.createElement('div')
  panel = document.createElement('div')
  document.body.append(host, panel)
  const onCommand = vi.fn()
  renderBoth(host, undefined, false, onCommand)
  expect(host.hidden).toBe(true)
  expect(document.querySelector('[data-testid="goal-bar"]')).toBeNull()
  renderBoth(host, live, false, onCommand)
  expect(host.hidden).toBe(false)
  expect(host.textContent).toContain('受阻的目标')
  expect(document.querySelector('[data-testid=goal-card]')).toBeNull()
  flushSync(() => (document.querySelector('[data-testid=goal-toggle]') as HTMLButtonElement).click())
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid=goal-reason]')?.textContent).toBe(
      '自动续轮已暂停。请检查目标状态后恢复。',
    ),
  )
  await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe('Ship a patch'))
  expect(panel.textContent).toContain('Ship a patch')
  expect(document.querySelectorAll('[data-testid=goal-reason]')).toHaveLength(1)
  expect(panel.querySelector('[data-testid=goal-reason]')).not.toBeNull()
  expect(panel.querySelector('[data-testid=goal-panel-progress]')).not.toBeNull()
  flushSync(() => (panel.querySelector('[data-testid=goal-panel-resume]') as HTMLButtonElement).click())
  expect(onCommand).toHaveBeenCalledWith('/goal resume')
  flushSync(() => (document.querySelector('[data-testid=goal-resume]') as HTMLButtonElement).click())
  expect(onCommand).toHaveBeenCalledWith('/goal resume')
  renderBoth(
    host,
    {
      ...live,
      slots: live.slots.map((fill) => ({
        ...fill,
        payload: { ...fill.payload, goal: { ...goal, revision: 2, phase: 'active', rounds: 3 } },
      })),
    },
    false,
    onCommand,
  )
  expect(document.querySelector('[data-testid=goal-toggle]')?.getAttribute('aria-expanded')).toBe('true')
  expect(panel.querySelector('[data-testid=goal-panel-phase]')?.textContent).toBe('进行中的目标')
  flushSync(() => (document.querySelector('[data-testid=goal-pause]') as HTMLButtonElement).click())
  expect(onCommand).toHaveBeenCalledWith('/goal pause')
  flushSync(() => (document.querySelector('[data-testid=goal-clear]') as HTMLButtonElement).click())
  expect(onCommand).toHaveBeenCalledWith('/goal clear')
  renderBoth(host, live, true, onCommand)
  expect((document.querySelector('[data-testid=goal-resume]') as HTMLButtonElement).disabled).toBe(true)
  expect((panel.querySelector('[data-testid=goal-panel-resume]') as HTMLButtonElement).disabled).toBe(true)
  renderBoth(
    host,
    {
      ...live,
      sessionId: 'session-b',
      slots: live.slots.map((fill) => ({
        ...fill,
        payload: { ...fill.payload, goal: { ...goal, objective: 'Ship a second patch' } },
      })),
    },
    false,
    onCommand,
  )
  const toggle = document.querySelector('[data-testid=goal-toggle]') as HTMLButtonElement
  if (toggle.getAttribute('aria-expanded') === 'false') flushSync(() => toggle.click())
  await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe('Ship a second patch'))
  renderBoth(
    host,
    {
      ...live,
      slots: live.slots.map((fill) => ({
        ...fill,
        payload: { ...fill.payload, goal: { ...goal, reason: 'Credit budget exhausted' } },
      })),
    },
    false,
    onCommand,
  )
  flushSync(() => (document.querySelector('[data-testid=goal-toggle]') as HTMLButtonElement).click())
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid=goal-reason]')?.textContent).toBe('额度预算已用完。'),
  )
  renderBoth(
    host,
    {
      ...live,
      slots: live.slots.map((fill) => ({
        ...fill,
        payload: { level: fill.payload.level, text: 'Internal failure' },
      })),
    },
    false,
    onCommand,
  )
  flushSync(() => (document.querySelector('[data-testid=goal-toggle]') as HTMLButtonElement).click())
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid=goal-card]')?.textContent).toContain('目标更新失败。'),
  )
  expect(host.textContent).not.toContain('Internal failure')
  expect(panel.textContent).toContain('目标更新失败。')
  expect(panel.textContent).not.toContain('Internal failure')
})
