import type { Disposer, HookContext, PluginContextFacets } from '@agnes/extension-api'
import type { StopConfig } from '../config.js'
import { deadlineScope, within } from '../deadline.js'
import type { Judge } from '../judge.js'
import type { JudgmentRequest } from '../questions.js'
import {
  CONVERSATION,
  type ConversationState,
  createConversationProjection,
} from './conversation-projection.js'
import { redactedWindow } from './redacted-window.js'
import questions from './stop-questions.json' with { type: 'json' }

const STOP = { action: 'stop' as const }
function eligible(state: ConversationState): boolean {
  return (
    !state.child &&
    !state.goalSources.length &&
    !!state.request?.text &&
    !!state.reply?.text &&
    !state.reply.hasTools &&
    state.reply.seq > state.request.seq &&
    state.continuedSeq < state.request.seq
  )
}
export function registerStopDetection(
  plugin: PluginContextFacets,
  deps: { judge: (ctx: HookContext) => Promise<Judge | null> | Judge | null; config: () => StopConfig },
): Disposer {
  const lifetime = new AbortController()
  const busy = new Set<string>()
  const projection = plugin.projections.register(createConversationProjection(plugin.self.extId))
  const hook = plugin.hooks.register(
    'turn_stopping',
    async (payload, ctx) => {
      if (busy.has(ctx.session.key)) return STOP
      const scope = deadlineScope(AbortSignal.any([ctx.signal, plugin.self.signal, lifetime.signal]), 14500)
      const started = Date.now()
      busy.add(ctx.session.key)
      try {
        if (!deps.config().enabled || ctx.unattended || !ctx.sideCall || scope.signal.aborted) return STOP
        const read = async () => {
          const result = await within(ctx.projections.readOwn<ConversationState>(CONVERSATION), scope.signal)
          return result.status === 'available' ? result.value : null
        }
        const state = await read()
        if (!state || !eligible(state)) return STOP
        const judge = await within(
          Promise.resolve(deps.judge({ ...ctx, signal: scope.signal })),
          scope.signal,
        )
        if (!judge || scope.signal.aborted) return STOP
        const req: JudgmentRequest = {
          state: {
            request: redactedWindow(state.request!.text, 2000, 'first'),
            reply: redactedWindow(state.reply!.text, 8000, 'last'),
          },
          questions: questions as JudgmentRequest['questions'],
        }
        const result = await within(
          judge.judge('judgment.stop', req, {
            attemptMs: 5000,
            totalMs: Math.max(0, 14500 - (Date.now() - started)),
            signal: scope.signal,
            idPrefix: `stop:${payload.turn}:${state.request!.seq}`,
          }),
          scope.signal,
        )
        if (scope.signal.aborted || result.status !== 'ok') return STOP
        const answer = result.answers.unexpected_stop
        if (answer?.type !== 'noul' || !Number.isFinite(answer.noul) || answer.noul < 0.5 || answer.noul > 1)
          return STOP
        const current = await read()
        if (
          !current ||
          !eligible(current) ||
          current.request!.seq !== state.request!.seq ||
          current.reply!.seq !== state.reply!.seq
        )
          return STOP
        await within(
          plugin.eventLog.append('stop.continued', { requestSeq: state.request!.seq }),
          scope.signal,
        )
        if (scope.signal.aborted) return STOP
        return {
          action: 'continue',
          note: `检测到回复说了要做却结束了，已提醒继续${result.cached ? '（缓存）' : ''}。请继续完成已承诺的下一步，仍须遵守原有权限、审批和预算。`,
        }
      } catch {
        return STOP
      } finally {
        scope.close()
        busy.delete(ctx.session.key)
      }
    },
    { timeoutMs: 15000 },
  )
  return () => {
    lifetime.abort()
    hook()
    projection()
  }
}
