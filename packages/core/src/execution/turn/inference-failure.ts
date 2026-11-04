import { type OpStateObj, withPhase } from '@agnes/core-common/step/op-state'
import type { EventInput } from '@agnes/core-common/types'
import type { InferenceEvent } from '@agnes/protocol'
import type { SessionImpl, StepOutcome } from '../../step/session.js'
import type { ModelExecution } from '../model-execution.js'

/** Retry feedback contains no discarded model text or executable tool calls. */
export function interruptedRequestNote(s: SessionImpl, code: string): EventInput {
  return s.ev('user/message', {
    kind: 'runtime_context',
    content: [
      {
        type: 'text',
        text: `The previous model request was interrupted (${code}). Its unfinished response was discarded and its tool calls were not executed. Continue from the last completed step, use smaller steps, and return a visible answer or tool call.`,
      },
    ],
  })
}

/** Settle each failed request before advancing its durable retry counter or draining the turn. */
export async function settleInferenceFailure(
  s: SessionImpl,
  execution: ModelExecution,
  cur: OpStateObj,
  error: Extract<InferenceEvent, { type: 'error' }>,
  attempt: number,
  stepEnd: EventInput,
  partial: boolean,
): Promise<StepOutcome> {
  // Observe category, mode 'parallel': HookDispatch already contains a failing handler internally
  // (it reports and moves on rather than rejecting), so this cannot itself throw into the retry/
  // drain/compaction decisions that follow. `attempt` is the same retry counter those decisions
  // read below, not the request's own id — there is no request id to report here.
  if (s.hooks.requestError)
    await s.hooks.requestError({
      code: error.code,
      message: error.message,
      attempt,
      retryable: error.retryable,
    })
  if (s.ac.signal.aborted || error.reason === 'aborted' || error.code === 'ABORTED') {
    await execution.commit(
      [...execution.rows('aborted', true), stepEnd],
      withPhase(cur, {
        kind: 'failure_drain',
        error: { code: 'ABORTED', message: error.message },
        provenance: { kind: 'inference' },
      }),
    )
    // The settlement and the step's close are already written; what is missing is the turn's own
    // terminal row, and the drain phase is where `step()` writes it. Reporting `terminal` here
    // ended the run with the turn still open, which is a ledger the next reader has to repair
    // before it can do anything else.
    return { phase: 'failure_drain' }
  }
  if (
    error.code === 'OVERFLOW' &&
    s.preset.compaction.enabled &&
    s.compaction.onOverflow() === 'compaction'
  ) {
    await execution.commit(
      [...execution.rows('error', true), stepEnd],
      withPhase(cur, {
        kind: 'compaction',
        reason: 'overflow',
        resumeAfter: {
          kind: 'checkpoint',
          continuation: 'need_assistant',
          triggerSeq: cur.meta.triggerSeq,
        },
      }),
    )
    return { phase: 'compaction' }
  }
  if (error.retryable && attempt + 1 < s.preset.model.retry.maxAttempts) {
    const notBefore = new Date(s.d.clock() + s.preset.model.retry.baseDelayMs * 2 ** attempt).toISOString()
    await execution.commit(
      [
        ...execution.rows('error', true),
        ...(partial ? [interruptedRequestNote(s, error.code)] : []),
        stepEnd,
      ],
      withPhase(cur, {
        kind: 'inference',
        gen: { status: 'retry_wait', attempt: attempt + 1, notBefore, code: error.code },
      }),
    )
    return { phase: 'inference' }
  }
  await execution.commit(
    [...execution.rows('error', true), stepEnd],
    withPhase(cur, {
      kind: 'failure_drain',
      error: {
        code: error.code,
        message: error.retryable
          ? `${error.message}; retries exhausted after ${attempt + 1} attempts`
          : error.message,
      },
      provenance: { kind: 'inference' },
    }),
  )
  return { phase: 'failure_drain' }
}
