import { redactSecrets } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import { splitRequest } from '../encode.js'
import { object, type Question, validateRequest } from '../questions.js'

export type BatchInput = { items: { id: string; state: JsonValue }[]; questions: Record<string, Question> }
export function batchInput(value: unknown): BatchInput | null {
  if (!object(value) || !Array.isArray(value.items) || !value.items.length || value.items.length > 500)
    return null
  const ids = new Set<string>()
  for (const item of value.items) {
    if (!object(item) || typeof item.id !== 'string' || !item.id || item.id.length > 128 || ids.has(item.id))
      return null
    ids.add(item.id)
    if (!validateRequest({ state: item.state, questions: value.questions } as never).ok) return null
  }
  for (const [id, question] of Object.entries(value.questions as Record<string, Question>)) {
    if (redactSecrets(id) !== id) return null
    if (
      question.type === 'choice' &&
      Object.keys(question.criteria).some((key) => redactSecrets(key) !== key)
    )
      return null
    if (
      question.type === 'choice' &&
      (!Object.hasOwn(question.criteria, 'other') || !Object.hasOwn(question.criteria, 'mixed'))
    )
      return null
  }
  try {
    const questions = Object.fromEntries(
      Object.entries(structuredClone(value.questions) as Record<string, Question>).map(([id, question]) => [
        id,
        maskQuestion(question),
      ]),
    )
    const items = value.items.map((item) => ({ id: item.id, state: redactState(item.state) }))
    for (const item of items) splitRequest({ state: item.state, questions }, { state: 24000, request: 48000 })
    return { items, questions }
  } catch {
    return null
  }
}
function maskQuestion(question: Question): Question {
  const instructions = redactSecrets(question.instructions)
  if (question.type === 'choice')
    return {
      type: 'choice',
      instructions,
      criteria: Object.fromEntries(
        Object.entries(question.criteria).map(([key, value]) => [
          key,
          value === null ? null : redactSecrets(value),
        ]),
      ),
    }
  if (question.type === 'score')
    return { type: 'score', instructions, criteria: question.criteria.map(redactSecrets) }
  return {
    type: 'noul',
    instructions,
    ...(question.criteria
      ? {
          criteria: Object.fromEntries(
            Object.entries(question.criteria).map(([key, value]) => [key, redactSecrets(value)]),
          ),
        }
      : {}),
  }
}
function credentialKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  return (
    /^secret:\/\//i.test(key) ||
    /(?:^|[_-])(?:password|passwd|token|secret|api[_-]?key|authorization|key)$/i.test(words)
  )
}
function redactState(value: JsonValue): JsonValue {
  const walk = (item: JsonValue): JsonValue => {
    if (Array.isArray(item)) return item.map(walk)
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [key, credentialKey(key) ? '[REDACTED]' : walk(child)]),
      )
    return item
  }
  return JSON.parse(redactSecrets(JSON.stringify(walk(value)))) as JsonValue
}
export function findInput(value: unknown): { query: string; path?: string } | null {
  if (
    !object(value) ||
    typeof value.query !== 'string' ||
    !value.query.trim() ||
    value.query.length > 2000 ||
    (value.path !== undefined && (typeof value.path !== 'string' || !value.path || value.path.length > 2048))
  )
    return null
  return {
    query: redactSecrets(value.query),
    ...(typeof value.path === 'string' ? { path: value.path } : {}),
  }
}
