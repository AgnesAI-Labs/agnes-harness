import type { ToolContext } from '@agnes/extension-api'
import type { SessionImpl } from '../../step/session.js'
import { assertReview } from './review-budget.js'

/** Guard Core's capability ports, leaving pre-existing jobs and children alone. */
export function reviewToolContext(s: SessionImpl, context: ToolContext): ToolContext {
  const sendMessage = context.subagent.sendMessage
  return {
    ...context,
    artifacts: {
      ...context.artifacts,
      submitJob: async (spec) => {
        await assertReview(s, 'unsupported')
        return context.artifacts.submitJob(spec)
      },
    },
    subagent: {
      ...context.subagent,
      resume: async (id) => {
        await assertReview(s, 'unsupported')
        return context.subagent.resume(id)
      },
      ...(sendMessage
        ? {
            sendMessage: async (id: string, text: string, signal?: AbortSignal) => {
              await assertReview(s, 'unsupported')
              return sendMessage(id, text, signal)
            },
          }
        : {}),
      fork: async (task, options) => {
        await assertReview(s, 'unsupported')
        return context.subagent.fork(task, options)
      },
      spawn: async (task, options) => {
        await assertReview(s, 'unsupported')
        return context.subagent.spawn(task, options)
      },
    },
    decisions: {
      ...context.decisions,
      request: async (spec) => {
        await assertReview(s, 'unsupported')
        return context.decisions.request(spec)
      },
      wait: async (handle, options) => {
        await assertReview(s, 'unsupported')
        return context.decisions.wait(handle, options)
      },
    },
  }
}
