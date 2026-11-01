import type { ToolContext } from '@agnes/extension-api'
import type { SessionImpl } from '../../step/session.js'
import { assertReview } from './review-budget.js'

/** Guard Core's capability ports, leaving pre-existing jobs and children alone. */
export function reviewToolContext(s: SessionImpl, context: ToolContext): ToolContext {
  const { artifacts, subagent, decisions } = context
  const sendMessage = subagent.sendMessage
  // Assemble guards before publication, preserving the identity bound to Core's effect scope.
  return Object.assign(context, {
    artifacts: {
      ...artifacts,
      submitJob: async (spec) => {
        await assertReview(s, 'unsupported')
        return artifacts.submitJob(spec)
      },
    },
    subagent: {
      ...subagent,
      resume: async (id) => {
        await assertReview(s, 'unsupported')
        return subagent.resume(id)
      },
      ...(sendMessage
        ? {
            sendMessage: async (id: string, text: string, signal?: AbortSignal) => {
              await assertReview(s, 'unsupported')
              return sendMessage.call(subagent, id, text, signal)
            },
          }
        : {}),
      fork: async (task, options) => {
        await assertReview(s, 'unsupported')
        return subagent.fork(task, options)
      },
      spawn: async (task, options) => {
        await assertReview(s, 'unsupported')
        return subagent.spawn(task, options)
      },
    },
    decisions: {
      ...decisions,
      request: async (spec) => {
        await assertReview(s, 'unsupported')
        return decisions.request(spec)
      },
      wait: async (handle, options) => {
        await assertReview(s, 'unsupported')
        return decisions.wait(handle, options)
      },
    },
  } satisfies Pick<ToolContext, 'artifacts' | 'subagent' | 'decisions'>)
}
