import { answerPrefix, parseAnswer, type UINode } from '@agnes/protocol'
import type { ToolCardInlinePayload } from '@agnes/protocol/gen/slots'
export type QuestionPrompt = NonNullable<ToolCardInlinePayload['question']>

export function pendingQuestion(nodes: readonly UINode[]): QuestionPrompt | undefined {
  const texts = nodes
    .filter((n) => n.kind === 'user')
    .map((n) =>
      n.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    )
  const questions = nodes.flatMap((node) =>
    node.kind === 'tool' && node.name === 'ask_user_question'
      ? (node.slots ?? []).flatMap((fill) => {
          const question = (fill.payload as ToolCardInlinePayload).question
          return question ? [question] : []
        })
      : [],
  )
  return questions.reverse().find((q) => !texts.some((text) => parseAnswer(q.id, q.questions, text)))
}

/** Single questions accept labels or option numbers; multiple questions use a JSON object. */
export function answerQuestion(question: QuestionPrompt, text: string): string {
  let answers: unknown
  try {
    answers = JSON.parse(text)
  } catch {
    /* A plain answer is the usual single-question input. */
  }
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    if (question.questions.length !== 1)
      throw new Error(
        'Answer with a JSON object mapping each question id to a value; multiple choice uses arrays.',
      )
    const q = question.questions[0]!
    const translate = (value: string) => {
      const index = /^\d+$/.test(value.trim()) ? Number(value.trim()) - 1 : -1
      return q.options?.[index] ?? value.trim()
    }
    answers = { [q.id]: q.multiple ? text.split(',').map(translate) : translate(text) }
  }
  const encoded = answerPrefix(question.id) + JSON.stringify(answers)
  if (!parseAnswer(question.id, question.questions, encoded))
    throw new Error('Choose the listed option(s), or supply free text when allowed.')
  return encoded
}
