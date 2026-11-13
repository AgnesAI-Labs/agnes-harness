import { estimateTokens } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import { type JudgmentRequest, validateRequest } from './questions.js'

export function nativePayload(req: JudgmentRequest): JsonValue {
  return { state: req.state, questions: req.questions }
}

export function splitRequest(
  req: JudgmentRequest,
  budgets: { state: number; request: number },
): JudgmentRequest[] {
  if (!validateRequest(req).ok) throw new TypeError('Invalid judgment request')
  if (![budgets.state, budgets.request].every((n) => Number.isFinite(n) && n > 0))
    throw new RangeError('Invalid token budgets')
  const parts: JudgmentRequest[] = []
  let entries: [string, JudgmentRequest['questions'][string]][] = []
  const part = (rows: typeof entries): JudgmentRequest => ({
    state: req.state,
    questions: Object.fromEntries(rows),
  })
  const size = (rows: typeof entries) => estimateTokens(JSON.stringify(nativePayload(part(rows))))
  for (const entry of Object.entries(req.questions)) {
    if (size([entry]) > Math.min(budgets.state, budgets.request))
      throw new RangeError('State and question do not fit token budget')
    if (entries.length && size([...entries, entry]) > budgets.request) {
      parts.push(part(entries))
      entries = []
    }
    entries.push(entry)
  }
  if (entries.length) parts.push(part(entries))
  return parts
}
