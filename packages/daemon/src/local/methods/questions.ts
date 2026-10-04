import type {
  Actor,
  QuestionAnswerParams,
  QuestionCancelParams,
  QuestionInteraction,
  QuestionPendingParams,
  QuestionResolution,
} from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import type { LocalEndpoint } from '../endpoint.js'
import type { AgnesContext } from './agnes.js'

/** The writer owns pending state. This port also supports a remote session without reopening it. */
export type QuestionControl = {
  resolveActor?(credential: unknown, sessionKey: string): Promise<Actor>
  pending(sessionKey: string): QuestionInteraction[] | Promise<QuestionInteraction[]>
  answer(
    sessionKey: string,
    interactionId: string,
    answer: unknown,
    actor: Actor,
  ): Promise<QuestionResolution>
  cancel(sessionKey: string, interactionId: string, actor: Actor): Promise<QuestionResolution>
}
const QUESTION_ERRORS = new Set([
  'NO_PROVIDER',
  'CALLER_NOT_LIVE',
  'DELEGATED_CALLER',
  'INVALID_QUESTION_REQUEST',
  'INVALID_QUESTION_ANSWER',
  'QUESTION_NOT_LIVE',
  'QUESTION_CONFLICT',
  'ASK_ABORTED',
  'ASK_CANCELLED',
  'E_STORAGE_FAULT',
])

export function registerQuestions(ep: LocalEndpoint, cx: AgnesContext): void {
  const control: QuestionControl = cx.questionControl ?? cx.host.questions
  function owned(sessionId: string): void {
    const owner = cx.sessionOwnership?.resolve(sessionId)
    if (!owner?.active || owner.principalId !== ep.conn.principalId) throw rpcError('CAPABILITY_DENIED')
    if (!control) throw rpcError('SEMANTIC_REJECTED', { code: 'NO_PROVIDER' })
  }
  async function settle(operation: () => Promise<QuestionResolution>): Promise<QuestionResolution> {
    try {
      return await operation()
    } catch (error) {
      const e = error as { code?: unknown; data?: { code?: unknown } } | null
      const code = typeof e?.code === 'string' ? e.code : e?.data?.code
      throw rpcError('SEMANTIC_REJECTED', {
        code: typeof code === 'string' && QUESTION_ERRORS.has(code) ? code : 'QUESTION_NOT_LIVE',
      })
    }
  }
  async function actor(sessionId: string): Promise<Actor> {
    if (!cx.registry.get(sessionId)) throw rpcError('SEMANTIC_REJECTED', { code: 'QUESTION_NOT_LIVE' })
    const resolver = cx.resolveActor ?? cx.host.resolveActor.bind(cx.host)
    const resolved = control.resolveActor
      ? await control.resolveActor(ep.conn.credential, sessionId)
      : await resolver(ep.conn.credential, 'session', sessionId)
    // Resolving a principal can cross a worker await. Recheck ownership before dispatch.
    owned(sessionId)
    if (!cx.registry.get(sessionId)) throw rpcError('SEMANTIC_REJECTED', { code: 'QUESTION_NOT_LIVE' })
    return resolved
  }
  ep.register('_agnes/v1/questions.pending', async (params) => {
    const { sessionId } = params as QuestionPendingParams
    owned(sessionId)
    const interactions = cx.registry.get(sessionId) ? await control.pending(sessionId) : []
    owned(sessionId)
    return { sessionId, interactions }
  })
  ep.register('_agnes/v1/questions.answer', async (params) => {
    const p = params as QuestionAnswerParams
    owned(p.sessionId)
    return settle(async () => {
      const resolved = await actor(p.sessionId)
      cx.commandQueue.assertAdmitted(p.sessionId)
      return control.answer(p.sessionId, p.interactionId, p.answer, resolved)
    })
  })
  ep.register('_agnes/v1/questions.cancel', async (params) => {
    const p = params as QuestionCancelParams
    owned(p.sessionId)
    return settle(async () => control.cancel(p.sessionId, p.interactionId, await actor(p.sessionId)))
  })
}
