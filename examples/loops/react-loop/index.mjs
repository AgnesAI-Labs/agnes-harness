import { loopCheckpointCodec, registerLoopPlugin } from '@agnes/extension-api'

const SOURCE = '@agnes-example/react-loop'
const ID = 'example.react'
const VERSION = '1.0.0'
const stages = ['input', 'wait', 'child', 'model', 'publish', 'tools', 'parked', 'done']
const initial = () => ({
  stage: 'input',
  turnId: null,
  round: 0,
  calls: [],
  response: null,
  childStarted: false,
  compacted: false,
  endReason: null,
  endError: null,
})

export const codec = loopCheckpointCodec(1, (value) => {
  if (
    !value ||
    typeof value !== 'object' ||
    !stages.includes(value.stage) ||
    (value.turnId !== null && !Number.isSafeInteger(value.turnId)) ||
    !Number.isSafeInteger(value.round) ||
    value.round < 0 ||
    !Array.isArray(value.calls) ||
    typeof value.childStarted !== 'boolean' ||
    typeof value.compacted !== 'boolean' ||
    (value.endReason !== null && !['completed', 'aborted', 'error'].includes(value.endReason)) ||
    (value.endError !== null &&
      (typeof value.endError?.code !== 'string' || typeof value.endError?.message !== 'string')) ||
    (value.response !== null && !Array.isArray(value.response))
  )
    throw new Error('Invalid ReAct checkpoint')
  for (const call of value.calls)
    if (
      !call ||
      typeof call.name !== 'string' ||
      typeof call.invocationId !== 'string' ||
      call.args === undefined
    )
      throw new Error('Invalid ReAct tool call')
  return value
})

/** A scheduler owned by the plugin. No default continuation/checkpoint/respond/drain edges. */
export function createReactLoop(config = {}) {
  function driver(ctx, saved = initial()) {
    let state = structuredClone(saved)
    let disposed = false
    const save = (ids = []) => ctx.checkpoints.write(codec.encode(state), { invocationIds: ids })
    const modelId = () => `react:${state.turnId}:model:${state.round}`
    const running = () => ({ outcome: 'running', phase: state.stage })
    const finish = async (reason, error) => {
      state.stage = 'done'
      state.endReason = reason
      state.endError = error ?? null
      await save()
      await ctx.events.finish(reason, error)
      return { outcome: 'turn-ended', reason }
    }
    return {
      checkpoint: () => codec.encode(state),
      cancel() {}, // Core supplies the abort signal; cancellation must not poison the next turn.
      dispose() {
        disposed = true
      },
      async step(signal) {
        if (disposed) throw new Error('ReAct driver is disposed')
        try {
          if (state.stage === 'parked') {
            const active = await ctx.turn.view()
            // A durable park intent can precede dispatch or survive an ordinary tool response.
            if (active?.turnId === state.turnId) {
              state.stage = 'tools'
              await save()
              return running()
            }
            const resumed = active ? 'opened' : await ctx.input.resumeParked()
            if (resumed === 'blocked') return { outcome: 'turn-ended', reason: 'blocked' }
            if (resumed !== 'opened') return { outcome: 'parked', reason: 'parked' }
            // The approval continuation has a new Core turn id. Keep the original invocation ids.
            let waiting = false
            for (const call of state.calls) {
              const receipt = await ctx.effects.status(call.invocationId)
              if (receipt.status === 'may-have-sent') {
                try {
                  await ctx.tools.resume(call.invocationId, signal)
                } catch (error) {
                  if (error?.code !== 'E_LANE_BUSY') throw error
                  waiting = true
                }
              } else if (receipt.status === 'not-sent')
                throw new Error('Approval continuation lost its original tool invocation')
            }
            if (waiting) {
              state.turnId = (await ctx.turn.view()).turnId
              await save(state.calls.map((call) => call.invocationId))
              await ctx.events.finish('parked')
              return { outcome: 'parked', reason: 'parked' }
            }
            state.calls = []
            state.turnId = (await ctx.turn.view()).turnId
            state.round++
            state.stage = 'model'
            await save()
            return running()
          }
          const input = await ctx.input.claim('next-turn')
          if (!input) return { outcome: 'idle' }
          if (state.stage === 'done' && state.turnId === input.turnId)
            return await finish(state.endReason ?? 'completed', state.endError ?? undefined)
          if (state.turnId !== null && state.turnId !== input.turnId) state = initial()
          if (state.stage === 'input') {
            state.turnId = input.turnId
            state.stage = config.waitForWake ? 'wait' : config.childTask ? 'child' : 'model'
            await save()
            return running()
          }
          const view = await ctx.turn.view()
          if (!view) throw new Error('Claimed turn has no public view')
          if (signal.aborted || view.cancelled) return await finish('aborted')
          if (state.stage === 'wait') {
            await ctx.wait.park(signal)
            signal.throwIfAborted()
            await ctx.input.claim('next-step')
            state.stage = config.childTask ? 'child' : 'model'
            await save()
            return running()
          }
          if (state.stage === 'child') {
            if (!ctx.children) throw new Error('Host has no child-agent service')
            // Child creation has no invocation receipt. Refuse replay after a crash in this window.
            if (state.childStarted) throw new Error('Child creation requires reconciliation after restart')
            state.childStarted = true
            await save()
            const handle = await ctx.children.start(config.childTask, {
              signal,
              ...(view.budget.perRequestCap === null ? {} : { budget: view.budget.perRequestCap }),
            })
            try {
              // Continuable providers remain idle after a turn; result() waits for lifecycle end.
              const answer = async () => {
                let text = ''
                for await (const event of handle.events()) {
                  if (event.type === 'text') text += event.text
                  if (event.type === 'error') throw new Error(event.message)
                  if (
                    event.type === 'status' &&
                    ['idle', 'completed', 'failed', 'cancelled', 'interrupted'].includes(event.status)
                  )
                    return { status: event.status, text }
                }
                return await handle.result()
              }
              let result = await answer()
              if (config.childMessage) {
                await handle.sendMessage(config.childMessage, signal)
                result = await answer()
              }
              await ctx.events.emit('x/react/child', { id: handle.id, result })
            } finally {
              await handle.dispose()
            }
            state.stage = 'model'
            await save()
            return running()
          }
          if (state.stage === 'model') {
            await ctx.input.claim('next-step')
            // The view is advisory. Core ports still enforce admission for every operation.
            await ctx.events.emit('x/react/budget', {
              ...view.budget,
              model: view.model.id,
              tools: view.tools.map((tool) => tool.name),
            })
            if (config.compactAfterTools && state.round > 0 && !state.compacted) {
              if (!ctx.compaction) throw new Error('Host has no compaction port')
              await ctx.turn.endStep()
              const outcome = await ctx.compaction.run(signal)
              if (outcome.outcome !== 'running') return outcome
              state.compacted = true
              await save()
            }
            const id = modelId()
            await save([id])
            const receipt = await ctx.effects.status(id)
            if (receipt.status === 'may-have-sent')
              throw new Error(`Reconcile uncertain model invocation ${id}`)
            const response = []
            if (receipt.status === 'responded') {
              if (!Array.isArray(receipt.result)) throw new Error('Expected a model receipt')
              response.push(...receipt.result)
            } else {
              // Omitted messages preserve Core's media handling, trust envelopes and compacted surface.
              const request = await ctx.prepareRequest({ invocationId: id })
              for await (const event of ctx.model.stream(request, signal)) response.push(event)
            }
            if (response.some((event) => event.type === 'error'))
              throw new Error('ReAct model request failed')
            state.response = response
            state.stage = 'publish'
            await save([id])
            return running()
          }
          if (state.stage === 'publish') {
            const content = state.response.flatMap((event) =>
              event.type === 'text_delta' || event.type === 'thinking_delta'
                ? [{ type: event.type === 'text_delta' ? 'text' : 'thinking', text: event.delta }]
                : [],
            )
            const calls = state.response.filter((event) => event.type === 'toolcall_end')
            state.calls = calls.map((event, i) => ({
              invocationId: `react:${state.turnId}:tool:${state.round}:${i}`,
              name: event.call.name,
              args: event.call.args,
            }))
            const done = state.response.findLast((event) => event.type === 'done')
            state.response = null
            state.stage = state.calls.length ? 'tools' : 'done'
            state.endReason = state.stage === 'done' ? 'completed' : null
            // Atomic publication prevents duplicate assistant messages if a process dies here.
            await ctx.events.assistant(
              {
                content,
                stopReason: state.calls.length
                  ? 'tool_use'
                  : done?.reason === 'length'
                    ? 'max_tokens'
                    : 'end_turn',
              },
              codec.encode(state),
            )
            if (state.stage === 'done') {
              await ctx.events.finish('completed')
              return { outcome: 'turn-ended', reason: 'completed' }
            }
            return running()
          }
          if (state.stage === 'tools') {
            // Core can close a parked turn before returning PARKED. Save the park intent first.
            await ctx.checkpoints.write(codec.encode({ ...state, stage: 'parked' }), {
              invocationIds: state.calls.map((call) => call.invocationId),
            })
            const pending = []
            for (const call of state.calls) {
              const receipt = await ctx.effects.status(call.invocationId)
              if (receipt.status === 'may-have-sent')
                throw new Error(`Reconcile uncertain tool invocation ${call.invocationId}`)
              if (receipt.status === 'not-sent') pending.push(call)
            }
            await ctx.tools.batch(pending, signal)
            state.calls = []
            state.round++
            state.stage = 'model'
            await save()
            return running()
          }
          throw new Error(`Invalid ReAct stage ${state.stage}`)
        } catch (error) {
          if (error?.code === 'PARKED') {
            state.stage = 'parked'
            await save(state.calls.map((call) => call.invocationId))
            return { outcome: 'parked', reason: 'parked' }
          }
          if (signal.aborted) return await finish('aborted')
          // Core can end admission before a model/tool effect. Do not overwrite that ending.
          if (error?.code === 'E_BUDGET')
            return { outcome: 'turn-ended', reason: error.detail?.reason ?? 'budget' }
          return await finish('error', { code: 'REACT_FAILED', message: String(error) })
        }
      },
    }
  }
  return {
    id: ID,
    version: VERSION,
    capabilities: ['model', 'tools', 'parallel', 'approval', 'checkpoint', 'compaction', 'children', 'park'],
    codec,
    create: (ctx) => driver(ctx),
    resume: (ctx, checkpoint) => driver(ctx, codec.decode(checkpoint)),
  }
}

export const plugin = {
  inject: ['loops'],
  apply(ctx, config) {
    registerLoopPlugin(ctx, SOURCE, createReactLoop(config))
  },
}
