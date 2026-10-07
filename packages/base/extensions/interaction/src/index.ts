import { setTimeout as delay } from 'node:timers/promises'
import { defineExtension, defineTool, type ProjectionDef } from '@agnes/extension-api'
import { type Answers, answerPrefix, parseAnswer, QuestionParams, type Questions } from './question.js'

type Question = {
  id: string
  toolUseId: string
  questions: Questions
  answer: Answers | null
  deadline?: number
}
type State = { questions: Question[] }
function bounded(questions: Question[]): State {
  while (questions.length > 1 && new TextEncoder().encode(JSON.stringify(questions)).length > 230000)
    questions.shift()
  return { questions }
}
export const questionProjection: ProjectionDef<State> = {
  name: 'questions',
  stateVersion: 1,
  stateSchema: {
    type: 'object',
    required: ['questions'],
    properties: { questions: { type: 'array', items: { type: 'object' } } },
    additionalProperties: false,
  },
  init: () => ({ questions: [] }),
  apply(state, event) {
    if (event.type === 'x/agnes/interaction/requested') {
      const question = event.data as Question
      if (state.questions.some((q) => q.id === question.id)) return state as State
      const questions = [...state.questions.slice(-31), question]
      return bounded(questions)
    }
    if (event.type === 'user/message' || event.type === 'inbox') {
      const data = event.data as {
        content?: { type: string; text?: string }[]
        items?: { content: { type: string; text?: string }[] }[]
      } | null
      const messages = event.type === 'inbox' ? (data?.items ?? []) : data ? [data] : []
      const texts = messages.map(
        (message) =>
          message.content
            ?.filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('\n') ?? '',
      )
      const questions = state.questions.map((q) => {
        if (q.answer) return q
        const answer = texts.map((text) => parseAnswer(q.id, q.questions, text)).find(Boolean)
        return answer ? { ...q, answer } : q
      })
      return questions.some((q, i) => q !== state.questions[i]) ? bounded(questions) : (state as State)
    }
    return state as State
  },
}

export default defineExtension((agnes) => {
  const read = async (ctx: { projections: import('@agnes/extension-api').ProjectionReader }) => {
    const result = await ctx.projections.readOwn<State>('questions')
    if (result.status !== 'available') throw new Error('question persistence unavailable')
    return result.value
  }
  const disposers = [agnes.registerProjection(questionProjection)]
  disposers.push(
    agnes.registerTool(
      defineTool({
        name: 'ask_user_question',
        description:
          'Ask one to four questions with single choice, multiple choice, or free text. The agent continues immediately by default; timeoutMs optionally waits up to a bounded deadline. Late answers arrive as new input. Options are labels; omit options for free text. Responses are persisted in the session and wake it through ordinary user input.',
        parameters: QuestionParams,
        meta: {
          isReadOnly: true,
          isDestructive: false,
          isConcurrencySafe: true,
          isOpenWorld: false,
          replay: 'idempotent',
          costHint: {},
          deferLoading: false,
          requiresApproval: 'never',
        },
        async execute(args, ctx) {
          if (new TextEncoder().encode(JSON.stringify(args.questions)).length > 60000)
            return {
              content: [{ type: 'text', text: 'questions exceed the card payload limit' }],
              isError: true,
            }
          if (new Set(args.questions.map((q) => q.id)).size !== args.questions.length)
            return { content: [{ type: 'text', text: 'question ids must be unique' }], isError: true }
          const state = await read(ctx)
          const previous = state.questions.find((q) => q.toolUseId === ctx.session.toolUseId)
          if (previous?.answer)
            return {
              content: [{ type: 'text', text: JSON.stringify(previous.answer) }],
              details: { questionId: previous.id, answers: previous.answer },
            }
          const id = ctx.session.toolUseId
          const deadline = previous?.deadline ?? Date.now() + (args.timeoutMs ?? 0)
          if (!previous)
            await agnes.events.append('requested', {
              id,
              toolUseId: id,
              questions: args.questions,
              answer: null,
              deadline,
            })
          while (Date.now() < deadline) {
            ctx.signal.throwIfAborted()
            const answer = (await read(ctx)).questions.find((q) => q.id === id)?.answer
            if (answer)
              return {
                content: [{ type: 'text', text: JSON.stringify(answer) }],
                details: { questionId: id, answers: answer },
              }
            await delay(Math.min(100, deadline - Date.now()), undefined, { signal: ctx.signal })
          }
          return {
            content: [
              {
                type: 'text',
                text: `Question remains open; continue independent work. A late answer will arrive as new user input.\n${args.questions.map((q) => `${q.question}${q.options ? `\n${q.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}` : ''}`).join('\n\n')}\nSubmit ${answerPrefix(id)} followed by a JSON object mapping question ids to answers; multiple choice uses arrays.`,
              },
            ],
            details: { questionId: id, status: 'pending', deadline },
          }
        },
      }),
    ),
  )
  disposers.push(
    agnes.registerSlot('tool.card.inline', async (ctx) => {
      if (ctx.trigger.kind !== 'tool_result' && ctx.trigger.kind !== 'tool_call') return null
      const toolUseId = ctx.trigger.toolUseId
      const question = (await read(ctx)).questions.find((q) => q.toolUseId === toolUseId)
      return question
        ? {
            title: 'Question · continue independent work; late answers are accepted',
            question: { id: question.id, questions: question.questions },
          }
        : null
    }),
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
})
