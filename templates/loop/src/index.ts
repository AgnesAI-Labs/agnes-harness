import { createHash } from 'node:crypto'
import { defineAgnesPlugin, defineLoop, type LoopPluginContext as Context } from '@agnes/plugin-runtime'
import {
  loopCheckpointCodec,
  type LoopContext,
  type LoopCheckpoint,
  type LoopDriver,
} from '@agnes/extension-api'

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
      if (state.done) return { phase: 'terminal', reason: 'completed' }
      const input = await ctx.input.accept()
      if (!input) return { phase: 'idle', reason: 'parked' }
      const messages = [{ role: 'user' as const, content: [...input.content] }]
      const reply = await ctx.model.complete(
        {
          kind: 'inference',
          sessionKey: ctx.sessionKey,
          slot: 'primary',
          route: 'demo',
          model: 'demo-model',
          contractId: null,
          derivedHash: createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
          system: 'Answer the user briefly.',
          messages,
          tools: [],
        },
        active,
      )
      const failure = reply.find((event) => event.type === 'error')
      if (failure?.type === 'error') throw new Error(failure.message)
      active.throwIfAborted()
      const text = reply.flatMap((event) => (event.type === 'text_delta' ? [event.delta] : [])).join('')
      await ctx.events.emit('assistant/message', {
        content: [{ type: 'text', text }],
        stopReason: 'end_turn',
      })
      state = { done: true }
      await ctx.checkpoints.write(codec.encode(state))
      await ctx.events.finish('completed')
      return { phase: 'terminal', reason: 'completed' }
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
