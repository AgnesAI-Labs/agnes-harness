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
it('shows a localized durable goal and forwards human controls through slash input', () => {
  setLocaleTranslator((key) => webLocaleCatalog['zh-CN']?.[key] ?? key)
  const timeline = {
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
  renderGoalCard(host, live, false, onCommand)
  expect(host.textContent).toContain('受阻的目标')
  expect(host.querySelector('[data-testid=goal-reason]')?.textContent).toBe('Need access')
  flushSync(() => (host.querySelector('[data-testid=goal-toggle]') as HTMLButtonElement).click())
  expect(host.querySelector('textarea')?.value).toBe('Ship a patch')
  flushSync(() => (host.querySelector('[data-testid=goal-resume]') as HTMLButtonElement).click())
  expect(onCommand).toHaveBeenCalledWith('/goal resume')
  flushSync(() => (host.querySelector('[data-testid=goal-clear]') as HTMLButtonElement).click())
  expect(onCommand).toHaveBeenCalledWith('/goal clear')
  renderGoalCard(host, live, true, onCommand)
  expect((host.querySelector('[data-testid=goal-resume]') as HTMLButtonElement).disabled).toBe(true)
})
