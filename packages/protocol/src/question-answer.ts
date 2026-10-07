import type { ToolCardInlinePayload } from '../gen/ts/slots.js'

type Questions = NonNullable<ToolCardInlinePayload['question']>['questions']
export type QuestionAnswers = Record<string, string | string[]>
type Answers = QuestionAnswers
export const answerPrefix = (id: string) => `[question-answer ${id}] `

/** User input is data, not an authority decision. Validate the entire answer before waking. */
export function parseAnswer(id: string, questions: Questions, text: string): Answers | undefined {
  if (new TextEncoder().encode(text).length > 60000 || !text.startsWith(answerPrefix(id))) return undefined
  try {
    const value: unknown = JSON.parse(text.slice(answerPrefix(id).length))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const answers = value as Answers
    if (Object.keys(answers).length !== questions.length) return undefined
    for (const q of questions) {
      const answer = answers[q.id]
      const selected = Array.isArray(answer) ? answer : [answer]
      if (q.multiple ? !Array.isArray(answer) : typeof answer !== 'string') return undefined
      if (!selected.length || selected.length > 12 || new Set(selected).size !== selected.length)
        return undefined
      if (
        selected.some(
          (a) =>
            typeof a !== 'string' ||
            !a.trim() ||
            a.length > 8192 ||
            (q.options && !q.allowFreeText && !q.options.includes(a)),
        )
      )
        return undefined
    }
    return answers
  } catch {
    return undefined
  }
}
