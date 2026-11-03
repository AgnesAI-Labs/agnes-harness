import { chargeToMicrocredits } from '@agnes/core-child-control/child/credits'
import { presetDefaults } from '@agnes/core-common/step/preset'
import type { Event } from '@agnes/core-common/types'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { MAINTENANCE_LANE } from '@agnes/core-ledger/reduce/state'
import type { InferenceEvent, Provider, RequestBody } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { RoleDelegation } from '../src/child/roles.js'
import { Kernel } from '../src/kernel.js'
import { MAINTENANCE_BUDGET_TOKENS, maintenanceCapCredits } from '../src/maintenance/budget.js'
import {
  createMaintenancePort,
  type MaintenanceRequest,
  maintenanceUnavailable,
} from '../src/maintenance/port.js'
import type { SessionImpl } from '../src/step/session.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, type Script, sentFor, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, openSession, readTool, testFsOps } from './helpers/open-session.js'
import { data, ofType, record, violations } from './helpers/side-call-session.js'

const PLAN = '{"summary":"none","edits":[]}'
const planner = record({
  id: 'planner',
  route: 'rsi',
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
})
// No price at all: the catalogue gives no usable rate. A price of zero is a known price (a free or local model).
const unpriced = record({
  id: 'local',
  route: 'rsi',
  cost: { input: Number.NaN, output: Number.NaN, cacheRead: 0, cacheWrite: 0 },
})
const free = record({ id: 'free', route: 'rsi' })
const plannerUsage = (credits = 0.001): InferenceEvent => ({
  type: 'usage',
  tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
  credits,
  creditSource: 'gateway',
})

const gate = () => {
  let open!: () => void
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

/**
 * A provider that answers the conversation from scripts and the maintenance route with a plan.
 * Either can be held at a gate, so a test decides what is in flight when.
 */
function provider(
  o: {
    plannerGate?: Promise<void>
    turnGate?: Promise<void>
    turnEntered?: () => void
    scripts?: Script[]
    plannerCredits?: number
    /** The provider reports tokens but no credits for the planning call. */
    plannerNoCredits?: boolean
    plannerHang?: boolean
  } = {},
) {
  const base = fakeProvider(o.scripts ?? [textTurn('answer')])
  const planned: RequestBody[] = []
  const p: Provider = {
    ...base,
    models: () => [planner, unpriced, free],
    async *infer(request, options) {
      if (request.route !== 'rsi') {
        o.turnEntered?.()
        await o.turnGate
        yield* base.infer(request, options)
        return
      }
      planned.push(request)
      yield sentFor(request)
      if (o.plannerHang) await new Promise<never>(() => undefined)
      await o.plannerGate
      yield { type: 'text_delta', delta: PLAN }
      yield o.plannerNoCredits
        ? ({
            type: 'usage',
            tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
          } as InferenceEvent)
        : plannerUsage(o.plannerCredits)
      yield { type: 'done', reason: 'stop' }
    },
  }
  return { provider: p, planned, base }
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
const onLane = (all: Event[]) => all.filter((row) => row.lane === MAINTENANCE_LANE)
const run = (session: SessionImpl) => session.run({ until: 'turn-end', signal: signal() })

describe('the maintenance port', () => {
  it('invokes a model with no open turn and settles once', async () => {
    const { provider: p, planned } = provider()
    const { session, log } = await openSession({ provider: p })
    const billing = vi.spyOn(session.d.runtime, 'billingRecord')
    const port = createMaintenancePort(session)
    expect(session.op()).toBeNull()

    const result = await port.invoke(request(), signal())
    expect(result).toMatchObject({
      outcome: 'ok',
      text: PLAN,
      dispatch: 'may-have-sent',
      usage: { input: 100, output: 10, credits: 0.001 },
    })
    expect(planned).toHaveLength(1)
    expect(planned[0]).toMatchObject({
      route: 'rsi',
      model: 'planner',
      tools: [],
      sampling: { maxTokens: 1024 },
    })

    const all = await rows(log)
    const lane = onLane(all)
    expect(lane.map((row) => row.type)).toEqual([
      'effect/intent',
      'x/core/maintenance-intent',
      'cost/ledger',
      'effect/settled',
      'x/core/maintenance-result',
    ])
    expect(data(ofType(lane, 'effect/settled')[0])).toMatchObject({
      effectId: 'maintenance:run-1',
      outcome: 'ok',
    })
    expect(data(ofType(lane, 'x/core/maintenance-result')[0])).toMatchObject({ outcome: 'ok', text: PLAN })
    // No turn was opened for it, nothing is left pending, and the ledger's own checks agree.
    expect(ofType(all, 'turn/start')).toEqual([])
    expect(session.op()).toBeNull()
    expect(session.state.pendingEffects.size).toBe(0)
    expect(violations(all)).toEqual([])
    expect(billing).toHaveBeenCalledTimes(1)
    expect(billing).toHaveBeenCalledWith(
      expect.objectContaining({ lane: MAINTENANCE_LANE, effectId: 'maintenance:run-1' }),
    )

    // The same run never sends twice; a retry is a new run.
    expect(await port.invoke(request(), signal())).toMatchObject({ outcome: 'error', reason: 'duplicate' })
    expect(planned).toHaveLength(1)
    expect(onLane(await rows(log))).toHaveLength(5)

    // The session's usage view counts the spend and shows it on its own line.
    const usage = (await session.projectUI()).usage
    expect((usage?.byLane as Record<string, unknown> | undefined)?.[MAINTENANCE_LANE]).toMatchObject({
      input: 100,
      output: 10,
      credits: 0.001,
    })
    expect(usage?.totals).toMatchObject({ input: 100, output: 10 })
    await session.close()
  })

  it('a user turn can start and end while maintenance is in flight', async () => {
    const held = gate()
    const { provider: p, planned, base } = provider({ plannerGate: held.wait })
    const { session, log } = await openSession({ provider: p })
    const port = createMaintenancePort(session)
    const call = port.invoke(request(), signal())
    await vi.waitFor(() => expect(planned).toHaveLength(1))
    expect(session.state.pendingEffects.has('maintenance:run-1')).toBe(true)
    // The turn's own view of effects never includes the maintenance call.
    expect(session.pendingEffects()).toEqual([])

    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    expect(session.op()).toBeNull()
    expect(base.calls).toBe(1)
    expect(session.state.pendingEffects.has('maintenance:run-1')).toBe(true)

    held.open()
    expect(await call).toMatchObject({ outcome: 'ok', text: PLAN })
    const all = await rows(log)
    const turnEnd = ofType(all, 'turn/end')[0]?.seq ?? 0
    const settled = ofType(onLane(all), 'effect/settled')[0]?.seq ?? 0
    expect(settled).toBeGreaterThan(turnEnd)
    expect(
      ofType(all, 'effect/settled').filter((row) => data(row).effectId === 'maintenance:run-1'),
    ).toHaveLength(1)
    expect(violations(all)).toEqual([])
    await session.close()
  })

  it('budget is charged to rsi:<sessionKey> and never to the user turn', async () => {
    const entered = gate()
    const turnHeld = gate()
    const { provider: p } = provider({ turnGate: turnHeld.wait, turnEntered: entered.open })
    const storage = new MemoryStorage()
    const reserve = vi.spyOn(storage, 'reserve')
    const preset = presetDefaults()
    preset.treeBudgetCredits = 10
    const { session } = await openSession({ provider: p, storage, preset })
    const port = createMaintenancePort(session)

    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const turn = run(session)
    await entered.wait
    const turnStart = session.state.openTurn.get('main')?.startSeq
    expect(await port.invoke(request(), signal())).toMatchObject({ outcome: 'ok' })
    turnHeld.open()
    expect(await turn).toMatchObject({ reason: 'completed' })

    const roots = reserve.mock.calls.map(([req]) => ({ root: req.rootTaskId, effectId: req.effectId }))
    expect(roots).toContainEqual({ root: 'rsi:k', effectId: 'maintenance:run-1' })
    // Every other hold is the turn's, and none of them is the maintenance call's.
    for (const { root, effectId } of roots.filter((entry) => entry.root !== 'rsi:k')) {
      expect(root).toBe(`k:main:${turnStart}`)
      expect(effectId).not.toContain('maintenance')
    }
    const cap = maintenanceCapCredits(planner) as number
    expect(await storage.projectTree('rsi:k')).toMatchObject({
      capMicro: BigInt(Math.floor(cap * 1_000_000)),
      settledMicro: chargeToMicrocredits(0.001),
      heldMicro: 0n,
    })
    // The turn's root carries the conversation's spend alone.
    expect(await storage.projectTree(`k:main:${turnStart}`)).toMatchObject({
      settledMicro: chargeToMicrocredits(1),
    })
    await session.close()
  })

  it('a model priced at zero is a known price: it plans unheld, its cost is zero, and the token budget still bounds it', async () => {
    const { provider: p, planned } = provider({ plannerCredits: 0 })
    const storage = new MemoryStorage()
    const reserve = vi.spyOn(storage, 'reserve')
    const { session, log } = await openSession({ provider: p, storage })
    const port = createMaintenancePort(session, { budgetTokens: 2000 })
    const target = { route: free.route, model: free.id }
    expect(await port.invoke(request({ target, maxOutputTokens: 1000 }), signal())).toMatchObject({
      outcome: 'ok',
      text: PLAN,
    })
    expect(reserve).not.toHaveBeenCalled()
    const [cost] = ofType(onLane(await rows(log)), 'cost/ledger')
    expect(data(cost)).toMatchObject({ credits: 0, tokens: { input: 100, output: 10 } })
    // 110 tokens are spent: a call that could take the rest of the budget and more is refused.
    expect(
      await port.invoke(request({ runId: 'run-2', target, maxOutputTokens: 1900 }), signal()),
    ).toMatchObject({ outcome: 'error', reason: 'budget', dispatch: 'not-sent' })
    expect(planned).toHaveLength(1)
    await session.close()
  })

  it('a run the user agreed to on an unknown price records its cost as unknown and is bounded by tokens', async () => {
    const { provider: p } = provider({ plannerNoCredits: true })
    const { session, log } = await openSession({ provider: p })
    const port = createMaintenancePort(session, { budgetTokens: 2000 })
    const target = { route: unpriced.route, model: unpriced.id }
    expect(
      await port.invoke(request({ target, allowUnpriced: true, maxOutputTokens: 1000 }), signal()),
    ).toMatchObject({ outcome: 'ok', usage: { input: 100, output: 10 } })
    const [cost] = ofType(onLane(await rows(log)), 'cost/ledger')
    expect(data(cost)).not.toHaveProperty('credits')
    expect(
      await port.invoke(
        request({ runId: 'run-2', target, allowUnpriced: true, maxOutputTokens: 1900 }),
        signal(),
      ),
    ).toMatchObject({ outcome: 'error', reason: 'budget' })
    await session.close()
  })

  it('unpriced models are refused for automatic planning', async () => {
    const { provider: p, planned } = provider()
    const storage = new MemoryStorage()
    const reserve = vi.spyOn(storage, 'reserve')
    const { session, log } = await openSession({ provider: p, storage })
    const port = createMaintenancePort(session)
    const target = { route: unpriced.route, model: unpriced.id }

    expect(await port.invoke(request({ target }), signal())).toEqual({
      outcome: 'error',
      reason: 'unpriced',
      dispatch: 'not-sent',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
    expect(
      await port.invoke(request({ runId: 'run-2', target: { route: 'rsi', model: 'missing' } }), signal()),
    ).toMatchObject({ outcome: 'error', reason: 'target-unknown' })
    expect(planned).toHaveLength(0)
    expect(onLane(await rows(log))).toEqual([])
    expect(reserve).not.toHaveBeenCalled()

    // A manual run the user agreed to pay an unknown price for is sent, recorded, and not held.
    expect(
      await port.invoke(request({ runId: 'run-3', target, allowUnpriced: true }), signal()),
    ).toMatchObject({
      outcome: 'ok',
      text: PLAN,
    })
    expect(reserve).not.toHaveBeenCalled()
    expect(ofType(onLane(await rows(log)), 'cost/ledger')).toHaveLength(1)
    await session.close()
  })

  it('pause does not block planning', async () => {
    const entered = gate()
    const turnHeld = gate()
    const { provider: p } = provider({ turnGate: turnHeld.wait, turnEntered: entered.open })
    const { session } = await openSession({ provider: p })
    const port = createMaintenancePort(session)
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const turn = run(session)
    await entered.wait
    await session.controls.apply('pause', actor, 'pause-1')
    expect(await session.controls.paused()).toBe(true)

    expect(await port.invoke(request(), signal())).toMatchObject({ outcome: 'ok', text: PLAN })
    // Planning changed nothing about the paused turn.
    expect(await session.controls.paused()).toBe(true)
    turnHeld.open()
    expect(await turn).toMatchObject({ reason: 'parked' })
    await session.close()
  })

  it('child sessions cannot start maintenance', async () => {
    // A spawned child records its parent; a role child opens through its own session factory with no
    // parent at all, and only its delegation says it is a child.
    const role = { ref: '@fixture/roles#reader', title: { en: 'Reader' } }
    const roleDelegation: RoleDelegation = {
      role,
      parentKey: 'parent',
      actor,
      tools: [],
      generationLimit: 3,
      maxFanOut: 2,
      permission: 'read-only',
      approvalPolicy: 'never',
      parentPolicy: 'default',
      parentTainted: false,
      sandboxRequired: true,
      filesystem: fakeSeams().sandbox.fsPolicy(),
    }
    const options = { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' }
    const base = provider({ scripts: [textTurn('done')] })
    let k!: Kernel
    k = Kernel.create({
      loops: defaultLoops(),
      storage: new MemoryStorage(),
      seams: fakeSeams(),
      provider: base.provider,
      contract: { contract_id: null, parser_version: '1' },
      preset: { ...presetDefaults(), generationLimit: 3, maxFanOut: 4, treeBudgetCredits: 100 },
      fsOps: testFsOps(),
      netFetch: async () => new Response(''),
      timers: noTimers,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      childRoles: {
        list: async () => [role],
        resolve: async () => ({
          role,
          open: (key, opts) => k.session(key, { ...options, ...opts, roleDelegation }),
        }),
      },
    })
    try {
      const parent = await k.session('parent', options)
      expect(maintenanceUnavailable(parent)).toBeUndefined()
      const spawned = await parent.d.children.create({ parent: 'parent', cwd: '/w', input: 'spawned' })
      const roled = await parent.d.children.createWithKind?.('spawn', {
        parent: 'parent',
        cwd: '/w',
        role: role.ref,
        input: 'role',
        resident: true,
      })
      const roleChild = k.get(roled?.key ?? '') as SessionImpl
      expect(roleChild.d.log.parent).toBeUndefined()
      expect(roleChild.state.session?.parent).toBeUndefined()
      for (const child of [k.get(spawned.key) as SessionImpl, roleChild]) {
        expect(maintenanceUnavailable(child)).toBe('child-session')
        expect(await createMaintenancePort(child).invoke(request(), signal())).toMatchObject({
          outcome: 'error',
          reason: 'child-session',
          dispatch: 'not-sent',
        })
      }
      expect(base.planned).toHaveLength(0)
    } finally {
      await k.close()
    }
  })

  it('maintenance spend never counts against the user turn budget', async () => {
    const entered = gate()
    const turnHeld = gate()
    const { provider: p } = provider({
      turnGate: turnHeld.wait,
      turnEntered: entered.open,
      scripts: [toolTurn('read', {}), textTurn('done')],
      plannerCredits: 50,
    })
    const preset = presetDefaults()
    preset.budget.perRequestCap = 10
    const registry = new (await import('../src/registry/tools.js')).ToolRegistry()
    registry.add(readTool(), { source: 's', trust: 'builtin' })
    const { session, log } = await openSession({ provider: p, preset, registry })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const turn = run(session)
    await entered.wait
    expect(await createMaintenancePort(session).invoke(request(), signal())).toMatchObject({
      outcome: 'ok',
      usage: { credits: 50 },
    })
    // The 50 credits are the session's spend, not the turn's: its budget gate still admits the tool call.
    expect(session.state.creditsUsed).toBe(0)
    turnHeld.open()
    expect(await turn).toMatchObject({ reason: 'completed' })
    const all = await rows(log)
    expect(ofType(all, 'tool/result').map((row) => data(row).isError)).toEqual([false])
    expect(session.state.creditsUsed).toBe(2)
    const usage = (await session.projectUI()).usage
    expect(usage?.credits).toMatchObject({ amount: 52 })
    await session.close()
  })

  it('an already-aborted caller signal writes nothing and sends nothing', async () => {
    const { provider: p, planned } = provider()
    const storage = new MemoryStorage()
    const reserve = vi.spyOn(storage, 'reserve')
    const { session, log } = await openSession({ provider: p, storage })
    const aborted = new AbortController()
    aborted.abort()
    expect(await createMaintenancePort(session).invoke(request(), aborted.signal)).toEqual({
      outcome: 'error',
      reason: 'cancelled',
      dispatch: 'not-sent',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
    expect(planned).toHaveLength(0)
    expect(onLane(await rows(log))).toEqual([])
    expect(reserve).not.toHaveBeenCalled()
    await session.close()
  })

  it('a call admitted after close has begun writes no intent and stays queued', async () => {
    const { provider: p, planned } = provider()
    const storage = new MemoryStorage()
    const { session } = await openSession({ provider: p, storage })
    const port = createMaintenancePort(session)
    const closing = session.close()
    expect(await port.invoke(request(), signal())).toMatchObject({
      outcome: 'error',
      reason: 'closing',
      dispatch: 'not-sent',
    })
    await closing
    expect(planned).toHaveLength(0)
    const reread = await openSession({ provider: p, storage, key: 'k', writerRunId: 'r2' })
    expect(onLane(await rows(reread.log))).toEqual([])
    await reread.session.close()
  })

  it('a caller cancel or a deadline mid-call settles once with the estimate, and the lease is held meanwhile', async () => {
    for (const cut of ['cancelled', 'deadline'] as const) {
      const { provider: p, planned } = provider({ plannerHang: true })
      const { session, log } = await openSession({ provider: p })
      const original = session.d.log.holdRenewal.bind(session.d.log)
      const released = vi.fn()
      const hold = vi.spyOn(session.d.log, 'holdRenewal').mockImplementation(() => {
        const release = original()
        return () => {
          released()
          release()
        }
      })
      const caller = new AbortController()
      const call = createMaintenancePort(session).invoke(
        request({ deadlineMs: cut === 'deadline' ? 100 : 60_000 }),
        caller.signal,
      )
      await vi.waitFor(() => expect(planned).toHaveLength(1))
      expect(hold).toHaveBeenCalledTimes(1)
      expect(released).not.toHaveBeenCalled()
      if (cut === 'cancelled') caller.abort()
      expect(await call).toMatchObject({ outcome: 'error', reason: cut, dispatch: 'may-have-sent' })
      expect(released).toHaveBeenCalledTimes(1)
      const lane = onLane(await rows(log))
      expect(ofType(lane, 'effect/settled').map((row) => data(row).outcome)).toEqual(['error'])
      expect(ofType(lane, 'cost/ledger').map((row) => data(row))).toEqual([
        expect.objectContaining({ interrupted: true, creditSource: 'estimated' }),
      ])
      await session.close()
    }
  })

  it('a user turn cancelled while maintenance is in flight leaves the call to finish on its own', async () => {
    const entered = gate()
    const planHeld = gate()
    const { provider: p, planned } = provider({
      plannerGate: planHeld.wait,
      turnEntered: entered.open,
      turnGate: new Promise<void>(() => undefined),
    })
    const { session, log } = await openSession({ provider: p })
    const call = createMaintenancePort(session).invoke(request(), signal())
    await vi.waitFor(() => expect(planned).toHaveLength(1))
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const turn = run(session)
    await entered.wait
    await session.abort(actor)
    await turn.catch(() => undefined)
    expect(session.op()).toBeNull()
    // Draining the cancelled turn settled none of the maintenance call's effects.
    expect(session.state.pendingEffects.has('maintenance:run-1')).toBe(true)
    planHeld.open()
    expect(await call).toMatchObject({ outcome: 'ok', text: PLAN })
    const all = await rows(log)
    expect(ofType(all, 'effect/settled').filter((row) => data(row).effectId === 'maintenance:run-1')).toEqual(
      [expect.objectContaining({ data: expect.objectContaining({ outcome: 'ok' }) })],
    )
    expect(violations(all)).toEqual([])
    await session.close()
  })

  it('the budget never allows more tokens than its count, and a cap too small to hold is unpriced', () => {
    // Output five times dearer than input: whatever the mix, the credits cap buys at most the budget.
    const skewed = record({
      id: 'skewed',
      route: 'rsi',
      cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
    })
    const cap = maintenanceCapCredits(skewed) as number
    for (const share of [0, 0.25, 0.5, 0.75, 1]) {
      const perToken = (share * skewed.cost.input + (1 - share) * skewed.cost.output) / 1_000_000
      expect(cap / perToken).toBeLessThanOrEqual(MAINTENANCE_BUDGET_TOKENS + 1e-6)
    }
    expect(Math.round((cap / skewed.cost.input) * 1_000_000)).toBe(MAINTENANCE_BUDGET_TOKENS)
    const tiny = record({
      id: 'tiny',
      route: 'rsi',
      cost: { input: 1e-9, output: 1e-9, cacheRead: 0, cacheWrite: 0 },
    })
    expect(maintenanceCapCredits(tiny)).toBeUndefined()
  })
})
