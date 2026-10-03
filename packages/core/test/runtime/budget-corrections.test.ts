import { describe, expect, it } from 'vitest'
import { budgetContext, budgetRequest } from './fixtures/budget-authority.js'
import { budgetCorrectionFixture } from './fixtures/budget-correction-authority.js'

const account = (f: ReturnType<typeof budgetCorrectionFixture>) =>
  f.get<{ held: string; settled: string; units: { token: { settled: string } } }>('account', 'root')!
describe('default Budget original immutable settlement corrections', () => {
  it('applies 60 to 30 delta, preserves original receipt bytes and replays both after cold reopen', async () => {
    const f = budgetCorrectionFixture(),
      r = (await f.operations.reserve(budgetRequest('a'), budgetContext)).reservation,
      first = f.observe(r, '6'),
      settled = await f.operations.settle(first, budgetContext),
      prior = f.latest(r.ref)!,
      bytes = f.events()[0]!.body,
      correction = f.observe(settled.reservation, '3', prior.eventDigest),
      corrected = await f.operations.settle(correction, budgetContext)
    expect(account(f).settled).toBe('30')
    expect(account(f).held).toBe('0')
    expect(account(f).units.token.settled).toBe('3')
    expect(corrected.reservation.settledAmount?.units).toBe('30')
    expect(f.events()[0]!.body).toBe(bytes)
    const file = f.file
    f.close()
    const cold = budgetCorrectionFixture(file)
    // Each original source remains separately selectable by its authentic persisted input.
    const original = cold.get<{ value: Parameters<typeof cold.measurement>[0] }>(
      'verified-charge',
      JSON.parse(bytes).settlement.sourceDigest,
    )!
    cold.measurement(original.value)
    expect(await cold.operations.settle(first, budgetContext)).toEqual(settled)
    const newer = JSON.parse(cold.events()[1]!.body).settlement
    cold.measurement(newer)
    expect(await cold.operations.settle(correction, budgetContext)).toEqual(corrected)
    expect(cold.events()).toHaveLength(2)
    cold.close()
  })
  it('keeps unknown hold until genuine replacement proves known usage', async () => {
    const f = budgetCorrectionFixture(),
      r = (await f.operations.reserve(budgetRequest('a'), budgetContext)).reservation,
      unknown = await f.operations.settle(f.observe(r, '4', null, 'unknown'), budgetContext)
    expect(account(f).held).toBe('40')
    expect(account(f).settled).toBe('0')
    const known = await f.operations.settle(
      f.observe(unknown.reservation, '3', f.latest(r.ref)!.eventDigest),
      budgetContext,
    )
    expect(known.reservation.status).toBe('settled')
    expect(account(f).held).toBe('0')
    expect(account(f).settled).toBe('30')
    f.close()
  })
  it('rejects stale correction CAS and a guessed replacement without writes', async () => {
    const f = budgetCorrectionFixture(),
      r = (await f.operations.reserve(budgetRequest('a'), budgetContext)).reservation,
      first = await f.operations.settle(f.observe(r, '4'), budgetContext),
      old = f.latest(r.ref)!.eventDigest,
      one = f.observe(first.reservation, '3', old)
    await f.operations.settle(one, budgetContext)
    const writes = f.writes()
    await expect(f.operations.settle(f.observe(first.reservation, '2', old), budgetContext)).rejects.toThrow(
      'exact original',
    )
    await expect(
      f.operations.settle(f.observe(first.reservation, '2', 'a'.repeat(64)), budgetContext),
    ).rejects.toThrow('exact original')
    expect(f.writes()).toBe(writes)
    expect(f.events()).toHaveLength(2)
    f.close()
  })
  it('allows exactly one of two genuine concurrent replacements of the same original event', async () => {
    const f = budgetCorrectionFixture(),
      r = (await f.operations.reserve(budgetRequest('a'), budgetContext)).reservation,
      first = await f.operations.settle(f.observe(r, '4'), budgetContext),
      old = f.latest(r.ref)!.eventDigest,
      left = f.observe(first.reservation, '3', old),
      leftSource = f.get<{ value: Parameters<typeof f.measurement>[0] }>(
        'usage-observation',
        'selected',
      )!.value,
      right = f.observe(first.reservation, '2', old),
      rightSource = f.get<{ value: Parameters<typeof f.measurement>[0] }>(
        'usage-observation',
        'selected',
      )!.value
    const results = await Promise.allSettled([
      Promise.resolve().then(() => {
        f.measurement(leftSource)
        return f.operations.settle(left, budgetContext)
      }),
      Promise.resolve().then(() => {
        f.measurement(rightSource)
        return f.operations.settle(right, budgetContext)
      }),
    ])
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1)
    expect(f.events()).toHaveLength(2)
    expect(account(f).settled).toBe('30')
    f.close()
  })
  it('rolls back immutable append and delta after final qualification withdrawal', async () => {
    const f = budgetCorrectionFixture(),
      r = (await f.operations.reserve(budgetRequest('a'), budgetContext)).reservation,
      first = await f.operations.settle(f.observe(r, '4'), budgetContext),
      next = f.observe(first.reservation, '2', f.latest(r.ref)!.eventDigest),
      before = f.writes()
    f.beforeCommit(f.revoke)
    await expect(f.operations.settle(next, budgetContext)).rejects.toThrow('qualification')
    expect(f.writes()).toBe(before)
    expect(f.events()).toHaveLength(1)
    expect(account(f).settled).toBe('40')
    f.close()
  })
  it('does not reduce unrelated owners or accept lost original charge', async () => {
    const f = budgetCorrectionFixture(),
      r = (await f.operations.reserve(budgetRequest('a'), budgetContext)).reservation,
      first = await f.operations.settle(f.observe(r, '4'), budgetContext),
      head = f.latest(r.ref)!.eventDigest
    const other = (await f.operations.reserve(budgetRequest('b', '1', '10'), budgetContext)).reservation
    await f.operations.settle(f.observe(other, '1', null, 'known', ['actual-request-two']), budgetContext)
    expect(account(f).settled).toBe('50')
    await f.operations.settle(f.observe(first.reservation, '2', head), budgetContext)
    expect(account(f).settled).toBe('30')
    const current = f.latest(r.ref)!,
      a = f.tx.account('root')!
    f.put('account', 'root', { ...a, settled: '1' })
    const writes = f.writes()
    await expect(
      f.operations.settle(
        f.observe(current.event.result.reservation, '0', current.eventDigest),
        budgetContext,
      ),
    ).rejects.toThrow('missing from ancestor')
    expect(f.writes()).toBe(writes)
    f.close()
  })
  it('fails closed on altered full immutable event bytes', async () => {
    const f = budgetCorrectionFixture(),
      r = (await f.operations.reserve(budgetRequest('a'), budgetContext)).reservation,
      first = await f.operations.settle(f.observe(r, '4'), budgetContext),
      next = f.observe(first.reservation, '3', f.latest(r.ref)!.eventDigest)
    f.db.prepare('UPDATE settlement_events SET body=? WHERE seq=1').run('{}')
    await expect(f.operations.settle(next, budgetContext)).rejects.toThrow('digest')
    expect(f.events()).toHaveLength(1)
    f.close()
  })
})
