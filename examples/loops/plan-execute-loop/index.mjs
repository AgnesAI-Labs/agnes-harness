import { loopCheckpointCodec, loopKind } from '@agnes/extension-api'

const ID = 'example.plan-execute'
const VERSION = '1.0.0'
const MAX_STEPS = 8
const stages = ['input', 'planning', 'approving', 'executing', 'tool-parked', 'awaiting-child', 'done']
const childStatuses = ['completed', 'failed', 'cancelled', 'budget_stopped']
const initial = () => ({
  stage: 'input',
  turnId: null,
  request: '',
  steps: [],
  index: 0,
  results: [],
  notices: [],
  handle: null,
  endReason: null,
  endError: null,
})

export const codec = loopCheckpointCodec(1, (value) => {
  if (
    !value ||
    typeof value !== 'object' ||
    !stages.includes(value.stage) ||
    (value.turnId !== null && !Number.isSafeInteger(value.turnId)) ||
    typeof value.request !== 'string' ||
    !Array.isArray(value.steps) ||
    !Number.isSafeInteger(value.index) ||
    value.index < 0 ||
    value.index > value.steps.length ||
    !Array.isArray(value.results) ||
    value.results.length > value.index + 1 ||
    !Array.isArray(value.notices) ||
    (value.handle !== null &&
      (typeof value.handle?.id !== 'string' || typeof value.handle?.sessionId !== 'string')) ||
    (value.endReason !== null && !['completed', 'aborted', 'error', 'blocked'].includes(value.endReason)) ||
    (value.endError !== null &&
      (typeof value.endError?.code !== 'string' || typeof value.endError?.message !== 'string'))
  )
    throw new Error('Invalid plan-execute checkpoint')
  for (const step of value.steps)
    if (!step || typeof step.tool !== 'string' || step.args === undefined)
      throw new Error('Invalid plan step')
  for (const notice of value.notices)
    if (typeof notice?.childKey !== 'string' || !childStatuses.includes(notice.status))
      throw new Error('Invalid child notice')
  if (['waiting', 'approving'].includes(value.stage) && !value.handle)
    throw new Error('Missing original decision')
  if (value.stage !== 'input' && value.turnId === null) throw new Error('Missing original turn')
  return value
})

const textOf = (content) =>
  content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')

/** The reply must be exactly one JSON array, optionally in a single code fence. */
export function parsePlan(reply, tools) {
  const body = reply.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, '$1')
  let steps
  try {
    steps = JSON.parse(body)
  } catch (error) {
    throw new Error(`Plan is not JSON: ${error.message}`)
  }
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS)
    throw new Error(`Plan must be an array of 1-${MAX_STEPS} steps`)
  return steps.map((step, i) => {
    if (!step || typeof step.tool !== 'string' || !tools.includes(step.tool))
      throw new Error(`Step ${i} names a tool outside the turn's catalog`)
    return {
      tool: step.tool,
      args: step.args ?? {},
      ...(step.awaitChild === true ? { awaitChild: true } : {}),
    }
  })
}

/** Host-authenticated source; the body stays untrusted, so only its status and key are kept. */
function childNotice(input) {
  const system = input.system
  if (system?.source !== 'agnes/child' || system.type !== 'child-completed') return null
  const data = system.data
  if (!data || typeof data.childKey !== 'string' || !childStatuses.includes(data.status)) return null
  return { childKey: data.childKey.slice(0, 200), status: data.status }
}

/**
 * Plan, ask a person, then execute: an explicit state machine written against the generic ports
 * only. It never delegates a stage to Core.
 */
export function createPlanExecuteLoop() {
  function driver(ctx, saved = initial()) {
    let state = structuredClone(saved)
    const save = (association = {}) => ctx.checkpoints.write(codec.encode(state), association)
    const running = () => ({ outcome: 'running', phase: state.stage })
    const finish = async (reason, error) => {
      state.stage = 'done'
      state.endReason = reason
      state.endError = error ?? null
      await save()
      return await closeTurn()
    }
    const closeTurn = async () => {
      // Core decides how the turn ends. A stop gate that keeps it open is asked once more on the
      // next step; this loop has no further step to offer, so Core then ends the turn as blocked.
      const end = await ctx.events.finish(state.endReason, state.endError ?? undefined)
      if (end.outcome === 'running') return end
      state = initial()
      await save()
      return end
    }
    const unknownOutcome = (id) =>
      finish('error', {
        code: 'PLAN_UNKNOWN_OUTCOME',
        message: `The outcome of ${id} is unknown; it was not retried`,
      })
    const failStep = async (result) => {
      await ctx.events.emit('result', { results: state.results, failedStep: state.index })
      return await finish('error', {
        code: 'PLAN_STEP_FAILED',
        message: `Step ${state.index} (${state.steps[state.index].tool}) failed: ${textOf(result.content).slice(0, 500)}`,
      })
    }
    const settle = async (result) => {
      if (result.isError) {
        state.results.push({ ok: false, text: textOf(result.content).slice(0, 2000) })
        return await failStep(result)
      }
      state.results.push({ ok: true, text: textOf(result.content).slice(0, 2000) })
      const step = state.steps[state.index]
      state.index++
      state.stage = step.awaitChild ? 'awaiting-child' : 'executing'
      await save()
      return running()
    }
    /** Only a step that awaits a child claims inputs; others stay queued for their own turn. A child that did not complete ends the plan honestly. */
    const absorbInputs = async () => {
      for (
        let input = await ctx.input.claim('next-step');
        input;
        input = await ctx.input.claim('next-step')
      ) {
        const notice = childNotice(input)
        if (!notice) {
          await ctx.events.emit('ignored-input', { id: input.id })
          continue
        }
        state.notices.push(notice)
        await ctx.events.emit('notice', notice)
        if (notice.status !== 'completed') {
          await save()
          return await finish('blocked', {
            code: 'PLAN_CHILD_NOT_COMPLETED',
            message: `Child ${notice.childKey} ended as ${notice.status}`,
          })
        }
        if (state.stage === 'awaiting-child') state.stage = 'executing'
      }
      return null
    }
    return {
      checkpoint: () => codec.encode(state),
      cancel() {},
      dispose() {},
      async step(signal) {
        try {
          if (state.stage === 'done') return await closeTurn()
          if (state.stage === 'input') {
            const input = await ctx.input.accept()
            if (!input) return { outcome: 'idle' }
            const notice = childNotice(input)
            if (notice) {
              // No plan is waiting for this child; record it and say nothing was done.
              await ctx.events.emit('notice', notice)
              state = { ...initial(), stage: 'done', turnId: input.turnId, endReason: 'completed' }
              await save()
              return await closeTurn()
            }
            state = { ...initial(), stage: 'planning', turnId: input.turnId, request: textOf(input.content) }
            await save()
            return running()
          }
          const view = await ctx.turn.view()
          if (signal.aborted || ctx.turn.cancelled()) return await finish('aborted')
          if (state.stage === 'planning') {
            const id = `plan:${state.turnId}:plan`
            await save({ invocationIds: [id] })
            const receipt = await ctx.effects.status(id)
            if (receipt.status === 'may-have-sent') return await unknownOutcome(id)
            let events
            if (receipt.status === 'responded') events = receipt.result
            else {
              const tools = view?.tools.map((tool) => tool.name) ?? []
              const request = await ctx.prepareRequest({
                invocationId: id,
                tools: [],
                system: `Plan the request as one JSON array of at most ${MAX_STEPS} steps: {"tool": string, "args": object, "awaitChild"?: true}. Available tools: ${tools.join(', ') || 'none'}. Reply with the JSON only.`,
                messages: [{ role: 'user', content: [{ type: 'text', text: state.request }] }],
              })
              events = await ctx.model.complete(request, signal)
            }
            if (events.some((event) => event.type === 'error'))
              return await finish('error', {
                code: 'PLAN_MODEL_FAILED',
                message: 'The planning request failed',
              })
            let steps
            try {
              steps = parsePlan(
                events.map((event) => (event.type === 'text_delta' ? event.delta : '')).join(''),
                view?.tools.map((tool) => tool.name) ?? [],
              )
            } catch (error) {
              return await finish('error', { code: 'PLAN_INVALID', message: error.message })
            }
            state.steps = steps
            // The stable key makes a replay after a crash reuse this question.
            state.handle = await ctx.decisions.request({
              key: `plan:${state.turnId}`,
              purpose: 'business.confirm',
              subject: { turnId: state.turnId, request: state.request, steps },
              prompt: `Run this ${steps.length}-step plan?`,
              options: ['approve', 'reject'],
              responseSchema: { type: 'null' },
            })
            state.stage = 'approving'
            await save()
            await ctx.events.emit('proposed', { steps })
            return { outcome: 'parked', phase: state.stage, reason: 'parked' }
          }
          if (state.stage === 'approving') {
            const snapshot = await ctx.decisions.get(state.handle)
            const waited =
              snapshot.result || snapshot.invalidation
                ? { status: 'resolved', snapshot }
                : await ctx.decisions.wait(state.handle, { signal })
            if (waited.status !== 'resolved')
              return { outcome: 'parked', phase: state.stage, reason: 'parked' }
            const answer = waited.snapshot
            if (answer.invalidation || answer.result?.reason !== 'answered')
              return await finish('blocked', {
                code: 'PLAN_APPROVAL_UNAVAILABLE',
                message: 'The original approval expired or was withdrawn',
              })
            const approved = answer.result.response.option === 'approve'
            state.endReason = approved ? null : 'blocked'
            if (approved) state.stage = 'executing'
            // Consume the answer once, with the checkpoint that acts on it.
            await save({ decisionRefs: [state.handle] })
            if (!approved)
              return await finish('blocked', {
                code: 'PLAN_REJECTED',
                message: 'The person rejected the plan',
              })
            return running()
          }
          if (state.stage === 'tool-parked') {
            const resumed = await ctx.input.resumeParked()
            if (resumed === 'blocked') return await finish('blocked')
            if (resumed !== 'opened') return { outcome: 'parked', phase: state.stage, reason: 'parked' }
            return await settle(await ctx.tools.resume(`plan:${state.turnId}:step:${state.index}`, signal))
          }
          if (state.stage === 'awaiting-child') {
            const absorbed = await absorbInputs()
            if (absorbed) return absorbed
            if (state.stage === 'executing') return running()
            await ctx.wait.park(signal)
            return running()
          }
          if (state.stage === 'executing') {
            if (state.index >= state.steps.length) {
              const lines = state.results.map(
                (result, i) => `${i + 1}. ${state.steps[i].tool}: ${result.text}`,
              )
              state.stage = 'done'
              state.endReason = 'completed'
              await ctx.events.assistant(
                { content: [{ type: 'text', text: lines.join('\n') }], stopReason: 'end_turn' },
                codec.encode(state),
              )
              return await closeTurn()
            }
            const id = `plan:${state.turnId}:step:${state.index}`
            const receipt = await ctx.effects.status(id)
            if (receipt.status === 'may-have-sent') return await unknownOutcome(id)
            if (receipt.status === 'responded') return await settle(receipt.result)
            // Save the park intent before dispatch: Core may close the turn before PARKED returns.
            await save({ invocationIds: [id] })
            const call = state.steps[state.index]
            try {
              return await settle(
                await ctx.tools.execute({ invocationId: id, name: call.tool, args: call.args }, signal),
              )
            } catch (error) {
              if (error?.code !== 'PARKED') throw error
              state.stage = 'tool-parked'
              await save({ invocationIds: [id] })
              return { outcome: 'parked', phase: state.stage, reason: 'parked' }
            }
          }
          throw new Error(`Invalid plan-execute stage ${state.stage}`)
        } catch (error) {
          if (signal.aborted) return await finish('aborted')
          if (error?.code === 'E_BUDGET')
            return { outcome: 'turn-ended', reason: error.detail?.reason ?? 'budget' }
          return await finish('error', { code: 'PLAN_FAILED', message: String(error) })
        }
      },
    }
  }
  return {
    id: ID,
    version: VERSION,
    controls: {},
    capabilities: ['model', 'tools', 'approval', 'checkpoint', 'park'],
    codec,
    create: (ctx) => driver(ctx),
    resume: (ctx, checkpoint) => driver(ctx, codec.decode(checkpoint)),
  }
}

export const plugin = {
  inject: ['providers'],
  apply(ctx) {
    ctx.providers.register(loopKind, createPlanExecuteLoop())
  },
}
