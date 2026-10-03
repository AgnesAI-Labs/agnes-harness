import { describe, expect, it } from 'vitest'
import type { BudgetAccount } from '../../src/runtime/budget/reservations.js'
import { budgetContext } from './fixtures/budget-authority.js'
import { budgetFundingFixture } from './fixtures/budget-funding-authority.js'

const a = (f: ReturnType<typeof budgetFundingFixture>, id = 'root') => f.get<BudgetAccount>('account', id)!
const observe = (
  f: ReturnType<typeof budgetFundingFixture>,
  r: Parameters<typeof f.observe>[0],
  units: string,
) => f.observe(r, units, null, 'known', [`original-request-${r.actionId}`])
describe('default Budget actual different and nested funding sources', () => {
  it('holds shared ancestors once, constrains child-exclusive accounts and settles the actual child chain', async () => {
    const f = budgetFundingFixture()
    f.addAction('p')
    f.addAction('c', 'other-leaf', 'p')
    const p = await f.operations.reserve(f.request('p', '8', '80'), budgetContext),
      c = await f.operations.reserve(f.request('c', '4', '40', p.reservation.ref), budgetContext)
    expect(a(f).held).toBe('80')
    expect(a(f, 'leaf').held).toBe('80')
    expect(a(f, 'other-leaf').held).toBe('40')
    const before = f.writes()
    await expect(f.operations.settle(observe(f, p.reservation, '8'), budgetContext)).rejects.toThrow(
      'active children',
    )
    expect(f.writes()).toBe(before)
    const settled = await f.operations.settle(observe(f, c.reservation, '4'), budgetContext)
    expect(settled.reservation.status).toBe('settled')
    expect(a(f).held).toBe('40')
    expect(a(f).settled).toBe('40')
    expect(a(f, 'leaf').settled).toBe('0')
    expect(a(f, 'other-leaf').settled).toBe('40')
    await f.operations.settle(observe(f, p.reservation, '4'), budgetContext)
    expect(a(f).settled).toBe('80')
    expect(a(f).held).toBe('0')
    f.close()
  })
  it('reconstructs three levels of authentic lineage after cold reopen without double consuming allocation', async () => {
    const f = budgetFundingFixture()
    f.addAction('p')
    f.addAction('c', 'other-leaf', 'p')
    f.addAction('g', 'leaf', 'c')
    const p = await f.operations.reserve(f.request('p', '8', '80'), budgetContext),
      c = await f.operations.reserve(f.request('c', '4', '40', p.reservation.ref), budgetContext),
      request = f.request('g', '2', '20', c.reservation.ref),
      g = await f.operations.reserve(request, budgetContext)
    expect(a(f).held).toBe('80')
    expect(a(f, 'other-leaf').held).toBe('40')
    expect(a(f, 'leaf').held).toBe('80')
    const file = f.file
    f.close()
    const cold = budgetFundingFixture(file)
    expect(await cold.operations.reserve(request, budgetContext)).toEqual(g)
    await cold.operations.settle(observe(cold, g.reservation, '2'), budgetContext)
    expect(a(cold).held).toBe('60')
    expect(cold.get<{ moneyHeld: string }>('reservation', p.reservation.ref.id)?.moneyHeld).toBe('60')
    await cold.operations.settle(observe(cold, c.reservation, '2'), budgetContext)
    await cold.operations.settle(observe(cold, p.reservation, '4'), budgetContext)
    expect(a(cold).settled).toBe('80')
    expect(a(cold).held).toBe('0')
    expect(cold.events()).toHaveLength(6)
    cold.close()
  })
  it('does not grant parent funds from a DTO and rejects missing genuine original reserve source', async () => {
    const f = budgetFundingFixture()
    f.addAction('p')
    f.addAction('unrelated', 'other-leaf')
    const p = await f.operations.reserve(f.request('p', '8', '80'), budgetContext),
      before = f.writes()
    await expect(
      f.operations.reserve(f.request('unrelated', '2', '20', p.reservation.ref), budgetContext),
    ).rejects.toThrow('child-parent')
    expect(f.writes()).toBe(before)
    f.addAction('c', 'other-leaf', 'p')
    f.db.exec('DELETE FROM funding_events')
    await expect(
      f.operations.reserve(f.request('c', '2', '20', p.reservation.ref), budgetContext),
    ).rejects.toThrow('original funding reserve event missing')
    expect(f.writes()).toBe(before)
    f.close()
  })
  it('retains unknown hold and active-child gate, but true not-executed releases only exclusive child holds', async () => {
    const f = budgetFundingFixture()
    f.addAction('p')
    f.addAction('c', 'other-leaf', 'p')
    const p = await f.operations.reserve(f.request('p', '8', '80'), budgetContext),
      c = await f.operations.reserve(f.request('c', '4', '40', p.reservation.ref), budgetContext),
      unknown = {
        reservationRef: c.reservation.ref,
        evidenceRef: f.reconciliationProof(c.reservation.ref.id, {
          kind: 'unknown',
          sourceDigest: 'authentic-not-found',
        }),
      }
    await f.operations.reconcile(unknown, budgetContext)
    expect(a(f).held).toBe('80')
    expect(a(f, 'other-leaf').held).toBe('40')
    const parentProof = f.reconciliationProof(p.reservation.ref.id, {
      kind: 'not-executed',
      sourceDigest: 'authentic-parent-negative',
    })
    await expect(
      f.operations.reconcile({ reservationRef: p.reservation.ref, evidenceRef: parentProof }, budgetContext),
    ).rejects.toThrow('this state')
    const released = await f.operations.reconcile(
      {
        reservationRef: c.reservation.ref,
        evidenceRef: f.reconciliationProof(c.reservation.ref.id, {
          kind: 'not-executed',
          sourceDigest: 'authentic-child-negative',
        }),
      },
      budgetContext,
    )
    expect(released.reservation.status).toBe('released')
    expect(a(f).held).toBe('80')
    expect(a(f, 'leaf').held).toBe('80')
    expect(a(f, 'other-leaf').held).toBe('0')
    expect(
      f.get<{ moneyHeld: string; allocations: unknown }>('reservation', p.reservation.ref.id),
    ).toMatchObject({ moneyHeld: '80', allocations: {} })
    f.close()
  })
  it('rejects parent oversubscription and graph issuance changes with zero write', async () => {
    const f = budgetFundingFixture()
    f.addAction('p')
    f.addAction('c', 'other-leaf', 'p')
    f.addAction('s', 'other-leaf', 'p')
    const p = await f.operations.reserve(f.request('p', '8', '80'), budgetContext)
    await f.operations.reserve(f.request('c', '6', '60', p.reservation.ref), budgetContext)
    const before = f.writes()
    await expect(
      f.operations.reserve(f.request('s', '4', '40', p.reservation.ref), budgetContext),
    ).rejects.toThrow('exhausted')
    expect(f.writes()).toBe(before)
    f.put('account', 'other-leaf', { ...a(f, 'other-leaf'), cap: '1' })
    await expect(
      f.operations.reserve(f.request('s', '1', '10', p.reservation.ref), budgetContext),
    ).rejects.toThrow('graph changed')
    expect(f.writes()).toBe(before)
    f.close()
  })
  it('permits exactly one concurrent sibling when the parent can fund only one', async () => {
    const f = budgetFundingFixture()
    f.addAction('p')
    f.addAction('c', 'other-leaf', 'p')
    f.addAction('s', 'other-leaf', 'p')
    const p = await f.operations.reserve(f.request('p', '8', '80'), budgetContext),
      results = await Promise.allSettled([
        f.operations.reserve(f.request('c', '6', '60', p.reservation.ref), budgetContext),
        f.operations.reserve(f.request('s', '6', '60', p.reservation.ref), budgetContext),
      ])
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1)
    expect(a(f).held).toBe('80')
    expect(a(f, 'other-leaf').held).toBe('60')
    expect(f.events()).toHaveLength(2)
    f.close()
  })
  it('refuses terminal use of a new funded projection if the original immutable source disappeared', async () => {
    const f = budgetFundingFixture()
    f.addAction('p')
    f.addAction('c', 'other-leaf', 'p')
    const p = await f.operations.reserve(f.request('p', '8', '80'), budgetContext),
      c = await f.operations.reserve(f.request('c', '4', '40', p.reservation.ref), budgetContext),
      input = observe(f, c.reservation, '4'),
      before = f.writes()
    f.db.exec('DELETE FROM funding_events')
    await expect(f.operations.settle(input, budgetContext)).rejects.toThrow('original funding event missing')
    expect(f.writes()).toBe(before)
    expect(a(f).held).toBe('80')
    expect(a(f, 'other-leaf').held).toBe('40')
    f.close()
  })
  it('does not reconsume parent funds when genuine child known usage is corrected', async () => {
    const f = budgetFundingFixture()
    f.addAction('p')
    f.addAction('c', 'other-leaf', 'p')
    const p = await f.operations.reserve(f.request('p', '8', '80'), budgetContext),
      c = await f.operations.reserve(f.request('c', '4', '40', p.reservation.ref), budgetContext),
      settled = await f.operations.settle(observe(f, c.reservation, '4'), budgetContext),
      parent = f.get('reservation', p.reservation.ref.id),
      replacement = f.latest(c.reservation.ref)!.eventDigest,
      correction = f.observe(settled.reservation, '2', replacement, 'known', [
        `original-request-${c.reservation.actionId}`,
      ])
    await f.operations.settle(correction, budgetContext)
    expect(f.get('reservation', p.reservation.ref.id)).toEqual(parent)
    expect(a(f).held).toBe('40')
    expect(a(f).settled).toBe('20')
    expect(a(f, 'other-leaf').settled).toBe('20')
    f.close()
  })
  it('enforces the original child-exclusive cap even when shared parent funds remain available', async () => {
    const f = budgetFundingFixture(undefined, { exclusiveCap: '20' })
    f.addAction('p')
    f.addAction('c', 'other-leaf', 'p')
    const p = await f.operations.reserve(f.request('p', '8', '80'), budgetContext),
      before = f.writes()
    await expect(
      f.operations.reserve(f.request('c', '4', '40', p.reservation.ref), budgetContext),
    ).rejects.toThrow('ancestor monetary')
    expect(f.writes()).toBe(before)
    expect(f.events()).toHaveLength(1)
    expect(a(f, 'other-leaf').held).toBe('0')
    f.close()
  })
  it('rejects original context scope mutation and abort at the last actual COMMIT fence', async () => {
    for (const kind of ['scope', 'abort'] as const) {
      const f = budgetFundingFixture()
      f.addAction('p')
      f.addAction('c', 'other-leaf', 'p')
      const p = await f.operations.reserve(f.request('p', '8', '80'), budgetContext),
        before = f.writes(),
        cancel = new AbortController(),
        context = { ...budgetContext, scope: { ...budgetContext.scope }, signal: cancel.signal }
      f.beforeCommit(() => {
        if (kind === 'scope') context.scope.installationId = 'another'
        else cancel.abort()
      })
      await expect(
        f.operations.reserve(f.request('c', '4', '40', p.reservation.ref), context),
      ).rejects.toThrow(/qualification/)
      expect(f.writes()).toBe(before)
      expect(f.events()).toHaveLength(1)
      expect(a(f, 'other-leaf').held).toBe('0')
      f.close()
    }
  })
  it('rolls back both ancestor allocations and immutable source on final owner withdrawal', async () => {
    const f = budgetFundingFixture()
    f.addAction('p')
    f.addAction('c', 'other-leaf', 'p')
    const p = await f.operations.reserve(f.request('p', '8', '80'), budgetContext),
      before = f.writes()
    f.beforeCommit(f.revoke)
    await expect(
      f.operations.reserve(f.request('c', '4', '40', p.reservation.ref), budgetContext),
    ).rejects.toThrow('qualification')
    expect(f.writes()).toBe(before)
    expect(f.events()).toHaveLength(1)
    expect(a(f, 'other-leaf').held).toBe('0')
    expect(f.get<{ allocations: unknown }>('reservation', p.reservation.ref.id)?.allocations).toEqual({})
    f.close()
  })
  it('rejects full-source byte corruption rather than trusting projection indexes', async () => {
    const f = budgetFundingFixture()
    f.addAction('p')
    f.addAction('c', 'other-leaf', 'p')
    const p = await f.operations.reserve(f.request('p', '8', '80'), budgetContext),
      before = f.writes()
    f.db.prepare('UPDATE funding_events SET body=? WHERE seq=1').run('{}')
    await expect(
      f.operations.reserve(f.request('c', '4', '40', p.reservation.ref), budgetContext),
    ).rejects.toThrow('bytes')
    expect(f.writes()).toBe(before)
    f.close()
  })
})
