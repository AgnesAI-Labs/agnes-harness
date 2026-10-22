import { withPhase } from '@agnes/core-common/step/op-state'
import { CoreError, type Seq } from '@agnes/core-common/types'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { Inbox, InboxItem } from '@agnes/core-ledger/reduce/shapes'
import type {
  BindableKind,
  LoopCheckpoint,
  LoopContext,
  LoopInput,
  LoopRequest,
  LoopRequestOptions,
  LoopToolCall,
  LoopToolCallOptions,
  ServiceInstance,
  ServicePorts,
} from '@agnes/extension-api'
import type { ContentBlock, InferenceEvent, RequestBody } from '@agnes/protocol'
import { releaseTreeReservation } from '../child/runtime-budget.js'
import { ModelExecution } from '../execution/model-execution.js'
import { approvalContinuation, continueParked } from '../execution/turn/parked.js'
import { approveAndExecute } from '../execution/turn/tools.js'
import { unrecordedParkEvents } from '../execution/turn/unknown-outcome.js'
import { hasCompleteToolPolicyEnvelope } from '../registry/tool-policy.js'
import type { DeriveOutput } from '../request/derive.js'
import { toProviderRequest } from '../request/to-provider.js'
import { runCompaction } from '../step/compaction.js'
import { finishAborted } from '../step/control.js'
import { appendExtensionEvent, prepareLoopEvent } from '../step/ext-events.js'
import { beforeStepGate, builtinBudgetPreflight, checkpointRoutine, stopGate } from '../step/gate.js'
import { admitInferenceRequest, prepareInferenceRequest } from '../step/inference.js'
import type { SessionImpl } from '../step/session.js'
import { announcedTools } from './announce.js'
import { loopChildStarts } from './child-starts.js'
import { estimateLoopRequest } from './estimates.js'
import { dispatchLoopEvent } from './events.js'
import { LoopInvocations } from './invocations.js'
import { loopJobs } from './jobs.js'
import { publicOutcome } from './outcome.js'
import { scopeLoopContext, sessionForLoop } from './scope.js'
import { createSideCallPort, sideCallInFlight } from './side-call.js'
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
  s = sessionForLoop(s)
  const decisionSource = s.loopDecisionSource()
  let checkpoint: LoopCheckpoint | null = null
  // Next-step inputs claimed after the restored checkpoint: the driver never recorded them, so they
  // are handed back in order before the inbox is read again.
  const unconfirmed: InboxItem[] = []
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
    const delivered = scanPages((query) => s.d.log.scan(query), {
      type: 'x/core/control',
      lane: s.lane,
      fromSeq: ((event?.seq ?? start?.seq ?? 0) + 1) as Seq,
      toSeq: s.lastSeq,
    })
    for await (const rows of delivered) {
      for (const row of rows) {
        const data = row.data as { action?: string; outcome?: string; item?: InboxItem }
        if (data.action === 'steer' && data.outcome === 'delivered' && data.item)
          unconfirmed.push(structuredClone(data.item))
      }
    }
  }
  const waiting = await loopWait(s, restoreCheckpoint)

  function requireOp() {
    const op = s.op()
    if (!op) throw new Error('Loop operation requires an accepted input')
    return op
  }
  let lastPortEdge: number | null = null
  // The completion the stop gate last kept open. Asking again before another step cannot change
  // the gate's answer, so that second request ends the turn as blocked instead of asking forever.
  let heldCompletion: string | null = null
  async function ensureStep(newModel = false, open = true): Promise<void> {
    const op = requireOp()
    if (s.closingOrClosed) throw new CoreError('E_CLOSED', 'session closed')
    if (op.control.status === 'cancel_requested')
      throw new CoreError('E_CLOSED', 'Loop operation was cancelled')
    if (!s.turn) await s.rehydrateTurn(op)
    const opened = s.state.openStep.get(s.lane)
    if (opened && (newModel || lastPortEdge !== s.loopEdge))
      await announced.closeStep([s.ev('step/end', { turn: opened.turn, step: opened.step })], op)
    lastPortEdge = s.loopEdge
    if (!s.state.openStep.has(s.lane)) {
      const admission = await builtinBudgetPreflight(s)
      if (admission !== 'ok')
        throw new CoreError('E_BUDGET', 'Loop operation refused by budget admission', {
          reason: admission.reason,
        })
      if (!open) return
      const hooked = await beforeStepGate(s, requireOp().step + 1)
      if (hooked !== 'ok')
        throw new CoreError('E_BUDGET', 'Loop step refused by a before_step hook', { reason: hooked.reason })
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
      await announced.answerStranded()
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
      if (s.turn?.ledgerFailed)
        throw new CoreError('E_BUDGET', 'usage ledger unavailable; refusing inference')
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
      const result = await invocations.claim(binding.invocationId, request)
      // Another stream can settle this invocation while request admission is awaiting.
      if (result !== undefined) {
        if (!Array.isArray(result))
          throw new CoreError('E_RELATION', 'Invocation result is not a model response')
        for (const event of result) yield event
        return
      }
      const events: InferenceEvent[] = []
      let settled = false
      for await (const event of streamWire(admitted.wire, admitted.output, signal, binding.invocationId)) {
        events.push(event)
        if (event.type === 'done' || event.type === 'error') {
          await invocations.settle(binding.invocationId, request, events)
          settled = true
        }
        yield event
      }
      if (!settled) await invocations.settle(binding.invocationId, request, events)
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
    const memory = s.turn
    const seqs = await s.transition(
      pre,
      withPhase(op, {
        kind: 'inference',
        gen: { status: 'effect_pending', attempt: 0, effectId: effect.effectId, slot: request.slot },
      }),
    )
    const headerSeq = seqs[pre.length - 2]!
    const intentSeq = seqs[pre.length - 1]!
    if (memory) {
      memory.lastHeader = output.header
      memory.lastHeaderSeq = headerSeq
    }
    const execution = new ModelExecution(s, {
      wire: request,
      header: output.header,
      effect,
      headerSeq,
      intentSeq,
      signal,
      publicIterator: true,
      turnId: op.meta.turn,
      step: op.step,
      memory,
    })
    let stopReason = 'end_turn'
    try {
      for await (const event of execution.stream()) {
        if (event.type === 'done') {
          stopReason =
            event.reason === 'length' ? 'max_tokens' : event.reason === 'toolUse' ? 'tool_use' : 'end_turn'
        }
        if (event.type === 'done' || event.type === 'error')
          await execution.commit(execution.rows(execution.outcome, execution.outcome !== 'ok'), (cur) => cur)
        yield event
      }
      if (execution.outcome === 'ok')
        await dispatchLoopEvent(s, 'after_model_response', { content: execution.content, stopReason }, signal)
    } finally {
      await execution.commit(execution.rows(execution.outcome, execution.outcome !== 'ok'), (cur) => cur)
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
      events: [
        ...unrecordedParkEvents(s, events),
        ...(step ? [s.ev('step/end', { turn: step.turn, step: step.step })] : []),
      ],
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
  const announced = announcedTools(s, { invocations, prepareTools, closeParked })
  async function execute(call: LoopToolCall, signal: AbortSignal, options?: LoopToolCallOptions) {
    if (options?.announce) return announced.execute(call, signal, options.announce)
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
        const item = unconfirmed.shift() ?? (await s.controls.claim())
        if (!item) return null
        return {
          id: item.itemId,
          turnId: op.meta.turn,
          content: structuredClone(item.content),
          kind: item.kind ?? 'steer',
          trust: item.trust ?? 'trusted',
          actor: structuredClone(item.actor),
          ...(item.origin ? { origin: item.origin } : {}),
          ...(item.origin === 'system' && item.system ? { system: structuredClone(item.system) } : {}),
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
    const data = row.data as {
      content?: ContentBlock[]
      kind?: LoopInput['kind']
      system?: LoopInput['system']
    }
    return {
      id: String(op.meta.triggerSeq),
      turnId: op.meta.turn,
      content: data.content ?? [],
      kind: data.kind ?? 'prompt',
      trust: row.trust,
      actor: structuredClone(row.actor),
      origin: row.origin === 'system' ? 'system' : 'principal',
      ...(row.origin === 'system' && data.system ? { system: structuredClone(data.system) } : {}),
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
    decisions: s.decisions.port(decisionSource),
    session: Object.freeze({ key: s.key, lane: s.lane, workspaceRoot: s.workspaceRoot }),
    sessionKey: s.key,
    lane: s.lane,
    services: {
      get: <S extends ServiceInstance, P extends ServicePorts>(_kind: BindableKind<S, P>) =>
        undefined as S | undefined,
    },
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
    sideCall: createSideCallPort(s),
    turn: {
      view: () => loopTurnView(s),
      async endStep() {
        const done = s.beginLoopOperation()
        try {
          const op = requireOp()
          if (s.pendingEffects().length)
            throw new CoreError('E_RELATION', 'Cannot close a step with active effects')
          const step = s.state.openStep.get(s.lane)
          if (step) await announced.closeStep([s.ev('step/end', { turn: step.turn, step: step.step })], op)
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
      drain: (signal) =>
        controlled(signal, async () => publicOutcome(await announced.driving(() => s.runToolsPhase()))),
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
      async batch(calls, signal, options) {
        if (options?.announce) return announced.batch(calls, signal, options.announce)
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
      pending: () =>
        unconfirmed.length > 0 || ((s.latest('inbox') as Inbox | undefined)?.items.length ?? 0) > 0,
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
      async emit(name, data) {
        const event = prepareLoopEvent(s.d.loopSourcePackage ?? s.loop.id, name, data)
        await s.locked(() => appendExtensionEvent(s, event, { loopTrigger: true }))
      },
      async finish(reason, error) {
        // A side call settles inside its turn; ending the turn first would leave it unsettled.
        if (sideCallInFlight(s))
          throw new CoreError('E_RELATION', 'A side call is still in flight', {
            reason: 'side-call-in-flight',
          })
        if (reason !== 'completed') {
          const step = s.state.openStep.get(s.lane)
          const end =
            step && (await announced.endTurnRows([s.ev('step/end', { turn: step.turn, step: step.step })]))
          await s.endTurn(reason, { ...(error ? { error } : {}), ...(end ? { events: end } : {}) })
          return { outcome: reason === 'parked' ? 'parked' : 'turn-ended', phase: 'terminal', reason }
        }
        const done = s.beginLoopOperation()
        try {
          const op = requireOp()
          if (!s.turn) await s.rehydrateTurn(op)
          const step = s.state.openStep.get(s.lane)
          if (step) await announced.closeStep([s.ev('step/end', { turn: step.turn, step: step.step })], op)
          const mark = `${op.meta.turn}:${op.step}:${op.latestAssistantSeq ?? ''}`
          if (heldCompletion === mark) {
            const held = {
              code: 'STOP_GATE_HELD',
              message: 'The stop gate kept the turn open and the loop made no further step',
            }
            await s.endTurn('blocked', { error: held })
            return { outcome: 'turn-ended', phase: 'terminal', reason: 'blocked' }
          }
          const gated = await stopGate(s, 'complete')
          heldCompletion = gated.phase === 'terminal' ? null : mark
          return publicOutcome(gated)
        } finally {
          done()
        }
      },
    },
    checkpoints: {
      read: () => checkpoint && structuredClone(checkpoint),
      async write(value, association) {
        s.d.loopFactory?.codec?.decode(value)
        if (association?.invocationIds)
          for (const id of association.invocationIds) await invocations.status(id)
        const next = structuredClone(value)
        if (association?.decisionRefs?.length) await s.requireVerifiedHistory()
        await s.locked(() =>
          s.d.log.append(
            [
              ...s.decisions.consumptionEvents(association?.decisionRefs ?? [], decisionSource, null),
              s.ev(
                CHECKPOINT_EVENT,
                {
                  loop: s.loop,
                  checkpoint: next,
                  ...(association?.invocationIds ? { invocationIds: [...association.invocationIds] } : {}),
                  ...(association?.decisionRefs ? { decisionRefs: [...association.decisionRefs] } : {}),
                },
                { ignorable: true },
              ),
            ],
            {
              commitCheck: () => {
                s.decisions.consumptionEvents(association?.decisionRefs ?? [], decisionSource, null)
              },
            },
          ),
        )
        checkpoint = next
      },
    },
    wait: {
      wake: waiting.wake,
      async delay(ms, signal) {
        signal.throwIfAborted()
        const waited = s.loopScope.beginWait()
        try {
          await s.sleep(ms)
        } finally {
          waited()
        }
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
  const scoped = scopeLoopContext(ctx, s.loopScope)
  cleanup.set(scoped, () => {
    s.loopScope.revoke()
    waiting.dispose()
  })
  return scoped
}
