import { describe, expect, it } from 'vitest'
import { rootInput } from '../src/root-input.js'

describe('rootInput', () => {
  it('runs a tool card action for a digit only on an empty, settled prompt', () => {
    const fired: string[] = []
    const route = (o: { draft: string; settled: boolean }) =>
      rootInput(
        {
          signals: () => ({ focus: () => false }),
          settle: { press: () => o.settled },
          modal: { handleInput: () => false },
          dialogs: [],
          closed: () => false,
          approvalCards: new Map(),
          latestApproval: () => undefined,
          cards: { handleInput: (data: string) => fired.push(data) > 0 },
          timeline: { jumpKey: () => false },
          noAltScreen: true,
          busy: () => false,
          editor: { text: o.draft },
        } as never,
        () => false,
      )('3')
    expect(route({ draft: 'use port ', settled: true })).toBe(false)
    expect(route({ draft: '', settled: false })).toBe(false)
    expect(fired).toEqual([])
    expect(route({ draft: '', settled: true })).toBe(true)
    expect(fired).toEqual(['3'])
  })
})
