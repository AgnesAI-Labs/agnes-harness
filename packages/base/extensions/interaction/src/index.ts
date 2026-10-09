import { setTimeout as delay } from 'node:timers/promises'
import { defineExtension, defineTool, type ProjectionDef } from '@agnes/extension-api'
import { interactionSurfaceId, renderInteractionSurface } from '../../../src/interaction-surfaces.js'
import { type Answers, questionSurface, QuestionParams, type Questions } from './question.js'

type Question = {
  id: string
  toolUseId: string
  questions: Questions
  answer: Answers | null
  deadline?: number
}
type State = { questions: Question[]; submissions: Record<string, { surfaceId: string; answers: Answers }> }
function bounded(questions: Question[], submissions: State['submissions'] = {}): State {
  const pending = Object.fromEntries(Object.entries(submissions).slice(-32))
  const bytes = () => new TextEncoder().encode(JSON.stringify({ questions, submissions: pending })).length
  while (bytes() > 230000 && Object.keys(pending).length) delete pending[Object.keys(pending)[0]!]
  while (bytes() > 230000 && questions.length > 1) questions.shift()
  return { questions, submissions: pending }
}
export const questionProjection: ProjectionDef<State> = {
  name: 'questions',
  stateVersion: 1,
  stateSchema: {
    type: 'object',
    required: ['questions', 'submissions'],
    properties: { questions: { type: 'array', items: { type: 'object' } }, submissions: { type: 'object' } },
    additionalProperties: false,
  },
  init: () => ({ questions: [], submissions: {} }),
  apply(state, event) {
    if (event.type === 'x/agnes/interaction/requested') {
      const question = event.data as Question
      if (state.questions.some((q) => q.id === question.id)) return state as State
      const questions = [...state.questions.slice(-31), question]
      return bounded(questions, state.submissions)
    }
    if (event.origin !== 'ext:agnes/intelligent-ui') return state as State
    if (event.type === 'x/agnes/intelligent-ui/action.received') {
      const { record } = event.data as {
        record: {
          request: { commandId: string }
          invocation?: { tool: string; args: { surfaceId: string; answers: Answers } }
        }
      }
      if (record.invocation?.tool !== 'ui_submit') return state as State
      return bounded([...state.questions], {
        ...state.submissions,
        [record.request.commandId]: record.invocation.args,
      })
    }
    if (event.type === 'x/agnes/intelligent-ui/action.succeeded') {
      const { commandId } = event.data as { commandId: string }
      const submitted = state.submissions[commandId]
      if (!submitted) return state as State
      return bounded(
        state.questions.map((q) =>
          interactionSurfaceId(q.id) === submitted.surfaceId && !q.answer
            ? { ...q, answer: submitted.answers }
            : q,
        ),
        state.submissions,
      )
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
          'Ask one to four questions with single choice, multiple choice, or free text. The agent continues immediately by default; timeoutMs optionally waits up to a bounded deadline. Late answers arrive as new input. Options are labels; omit options for free text. Responses use authenticated surface actions and the ordinary queued-input delivery path.',
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
              content: [{ type: 'text', text: 'questions exceed the surface payload limit' }],
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
          if (!previous) {
            await renderInteractionSurface(ctx, questionSurface(interactionSurfaceId(id), args.questions))
            await agnes.events.append('requested', {
              id,
              toolUseId: id,
              questions: args.questions,
              answer: null,
              deadline,
            })
          }
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
                text: `Question remains open; continue independent work. A late answer arrives through the surface action.
${args.questions.map((q) => `${q.question}${q.options ? '\n' + q.options.map((o, i) => `${i + 1}. ${o}`).join('\n') : ''}`).join('\n\n')}
[Open questions](/?session=${encodeURIComponent(ctx.session.key)}&surface=${interactionSurfaceId(id)})`,
              },
            ],
            details: { questionId: id, status: 'pending', deadline },
          }
        },
      }),
    ),
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
})
