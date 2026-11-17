import { createHash } from 'node:crypto'
import type { JudgmentAccounting } from '../accounting.js'
import type { Judge } from '../judge.js'
import type { Answer, Answers } from '../questions.js'
import type { BatchInput } from './tool-input.js'

type PublicAnswer =
  | Answer
  | { type: 'choice'; choice: string }
  | { type: 'score'; score: number }
  | { type: 'noul'; value: boolean }
export type BatchCompleted = {
  id: string
  answers?: Record<string, PublicAnswer>
  failure?: string
  needsReview: boolean
  probabilityAvailable: boolean
}
const review = (answer: Answer) =>
  answer.type === 'noul'
    ? Math.max(answer.noul, 1 - answer.noul) < 0.7
    : Math.max(...Object.values(answer.probabilities)) < 0.7 ||
      (answer.type === 'choice' && ['other', 'mixed'].includes(answer.choice))
const publicAnswers = (answers: Answers, native: boolean): Record<string, PublicAnswer> =>
  Object.fromEntries(
    Object.entries(answers).map(([id, answer]) => [
      id,
      native
        ? answer
        : answer.type === 'choice'
          ? { type: 'choice', choice: answer.choice }
          : answer.type === 'score'
            ? { type: 'score', score: answer.score }
            : { type: 'noul', value: answer.noul >= 0.5 },
    ]),
  )
export async function judgeBatch(
  judge: Judge,
  input: BatchInput,
  signal: AbortSignal,
  id: string,
  end: number,
) {
  const calls: JudgmentAccounting['calls'][number][] = []
  const prefix = createHash('sha256').update(id).digest('hex').slice(0, 32)
  const rows = await Promise.all(
    input.items.map(async (item, index): Promise<BatchCompleted | null> => {
      if (signal.aborted || Date.now() >= end) return null
      try {
        const result = await judge.judge(
          'judgment.batch',
          { state: item.state, questions: input.questions },
          {
            attemptMs: 10000,
            totalMs: Math.max(1, end - Date.now()),
            signal,
            idPrefix: `batch:${prefix}:${index}`,
            retry: 'once',
          },
        )
        calls.push(...result.accounting.calls)
        if (result.status === 'failed') {
          if (signal.aborted || result.reason === 'timeout') return null
          return { id: item.id, failure: result.reason, needsReview: true, probabilityAvailable: false }
        }
        return {
          id: item.id,
          answers: publicAnswers(result.answers, result.probabilityAvailable),
          needsReview: !result.probabilityAvailable || Object.values(result.answers).some(review),
          probabilityAvailable: result.probabilityAvailable,
        }
      } catch {
        return signal.aborted
          ? null
          : { id: item.id, failure: 'error', needsReview: true, probabilityAvailable: false }
      }
    }),
  )
  const completed = rows.filter((row): row is BatchCompleted => row !== null)
  const pending = input.items.filter((_, index) => rows[index] === null).map((item) => item.id)
  return {
    completed,
    pending,
    partial: pending.length > 0 || completed.some((row) => !!row.failure),
    accounting: { calls },
    billing: 'See original accounting; missing dollar billing is unknown.',
  }
}
