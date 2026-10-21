import type { BillingRow } from '@agnes/core'
import { describe, expect, it } from 'vitest'
import { fakeSeamInit, type MemNamespace } from '../../../testkit/seam-init.js'
import { budgetBilling } from '../src/seam.js'

const row = (over: Partial<BillingRow> = {}): BillingRow => ({
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
    const seam = await budgetBilling(init)
    await seam.record(row())
    await seam.record(row())
    expect(init.namespaces.get('usage_ledger')?.entries()).toHaveLength(1)
  })

  it('projects from gateway rows of the same model, estimated when no history', async () => {
    const init = fakeSeamInit()
    const seam = await budgetBilling(init)
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

  it('throws when the metadata write fails', async () => {
    const init = fakeSeamInit()
    const seam = await budgetBilling(init)
    const ns = init.adapters.storage.namespace('usage_ledger') as MemNamespace
    ns.set = () => {
      throw new Error('disk full')
    }
    await expect(seam.record(row())).rejects.toThrow(/disk full/)
  })
})
