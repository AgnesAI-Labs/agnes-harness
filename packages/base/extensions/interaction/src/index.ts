import { defineExtension, defineTool, type ProjectionDef } from '@agnes/extension-api'
import { type Answers, answerPrefix, parseAnswer, QuestionParams, type Questions } from './question.js'

type Question = { id: string; toolUseId: string; questions: Questions; answer: Answers | null }
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
    if (event.type === 'user/message') {
      const data = event.data as { content?: { type: string; text?: string }[] }
      const text =
        data.content
          ?.filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('\n') ?? ''
      const questions = state.questions.map((q) => {
        if (q.answer) return q
        const answer = parseAnswer(q.id, q.questions, text)
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
          'Ask one to four questions with single choice, multiple choice, or free text. The session parks until the user supplies a valid answer. Options are labels; omit options for free text. Responses are persisted in the session and wake it through ordinary user input.',
        parameters: QuestionParams,
        meta: {
          isReadOnly: true,
          isDestructive: false,
          isConcurrencySafe: false,
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
          const pending = state.questions.find((q) => !q.answer)
          if (pending && pending.toolUseId !== ctx.session.toolUseId)
            return {
              content: [{ type: 'text', text: `A question is already waiting: ${pending.id}` }],
              isError: true,
            }
          const id = ctx.session.toolUseId
          if (!previous)
            await agnes.events.append('requested', {
              id,
              toolUseId: id,
              questions: args.questions,
              answer: null,
            })
          return {
            content: [
              {
                type: 'text',
                text: `Waiting for your answer.\n${args.questions.map((q) => `${q.question}${q.options ? `\n${q.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}` : ''}`).join('\n\n')}\nSubmit ${answerPrefix(id)} followed by a JSON object mapping question ids to answers; multiple choice uses arrays.`,
              },
            ],
            details: { questionId: id, status: 'pending' },
          }
        },
      }),
    ),
  )
  // Sibling calls in the same batch cannot implement work while a question is waiting.
  disposers.push(
    agnes.registerHook('tool_call', async (payload, ctx) => {
      const pending = (await read(ctx)).questions.find((q) => !q.answer)
      return pending && payload.name !== 'ask_user_question'
        ? { allow: false, reason: 'Answer the pending question first' }
        : { allow: true }
    }),
  )
  disposers.push(
    agnes.registerHook('before_step', async (_payload, ctx) => {
      const state = await read(ctx)
      return state.questions.some((q) => !q.answer) ? { park: true, reason: 'waiting for user answer' } : {}
    }),
  )
  disposers.push(
    agnes.registerSlot('tool.card.inline', async (ctx) => {
      if (ctx.trigger.kind !== 'tool_result') return null
      const toolUseId = ctx.trigger.toolUseId
      const question = (await read(ctx)).questions.find((q) => q.toolUseId === toolUseId)
      return question
        ? { title: 'Question', question: { id: question.id, questions: question.questions } }
        : null
    }),
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
})
