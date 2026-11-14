import { redactSecrets } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import { atomicRequestFits } from '../encode.js'
import { type Preparation, preparation, snapshot } from '../preparation.js'
import { type JudgmentRequest, object, type Question, validateRequest } from '../questions.js'
import { maskCredentialValues } from './credential-values.js'

export type BatchInput = { items: { id: string; state: JsonValue }[]; questions: Record<string, Question> }
export class BatchPreparationInterrupted extends Error {
  constructor(readonly pending: string[]) {
    super('Judgment preparation interrupted')
  }
}
const RAW_BYTES = 1048576
const encoder = new TextEncoder()
async function cleanText(value: string, scope: Preparation): Promise<string> {
  const before = scope.step()
  if (before) await before
  const text = redactSecrets(value)
  const after = scope.step()
  if (after) await after
  return text
}
async function maskQuestion(question: Question, scope: Preparation): Promise<Question> {
  const instructions = await cleanText(question.instructions, scope)
  if (question.type === 'score') {
    const criteria: string[] = []
    for (const value of question.criteria) criteria.push(await cleanText(value, scope))
    return { type: 'score', instructions, criteria }
  }
  if (question.type === 'choice') {
    const criteria: Record<string, string | null> = Object.create(null)
    for (const [key, value] of Object.entries(question.criteria)) {
      if ((await cleanText(key, scope)) !== key) throw new TypeError('Unsafe judgment identifier')
      criteria[key] = value === null ? null : await cleanText(value, scope)
    }
    return { type: 'choice', instructions, criteria }
  }
  const criteria: Record<string, string> = Object.create(null)
  for (const [key, value] of Object.entries(question.criteria ?? {}))
    criteria[key] = await cleanText(value, scope)
  return { type: 'noul', instructions, ...(question.criteria ? { criteria } : {}) }
}
export async function batchInput(
  value: unknown,
  options = { signal: new AbortController().signal, end: Date.now() + 60000 },
): Promise<BatchInput | null> {
  if (!object(value) || !Array.isArray(value.items) || !value.items.length || value.items.length > 500)
    return null
  const ids: string[] = [],
    unique = new Set<string>()
  // At most500 scalar headers are inspected even on cancellation; states/questions are untouched.
  for (const item of value.items) {
    const id = object(item) ? item.id : undefined
    if (typeof id !== 'string' || !id || id.length > 128 || unique.has(id)) return null
    ids.push(id)
    unique.add(id)
  }
  const scope = preparation(options.signal, options.end)
  try {
    scope.check()
    if (!object(value.questions)) return null
    const raw = await snapshot(value.questions, RAW_BYTES, scope)
    const questions: Record<string, Question> = Object.create(null)
    const encoded: [string, string][] = []
    for (const [id, entry] of Object.entries(raw.value as Record<string, JsonValue>)) {
      const waiting = scope.step()
      if (waiting) await waiting
      if (
        (await cleanText(id, scope)) !== id ||
        !validateRequest({ state: null, questions: { [id]: entry } } as JudgmentRequest).ok
      )
        return null
      const question = entry as Question
      if (
        question.type === 'choice' &&
        (!Object.hasOwn(question.criteria, 'other') || !Object.hasOwn(question.criteria, 'mixed'))
      )
        return null
      questions[id] = await maskQuestion(question, scope)
      if (!validateRequest({ state: null, questions: { [id]: questions[id] } }).ok) return null
      encoded.push([id, JSON.stringify(questions[id])])
    }
    if (!encoded.length) return null
    const items: BatchInput['items'] = []
    for (let index = 0; index < value.items.length; index++) {
      scope.check()
      const id = ids[index]
      if (id === undefined) return null
      const overhead = encoder.encode(JSON.stringify({ id, state: null })).length - 4
      const raw = await snapshot(value.items[index].state, RAW_BYTES - overhead, scope)
      const masked = await maskCredentialValues(raw.value, scope)
      scope.check()
      const text = await cleanText(JSON.stringify(masked), scope)
      const state = JSON.parse(text) as JsonValue
      for (const [id, question] of encoded) {
        const waiting = scope.step()
        if (waiting) await waiting
        if (!atomicRequestFits(text, id, question, 24000)) return null
      }
      items.push({ id, state })
    }
    scope.check()
    return { items, questions }
  } catch {
    if (options.signal.aborted || Date.now() >= options.end) throw new BatchPreparationInterrupted(ids)
    return null
  }
}
