import type { JsonValue } from '@agnes/protocol'
import type { JudgmentAccounting } from '../accounting.js'
import { splitRequest } from '../encode.js'
import type { Judge } from '../judge.js'
import type { JudgmentRequest } from '../questions.js'
import instructions from './find-questions.json' with { type: 'json' }

export type FindStageStats = {
  calls: JudgmentAccounting['calls'][number][]
  failures: number
  successful: number
  reasons: Set<string>
  sequence: number
}
export async function scoreFindEntries<T>(
  deps: {
    judge: Judge
    query: string
    signal: AbortSignal
    end: number
    prefix: string
    stats: FindStageStats
  },
  stage: keyof typeof instructions,
  entries: readonly T[],
  batchSize: number,
  stateOf: (entry: T) => JsonValue,
): Promise<{ entry: T; score: number }[]> {
  const scored: { entry: T; score: number }[] = []
  for (let offset = 0; offset < entries.length; ) {
    if (deps.signal.aborted || Date.now() >= deps.end) {
      deps.stats.reasons.add('cancelled')
      break
    }
    let size = Math.min(batchSize, entries.length - offset)
    let req: JudgmentRequest
    for (;;) {
      const batch = entries.slice(offset, offset + size)
      req = {
        state: {
          query: deps.query,
          entries: batch.map((entry, index) => ({ id: `q${index}`, value: stateOf(entry) })),
        },
        questions: Object.fromEntries(
          batch.map((_, index) => [
            `q${index}`,
            { type: 'noul', instructions: `${instructions[stage]} Assess entry q${index}.` },
          ]),
        ),
      }
      try {
        splitRequest(req, { state: 24000, request: 48000 })
        break
      } catch {
        if (size === 1) throw new Error('Find entry exceeds request bounds')
        size = Math.max(1, Math.floor(size / 2))
      }
    }
    const batch = entries.slice(offset, offset + size)
    offset += size
    try {
      const result = await deps.judge.judge(`judgment.find.${stage}`, req, {
        attemptMs: 10000,
        totalMs: Math.max(1, deps.end - Date.now()),
        signal: deps.signal,
        idPrefix: `find:${deps.prefix}:${deps.stats.sequence++}`,
        retry: 'once',
      })
      deps.stats.calls.push(...result.accounting.calls)
      if (result.status !== 'ok' || !result.probabilityAvailable) {
        deps.stats.failures += batch.length
        deps.stats.reasons.add(`judgment_${result.status === 'failed' ? result.reason : 'non_native'}`)
        continue
      }
      deps.stats.successful++
      batch.forEach((entry, index) => {
        const answer = result.answers[`q${index}`]
        if (answer?.type === 'noul') scored.push({ entry, score: answer.noul })
        else {
          deps.stats.failures++
          deps.stats.reasons.add('invalid_answer')
        }
      })
    } catch {
      deps.stats.failures += batch.length
      deps.stats.reasons.add(deps.signal.aborted ? 'cancelled' : 'judgment_error')
    }
  }
  return scored
}
