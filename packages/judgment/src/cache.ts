import { createHash } from 'node:crypto'
import type { OwnedStore } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import type { JudgeTarget } from './config.js'
import { type Answer, object, parseNativeAnswers, type Question } from './questions.js'

export type KeyValueStore = Pick<OwnedStore, 'get' | 'set' | 'delete' | 'scan'>
export interface AnswerCache {
  get(state: JsonValue, target: JudgeTarget, question: Question): Answer | null
  set(state: JsonValue, target: JudgeTarget, question: Question, answer: Answer): void
  clear(): void
}
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
function keyFor(state: JsonValue, target: JudgeTarget, q: Question): string {
  return createHash('sha256')
    .update(
      canonical({
        state,
        route: target.route,
        model: target.model,
        type: q.type,
        instructions: q.instructions,
        criteria: q.type === 'choice' ? Object.entries(q.criteria) : (q.criteria ?? null),
      }),
    )
    .digest('hex')
}

export function createAnswerCache(
  store: KeyValueStore | null,
  opts: { ttlMs: number; maxEntries: number; onError?: () => void },
): AnswerCache {
  const memory = new Map<string, { answer: Answer; at: number }>()
  let disabled = false
  const fail = () => {
    disabled = true
    memory.clear()
    opts.onError?.()
  }
  const trim = () => {
    while (memory.size > opts.maxEntries) {
      const key = memory.keys().next().value!
      memory.delete(key)
      store?.delete(key)
    }
  }
  return {
    get(state, target, question) {
      if (disabled || !target.native) return null
      try {
        const key = keyFor(state, target, question)
        const value: unknown = memory.get(key) ?? store?.get(key)
        if (
          !object(value) ||
          typeof value.at !== 'number' ||
          !Number.isFinite(value.at) ||
          value.at > Date.now() ||
          Date.now() - value.at >= opts.ttlMs
        ) {
          memory.delete(key)
          if (value !== undefined) store?.delete(key)
          return null
        }
        const answer = parseNativeAnswers({ q: value.answer }, { state: null, questions: { q: question } })?.q
        if (!answer) return null
        memory.delete(key)
        memory.set(key, { answer, at: value.at })
        trim()
        return structuredClone(answer)
      } catch {
        fail()
        return null
      }
    },
    set(state, target, question, answer) {
      if (disabled || !target.native) return
      try {
        const key = keyFor(state, target, question)
        const value = { answer: structuredClone(answer), at: Date.now() }
        store?.set(key, value)
        memory.delete(key)
        memory.set(key, value)
        trim()
      } catch {
        fail()
      }
    },
    clear() {
      memory.clear()
    },
  }
}
