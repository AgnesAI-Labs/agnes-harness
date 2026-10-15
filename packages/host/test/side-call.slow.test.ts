import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fakeModel } from '@agnes/ai/testkit'
import { CORE_CHECKS, type Event, foldEvents, InvariantRegistry, scanAll } from '@agnes/core'
import {
  type LoopContext,
  type LoopFactory,
  type LoopSideCallPort,
  type LoopStepOutcome,
  loopCheckpointCodec,
  loopKind,
  type ModelAdapter,
  type ModelAdapterStreamOptions,
  modelAdapterKind,
  type PreparedSideCall,
  type ReservationRecord,
  type ReserveRequest,
  type ReserveResult,
  type SideCallOptions,
  type SideCallResult,
  type SideCallStatus,
} from '@agnes/extension-api'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import type { RequestBody, RouteDecl } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostSession } from '../src/runtime/lifecycle/host.js'
import type { SessionRecovery } from '../src/runtime/sessions/session.js'
import { createTestHost } from '../testkit/index.js'

type Row = Record<string, unknown>

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  promise.catch(() => undefined)
  return { promise, resolve, reject }
}
/** Rejects with the signal's reason once it aborts, and never settles otherwise. */
const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
/** How a promise settled, without throwing. */
const settledWith = <T>(work: Promise<T>): Promise<{ value?: T; error?: unknown }> =>
  work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )

const SIDE = Object.freeze({ route: 'side', model: 'side-model' })
const ANSWER = '{"verdict":"yes"}'
const ENDPOINT_HOST = 'models.example.com'
const ADAPTER_ID = 'side-payload'
const LOOP = Object.freeze({ id: 'test.side-call', version: '1.0.0' })

/** The conversation route the test host serves; the loop below never sends it a request. */
const conversationRoute: RouteDecl = {
  route: 'gw',
  api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:1/v1',
  models: [fakeModel({ id: 'm1', route: 'gw', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 200000 })],
}
const sideRoute: RouteDecl = {
  route: SIDE.route,
  api: ADAPTER_ID,
  baseUrl: `https://${ENDPOINT_HOST}/v1`,
  models: [
    fakeModel({
      id: SIDE.model,
      route: SIDE.route,
      api: ADAPTER_ID,
      baseUrl: `https://${ENDPOINT_HOST}/v1`,
      contextWindow: 64000,
      cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  ],
}

/**
 * The service behind the payload-only adapter. It outlives any one host, so a request that reached
 * it before a crash is still counted after the reopen. How it treats a request is set by the case:
 * answer at once; take the request and never answer; hold the request before it is sent at all; or
 * take it and answer only when the case opens the gate. A request that waits ends when the adapter's
 * signal aborts, as a socket read does. (An adapter that ignores its signal keeps its instance's
 * lifetime from draining, so the host could not be closed under it; that is not what these cases
 * are about.)
 */
class Endpoint {
  behaviour: 'answer' | 'stall' | 'hold-before-send' | 'gate' = 'answer'
  /** Requests that reached the service. */
  readonly hits: RequestBody[] = []
  /** The signal each request entering the adapter was handed, in arrival order. */
  readonly signals: AbortSignal[] = []
  gate = deferred()
  private entered = 0
  private waiters: Array<{ count: number; done: () => void }> = []

  /** Settles once `count` requests have entered the adapter (the next one by default). */
  entering(count = this.entered + 1): Promise<void> {
    if (this.entered >= count) return Promise.resolve()
    const wait = deferred()
    this.waiters.push({ count, done: wait.resolve })
    return wait.promise
  }

  async *serve(request: RequestBody, options: ModelAdapterStreamOptions) {
    const behaviour = this.behaviour
    this.signals.push(options.signal)
    this.entered++
    for (const waiter of this.waiters.filter((w) => w.count <= this.entered)) waiter.done()
    this.waiters = this.waiters.filter((w) => w.count > this.entered)
    if (behaviour === 'hold-before-send') await aborted(options.signal)
    this.hits.push(request)
    options.reportSent?.({
      sentHash: createHash('sha256')
        .update(JSON.stringify(request.payload ?? null))
        .digest('hex'),
      transforms: [{ event: 'payload_body', ext: ADAPTER_ID }],
    })
    options.reportDispatch?.()
    if (behaviour === 'stall') await aborted(options.signal)
    if (behaviour === 'gate') await Promise.race([this.gate.promise, aborted(options.signal)])
    yield { type: 'text_delta' as const, delta: ANSWER }
    yield {
      type: 'usage' as const,
      tokens: { input: 120, output: 4, cacheRead: 0, cacheWrite: 0 },
      creditSource: 'estimated' as const,
      billing: { usdMicros: 420, source: 'gateway' as const, subscription: false },
    }
    yield { type: 'done' as const, reason: 'stop' as const }
  }
}

/** A payload-only adapter registered the way a plugin registers one; the real facade serves it. */
function payloadAdapter(endpoint: Endpoint): ModelAdapter {
  return {
    id: ADAPTER_ID,
    wireApi: `${ADAPTER_ID}-wire`,
    version: '1.0.0',
    capabilities: { imageInput: false, tools: false, streaming: false, payload: true, payloadOnly: true },
    create(config) {
      return {
        id: `${ADAPTER_ID}-instance`,
        routes: () => [...config.routes],
        models: (route) => config.routes.find((candidate) => candidate.route === route)?.models ?? [],
        bindCredential() {},
        stream: (_route, request, options) => endpoint.serve(request, options),
      }
    },
  }
}

/** What the loop does in a turn before it closes the step, publishes its answer and finishes. */
type Act = (
  port: LoopSideCallPort,
  signal: AbortSignal,
  ctx: LoopContext,
) => Promise<LoopStepOutcome | undefined>
/** The loop's script, shared by every process that opens the session. */
type Script = {
  /** One action per step that finds an open turn, taken in order; none means "just finish". */
  acts: Act[]
  /** Refusals `endStep` or `assistant` gave, which a pending effect would cause. */
  refusals: unknown[]
}
const script = (...acts: Act[]): Script => ({ acts, refusals: [] })

const codec = loopCheckpointCodec(1, (state) => {
  if (state !== null) throw new Error('Unexpected side-call loop state')
  return null
})

/**
 * A plugin loop: in each step with an open turn it runs the case's next action, then closes the
 * step, publishes an answer and finishes the turn through the ordinary ports. A side-call effect
 * still pending at that point makes `endStep` refuse, which is what the cases watch for.
 */
function sideCallLoop(plan: Script): LoopFactory {
  const create = (ctx: LoopContext) => ({
    cancel() {},
    dispose() {},
    checkpoint: () => codec.encode(null),
    async step(signal: AbortSignal): Promise<LoopStepOutcome> {
      const input = await ctx.input.claim('next-turn')
      if (!input) return { outcome: 'idle', phase: 'idle' }
      if (ctx.turn.cancelled() || signal.aborted) return ctx.turn.finishCancelled()
      const act = plan.acts.shift()
      if (act) {
        if (!ctx.sideCall) throw new Error('Core provides ctx.sideCall to every loop context')
        const early = await act(ctx.sideCall, signal, ctx)
        if (early) return early
      }
      if (ctx.turn.cancelled() || signal.aborted) return ctx.turn.finishCancelled()
      try {
        await ctx.turn.endStep()
        await ctx.events.assistant(
          { content: [{ type: 'text', text: 'turn done' }], stopReason: 'end_turn' },
          codec.encode(null),
        )
      } catch (error) {
        plan.refusals.push(error)
        throw error
      }
      return ctx.events.finish('completed')
    },
  })
  return {
    ...LOOP,
    codec,
    capabilities: ['model'],
    create: (ctx) => create(ctx),
    resume: (ctx) => create(ctx),
  }
}

/** An in-process plugin row that registers `value` under `kind`. */
const providerRow = (id: string, exportName: string, kind: unknown, value: unknown) => ({
  declaration: {
    id,
    export: exportName,
    apiRange: '^4.0.0',
    default: true,
    inject: ['providers'],
    provide: [],
    runtime: 'in-process' as const,
  },
  entry: normalizePluginExport({
    inject: ['providers'],
    apply(ctx: { providers: { register(kind: unknown, value: unknown): void } }) {
      ctx.providers.register(kind, value)
    },
  }),
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-side-call-'))
  dirs.push(dir)
  return dir
}

type BootOptions = {
  /** Runs before a billing row is recorded; a row is recorded only when this returns. */
  billing?: (row: Row) => Promise<void>
  treeBudgetCredits?: number
  /** The model request timeout of the preset, which is also the floor of the loop's idle window. */
  modelTimeoutMs?: number
}

/** One process: a real host over `dataDir` with the payload-only adapter and the test loop installed. */
async function boot(dataDir: string, endpoint: Endpoint, plan: Script, over: BootOptions = {}) {
  const billed: Row[] = []
  const t = await createTestHost({
    dataDir,
    disableSessionTitle: true,
    ...(over.treeBudgetCredits === undefined ? {} : { treeBudgetCredits: over.treeBudgetCredits }),
    ...(over.modelTimeoutMs === undefined
      ? {}
      : {
          presets: {
            standard: {
              name: 'standard',
              extends: 'base',
              disclosure: 'standard',
              model: { route: { primary: 'default' }, timeout_ms: over.modelTimeoutMs },
            },
          },
        }),
    limits: { 'cost.credits_per_usd': 100 },
    seams: {
      billing: {
        record: async (row) => {
          await over.billing?.(row as unknown as Row)
          billed.push(row as unknown as Row)
        },
      },
    },
    profileInputs: {
      user: { name: 'local-dev', provider: { package: '@agnes/ai', routes: [conversationRoute, sideRoute] } },
    },
    packages: {
      '@agnes/ai': {
        plugins: [
          providerRow(
            'model-adapters:side-payload',
            'sidePayload',
            modelAdapterKind,
            payloadAdapter(endpoint),
          ),
        ],
      },
      '@agnes/code': {
        plugins: [providerRow('loop:test.side-call', 'sideCallLoop', loopKind, sideCallLoop(plan))],
      },
    },
  })
  const recovered: SessionRecovery[] = []
  const open = (key: string) =>
    t.host.createSession({
      key,
      cwd: dataDir,
      loop: LOOP,
      onRecovered: (recovery) => {
        recovered.push(recovery)
      },
    })
  return { ...t, billed, recovered, open }
}
type Kit = Awaited<ReturnType<typeof boot>>

/**
 * What a killed process leaves behind: the ledger is sealed first, so nothing the dying host does
 * while it tears down reaches it, then the host is closed to release its resources.
 */
async function crash(kit: Kit, session: HostSession, release?: () => void): Promise<void> {
  await session.d.log.close()
  release?.()
  await kit.host.close()
}

const rowsOf = async (session: HostSession): Promise<Event[]> =>
  scanAll((query) => session.scan(query), { fromSeq: 1, toSeq: session.lastSeq })
const data = (row: Event | undefined): Row => (row?.data ?? {}) as Row
const ofType = (rows: Event[], type: string) => rows.filter((row) => row.type === type)
const costs = (rows: Event[]) => ofType(rows, 'cost/ledger')
const sideCosts = (rows: Event[]) => costs(rows).filter((row) => data(row).purpose === 'side-call')
const forEffect = (rows: Event[], type: string, id: string) =>
  ofType(rows, type).filter((row) => data(row).effectId === `side:${id}`)
const sideBilled = (billed: Row[], id: string) => billed.filter((row) => row.effectId === `side:${id}`)
const violations = (rows: Event[]) => {
  const checks = new InvariantRegistry()
  checks.register('@agnes/core', CORE_CHECKS)
  return checks.run(rows, foldEvents([]))
}
const pendingSideCalls = (session: HostSession) =>
  session.pendingEffects().filter((node) => node.kind === 'side-call')
const audit = (rows: Event[], id: string) => {
  const binding = ofType(rows, 'x/core/side-call-intent').find(
    (row) => (data(row).binding as Row | undefined)?.effectId === `side:${id}`,
  )
  return data(binding).audit as { inputTokens: number; projectedCredits: number | null }
}

const enqueue = (session: HostSession, text: string) =>
  session.enqueue('next-turn', { content: [{ type: 'text', text }], actor: session.d.actor, kind: 'prompt' })
const runTurn = async (session: HostSession, text = 'decide', signal = new AbortController().signal) => {
  await enqueue(session, text)
  return session.run({ until: 'turn-end', signal })
}
const continueTurn = (session: HostSession, signal = new AbortController().signal) =>
  session.run({ until: 'turn-end', signal })
const options = (invocationId: string, over: Partial<SideCallOptions> = {}): SideCallOptions => ({
  label: 'test.decide',
  target: SIDE,
  system: 'Answer the question.',
  payload: { question: 'continue?' },
  output: 'json',
  deadlineMs: 5000,
  invocationId,
  ...over,
})
const call = async (
  port: LoopSideCallPort,
  id: string,
  signal: AbortSignal,
  over?: Partial<SideCallOptions>,
) => port.invoke(await port.prepare(options(id, over)), signal)

/** The next turn of the same session must close its step and finish as if nothing had happened. */
async function nextTurnFinishes(session: HostSession, plan: Script): Promise<void> {
  const before = plan.refusals.length
  expect((await runTurn(session, 'next')).reason).toBe('completed')
  expect(plan.refusals.slice(before)).toEqual([])
  expect(pendingSideCalls(session)).toEqual([])
}

describe('side model calls on a real host', () => {
  it('answers through the registered payload-only adapter and the real facade', async () => {
    const endpoint = new Endpoint()
    let result: SideCallResult | undefined
    const plan = script(async (port, signal) => {
      result = await call(port, 'ok-1', signal)
      return undefined
    })
    const kit = await boot(scratch(), endpoint, plan)
    try {
      const session = await kit.open('side-ok')
      expect((await runTurn(session)).reason).toBe('completed')
      expect(result).toMatchObject({ status: 'ok', text: ANSWER, json: { verdict: 'yes' }, replayed: false })
      expect(endpoint.hits).toHaveLength(1)
      expect(endpoint.hits[0]?.payload).toEqual({ question: 'continue?' })
      const rows = await rowsOf(session)
      expect(sideCosts(rows).map(data)).toEqual([
        expect.objectContaining({
          effectId: 'side:ok-1',
          creditSource: 'gateway',
          credits: 0.042,
          route: SIDE.route,
          adapter: { id: `${ADAPTER_ID}-instance`, version: '1.0.0' },
          endpointHost: ENDPOINT_HOST,
        }),
      ])
      expect(sideBilled(kit.billed, 'ok-1')).toHaveLength(1)
      await nextTurnFinishes(session, plan)
      expect(violations(await rowsOf(session))).toEqual([])
    } finally {
      await kit.host.close()
    }
  })
})

describe('a process that dies around a side call', () => {
  /**
   * Kills the process while the endpoint holds the call (`hold-before-send`: before the request is
   * sent; `stall`: after it arrived), reopens the session in a new host over the same files, checks
   * what recovery wrote, then lets the loop ask for the same invocation again.
   */
  async function crashedCall(behaviour: 'hold-before-send' | 'stall', id: string) {
    const dataDir = scratch()
    const endpoint = new Endpoint()
    endpoint.behaviour = behaviour
    let replay: SideCallResult | undefined
    const plan = script(
      async (port, signal) => {
        await settledWith(call(port, id, signal))
        throw new Error('process ended')
      },
      async (port, signal) => {
        replay = await call(port, id, signal)
        return undefined
      },
    )
    const first = await boot(dataDir, endpoint, plan)
    const session = await first.open(`crash-${id}`)
    await enqueue(session, 'decide')
    void continueTurn(session).catch(() => undefined)
    await endpoint.entering(1)
    const phase = structuredClone(session.op()?.phase)
    const before = await rowsOf(session)
    expect(forEffect(before, 'effect/intent', id)).toHaveLength(1)
    expect(audit(before, id)).toBeDefined()
    expect(forEffect(before, 'effect/settled', id)).toHaveLength(0)
    await crash(first, session)
    const sentBeforeCrash = endpoint.hits.length
    endpoint.behaviour = 'answer'
    const second = await boot(dataDir, endpoint, plan)
    try {
      const reopened = await second.open(`crash-${id}`)
      const recovered = await rowsOf(reopened)
      // Recovery settles the call as unknown and closes it with one estimated cost row, never as a
      // conversation inference: no retry, no inference row, no row named after a model slot, and the
      // conversation phase with its attempt counter is left as it was.
      expect(second.recovered.flatMap((r) => r.actions)).toEqual([
        { effectId: `side:${id}`, action: 'unknown' },
      ])
      expect(reopened.op()?.phase).toEqual(phase)
      expect(costs(recovered).map((row) => [data(row).purpose, data(row).model])).toEqual([
        ['side-call', SIDE.model],
      ])
      const frozen = audit(recovered, id)
      expect(data(sideCosts(recovered)[0])).toEqual({
        purpose: 'side-call',
        effectId: `side:${id}`,
        model: SIDE.model,
        tokens: { input: frozen.inputTokens, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(frozen.projectedCredits === null ? {} : { credits: frozen.projectedCredits }),
        creditSource: 'estimated',
        interrupted: true,
        route: SIDE.route,
      })
      expect(forEffect(recovered, 'effect/settled', id).map(data)).toEqual([
        { effectId: `side:${id}`, outcome: 'unknown' },
      ])
      expect(forEffect(recovered, 'x/core/side-call-terminal', id)).toHaveLength(0)
      // Rows written by recovery reach neither the billing seam nor the tree budget.
      expect(sideBilled(second.billed, id)).toEqual([])
      expect(pendingSideCalls(reopened)).toEqual([])
      // The loop asks for the same invocation again: it gets the interrupted record, nothing is sent.
      expect((await continueTurn(reopened)).reason).toBe('completed')
      expect(replay).toMatchObject({ status: 'unknown', reason: 'interrupted', replayed: true })
      expect(endpoint.hits).toHaveLength(sentBeforeCrash)
      await nextTurnFinishes(reopened, plan)
      expect(violations(await rowsOf(reopened))).toEqual([])
      return { sentBeforeCrash }
    } finally {
      await second.host.close()
    }
  }

  it('(a) after the intent and before the request is sent: unknown, one estimated row, nothing sent', async () => {
    const { sentBeforeCrash } = await crashedCall('hold-before-send', 'a-1')
    expect(sentBeforeCrash).toBe(0)
  })

  it('(b) after the request reached the endpoint and before its terminal: unknown, not sent again', async () => {
    const { sentBeforeCrash } = await crashedCall('stall', 'b-1')
    expect(sentBeforeCrash).toBe(1)
  })

  it('(c) after the terminal and before the billing seam: the record replays, the seam never gets the row', async () => {
    const dataDir = scratch()
    const endpoint = new Endpoint()
    const reached = deferred()
    const billing = deferred()
    let back: SideCallStatus | undefined
    let again: SideCallResult | undefined
    const plan = script(
      async (port, signal) => {
        await settledWith(call(port, 'c-1', signal))
        throw new Error('process ended')
      },
      async (port, signal) => {
        back = await port.status('c-1')
        again = await call(port, 'c-1', signal)
        return undefined
      },
    )
    const first = await boot(dataDir, endpoint, plan, {
      billing: async (row) => {
        if (row.purpose !== 'side-call') return
        reached.resolve()
        await billing.promise
      },
    })
    const session = await first.open('crash-c')
    await enqueue(session, 'decide')
    void continueTurn(session).catch(() => undefined)
    await reached.promise
    const before = await rowsOf(session)
    expect(forEffect(before, 'x/core/side-call-terminal', 'c-1')).toHaveLength(1)
    // The seam call never completes in the process that made it.
    await crash(first, session, () => billing.reject(new Error('process ended')))
    expect(sideBilled(first.billed, 'c-1')).toEqual([])
    const second = await boot(dataDir, endpoint, plan)
    try {
      const reopened = await second.open('crash-c')
      expect(second.recovered).toEqual([])
      expect((await continueTurn(reopened)).reason).toBe('completed')
      expect(back).toMatchObject({
        status: 'finished',
        result: { status: 'ok', text: ANSWER, replayed: true },
      })
      expect(again).toMatchObject({ status: 'ok', text: ANSWER, replayed: true })
      expect(endpoint.hits).toHaveLength(1)
      const rows = await rowsOf(reopened)
      expect(sideCosts(rows).map((row) => [data(row).creditSource, data(row).credits])).toEqual([
        ['gateway', 0.042],
      ])
      // Known behaviour: nothing reconciles the billing seam after a crash in this window, so the
      // seam is missing the row that the ledger has. Nothing reconciles it on reopen yet.
      expect(sideBilled(second.billed, 'c-1')).toEqual([])
      await nextTurnFinishes(reopened, plan)
      expect(violations(await rowsOf(reopened))).toEqual([])
    } finally {
      await second.host.close()
    }
  })

  it('(d) after the tree budget hold and before the intent: the hold stays held until the same id runs', async () => {
    const dataDir = scratch()
    const endpoint = new Endpoint()
    const reserved = deferred<ReserveResult>()
    const held = deferred()
    let result: SideCallResult | undefined
    const plan = script(
      async (port, signal) => {
        await settledWith(call(port, 'd-1', signal))
        throw new Error('process ended')
      },
      async (port, signal) => {
        result = await call(port, 'd-1', signal)
        return undefined
      },
    )
    const first = await boot(dataDir, endpoint, plan, { treeBudgetCredits: 1000 })
    const session = await first.open('crash-d')
    type Reservations = {
      reserve(req: ReserveRequest): Promise<ReserveResult>
      peekReservation(permitId: string): Promise<ReservationRecord | null>
    }
    const storage = session.d.log.storage as unknown as Reservations
    const reserve = storage.reserve.bind(storage)
    storage.reserve = async (req) => {
      const out = await reserve(req)
      if (req.effectId !== 'side:d-1') return out
      reserved.resolve(out)
      await held.promise
      return out
    }
    await enqueue(session, 'decide')
    void continueTurn(session).catch(() => undefined)
    const hold = await reserved.promise
    if (!hold.ok) throw new Error(`reservation refused: ${hold.message}`)
    expect((await storage.peekReservation(hold.permitId))?.status).toBe('held')
    expect(forEffect(await rowsOf(session), 'effect/intent', 'd-1')).toHaveLength(0)
    await crash(first, session, () => held.reject(new Error('process ended')))
    const second = await boot(dataDir, endpoint, plan, { treeBudgetCredits: 1000 })
    try {
      const reopened = await second.open('crash-d')
      const reservations = reopened.d.log.storage as unknown as Reservations
      expect(second.recovered).toEqual([])
      // Known limitation, as for auxiliary vision: the orphaned hold stays held after the reopen.
      expect((await reservations.peekReservation(hold.permitId))?.status).toBe('held')
      expect((await continueTurn(reopened)).reason).toBe('completed')
      expect(result).toMatchObject({ status: 'ok', text: ANSWER, replayed: false })
      expect(endpoint.hits).toHaveLength(1)
      // Calling the same id again adopts the hold and settles it with the recorded spend.
      expect((await reservations.peekReservation(hold.permitId))?.status).toBe('settled')
      await nextTurnFinishes(reopened, plan)
      expect(violations(await rowsOf(reopened))).toEqual([])
    } finally {
      await second.host.close()
    }
  })

  it('(e) a reopen that closes the interrupted turn (damaged tail) settles the call as unknown', async () => {
    const dataDir = scratch()
    const endpoint = new Endpoint()
    endpoint.behaviour = 'stall'
    let replay: SideCallResult | undefined
    const plan = script(
      async (port, signal) => {
        await settledWith(call(port, 'e-1', signal))
        throw new Error('process ended')
      },
      async (port, signal) => {
        replay = await call(port, 'e-1', signal)
        return undefined
      },
    )
    const first = await boot(dataDir, endpoint, plan)
    const session = await first.open('crash-e')
    await enqueue(session, 'decide')
    void continueTurn(session).catch(() => undefined)
    await endpoint.entering(1)
    // A torn last row makes the reopen close the turn instead of continuing it.
    await session.d.log.append([session.ev('x/test/torn-tail', { pending: true }, { ignorable: true })])
    const damagedSeq = session.lastSeq
    await crash(first, session)
    const db = new DatabaseSync(join(dataDir, 'sessions.db'))
    db.prepare('UPDATE events SET data = ? WHERE session_key = ? AND seq = ?').run(
      '{',
      session.key,
      damagedSeq,
    )
    db.close()
    endpoint.behaviour = 'answer'
    const second = await boot(dataDir, endpoint, plan)
    try {
      const reopened = await second.open('crash-e')
      expect(second.recovered.flatMap((r) => r.actions)).toEqual([
        { effectId: 'side:e-1', action: 'unknown' },
      ])
      const rows = await rowsOf(reopened)
      expect(ofType(rows, 'x/core/ledger-tail-recovered')).toHaveLength(1)
      expect(reopened.op()).toBeNull()
      expect(data(ofType(rows, 'turn/end').at(-1)).reason).toBe('interrupted')
      expect(forEffect(rows, 'effect/settled', 'e-1').map((row) => data(row).outcome)).toEqual(['unknown'])
      expect(
        costs(rows).map((row) => [data(row).purpose, data(row).creditSource, data(row).interrupted]),
      ).toEqual([['side-call', 'estimated', true]])
      expect(sideBilled(second.billed, 'e-1')).toEqual([])
      expect(pendingSideCalls(reopened)).toEqual([])
      // The next turn reads the interrupted record for the same id and sends nothing.
      await nextTurnFinishes(reopened, plan)
      expect(replay).toMatchObject({ status: 'unknown', reason: 'interrupted', replayed: true })
      expect(endpoint.hits).toHaveLength(1)
      expect(violations(await rowsOf(reopened))).toEqual([])
    } finally {
      await second.host.close()
    }
  })
})

type Seen = {
  call?: Promise<SideCallResult>
  outcome?: { value?: SideCallResult; error?: unknown }
  back?: SideCallStatus
  again?: SideCallResult
}
const code = (error: unknown) => (error as { code?: string } | undefined)?.code
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** The step ends while the call keeps running; the run returns with the turn still open. */
const pause: LoopStepOutcome = { outcome: 'idle', phase: 'idle' }
const cancelledReplay = {
  status: 'finished',
  result: {
    status: 'failed',
    reason: 'cancelled',
    retryable: false,
    dispatch: 'may-have-sent',
    replayed: true,
  },
}

describe('a loop execution scope revoked around a side call', () => {
  // Revoking a scope while one of its calls is dispatched is reached in the host only when nothing
  // has stopped the session first: a Stop, a close and an interrupt all abort the session's signal,
  // which ends a dispatched call before any revocation (see the stop cases below), and the idle
  // deadline is suspended while a call is dispatched. These cases therefore release the context the
  // way an interrupt does after its run has drained: the loop leaves its call running with its own
  // signal and ends the step, then `restartLoopDriver` revokes the old scope and builds the next
  // loop generation from the checkpoint.

  it('(f) context released while the call is dispatched: a late receipt closes it, billed once', async () => {
    const dataDir = scratch()
    const endpoint = new Endpoint()
    endpoint.behaviour = 'stall'
    const own = new AbortController()
    const seen: Seen = {}
    const plan = script(
      async (port) => {
        seen.call = call(port, 'f-1', own.signal)
        seen.call.catch(() => undefined)
        await endpoint.entering(1)
        return pause
      },
      async (port, signal) => {
        seen.outcome = await settledWith(seen.call as Promise<SideCallResult>)
        seen.back = await port.status('f-1')
        seen.again = await call(port, 'f-1', signal)
        return undefined
      },
    )
    const kit = await boot(dataDir, endpoint, plan)
    try {
      const session = await kit.open('revoke-f')
      expect((await runTurn(session)).reason).toBe('completed')
      expect(pendingSideCalls(session)).toHaveLength(1)
      await session.restartLoopDriver()
      expect((await continueTurn(session)).reason).toBe('completed')
      expect(code(seen.outcome?.error)).toBe('E_CLOSED')
      expect(own.signal.aborted).toBe(false)
      expect(endpoint.signals[0]?.aborted).toBe(true)
      const rows = await rowsOf(session)
      const [intent] = forEffect(rows, 'effect/intent', 'f-1')
      expect(intent).toBeDefined()
      expect(ofType(rows, 'x/core/side-call-intent')).toHaveLength(1)
      expect(forEffect(rows, 'effect/settled', 'f-1')).toEqual([])
      expect(ofType(rows, 'x/core/side-call-terminal')).toEqual([])
      const receipts = ofType(rows, 'x/core/late-effect-receipt')
      expect(receipts).toHaveLength(1)
      expect(receipts[0]?.sourceEventSeqs).toEqual([intent?.seq])
      expect((data(receipts[0]).effects as Row[]).map((effect) => effect.effectId)).toEqual(['side:f-1'])
      expect(sideCosts(rows).map((row) => [data(row).creditSource, data(row).interrupted])).toEqual([
        ['estimated', true],
      ])
      expect(sideBilled(kit.billed, 'f-1').map((row) => row.credits)).toEqual([
        data(sideCosts(rows)[0]).credits,
      ])
      expect(pendingSideCalls(session)).toEqual([])
      expect(seen.back).toMatchObject(cancelledReplay)
      expect(seen.again).toMatchObject(cancelledReplay.result)
      expect(endpoint.hits).toHaveLength(1)
      await nextTurnFinishes(session, plan)
      expect(violations(await rowsOf(session))).toEqual([])
    } finally {
      await kit.host.close()
    }
    // The receipt already cleared the effect, so a reopen has nothing to settle as unknown.
    const second = await boot(dataDir, endpoint, plan)
    try {
      await second.open('revoke-f')
      expect(second.recovered).toEqual([])
    } finally {
      await second.host.close()
    }
  })

  it('(f) close does not hang and waits for the late receipt of a released call', async () => {
    const dataDir = scratch()
    const endpoint = new Endpoint()
    endpoint.behaviour = 'stall'
    const own = new AbortController()
    const seen: Seen = {}
    const plan = script(async (port) => {
      seen.call = call(port, 'fc-1', own.signal)
      seen.call.catch(() => undefined)
      await endpoint.entering(1)
      return pause
    })
    const first = await boot(dataDir, endpoint, plan)
    const session = await first.open('revoke-close')
    expect((await runTurn(session)).reason).toBe('completed')
    // Hold the session's write lock so the receipt cannot be written yet.
    const taken = deferred()
    const hold = deferred()
    const locked = session.locked(async () => {
      taken.resolve()
      await hold.promise
    })
    await taken.promise
    await session.restartLoopDriver()
    const closing = first.host.close()
    // Bounded check that close is still waiting while the receipt is held back.
    expect(await Promise.race([closing.then(() => 'closed'), delay(300).then(() => 'waiting')])).toBe(
      'waiting',
    )
    hold.resolve()
    await locked
    await closing
    expect(code((await settledWith(seen.call as Promise<SideCallResult>)).error)).toBe('E_CLOSED')
    expect(sideBilled(first.billed, 'fc-1')).toHaveLength(1)
    const second = await boot(dataDir, endpoint, plan)
    try {
      const reopened = await second.open('revoke-close')
      expect(second.recovered).toEqual([])
      const rows = await rowsOf(reopened)
      expect(ofType(rows, 'x/core/late-effect-receipt')).toHaveLength(1)
      expect(forEffect(rows, 'effect/settled', 'fc-1')).toEqual([])
      expect(sideCosts(rows)).toHaveLength(1)
      expect(pendingSideCalls(reopened)).toEqual([])
      await nextTurnFinishes(reopened, plan)
      expect(violations(await rowsOf(reopened))).toEqual([])
    } finally {
      await second.host.close()
    }
  })

  it('(f) an idle-deadline expiry while the call is dispatched closes it with a late receipt', async () => {
    const endpoint = new Endpoint()
    endpoint.behaviour = 'stall'
    const seen: Seen = {}
    const plan = script(
      async (port, signal) => {
        seen.outcome = await settledWith(call(port, 'fi-1', signal))
        return { outcome: 'running', phase: 'expired' }
      },
      async (port, signal) => {
        seen.back = await port.status('fi-1')
        seen.again = await call(port, 'fi-1', signal)
        return undefined
      },
    )
    const kit = await boot(scratch(), endpoint, plan)
    try {
      const session = await kit.open('revoke-idle')
      await enqueue(session, 'decide')
      const running = continueTurn(session)
      await endpoint.entering(1)
      // The idle deadline is suspended while a call is dispatched (see the idle stop case), so it
      // cannot expire here by itself. Apply what its expiry does to the scope: revoke the decision
      // scope, abort the session signal, expire the loop scope.
      session.decisions.revokeScope()
      session.ac.abort()
      session.loopScope.expire()
      // A real expiry also rejects the step race and the run ends the turn as an error; here the step
      // returns, and the run ends the turn as the stop its aborted signal reads as.
      await running
      expect(session.op()).toBeNull()
      expect(code(seen.outcome?.error)).toBe('E_CLOSED')
      expect(endpoint.signals[0]?.aborted).toBe(true)
      const rows = await rowsOf(session)
      expect(forEffect(rows, 'effect/intent', 'fi-1')).toHaveLength(1)
      expect(forEffect(rows, 'effect/settled', 'fi-1')).toEqual([])
      expect(ofType(rows, 'x/core/side-call-terminal')).toEqual([])
      expect(ofType(rows, 'x/core/late-effect-receipt')).toHaveLength(1)
      expect(sideCosts(rows)).toHaveLength(1)
      expect(sideBilled(kit.billed, 'fi-1')).toHaveLength(1)
      expect(pendingSideCalls(session)).toEqual([])
      // The next run builds a new loop generation, which reads the call back and does not resend it.
      await nextTurnFinishes(session, plan)
      expect(seen.back).toMatchObject(cancelledReplay)
      expect(seen.again).toMatchObject(cancelledReplay.result)
      expect(endpoint.hits).toHaveLength(1)
      expect(violations(await rowsOf(session))).toEqual([])
    } finally {
      await kit.host.close()
    }
  })

  it('(g) context released before the intent is written: nothing written, hold released, E_CLOSED', async () => {
    const endpoint = new Endpoint()
    const own = new AbortController()
    const reserved = deferred<ReserveResult>()
    const gate = deferred()
    const seen: Seen = {}
    const plan = script(
      async (port) => {
        seen.call = call(port, 'g-1', own.signal)
        seen.call.catch(() => undefined)
        await reserved.promise
        return pause
      },
      async (port) => {
        seen.back = await port.status('g-1')
        return undefined
      },
    )
    const kit = await boot(scratch(), endpoint, plan, { treeBudgetCredits: 1000 })
    try {
      const session = await kit.open('revoke-g')
      type Reservations = {
        reserve(req: ReserveRequest): Promise<ReserveResult>
        peekReservation(permitId: string): Promise<ReservationRecord | null>
      }
      const storage = session.d.log.storage as unknown as Reservations
      const reserve = storage.reserve.bind(storage)
      storage.reserve = async (req) => {
        const out = await reserve(req)
        if (req.effectId !== 'side:g-1') return out
        reserved.resolve(out)
        await gate.promise
        return out
      }
      expect((await runTurn(session)).reason).toBe('completed')
      const hold = await reserved.promise
      if (!hold.ok) throw new Error(`reservation refused: ${hold.message}`)
      expect((await storage.peekReservation(hold.permitId))?.status).toBe('held')
      await session.restartLoopDriver()
      gate.resolve()
      expect(code((await settledWith(seen.call as Promise<SideCallResult>)).error)).toBe('E_CLOSED')
      const rows = await rowsOf(session)
      expect(forEffect(rows, 'effect/intent', 'g-1')).toEqual([])
      expect(ofType(rows, 'x/core/side-call-intent')).toEqual([])
      expect(ofType(rows, 'x/core/late-effect-receipt')).toEqual([])
      expect(costs(rows)).toEqual([])
      expect((await storage.peekReservation(hold.permitId))?.status).toBe('released')
      expect(endpoint.hits).toHaveLength(0)
      expect((await continueTurn(session)).reason).toBe('completed')
      expect(seen.back).toEqual({ status: 'absent', invocationId: 'g-1' })
      await nextTurnFinishes(session, plan)
      expect(violations(await rowsOf(session))).toEqual([])
    } finally {
      await kit.host.close()
    }
  })

  it('(h) context released after the terminal is committed: the record stands and reads back as it was', async () => {
    const endpoint = new Endpoint()
    const own = new AbortController()
    const reached = deferred()
    const billing = deferred()
    const seen: Seen = {}
    const plan = script(
      async (port) => {
        seen.call = call(port, 'h-1', own.signal)
        seen.call.catch(() => undefined)
        await reached.promise
        return pause
      },
      async (port, signal) => {
        seen.back = await port.status('h-1')
        seen.again = await call(port, 'h-1', signal)
        return undefined
      },
    )
    const kit = await boot(scratch(), endpoint, plan, {
      billing: async (row) => {
        if (row.effectId !== 'side:h-1') return
        reached.resolve()
        await billing.promise
      },
    })
    try {
      const session = await kit.open('revoke-h')
      expect((await runTurn(session)).reason).toBe('completed')
      expect(ofType(await rowsOf(session), 'x/core/side-call-terminal')).toHaveLength(1)
      await session.restartLoopDriver()
      billing.resolve()
      const outcome = await settledWith(seen.call as Promise<SideCallResult>)
      expect(code(outcome.error)).toBe('E_CLOSED')
      expect(sideBilled(kit.billed, 'h-1')).toHaveLength(1)
      expect((await continueTurn(session)).reason).toBe('completed')
      const rows = await rowsOf(session)
      expect(ofType(rows, 'x/core/late-effect-receipt')).toEqual([])
      expect(forEffect(rows, 'effect/settled', 'h-1').map((row) => data(row).outcome)).toEqual(['ok'])
      expect(sideCosts(rows).map((row) => data(row).creditSource)).toEqual(['gateway'])
      expect(seen.back).toMatchObject({
        status: 'finished',
        result: { status: 'ok', text: ANSWER, replayed: true },
      })
      expect(seen.again).toMatchObject({ status: 'ok', text: ANSWER, replayed: true })
      expect(endpoint.hits).toHaveLength(1)
      expect(sideBilled(kit.billed, 'h-1')).toHaveLength(1)
      await nextTurnFinishes(session, plan)
      expect(violations(await rowsOf(session))).toEqual([])
    } finally {
      await kit.host.close()
    }
  })
})

/** How the loop treats its call when the turn is stopped. */
type Waiting = 'waits for the call' | 'stops waiting at the stop' | 'ends the turn at the abort event'
const waitings: Waiting[] = [
  'waits for the call',
  'stops waiting at the stop',
  'ends the turn at the abort event',
]

/**
 * A session whose loop sends a call in the first turn, with the request out when this returns. A
 * loop that waits for the call ends the turn after the call settles. One that stops waiting ends the
 * cancelled turn as soon as its signal aborts, and an eager one ends it from the abort event itself;
 * both leave the call to settle on its own, racing the turn's end.
 */
async function callInFlight(id: string, waiting: Waiting, signal = new AbortController().signal) {
  const endpoint = new Endpoint()
  endpoint.behaviour = 'stall'
  const seen: Seen = {}
  const plan = script(async (port, stepSignal, ctx) => {
    seen.call = call(port, id, stepSignal)
    seen.call.catch(() => undefined)
    if (waiting === 'waits for the call') seen.outcome = await settledWith(seen.call)
    else if (waiting === 'stops waiting at the stop')
      await Promise.race([seen.call, aborted(stepSignal)]).catch(() => undefined)
    else
      return new Promise<LoopStepOutcome>((resolve, reject) =>
        stepSignal.addEventListener('abort', () => void ctx.turn.finishCancelled().then(resolve, reject), {
          once: true,
        }),
      )
    return undefined
  })
  const dataDir = scratch()
  const kit = await boot(dataDir, endpoint, plan)
  const session = await kit.open(`stop-${id}`)
  await enqueue(session, 'decide')
  const running = session.run({ until: 'turn-end', signal })
  await endpoint.entering(1)
  return { endpoint, seen, plan, kit, session, dataDir, running }
}

/**
 * The acceptance for every stop path: the call is closed exactly once (a settlement or a late
 * receipt), with one cost row billed once, nothing of it stays pending, and the next turn on the
 * same session closes its step and finishes.
 */
async function closedOnceThenNextTurn(session: HostSession, plan: Script, billed: Row[], id: string) {
  const rows = await rowsOf(session)
  const receipts = ofType(rows, 'x/core/late-effect-receipt').filter((row) =>
    (data(row).effects as Row[]).some((effect) => effect.effectId === `side:${id}`),
  )
  expect(pendingSideCalls(session)).toEqual([])
  expect(forEffect(rows, 'effect/settled', id).length + receipts.length).toBe(1)
  expect(sideCosts(rows).filter((row) => data(row).effectId === `side:${id}`)).toHaveLength(1)
  expect(sideBilled(billed, id)).toHaveLength(1)
  await nextTurnFinishes(session, plan)
  expect(violations(await rowsOf(session))).toEqual([])
}

describe('stopping a turn while a side call is in flight', () => {
  it('(f) a user Stop reaches the dispatched call through the session signal before any revocation', async () => {
    // A Stop aborts the session signal, which the call races, so the call settles inside its turn
    // with its terminal row. The scope would be revoked only if the step were still running five
    // seconds later, and by then the call has settled, so no late receipt is needed.
    const stop = new AbortController()
    const t = await callInFlight('fs-1', 'waits for the call', stop.signal)
    try {
      t.plan.acts.push(async (port, signal) => {
        t.seen.back = await port.status('fs-1')
        t.seen.again = await call(port, 'fs-1', signal)
        return undefined
      })
      stop.abort()
      expect((await t.running).reason).toBe('aborted')
      expect(t.seen.outcome?.value).toMatchObject({
        status: 'failed',
        reason: 'cancelled',
        dispatch: 'may-have-sent',
        replayed: false,
      })
      expect(t.endpoint.signals[0]?.aborted).toBe(true)
      const rows = await rowsOf(t.session)
      expect(forEffect(rows, 'effect/intent', 'fs-1')).toHaveLength(1)
      expect(forEffect(rows, 'effect/settled', 'fs-1').map((row) => data(row).outcome)).toEqual(['aborted'])
      expect(
        ofType(rows, 'x/core/side-call-terminal').map((row) => (data(row).terminal as Row).reason),
      ).toEqual(['session_cancelled'])
      expect(ofType(rows, 'x/core/late-effect-receipt')).toEqual([])
      expect(sideCosts(rows).map((row) => [data(row).creditSource, data(row).interrupted])).toEqual([
        ['estimated', true],
      ])
      await closedOnceThenNextTurn(t.session, t.plan, t.kit.billed, 'fs-1')
      expect(t.seen.back).toMatchObject(cancelledReplay)
      expect(t.seen.again).toMatchObject(cancelledReplay.result)
      expect(t.endpoint.hits).toHaveLength(1)
    } finally {
      await t.kit.host.close()
    }
  })

  it.each<Waiting>(waitings)('① user Stop, the loop %s', async (waiting) => {
    const stop = new AbortController()
    const t = await callInFlight('s1', waiting, stop.signal)
    try {
      stop.abort()
      expect((await t.running).reason).toBe('aborted')
      expect(await settledWith(t.seen.call as Promise<SideCallResult>)).toMatchObject({
        value: { status: 'failed', reason: 'cancelled' },
      })
      const rows = await rowsOf(t.session)
      expect(forEffect(rows, 'effect/settled', 's1').map((row) => data(row).outcome)).toEqual(['aborted'])
      expect(ofType(rows, 'x/core/side-call-terminal')).toHaveLength(1)
      // The settlement is committed before the turn ends.
      const [settled] = forEffect(rows, 'effect/settled', 's1')
      expect(settled?.seq).toBeLessThan(ofType(rows, 'turn/end')[0]?.seq ?? 0)
      await closedOnceThenNextTurn(t.session, t.plan, t.kit.billed, 's1')
    } finally {
      await t.kit.host.close()
    }
  })

  it.each<Waiting>(waitings)('② close, the loop %s', async (waiting) => {
    const t = await callInFlight('s2', waiting)
    await t.kit.host.close()
    await t.running.catch(() => undefined)
    await settledWith(t.seen.call as Promise<SideCallResult>)
    const second = await boot(t.dataDir, t.endpoint, t.plan)
    try {
      const reopened = await second.open('stop-s2')
      // Close settled the call and ended its turn; the reopen has nothing to recover.
      expect(second.recovered).toEqual([])
      expect(reopened.op()).toBeNull()
      const rows = await rowsOf(reopened)
      // A close is not a user stop: the call is cut by the closing session and settles as an error.
      expect(forEffect(rows, 'effect/settled', 's2').map((row) => data(row).outcome)).toEqual(['error'])
      expect(
        ofType(rows, 'x/core/side-call-terminal').map((row) => (data(row).terminal as Row).reason),
      ).toEqual(['caller_cancelled'])
      expect(data(ofType(rows, 'turn/end')[0]).reason).toBe('aborted')
      const [settled] = forEffect(rows, 'effect/settled', 's2')
      expect(settled?.seq).toBeLessThan(ofType(rows, 'turn/end')[0]?.seq ?? 0)
      expect(sideBilled(second.billed, 's2')).toEqual([])
      await closedOnceThenNextTurn(reopened, t.plan, t.kit.billed, 's2')
    } finally {
      await second.host.close()
    }
  })

  it('③ idle deadline: it does not cut a dispatched call, and ends the silent loop after the call settled', async () => {
    const endpoint = new Endpoint()
    endpoint.behaviour = 'stall'
    const seen: Seen & { elapsedMs?: number } = {}
    const plan = script(async (port, signal) => {
      const began = performance.now()
      seen.outcome = await settledWith(call(port, 'i-1', signal, { deadlineMs: 1000 }))
      seen.elapsedMs = performance.now() - began
      // Then the loop goes silent until the idle deadline gives up on it and aborts its signal.
      await aborted(signal).catch(() => undefined)
      return { outcome: 'running', phase: 'silent' }
    })
    const kit = await boot(scratch(), endpoint, plan, { modelTimeoutMs: 100 })
    try {
      const session = await kit.open('stop-idle')
      // The host does not set the loop step's idle window; shorten it the way the kernel option does.
      Object.assign(session.d, { loopStepTimeoutMs: 200 })
      const out = await runTurn(session)
      expect(out).toMatchObject({
        reason: 'error',
        error: { message: expect.stringContaining('made no progress') },
      })
      // The call ran to its own deadline, five idle windows long: the window was suspended meanwhile.
      expect(seen.outcome?.value).toMatchObject({ status: 'failed', reason: 'deadline', code: 'TIMEOUT' })
      expect(seen.elapsedMs).toBeGreaterThanOrEqual(1000)
      const rows = await rowsOf(session)
      expect(
        forEffect(rows, 'effect/settled', 'i-1').map((row) => [data(row).outcome, data(row).code]),
      ).toEqual([['error', 'TIMEOUT']])
      expect(ofType(rows, 'x/core/late-effect-receipt')).toEqual([])
      await closedOnceThenNextTurn(session, plan, kit.billed, 'i-1')
    } finally {
      await kit.host.close()
    }
  })

  it.each(['the answer first', 'the Stop first'])(
    '④ the answer and a user Stop arrive together, %s',
    async (order) => {
      const stop = new AbortController()
      const endpoint = new Endpoint()
      endpoint.behaviour = 'gate'
      const seen: Seen = {}
      const plan = script(async (port, signal) => {
        seen.outcome = await settledWith(call(port, 's4', signal))
        return undefined
      })
      const kit = await boot(scratch(), endpoint, plan)
      try {
        const session = await kit.open('stop-race')
        await enqueue(session, 'decide')
        const running = session.run({ until: 'turn-end', signal: stop.signal })
        await endpoint.entering(1)
        if (order === 'the answer first') {
          endpoint.gate.resolve()
          stop.abort()
        } else {
          stop.abort()
          endpoint.gate.resolve()
        }
        expect((await running).reason).toBe('aborted')
        const rows = await rowsOf(session)
        expect(ofType(rows, 'x/core/side-call-terminal')).toHaveLength(1)
        expect(ofType(rows, 'x/core/late-effect-receipt')).toEqual([])
        await closedOnceThenNextTurn(session, plan, kit.billed, 's4')
      } finally {
        await kit.host.close()
      }
    },
  )

  it('refuses a call after its turn has ended (no-turn) and writes nothing', async () => {
    const endpoint = new Endpoint()
    const held: { port?: LoopSideCallPort; prepared?: PreparedSideCall } = {}
    const plan = script(async (port) => {
      held.port = port
      held.prepared = await port.prepare(options('late-1'))
      return undefined
    })
    const kit = await boot(scratch(), endpoint, plan)
    try {
      const session = await kit.open('after-turn')
      expect((await runTurn(session)).reason).toBe('completed')
      expect(session.op()).toBeNull()
      const before = session.lastSeq
      const port = held.port as LoopSideCallPort
      await expect(
        port.invoke(held.prepared as PreparedSideCall, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'E_RELATION', detail: { reason: 'no-turn' } })
      await expect(port.prepare(options('late-2'))).rejects.toMatchObject({
        code: 'E_RELATION',
        detail: { reason: 'no-turn' },
      })
      expect(session.lastSeq).toBe(before)
      expect(endpoint.hits).toHaveLength(0)
      await nextTurnFinishes(session, plan)
      expect(violations(await rowsOf(session))).toEqual([])
    } finally {
      await kit.host.close()
    }
  })
})

// A turn can also end while its side call is in flight with the session itself never stopped: a
// loop step that throws ends the turn as failed, and a loop may end its own turn as cancelled.
// Nothing on those paths stops the call or waits for it. The call runs on to its own deadline, its
// settlement is then refused because the turn has ended, the effect stays pending and the next
// turn cannot close its step until the session is reopened and recovery settles it as unknown.
describe('known gap: a turn ended by its loop while a side call is in flight', () => {
  async function endedUnderCall(id: string, end: (ctx: LoopContext) => Promise<LoopStepOutcome>) {
    const endpoint = new Endpoint()
    endpoint.behaviour = 'stall'
    const seen: Seen = {}
    const plan = script(async (port, signal, ctx) => {
      seen.call = call(port, id, signal, { deadlineMs: 300 })
      seen.call.catch(() => undefined)
      await endpoint.entering(1)
      return end(ctx)
    })
    const kit = await boot(scratch(), endpoint, plan)
    try {
      const session = await kit.open(`gap-${id}`)
      await runTurn(session)
      expect(session.op()).toBeNull()
      // The call ends at its own deadline, after its turn.
      const outcome = await settledWith(seen.call as Promise<SideCallResult>)
      const rows = await rowsOf(session)
      // Each expectation is reported on its own, so a failure shows the whole state left behind.
      expect.soft(pendingSideCalls(session), 'no side-call effect pending after the turn').toEqual([])
      expect.soft(code(outcome.error), 'the call settles without being refused').toBeUndefined()
      expect.soft(forEffect(rows, 'effect/settled', id), 'the call is settled once').toHaveLength(1)
      expect.soft(sideCosts(rows), 'the ledger has its cost row').toHaveLength(1)
      expect.soft(sideBilled(kit.billed, id), 'the billing seam has one row').toHaveLength(1)
      const next = await runTurn(session, 'next')
      expect.soft(plan.refusals.map(String), 'the next turn closes its step').toEqual([])
      expect.soft(next.reason, 'the next turn finishes').toBe('completed')
      expect(violations(await rowsOf(session))).toEqual([])
    } finally {
      await kit.host.close()
    }
  }

  it('a loop step that throws while its call is in flight', () =>
    endedUnderCall('gap-1', async () => {
      throw new Error('loop step failed')
    }))

  it('a loop that ends its own turn as cancelled while its call is in flight', () =>
    endedUnderCall('gap-2', (ctx) => ctx.turn.finishCancelled()))
})
