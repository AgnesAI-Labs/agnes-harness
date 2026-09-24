import { describe, expect, it } from 'vitest'
import { foldEvents } from '../src/reduce/reducer.js'
import { toolHeavyLedger } from '../testkit/tool-heavy-ledger.js'

describe('the tool-heavy synthetic ledger', () => {
  it('folds to one tool call per call, one decision per approval and nothing left in flight', () => {
    const rows = [...toolHeavyLedger({ calls: 120 })]
    expect(rows.map((row) => row.seq)).toEqual(rows.map((_, i) => i + 1))
    const state = foldEvents(rows)
    expect(state.toolCalls.size).toBe(120)
    expect(state.decisions.size).toBe(12)
    expect(state.pendingEffects.size).toBe(0)
    expect(state.lastTurn.get('main')).toBe(3)
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
  })

  it('is generated lazily', () => {
    const it = toolHeavyLedger({ calls: 1_000_000 })[Symbol.iterator]()
    expect(it.next().value?.type).toBe('session/start')
  })
})
