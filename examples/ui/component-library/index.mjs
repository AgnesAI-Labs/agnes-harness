import { loopCheckpointCodec, loopKind } from '@agnes/extension-api'
import {
  defineAgnesPlugin,
  defineTool,
  drainDeferredToolInvocations,
  readOnlyTool,
} from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
import { reviewSurface } from './surface.mjs'

const codec = loopCheckpointCodec(1, (value) => {
  if (
    !value ||
    !['input', 'waiting', 'done'].includes(value.stage) ||
    !Array.isArray(value.commands) ||
    value.commands.some((id) => typeof id !== 'string') ||
    (value.turnId !== null && !Number.isSafeInteger(value.turnId))
  )
    throw new Error('Invalid review checkpoint')
  return value
})
export function createReviewLoop() {
  const driver = (ctx, saved = { stage: 'input', turnId: null, commands: [] }) => {
    const state = structuredClone(saved)
    const save = () => ctx.checkpoints.write(codec.encode(state))
    return {
      checkpoint: () => codec.encode(state),
      cancel() {},
      dispose() {},
      async step(signal) {
        signal.throwIfAborted()
        const deferred = await drainDeferredToolInvocations(ctx, signal)
        if (deferred) return deferred
        const input = await ctx.input.accept()
        if (!input) {
          await ctx.wait.park(signal)
          return { outcome: 'idle' }
        }
        if (state.stage === 'input') {
          state.turnId = input.turnId
          // A stable invocation id gives publication the normal durable tool replay semantics.
          await ctx.tools.execute(
            {
              invocationId: `review:${state.turnId}`,
              name: 'ui_render',
              args: { surface: reviewSurface(`review-${state.turnId}`) },
            },
            signal,
          )
          state.stage = 'waiting'
          await save()
          return ctx.events.finish('completed')
        }
        // Text and caller-supplied payloads cannot impersonate authenticated action-result input.
        const result = input.system
        if (
          input.origin !== 'system' ||
          result?.source !== 'agnes/intelligent-ui' ||
          result.type !== 'action-result' ||
          result.data?.status !== 'succeeded' ||
          result.data.surfaceId !== `review-${state.turnId}` ||
          result.data.invocation?.tool !== 'ui_example_ack' ||
          typeof result.data.commandId !== 'string'
        )
          return ctx.events.finish('completed')
        if (!state.commands.includes(result.data.commandId)) {
          state.commands.push(result.data.commandId)
          state.stage = 'done'
          await save()
          await ctx.events.emit('review.completed', { commandId: result.data.commandId })
        }
        return ctx.events.finish('completed')
      },
    }
  }
  return {
    id: 'example.ui-review',
    version: '1.0.0',
    controls: {},
    capabilities: ['checkpoint', 'park', 'deferred-invocations'],
    codec,
    create: (ctx) => driver(ctx),
    resume: (ctx, saved) => driver(ctx, codec.decode(saved)),
  }
}
export const main = defineAgnesPlugin({
  inject: ['tools', 'providers'],
  apply(ctx) {
    ctx.providers.register(loopKind, createReviewLoop())
    ctx.tools.register(
      defineTool({
        name: 'ui_example_ack',
        description: 'Acknowledge a synthetic review.',
        parameters: Type.Object({ message: Type.String({ maxLength: 64 }) }, { additionalProperties: false }),
        meta: readOnlyTool,
        async execute(args) {
          return { content: [{ type: 'text', text: args.message }], structured: args }
        },
      }),
    )
  },
})
