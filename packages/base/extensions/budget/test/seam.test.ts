import type { LedgerRow } from '@agnes/core'
import { describe, expect, it } from 'vitest'
import { fakeSeamInit } from '../../../testkit/seam-init.js'
import { budgetLedger } from '../src/seam.js'

const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  sessionKey: 's',
  lane: 'main',
  turn: 1,
  step: 1,
  purpose: 'inference',
  effectId: 'e1',
  tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
  credits: 11,
  creditSource: 'gateway',
  model: 'm',
  ...over,
})

describe('budget ledger', () => {
  it('records rows and ignores replays of the same effect', async () => {
    const init = fakeSeamInit()
    const seam = await budgetLedger(init)
    await seam.record(row())
    await seam.record(row())
    expect(init.tables.get('usage_ledger')?.rows).toHaveLength(1)
  })

  it('projects from gateway rows of the same model, estimated when no history', async () => {
    const init = fakeSeamInit()
    const seam = await budgetLedger(init)
    expect(await seam.projected({ tokensEstimate: 500, model: 'm' })).toEqual({
      credits: 0,
      creditSource: 'estimated',
    })
    await seam.record(row({ effectId: 'e1', credits: 11 })) // 11 / 1100 tokens = 0.01/token
    await seam.record(row({ effectId: 'e2', credits: 99, creditSource: 'estimated' })) // estimated rows are excluded once a gateway row exists
    expect(await seam.projected({ tokensEstimate: 500, model: 'm' })).toEqual({
      credits: 5,
      creditSource: 'estimated',
    })
  })

  it('throws when the table write fails', async () => {
    const init = fakeSeamInit()
    const seam = await budgetLedger(init)
    const table = init.tables.get('usage_ledger')
    if (!table) throw new Error('usage_ledger table was not opened by budgetLedger')
    table.run = () => {
      throw new Error('disk full')
    }
    await expect(seam.record(row())).rejects.toThrow(/disk full/)
  })
})
