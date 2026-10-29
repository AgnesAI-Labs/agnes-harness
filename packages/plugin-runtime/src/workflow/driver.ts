import { createHash } from 'node:crypto'
import type {
  DecisionHandle,
  LoopCheckpointCodec,
  LoopContext,
  LoopDriver,
  LoopToolCall,
  LoopToolCallOptions,
} from '@agnes/extension-api'
import { deferredQueueKind } from '../deferred-contract.js'
import { drainDeferredToolInvocations } from '../deferred-invocations.js'
import { requestConfirmation, resolveConfirmation } from './confirmation.js'
import { publishWorkflow } from './publishing.js'
import type { WorkflowCheckpointState, WorkflowOptions, WorkflowStage } from './types.js'
import { workflowModelText } from './values.js'

const codeOf = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? error.code : undefined
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function workflowDriver(
  ctx: LoopContext,
  saved: WorkflowCheckpointState,
  options: WorkflowOptions,
  workflow: readonly WorkflowStage[],
  codec: LoopCheckpointCodec<WorkflowCheckpointState>,
  initial: () => WorkflowCheckpointState,
  plan: string,
): LoopDriver {
  let state = structuredClone(saved)
  let closed = false
  const lifetime = new AbortController()
  const save = (decisionRefs: readonly DecisionHandle[] = []) =>
    ctx.checkpoints.write(codec.encode(state), { decisionRefs })
  async function captureInputs() {
    await ctx.turn.endStep()
    // A generic checkpoint claims inbox messages too. Persist every input first, in order.
    for (;;) {
      const input = await ctx.input.claim('next-step')
      if (!input) break
      state.inputQueue.push(input)
      await save()
    }
  }
  // Business validation consumes this Loop's durable checkpoint, irrespective of producer.
  const businessCtx: LoopContext = Object.create(ctx)
  Object.defineProperty(businessCtx, 'tools', {
    value: {
      ...ctx.tools,
      async execute(call: LoopToolCall, signal: AbortSignal, callOptions?: LoopToolCallOptions) {
        options.guardToolCall?.(call, state)
        const output = await (callOptions === undefined
          ? ctx.tools.execute(call, signal)
          : ctx.tools.execute(call, signal, callOptions))
        if (options.recordToolResult?.(call, output, state)) await save()
        return output
      },
      async resume(id: string, signal: AbortSignal) {
        const original = await (await ctx.services?.get(deferredQueueKind))?.read(id, signal)
        const call = original
          ? { invocationId: id, name: original.invocation.tool, args: original.invocation.args }
          : state.approvalCall
        if (!call) throw new Error('Original business invocation unavailable')
        options.guardToolCall?.(call, state)
        const output = await ctx.tools.resume(id, signal)
        if (options.recordToolResult?.(call, output, state)) await save()
        return output
      },
    },
  })
  return {
    checkpoint: () => codec.encode(state),
    cancel() {
      closed = true
      lifetime.abort()
    },
    dispose() {
      closed = true
      lifetime.abort()
    },
    async step(suppliedSignal) {
      suppliedSignal.throwIfAborted()
      if (closed) return { outcome: 'turn-ended', phase: 'cancelled', reason: 'aborted' }
      const signal = AbortSignal.any([suppliedSignal, lifetime.signal])
      if (ctx.turn.cancelled()) return ctx.turn.finishCancelled()
      if (state.completed) {
        if (!ctx.input.pending()) return { outcome: 'idle', phase: 'idle' }
        state = initial()
      }
      // Every producer uses the same public queue; this Loop knows no UI execution helper.
      const deferred = await drainDeferredToolInvocations(businessCtx, signal)
      if (deferred) return deferred
      if (state.approvalWaiting) {
        const originalCall = state.approvalCall
        if (!originalCall) throw new Error('Missing original approval call')
        const continuation = await ctx.input.resumeParked()
        if (continuation === 'waiting' || continuation === false)
          return { outcome: 'parked', phase: 'tool-approval', reason: 'parked' }
        if (continuation === 'blocked')
          return { outcome: 'turn-ended', phase: 'approval-blocked', reason: 'blocked' }
        try {
          await businessCtx.tools.resume(originalCall.invocationId, signal)
        } catch (error) {
          signal.throwIfAborted()
          if (codeOf(error) === 'PARKED' || codeOf(error) === 'E_LANE_BUSY')
            return { outcome: 'parked', phase: 'tool-approval', reason: 'parked' }
          throw error
        }
        // Re-enter only this exact call: Core returns its bound receipt, never dispatches it twice.
        state.approvalWaiting = false
        state.pending = false
        await save()
      }
      if (state.pending) {
        if (!(await ctx.input.accept())) return { outcome: 'turn-ended', phase: 'unknown', reason: 'blocked' }
        await ctx.events.finish('blocked', {
          code: 'WORKFLOW_OUTCOME_UNKNOWN',
          message: 'Inspect evidence before starting a new run; do not replay a pending stage.',
        })
        return { outcome: 'turn-ended', phase: 'unknown', reason: 'blocked' }
      }
      if (state.waiting) {
        if (ctx.turn.continuation() === 'checkpoint') {
          if (!state.waiting.handle) await captureInputs()
          const boundary = await ctx.turn.checkpoint(signal)
          if (boundary.outcome !== 'running') return boundary
        }
        const deferred = await drainDeferredToolInvocations(businessCtx, signal)
        if (deferred) return deferred
        if (ctx.turn.continuation() === 'tools') return await ctx.tools.drain(signal)
        const outcome = await resolveConfirmation(ctx, state, save, signal)
        if (outcome) return outcome
      }
      if (!state.input) {
        const input = await ctx.input.accept()
        if (!input) return { outcome: 'idle', phase: 'idle' }
        state.input = input.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
        if (!state.input.trim()) throw new Error('This workflow needs text input')
        state.outputKey = createHash('sha256').update(`${ctx.sessionKey}\0${input.id}`).digest('hex')
        await save()
      }
      if (state.index === workflow.length) {
        // Core decides how the turn ends. A stop gate that keeps it open is asked once more on the
        // next step; a workflow has no further stage to offer, so Core then ends the turn as blocked.
        // A gate that parks on a person is Core's to settle: the stages are done either way.
        const end = await ctx.events.finish('completed')
        if (end.outcome === 'running') return end
        state.completed = true
        await save()
        return { ...end, phase: 'done' }
      }
      const stage = workflow[state.index]
      if (!stage) throw new Error('Workflow stage unavailable')
      if (stage.inputStage) {
        if (ctx.turn.continuation() === 'checkpoint') {
          await captureInputs()
          const boundary = await ctx.turn.checkpoint(signal)
          if (boundary.outcome !== 'running') return boundary
        }
        const deferred = await drainDeferredToolInvocations(businessCtx, signal)
        if (deferred) return deferred
        if (ctx.turn.continuation() === 'tools') return await ctx.tools.drain(signal)
        if (!state.stageInput) {
          if (ctx.turn.continuation()) await ctx.turn.endStep()
          const input =
            state.inputQueue.shift() ??
            (ctx.turn.continuation() ? await ctx.input.claim('next-step') : await ctx.input.accept())
          if (!input) {
            if (ctx.turn.continuation()) await ctx.events.finish('parked')
            return { outcome: 'parked', phase: 'waiting-for-action', reason: 'parked' }
          }
          state.stageInput = input
          await save()
          if (ctx.turn.continuation() === 'checkpoint') return { outcome: 'running', phase: 'action-input' }
        }
      }
      state.pending = true
      await save()
      try {
        const question = stage.confirm?.(state)
        if (question && state.confirmed !== state.index) {
          state.data.draftDeliverables = await publishWorkflow(businessCtx, state, options, signal)
          await requestConfirmation(ctx, state, options, question, signal)
          await save()
          if (options.confirm === 'surface') await ctx.events.finish('parked')
          return { outcome: 'parked', phase: 'waiting-for-answer', reason: 'parked' }
        }
        const needsApproval = stage.approval === true || !!question
        const activePlan = (await ctx.turn.view())?.prompt.sections.some(
          (section) => section.id === 'plan-mode',
        )
        if (
          needsApproval &&
          (stage.name !== 'approve-plan' || activePlan || state.approvalCall) &&
          state.explanation === null
        ) {
          // A model response also supplies the original assistant edge for Core's ticket continuation.
          state.explanation = await workflowModelText(
            ctx,
            'Briefly explain the next fixed workflow step without changing it. Plan approval does not authorize later business actions.',
            { stage: stage.name, plan },
            signal,
          )
          await save()
        }
        const stageCtx = needsApproval
          ? Object.defineProperty(Object.create(businessCtx), 'tools', {
              value: {
                ...businessCtx.tools,
                async execute(
                  call: LoopToolCall,
                  callSignal: AbortSignal,
                  callOptions?: LoopToolCallOptions,
                ) {
                  const invocationId =
                    'workflow:' +
                    state.outputKey +
                    ':' +
                    state.index +
                    ':' +
                    createHash('sha256').update(JSON.stringify(call)).digest('hex')
                  if (state.approvalCall && state.approvalCall.invocationId !== invocationId)
                    throw new Error('Approval receipt does not match the original call')
                  state.approvalCall = { ...call, invocationId }
                  await save()
                  return callOptions === undefined
                    ? businessCtx.tools.execute(state.approvalCall, callSignal)
                    : businessCtx.tools.execute(state.approvalCall, callSignal, callOptions)
                },
              },
            })
          : businessCtx
        const data = await stage.run(stageCtx, state, signal)
        signal.throwIfAborted()
        if (stage.inputStage && data.waitingForInput) {
          state.stageInput = null
          state.pending = false
          await save()
          return { outcome: 'running', phase: 'waiting-for-action' }
        }
        state.stageInput = null
        state.data = { ...state.data, ...data }
        state.index++
        state.pending = false
        state.approvalCall = null
        state.explanation = null
        await save()
        await ctx.events.assistant(
          {
            content: [
              {
                type: 'text',
                text: stage.message?.(data) ?? `${stage.name}:\n${JSON.stringify(data, null, 2)}`,
              },
            ],
            stopReason: 'end_turn',
          },
          codec.encode(state),
        )
        return { outcome: 'running', phase: stage.name }
      } catch (error) {
        signal.throwIfAborted()
        if (codeOf(error) === 'PARKED') {
          // Core already closed the turn. Never try to finish it a second time.
          state.approvalWaiting = state.approvalCall !== null
          await save()
          return { outcome: 'parked', phase: 'tool-approval', reason: 'parked' }
        }
        await ctx.events.finish('error', { code: 'WORKFLOW_STAGE_FAILED', message: messageOf(error) })
        return { outcome: 'turn-ended', phase: 'failed', reason: 'error' }
      }
    },
  }
}
