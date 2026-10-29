import type { UITimeline } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { goalCommand, readGoal } from '../src/goals.js'

it('reads durable history, prefers live clear/error and rejects malformed goal data', () => {
  const payload = {
    text: 'Active',
    level: 'info',
    goal: {
      id: 'g',
      revision: 1,
      objective: 'Ship',
      phase: 'active',
      rounds: 0,
      maxRounds: 10,
      creditsUsed: 0,
    },
  }
  const fill = { extId: 'agnes/goal', slot: 'status.line', payload }
  const history = { nodes: [{ kind: 'slot', fill }] } as unknown as UITimeline
  expect(readGoal(history)).toEqual(payload)
  expect(
    readGoal({ ...history, slots: [{ ...fill, payload: { text: 'Cleared', level: 'info' } }] } as UITimeline)
      ?.goal,
  ).toBeUndefined()
  expect(
    readGoal({ ...history, slots: [{ ...fill, payload: { text: 'Invalid', level: 'warn' } }] } as UITimeline)
      ?.level,
  ).toBe('warn')
  expect(
    readGoal({ ...history, slots: [{ ...fill, payload: { goal: { phase: 'invented' } } }] } as UITimeline),
  ).toBeUndefined()
  expect(readGoal()).toBeUndefined()
})
it('formats human requests without granting budget or execution authority', () => {
  expect(goalCommand({ action: 'resume' })).toBe('/goal resume')
  expect(goalCommand({ action: 'edit', objective: ' Ship ', maxRounds: 10, budgetCredits: 2 })).toBe(
    '/goal edit --max-rounds 10 --budget 2 Ship',
  )
  expect(goalCommand({ action: 'create', objective: 'Ship', maxRounds: 1 })).toContain('--budget none')
  expect(() => goalCommand({ action: 'create', objective: '', maxRounds: 1 })).toThrow()
  expect(() => goalCommand({ action: 'create', objective: 'Ship', maxRounds: 101 })).toThrow()
  expect(() => goalCommand({ action: 'edit', objective: 'Ship', maxRounds: 1, budgetCredits: NaN })).toThrow()
})
