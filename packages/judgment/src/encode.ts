import { estimateTokens } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import { cooperate, type Preparation, preparation, serializedJson } from './preparation.js'
import { type JudgmentRequest, object, type Question, validateRequest } from './questions.js'

export function nativePayload(req: JudgmentRequest): JsonValue {
  return { state: req.state, questions: req.questions }
}
const text = (state: string, questions: readonly string[]) =>
  `{"state":${state},"questions":{${questions.join(',')}}}`
export function atomicRequestFits(state: string, id: string, question: string, limit: number): boolean {
  return estimateTokens(text(state, [`${JSON.stringify(id)}:${question}`])) <= limit
}
function* partition(
  req: JudgmentRequest,
  budgets: { state: number; request: number },
): Generator<void, JudgmentRequest[]> {
  if (!object(req) || !object(req.questions)) throw new TypeError('Invalid judgment request')
  if (![budgets.state, budgets.request].every((n) => Number.isFinite(n) && n > 0))
    throw new RangeError('Invalid token budgets')
  const atomic = Math.min(budgets.state, budgets.request)
  // Four UTF-8 bytes/code point and the public estimator's minimum 1/4 token/code point.
  // Exceeding this byte bound cannot fit the existing token budget, even for astral text.
  const state = yield* serializedJson(req.state, 16 * atomic)
  const parts: JudgmentRequest[] = []
  let entries: [string, Question][] = []
  let encoded: string[] = []
  let questionCount = 0
  for (const id in req.questions) {
    if (!Object.hasOwn(req.questions, id)) continue
    questionCount++
    const question = req.questions[id]
    if (!question) throw new TypeError('Invalid judgment request')
    const snapshot = yield* serializedJson(question, 16 * atomic)
    const single = { state: null, questions: { [id]: snapshot.value } } as JudgmentRequest
    if (!validateRequest(single).ok) throw new TypeError('Invalid judgment request')
    yield
    if (!atomicRequestFits(state.text, id, snapshot.text, atomic))
      throw new RangeError('State and question do not fit token budget')
    const next = `${JSON.stringify(id)}:${snapshot.text}`
    yield
    if (entries.length && estimateTokens(text(state.text, [...encoded, next])) > budgets.request) {
      parts.push({ state: req.state, questions: Object.fromEntries(entries) })
      entries = []
      encoded = []
    }
    entries.push([id, question])
    encoded.push(next)
  }
  if (!questionCount) throw new TypeError('Invalid judgment request')
  if (entries.length) parts.push({ state: req.state, questions: Object.fromEntries(entries) })
  return parts
}
export function splitRequest(
  req: JudgmentRequest,
  budgets: { state: number; request: number },
): JudgmentRequest[] {
  const iterator = partition(req, budgets)
  for (;;) {
    const next = iterator.next()
    if (next.done) return next.value
  }
}
export function planRequest(
  req: JudgmentRequest,
  budgets: { state: number; request: number },
  options: Pick<Preparation, 'signal' | 'end'> & { now?: () => number },
) {
  return cooperate(partition(req, budgets), preparation(options.signal, options.end, options.now))
}
