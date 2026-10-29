import assert from 'node:assert/strict'
import {
  createWorkspaceInvocationPort,
  type Event,
  Kernel,
  LoopRegistry,
  presetDefaults,
  type SessionImpl,
  scanAll,
} from '@agnes/core'
import {
  actor,
  fakeProvider,
  fakeSeams,
  fencedFs,
  MemoryStorage,
  noTimers,
  shellTool,
  testFsPolicy,
  textTurn,
  toolTurn,
} from '@agnes/core/testkit'
import type {
  LoopCheckpoint,
  LoopContext,
  LoopDriver,
  LoopFactory,
  LoopSideCallPort,
  LoopStepOutcome,
  PreparedSideCall,
  SideCallOptions,
  SideCallResult,
  SideCallStatus,
} from '@agnes/extension-api'

export interface LoopContractReport {
  loop: { id: string; version: string }
  checks: string[]
}

export interface LoopContractOptions {
  /**
   * Also check side model calls. The suite makes calls through the loop's own `ctx.sideCall` against
   * a payload-only adapter it defines, then lets the loop finish the turn. It checks the success, the
   * deadline, both kinds of cancellation, a revoked loop generation and the estimated cost row that
   * covers a call whose spend was not seen. Without this option a loop is checked exactly as before.
   */
  sideCall?: boolean
}

const signal = () => new AbortController().signal
const facts = async (session: SessionImpl) => {
  const [head] = await session.scan({ order: 'desc', limit: 1 })
  return scanAll((query) => session.scan(query), { toSeq: head?.seq ?? 0 })
}
const payload = (row: Event | undefined): Record<string, unknown> => {
  assert.ok(row)
  assert.ok(row.data && typeof row.data === 'object' && !Array.isArray(row.data))
  return row.data
}
const sideCosts = (rows: Event[]) =>
  rows.filter((row) => row.type === 'cost/ledger' && payload(row).purpose === 'side-call')
const sideSettled = (rows: Event[], invocationId: string) =>
  rows.filter((row) => row.type === 'effect/settled' && payload(row).effectId === `side:${invocationId}`)
const defer = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
// Delegate with the original receiver: factories/drivers may use prototype methods or private state.
function variant(factory: LoopFactory, overrides: Partial<LoopFactory> = {}): LoopFactory {
  return {
    id: factory.id,
    version: factory.version,
    codec: factory.codec,
    capabilities: factory.capabilities,
    ...(factory.controls ? { controls: factory.controls } : {}),
    ...(factory.checkpointMode ? { checkpointMode: factory.checkpointMode } : {}),
    create: (ctx, stop) => factory.create(ctx, stop),
    resume: (ctx, saved, stop) => factory.resume(ctx, saved, stop),
    ...overrides,
  }
}

/**
 * Run real Core execution, with synthetic seams/storage and no account or external service.
 * The factory must support ordinary text prompts and model tool-call replies. Scheduler-specific
 * planning languages should be adapted in the factory supplied by the author.
 */
export async function verifyLoopExecutionContract(
  factory: LoopFactory,
  options: LoopContractOptions = {},
): Promise<LoopContractReport> {
  const report: LoopContractReport = { loop: { id: factory.id, version: factory.version }, checks: [] }
  function runtime(loop = factory, scripts = [textTurn('contract answer')], storage = new MemoryStorage()) {
    const provider = fakeProvider(scripts)
    const billing: unknown[] = []
    const seams = fakeSeams({
      billing: {
        record: async (row) => {
          billing.push(row)
        },
      },
    })
    const fs = fencedFs(
      {
        read: async () => new Uint8Array(),
        write: async () => undefined,
        list: async () => [],
        stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
      },
      testFsPolicy('/w'),
    )
    const workspaceInvocation = createWorkspaceInvocationPort(() => ({
      source: {
        root: '/w',
        fs,
        ready: async () => ({ confine: async (argv) => [...argv] }),
        hookSnapshot: async () => ({ workspaceDigest: 'contract', policyRevision: 'contract', hooks: [] }),
        hookSandbox: seams.sandbox,
        approval: seams.approval,
        checkpoint: seams.checkpoint,
      },
      release() {},
    }))
    const loops = new LoopRegistry()
    loops.register('@contract/loop', loop)
    const preset = presetDefaults()
    preset.model.timeoutMs = 5
    preset.model.retry.maxAttempts = 1
    const kernel = Kernel.create({
      loops,
      storage,
      provider,
      seams,
      preset,
      fsOps: fs,
      contract: { contract_id: null, parser_version: '1' },
      timers: noTimers,
      netFetch: async () => new Response(''),
      loopStepTimeoutMs: 50,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    })
    const open = (key: string, selected = loop) =>
      kernel.session(key, {
        actor,
        cwd: '/w',
        resolvedProfileHash: null,
        writerRunId: `contract:${key}`,
        workspaceInvocation,
        loop: selected,
      })
    const run = async (session: SessionImpl, text = 'Run the contract task', stop = signal()) => {
      await session.enqueue('next-turn', { actor, content: [{ type: 'text', text }] })
      return session.run({ until: 'turn-end', signal: stop })
    }
    return { kernel, provider, seams, storage, billing, loops, open, run }
  }
  for (const missing of [false, true]) {
    const script = textTurn('contract answer').filter((event) => !missing || event.type !== 'usage')
    const kit = runtime(factory, [script])
    try {
      const session = await kit.open('cost')
      assert.equal((await kit.run(session)).reason, 'completed', 'cost scenario must complete')
      const rows = await facts(session)
      const costs = rows.filter((row) => row.type === 'cost/ledger')
      assert.ok(kit.provider.calls > 0)
      assert.equal(costs.length, kit.provider.calls, 'one cost per model request')
      assert.equal(kit.billing.length, kit.provider.calls, 'one billing record per model request')
      const ids = costs.map((row) => payload(row).effectId)
      assert.equal(new Set(ids).size, ids.length, 'each request settles once')
      for (const id of ids) {
        assert.equal(
          rows.filter((row) => row.type === 'effect/settled' && payload(row).effectId === id).length,
          1,
        )
        assert.equal(kit.billing.filter((row) => (row as { effectId: string }).effectId === id).length, 1)
      }
      const cost = costs[0]
      assert.ok(cost)
      assert.equal(payload(cost).creditSource, 'estimated')
      assert.ok((payload(cost).tokens as { output: number }).output > 0)
      report.checks.push(missing ? 'missing-usage' : 'cost-settlement')
    } finally {
      await kit.kernel.close()
    }
  }
  {
    const kit = runtime()
    const started = defer()
    kit.provider.infer = async function* (request) {
      // Reuse the bound synthetic provider rather than relying on a fixed wire stamp.
      const transcript = fakeProvider([textTurn('partial')])
      for await (const event of transcript.infer(request, { signal: signal(), toolNames: [] })) {
        if (event.type === 'usage' || event.type === 'done') break
        yield event
      }
      started.resolve()
      await new Promise<never>(() => {})
    }
    const stop = new AbortController()
    try {
      const session = await kit.open('cancel')
      const running = kit.run(session, 'Cancel the running request', stop.signal)
      await started.promise
      stop.abort()
      assert.equal((await running).reason, 'aborted')
      const rows = await facts(session)
      assert.equal(rows.filter((row) => row.type === 'cost/ledger').length, 1)
      assert.equal(kit.billing.length, 1)
      assert.deepEqual(session.pendingEffects(), [])
      assert.equal(payload(rows.filter((row) => row.type === 'effect/settled').at(-1)).outcome, 'aborted')
      report.checks.push('cancel')
    } finally {
      await kit.kernel.close()
    }
  }
  for (const unknown of [false, true]) {
    const kit = runtime(factory, [toolTurn('shell', {}), textTurn('finished')])
    let effects = 0
    kit.kernel.tools.add(
      shellTool(async () => {
        effects++
        if (unknown) throw new Error('synthetic mutation lost its receipt')
        return { content: [{ type: 'text', text: 'synthetic effect' }] }
      }),
      { source: '@contract/tool', trust: 'builtin' },
    )
    kit.seams.approval.ask = async (request) =>
      unknown
        ? request.kind === 'unknown-outcome'
          ? { ticket: 'contract-pending', expiresAt: request.deadline }
          : { verdict: 'allowed-once', answeredBy: actor }
        : { verdict: 'rejected', answeredBy: actor }
    try {
      const session = await kit.open(unknown ? 'unknown' : 'rejection')
      const outcome = await kit.run(session)
      const rows = await facts(session)
      assert.equal(effects, unknown ? 1 : 0, 'a rejected or unknown effect must never replay')
      if (unknown) {
        assert.equal(outcome.reason, 'parked')
        assert.ok(rows.some((row) => row.type === 'effect/settled' && payload(row).outcome === 'unknown'))
        assert.ok(
          rows.some(
            (row) =>
              row.type === 'decision/state' &&
              (row.data as { request?: { spec?: { purpose?: string } } }).request?.spec?.purpose ===
                'unknown-outcome',
          ),
        )
      } else assert.ok(rows.some((row) => row.type === 'tool/result' && payload(row).isError === true))
      report.checks.push(unknown ? 'unknown-outcome' : 'approval-rejection')
    } finally {
      await kit.kernel.close()
    }
  }
  {
    // Capture a real durable transaction boundary, independent of the driver's step granularity.
    class CrashBoundary extends MemoryStorage {
      snapshot?: { rows: Event[]; storage: MemoryStorage }
      override async commit(...args: Parameters<MemoryStorage['commit']>) {
        const [key, tx] = args
        if (!this.snapshot && tx.events.some((row) => row.type === 'turn/end')) {
          const [head] = await this.scan(key, { order: 'desc', limit: 1 })
          const rows = await scanAll((query) => this.scan(key, query), { toSeq: head?.seq ?? 0 })
          const opCells = (await this.registers(key)).filter((row) => row.register === 'op.state')
          this.snapshot = { rows, storage: MemoryStorage.fromEvents(key, rows, { opCells }) }
        }
        return super.commit(...args)
      }
    }
    const storage = new CrashBoundary()
    const baseline = runtime(factory, [textTurn('contract answer')], storage)
    try {
      const first = await baseline.open('restore')
      assert.equal((await baseline.run(first)).reason, 'completed')
      const expected = await facts(first)
      const snapshot = storage.snapshot
      assert.ok(snapshot, 'the Loop must complete a durable turn')
      assert.ok(snapshot.rows.some((row) => row.type === 'cost/ledger'))
      assert.equal(snapshot.rows.filter((row) => row.type === 'turn/end').length, 0)
      await baseline.kernel.close()
      const recovered = runtime(factory, [textTurn('must not send again')], snapshot.storage)
      try {
        const restored = await recovered.open('restore')
        assert.deepEqual((await facts(restored)).slice(0, snapshot.rows.length), snapshot.rows)
        assert.equal((await restored.run({ until: 'turn-end', signal: signal() })).reason, 'completed')
        const after = await facts(restored)
        assert.equal(after.filter((row) => row.type === 'turn/end').length, 1)
        assert.equal(recovered.provider.calls, 0, 'restore must not replay settled model requests')
        assert.equal(recovered.billing.length, 0, 'restore must not bill settled model requests again')
        for (const type of ['cost/ledger', 'assistant/message'])
          assert.deepEqual(
            after.filter((row) => row.type === type),
            expected.filter((row) => row.type === type),
          )
        report.checks.push('cold-restore')
      } finally {
        await recovered.kernel.close()
      }
    } finally {
      await baseline.kernel.close()
    }
  }
  {
    let first = true
    let old!: LoopContext
    let checkpoint!: LoopCheckpoint
    const release = defer(),
      attempted = defer()
    const errors: unknown[] = []
    const decorate = (ctx: LoopContext, base: LoopDriver): LoopDriver => ({
      checkpoint: () => base.checkpoint(),
      cancel: () => base.cancel(),
      dispose: () => base.dispose(),
      async step(stop) {
        if (!first) return base.step(stop)
        first = false
        old = ctx
        checkpoint = base.checkpoint()
        await ctx.input.accept()
        await ctx.checkpoints.write(checkpoint)
        await release.promise
        for (const write of [
          () =>
            old.events.assistant(
              { content: [{ type: 'text', text: 'stale' }], stopReason: 'end_turn' },
              checkpoint,
            ),
          () => old.checkpoints.write(checkpoint),
          () => old.prepareRequest(),
          () => old.tools.execute({ name: 'shell', args: {} }, signal()),
          () => old.input.accept(),
          () => old.wait.wake(),
          () => old.events.emit('stale', {}),
        ]) {
          try {
            await write()
            errors.push('accepted')
          } catch (error) {
            errors.push(error)
          }
        }
        attempted.resolve()
        return { outcome: 'idle', phase: 'idle' }
      },
    })
    const observed = variant(factory, {
      create: async (ctx, stop) => decorate(ctx, await factory.create(ctx, stop)),
      resume: async (ctx, saved, stop) => decorate(ctx, await factory.resume(ctx, saved, stop)),
    })
    const kit = runtime(observed)
    try {
      const session = await kit.open('stale')
      assert.equal((await kit.run(session)).reason, 'error')
      assert.equal((await kit.run(session, 'Run the replacement generation')).reason, 'completed')
      const before = await facts(session)
      release.resolve()
      await attempted.promise
      assert.equal(errors.length, 7)
      for (const error of errors)
        assert.ok(
          error instanceof Error && 'code' in error && error.code === 'E_CLOSED',
          'stale mutations must be refused',
        )
      assert.deepEqual(await facts(session), before)
      report.checks.push('stale-scope')
    } finally {
      release.resolve()
      await kit.kernel.close()
    }
  }
  {
    const kit = runtime()
    const second = variant(factory, { version: factory.version === '999.0.0' ? '999.0.1' : '999.0.0' })
    kit.loops.register('@contract/next-generation', second)
    try {
      const [old, next] = await Promise.all([kit.open('generation-old'), kit.open('generation-new', second)])
      assert.deepEqual(old.loop, { id: factory.id, version: factory.version })
      assert.deepEqual(next.loop, { id: second.id, version: second.version })
      const outcomes = await Promise.all([kit.run(old), kit.run(next)])
      assert.deepEqual(
        outcomes.map((outcome) => outcome.reason),
        ['completed', 'completed'],
      )
      await old.close()
      const before = await facts(next)
      assert.equal((await kit.run(next, 'Keep the second generation running')).reason, 'completed')
      const after = await facts(next)
      assert.deepEqual(after.slice(0, before.length), before)
      assert.equal(after.filter((row) => row.type === 'turn/end').length, 2)
      report.checks.push('parallel-generations')
    } finally {
      await kit.kernel.close()
    }
  }

  // The suite makes the side calls itself, through the loop's own context in its first step, and then
  // hands the turn to the loop under test: whatever the loop does, a call must settle once, bill once
  // and leave no pending effect behind. The adapter is defined here, so no account or service is needed.
  async function sideCallCases() {
    const { addSideRoute, SIDE_ANSWER, SIDE_ENDPOINT_HOST, SIDE_TARGET } = await import(
      './side-call-fixture.js'
    )
    const sentinel = 'SENTINEL-side-call-request-content'
    const request = (invocationId: string, over: Partial<SideCallOptions> = {}): SideCallOptions => ({
      label: 'contract.check',
      target: SIDE_TARGET,
      system: 'Judge the question.',
      payload: { question: sentinel },
      output: 'json',
      deadlineMs: 5000,
      invocationId,
      ...over,
    })
    type Act = (
      port: LoopSideCallPort,
      stop: AbortSignal,
      generation: number,
    ) => Promise<LoopStepOutcome | undefined>
    /** A runtime whose loop runs `act` in the first step of each generation before the loop's own step. */
    const start = (mode: 'answer' | 'stall', act: Act) => {
      let generations = 0
      const wrap = (ctx: LoopContext, base: LoopDriver): LoopDriver => {
        const generation = generations++
        let first = true
        return {
          checkpoint: () => base.checkpoint(),
          cancel: () => base.cancel(),
          dispose: () => base.dispose(),
          async step(stop) {
            if (first) {
              first = false
              assert.ok(ctx.sideCall, 'Core provides ctx.sideCall')
              await ctx.input.accept()
              const early = await act(ctx.sideCall, stop, generation)
              if (early) return early
            }
            return base.step(stop)
          },
        }
      }
      const kit = runtime(
        variant(factory, {
          create: async (ctx, stop) => wrap(ctx, await factory.create(ctx, stop)),
          resume: async (ctx, saved, stop) => wrap(ctx, await factory.resume(ctx, saved, stop)),
        }),
      )
      const adapter = addSideRoute(kit.provider)
      adapter.mode = mode
      return { ...kit, adapter }
    }
    type Kit = ReturnType<typeof start>
    const billed = (kit: Kit) =>
      kit.billing.filter((row) => (row as { purpose?: string }).purpose === 'side-call')
    let got: { prepared?: PreparedSideCall; result?: SideCallResult; again?: SideCallResult } = {}

    {
      got = {}
      const kit: Kit = start('answer', async (port, stop) => {
        got.prepared = await port.prepare(request('contract-ok'))
        got.result = await port.invoke(got.prepared, stop)
        return undefined
      })
      try {
        const session = await kit.open('side-ok')
        assert.equal((await kit.run(session)).reason, 'completed', 'a side call must not block the turn')
        const result = got.result
        assert.ok(result?.status === 'ok', 'the call succeeds')
        assert.equal(result.text, SIDE_ANSWER)
        assert.deepEqual(result.json, { verdict: 'yes' })
        assert.equal(result.replayed, false)
        assert.equal(result.usage.credits, 0.042, 'the vendor price is the cost')
        assert.equal(result.usage.creditSource, 'gateway')
        assert.equal(kit.adapter.seen.length, 1)
        assert.deepEqual(kit.adapter.seen[0]?.payload, { question: sentinel })
        assert.deepEqual(kit.adapter.answeredAborted, [false], 'a call that succeeds is not told to stop')
        assert.ok(kit.provider.requests.every((body) => body.payload === undefined))
        const rows = await facts(session)
        const [cost, ...extra] = sideCosts(rows)
        assert.equal(extra.length, 0, 'one cost row per side call')
        assert.equal(payload(cost).route, SIDE_TARGET.route)
        assert.equal(payload(cost).endpointHost, SIDE_ENDPOINT_HOST)
        assert.equal(payload(cost).creditSource, 'gateway')
        assert.deepEqual(
          sideSettled(rows, 'contract-ok').map((row) => payload(row).outcome),
          ['ok'],
        )
        assert.equal(billed(kit).length, 1, 'one billing record per side call')
        assert.deepEqual(session.pendingEffects(), [])
        assert.ok(!JSON.stringify(rows).includes(sentinel), 'request content stays out of the ledger')
        report.checks.push('side-call')
      } finally {
        await kit.kernel.close()
      }
    }
    {
      got = {}
      let elapsedMs = Infinity
      const kit: Kit = start('stall', async (port, stop) => {
        got.prepared = await port.prepare(request('contract-deadline', { deadlineMs: 1000 }))
        const began = performance.now()
        got.result = await port.invoke(got.prepared, stop)
        elapsedMs = performance.now() - began
        return undefined
      })
      try {
        const session = await kit.open('side-deadline')
        assert.equal((await kit.run(session)).reason, 'completed')
        assert.ok(got.result?.status === 'failed')
        assert.equal(got.result.reason, 'deadline')
        assert.equal(got.result.code, 'TIMEOUT')
        assert.equal(got.result.retryable, true)
        assert.equal(got.result.dispatch, 'may-have-sent')
        assert.ok(elapsedMs < 2000, 'the platform ends the call; the adapter never answers')
        assert.ok(kit.adapter.signals[0]?.aborted, 'the adapter is told to stop at the deadline')
        const settled = sideSettled(await facts(session), 'contract-deadline')
        assert.deepEqual(
          settled.map((row) => [payload(row).outcome, payload(row).code]),
          [['error', 'TIMEOUT']],
        )
        assert.deepEqual(session.pendingEffects(), [])
        report.checks.push('side-call-deadline')
      } finally {
        await kit.kernel.close()
      }
    }
    for (const sessionStop of [false, true]) {
      // The loop cutting its own call is a failure of that call; a stop of the whole session is a cancellation.
      const id = sessionStop ? 'contract-stop' : 'contract-cancel'
      got = {}
      // Only the loop's own signal is ever aborted by the loop; in the stop variant the signal handed to
      // `invoke` never fires, so the call can only end because Core also watches the session's signal.
      const own = new AbortController()
      const idle = new AbortController()
      const stop = new AbortController()
      const kit: Kit = start('stall', async (port) => {
        got.prepared = await port.prepare(request(id))
        const call = port.invoke(got.prepared, sessionStop ? idle.signal : own.signal)
        await kit.adapter.arrived
        if (!sessionStop) own.abort()
        got.result = await call
        return undefined
      })
      try {
        const session = await kit.open(id)
        const running = kit.run(session, undefined, stop.signal)
        if (sessionStop) {
          await kit.adapter.arrived
          stop.abort()
        }
        assert.equal((await running).reason, sessionStop ? 'aborted' : 'completed')
        assert.ok(got.result?.status === 'failed')
        assert.equal(got.result.reason, 'cancelled')
        assert.equal(got.result.retryable, false)
        assert.equal(got.result.dispatch, 'may-have-sent')
        assert.equal(idle.signal.aborted, false)
        assert.ok(kit.adapter.signals[0]?.aborted, 'the adapter is told to stop')
        const rows = await facts(session)
        assert.deepEqual(
          sideSettled(rows, id).map((row) => payload(row).outcome),
          [sessionStop ? 'aborted' : 'error'],
        )
        assert.deepEqual(
          sideCosts(rows).map((row) => payload(row).creditSource),
          ['estimated'],
          'a cut call still leaves one cost row',
        )
        assert.deepEqual(session.pendingEffects(), [])
      } finally {
        await kit.kernel.close()
      }
    }
    report.checks.push('side-call-cancel')
    {
      // The loop is replaced while its call is in flight (an interrupt, a hot swap). The old execution
      // scope is revoked, so the call closes with a late receipt instead of hanging or vanishing, and
      // the replacement generation reads it back.
      const id = 'contract-revoked'
      const seen: { call?: Promise<SideCallResult>; refused?: unknown; back?: SideCallStatus } = {}
      let session: SessionImpl | undefined
      const kit: Kit = start('stall', async (port, stop, generation) => {
        if (generation === 0) {
          seen.call = port.invoke(await port.prepare(request(id)), stop)
          seen.call.catch(() => undefined)
          await kit.adapter.arrived
          await session?.restartLoopDriver()
          return { outcome: 'running', phase: 'replaced' }
        }
        // Finishing the turn is refused until the revoked call has been written down.
        seen.refused = await seen.call?.then(
          () => undefined,
          (error: unknown) => error,
        )
        seen.back = await port.status(id)
        return undefined
      })
      try {
        session = await kit.open('side-revoked')
        assert.equal((await kit.run(session)).reason, 'completed')
        assert.equal(
          (seen.refused as { code?: string } | undefined)?.code,
          'E_CLOSED',
          'the old caller is refused',
        )
        assert.equal(kit.adapter.seen.length, 1)
        assert.ok(kit.adapter.signals[0]?.aborted, 'revoking the scope tells the adapter to stop')
        assert.ok(seen.back?.status === 'finished', 'the replacement reads the call back')
        const back = seen.back.result
        assert.ok(back.status === 'failed')
        assert.deepEqual(
          [back.reason, back.retryable, back.dispatch, back.replayed],
          ['cancelled', false, 'may-have-sent', true],
        )
        const rows = await facts(session)
        assert.equal(rows.filter((row) => row.type === 'x/core/late-effect-receipt').length, 1)
        assert.equal(sideSettled(rows, id).length, 0, 'the late receipt carries the settlement')
        assert.deepEqual(
          sideCosts(rows).map((row) => [payload(row).creditSource, payload(row).interrupted]),
          [['estimated', true]],
        )
        assert.equal(rows.filter((row) => row.type === 'turn/end').length, 1)
        assert.deepEqual(session.pendingEffects(), [])
        report.checks.push('side-call-revocation')
      } finally {
        await kit.kernel.close()
      }
    }
    {
      // A call whose spend was not seen is billed at the estimate frozen by `prepare`, once, and asking
      // for the same invocation again returns the record instead of sending and billing a second time.
      const id = 'contract-estimate'
      got = {}
      const kit: Kit = start('stall', async (port, stop) => {
        got.prepared = await port.prepare(request(id, { deadlineMs: 1000 }))
        got.result = await port.invoke(got.prepared, stop)
        got.again = await port.invoke(got.prepared, stop)
        return undefined
      })
      try {
        const session = await kit.open('side-estimate')
        assert.equal((await kit.run(session)).reason, 'completed')
        const projected = got.prepared?.estimate.projectedCredits
        assert.equal(typeof projected, 'number', 'the billing seam prices the estimate')
        assert.ok(got.result?.status === 'failed' && got.again?.status === 'failed')
        assert.equal(got.again.reason, 'deadline')
        assert.equal(got.again.replayed, true)
        assert.equal(got.result.usage?.creditSource, 'estimated')
        assert.equal(got.result.usage?.credits, projected)
        assert.equal(kit.adapter.seen.length, 1, 'the second invoke does not send')
        const rows = await facts(session)
        const [cost, ...extra] = sideCosts(rows)
        assert.equal(extra.length, 0, 'exactly one cost row')
        assert.equal(payload(cost).creditSource, 'estimated')
        assert.equal(payload(cost).interrupted, true)
        assert.equal(payload(cost).credits, projected)
        assert.deepEqual(payload(cost).tokens, {
          input: got.prepared?.estimate.inputTokens,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        })
        assert.deepEqual(
          billed(kit).map((row) => (row as { effectId: string }).effectId),
          [`side:${id}`],
        )
        report.checks.push('side-call-estimated-cost')
      } finally {
        await kit.kernel.close()
      }
    }
  }
  if (options.sideCall) await sideCallCases()
  return report
}
