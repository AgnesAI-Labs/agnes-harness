/** @vitest-environment happy-dom */
import type { UITimeline } from '@agnes/protocol'
import { unmountRegion } from '@agnes/web-ui'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { goalSlot, renderGoalCard } from '../src/goal-card.js'
import { setLocaleTranslator } from '../src/locale-bridge.js'
import { webLocaleCatalog } from '../src/locale-catalog.js'

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
let host: HTMLElement
afterEach(() => {
  if (host) unmountRegion(host)
  document.body.replaceChildren()
})
it('shows a localized durable goal and forwards human controls through slash input', async () => {
  setLocaleTranslator((key) => webLocaleCatalog['zh-CN']?.[key] ?? key)
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
  document.body.append(host)
  const onCommand = vi.fn()
  renderGoalCard(host, undefined, false, onCommand)
  expect(host.hidden).toBe(true)
  expect(document.querySelector('[data-testid="goal-bar"]')).toBeNull()
  renderGoalCard(host, live, false, onCommand)
  expect(host.hidden).toBe(false)
  expect(host.textContent).toContain('受阻的目标')
  expect(document.querySelector('[data-testid=goal-card]')).toBeNull()
  flushSync(() => (document.querySelector('[data-testid=goal-toggle]') as HTMLButtonElement).click())
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid=goal-reason]')?.textContent).toBe(
      '自动续轮已暂停。请检查目标状态后恢复。',
    ),
  )
  expect(document.querySelector('textarea')?.value).toBe('Ship a patch')
  flushSync(() => (document.querySelector('[data-testid=goal-resume]') as HTMLButtonElement).click())
  expect(onCommand).toHaveBeenCalledWith('/goal resume')
  renderGoalCard(
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
  flushSync(() => (document.querySelector('[data-testid=goal-pause]') as HTMLButtonElement).click())
  expect(onCommand).toHaveBeenCalledWith('/goal pause')
  flushSync(() => (document.querySelector('[data-testid=goal-clear]') as HTMLButtonElement).click())
  expect(onCommand).toHaveBeenCalledWith('/goal clear')
  renderGoalCard(host, live, true, onCommand)
  expect((document.querySelector('[data-testid=goal-resume]') as HTMLButtonElement).disabled).toBe(true)
  renderGoalCard(
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
  renderGoalCard(
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
  renderGoalCard(
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
  await vi.waitFor(() => expect(document.body.textContent).toContain('目标更新失败。'))
  expect(host.textContent).not.toContain('Internal failure')
})
