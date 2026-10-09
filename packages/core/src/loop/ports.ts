import { withPhase } from '@agnes/core-common/step/op-state'
import { CoreError } from '@agnes/core-common/types'
import type { Inbox } from '@agnes/core-ledger/reduce/shapes'
import type {
  LoopCheckpoint,
  LoopContext,
  LoopInput,
  LoopRequest,
  LoopRequestOptions,
  LoopToolCall,
} from '@agnes/extension-api'
import { type ContentBlock, type InferenceEvent, inspectJsonData, type RequestBody } from '@agnes/protocol'
import { releaseTreeReservation, settleTreeSpend } from '../child/runtime-budget.js'
import { approvalContinuation, continueParked } from '../execution/turn/parked.js'
import { approveAndExecute } from '../execution/turn/tools.js'
import { hasCompleteToolPolicyEnvelope } from '../registry/tool-policy.js'
import type { DeriveOutput } from '../request/derive.js'
import { toProviderRequest } from '../request/to-provider.js'
import { runCompaction } from '../step/compaction.js'
import { finishAborted } from '../step/control.js'
import { appendExtensionEvent } from '../step/ext-events.js'
import { builtinBudgetPreflight, checkpointRoutine } from '../step/gate.js'
import { admitInferenceRequest, prepareInferenceRequest } from '../step/inference.js'
import type { SessionImpl } from '../step/session.js'
import { loopChildStarts } from './child-starts.js'
import { estimateLoopRequest } from './estimates.js'
import { dispatchLoopEvent } from './events.js'
import { LoopInvocations } from './invocations.js'
import { loopJobs } from './jobs.js'
import { publicOutcome } from './outcome.js'
import { freezeView, loopTurnView } from './turn-view.js'
import { loopWait } from './wait.js'

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
      if (event.origin !== 'system' || event.trust !== 'trusted')
        throw new CoreError('E_RELATION', 'Loop checkpoint source is invalid')
      const data = event.data as unknown as {
        loop: { id: string; version: string }
        checkpoint: LoopCheckpoint
      }
      if (data.loop.id !== s.loop.id || data.loop.version !== s.loop.version)
        throw new Error('Loop checkpoint identity does not match the pinned session loop')
      checkpoint = data.checkpoint
    }
  }
  const waiting = await loopWait(s, restoreCheckpoint)

  function requireOp() {
    const op = s.op()
    if (!op) throw new Error('Loop operation requires an accepted input')
    return op
  }
  let lastPortEdge: number | null = null
  async function ensureStep(newModel = false, open = true): Promise<void> {
    const op = requireOp()
    if (s.closingOrClosed) throw new CoreError('E_CLOSED', 'session closed')
    if (op.control.status === 'cancel_requested')
      throw new CoreError('E_CLOSED', 'Loop operation was cancelled')
    if (!s.turn) await s.rehydrateTurn(op)
    const opened = s.state.openStep.get(s.lane)
    if (opened && (newModel || lastPortEdge !== s.loopEdge))
      await s.transition([s.ev('step/end', { turn: opened.turn, step: opened.step })], op)
    lastPortEdge = s.loopEdge
    if (!s.state.openStep.has(s.lane)) {
      const admission = await builtinBudgetPreflight(s)
      if (admission !== 'ok')
        throw new CoreError('E_BUDGET', 'Loop operation refused by budget admission', {
          reason: admission.reason,
        })
      if (!open) return
      const current = requireOp()
      await s.transition([s.ev('step/start', { turn: current.meta.turn, step: current.step + 1 })], {
        ...current,
        step: current.step + 1,
      })
    }
  }
  const prepared = new WeakMap<LoopRequest, { output: DeriveOutput; turnId: number; invocationId: string }>()
  const invocations = new LoopInvocations(s, () => checkpoint)
  const resumingTools = new Set<string>()
  async function prepareRequest(options: LoopRequestOptions = {}): Promise<LoopRequest> {
    const releaseEffect = await s.controls.beginEffect()
    const done = s.beginLoopOperation()
    try {
      const op = requireOp()
      if (!s.turn) await s.rehydrateTurn(op)
      const output = await prepareInferenceRequest(s, options)
      if ('phase' in output)
        throw new CoreError('E_BUDGET', 'Request preparation stopped the turn', { reason: output.reason })
      const request = freezeView(
        toProviderRequest(output.request, { sessionKey: s.key, derivedHash: output.header.derived_hash }),
      ) as LoopRequest
      prepared.set(request, {
        output,
        turnId: op.meta.turn,
        invocationId: options.invocationId ?? s.d.ids.effectId(),
      })
      return request
    } finally {
      done()
      releaseEffect()
    }
  }
  async function* stream(request: LoopRequest, signal: AbortSignal): AsyncIterable<InferenceEvent> {
    const releaseEffect = await s.controls.beginEffect()
    const done = s.beginLoopOperation()
    try {
      const binding = prepared.get(request)
      if (!binding || binding.turnId !== requireOp().meta.turn)
        throw new CoreError('E_REQUEST_FROZEN', 'Model request must be prepared by this turn')
      signal = AbortSignal.any([signal, s.ac.signal])
      signal.throwIfAborted()
      const cached = await invocations.status(binding.invocationId)
      if (cached.status !== 'not-sent') {
        const result = await invocations.claim(binding.invocationId, request)
        if (!Array.isArray(result))
          throw new CoreError('E_RELATION', 'Invocation result is not a model response')
        for (const event of result) yield event
        return
      }
      await ensureStep(true, false)
      const admitted = await admitInferenceRequest(s, binding.output, true)
      if ('phase' in admitted)
        throw new CoreError('E_BUDGET', 'Request admission stopped the turn', { reason: admitted.reason })
      if (admitted.calibration.event && !admitted.calibration.deny)
        await s.d.log.append([admitted.calibration.event])
      await ensureStep(true)
      await invocations.claim(binding.invocationId, request)
      const events: InferenceEvent[] = []
      for await (const event of streamWire(admitted.wire, admitted.output, signal, binding.invocationId)) {
        events.push(event)
        yield event
      }
      await invocations.settle(binding.invocationId, request, events)
    } finally {
      await releaseTreeReservation(s)
      done()
      releaseEffect()
    }
  }
  async function* streamWire(
    request: RequestBody,
    output: DeriveOutput,
    signal: AbortSignal,
    invocationId: string,
  ): AsyncIterable<InferenceEvent> {
    const effect = s.effects.start({ kind: 'inference', replay: 'never', slot: request.slot })
    const pre = [
      s.ev('x/core/loop-effect', { invocationId, effectId: effect.effectId }, { ignorable: true }),
      ...output.notes,
      s.ev('request/header', output.header),
      effect.intent,
    ]
    const op = requireOp()
    const seqs = await s.transition(
      pre,
      withPhase(op, {
        kind: 'inference',
        gen: { status: 'effect_pending', attempt: 0, effectId: effect.effectId, slot: request.slot },
      }),
    )
    const headerSeq = seqs[pre.length - 2]!
    const intentSeq = seqs[pre.length - 1]!
    if (s.turn) {
      s.turn.lastHeader = output.header
      s.turn.lastHeaderSeq = headerSeq
    }
    let sent = false
    let settled = false
    let failed = false
    let completed = false
    let stopReason = 'end_turn'
    const content: Array<{ type: 'text' | 'thinking'; text: string }> = []
    try {
      for await (const event of s.d.provider.infer(request, {
        signal,
        toolNames: request.tools.map((tool) => tool.name),
      })) {
        if (event.type === 'sent') {
          if (
            sent ||
            event.stamp.derived_hash !== request.derivedHash ||
            event.stamp.contract_id !== output.header.contract_id ||
            event.stamp.parser_version !== output.header.parser_version ||
            event.stamp.tool_schema_hash !== output.header.tool_schema_hash ||
            event.stamp.model.id !== request.model ||
            event.stamp.model.route !== request.route
          )
            throw new CoreError('E_ENVELOPE', 'Provider sent stamp does not match prepared request')
          await s.d.log.append([
            s.ev('request/sent', event.stamp, { sourceEventSeqs: [headerSeq, intentSeq] }),
          ])
          sent = true
        } else if (!sent && event.type !== 'error')
          throw new CoreError('E_ENVELOPE', 'Provider response is missing a sent stamp')
        if (event.type === 'error') failed = true
        if (event.type === 'done') completed = true
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
          const {
            seqs: [costSeq],
          } = await s.d.log.append([
            s.ev('cost/ledger', {
              ...usage,
              purpose: 'inference',
              model: request.model,
              effectId: effect.effectId,
            }),
          ])
          await settleTreeSpend(s, usage.credits, costSeq!)
          if (!(await s.d.runtime.ledgerRecord(spend))) {
            if (s.turn) s.turn.ledgerFailed = true
            throw new Error('Loop model usage could not be recorded')
          }
        }
        yield event
      }
      if (!failed && !signal.aborted && (!sent || !completed))
        throw new CoreError('E_ENVELOPE', 'Provider response ended without sent/done events')
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
  async function closeParked(events: import('@agnes/core-common/types').EventInput[]) {
    const step = s.state.openStep.get(s.lane)
    await s.endTurn('parked', {
      events: [...events, ...(step ? [s.ev('step/end', { turn: step.turn, step: step.step })] : [])],
    })
  }
  function invoke(
    call: LoopToolCall,
    signal: AbortSignal,
    parked: import('@agnes/core-common/types').EventInput[],
  ) {
    return s.invokeTool(call.name, call.args, {
      signal,
      ...(call.invocationId ? { invocationId: call.invocationId } : {}),
      depth: 0,
      onPark: (event) => {
        parked.push(event)
      },
    })
  }
  async function executeOwned(call: LoopToolCall, signal: AbortSignal) {
    signal = AbortSignal.any([signal, s.ac.signal])
    await prepareTools(signal)
    const parked: import('@agnes/core-common/types').EventInput[] = []
    try {
      return await invoke(call, signal, parked)
    } catch (error) {
      if (parked.length) await closeParked(parked)
      throw error
    }
  }
  async function execute(call: LoopToolCall, signal: AbortSignal) {
    const releaseEffect = await s.controls.beginEffect()
    const done = s.beginLoopOperation()
    try {
      const id = call.invocationId ?? s.d.ids.effectId()
      const input = { name: call.name, args: call.args }
      if ((await invocations.status(id)).status !== 'not-sent') {
        const result = await invocations.claim(id, input)
        if (!result || Array.isArray(result))
          throw new CoreError('E_RELATION', 'Invocation result is not a tool response')
        return result as import('@agnes/extension-api').ToolResult
      }
      // Admission precedes the durable uncertainty fence.
      await prepareTools(AbortSignal.any([signal, s.ac.signal]))
      return await invocations.run(id, input, () => executeOwned({ ...call, invocationId: id }, signal))
    } finally {
      done()
      releaseEffect()
    }
  }
  async function claim(target: 'next-turn' | 'next-step'): Promise<LoopInput | null> {
    if (s.closingOrClosed) throw new CoreError('E_CLOSED', 'session closed')
    if (target === 'next-step') {
      {
        const op = requireOp()
        const item = await s.controls.claim()
        if (!item) return null
        return {
          id: item.itemId,
          turnId: op.meta.turn,
          content: structuredClone(item.content),
          kind: item.kind ?? 'steer',
          trust: item.trust ?? 'trusted',
          actor: structuredClone(item.actor),
        }
      }
    }
    const current = s.op()
    if (current) {
      if (!s.turn) await s.rehydrateTurn(current)
    } else if (!(await s.acceptInput())) return null
    const op = requireOp()
    const [row] = await s.d.log.scan({ fromSeq: op.meta.triggerSeq, toSeq: op.meta.triggerSeq, limit: 1 })
    if (!row) throw new Error('Accepted input is missing from the session ledger')
    const data = row.data as { content?: ContentBlock[]; kind?: LoopInput['kind'] }
    return {
      id: String(op.meta.triggerSeq),
      turnId: op.meta.turn,
      content: data.content ?? [],
      kind: data.kind ?? 'prompt',
      trust: row.trust,
      actor: structuredClone(row.actor),
    }
  }
  async function controlled<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const releaseEffect = await s.controls.beginEffect()
    const done = s.beginLoopOperation()
    try {
      signal.throwIfAborted()
      return await fn()
    } finally {
      done()
      releaseEffect()
    }
  }
  const children = s.loopChildrenPort()
  const ctx: LoopContext = {
    sessionKey: s.key,
    lane: s.lane,
    prepareRequest,
    async estimateRequest(request) {
      const done = s.beginLoopOperation()
      try {
        const binding = prepared.get(request)
        if (!binding || binding.turnId !== requireOp().meta.turn)
          throw new CoreError('E_REQUEST_FROZEN', 'Estimate requires a request prepared by this turn')
        return await estimateLoopRequest(s, request)
      } finally {
        done()
      }
    },
    jobs: loopJobs(s, invocations),
    effects: { status: (id) => invocations.status(id) },
    turn: {
      view: () => loopTurnView(s),
      async endStep() {
        const done = s.beginLoopOperation()
        try {
          const op = requireOp()
          if (s.pendingEffects().length)
            throw new CoreError('E_RELATION', 'Cannot close a step with active effects')
          const step = s.state.openStep.get(s.lane)
          if (step) await s.transition([s.ev('step/end', { turn: step.turn, step: step.step })], op)
        } finally {
          done()
        }
      },
      cancelled: () => s.op()?.control.status === 'cancel_requested',
      continuation() {
        const kind = s.op()?.phase.kind
        return kind === undefined
          ? null
          : kind === 'inference'
            ? 'model'
            : kind === 'failure_drain'
              ? 'failure'
              : kind
      },
      checkpoint: async (signal) => {
        signal.throwIfAborted()
        return publicOutcome(await checkpointRoutine(s))
      },
      finishCancelled: async () => publicOutcome(await finishAborted(s)),
      async finishFailure() {
        const op = requireOp()
        if (op.phase.kind !== 'failure_drain')
          throw new CoreError('E_RELATION', 'No failed continuation to finish')
        const reason = op.phase.error.code === 'ABORTED' ? 'aborted' : 'error'
        await s.endTurn(reason, { error: op.phase.error })
        return { outcome: 'turn-ended', phase: 'terminal', reason }
      },
    },
    model: {
      respond: (signal) => controlled(signal, async () => publicOutcome(await s.runInference())),
      stream,
      async complete(request, signal) {
        const events: InferenceEvent[] = []
        for await (const event of stream(request, signal)) events.push(event)
        return events
      },
    },
    tools: {
      drain: (signal) => controlled(signal, async () => publicOutcome(await s.runToolsPhase())),
      execute,
      async resume(id, signal) {
        if (resumingTools.has(id))
          throw new CoreError('E_RELATION', 'Approval invocation is already resuming')
        const releaseEffect = await s.controls.beginEffect()
        const done = s.beginLoopOperation()
        resumingTools.add(id)
        try {
          signal = AbortSignal.any([signal, s.ac.signal])
          signal.throwIfAborted()
          const status = await invocations.status(id)
          if (status.status === 'responded' && !Array.isArray(status.result))
            return status.result as import('@agnes/extension-api').ToolResult
          const toolUseId = await invocations.toolUseId(id)
          const continuation = await approvalContinuation(s)
          const op = s.op()
          const call =
            op?.phase.kind === 'tools'
              ? op.phase.batch.calls.find((call) => call.toolUseId === toolUseId)
              : undefined
          if (
            !call ||
            call.status !== 'planned' ||
            !hasCompleteToolPolicyEnvelope(call) ||
            continuation?.toolUseId !== toolUseId
          ) {
            if (toolUseId && (await invocations.awaitingApproval(toolUseId)))
              throw new CoreError('E_LANE_BUSY', 'Invocation awaits its own approval continuation', {
                invocationId: id,
              })
            throw new CoreError(
              'E_RELATION',
              'Invocation has no opened approval continuation; reconcile uncertain effects',
              { invocationId: id },
            )
          }
          const [row] = await s.d.log.scan({ fromSeq: call.argsSeq, toSeq: call.argsSeq, limit: 1 })
          if (!row || row.type !== 'tool/call')
            throw new CoreError('E_RELATION', 'Approval call arguments are missing')
          const outcome = await approveAndExecute(
            s,
            { ...call, args: (row.data as { args: unknown }).args },
            { depth: call.depth ?? 0, signal },
          )
          if (outcome.park) {
            await closeParked([outcome.park])
            throw Object.assign(new Error('PARKED'), { code: 'PARKED' })
          }
          await invocations.settleTool(id, outcome.result)
          return outcome.result
        } finally {
          resumingTools.delete(id)
          done()
          releaseEffect()
        }
      },
      async batch(calls, signal) {
        const releaseEffect = await s.controls.beginEffect()
        const done = s.beginLoopOperation()
        try {
          if (!calls.length) return []
          signal = AbortSignal.any([signal, s.ac.signal])
          // Open one step before launching siblings; nested execution still enforces tool policy.
          await prepareTools(signal)
          const parked: import('@agnes/core-common/types').EventInput[] = []
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
                  const id = calls[Number(input.id)]?.invocationId ?? s.d.ids.effectId()
                  return await invocations.run(id, { name: input.name, args: input.args }, () =>
                    invoke({ ...input, invocationId: id }, callSignal, parked),
                  )
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
        } finally {
          done()
          releaseEffect()
        }
      },
    },
    input: {
      accept: () => claim('next-turn'),
      claim,
      resumeParked: () => continueParked(s),
      pending: () => ((s.latest('inbox') as Inbox | undefined)?.items.length ?? 0) > 0,
    },
    events: {
      dispatch: (event, payload, signal) => dispatchLoopEvent(s, event, payload, signal),
      async assistant(message, saved) {
        const done = s.beginLoopOperation()
        try {
          const next = s.d.loopFactory.codec.encode(s.d.loopFactory.codec.decode(saved))
          const op = requireOp()
          if (s.pendingEffects().length)
            throw new CoreError('E_RELATION', 'Assistant commit requires settled effects')
          await s.transition(
            [
              s.ev(
                'assistant/message',
                {
                  content: message.content,
                  stopReason: message.stopReason,
                  ...(s.turn?.lastHeaderSeq ? { requestSeq: s.turn.lastHeaderSeq } : {}),
                },
                { origin: 'model' },
              ),
              s.ev(CHECKPOINT_EVENT, { loop: s.loop, checkpoint: next }, { ignorable: true }),
            ],
            (cur, seq) => {
              if (!cur) throw new CoreError('E_RELATION', 'Assistant commit lost its turn')
              return {
                ...withPhase(cur, {
                  kind: 'checkpoint',
                  continuation: 'need_assistant',
                  triggerSeq: op.meta.triggerSeq,
                }),
                latestAssistantSeq: seq,
              }
            },
          )
          checkpoint = next
        } finally {
          done()
        }
      },
      async emit(type, data) {
        if (
          typeof type !== 'string' ||
          !/^x\/[a-zA-Z0-9._-]+\/[^\s]+$/.test(type) ||
          type.startsWith('x/core/')
        )
          throw new CoreError('E_ENVELOPE', 'Loop emit accepts only non-reserved extension event types')
        const checked = inspectJsonData(data)
        if (!checked.ok) throw new CoreError('E_ENVELOPE', 'Invalid Loop event data')
        await s.locked(() =>
          appendExtensionEvent(s, { type, data: checked.value, source: s.loop.id }, { loopTrigger: true }),
        )
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
      async write(value, association) {
        s.d.loopFactory?.codec?.decode(value)
        if (association) for (const id of association.invocationIds) await invocations.status(id)
        const next = structuredClone(value)
        await s.d.log.append([
          s.ev(
            CHECKPOINT_EVENT,
            {
              loop: s.loop,
              checkpoint: next,
              ...(association ? { invocationIds: [...association.invocationIds] } : {}),
            },
            { ignorable: true },
          ),
        ])
        checkpoint = next
      },
    },
    wait: {
      wake: waiting.wake,
      async delay(ms, signal) {
        signal.throwIfAborted()
        await s.sleep(ms)
        signal.throwIfAborted()
      },
      async poll(signal) {
        signal.throwIfAborted()
        return publicOutcome(await s.runDeferred())
      },
      park: waiting.park,
    },
    ...(children ? { children: loopChildStarts(s, children) } : {}),
    compaction: {
      run: (signal: AbortSignal) =>
        controlled(signal, async () => {
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
        }),
    },
  }
  cleanup.set(ctx, () => {
    waiting.dispose()
  })
  return ctx
}
