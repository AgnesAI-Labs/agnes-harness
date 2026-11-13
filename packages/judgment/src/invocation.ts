import type { SideCallPort, SideCallResult, SideCallStatus } from '@agnes/extension-api'
import { callAccounting, type JudgmentAccounting } from './accounting.js'
import type { JudgeTarget } from './config.js'
import { within } from './deadline.js'
import { nativePayload } from './encode.js'
import { type Answers, type JudgmentRequest, parseNativeAnswers } from './questions.js'
import { recordedRequest } from './request-plan.js'
import type { JudgmentScheduler } from './scheduler.js'
import { parseAnswers, renderPrompt } from './text-bridge.js'

export type InvocationOutcome =
  | { status: 'ok'; answers: Answers }
  | {
      status: 'failed'
      reason: 'invalid' | 'budget' | 'timeout' | 'error'
      stop: boolean
      retryable: boolean
      cooldown?: boolean
    }

/** Read status with the local id; prepared/accounting ids are owned and namespaced by Core. */
export async function runInvocation(input: {
  port: SideCallPort
  scheduler?: JudgmentScheduler | undefined
  purpose: string
  target: JudgeTarget
  full: JudgmentRequest
  missing: JudgmentRequest
  localId: string
  attemptMs: number
  signal: AbortSignal
  calls: JudgmentAccounting['calls'][number][]
}): Promise<InvocationOutcome> {
  const { port, signal, target, calls } = input
  let recorded: SideCallStatus
  try {
    recorded = await within(port.status(input.localId), signal)
  } catch {
    return { status: 'failed', reason: signal.aborted ? 'timeout' : 'error', stop: true, retryable: false }
  }
  if (recorded.status !== 'finished' && recorded.status !== 'absent')
    return { status: 'failed', reason: 'error', stop: true, retryable: false }
  const part = recordedRequest(input.full, input.missing, recorded, target.native)
  if (!part) return { status: 'failed', reason: 'invalid', stop: true, retryable: false }
  const prepared = await within(
    port.prepare({
      label: input.purpose,
      target: { route: target.route, model: target.model },
      deadlineMs: input.attemptMs,
      invocationId: input.localId,
      ...(target.native
        ? { payload: nativePayload(part), output: 'json' as const }
        : { ...renderPrompt(part), output: 'text' as const }),
    }),
    signal,
  )
  if (
    recorded.status === 'finished' &&
    (recorded.label !== prepared.label || recorded.requestHash !== prepared.requestHash)
  )
    return { status: 'failed', reason: 'invalid', stop: true, retryable: false }
  let result: SideCallResult
  if (recorded.status === 'finished') {
    result = recorded.result
    calls.push(callAccounting(prepared, result, true))
  } else {
    let index: number | undefined
    const run = () => {
      if (signal.aborted) throw signal.reason
      index = calls.length
      calls.push(callAccounting(prepared))
      return port.invoke(prepared, signal)
    }
    const pending = input.scheduler ? input.scheduler.run(signal, run) : run()
    // Observe the actual receipt independently of the deadline race. Only the result snapshot is returned.
    const observed = pending.then((receipt) => {
      if (index !== undefined) calls[index] = callAccounting(prepared, receipt)
      return receipt
    })
    result = await within(observed, signal)
  }
  if (result.status === 'refused') return { status: 'failed', reason: 'budget', stop: true, retryable: false }
  if (result.status === 'unknown' || (result.status === 'failed' && result.reason === 'cancelled'))
    return { status: 'failed', reason: 'error', stop: true, retryable: false }
  if (result.status !== 'ok')
    return {
      status: 'failed',
      reason: result.status === 'failed' && result.reason === 'deadline' ? 'timeout' : 'error',
      stop: false,
      retryable: result.status === 'failed' && result.retryable,
      cooldown: result.status === 'failed' && result.reason === 'adapter-error' && !result.retryable,
    }
  const answers = target.native ? parseNativeAnswers(result.json, part) : parseAnswers(result.text, part)
  return answers
    ? { status: 'ok', answers }
    : { status: 'failed', reason: 'invalid', stop: false, retryable: false }
}
