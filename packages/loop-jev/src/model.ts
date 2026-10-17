import type { GenericLoopPorts, LoopRequest, LoopStepOutcome } from '@agnes/extension-api'
import type { InferenceEvent, LlmKind } from './types.js'
import { clip, errorCode } from './util.js'

export type ModelDeps = Pick<
  GenericLoopPorts,
  'prepareRequest' | 'estimateRequest' | 'model' | 'turn' | 'compaction' | 'wait'
> & {
  /** Records the attempt about to be sent before anything is prepared under its id. */
  save(llm: { kind: LlmKind; attempt: number; note?: string }, invocationId: string): Promise<void>
  /** Called when a prepared request names a tool outside the turn's catalog. */
  recomputeToolNames(): Promise<string[]>
}

export type LlmRequest = {
  idPrefix: string
  kind: LlmKind
  /** Committed with the first attempt only (`m0`); never resent. */
  note: string
  firstAttempt: number
  maxAttempts: number
  toolNames: readonly string[]
}

export type LlmOutcome =
  | { kind: 'reply'; events: readonly InferenceEvent[]; attempts: number; ids: string[]; toolNames: string[] }
  | { kind: 'failed'; code: string; message: string; attempts: number; ids: string[] }
  | { kind: 'aborted' }
  | { kind: 'outcome'; outcome: LoopStepOutcome }

type ErrorEvent = Extract<InferenceEvent, { type: 'error' }>

const BASE_DELAY_MS = 1000

/**
 * Sends one main-model request with the same tools on every attempt. Retries retryable errors under
 * a new id after a backoff, and compacts when the estimate asks for it or the model reports an
 * overflow. The note is committed with the first request actually sent, so a retry never carries it.
 */
export async function requestLlm(req: LlmRequest, deps: ModelDeps, signal: AbortSignal): Promise<LlmOutcome> {
  let toolNames = [...req.toolNames]
  const ids: string[] = []

  const prepare = async (invocationId: string, note: string | undefined): Promise<LoopRequest> => {
    const options = () => ({
      tools: toolNames,
      invocationId,
      ...(note ? { tailNote: { text: note, commit: true } } : {}),
    })
    try {
      return await deps.prepareRequest(options())
    } catch (error) {
      if (errorCode(error) !== 'E_ENVELOPE') throw error
      toolNames = await deps.recomputeToolNames()
      return await deps.prepareRequest(options())
    }
  }

  const compact = async (): Promise<LoopStepOutcome | null> => {
    if (!deps.compaction) return null
    await deps.turn.endStep()
    const outcome = await deps.compaction.run(signal)
    return outcome.outcome === 'running' ? null : outcome
  }

  for (let k = req.firstAttempt; k < req.maxAttempts; k++) {
    const id = `${req.idPrefix}:m${k}`
    const note = k === 0 && req.note ? req.note : undefined
    await deps.save(
      note === undefined ? { kind: req.kind, attempt: k } : { kind: req.kind, attempt: k, note },
      id,
    )
    let request = await prepare(id, note)
    const estimate = await deps.estimateRequest(request)
    if (estimate.shouldCompact === true && deps.compaction) {
      const ended = await compact()
      if (ended) return { kind: 'outcome', outcome: ended }
      // Not sent yet, so the same id and the same note are still safe.
      request = await prepare(id, note)
    }
    const events = await deps.model.complete(request, signal)
    ids.push(id)
    const error = events.find((event): event is ErrorEvent => event.type === 'error')
    if (!error) return { kind: 'reply', events, attempts: ids.length, ids, toolNames }
    if (error.reason === 'aborted' || signal.aborted) return { kind: 'aborted' }
    const more = k + 1 < req.maxAttempts
    if (error.code === 'OVERFLOW' && deps.compaction && more) {
      const ended = await compact()
      if (ended) return { kind: 'outcome', outcome: ended }
      continue
    }
    if (error.retryable && more) {
      await deps.wait.delay(error.retryAfterMs ?? BASE_DELAY_MS * 2 ** k, signal)
      continue
    }
    return { kind: 'failed', code: error.code, message: clip(error.message, 200), attempts: ids.length, ids }
  }
  return {
    kind: 'failed',
    code: 'NO_ATTEMPTS',
    message: `no model attempts left (attempt ${req.firstAttempt} of ${req.maxAttempts})`,
    attempts: 0,
    ids,
  }
}
