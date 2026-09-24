import { describe, expect, it } from 'vitest'
import { foldEvents } from '../src/reduce/reducer.js'
import { toolHeavyLedger } from '../testkit/tool-heavy-ledger.js'
import { copiedPerRow } from './helpers/copy-counter.js'

describe('what folding a long tool-heavy session copies', () => {
  it('copies a bounded number of entries per row, however many calls came before', {
    timeout: 120_000,
  }, () => {
    const perRow = copiedPerRow(toolHeavyLedger({ calls: 4000 }), (rows) => {
      foldEvents(rows)
    })
    expect(perRow).toBeLessThan(50)
  })
})
