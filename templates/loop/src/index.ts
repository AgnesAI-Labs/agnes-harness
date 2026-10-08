import {
  type LoopCheckpoint,
  type LoopContext,
  type LoopDriver,
  loopCheckpointCodec,
} from '@agnes/extension-api'
import { type LoopPluginContext as Context, defineAgnesPlugin, defineLoop } from '@agnes/plugin-runtime'

const codec = loopCheckpointCodec(1, (state) => {
  if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.done !== 'boolean')
    throw new TypeError('Invalid loop checkpoint')
  return { done: state.done }
})

function driver(ctx: LoopContext, saved?: LoopCheckpoint): LoopDriver {
  let state = saved ? codec.decode(saved) : { done: false }
  const lifetime = new AbortController()
  return {
    async step(signal) {
      const active = AbortSignal.any([signal, lifetime.signal])
      active.throwIfAborted()
      if (state.done) return { outcome: 'turn-ended', phase: 'terminal', reason: 'completed' }
      const input = await ctx.input.accept()
      if (!input) return { outcome: 'idle', phase: 'idle' }
      const messages = [{ role: 'user' as const, content: [...input.content] }]
      const request = await ctx.prepareRequest({
        system: 'Answer the user briefly.',
        messages,
        tools: [],
        invocationId: 'answer:' + input.id,
      })
      const reply = await ctx.model.complete(request, active)
      const failure = reply.find((event) => event.type === 'error')
      if (failure?.type === 'error') throw new Error(failure.message)
      active.throwIfAborted()
      const text = reply.flatMap((event) => (event.type === 'text_delta' ? [event.delta] : [])).join('')
      await ctx.events.assistant(
        {
          content: [{ type: 'text', text }],
          stopReason: 'end_turn',
        },
        codec.encode({ done: true }),
      )
      state = { done: true }
      await ctx.checkpoints.write(codec.encode(state))
      await ctx.events.finish('completed')
      return { outcome: 'turn-ended', phase: 'terminal', reason: 'completed' }
    },
    cancel() {
      lifetime.abort()
    },
    dispose() {
      lifetime.abort()
    },
    checkpoint: () => codec.encode(state),
  }
}

// A deliberately small one-turn loop, independent of the default product loop.
export const loop = defineLoop({
  id: '__PACKAGE_NAME__',
  version: '0.1.0',
  capabilities: ['model'],
  codec,
  create: (ctx: LoopContext) => driver(ctx),
  resume: (ctx: LoopContext, checkpoint: LoopCheckpoint) => driver(ctx, checkpoint),
})

export const main = defineAgnesPlugin({
  inject: ['loops'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.loops.register('__PACKAGE_NAME__', loop))
  },
})
