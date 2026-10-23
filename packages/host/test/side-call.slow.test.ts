import { createHash } from 'node:crypto'
import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getApiKeyProvider } from '@agnes/ai'
import {
  assertLoopbackOnly,
  type FakeSystemOne,
  type FakeSystemOneBehaviour,
  type FakeSystemOneScript,
  fakeModel,
  installLoopbackOnly,
  restoreLoopbackOnly,
  SYSTEMONE_ERROR_BODIES,
  startFakeSystemOne,
} from '@agnes/ai/testkit'
import { CORE_CHECKS, type Event, foldEvents, InvariantRegistry, scanAll } from '@agnes/core'
import {
  type LoopContext,
  type LoopDriver,
  type LoopFactory,
  type LoopSideCallPort,
  type LoopStepOutcome,
  loopCheckpointCodec,
  loopKind,
  type ModelAdapter,
  type ModelAdapterEvent,
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
import type { RuntimeProfileManifest } from '@agnes/host-common/profile/types'
import { createCredentialStore } from '@agnes/host-infrastructure/adapters/credential-store'
import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import { defaultLoopFactory } from '@agnes/loop-default'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import type { JsonValue, RequestBody, RouteDecl } from '@agnes/protocol'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { Type } from '@sinclair/typebox'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { payloadOnlyRoutes } from '../src/index.js'
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
 * signal aborts, as a socket read does, except under `ignore-abort`, which waits for the gate alone.
 * An adapter that ignores its signal keeps its instance's lifetime from draining, so a case that uses
 * it opens the gate before it closes the host.
 */
class Endpoint {
  behaviour: 'answer' | 'stall' | 'hold-before-send' | 'gate' | 'ignore-abort' = 'answer'
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
    if (behaviour === 'ignore-abort') await this.gate.promise
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
    apiRange: '^5.0.0',
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

  it('(e) a damaged SQLite tail refuses recovery without settling or resending its side call', async () => {
    const dataDir = scratch()
    const endpoint = new Endpoint()
    endpoint.behaviour = 'stall'
    const plan = script(async (port, signal) => {
      await settledWith(call(port, 'e-1', signal))
      throw new Error('process ended')
    })
    const first = await boot(dataDir, endpoint, plan)
    const session = await first.open('crash-e')
    await enqueue(session, 'decide')
    void continueTurn(session).catch(() => undefined)
    await endpoint.entering(1)
    const pending = await rowsOf(session)
    expect(forEffect(pending, 'effect/intent', 'e-1')).toHaveLength(1)
    expect(forEffect(pending, 'effect/settled', 'e-1')).toEqual([])
    expect(costs(pending)).toEqual([])
    // SQLite must verify the complete ledger before recovery. Unlike an ordinary interrupted
    // call (cases a/b), corrupt evidence is preserved and the open is refused, not repaired.
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
    const stored = () => {
      const raw = new DatabaseSync(join(dataDir, 'sessions.db'), { readOnly: true })
      try {
        return {
          events: raw.prepare('SELECT * FROM events WHERE session_key = ? ORDER BY seq').all(session.key),
          head: raw
            .prepare('SELECT head_version, head_seq, head_digest FROM sessions WHERE session_key = ?')
            .get(session.key),
          registers: raw
            .prepare('SELECT * FROM registers WHERE session_key = ? ORDER BY register, key')
            .all(session.key),
        }
      } finally {
        raw.close()
      }
    }
    const evidence = stored()
    expect(evidence.events.at(-1)).toMatchObject({ seq: damagedSeq, data: '{' })
    endpoint.behaviour = 'answer'
    const second = await boot(dataDir, endpoint, plan)
    try {
      await expect(second.open('crash-e')).rejects.toMatchObject({
        code: 'E_SESSION_CORRUPT',
        detail: { sessionKey: session.key, cause: 'E_LEDGER_INTEGRITY', issue: 'corrupt' },
      })
      expect(second.recovered).toEqual([])
      expect(sideBilled(second.billed, 'e-1')).toEqual([])
      expect(endpoint.hits).toHaveLength(1)
      expect(stored()).toEqual(evidence)
    } finally {
      await second.host.close()
    }
    expect(stored()).toEqual(evidence)
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
// loop step that throws ends the turn as failed, and a loop may end its own turn as cancelled. The
// end of the turn cuts the call and waits for its settlement before it writes `turn/end`, so the call
// is recorded inside its turn and the next turn closes its step as usual. Core stops reading the
// adapter when it cuts the call, so an adapter that ignores its abort does not hold the turn's end.
describe('a turn ended by its loop while a side call is in flight', () => {
  async function endedUnderCall(
    id: string,
    end: (ctx: LoopContext) => Promise<LoopStepOutcome>,
    behaviour: 'stall' | 'ignore-abort' = 'stall',
    // Far above the time a request takes to reach the adapter on a loaded machine, which includes
    // the request trace capture: the end of the turn, not this deadline, must be what cuts the call.
    deadlineMs = 5000,
  ) {
    const endpoint = new Endpoint()
    endpoint.behaviour = behaviour
    const seen: Seen & { endedMs?: number } = {}
    const plan = script(async (port, signal, ctx) => {
      seen.call = call(port, id, signal, { deadlineMs })
      seen.call.catch(() => undefined)
      // A call that ends before its request reaches the adapter must fail the case, not hold the
      // step, and with it the turn, until the test times out.
      await Promise.race([
        endpoint.entering(1),
        seen.call.then(
          () => undefined,
          () => undefined,
        ),
      ])
      const began = performance.now()
      try {
        return await end(ctx)
      } finally {
        seen.endedMs = performance.now() - began
      }
    })
    const kit = await boot(scratch(), endpoint, plan)
    try {
      const session = await kit.open(`ended-${id}`)
      await runTurn(session)
      expect(endpoint.signals, 'the call reached the adapter before its turn ended').toHaveLength(1)
      expect(session.op()).toBeNull()
      // The end of the turn cut the call before its own deadline and waited for its settlement.
      const outcome = await settledWith(seen.call as Promise<SideCallResult>)
      const rows = await rowsOf(session)
      // Each expectation is reported on its own, so a failure shows the whole state left behind.
      expect.soft(pendingSideCalls(session), 'no side-call effect pending after the turn').toEqual([])
      expect.soft(code(outcome.error), 'the call settles without being refused').toBeUndefined()
      expect.soft(forEffect(rows, 'effect/settled', id), 'the call is settled once').toHaveLength(1)
      expect.soft(sideCosts(rows), 'the ledger has its cost row').toHaveLength(1)
      expect.soft(sideBilled(kit.billed, id), 'the billing seam has one row').toHaveLength(1)
      expect(outcome.value).toMatchObject({
        status: 'failed',
        reason: 'cancelled',
        dispatch: 'may-have-sent',
        replayed: false,
      })
      expect(endpoint.signals[0]?.aborted).toBe(true)
      expect(forEffect(rows, 'effect/settled', id).map((row) => data(row).outcome)).toEqual(['error'])
      expect(
        forEffect(rows, 'x/core/side-call-terminal', id).map((row) => (data(row).terminal as Row).reason),
      ).toEqual(['caller_cancelled'])
      const [settled] = forEffect(rows, 'effect/settled', id)
      expect(settled?.seq).toBeLessThan(ofType(rows, 'turn/end')[0]?.seq ?? 0)
      expect(
        ofType(rows, 'x/core/invariant').filter((row) => data(row).kind === 'side-call-unsettled'),
      ).toEqual([])
      // A loop that ends its own turn waits only until Core has cut and recorded the call.
      expect(seen.endedMs).toBeLessThan(Math.min(deadlineMs, 2000))
      const next = await runTurn(session, 'next')
      expect.soft(plan.refusals.map(String), 'the next turn closes its step').toEqual([])
      expect.soft(next.reason, 'the next turn finishes').toBe('completed')
      expect(violations(await rowsOf(session))).toEqual([])
    } finally {
      endpoint.gate.resolve()
      await kit.host.close()
    }
  }

  it('a loop step that throws while its call is in flight', () =>
    endedUnderCall('end-1', async () => {
      throw new Error('loop step failed')
    }))

  it('a loop that ends its own turn as cancelled while its call is in flight', () =>
    endedUnderCall('end-2', (ctx) => ctx.turn.finishCancelled()))

  it('a loop that ends its own turn while the adapter ignores the abort of its call', () =>
    endedUnderCall('end-3', (ctx) => ctx.turn.finishCancelled(), 'ignore-abort', 5000))
})

// The cases below run side calls through the built-in typesafe-systemone adapter, over real sockets,
// against a loopback stand-in for the vendor endpoint. The conversation model is the built-in
// scripted adapter, so both routes go through the production provider assembly.

const JEV = Object.freeze({ route: 'jev', model: 'typesafe/jev-1.13-20260917' })
const MAIN = Object.freeze({ route: 'main', model: 'main-1' })
/** A placeholder: the stand-in accepts any bearer key, and no ledger row may carry this one. */
const JEV_KEY = 'TEST-KEY-0123456789'
const JEV_CREDENTIAL = 'secret://jev/key'
const DECIDING_LOOP = Object.freeze({ id: 'test.deciding', version: '1.0.0' })
const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']
const FALLBACK_TEXT = 'Answered by the conversation model.'
const QUESTIONS = {
  done: {
    type: 'noul',
    instructions: 'Is the request already answered?',
    criteria: { true: 'it is answered', false: 'more work is needed' },
  },
  next: {
    type: 'choice',
    instructions: 'What should happen next?',
    criteria: { answer: 'answer from what is known', model: 'ask the conversation model' },
  },
} as const
const decisionPayload = (state: Record<string, JsonValue>): JsonValue => ({ state, questions: QUESTIONS })

type Tokens = { input: number; output?: number; cacheRead?: number }
const usageEvent = (t: Tokens): ModelAdapterEvent => ({
  type: 'usage',
  tokens: { input: t.input, output: t.output ?? 0, cacheRead: t.cacheRead ?? 0, cacheWrite: 0 },
  creditSource: 'estimated',
})
const textReply = (text: string, t: Tokens): ModelAdapterEvent[] => [
  { type: 'text_delta', delta: text },
  usageEvent(t),
  { type: 'done', reason: 'stop' },
]
const readReply = (toolUseId: string, t: Tokens): ModelAdapterEvent[] => [
  { type: 'toolcall_end', call: { toolUseId, name: 'read', args: { path: 'notes.txt' }, ordinal: 0 } },
  usageEvent(t),
  { type: 'done', reason: 'toolUse' },
]

const jevRoute = (baseUrl: string): RouteDecl => ({
  route: JEV.route,
  api: 'typesafe-systemone',
  baseUrl,
  credentialRef: JEV_CREDENTIAL,
  models: [
    fakeModel({
      id: JEV.model,
      route: JEV.route,
      api: 'typesafe-systemone',
      baseUrl,
      contextWindow: 64000,
      toolCallFormats: [],
      // The vendor prices input tokens only: 0.042 dollars per million.
      cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  ],
})
/** The conversation model: the built-in scripted adapter, answering from `replies` in order. */
const mainRoute = (replies: ModelAdapterEvent[][], contextWindow: number): RouteDecl => ({
  route: MAIN.route,
  api: 'scripted',
  baseUrl: 'https://scripted.invalid',
  compat: { replies, repeatLast: true },
  models: [
    fakeModel({
      id: MAIN.model,
      route: MAIN.route,
      api: 'scripted',
      baseUrl: 'https://scripted.invalid',
      contextWindow,
    }),
  ],
})

/** A scratch data directory with the route's key in a file secret store, as an operator keeps it. */
function jevDataDir(): string {
  const dataDir = scratch()
  const store = join(dataDir, 'credentials')
  createPrivateDirectorySync(store)
  createPrivateDirectorySync(join(store, 'jev'))
  const fd = createPrivateFileSync(join(store, 'jev', 'key'))
  try {
    writeFileSync(fd, JEV_KEY)
  } finally {
    closeSync(fd)
  }
  return dataDir
}

const fakes: FakeSystemOne[] = []
async function startJev(script: FakeSystemOneScript = {}): Promise<FakeSystemOne> {
  const fake = await startFakeSystemOne(script)
  fakes.push(fake)
  return fake
}

/**
 * How soon a closed pool must show as closed on the server side: well inside the few seconds after
 * which an idle kept-alive connection closes by itself, so only an actual close passes.
 */
const CLOSED_WITHIN_MS = 1500

/** Polls a condition that has no event of its own (a socket closing on the server side), bounded. */
async function until(condition: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

type JevBoot = {
  loop: LoopFactory
  /** The conversation model's replies; by default it answers every request with one short text. */
  main?: ModelAdapterEvent[][]
  mainContextWindow?: number
  /** A per-request credit cap, which makes Core run its budget preflight before every model step. */
  perRequestCap?: number
  /** Wins over the default user layer: the configuration overlay becomes the whole account layer. */
  userLayer?: RuntimeProfileManifest
}

/** One process: a real host whose profile declares the Jev route first and the conversation route second. */
async function bootJev(dataDir: string, fake: FakeSystemOne, o: JevBoot) {
  const billed: Row[] = []
  const t = await createTestHost({
    dataDir,
    disableSessionTitle: true,
    ...(o.perRequestCap === undefined
      ? {}
      : {
          presets: {
            standard: {
              name: 'standard',
              extends: 'base',
              disclosure: 'standard',
              model: { route: { primary: 'default' } },
              budget: {
                preflight: 'estimate',
                per_request_cap: o.perRequestCap,
                on_exceed: 'quote',
                max_steps: 50,
              },
            },
          },
        }),
    limits: { 'cost.credits_per_usd': 100 },
    seams: {
      billing: {
        record: async (row) => {
          billed.push(row as unknown as Row)
        },
      },
    },
    profileInputs: {
      user: o.userLayer ?? {
        name: 'local-dev',
        provider: {
          package: '@agnes/ai',
          routes: [
            jevRoute(fake.url),
            mainRoute(o.main ?? [textReply(FALLBACK_TEXT, { input: 100 })], o.mainContextWindow ?? 200_000),
          ],
        },
        adapters: { secrets: { kind: 'file', path: join(dataDir, 'credentials') } },
      },
    },
    packages: {
      '@agnes/code': { plugins: [providerRow(`loop:${o.loop.id}`, 'jevTestLoop', loopKind, o.loop)] },
    },
  })
  const recovered: SessionRecovery[] = []
  const open = (key: string) =>
    t.host.createSession({
      key,
      cwd: dataDir,
      loop: { id: o.loop.id, version: o.loop.version },
      onRecovered: (recovery) => {
        recovered.push(recovery)
      },
    })
  return { ...t, billed, recovered, open }
}

/** Where the deciding loop is about to go: a default-loop edge, counted per turn. */
type Edge = Readonly<{ continuation: 'model' | 'checkpoint'; turn: number; index: number }>
/** What the loop does before an edge; `finish` ends the turn on the answer, without the edge. */
type Ask = (port: LoopSideCallPort, signal: AbortSignal, edge: Edge) => Promise<'finish' | undefined>

/**
 * A loop in the shape of a decision loop: the default loop's edges, with a question to the decision
 * model before the edges the case picks. When the answer settles the turn it ends the turn there;
 * otherwise, and whenever the call fails or the answer is unusable, it falls back to the default edge,
 * which asks the conversation model. `phases` collects the phase each default step reports.
 */
function decidingLoop(ask: Ask, phases: string[] = []): LoopFactory {
  const create = async (ctx: LoopContext): Promise<LoopDriver> => {
    const inner = await defaultLoopFactory.create(ctx)
    const seen = new Map<string, number>()
    return {
      cancel: () => inner.cancel(),
      dispose: () => inner.dispose(),
      checkpoint: () => inner.checkpoint(),
      async step(signal: AbortSignal): Promise<LoopStepOutcome> {
        const continuation = ctx.turn.continuation()
        if (
          (continuation === 'model' || continuation === 'checkpoint') &&
          !ctx.turn.cancelled() &&
          !signal.aborted
        ) {
          if (!ctx.sideCall) throw new Error('Core provides ctx.sideCall to every loop context')
          const turn = (await ctx.turn.view())?.turnId ?? 0
          const key = `${turn}:${continuation}`
          const index = seen.get(key) ?? 0
          seen.set(key, index + 1)
          if ((await ask(ctx.sideCall, signal, { continuation, turn, index })) === 'finish')
            return ctx.events.finish('completed')
        }
        const out = await inner.step(signal)
        if (out.phase) phases.push(out.phase)
        return out
      },
    }
  }
  return {
    ...defaultLoopFactory,
    ...DECIDING_LOOP,
    create,
    resume: (ctx, checkpoint) => {
      defaultLoopFactory.codec.decode(checkpoint)
      return create(ctx)
    },
  }
}

/** One decision question to the Jev route, as a decision loop asks it. */
const decide = async (
  port: LoopSideCallPort,
  id: string,
  signal: AbortSignal,
  over: Partial<SideCallOptions> = {},
) =>
  port.invoke(
    await port.prepare({
      label: 'test.decide',
      target: JEV,
      payload: decisionPayload({ step: 1 }),
      output: 'json',
      deadlineMs: 5000,
      invocationId: id,
      ...over,
    }),
    signal,
  )

/** The loop's own check of an answer: only well-formed answers to what it asked are used. */
function usableAnswer(result: SideCallResult): { done: number } | undefined {
  if (result.status !== 'ok') return undefined
  const answers = result.json as Record<string, { type?: unknown; noul?: unknown; choice?: unknown }> | null
  const done = answers?.done
  const next = answers?.next
  if (done?.type !== 'noul' || typeof done.noul !== 'number' || done.noul < 0 || done.noul > 1)
    return undefined
  if (next?.type !== 'choice' || !Object.keys(QUESTIONS.next.criteria).includes(String(next.choice)))
    return undefined
  return { done: done.noul }
}

/** A tool the conversation model can call, so one turn takes two model steps. */
function addReadTool(session: HostSession): void {
  session.currentTools().add(
    {
      name: 'read',
      description: 'Reads a note',
      parameters: Type.Object({ path: Type.String() }),
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        replay: 'safe',
        costHint: {},
        deferLoading: false,
        requiresApproval: 'never',
      },
      // An empty result adds nothing to the context estimate, so the context stays the reported 180 400.
      execute: async () => ({ content: [{ type: 'text', text: '' }] }),
    },
    { source: 'test/read', trust: 'builtin' },
  )
}

const sideRows = (rows: Event[], type: string) =>
  ofType(rows, type).filter((row) => String(data(row).effectId ?? '').startsWith('side:'))
const bindingOf = (rows: Event[], id: string) =>
  data(
    ofType(rows, 'x/core/side-call-intent').find(
      (row) => (data(row).binding as Row | undefined)?.effectId === `side:${id}`,
    ),
  )
const terminalOf = (rows: Event[], id: string) =>
  data(forEffect(rows, 'x/core/side-call-terminal', id)[0]).terminal as Row | undefined

describe('side model calls through the built-in typesafe-systemone adapter', () => {
  const savedEnv = new Map<string, string | undefined>()
  beforeAll(() => {
    installLoopbackOnly()
    // The deployment pool honours the proxy variables, which would send even loopback traffic
    // through a proxy configured on the machine running the tests.
    for (const key of [...PROXY_VARIABLES, 'NO_PROXY', 'no_proxy']) savedEnv.set(key, process.env[key])
    for (const key of PROXY_VARIABLES) delete process.env[key]
    process.env.NO_PROXY = '127.0.0.1,localhost'
    delete process.env.no_proxy
  })
  afterAll(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    restoreLoopbackOnly()
  })
  afterEach(async () => {
    await Promise.all(fakes.splice(0).map((fake) => fake.close()))
    assertLoopbackOnly()
  })

  describe('the conversation context', () => {
    /** The conversation anchor and the context the UI shows, read at one moment. */
    type Reading = { anchor: number | null; ui: number | null }
    const read = async (session: HostSession): Promise<Reading> => ({
      anchor: session.state.lastLedgerTokens?.total ?? null,
      ui: (await session.projectUI()).usage?.context?.tokens ?? null,
    })

    /**
     * One turn of two model steps: the conversation model calls a tool, reporting 180 400 tokens
     * (30 000 new input, 150 000 read from a cache, 400 output), and then answers on a cache miss.
     * With `withSideCalls` the loop asks the decision model twice between the tool result and the
     * second reply; a per-request cap makes Core run its budget preflight before that reply.
     */
    async function twoCallsBeforeAReply(withSideCalls: boolean) {
      const fake = await startJev()
      const holder: { session?: HostSession } = {}
      const seen: { before?: Reading; after?: Reading; results: SideCallResult[] } = { results: [] }
      const loop = decidingLoop(async (port, signal, edge) => {
        if (edge.turn !== 1 || edge.continuation !== 'model' || edge.index !== 1) return undefined
        const session = holder.session as HostSession
        seen.before = await read(session)
        if (withSideCalls)
          for (const id of ['anchor-1', 'anchor-2']) seen.results.push(await decide(port, id, signal))
        seen.after = await read(session)
        return undefined
      })
      const kit = await bootJev(jevDataDir(), fake, {
        loop,
        main: [
          readReply('read-1', { input: 30_000, cacheRead: 150_000, output: 400 }),
          textReply('The window is 30 days.', { input: 151_000, output: 300 }),
        ],
        perRequestCap: 1_000_000,
      })
      try {
        const session = await kit.open(`anchor-${withSideCalls}`)
        holder.session = session
        addReadTool(session)
        expect((await runTurn(session)).reason).toBe('completed')
        const rows = await rowsOf(session)
        const [, secondReply] = costs(rows).filter((row) => data(row).purpose === 'inference')
        const lastSideCall = sideRows(rows, 'effect/settled').at(-1)?.seq ?? 0
        // The preflight Core ran for the second reply: the last one before that reply's cost row.
        const preflight = ofType(rows, 'budget.state')
          .filter((row) => row.seq < (secondReply?.seq ?? 0))
          .at(-1)
        return {
          seen,
          hits: fake.seen.length,
          steps: ofType(rows, 'step/start').length,
          sideCosts: sideCosts(rows).length,
          preflight: {
            tokens: (data(preflight).lastPreflight as Row | undefined)?.tokens,
            afterSideCalls: (preflight?.seq ?? 0) > lastSideCall,
          },
          invalidation: (await session.projectUI()).usage?.cache?.lastInvalidation,
          violations: violations(rows),
        }
      } finally {
        await kit.host.close()
      }
    }

    it('leaves the context anchor, the context the UI shows, the budget preflight and the step count as without the calls', async () => {
      const control = await twoCallsBeforeAReply(false)
      const side = await twoCallsBeforeAReply(true)
      expect(side.seen.results.map((result) => result.status)).toEqual(['ok', 'ok'])
      expect([control.hits, side.hits]).toEqual([0, 2])
      expect(side.sideCosts).toBe(2)
      const conversation = { anchor: 180_400, ui: 180_400 }
      for (const run of [control, side]) {
        expect(run.seen.before).toEqual(conversation)
        expect(run.seen.after).toEqual(conversation)
        // A side call opens no Core step: both turns take the two steps of their two replies.
        expect(run.steps).toBe(2)
        // The real cache miss on the second reply is still seen as one.
        expect(run.invalidation).toMatchObject({ reprocessedTokens: 151_000, cause: 'history-changed' })
        expect(run.violations).toEqual([])
      }
      expect(control.preflight.tokens).toBe(180_400)
      // The side calls moved the credits used, so Core estimated again for the second reply, after them.
      expect(side.preflight).toEqual({ tokens: 180_400, afterSideCalls: true })
    })

    /**
     * A first turn whose last model rows are two side calls, and a second turn whose input carries
     * the context over the compaction threshold. The window is set so that the conversation's
     * 180 400 tokens alone stay under the threshold (196 900 - 16 384 = 180 516) and the second
     * input's estimated 488 tokens take it over; counted from a side call's 189 tokens it never would.
     */
    async function turnEndingOnTwoCalls(withSideCalls: boolean) {
      const fake = await startJev()
      const phases: string[] = []
      const holder: { session?: HostSession } = {}
      const seen: { after?: Reading; results: SideCallResult[] } = { results: [] }
      const loop = decidingLoop(async (port, signal, edge) => {
        // The checkpoint after the first reply, where the turn ends.
        if (edge.turn !== 1 || edge.continuation !== 'checkpoint' || edge.index !== 1) return undefined
        if (withSideCalls)
          for (const id of ['last-1', 'last-2']) seen.results.push(await decide(port, id, signal))
        seen.after = await read(holder.session as HostSession)
        return undefined
      }, phases)
      const kit = await bootJev(jevDataDir(), fake, {
        loop,
        main: [
          textReply('First answer.', { input: 180_000, output: 400 }),
          textReply('Second answer.', { input: 600, output: 20 }),
        ],
        mainContextWindow: 196_900,
      })
      try {
        const session = await kit.open(`compaction-${withSideCalls}`)
        holder.session = session
        expect((await runTurn(session)).reason).toBe('completed')
        const firstEnd = session.lastSeq
        const firstPhases = phases.splice(0)
        expect((await runTurn(session, 'Please also check the exchange window. '.repeat(50))).reason).toBe(
          'completed',
        )
        const rows = await rowsOf(session)
        const marks = (from: number, to: number) =>
          ofType(rows, 'x/core/op-mark')
            .filter((row) => row.seq > from && row.seq <= to)
            .map((row) => data(row).phase)
        return {
          seen,
          hits: fake.seen.length,
          first: { phases: firstPhases, marks: marks(0, firstEnd) },
          second: { phases, marks: marks(firstEnd, session.lastSeq) },
          violations: violations(rows),
        }
      } finally {
        await kit.host.close()
      }
    }

    it('sends the next turn into compaction when the turn before ended on two calls', async () => {
      const control = await turnEndingOnTwoCalls(false)
      const side = await turnEndingOnTwoCalls(true)
      expect(side.seen.results.map((result) => result.status)).toEqual(['ok', 'ok'])
      expect([control.hits, side.hits]).toEqual([0, 2])
      for (const run of [control, side]) {
        expect(run.seen.after).toEqual({ anchor: 180_400, ui: 180_400 })
        expect(run.first.marks).not.toContain('compaction')
        // The second turn's threshold check reads the conversation, not the side calls.
        expect(run.second.marks).toContain('compaction')
        expect(run.second.phases).toContain('compaction')
        expect(run.violations).toEqual([])
      }
    })
  })

  /** Answers that settle the turn: the loop ends it on them without asking the conversation model. */
  const CONFIDENT = { done: { type: 'noul', noul: 0.95 } }

  /**
   * Asks once before the first model edge of every turn, with the id `decide-<turn>`. A usable and
   * confident answer ends the turn; anything else - a failed call, an unusable answer, a refusal -
   * falls back to the conversation model.
   */
  function askBeforeReply(
    results: SideCallResult[],
    over: (turn: number) => Partial<SideCallOptions> = () => ({}),
    refusals: unknown[] = [],
  ): Ask {
    return async (port, signal, edge) => {
      if (edge.continuation !== 'model' || edge.index !== 0) return undefined
      let result: SideCallResult
      try {
        result = await decide(port, `decide-${edge.turn}`, signal, over(edge.turn))
      } catch (error) {
        refusals.push(error)
        return undefined
      }
      results.push(result)
      const answer = usableAnswer(result)
      return answer && answer.done >= 0.9 ? 'finish' : undefined
    }
  }
  const replies = (rows: Event[]) =>
    ofType(rows, 'assistant/message').map((row) =>
      ((data(row).content ?? []) as Array<{ type: string; text?: string }>)
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join(''),
    )
  const conversationCosts = (rows: Event[]) => costs(rows).filter((row) => data(row).purpose === 'inference')
  const auditFields = (fake: FakeSystemOne) => ({
    route: JEV.route,
    adapter: { id: 'typesafe-systemone', version: '1.0.0' },
    endpointHost: new URL(fake.url).host,
  })

  it('prices a call at the price the vendor reports, in the cost row and at the billing seam', async () => {
    // The vendor reports only its price for the call: 420 micro-dollars, which at 100 credits per
    // dollar is 0.042 credits. The catalog price for its 180 input tokens would have made it 0.000756.
    const fake = await startJev({
      usage: { input_tokens: 180, output_tokens: 9, cost: 0.00042 },
      answers: CONFIDENT,
    })
    const results: SideCallResult[] = []
    const kit = await bootJev(jevDataDir(), fake, { loop: decidingLoop(askBeforeReply(results)) })
    try {
      const session = await kit.open('jev-billing')
      expect((await runTurn(session)).reason).toBe('completed')
      expect(results).toMatchObject([
        {
          status: 'ok',
          usage: {
            credits: 0.042,
            creditSource: 'gateway',
            billing: { usdMicros: 420, source: 'gateway', subscription: false },
          },
        },
      ])
      const rows = await rowsOf(session)
      expect(sideCosts(rows).map(data)).toEqual([
        expect.objectContaining({
          effectId: 'side:decide-1',
          model: JEV.model,
          tokens: { input: 180, output: 9, cacheRead: 0, cacheWrite: 0 },
          credits: 0.042,
          creditSource: 'gateway',
          billing: { usdMicros: 420, source: 'gateway', subscription: false },
          ...auditFields(fake),
        }),
      ])
      // The seam receives the same row, with the route, the adapter and the endpoint host on it.
      expect(sideBilled(kit.billed, 'decide-1')).toEqual([
        expect.objectContaining({ credits: 0.042, creditSource: 'gateway', ...auditFields(fake) }),
      ])
      // The answer settled the turn, so the conversation model was never asked.
      expect(conversationCosts(rows)).toEqual([])
      expect(fake.seen).toHaveLength(1)
      expect(violations(rows)).toEqual([])
    } finally {
      await kit.host.close()
    }
  })

  it('records who served each call on its binding row, without the key or the path of the endpoint', async () => {
    const fake = await startJev({ answers: CONFIDENT })
    const results: SideCallResult[] = []
    const kit = await bootJev(jevDataDir(), fake, { loop: decidingLoop(askBeforeReply(results)) })
    try {
      const session = await kit.open('jev-audit')
      expect((await runTurn(session)).reason).toBe('completed')
      expect(results.map((result) => result.status)).toEqual(['ok'])
      // The key did reach the vendor, as a bearer token.
      expect(fake.seen.map((seen) => [seen.path, seen.authorization])).toEqual([
        ['/v1/systemone', `Bearer ${JEV_KEY}`],
      ])
      const rows = await rowsOf(session)
      const binding = bindingOf(rows, 'decide-1')
      expect(binding.binding).toMatchObject({ effectId: 'side:decide-1', route: JEV.route, model: JEV.model })
      expect(binding.audit).toMatchObject({
        label: 'test.decide',
        adapter: { id: 'typesafe-systemone', version: '1.0.0' },
        api: 'typesafe-systemone',
        endpointHost: new URL(fake.url).host,
        deadlineMs: 5000,
      })
      const written = JSON.stringify(binding)
      for (const absent of [JEV_KEY, JEV_CREDENTIAL, 'Bearer', fake.url, 'http:', '/v1', '/systemone'])
        expect(written).not.toContain(absent)
      // Nor does any other row of the ledger carry the key, its reference or the endpoint URL.
      const ledger = JSON.stringify(rows)
      for (const absent of [JEV_KEY, JEV_CREDENTIAL, fake.url, '/systemone'])
        expect(ledger).not.toContain(absent)
      expect(violations(rows)).toEqual([])
    } finally {
      await kit.host.close()
    }
  })

  it('ends a call to an endpoint that never answers at the loop deadline of two seconds', async () => {
    const fake = await startJev({ hang: true })
    const seen: { result?: SideCallResult; elapsedMs?: number } = {}
    const loop = decidingLoop(async (port, signal, edge) => {
      if (edge.continuation !== 'model' || edge.index !== 0) return undefined
      const began = performance.now()
      seen.result = await decide(port, 'slow-1', signal, { deadlineMs: 2000 })
      seen.elapsedMs = performance.now() - began
      return undefined
    })
    const kit = await bootJev(jevDataDir(), fake, { loop })
    try {
      const session = await kit.open('jev-deadline')
      expect((await runTurn(session)).reason).toBe('completed')
      expect(seen.result).toMatchObject({
        status: 'failed',
        reason: 'deadline',
        code: 'TIMEOUT',
        retryable: true,
        dispatch: 'may-have-sent',
      })
      expect(seen.elapsedMs).toBeGreaterThanOrEqual(1990)
      expect(seen.elapsedMs).toBeLessThan(3000)
      expect(fake.seen).toHaveLength(1)
      const rows = await rowsOf(session)
      expect(terminalOf(rows, 'slow-1')).toMatchObject({
        kind: 'unknown_spend',
        reason: 'deadline_exceeded',
        code: 'TIMEOUT',
      })
      expect(sideCosts(rows).map((row) => [data(row).creditSource, data(row).interrupted])).toEqual([
        ['estimated', true],
      ])
      expect(sideBilled(kit.billed, 'slow-1')).toHaveLength(1)
      expect(replies(rows)).toEqual([FALLBACK_TEXT])
      expect(violations(rows)).toEqual([])
    } finally {
      await kit.host.close()
    }
  })

  it('ends a call at the loop deadline of two seconds even when the adapter ignores its abort', async () => {
    // The built-in adapter honours its abort signal, so this uses the test adapter that does not:
    // Core stops reading at its own deadline and does not wait for the adapter.
    const endpoint = new Endpoint()
    endpoint.behaviour = 'ignore-abort'
    const seen: { result?: SideCallResult; elapsedMs?: number } = {}
    const plan = script(async (port, signal) => {
      const began = performance.now()
      seen.result = await call(port, 'ignored-1', signal, { deadlineMs: 2000 })
      seen.elapsedMs = performance.now() - began
      return undefined
    })
    const kit = await boot(scratch(), endpoint, plan)
    try {
      const session = await kit.open('ignored-abort')
      expect((await runTurn(session)).reason).toBe('completed')
      expect(seen.result).toMatchObject({ status: 'failed', reason: 'deadline', code: 'TIMEOUT' })
      expect(seen.elapsedMs).toBeGreaterThanOrEqual(1990)
      expect(seen.elapsedMs).toBeLessThan(3000)
      expect(endpoint.signals[0]?.aborted).toBe(true)
      const rows = await rowsOf(session)
      expect(forEffect(rows, 'effect/settled', 'ignored-1').map((row) => data(row).code)).toEqual(['TIMEOUT'])
      expect(violations(rows)).toEqual([])
    } finally {
      // The adapter's stream is still waiting; let it end so the host can drain it.
      endpoint.gate.resolve()
      await kit.host.close()
    }
  })

  it('closes the endpoint connections when the model profile is replaced and when the host closes', async () => {
    const fake = await startJev({ answers: CONFIDENT })
    const results: SideCallResult[] = []
    // Two calls before the first model edge of each turn, then the turn ends on the answer.
    const loop = decidingLoop(async (port, signal, edge) => {
      if (edge.continuation !== 'model' || edge.index !== 0) return undefined
      for (const id of [`pool-${edge.turn}-a`, `pool-${edge.turn}-b`])
        results.push(await decide(port, id, signal))
      return 'finish'
    })
    const kit = await bootJev(jevDataDir(), fake, { loop })
    let closed = false
    try {
      const session = await kit.open('jev-pool')
      expect((await runTurn(session)).reason).toBe('completed')
      // Both calls went over one kept-alive connection.
      expect(fake.accepts()).toBe(1)
      expect(fake.openSockets()).toBe(1)
      await kit.host.applyModelProfile(structuredClone(kit.host.profile))
      // The retired provider closes its pool; nothing is left open on the server side.
      await until(() => fake.openSockets() === 0, CLOSED_WITHIN_MS)
      expect((await runTurn(session, 'again')).reason).toBe('completed')
      expect(fake.accepts()).toBe(2)
      expect(fake.openSockets()).toBe(1)
      expect(results.map((result) => result.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
      expect(new Set(fake.seen.map((seen) => seen.socket))).toEqual(new Set([1, 2]))
      expect(violations(await rowsOf(session))).toEqual([])
      closed = true
      await kit.host.close()
      await until(() => fake.openSockets() === 0, CLOSED_WITHIN_MS)
      expect(fake.accepts()).toBe(2)
    } finally {
      if (!closed) await kit.host.close()
    }
  })

  describe('when a call does not give the loop a usable answer, the loop falls back', () => {
    it('to the conversation model when an answer fails the loop check or the call is refused before sending', async () => {
      // First turn: an answer naming an option nobody asked about. Second turn: a payload over the
      // 1 MiB limit, refused before anything is written. Third turn: a usable answer, which settles
      // the turn without the conversation model, so the two fallbacks are the loop's choice.
      const fake = await startJev((n) =>
        n === 0 ? { answers: { next: { type: 'choice', choice: 'elsewhere' } } } : { answers: CONFIDENT },
      )
      const results: SideCallResult[] = []
      const refusals: unknown[] = []
      const tooLarge = decisionPayload({ notes: 'x'.repeat(1_100_000) })
      const loop = decidingLoop(
        askBeforeReply(results, (turn) => (turn === 2 ? { payload: tooLarge } : {}), refusals),
      )
      const kit = await bootJev(jevDataDir(), fake, { loop })
      try {
        const session = await kit.open('jev-unusable')
        for (const text of ['first', 'second', 'third'])
          expect((await runTurn(session, text)).reason).toBe('completed')
        expect(results.map((result) => result.status)).toEqual(['ok', 'ok'])
        expect(usableAnswer(results[0] as SideCallResult)).toBeUndefined()
        expect(usableAnswer(results[1] as SideCallResult)).toEqual({ done: 0.95 })
        expect(refusals).toEqual([
          expect.objectContaining({ code: 'E_ENVELOPE', detail: { reason: 'payload-size' } }),
        ])
        expect(fake.seen).toHaveLength(2)
        const rows = await rowsOf(session)
        // The refused call wrote nothing; the two that ran have their records and cost rows.
        expect(
          ofType(rows, 'x/core/side-call-intent').map((row) => (data(row).binding as Row).effectId),
        ).toEqual(['side:decide-1', 'side:decide-3'])
        expect(sideCosts(rows).map((row) => data(row).creditSource)).toEqual(['gateway', 'gateway'])
        expect(replies(rows)).toEqual([FALLBACK_TEXT, FALLBACK_TEXT])
        expect(conversationCosts(rows)).toHaveLength(2)
        expect(violations(rows)).toEqual([])
      } finally {
        await kit.host.close()
      }
    })

    it('to the conversation model when the vendor rejects the whole request with HTTP 400', async () => {
      const fake = await startJev({ status: 400, body: SYSTEMONE_ERROR_BODIES.validation })
      const results: SideCallResult[] = []
      const kit = await bootJev(jevDataDir(), fake, { loop: decidingLoop(askBeforeReply(results)) })
      try {
        const session = await kit.open('jev-rejected')
        expect((await runTurn(session)).reason).toBe('completed')
        expect(results).toMatchObject([
          {
            status: 'failed',
            reason: 'adapter-error',
            code: 'CONTRACT_MISMATCH',
            retryable: false,
            dispatch: 'may-have-sent',
            usage: { credits: 0, creditSource: 'gateway' },
          },
        ])
        // Sent once and not again: the adapter does not retry, and this failure is not retryable.
        expect(fake.seen).toHaveLength(1)
        const rows = await rowsOf(session)
        expect(forEffect(rows, 'effect/settled', 'decide-1').map(data)).toEqual([
          expect.objectContaining({ outcome: 'error', code: 'CONTRACT_MISMATCH' }),
        ])
        expect(terminalOf(rows, 'decide-1')).toMatchObject({
          kind: 'known_spend',
          reason: 'driver_failed',
          code: 'CONTRACT_MISMATCH',
          retryable: false,
        })
        // The vendor does not charge a rejected request: the adapter reports zero usage first.
        expect(sideCosts(rows).map(data)).toEqual([
          expect.objectContaining({
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            credits: 0,
            creditSource: 'gateway',
          }),
        ])
        expect(sideBilled(kit.billed, 'decide-1')).toHaveLength(1)
        // Nothing the vendor said reaches the ledger.
        const ledger = JSON.stringify(rows)
        for (const vendorText of ['user_fake_000', 'Field required']) expect(ledger).not.toContain(vendorText)
        expect(replies(rows)).toEqual([FALLBACK_TEXT])
        expect(violations(rows)).toEqual([])
      } finally {
        await kit.host.close()
      }
    })

    it('to the conversation model when the call runs out its deadline', async () => {
      const fake = await startJev({ hang: true })
      const results: SideCallResult[] = []
      const kit = await bootJev(jevDataDir(), fake, {
        loop: decidingLoop(askBeforeReply(results, () => ({ deadlineMs: 1000 }))),
      })
      try {
        const session = await kit.open('jev-timeout')
        expect((await runTurn(session)).reason).toBe('completed')
        expect(results).toMatchObject([
          {
            status: 'failed',
            reason: 'deadline',
            code: 'TIMEOUT',
            retryable: true,
            usage: { creditSource: 'estimated' },
          },
        ])
        expect(fake.seen).toHaveLength(1)
        const rows = await rowsOf(session)
        const frozen = audit(rows, 'decide-1')
        expect(data(sideCosts(rows)[0])).toMatchObject({
          tokens: { input: frozen.inputTokens, output: 0, cacheRead: 0, cacheWrite: 0 },
          credits: frozen.projectedCredits,
          creditSource: 'estimated',
          interrupted: true,
        })
        expect(forEffect(rows, 'effect/settled', 'decide-1').map(data)).toEqual([
          expect.objectContaining({ outcome: 'error', code: 'TIMEOUT' }),
        ])
        expect(terminalOf(rows, 'decide-1')).toMatchObject({
          kind: 'unknown_spend',
          reason: 'deadline_exceeded',
        })
        expect(sideBilled(kit.billed, 'decide-1')).toHaveLength(1)
        expect(replies(rows)).toEqual([FALLBACK_TEXT])
        expect(violations(rows)).toEqual([])
      } finally {
        await kit.host.close()
      }
    })

    it('to the conversation model after a process dies with the call out, and the reopen does not send it again', async () => {
      const dataDir = jevDataDir()
      const arrived = deferred()
      let reply: FakeSystemOneBehaviour = { hang: true }
      const fake = await startJev(() => {
        arrived.resolve()
        return reply
      })
      const results: SideCallResult[] = []
      const loop = decidingLoop(askBeforeReply(results))
      const first = await bootJev(dataDir, fake, { loop })
      const session = await first.open('jev-crash')
      await enqueue(session, 'decide')
      void continueTurn(session).catch(() => undefined)
      await arrived.promise
      expect(forEffect(await rowsOf(session), 'effect/intent', 'decide-1')).toHaveLength(1)
      await crash(first, session)
      // The dying host's teardown closed the connection that carried the call.
      await until(() => fake.openSockets() === 0, CLOSED_WITHIN_MS)
      // What the dying process's loop saw is not part of the record a killed process leaves.
      results.splice(0)
      reply = { answers: CONFIDENT }
      const second = await bootJev(dataDir, fake, { loop })
      try {
        const reopened = await second.open('jev-crash')
        expect(second.recovered.flatMap((r) => r.actions)).toEqual([
          { effectId: 'side:decide-1', action: 'unknown' },
        ])
        const recovered = await rowsOf(reopened)
        expect(costs(recovered).map((row) => [data(row).purpose, data(row).creditSource])).toEqual([
          ['side-call', 'estimated'],
        ])
        // The loop asks the same invocation again: it reads the interrupted record and falls back.
        expect((await continueTurn(reopened)).reason).toBe('completed')
        expect(results).toMatchObject([{ status: 'unknown', reason: 'interrupted', replayed: true }])
        expect(fake.seen).toHaveLength(1)
        expect(replies(await rowsOf(reopened))).toEqual([FALLBACK_TEXT])
        // The next turn asks with a new id over a new pool, and the answer settles it.
        expect((await runTurn(reopened, 'next')).reason).toBe('completed')
        expect(results.map((result) => result.status)).toEqual(['unknown', 'ok'])
        expect(fake.seen).toHaveLength(2)
        expect(fake.seen[1]?.socket).not.toBe(fake.seen[0]?.socket)
        expect(pendingSideCalls(reopened)).toEqual([])
        expect(violations(await rowsOf(reopened))).toEqual([])
      } finally {
        await second.host.close()
      }
    })
  })

  it('leaves retries to the loop: each attempt is a new invocation with its own record', async () => {
    // Rate limited twice (429 with a retry-after header, then 529), then answered.
    const fake = await startJev(
      (n) => [{ status: 429, headers: { 'retry-after': '2' } }, { status: 529 }][n] ?? { answers: CONFIDENT },
    )
    const results: SideCallResult[] = []
    const replayed: SideCallResult[] = []
    const loop = decidingLoop(async (port, signal, edge) => {
      if (edge.continuation !== 'model' || edge.index !== 0) return undefined
      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await decide(port, `retry-${attempt}`, signal)
        results.push(result)
        if (result.status !== 'failed' || !result.retryable) break
      }
      // Asking again under a used id only reads the record back; it never sends.
      replayed.push(await decide(port, 'retry-1', signal))
      const last = results.at(-1)
      return last && usableAnswer(last) ? 'finish' : undefined
    })
    const kit = await bootJev(jevDataDir(), fake, { loop })
    try {
      const session = await kit.open('jev-retry')
      expect((await runTurn(session)).reason).toBe('completed')
      expect(results).toMatchObject([
        { status: 'failed', reason: 'adapter-error', code: 'RATE_LIMIT', retryable: true },
        { status: 'failed', reason: 'adapter-error', code: 'RATE_LIMIT', retryable: true },
        { status: 'ok', replayed: false },
      ])
      expect(replayed).toMatchObject([{ status: 'failed', code: 'RATE_LIMIT', replayed: true }])
      // The vendor's retry-after reaches the loop, and its record replays it; the 529 gave none.
      expect(results[0]).toHaveProperty('retryAfterMs', 2000)
      expect(results[1]).not.toHaveProperty('retryAfterMs')
      expect(replayed[0]).toHaveProperty('retryAfterMs', 2000)
      // One HTTP request per attempt, and none for the read-back.
      expect(fake.seen).toHaveLength(3)
      const rows = await rowsOf(session)
      const ids = ['retry-1', 'retry-2', 'retry-3']
      for (const id of ids)
        expect(bindingOf(rows, id).audit).toMatchObject({
          label: 'test.decide',
          adapter: { id: 'typesafe-systemone', version: '1.0.0' },
          api: 'typesafe-systemone',
          endpointHost: new URL(fake.url).host,
        })
      expect(ofType(rows, 'x/core/side-call-intent')).toHaveLength(3)
      expect(ids.map((id) => forEffect(rows, 'effect/settled', id).map((row) => data(row).outcome))).toEqual([
        ['error'],
        ['error'],
        ['ok'],
      ])
      expect(ids.map((id) => [terminalOf(rows, id)?.kind, terminalOf(rows, id)?.reason])).toEqual([
        ['known_spend', 'driver_failed'],
        ['unknown_spend', 'adapter_error'],
        ['known_spend', undefined],
      ])
      // The 429 carries the vendor's zero usage, the 529 none (so an estimate), the answer its price.
      expect(sideCosts(rows).map((row) => [data(row).effectId, data(row).creditSource])).toEqual([
        ['side:retry-1', 'gateway'],
        ['side:retry-2', 'estimated'],
        ['side:retry-3', 'gateway'],
      ])
      for (const id of ids) expect(sideBilled(kit.billed, id)).toHaveLength(1)
      expect(violations(rows)).toEqual([])
    } finally {
      await kit.host.close()
    }
  })

  describe('a profile that declares the Jev route first', () => {
    async function firstRouteHost(key: string) {
      const fake = await startJev({ answers: CONFIDENT })
      const results: SideCallResult[] = []
      const dataDir = jevDataDir()
      const kit = await bootJev(dataDir, fake, { loop: decidingLoop(askBeforeReply(results)) })
      return { fake, results, kit, dataDir, session: await kit.open(key) }
    }

    it('gives new sessions the conversation route for every slot, and side calls still reach the Jev route', async () => {
      const t = await firstRouteHost('jev-first-slots')
      try {
        const slots = t.session.preset.model.route
        expect(slots.primary).toBe(MAIN.route)
        expect(Object.values(slots)).not.toContain(JEV.route)
        expect((await runTurn(t.session)).reason).toBe('completed')
        expect(t.results.map((result) => result.status)).toEqual(['ok'])
        expect(t.fake.seen.map((seen) => seen.path)).toEqual(['/v1/systemone'])
        expect(violations(await rowsOf(t.session))).toEqual([])
      } finally {
        await t.kit.host.close()
      }
    })

    it('leaves the Jev route out of the models a child agent can choose while side calls to it succeed', async () => {
      const t = await firstRouteHost('jev-first-children')
      try {
        // The catalog also lists the preconfigured API-key providers' models; none is on the Jev route.
        const choices = (await t.session.d.children.models?.())?.map((model) => model.selector) ?? []
        expect(choices).toContain(`${MAIN.route}/${MAIN.model}`)
        expect(choices.filter((selector) => selector.startsWith(`${JEV.route}/`))).toEqual([])
        expect(t.session.d.provider.models().map((model) => `${model.route}/${model.id}`)).toContain(
          `${JEV.route}/${JEV.model}`,
        )
        expect((await runTurn(t.session)).reason).toBe('completed')
        expect(t.results.map((result) => result.status)).toEqual(['ok'])
        expect(t.fake.seen).toHaveLength(1)
        expect(violations(await rowsOf(t.session))).toEqual([])
      } finally {
        await t.kit.host.close()
      }
    })

    it('refuses to start a child agent on the Jev model as an unknown model', async () => {
      const t = await firstRouteHost('jev-first-spawn')
      try {
        const before = t.session.lastSeq
        for (const model of [`${JEV.route}/${JEV.model}`, JEV.model])
          await expect(
            t.session.d.children.create({ parent: t.session.key, cwd: t.dataDir, input: 'task', model }),
          ).rejects.toMatchObject({ code: 'E_MODEL_UNKNOWN', detail: { model } })
        expect(t.session.lastSeq).toBe(before)
        expect(t.fake.seen).toHaveLength(0)
        expect(violations(await rowsOf(t.session))).toEqual([])
      } finally {
        await t.kit.host.close()
      }
    })
  })

  describe('a route saved through the configuration service', () => {
    it('serves side calls from the saved account and stays out of every conversation surface', async () => {
      const fake = await startJev({ answers: CONFIDENT })
      const dataDir = join(scratch(), 'home')
      const openai = getApiKeyProvider('openai')
      if (!openai) throw new Error('openai registry entry missing')
      const chatModel = (await openai.createAdapter()).models('openai')[0]?.id
      if (!chatModel) throw new Error('openai catalogue is empty')
      // The chat account's save probe asks the provider's models endpoint; a loopback stand-in serves it.
      const server = createServer((request, response) => {
        if (request.url !== '/v1/models') {
          response.writeHead(404)
          response.end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: chatModel }] }))
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('fixture did not bind')
      try {
        // The two accounts the settings page saves: one chat account, then the payload-only entry.
        const credentialRef = 'secret://generic/11111111-1111-4111-8111-111111111111'
        await createCredentialStore({ root: dataDir }).putGeneric(credentialRef, JEV_KEY, {
          label: 'Jev',
          createdAt: '2026-10-16T00:00:00.000Z',
        })
        const configuration = createConfigurationService({ home: dataDir, profile: 'local-dev' })
        const chat = await configuration.save({
          providerId: 'openai',
          accountId: 'chat',
          label: 'Chat',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: 'sk-test-value',
          model: chatModel,
          expectedRevision: 0,
        })
        await configuration.save({
          providerId: 'typesafe-systemone',
          accountId: 'jev',
          label: 'Jev',
          baseUrl: fake.url,
          credentialRef,
          model: JEV.model,
          models: [
            {
              id: JEV.model,
              name: 'Jev 1.13 (2026-09-17)',
              contextWindow: 64000,
              maxTokens: 32768,
              cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
          expectedRevision: chat.revision,
        })
        expect(chat.defaultAccountId).toBe('chat')
        // The automatic fast slot follows the chat account; the saved payload-only route is never in it.
        expect((await configuration.modelSlots()).auto?.fast?.route).toBe('account-chat')
        const overlay = await configuration.profileInput()
        expect(overlay.provider?.routes?.map((row) => row.route)).toEqual(['account-chat', 'account-jev'])

        const results: SideCallResult[] = []
        const kit = await bootJev(dataDir, fake, {
          loop: decidingLoop(
            askBeforeReply(results, () => ({ target: { route: 'account-jev', model: JEV.model } })),
          ),
          // Production applies the configuration overlay over the user layer; the user file is empty here.
          userLayer: { name: 'local-dev', ...overlay },
        })
        try {
          const session = await kit.open('configured-side')
          expect(session.preset.model.route.primary).toBe('account-chat')
          expect(Object.values(session.preset.model.route)).not.toContain('account-jev')
          const choices = (await session.d.children.models?.())?.map((model) => model.selector) ?? []
          expect(choices.filter((selector) => selector.startsWith('account-jev/'))).toEqual([])
          expect(choices).toContain(`account-chat/${chatModel}`)
          expect(
            payloadOnlyRoutes(kit.host.modelAdapterCatalog(), kit.host.profile.provider.routes ?? []),
          ).toEqual(new Set(['account-jev']))
          expect((await runTurn(session)).reason).toBe('completed')
          expect(results.map((result) => result.status)).toEqual(['ok'])
          expect(fake.seen.map((seen) => [seen.path, seen.authorization])).toEqual([
            ['/v1/systemone', `Bearer ${JEV_KEY}`],
          ])
          const rows = await rowsOf(session)
          expect(conversationCosts(rows)).toEqual([])
          expect(violations(rows)).toEqual([])
        } finally {
          await kit.host.close()
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  })
})
