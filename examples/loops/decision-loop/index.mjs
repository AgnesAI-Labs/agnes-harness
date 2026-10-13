import { loopCheckpointCodec, loopKind } from '@agnes/extension-api'

const ID = 'example.decision'
const initial = () => ({ stage: 'input', turnId: null, handle: null, option: null })
export const codec = loopCheckpointCodec(1, (value) => {
  if (
    !value ||
    !['input', 'request', 'waiting', 'done'].includes(value.stage) ||
    (value.turnId !== null && !Number.isSafeInteger(value.turnId)) ||
    (value.handle !== null &&
      (typeof value.handle?.id !== 'string' || typeof value.handle?.sessionId !== 'string')) ||
    (value.option !== null && !['continue', 'reject'].includes(value.option))
  )
    throw new Error('Invalid decision checkpoint')
  if (value.stage !== 'input' && value.turnId === null) throw new Error('Missing original turn')
  if (['waiting', 'done'].includes(value.stage) && !value.handle) throw new Error('Missing original decision')
  if (value.stage === 'done' && !value.option) throw new Error('Missing human response')
  return value
})

/** This confirmation advances a pure phase. It grants no tool or management permission. */
export function createDecisionLoop() {
  function driver(ctx, saved = initial()) {
    let state = structuredClone(saved)
    const save = (decisionRefs = []) => ctx.checkpoints.write(codec.encode(state), { decisionRefs })
    return {
      checkpoint: () => codec.encode(state),
      cancel() {},
      dispose() {},
      async step(signal) {
        signal.throwIfAborted()
        if (state.stage === 'input') {
          const input = await ctx.input.accept()
          if (!input) return { outcome: 'idle' }
          state = { ...initial(), stage: 'request', turnId: input.turnId }
          // Persist the stable key BEFORE request: a crash before the waiting checkpoint
          // recovers the same operation/key rather than issuing a new question.
          await save()
        }
        if (state.stage === 'request') {
          state.handle = await ctx.decisions.request({
            key: `phase:${state.turnId}`,
            purpose: 'business.confirm',
            subject: {
              phase: 'review',
              turnId: state.turnId,
              content: 'Advance the synthetic review phase.',
            },
            prompt: 'Advance the synthetic review phase?',
            options: ['continue', 'reject'],
            responseSchema: { type: 'null' },
          })
          state.stage = 'waiting'
          await save()
          return { outcome: 'parked', reason: 'parked' }
        }
        if (state.stage === 'waiting') {
          const snapshot = await ctx.decisions.get(state.handle)
          // A local wait may detach without answering. The original handle is durable.
          const result = snapshot.result
            ? { status: 'resolved', snapshot }
            : await ctx.decisions.wait(state.handle, { signal })
          if (result.status !== 'resolved') return { outcome: 'parked', reason: 'parked' }
          const resolved = result.snapshot
          if (resolved.invalidation || resolved.result?.reason !== 'answered')
            return { outcome: 'turn-ended', reason: 'blocked' }
          state.option = resolved.result.response.option
          state.stage = 'done'
          // Consume once with the next pure checkpoint; there is no effect dispatch here.
          await save([state.handle])
        }
        const reason = state.option === 'continue' ? 'completed' : 'blocked'
        // A completion the stop gate keeps open is asked again on the next step, from stage `done`.
        const end = await ctx.events.finish(reason)
        if (end.outcome === 'running') return end
        state = initial()
        await save()
        return end
      },
    }
  }
  return {
    id: ID,
    version: '1.0.0',
    controls: {},
    capabilities: ['approval', 'checkpoint', 'park'],
    codec,
    create: (ctx) => driver(ctx),
    resume: (ctx, checkpoint) => driver(ctx, codec.decode(checkpoint)),
  }
}
export const plugin = {
  inject: ['providers'],
  apply(ctx) {
    ctx.providers.register(loopKind, createDecisionLoop())
  },
}
