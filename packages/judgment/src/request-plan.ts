import { createHash } from 'node:crypto'
import type { SideCallStatus } from '@agnes/extension-api'
import type { AnswerCache } from './cache.js'
import type { JudgeTarget } from './config.js'
import { type Answers, type JudgmentRequest, object } from './questions.js'

/** Chunk ordinals come from the complete request, never from the volatile cache. */
export function missingQuestions(
  req: JudgmentRequest,
  target: JudgeTarget,
  cache: AnswerCache,
  answers: Answers,
): JudgmentRequest {
  return {
    state: req.state,
    questions: Object.fromEntries(
      Object.entries(req.questions).filter(([id, question]) => {
        const cached = target.native ? cache.get(req.state, target, question) : null
        if (cached) answers[id] = cached
        return !cached
      }),
    ),
  }
}

/** Successful native receipts name their sent subset; the caller must still verify its request hash. */
export function recordedRequest(
  full: JudgmentRequest,
  missing: JudgmentRequest,
  status: SideCallStatus,
  native: boolean,
): JudgmentRequest | null {
  if (!native || status.status !== 'finished' || status.result.status !== 'ok') return missing
  const json = status.result.json
  if (!object(json)) return null
  const ids = Object.keys(json)
  if (!ids.length || ids.some((id) => !Object.hasOwn(full.questions, id))) return null
  const selected = new Set(ids)
  return {
    state: full.state,
    questions: Object.fromEntries(Object.entries(full.questions).filter(([id]) => selected.has(id))),
  }
}

/** Residuals recover only answers that were cache-only before a restart, one stable identity each. */
export function invocationId(prefix: string, chunk: number, attempt: number, residual?: string): string {
  const suffix =
    residual === undefined ? '' : `:r${createHash('sha256').update(residual).digest('hex').slice(0, 16)}`
  const id = `${prefix}:c${chunk}:a${attempt}${suffix}`
  return id.length <= 112 ? id : `j${createHash('sha256').update(id).digest('hex')}`
}
