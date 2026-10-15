import { presetDefaults } from '@agnes/core-common/step/preset'
import type { LoopSideCallPort, SideCallOptions } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { LoopEventRegistry } from '../src/loop/events.js'
import { createLoopContext, disposeLoopContext } from '../src/loop/ports.js'
import { LoopScope } from '../src/step/loop-deadline.js'
import { noopHooks, type Operation, type ReplacementOperation } from '../src/step/session.js'
import { actor } from './helpers/open-session.js'
import {
  ANSWER,
  answer,
  data,
  gated,
  type Harness,
  identity,
  ofType,
  options,
  SENTINEL,
  type Setup,
  SIDE,
  type SideScript,
  settlements,
  sideCosts,
  signal,
  silent,
  stalled,
  terminals,
  violations,
  withSession,
} from './helpers/side-call-session.js'

describe('side model calls through the loop port', () => {
  it('sends the request as written and records intent, binding, cost, settlement and terminal in order', async () => {
    await withSession({}, async (t) => {
      const phase = t.session.op()?.phase
      const before = (await t.rows()).length
      const prepared = await t.port.prepare(options())
      expect(prepared).toMatchObject({
        invocationId: 'call-1',
        label: 'sample.decide',
        target: SIDE,
        deadlineMs: 5000,
        adapter: {
          id: 'sample-adapter',
          version: '1.0.0',
          api: 'sample-adapter',
          endpointHost: 'models.example.com',
        },
        estimate: { source: 'estimate', contextWindow: 64_000 },
      })
      expect(prepared.estimate.inputTokens).toBeGreaterThan(0)
      expect(prepared.estimate.projectedCredits).toBe(prepared.estimate.inputTokens / 1000)
      expect(Object.isFrozen(prepared)).toBe(true)
      expect(await t.rows()).toHaveLength(before)

      const result = await t.port.invoke(prepared, signal())
      expect(result).toEqual({
        status: 'ok',
        invocationId: 'call-1',
        text: ANSWER,
        json: JSON.parse(ANSWER),
        usage: {
          tokens: { input: 120, output: 4, cacheRead: 0, cacheWrite: 0 },
          credits: 0.042,
          creditSource: 'gateway',
          billing: { usdMicros: 420, source: 'gateway', subscription: false },
        },
        latencyMs: expect.any(Number),
        response: { id: 'gen-1', model: 'side-model-2026' },
        replayed: false,
      })
      const [call] = t.provider.calls
      expect(call?.request.payload).toEqual(options().payload)
      expect(call?.request).toMatchObject({
        kind: 'inference',
        slot: 'primary',
        route: SIDE.route,
        model: SIDE.model,
        contractId: null,
        system: 'Judge the board.',
        messages: [],
        tools: [],
        timeoutMs: { firstToken: 5000, total: 5000 },
      })
      expect(call?.options).toMatchObject({ toolNames: [], retry: false })

      const added = (await t.rows()).slice(before)
      expect(added.map((row) => row.type)).toEqual([
        'effect/intent',
        'x/core/side-call-intent',
        'cost/ledger',
        'effect/settled',
        'x/core/side-call-terminal',
      ])
      expect(data(added[0])).toEqual({ effectId: 'side:call-1', kind: 'side-call', replay: 'never' })
      expect(data(added[1])).toMatchObject({
        binding: { effectId: 'side:call-1', auditBindingHash: prepared.requestHash, ...SIDE },
        audit: {
          label: 'sample.decide',
          adapter: { id: 'sample-adapter', version: '1.0.0' },
          api: 'sample-adapter',
          endpointHost: 'models.example.com',
          deadlineMs: 5000,
          output: 'json',
          inputTokens: prepared.estimate.inputTokens,
          estimateSource: 'estimate',
          projectedCredits: prepared.estimate.projectedCredits,
        },
      })
      expect(data(added[2])).toMatchObject({
        purpose: 'side-call',
        effectId: 'side:call-1',
        model: SIDE.model,
        credits: 0.042,
        creditSource: 'gateway',
        route: SIDE.route,
        adapter: { id: 'sample-adapter', version: '1.0.0' },
        endpointHost: 'models.example.com',
      })
      expect(data(added[3])).toEqual({
        effectId: 'side:call-1',
        outcome: 'ok',
        durationMs: expect.any(Number),
      })
      expect(data(added[4])).toMatchObject({ terminal: { kind: 'known_spend', outcome: 'ok', text: ANSWER } })
      expect(ofType(added, 'step/start')).toEqual([])
      expect(ofType(added, 'request/header')).toEqual([])
      expect(ofType(added, 'request/sent')).toEqual([])
      expect(t.session.op()?.phase).toEqual(phase)
      expect(t.billing).toEqual([expect.objectContaining({ purpose: 'side-call', effectId: 'side:call-1' })])
    })
  })

  it('leaves the conversation request of the same turn as it is without a side call', async () => {
    const conversationOf = (withSide: boolean) =>
      withSession({}, async (t) => {
        if (withSide) await t.port.invoke(await t.port.prepare(options()), signal())
        await t.ctx.model.respond(signal())
        const rows = await t.rows()
        return {
          derived: ofType(rows, 'request/header').map((row) => data(row).derived_hash),
          prefix: ofType(rows, 'request/sent').map((row) => data(row).prompt_prefix_hash),
          requests: t.provider.calls
            .filter((call) => call.request.route !== SIDE.route)
            .map(({ request }) => ({
              system: request.system,
              messages: request.messages,
              tools: request.tools,
            })),
        }
      })
    const control = await conversationOf(false)
    expect(control.derived).toHaveLength(1)
    expect(control.prefix).toHaveLength(1)
    expect(await conversationOf(true)).toEqual(control)
  })

  it('runs no request hook, step hook, request operation or Inference replacement', async () => {
    const counts = {
      beforeModelRequest: 0,
      afterModelResponse: 0,
      beforeStep: 0,
      beforeInference: 0,
      replaced: 0,
    }
    const loopEvents = new LoopEventRegistry()
    loopEvents.on('before_model_request', () => {
      counts.beforeModelRequest++
      return {}
    })
    loopEvents.on('after_model_response', () => {
      counts.afterModelResponse++
    })
    const operation: Operation = {
      name: 'test.count-requests',
      slot: 'before-inference',
      replay: 'safe',
      applicable: async () => {
        counts.beforeInference++
        return 'applied'
      },
      run: async () => ({}),
    }
    const replacement: ReplacementOperation<'Inference'> = {
      name: 'test.replace-inference',
      slot: { replace: 'Inference' },
      replay: 'never',
      applicable: async () => 'applied',
      run: async () => ({}),
      replace: async ({ next }) => {
        counts.replaced++
        return await next()
      },
    }
    await withSession(
      { extra: { loopEvents, operations: [operation, replacement], segments: { Inference: replacement } } },
      async (t) => {
        t.session.hooks = {
          ...noopHooks,
          beforeStep: async () => {
            counts.beforeStep++
            return {}
          },
        }
        expect(await t.port.invoke(await t.port.prepare(options()), signal())).toMatchObject({ status: 'ok' })
        expect(counts).toEqual({
          beforeModelRequest: 0,
          afterModelResponse: 0,
          beforeStep: 0,
          beforeInference: 0,
          replaced: 0,
        })
        expect(t.provider.calls).toHaveLength(1)
        // A conversation request in the same session does run every one of them.
        await t.ctx.model.complete(await t.ctx.prepareRequest(), signal())
        for (const count of Object.values(counts)) expect(count).toBeGreaterThan(0)
      },
    )
  })

  it.each([
    ['a non-streaming adapter that sent no event', silent],
    ['an adapter that went silent after sending', stalled],
  ])('ends at the deadline with one estimated cost row for %s', async (_name, script) => {
    await withSession({ script }, async (t) => {
      const prepared = await t.port.prepare(options({ deadlineMs: 200 }))
      const started = performance.now()
      const result = await t.port.invoke(prepared, signal())
      // A call that ignored the 200 ms deadline would run to the 10 s default; the ceiling only has to
      // tell those apart, with room for a loaded machine.
      expect(performance.now() - started).toBeLessThan(2000)
      const estimate = {
        tokens: expect.objectContaining({ input: prepared.estimate.inputTokens }),
        credits: prepared.estimate.projectedCredits,
        creditSource: 'estimated',
      }
      expect(result).toMatchObject({
        status: 'failed',
        reason: 'deadline',
        code: 'TIMEOUT',
        retryable: true,
        dispatch: 'may-have-sent',
        usage: estimate,
        replayed: false,
      })
      const rows = await t.rows()
      expect(sideCosts(rows).map(data)).toEqual([expect.objectContaining({ ...estimate, interrupted: true })])
      expect(settlements(rows).map(data)).toEqual([
        { effectId: 'side:call-1', outcome: 'error', code: 'TIMEOUT', durationMs: expect.any(Number) },
      ])
      expect(data(terminals(rows)[0])).toMatchObject({
        terminal: { kind: 'unknown_spend', reason: 'deadline_exceeded', code: 'TIMEOUT' },
      })
    })
  })

  it('records a loop cancellation as an error and a session stop as aborted, each with an estimate', async () => {
    await withSession({ script: stalled }, async (t) => {
      const prepared = await t.port.prepare(options())
      const stop = new AbortController()
      const running = t.port.invoke(prepared, stop.signal)
      await vi.waitFor(() => expect(t.provider.calls).toHaveLength(1))
      stop.abort()
      expect(await running).toMatchObject({
        status: 'failed',
        reason: 'cancelled',
        retryable: false,
        dispatch: 'may-have-sent',
        usage: { creditSource: 'estimated', credits: prepared.estimate.projectedCredits },
      })
      expect(settlements(await t.rows()).map((row) => data(row).outcome)).toEqual(['error'])
      expect(sideCosts(await t.rows()).map(data)).toEqual([
        expect.objectContaining({ creditSource: 'estimated', interrupted: true }),
      ])
      await t.ctx.events.finish('completed')
      expect(violations(await t.rows())).toEqual([])
    })
    await withSession({ script: stalled }, async (t) => {
      const prepared = await t.port.prepare(options())
      const running = t.port.invoke(prepared, signal())
      await vi.waitFor(() => expect(t.provider.calls).toHaveLength(1))
      await t.session.abort(actor)
      expect(await running).toMatchObject({
        status: 'failed',
        reason: 'cancelled',
        dispatch: 'may-have-sent',
      })
      expect(settlements(await t.rows()).map((row) => data(row).outcome)).toEqual(['aborted'])
      expect(sideCosts(await t.rows()).map(data)).toEqual([
        expect.objectContaining({ creditSource: 'estimated', interrupted: true }),
      ])
      await t.ctx.turn.finishCancelled()
      expect(violations(await t.rows())).toEqual([])
    })
  })

  it('records a request refused before sending as not sent, with a zero cost row', async () => {
    const refused: SideScript = async function* () {
      yield {
        type: 'error',
        reason: 'error',
        code: 'CONTRACT_MISMATCH',
        message: 'adapter does not accept a payload',
        retryable: false,
      }
    }
    await withSession({ script: refused }, async (t) => {
      const result = await t.port.invoke(await t.port.prepare(options()), signal())
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      expect(result).toMatchObject({
        status: 'failed',
        reason: 'adapter-error',
        code: 'CONTRACT_MISMATCH',
        retryable: false,
        dispatch: 'not-sent',
        usage: { tokens: zero, credits: 0, creditSource: 'estimated' },
      })
      const rows = await t.rows()
      expect(sideCosts(rows).map(data)).toEqual([
        expect.objectContaining({ tokens: zero, credits: 0, creditSource: 'estimated' }),
      ])
      expect(settlements(rows).map(data)).toEqual([
        expect.objectContaining({ outcome: 'error', code: 'CONTRACT_MISMATCH' }),
      ])
      expect(data(terminals(rows)[0])).toMatchObject({
        terminal: { kind: 'no_spend', reason: 'driver_not_sent', code: 'CONTRACT_MISMATCH' },
      })
    })
  })

  describe('admission', () => {
    const refusedWithNothingWritten = async (setup: Setup, expected: string, before?: (t: Harness) => void) =>
      withSession(setup, async (t) => {
        const prepared = await t.port.prepare(options())
        before?.(t)
        const count = (await t.rows()).length
        expect(await t.port.invoke(prepared, signal())).toEqual({
          status: 'refused',
          invocationId: 'call-1',
          reason: expected,
        })
        expect(await t.rows()).toHaveLength(count)
        expect(t.provider.calls).toHaveLength(0)
      })

    it('refuses a call whose estimate is over the per-request cap', async () => {
      const preset = presetDefaults()
      preset.budget.perRequestCap = 0.000001
      await refusedWithNothingWritten({ preset }, 'budget')
    })

    it('refuses a call the tree budget blocks', async () => {
      const preset = presetDefaults()
      preset.treeBudgetCredits = 0.000001
      await refusedWithNothingWritten({ preset }, 'budget')
    })

    it('refuses to spend once the turn could not record usage', async () => {
      await refusedWithNothingWritten({}, 'usage-unrecorded', (t) => {
        if (t.session.turn) t.session.turn.ledgerFailed = true
      })
    })
  })

  describe('frozen requests and invocation ids', () => {
    it('refuses a call prepared by another context or in another turn', async () => {
      await withSession({}, async (t) => {
        const prepared = await t.port.prepare(options())
        const other = await createLoopContext(t.session)
        await expect(other.sideCall?.invoke(prepared, signal())).rejects.toMatchObject({
          code: 'E_REQUEST_FROZEN',
          detail: { reason: 'foreign' },
        })
        await t.ctx.events.finish('completed')
        await expect(t.port.prepare(options())).rejects.toMatchObject({
          code: 'E_RELATION',
          detail: { reason: 'no-turn' },
        })
        await expect(t.port.invoke(prepared, signal())).rejects.toMatchObject({
          code: 'E_RELATION',
          detail: { reason: 'no-turn' },
        })
        await t.session.enqueue('next-turn', { content: [{ type: 'text', text: 'again' }], actor })
        expect(await t.ctx.input.accept()).not.toBeNull()
        await expect(t.port.invoke(prepared, signal())).rejects.toMatchObject({
          code: 'E_REQUEST_FROZEN',
          detail: { reason: 'turn' },
        })
        expect(t.provider.calls).toHaveLength(0)
      })
    })

    it('replays a recorded id for the same request and refuses it for another', async () => {
      await withSession({}, async (t) => {
        const first = await t.port.invoke(await t.port.prepare(options()), signal())
        const replay = await t.port.invoke(await t.port.prepare(options()), signal())
        expect(replay).toEqual({ ...first, latencyMs: expect.any(Number), replayed: true })
        expect(t.provider.calls).toHaveLength(1)
        const changed = await t.port.prepare(options({ payload: { board: [], questions: ['other'] } }))
        await expect(t.port.invoke(changed, signal())).rejects.toMatchObject({
          code: 'E_RELATION',
          detail: { reason: 'invocation-reused' },
        })
        expect(t.provider.calls).toHaveLength(1)
      })
    })

    it('refuses the same id while it is in flight', async () => {
      const gate = gated()
      await withSession({ script: gate.script }, async (t) => {
        const prepared = await t.port.prepare(options())
        const running = t.port.invoke(prepared, signal())
        await gate.reached
        await expect(t.port.invoke(prepared, signal())).rejects.toMatchObject({
          code: 'E_RELATION',
          detail: { reason: 'invocation-in-flight' },
        })
        gate.open()
        expect(await running).toMatchObject({ status: 'ok', replayed: false })
        expect(t.provider.calls).toHaveLength(1)
      })
    })

    it('refuses a paused session without consuming the prepared call', async () => {
      await withSession({}, async (t) => {
        const prepared = await t.port.prepare(options())
        const pause = (paused: boolean) =>
          t.session.d.log.append([
            t.session.ev('x/core/pause-state', { paused }, { origin: 'principal', actor, ignorable: true }),
          ])
        await pause(true)
        const count = (await t.rows()).length
        await expect(t.port.invoke(prepared, signal())).rejects.toMatchObject({
          code: 'E_LANE_BUSY',
          detail: { reason: 'CONTROL_PAUSED' },
        })
        expect(await t.rows()).toHaveLength(count)
        await pause(false)
        expect(await t.port.invoke(prepared, signal())).toMatchObject({ status: 'ok' })
      })
    })

    it.each([
      ['another endpoint host', () => identity('/team-a/v1', 'other.example.com')],
      ['another path on the same host', () => identity('/team-b/v1')],
    ])('refuses a call whose target moved to %s after prepare', async (_name, moved) => {
      await withSession({}, async (t) => {
        const prepared = await t.port.prepare(options())
        t.provider.route = moved()
        const count = (await t.rows()).length
        await expect(t.port.invoke(prepared, signal())).rejects.toMatchObject({
          code: 'E_REQUEST_FROZEN',
          detail: { reason: 'target-changed' },
        })
        expect(await t.rows()).toHaveLength(count)
        expect(t.provider.calls).toHaveLength(0)
      })
    })
  })

  it('reads a call back as absent, in flight and finished with the result invoke returned', async () => {
    const gate = gated()
    await withSession({ script: gate.script }, async (t) => {
      const prepared = await t.port.prepare(options())
      expect(await t.port.status('call-1')).toEqual({ status: 'absent', invocationId: 'call-1' })
      const running = t.port.invoke(prepared, signal())
      await gate.reached
      expect(await t.port.status('call-1')).toEqual({ status: 'in-flight', invocationId: 'call-1' })
      gate.open()
      const result = await running
      expect(await t.port.status('call-1')).toEqual({
        status: 'finished',
        invocationId: 'call-1',
        label: 'sample.decide',
        requestHash: prepared.requestHash,
        result: { ...result, replayed: true },
      })
    })
  })

  it('keeps unparsable json output as text and reports it as invalid output', async () => {
    await withSession({ script: answer('not json') }, async (t) => {
      expect(await t.port.invoke(await t.port.prepare(options()), signal())).toMatchObject({
        status: 'failed',
        reason: 'invalid-output',
        retryable: false,
        dispatch: 'may-have-sent',
        usage: { credits: 0.042, creditSource: 'gateway' },
      })
      const rows = await t.rows()
      expect(sideCosts(rows)).toHaveLength(1)
      expect(data(terminals(rows)[0])).toMatchObject({
        terminal: { kind: 'known_spend', reason: 'invalid_output', text: 'not json', interrupted: false },
      })
    })
  })

  it('writes digests, never the request content, to the ledger', async () => {
    await withSession({}, async (t) => {
      const prepared = await t.port.prepare(
        options({
          system: `Judge the board. ${SENTINEL}`,
          messages: [{ role: 'user', content: [{ type: 'text', text: SENTINEL }] }],
          payload: { board: SENTINEL, questions: [SENTINEL] },
        }),
      )
      expect(await t.port.invoke(prepared, signal())).toMatchObject({ status: 'ok' })
      expect(t.provider.calls[0]?.request.system).toContain(SENTINEL)
      const rows = await t.rows()
      expect(terminals(rows)).toHaveLength(1)
      expect(JSON.stringify(rows)).not.toContain(SENTINEL)
    })
  })

  it('refuses to finish the turn while a side call is in flight', async () => {
    const gate = gated()
    await withSession({ script: gate.script }, async (t) => {
      const running = t.port.invoke(await t.port.prepare(options()), signal())
      await gate.reached
      await expect(t.ctx.events.finish('completed')).rejects.toMatchObject({
        code: 'E_RELATION',
        detail: { reason: 'side-call-in-flight' },
      })
      gate.open()
      expect(await running).toMatchObject({ status: 'ok' })
      await expect(t.ctx.events.finish('completed')).resolves.toMatchObject({ outcome: 'turn-ended' })
    })
  })

  it('settles without moving the program counter, so a concurrent transition does not conflict', async () => {
    const gate = gated()
    await withSession({ script: gate.script }, async (t) => {
      const running = t.port.invoke(await t.port.prepare(options()), signal())
      await gate.reached
      let release!: () => void
      const held = t.session.locked(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
      )
      const locked = vi.spyOn(t.session, 'locked')
      gate.open()
      // The settlement is now queued behind the held lock.
      await vi.waitFor(() => expect(locked).toHaveBeenCalled())
      const transition = t.session.transition([], t.session.op())
      release()
      await held
      await expect(transition).resolves.toHaveLength(1)
      expect(await running).toMatchObject({ status: 'ok' })
    })
  })

  it('closes a call revoked in flight with a late receipt that a replacement context reads back', async () => {
    await withSession({ script: stalled }, async (t) => {
      const prepared = await t.port.prepare(options())
      const running = t.port.invoke(prepared, signal())
      running.catch(() => undefined)
      await vi.waitFor(() => expect(t.provider.calls).toHaveLength(1))
      // The replacement exists, and has read the call as in flight, before the receipt is written.
      t.session.loopScope = new LoopScope()
      const fresh = await createLoopContext(t.session)
      const port = fresh.sideCall as LoopSideCallPort
      expect(await port.status('call-1')).toEqual({ status: 'in-flight', invocationId: 'call-1' })
      disposeLoopContext(t.ctx)
      await expect(running).rejects.toMatchObject({ code: 'E_CLOSED' })

      const rows = await t.rows()
      const side = rows.filter(
        (row) =>
          String(data(row).effectId ?? '').startsWith('side:') ||
          ['x/core/side-call-intent', 'x/core/late-effect-receipt'].includes(row.type),
      )
      expect(side.map((row) => row.type)).toEqual([
        'effect/intent',
        'x/core/side-call-intent',
        'cost/ledger',
        'x/core/late-effect-receipt',
      ])
      expect(t.session.pendingEffects()).toHaveLength(0)
      expect(t.billing).toEqual([
        expect.objectContaining({ purpose: 'side-call', creditSource: 'estimated' }),
      ])

      const status = await port.status('call-1')
      expect(status).toEqual({
        status: 'finished',
        invocationId: 'call-1',
        label: 'sample.decide',
        requestHash: prepared.requestHash,
        result: {
          status: 'failed',
          invocationId: 'call-1',
          reason: 'cancelled',
          retryable: false,
          dispatch: 'may-have-sent',
          latencyMs: expect.any(Number),
          replayed: true,
        },
      })
      expect(await port.invoke(await port.prepare(options()), signal())).toMatchObject({
        status: 'failed',
        reason: 'cancelled',
        replayed: true,
      })
      expect(t.provider.calls).toHaveLength(1)
      await expect(fresh.events.finish('completed')).resolves.toMatchObject({ outcome: 'turn-ended' })
    })
  })

  it('writes nothing and releases its budget hold when cancelled before the intent', async () => {
    const preset = presetDefaults()
    preset.treeBudgetCredits = 10
    await withSession({ preset }, async (t) => {
      const reserve = vi.spyOn(t.storage, 'reserve')
      const release = vi.spyOn(t.storage, 'releaseReservation')
      const prepared = await t.port.prepare(options())
      const count = (await t.rows()).length
      const stop = new AbortController()
      stop.abort()
      expect(await t.port.invoke(prepared, stop.signal)).toEqual({
        status: 'failed',
        invocationId: 'call-1',
        reason: 'cancelled',
        retryable: false,
        dispatch: 'not-sent',
        latencyMs: expect.any(Number),
        replayed: false,
      })
      expect(await t.rows()).toHaveLength(count)
      expect(t.provider.calls).toHaveLength(0)
      expect(reserve).toHaveBeenCalledTimes(1)
      expect(release).toHaveBeenCalledTimes(1)
      expect(await t.port.status('call-1')).toEqual({ status: 'absent', invocationId: 'call-1' })
    })
  })

  it('refuses options out of range at prepare, before anything is written', async () => {
    await withSession({}, async (t) => {
      const count = (await t.rows()).length
      const refused = async (over: Partial<SideCallOptions>, code: string, reason: string) =>
        expect(t.port.prepare(options(over))).rejects.toMatchObject({ code, detail: { reason } })
      await refused({ label: 'Not A Label' }, 'E_ENVELOPE', 'label')
      await refused({ deadlineMs: 99 }, 'E_ENVELOPE', 'deadline')
      await refused({ deadlineMs: 120_001 }, 'E_ENVELOPE', 'deadline')
      await refused({ invocationId: 'my-api-key' }, 'E_ENVELOPE', 'invocation-id')
      await refused({ payload: { blob: 'x'.repeat(1_048_577) } }, 'E_ENVELOPE', 'payload-size')
      await refused(
        { messages: [{ role: 'tool_result', toolUseId: 't', content: [], isError: false }] },
        'E_ENVELOPE',
        'messages',
      )
      await refused(
        { messages: [{ role: 'user', content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] }] },
        'E_ENVELOPE',
        'image-input',
      )
      await refused({ target: { route: SIDE.route, model: 'missing' } }, 'E_MODEL_UNKNOWN', 'target-unknown')
      expect(await t.rows()).toHaveLength(count)
    })
  })
})
