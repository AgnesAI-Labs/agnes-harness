import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerRow } from '@agnes/core'
import type { BudgetReservation } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import type { UsageLedgerOwners } from '../../src/assemble/usage-ledger.js'
import { assembleRuntimeUsageLedger } from '../../src/assemble/usage-ledger.js'
import { createTestHost } from '../../testkit/index.js'
import { attempt, ledgerFixture, measurement } from './fixtures/usage-ledger.js'

const dirs: string[] = []
const fixtures: Awaited<ReturnType<typeof ledgerFixture>>[] = []
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'host-usage-ledger-'))
  dirs.push(dir)
  const fixture = await ledgerFixture(dir)
  fixtures.push(fixture)
  return { ...fixture, dir }
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const refusal = (detailCode: string) => ({ ok: false, error: { detailCode } })

describe('Host runtime Usage to original ledger', () => {
  it('uses injected owners through the actual Host assembly slot and disposes its consumer', async () => {
    const f = await setup()
    f.commit(attempt('1'))
    f.commit(attempt('2'))
    const { host } = await createTestHost({ dataDir: f.dir, runtimeUsageLedgerOwners: f.owners })
    const consumer = host.runtimeServices.usageLedger
    try {
      expect(await consumer.consume(attempt('1'))).toMatchObject({ ok: true })
      expect(await consumer.consume(attempt('2'))).toMatchObject({ ok: true })
      expect(f.rows()).toHaveLength(2)
    } finally {
      await host.close()
    }
    expect(await consumer.consume(attempt('1'))).toMatchObject(refusal('usage_ledger_disposed'))
  })
  it('records two model attempts once each and preserves gateway zero across concurrent duplicates', async () => {
    const f = await setup()
    f.commit(attempt('1'))
    f.commit(attempt('2'))
    const replies = await Promise.all([
      f.consumer.consume(attempt('1')),
      f.consumer.consume(attempt('1')),
      f.consumer.consume(attempt('2')),
    ])
    expect(replies.every((r) => r.ok)).toBe(true)
    expect(replies[0]).toEqual(replies[1])
    expect(f.facts()).toBe(2)
    expect(f.rows()).toMatchObject([
      { effect_id: 'effect-attempt-1', credits: 0, credit_source: 'gateway' },
      { effect_id: 'effect-attempt-2', credits: 0, credit_source: 'gateway' },
    ])
    expect(f.consumer.pending()).toEqual([])
  })

  it.each(['installer', 'state', 'session'] as const)(
    'refuses a missing %s owner before creating a journal',
    async (name) => {
      const f = await setup()
      const owners: UsageLedgerOwners = { ...f.owners, [name]: undefined }
      const path = join(f.dir, `missing-${name}.sqlite`)
      const consumer = assembleRuntimeUsageLedger(path, owners)
      try {
        expect(await consumer.consume(attempt())).toMatchObject(refusal(`usage_${name}_owner_absent`))
        expect(f.rows()).toEqual([])
        expect(f.facts()).toBe(0)
        expect(existsSync(path)).toBe(false)
      } finally {
        await consumer.close()
      }
    },
  )

  it('refuses a missing ledger write capability and a nonexclusive session mapping', async () => {
    const f = await setup()
    f.commit()
    const claim = f.owners.session?.claim
    if (!claim) throw new Error('fixture')
    for (const mode of ['missing', 'nonexclusive']) {
      const consumer = assembleRuntimeUsageLedger(join(f.dir, `bad-${mode}.sqlite`), {
        ...f.owners,
        session: {
          async claim(input, ctx) {
            const result = await claim(input, ctx)
            if (!result.ok) return result
            return {
              ok: true,
              value: {
                ...result.value,
                ...(mode === 'missing' ? { ledger: undefined } : { mode: 'legacy' }),
              },
            } as unknown as typeof result
          },
        },
      })
      try {
        expect(await consumer.consume(attempt())).toMatchObject(
          refusal(mode === 'missing' ? 'usage_ledger_owner_absent' : 'usage_session_not_exclusive'),
        )
      } finally {
        await consumer.close()
      }
    }
    expect(f.facts()).toBe(0)
  })

  it('preserves original estimates without recalculating credits or billing', async () => {
    const f = await setup()
    f.commit(attempt(), {
      ...measurement('estimated'),
      credits: 3,
      creditSource: 'estimated',
      billing: { usdMicros: 12, source: 'estimated', subscription: false },
    })
    expect(await f.consumer.consume(attempt())).toMatchObject({ ok: true })
    expect(f.rows()).toMatchObject([{ credits: 3, credit_source: 'estimated' }])
  })

  it.each(['unknown', 'missing-credits'] as const)(
    'retains %s facts for reconciliation without writing zero',
    async (kind) => {
      const f = await setup()
      const value = kind === 'unknown' ? measurement('unknown') : measurement()
      if (kind === 'missing-credits') {
        delete value.credits
        delete value.creditSource
      }
      f.commit(attempt(), value)
      expect(await f.consumer.consume(attempt())).toMatchObject(refusal('usage_ledger_unknown'))
      expect(f.facts()).toBe(1)
      expect(f.rows()).toEqual([])
      expect(f.consumer.pending()).toEqual([attempt()])
    },
  )

  it('fails closed on ledger failure, retains delivery, and detects changed measurement under the same attempt', async () => {
    const f = await setup()
    f.commit()
    f.failLedger()
    expect(await f.consumer.consume(attempt())).toMatchObject(refusal('usage_ledger_failed'))
    expect(f.rows()).toEqual([])
    expect(f.facts()).toBe(1)
    expect(f.consumer.pending()).toEqual([attempt()])
    f.commit(attempt('2'))
    expect(await f.consumer.consume(attempt('2'))).toMatchObject(refusal('usage_ledger_pending'))
    expect(f.facts()).toBe(1)
    f.commit(attempt(), { ...measurement(), credits: 7 })
    expect(await f.consumer.consume(attempt())).toMatchObject(refusal('usage_ledger_idempotency_conflict'))
    expect(f.facts()).toBe(1)
  })

  it('refuses absent or revoked State and forged C33 query evidence', async () => {
    const f = await setup()
    expect(await f.consumer.consume(attempt())).toMatchObject(refusal('usage_state_source_absent'))
    f.commit(attempt(), measurement('corrected'))
    expect(await f.consumer.consume(attempt())).toMatchObject(refusal('usage_correction_owner_required'))
    expect(f.facts()).toBe(0)
    f.commit()
    f.badQuery()
    expect(await f.consumer.consume(attempt())).toMatchObject(refusal('usage_fact_source_mismatch'))
    expect(f.rows()).toEqual([])
    f.revoke()
    expect(await f.consumer.consume(attempt())).toMatchObject({ ok: false })
  })

  it('refuses an existing reservation without its bounded-units owner', async () => {
    const f = await setup()
    f.commit()
    f.reserve(attempt(), {
      authorityId: 'budget',
      id: 'reservation',
      typeId: 'budget/reservation@1',
      revision: 1,
    })
    expect(await f.consumer.consume(attempt())).toMatchObject(refusal('usage_budget_owner_absent'))
    expect(f.facts()).toBe(0)
    expect(f.rows()).toEqual([])
  })

  it('settles only the original bounded-units reservation with the recorded Usage references', async () => {
    const f = await setup()
    f.commit()
    const ref = { authorityId: 'budget', typeId: 'budget/reservation@1', id: 'reservation', revision: 1 }
    f.reserve(attempt(), ref)
    const reservation: BudgetReservation = {
      ref,
      actionId: attempt().actionId,
      attemptId: attempt().attemptId,
      accountRef: { ...ref, id: 'account', typeId: 'budget/account@1' },
      parentReservationRef: null,
      scopeIds: ['run'],
      unitsByKind: measurement().quantities,
      held: null,
      priceVersion: null,
      status: 'settled',
      revision: 2,
      expiresAt: '2099-01-01T00:00:00.000Z',
      settledAmount: null,
      usageRefs: [],
    }
    let observed: BudgetReservation | undefined
    const consumer = assembleRuntimeUsageLedger(join(f.dir, 'bounded.sqlite'), {
      ...f.owners,
      budget: {
        async settle(input) {
          expect(input.reservationRef).toEqual(ref)
          observed = { ...reservation, usageRefs: input.usageRefs }
          return { ok: true, value: { reservation: observed, balance: null } }
        },
      },
    })
    try {
      const result = await consumer.consume(attempt())
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error.detailCode)
      expect(observed?.usageRefs).toEqual(result.value.factRefs)
      expect(f.rows()).toHaveLength(1)
    } finally {
      await consumer.close()
    }
  })

  it('cancels before consumption and refuses use after disposal', async () => {
    const f = await setup()
    f.commit()
    f.controller.abort()
    expect(await f.consumer.consume(attempt())).toMatchObject(refusal('usage_ledger_disposed'))
    expect(f.rows()).toEqual([])
    const consumer = assembleRuntimeUsageLedger(join(f.dir, 'unused.sqlite'))
    await consumer.close()
    await consumer.close()
    expect(await consumer.consume(attempt())).toMatchObject(refusal('usage_ledger_disposed'))
  })

  it('leaves original legacy ledger writes unchanged while the synthetic owner excludes a claimed runtime run', async () => {
    const f = await setup()
    const row: LedgerRow = {
      sessionKey: 'legacy-session',
      lane: 'main',
      turn: 1,
      step: 1,
      effectId: 'legacy-effect',
      purpose: 'inference',
      model: 'legacy-model',
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      credits: 2,
      creditSource: 'gateway',
    }
    expect(await f.legacyWrite('legacy-run', row)).toMatchObject({ ok: true })
    await f.legacyWrite('legacy-run', row)
    f.commit()
    expect(await f.consumer.consume(attempt())).toMatchObject({ ok: true })
    expect(await f.legacyWrite('run', { ...row, effectId: 'duplicate-runtime' })).toMatchObject(
      refusal('runtime_owned'),
    )
    expect(f.rows()).toHaveLength(2)
    expect(f.rows()).toContainEqual(expect.objectContaining({ effect_id: 'legacy-effect', credits: 2 }))
  })
})
