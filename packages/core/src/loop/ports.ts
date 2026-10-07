import { publicOutcome } from './outcome.js'
import type { LoopCheckpoint, LoopContext, LoopToolCall } from '@agnes/extension-api'
import { type ContentBlock, type InferenceEvent, type RequestBody, validateAgainst } from '@agnes/protocol'
import { RequestBody as WireRequest } from '@agnes/protocol/gen/model'
import { runLoopChild } from '../child/loop-port.js'
import type { Inbox } from '../reduce/shapes.js'
import { runCompaction } from '../step/compaction.js'
import { withPhase } from '../step/op-state.js'
import type { SessionImpl } from '../step/session.js'
import { dispatchLoopEvent, modelRequestPayload } from './events.js'

const cleanup = new WeakMap<LoopContext, () => void>()
export function disposeLoopContext(ctx: LoopContext): void {
  cleanup.get(ctx)?.()
  cleanup.delete(ctx)
}
const CHECKPOINT_EVENT = 'x/core/loop-checkpoint'

/** Fit public operations without handing an independent driver the default scheduler. */
export async function createLoopContext(s: SessionImpl, restoreCheckpoint = false): Promise<LoopContext> {
  let checkpoint: LoopCheckpoint | null = null
  // Fresh children and the default loop use the op register, never the parent ledger.
  // Independent drivers restore only the latest checkpoint of the current session.
  if (restoreCheckpoint) {
    const [start] = await s.d.log.scan({ type: 'session/start', order: 'desc', limit: 1 })
    const [event] = await s.d.log.scan({
      type: CHECKPOINT_EVENT,
      lane: s.lane,
      fromSeq: start?.seq ?? 1,
      toSeq: s.lastSeq,
      order: 'desc',
      limit: 1,
    })
    if (event) {
      const data = event.data as unknown as {
        loop: { id: string; version: string }
        checkpoint: LoopCheckpoint
      }
      if (data.loop.id !== s.loop.id || data.loop.version !== s.loop.version)
        throw new Error('Loop checkpoint identity does not match the pinned session loop')
      checkpoint = data.checkpoint
    }
  }
  const waiters = new Set<() => void>()
  const wake = () => {
    for (const resolve of waiters) resolve()
  }
  const stopObserving = s.onAppended((events) => {
    if (events.some((event) => ['inbox', 'approval/decided', 'artifact/job'].includes(event.type))) wake()
  })
  const stopFault = s.d.log.onFault(wake)

  function requireOp() {
    const op = s.op()
    if (!op) throw new Error('Loop operation requires an accepted input')
    return op
  }
  async function ensureStep(): Promise<void> {
    const op = s.op()
    if (!op) throw new Error('Loop operation requires an accepted input')
    if (op.control.status === 'cancel_requested') throw new Error('Loop operation was cancelled')
    if (!s.turn) await s.rehydrateTurn(op)
    if (!s.state.openStep.has(s.lane))
      await s.transition([s.ev('step/start', { turn: op.meta.turn, step: op.step + 1 })], {
        ...op,
        step: op.step + 1,
      })
  }
  async function* stream(request: RequestBody, signal: AbortSignal): AsyncIterable<InferenceEvent> {
    signal = AbortSignal.any([signal, s.ac.signal])
    signal.throwIfAborted()
    await ensureStep()
    const transformed = await dispatchLoopEvent(
      s,
      'before_model_request',
      modelRequestPayload(request),
      signal,
    )
    const patch = transformed.patch
    if (patch) {
      if (patch.metadata && Object.keys(patch.metadata).length)
        throw new Error('Wire loop requests do not support metadata patches')
      const sampling = { ...request.sampling, ...patch.samplingParams }
      if (patch.maxTokens !== undefined) sampling.maxTokens = patch.maxTokens
      request = { ...request, sampling }
      if (!validateAgainst(WireRequest, request).ok) throw new Error('Invalid loop request sampling patch')
    }
    const effect = s.effects.start({ kind: 'inference', replay: 'never', slot: request.slot })
    await s.d.log.append([effect.intent])
    let settled = false
    let failed = false
    let stopReason = 'end_turn'
    const content: Array<{ type: 'text' | 'thinking'; text: string }> = []
    try {
      for await (const event of s.d.provider.infer(request, {
        signal,
        toolNames: request.tools.map((tool) => tool.name),
      })) {
        if (event.type === 'error') failed = true
        if (event.type === 'done')
          stopReason =
            event.reason === 'length' ? 'max_tokens' : event.reason === 'toolUse' ? 'tool_use' : 'end_turn'
        if (event.type === 'text_delta' || event.type === 'thinking_delta')
          content.push({ type: event.type === 'text_delta' ? 'text' : 'thinking', text: event.delta })
        if (event.type === 'usage') {
          const op = requireOp()
          const { type: _type, ...usage } = event
          const spend = {
            ...usage,
            purpose: 'inference' as const,
            model: request.model,
            sessionKey: s.key,
            lane: s.lane,
            turn: op.meta.turn,
            step: op.step,
            effectId: effect.effectId,
            slot: request.slot,
          }
          await s.d.log.append([
            s.ev('cost/ledger', {
              ...usage,
              purpose: 'inference',
              model: request.model,
              effectId: effect.effectId,
            }),
          ])
          if (!(await s.d.runtime.ledgerRecord(spend)))
            throw new Error('Loop model usage could not be recorded')
        }
        yield event
      }
      if (!failed && !signal.aborted)
        await dispatchLoopEvent(s, 'after_model_response', { content, stopReason }, signal)
      await s.d.log.append([effect.settle(signal.aborted ? 'aborted' : failed ? 'error' : 'ok')])
      settled = true
    } finally {
      if (!settled) await s.d.log.append([effect.settle(signal.aborted ? 'aborted' : 'error')])
    }
  }
  async function prepareTools(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await ensureStep()
    const op = requireOp()
    if (op.phase.kind !== 'tools') {
      const assistantSeq = op.latestAssistantSeq ?? op.meta.triggerSeq
      await s.transition([], withPhase(op, { kind: 'tools', batch: { assistantSeq, calls: [] } }))
    }
  }
  async function closeParked(events: import('../types.js').EventInput[]) {
    const step = s.state.openStep.get(s.lane)
    await s.endTurn('parked', {
      events: [...events, ...(step ? [s.ev('step/end', { turn: step.turn, step: step.step })] : [])],
    })
  }
  function invoke(call: LoopToolCall, signal: AbortSignal, parked: import('../types.js').EventInput[]) {
    return s.invokeTool(call.name, call.args, {
      signal,
      depth: 0,
      onPark: (event) => {
        parked.push(event)
      },
    })
  }
  async function execute(call: LoopToolCall, signal: AbortSignal) {
    signal = AbortSignal.any([signal, s.ac.signal])
    await prepareTools(signal)
    const parked: import('../types.js').EventInput[] = []
    try {
      return await invoke(call, signal, parked)
    } catch (error) {
      if (parked.length) await closeParked(parked)
      throw error
    }
  }
  const ctx: LoopContext = {
    sessionKey: s.key,
    lane: s.lane,
    model: {
      stream,
      async complete(request, signal) {
        const events: InferenceEvent[] = []
        for await (const event of stream(request, signal)) events.push(event)
        return events
      },
    },
    tools: {
      execute,
      async batch(calls, signal) {
        if (!calls.length) return []
        signal = AbortSignal.any([signal, s.ac.signal])
        // Open one step before launching siblings; nested execution still enforces tool policy.
        await prepareTools(signal)
        const parked: import('../types.js').EventInput[] = []
        const runtime = await s.toolRuntime()
        let failed = false
        let failure: unknown
        const results = await runtime.batch(
          structuredClone(calls).map((call, ordinal) => ({
            ...call,
            id: String(ordinal),
            concurrencySafe: s.turn?.snapshot.byName.get(call.name)?.meta.isConcurrencySafe === true,
          })),
          {
            dispatch: async (input, callSignal) => {
              try {
                return await invoke(input, callSignal, parked)
              } catch (error) {
                if (!failed) failure = error
                failed = true
                return { content: [{ type: 'text', text: 'Tool dispatch failed' }], isError: true }
              }
            },
          },
          signal,
        )
        // Drain every sibling before closing the turn or surfacing a failure.
        if (parked.length) await closeParked(parked)
        if (failed) throw failure
        return results
      },
    },
    input: {
      async accept() {
        const current = s.op()
        if (current) {
          if (!s.turn) await s.rehydrateTurn(current)
        } else if (!(await s.acceptInput())) return null
        const op = requireOp()
        const [row] = await s.d.log.scan({ fromSeq: op.meta.triggerSeq, toSeq: op.meta.triggerSeq, limit: 1 })
        if (!row) throw new Error('Accepted input is missing from the session ledger')
        return { id: String(op.meta.triggerSeq), content: (row.data as { content: ContentBlock[] }).content }
      },
      pending: () => ((s.latest('inbox') as Inbox | undefined)?.items.length ?? 0) > 0,
    },
    events: {
      dispatch: (event, payload, signal) => dispatchLoopEvent(s, event, payload, signal),
      async emit(type, data) {
        await s.d.log.append([s.ev(type, data, type.startsWith('x/') ? { ignorable: true } : {})])
      },
      async finish(reason, error) {
        const step = s.state.openStep.get(s.lane)
        await s.endTurn(reason, {
          ...(error ? { error } : {}),
          ...(step ? { events: [s.ev('step/end', { turn: step.turn, step: step.step })] } : {}),
        })
      },
    },
    checkpoints: {
      read: () => checkpoint && structuredClone(checkpoint),
      async write(value) {
        s.d.loopFactory?.codec?.decode(value)
        const next = structuredClone(value)
        await s.d.log.append([
          s.ev(CHECKPOINT_EVENT, { loop: s.loop, checkpoint: next }, { ignorable: true }),
        ])
        checkpoint = next
      },
    },
    wait: {
      wake,
      park(signal) {
        signal = AbortSignal.any([signal, s.ac.signal])
        if (signal.aborted || ((s.latest('inbox') as Inbox | undefined)?.items.length ?? 0) > 0)
          return Promise.resolve()
        return new Promise<void>((resolve) => {
          const done = () => {
            waiters.delete(done)
            signal.removeEventListener('abort', done)
            resolve()
          }
          waiters.add(done)
          signal.addEventListener('abort', done, { once: true })
        })
      },
    },
    children: {
      run: (input, signal) => runLoopChild(s, input, signal),
    },
    ...(s.compaction.runnable
      ? {
          compaction: {
            run: async (signal: AbortSignal) => {
              signal.throwIfAborted()
              const op = s.op()
              if (!op || s.state.openStep.has(s.lane))
                throw new Error('Compaction requires an accepted input at a step boundary')
              if (op.phase.kind !== 'compaction')
                await s.transition(
                  [],
                  withPhase(op, { kind: 'compaction', reason: 'requested', resumeAfter: op.phase }),
                )
              return publicOutcome(await runCompaction(s, signal))
            },
          },
        }
      : {}),
  }
  cleanup.set(ctx, () => {
    wake()
    stopObserving()
    stopFault()
  })
  return ctx
}
