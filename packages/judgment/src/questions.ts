import type { JsonValue } from '@agnes/protocol'

export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
export type NoulQuestion = {
  type: 'noul'
  instructions: string
  criteria?: { true?: string; false?: string }
}
export type ScoreQuestion = { type: 'score'; instructions: string; criteria: string[] }
export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion
export type JudgmentRequest = { state: JsonValue; questions: Record<string, Question> }
export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number }
export type Answers = Record<string, Answer>

export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const probability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

function json(value: unknown, seen = new Set<unknown>(), depth = 0): boolean {
  if (depth > 32) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  seen.add(value)
  const valid = Object.values(value).every((item) => json(item, seen, depth + 1))
  seen.delete(value)
  return valid
}

export function validateRequest(req: JudgmentRequest): { ok: true } | { ok: false; reason: string } {
  if (!object(req) || !json(req.state) || !object(req.questions) || !Object.keys(req.questions).length)
    return { ok: false, reason: 'invalid state or questions' }
  for (const [id, q] of Object.entries(req.questions)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) || !object(q) || !text(q.instructions))
      return { ok: false, reason: 'invalid question' }
    const c = q.criteria
    const valid =
      q.type === 'choice'
        ? object(c) &&
          Object.keys(c).length >= 2 &&
          Object.entries(c).every(
            ([key, value]) =>
              text(key) && !/[\r\n]/.test(key) && (value === null || typeof value === 'string'),
          )
        : q.type === 'score'
          ? Array.isArray(c) && c.length >= 2 && c.every(text)
          : q.type === 'noul' &&
            (c === undefined ||
              (object(c) &&
                Object.entries(c).every(
                  ([key, value]) => ['true', 'false'].includes(key) && typeof value === 'string',
                )))
    if (!valid) return { ok: false, reason: `invalid question ${id}` }
  }
  return { ok: true }
}

export function parseNativeAnswers(value: unknown, req: JudgmentRequest): Answers | null {
  if (!object(value)) return null
  const entries: [string, Answer][] = []
  for (const [id, q] of Object.entries(req.questions)) {
    const a = Object.hasOwn(value, id) ? value[id] : undefined
    if (!object(a) || a.type !== q.type) return null
    if (q.type === 'noul') {
      if (!probability(a.noul)) return null
      entries.push([id, { type: 'noul', noul: a.noul }])
      continue
    }
    const labels = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i))
    const p = a.probabilities
    if (
      !object(p) ||
      Object.keys(p).length !== labels.length ||
      !labels.every((key) => Object.hasOwn(p, key) && probability(p[key])) ||
      !probability(a.confidence)
    )
      return null
    const probabilities = Object.fromEntries(labels.map((key) => [key, p[key] as number]))
    if (Math.abs(Object.values(probabilities).reduce((sum, n) => sum + n, 0) - 1) > 0.01) return null
    if (q.type === 'choice') {
      if (typeof a.choice !== 'string' || !labels.includes(a.choice)) return null
      entries.push([id, { type: 'choice', choice: a.choice, probabilities, confidence: a.confidence }])
    } else {
      if (
        typeof a.score !== 'number' ||
        !Number.isFinite(a.score) ||
        a.score < 0 ||
        a.score > labels.length - 1
      )
        return null
      entries.push([id, { type: 'score', score: a.score, probabilities, confidence: a.confidence }])
    }
  }
  return Object.fromEntries(entries)
}
