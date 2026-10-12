import type { DecisionHandle, LoopContext, LoopInput, LoopStepOutcome } from '@agnes/extension-api'
import { object } from './checkpoint.js'
import type { WorkflowCheckpointState, WorkflowOptions } from './types.js'
import { workflowChecked } from './values.js'

function surfaceAnswer(input: LoopInput, surfaceId: string): string | null {
  if (
    input.origin !== 'system' ||
    input.system?.source !== 'agnes/intelligent-ui' ||
    input.system.type !== 'action-result'
  )
    return null
  const receipt = input.system.data
  if (
    !object(receipt) ||
    receipt.status !== 'succeeded' ||
    receipt.surfaceId !== surfaceId ||
    !object(receipt.invocation) ||
    receipt.invocation.tool !== 'ui_submit' ||
    !object(receipt.submitted) ||
    !object(receipt.submitted.answers)
  )
    return null
  const answers = receipt.submitted.answers
  return Object.keys(answers).length === 1 && ['Proceed', 'Cancel'].includes(String(answers.proceed))
    ? String(answers.proceed)
    : null
}

export async function requestConfirmation(
  ctx: LoopContext,
  state: WorkflowCheckpointState,
  options: WorkflowOptions,
  question: string,
  signal: AbortSignal,
) {
  const questions = [{ id: 'proceed', question, options: ['Proceed', 'Cancel'] }]
  if (options.confirm === 'surface') {
    const output = workflowChecked(
      await ctx.tools.execute({ name: 'ask_user_question', args: { questions } }, signal),
    )
    if (
      !object(output.details) ||
      output.details.status !== 'pending' ||
      typeof output.details.surfaceId !== 'string'
    )
      throw new Error('Official question did not return a persisted pending request')
    state.waiting = { id: output.details.surfaceId, questions }
  } else {
    const handle = await ctx.decisions.request({
      key: `workflow:${state.outputKey}:${state.index}`,
      purpose: 'business.confirm',
      subject: { workflow: options.id, stage: state.index, data: state.data },
      prompt: question,
      options: ['Proceed', 'Cancel'],
      responseSchema: { type: 'null' },
    })
    state.waiting = { id: handle.id, handle, questions }
  }
  state.pending = false
}

export async function resolveConfirmation(
  ctx: LoopContext,
  state: WorkflowCheckpointState,
  save: (decisionRefs?: readonly DecisionHandle[]) => Promise<void>,
  signal: AbortSignal,
): Promise<LoopStepOutcome | null> {
  const waiting = state.waiting
  if (!waiting) throw new Error('Missing original workflow confirmation')
  let answer: string | null
  if (waiting.handle) {
    const snapshot = await ctx.decisions.get(waiting.handle)
    const result =
      snapshot.result || snapshot.invalidation
        ? { status: 'resolved' as const, snapshot }
        : await ctx.decisions.wait(waiting.handle, { signal })
    signal.throwIfAborted()
    if (result.status === 'pending')
      return { outcome: 'parked', phase: 'waiting-for-answer', reason: 'parked' }
    if (result.snapshot.invalidation || result.snapshot.result?.reason !== 'answered') {
      state.waiting = null
      state.pending = true
      await save()
      await ctx.events.finish('blocked', {
        code: 'WORKFLOW_CONFIRMATION_UNAVAILABLE',
        message: 'The original business confirmation is unavailable',
      })
      return { outcome: 'turn-ended', phase: 'cancelled', reason: 'blocked' }
    }
    answer = result.snapshot.result.response.option
  } else {
    if (!waiting.input) {
      const startingTurn = !ctx.turn.continuation() && !state.inputQueue.length
      if (ctx.turn.continuation()) await ctx.turn.endStep()
      const input =
        state.inputQueue.shift() ??
        (ctx.turn.continuation() ? await ctx.input.claim('next-step') : await ctx.input.accept())
      if (!input) return { outcome: 'parked', phase: 'waiting-for-answer', reason: 'parked' }
      waiting.input = input
      await save()
      // A newly admitted turn may already be in the model phase. Give the generic
      // deferred queue its next boundary before treating its wake as an unrelated answer.
      if (ctx.turn.continuation() === 'checkpoint' || (startingTurn && ctx.turn.continuation()))
        return { outcome: 'running', phase: 'answer-input' }
    }
    answer = surfaceAnswer(waiting.input, waiting.id)
    delete waiting.input
    if (!answer) {
      await save()
      if (state.inputQueue.length) return { outcome: 'running', phase: 'answer-input' }
      await ctx.events.finish('parked')
      return { outcome: 'parked', phase: 'waiting-for-answer', reason: 'parked' }
    }
  }
  state.waiting = null
  if (answer !== 'Proceed') {
    state.pending = true
    await save(waiting.handle ? [waiting.handle] : [])
    await ctx.events.finish('error', {
      code: 'WORKFLOW_CANCELLED',
      message: 'The person cancelled the business action',
    })
    return { outcome: 'turn-ended', phase: 'cancelled', reason: 'error' }
  }
  state.confirmed = state.index
  // A custom decision advances only the business phase, never grants tool authority.
  await save(waiting.handle ? [waiting.handle] : [])
  return null
}
