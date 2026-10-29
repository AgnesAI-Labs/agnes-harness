import { setTimeout as delay } from 'node:timers/promises'
import type { ProjectionDef } from '@agnes/extension-api'
import { readUiAnswerFact } from '@agnes/intelligent-ui-contract'
import { type Context, defineAgnesPlugin, defineTool } from '@agnes/plugin-runtime'
import { interactionSurfaceId, renderInteractionSurface } from '../../../src/interaction-surfaces.js'
import { type Answers, QuestionParams, type Questions, questionSurface } from './question.js'

type Question = {
  id: string
  toolUseId: string
  questions: Questions
  answer: Answers | null
  deadline?: number
}
type State = {
  rendered: string[]
  questions: Question[]
  submissions: Record<string, { surfaceId: string; answers: Answers }>
}
function bounded(
  questions: Question[],
  submissions: State['submissions'] = {},
  rendered: string[] = [],
): State {
  const questionSurfaces = new Set(questions.map((question) => interactionSurfaceId(question.id)))
  rendered = [...new Set([...rendered.filter((id) => questionSurfaces.has(id)), ...rendered.slice(-128)])]
  const pending = Object.fromEntries(Object.entries(submissions).slice(-32))
  const bytes = () =>
    new TextEncoder().encode(JSON.stringify({ questions, submissions: pending, rendered })).length
  while (bytes() > 230000 && Object.keys(pending).length) delete pending[Object.keys(pending)[0]!]
  while (bytes() > 230000 && questions.length > 1) questions.shift()
  return { questions, submissions: pending, rendered }
}
/** What the model reads while a question is open. It never lists the questions: the person sees them. */
export function pendingQuestionText(count: number): string {
  const subject = count === 1 ? 'The question is' : `All ${count} questions are`
  return `${subject} shown to the user in the UI as a question card. Do not repeat or list the questions or options in your reply; at most say briefly that you are waiting for their answers. Continue independent work if there is any. The answers arrive later as new user input.`
}

export const questionProjection: ProjectionDef<State> = {
  name: 'questions',
  stateVersion: 3,
  stateSchema: {
    type: 'object',
    required: ['questions', 'submissions', 'rendered'],
    properties: {
      rendered: { type: 'array', items: { type: 'string' } },
      questions: { type: 'array', items: { type: 'object' } },
      submissions: { type: 'object' },
    },
    additionalProperties: false,
  },
  init: () => ({ questions: [], submissions: {}, rendered: [] }),
  apply(state, event) {
    if (event.type === 'x/agnes/interaction/requested' && event.origin === 'ext:agnes/interaction') {
      const question = event.data as Question
      if (state.questions.some((q) => q.id === question.id)) return state as State
      const questions = [...state.questions.slice(-31), question]
      return bounded(questions, state.submissions, state.rendered)
    }
    const fact = readUiAnswerFact(event)
    if (fact?.kind === 'presented')
      return bounded([...state.questions], state.submissions, [
        ...new Set([...state.rendered, fact.surfaceId]),
      ])
    if (fact?.kind === 'received') {
      return bounded(
        [...state.questions],
        {
          ...state.submissions,
          [fact.commandId]: { surfaceId: fact.surfaceId, answers: fact.answers },
        },
        state.rendered,
      )
    }
    if (fact?.kind === 'succeeded') {
      const submitted = state.submissions[fact.commandId]
      if (!submitted) return state as State
      return bounded(
        state.questions.map((q) =>
          interactionSurfaceId(q.id) === submitted.surfaceId && !q.answer
            ? { ...q, answer: submitted.answers }
            : q,
        ),
        state.submissions,
        state.rendered,
      )
    }
    return state as State
  },
}

export default defineAgnesPlugin({
  inject: ['tools', 'projections', 'eventLog'],
  apply(plugin: Context) {
    const read = async (ctx: { projections: import('@agnes/extension-api').ProjectionReader }) => {
      const result = await ctx.projections.readOwn<State>('questions')
      if (result.status !== 'available') throw new Error('question persistence unavailable')
      return result.value
    }
    const disposers = [plugin.projections.register(questionProjection)]
    disposers.push(
      plugin.tools.register(
        defineTool({
          name: 'ask_user_question',
          description:
            'Ask one to four questions with single choice, multiple choice, or free text. Use present for files the user should open or download, and ui_render for tables, charts, forms or dashboards in the UI instead. The agent continues immediately by default; timeoutMs optionally waits up to a bounded deadline. Late answers arrive as new input. Options are labels; omit options for free text; label optionally names a question in a few words. The person sees the questions in the UI, so do not restate them in your reply. Responses use authenticated surface actions and the ordinary queued-input delivery path.',
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
            // The answer comes from a person; an unattended turn does not offer the tool at all.
            requiresUser: true,
          },
          async execute(args, ctx) {
            ctx.signal.throwIfAborted()
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
            const hasRenderer = ctx.tools.list().some((tool) => tool.name === 'ui_render')
            let rendered = hasRenderer && state.rendered.includes(interactionSurfaceId(id))
            if (!previous) {
              await plugin.eventLog.append('requested', {
                id,
                toolUseId: id,
                questions: args.questions,
                answer: null,
                deadline,
              })
            }
            if (hasRenderer && !rendered) {
              try {
                await renderInteractionSurface(
                  ctx,
                  questionSurface(interactionSurfaceId(id), previous?.questions ?? args.questions, deadline),
                )
                rendered = true
              } catch {
                ctx.signal.throwIfAborted()
              }
            }
            if (!rendered)
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Interactive questions are unavailable. Ask the user in ordinary text and continue when they reply.',
                  },
                ],
                details: {
                  questionId: id,
                  status: 'pending',
                  presentation: 'unavailable',
                  questions: previous?.questions ?? args.questions,
                  deadline,
                },
              }
            while (Date.now() < deadline) {
              ctx.signal.throwIfAborted()
              const latest = await read(ctx)
              const answer = latest.questions.find((q) => q.id === id)?.answer
              if (answer)
                return {
                  content: [{ type: 'text', text: JSON.stringify(answer) }],
                  details: { questionId: id, answers: answer },
                }
              if (
                Object.values(latest.submissions).some((item) => item.surfaceId === interactionSurfaceId(id))
              )
                break
              await delay(Math.min(100, deadline - Date.now()), undefined, { signal: ctx.signal })
            }
            return {
              content: [
                {
                  type: 'text',
                  text: pendingQuestionText((previous?.questions ?? args.questions).length),
                },
              ],
              details: { questionId: id, surfaceId: interactionSurfaceId(id), status: 'pending', deadline },
            }
          },
        }),
      ),
    )
    return () => {
      for (const dispose of disposers) dispose()
    }
  },
})
