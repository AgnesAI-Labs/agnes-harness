import { drainDeferredToolInvocations } from '@agnes/plugin-runtime'
import {
  DEFAULT_LOOP,
  type LoopCheckpoint,
  type LoopCheckpointCodec,
  type LoopContext,
  type LoopDriver,
  type LoopFactory,
  type LoopPluginContext,
  type LoopStepOutcome,
  registerLoopPlugin,
} from '@agnes/extension-api'

/**
 * This stateless scheduler uses Core's recoverable ledger operations. Version 1 also accepts
 * historical checkpoints whose state was a ledger counter; Core, rather than the codec, recovers
 * that counter. No private counter shape is inspected by this package.
 */
const codec: LoopCheckpointCodec = {
  version: 1,
  encode: () => ({ codecVersion: 1, state: null }),
  decode(checkpoint) {
    if (checkpoint.codecVersion !== 1)
      throw new Error('Default loop checkpoint codec version is unsupported; expected 1')
    return null
  },
}

function create(ctx: LoopContext): LoopDriver {
  let disposed = false
  return {
    cancel() {},
    dispose() {
      disposed = true
    },
    checkpoint: () => codec.encode(null),
    async step(signal): Promise<LoopStepOutcome> {
      if (disposed) throw new Error('Default loop driver is disposed')
      const deferred = await drainDeferredToolInvocations(ctx, signal)
      if (deferred) return deferred
      const continuation = ctx.turn.continuation()
      if (!continuation) {
        const parked = await ctx.input.resumeParked()
        if (parked === 'opened') return { outcome: 'running', phase: ctx.turn.continuation() ?? 'checkpoint' }
        if (parked === 'blocked') return { outcome: 'turn-ended', phase: 'terminal', reason: 'blocked' }
        if (parked === 'waiting') return { outcome: 'parked', phase: 'terminal', reason: 'parked' }
        return (await ctx.input.claim('next-turn'))
          ? { outcome: 'running', phase: 'checkpoint' }
          : { outcome: 'idle', phase: 'idle' }
      }
      if (ctx.turn.cancelled() || signal.aborted) return ctx.turn.finishCancelled()
      if (continuation !== 'checkpoint' && continuation !== 'failure') await ctx.input.claim('next-step')
      switch (continuation) {
        case 'checkpoint':
          return ctx.turn.checkpoint(signal)
        case 'model':
          return ctx.model.respond(signal)
        case 'tools':
          return ctx.tools.drain(signal)
        case 'compaction':
          if (!ctx.compaction) throw new Error('Compaction continuation has no fitted runner')
          return ctx.compaction.run(signal)
        case 'deferred':
          return ctx.wait.poll(signal)
        case 'failure':
          if (await ctx.input.claim('next-step')) return { outcome: 'running', phase: 'checkpoint' }
          return ctx.turn.finishFailure()
      }
    },
  }
}

export const defaultLoopFactory: LoopFactory = Object.freeze({
  ...DEFAULT_LOOP,
  checkpointMode: 'ledger',
  controls: { steer: true, interrupt: true, pause: true },
  capabilities: [
    'model',
    'tools',
    'multimodal',
    'compaction',
    'children',
    'park',
    'recovery',
    'deferred-invocations',
  ],
  codec,
  create,
  resume(ctx: LoopContext, checkpoint: LoopCheckpoint) {
    codec.decode(checkpoint)
    return create(ctx)
  },
})

/** Loaded and cleaned up as an ordinary provider plugin, with no Core/Host registration privilege. */
export const defaultLoopPlugin = {
  inject: ['loops'],
  apply(ctx: LoopPluginContext) {
    registerLoopPlugin(ctx, '@agnes/loop-default', defaultLoopFactory)
  },
}
export { DEFAULT_LOOP }
