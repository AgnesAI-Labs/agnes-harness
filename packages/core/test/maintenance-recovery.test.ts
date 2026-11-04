import type { Event } from '@agnes/core-common/types'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { MAINTENANCE_LANE } from '@agnes/core-ledger/reduce/state'
import type { InferenceEvent, Provider, RequestBody } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { claimMaintenance } from '../src/maintenance/in-flight.js'
import { createMaintenancePort, type MaintenanceRequest } from '../src/maintenance/port.js'
import { recoverMaintenance } from '../src/maintenance/recovery.js'
import { fakeProvider, sentFor, textTurn } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'
import { data, ofType, record, violations } from './helpers/side-call-session.js'

const PLAN = '{"summary":"none","edits":[]}'
const planner = record({
  id: 'planner',
  route: 'rsi',
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
})
const never = () => new Promise<never>(() => undefined)
const opener = () => {
  let open!: () => void
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

/**
 * The conversation answers from scripts; the maintenance route sends its stamp, then waits at the
 * gate (forever when none is given) before it answers with a plan.
 */
function provider(o: { hang?: boolean; gate?: Promise<void>; turnHang?: boolean } = {}) {
  const base = fakeProvider([textTurn('answer')])
  const planned: RequestBody[] = []
  const p: Provider = {
    ...base,
    models: () => [planner],
    async *infer(request, options) {
      if (request.route !== 'rsi') {
        if (o.turnHang) {
          yield sentFor(request)
          await never()
        }
        yield* base.infer(request, options)
        return
      }
      planned.push(request)
      yield sentFor(request)
      if (o.hang) await never()
      await o.gate
      yield { type: 'text_delta', delta: PLAN }
      yield {
        type: 'usage',
        tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
        credits: 0.001,
        creditSource: 'gateway',
      } satisfies InferenceEvent
      yield { type: 'done', reason: 'stop' }
    },
  }
  return { provider: p, planned }
}

const request = (over: Partial<MaintenanceRequest> = {}): MaintenanceRequest => ({
  runId: 'run-1',
  system: 'You plan refinements.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'evidence' }] }],
  maxOutputTokens: 1024,
  deadlineMs: 60_000,
  target: { route: planner.route, model: planner.id },
  ...over,
})
const signal = () => new AbortController().signal
const rows = (log: { lastSeq: number; scan(q: object): Promise<Event[]> }) => log.scan({ toSeq: log.lastSeq })
const lane = (all: Event[]) => all.filter((row) => row.lane === MAINTENANCE_LANE)
const ofEffect = (all: Event[], type: string, effectId = 'maintenance:run-1') =>
  ofType(all, type).filter((row) => data(row).effectId === effectId)

/** Starts a call that never answers, then kills the process: the log goes, nothing settles. */
async function crashMidCall(o: { withTurn?: boolean } = {}) {
  const storage = new MemoryStorage()
  const a = await openSession({ provider: provider({ hang: true, turnHang: true }).provider, storage })
  if (o.withTurn) {
    await a.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    void a.session.run({ until: 'turn-end', signal: signal() }).catch(() => undefined)
    await vi.waitFor(() => expect(a.session.state.openStep.has('main')).toBe(true))
  }
  void createMaintenancePort(a.session)
    .invoke(request(), signal())
    .catch(() => undefined)
  await vi.waitFor(() => expect(a.session.state.pendingEffects.has('maintenance:run-1')).toBe(true))
  await a.log.close()
  return storage
}

describe('maintenance recovery', () => {
  it('a crash mid-call is settled as unknown on reopen, with no double charge', async () => {
    const storage = await crashMidCall({ withTurn: true })
    const reserve = vi.spyOn(storage, 'reserve')
    const { provider: p, planned } = provider()
    const b = await openSession({ provider: p, storage, key: 'k', writerRunId: 'r2' })
    const billing = vi.spyOn(b.session.d.runtime, 'billingRecord')
    const report = await b.session.resume()
    // The turn's own recovery never sees the maintenance call.
    expect(report.actions.map((action) => action.effectId)).not.toContain('maintenance:run-1')

    const all = await rows(b.log)
    const intent = data(ofEffect(all, 'x/core/maintenance-intent')[0])
    expect(ofEffect(all, 'effect/settled').map((row) => data(row).outcome)).toEqual(['unknown'])
    const costs = ofEffect(all, 'cost/ledger')
    expect(costs).toHaveLength(1)
    expect(costs[0]?.lane).toBe(MAINTENANCE_LANE)
    expect(data(costs[0])).toMatchObject({
      purpose: 'side-call',
      tokens: { input: intent.inputTokens, output: 0 },
      credits: intent.projectedCredits,
      creditSource: 'estimated',
      interrupted: true,
    })
    expect(data(ofEffect(all, 'x/core/maintenance-result')[0])).toMatchObject({
      runId: 'run-1',
      outcome: 'unknown',
      reason: 'interrupted',
    })
    expect(b.session.state.pendingEffects.has('maintenance:run-1')).toBe(false)
    expect(violations(all)).toEqual([])

    // Nothing is resent, charged again, or recovered twice: not by another sweep, not by a retry
    // of the same run, and not by the next open.
    expect(await recoverMaintenance(b.session)).toBe(0)
    expect(await createMaintenancePort(b.session).invoke(request(), signal())).toMatchObject({
      reason: 'duplicate',
    })
    expect(planned).toHaveLength(0)
    expect(billing).not.toHaveBeenCalledWith(expect.objectContaining({ lane: MAINTENANCE_LANE }))
    expect(reserve).not.toHaveBeenCalled()
    await b.session.close()
    const c = await openSession({ provider: p, storage, key: 'k', writerRunId: 'r3' })
    await c.session.resume()
    expect(lane(await rows(c.log))).toHaveLength(lane(all).length)
    await c.session.close()
  })

  it('idle sessions are swept on open', async () => {
    const storage = await crashMidCall()
    const { provider: p } = provider()
    const b = await openSession({ provider: p, storage, key: 'k', writerRunId: 'r2' })
    expect(b.session.op()).toBeNull()
    // An idle ledger resumes to idle, and the open still settles what the dead process left.
    expect(await b.session.resume()).toEqual({ state: 'idle', actions: [] })
    expect(ofEffect(await rows(b.log), 'effect/settled').map((row) => data(row).outcome)).toEqual(['unknown'])

    // A call this process is running is never mistaken for a stranded one.
    const held = opener()
    const gate = held.wait
    const live = provider({ gate })
    const c = await openSession({ provider: live.provider, storage: new MemoryStorage() })
    const call = createMaintenancePort(c.session).invoke(request({ runId: 'run-live' }), signal())
    await vi.waitFor(() => expect(live.planned).toHaveLength(1))
    expect(await c.session.resume()).toEqual({ state: 'idle', actions: [] })
    expect(await recoverMaintenance(c.session)).toBe(0)
    held.open()
    expect(await call).toMatchObject({ outcome: 'ok', text: PLAN })
    expect(
      ofEffect(await rows(c.log), 'effect/settled', 'maintenance:run-live').map((row) => data(row).outcome),
    ).toEqual(['ok'])
    await b.session.close()
    await c.session.close()
  })

  it('recovery never settles a call this process claims while it waits for the lock', async () => {
    const storage = await crashMidCall()
    const b = await openSession({ provider: provider().provider, storage, key: 'k', writerRunId: 'r2' })
    // Hold the session lock, so recovery sees the stranded intent first and runs its body later.
    const lock = opener()
    const holding = b.session.locked(() => lock.wait)
    const sweep = recoverMaintenance(b.session)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const claim = claimMaintenance(b.session, 'maintenance:run-1', () => undefined)
    if (typeof claim === 'string') throw new Error(`claim refused: ${claim}`)
    lock.open()
    await holding
    expect(await sweep).toBe(0)
    expect(ofEffect(await rows(b.log), 'effect/settled')).toEqual([])
    claim.release()
    expect(await recoverMaintenance(b.session)).toBe(1)
    await b.session.close()
  })

  it('close waits for maintenance then leaves the run queued', async () => {
    // A call in flight when the session closes finishes and settles before the log is released.
    const held = opener()
    const gate = held.wait
    const live = provider({ gate })
    const first = new MemoryStorage()
    const a = await openSession({ provider: live.provider, storage: first })
    const port = createMaintenancePort(a.session)
    const call = port.invoke(request(), signal())
    await vi.waitFor(() => expect(live.planned).toHaveLength(1))
    let closed = false
    const closing = a.session.close().then(() => {
      closed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(closed).toBe(false)
    // A run that had not sent its call yet is refused without a row, so it stays queued for the
    // next open.
    expect(await port.invoke(request({ runId: 'run-2' }), signal())).toEqual({
      outcome: 'error',
      reason: 'closing',
      dispatch: 'not-sent',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
    held.open()
    expect(await call).toMatchObject({ outcome: 'ok', text: PLAN })
    await closing
    // The closed writer is gone; the next one reads what it left.
    const reread = await openSession({ provider: live.provider, storage: first, key: 'k', writerRunId: 'r2' })
    const all = await rows(reread.log)
    expect(ofEffect(all, 'effect/settled').map((row) => data(row).outcome)).toEqual(['ok'])
    expect(ofType(lane(all), 'effect/intent')).toHaveLength(1)
    await reread.session.close()

    // One that outlives the drain bound is cut: its spend is recorded and its result is unknown, so
    // the next open finds nothing left to settle and nothing is charged twice.
    const storage = new MemoryStorage()
    const hung = provider({ hang: true })
    const b = await openSession({ provider: hung.provider, storage, closeDrainMs: 50 })
    const cut = createMaintenancePort(b.session).invoke(request(), signal())
    await vi.waitFor(() => expect(hung.planned).toHaveLength(1))
    await b.session.close()
    expect(await cut).toMatchObject({ outcome: 'unknown', reason: 'closing', dispatch: 'may-have-sent' })
    const c = await openSession({ provider: hung.provider, storage, key: 'k', writerRunId: 'r2' })
    const settledRows = await rows(c.log)
    expect(ofEffect(settledRows, 'effect/settled').map((row) => data(row).outcome)).toEqual(['unknown'])
    expect(data(ofEffect(settledRows, 'cost/ledger')[0])).toMatchObject({ interrupted: true })
    expect(violations(settledRows)).toEqual([])
    expect(await recoverMaintenance(c.session)).toBe(0)
    await c.session.close()
  })
})
