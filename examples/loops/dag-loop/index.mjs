import { loopCheckpointCodec, registerLoopPlugin } from '@agnes/extension-api'
import { plannerInstructions, plannerTrace } from './planner.mjs'

const SOURCE = '@agnes-example/dag-loop'
const ID = 'example.dag'
const VERSION = '1.0.0'

/** Validate a bounded DAG before asking Host to execute any tool. */
function plan(value) {
  if (!Array.isArray(value) || value.length > 64) throw new Error('DAG plan must contain at most 64 nodes')
  const nodes = value.map((node) => {
    if (
      !node ||
      typeof node.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(node.id) ||
      ['__proto__', 'constructor', 'prototype'].includes(node.id) ||
      typeof node.tool !== 'string' ||
      !Array.isArray(node.after) ||
      node.after.some((id) => typeof id !== 'string') ||
      node.args === undefined
    )
      throw new Error('DAG node requires id, tool, after and JSON args')
    return { id: node.id, tool: node.tool, after: [...node.after], args: structuredClone(node.args) }
  })
  const ids = new Set(nodes.map((node) => node.id))
  if (ids.size !== nodes.length || nodes.some((node) => node.after.some((id) => !ids.has(id))))
    throw new Error('DAG has duplicate nodes or unknown dependencies')
  const visited = new Set()
  while (visited.size < nodes.length) {
    const ready = nodes.filter((node) => !visited.has(node.id) && node.after.every((id) => visited.has(id)))
    if (!ready.length) throw new Error('DAG contains a cycle')
    for (const node of ready) visited.add(node.id)
  }
  return nodes
}

/** Accept a plan-first reply, never search arbitrary prose for executable instructions. */
function modelPlan(reply) {
  const text = reply.trim()
  const fence = /^```(?:json)?\s*\n/.exec(text)
  const body = fence ? text.slice(fence[0].length) : text
  if (!body.startsWith('[')) throw new Error('DAG model plan must begin with a JSON array')
  let depth = 0,
    quoted = false,
    escaped = false
  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '[') depth++
    else if (char === ']' && --depth === 0) {
      let tail = body.slice(i + 1).trim()
      if (fence) {
        if (!tail.startsWith('```')) throw new Error('DAG model plan has an unclosed JSON fence')
        tail = tail.slice(3).trim()
      }
      if (/^[[\]{}]/.test(tail) || tail.startsWith('```'))
        throw new Error('DAG model reply contains ambiguous plans')
      return plan(JSON.parse(body.slice(0, i + 1)))
    }
  }
  throw new Error('DAG model plan has an incomplete JSON array')
}

export const codec = loopCheckpointCodec(1, (value) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !['input', 'plan', 'tools', 'summary', 'done'].includes(value.stage) ||
    typeof value.static !== 'boolean' ||
    !Array.isArray(value.inFlight) ||
    !value.results ||
    typeof value.results !== 'object' ||
    Array.isArray(value.results) ||
    (value.input !== null && !Array.isArray(value.input)) ||
    (value.inputId !== null && typeof value.inputId !== 'string') ||
    (value.planAttempt !== undefined && ![0, 1].includes(value.planAttempt)) ||
    (value.planError !== undefined && value.planError !== null && typeof value.planError !== 'string')
  )
    throw new Error('Invalid DAG checkpoint')
  if (value.nodes !== null) plan(value.nodes)
  return value
})

async function complete(ctx, state, system, content, signal) {
  const events = await ctx.model.complete(
    await ctx.prepareRequest({
      system,
      messages: [{ role: 'user', content }],
      tools: [],
      invocationId:
        'dag:' +
        state.inputId +
        ':' +
        state.stage +
        (state.stage === 'plan' && state.planAttempt === 1 ? ':repair' : ''),
    }),
    signal,
  )
  if (events.some((event) => event.type === 'error')) throw new Error('DAG model request failed')
  return events
    .filter((event) => event.type === 'text_delta')
    .map((event) => event.delta)
    .join('')
}

// A join's args can contain { "$result": "node-id" } to consume an ancestor's output.
function argumentsFor(value, results, allowed) {
  if (Array.isArray(value)) return value.map((item) => argumentsFor(item, results, allowed))
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && typeof value.$result === 'string') {
      if (!allowed.has(value.$result) || !Object.hasOwn(results, value.$result))
        throw new Error('DAG result reference must name a completed dependency')
      return structuredClone(results[value.$result])
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, argumentsFor(item, results, allowed)]),
    )
  }
  return value
}

/** @param {import('./index.mjs').DagConfig} config */
export function createDagLoop(config = {}) {
  const staticPlan = config.plan === undefined ? null : plan(config.plan)
  const initial = () => ({
    stage: 'input',
    input: null,
    inputId: null,
    nodes: staticPlan,
    static: staticPlan !== null,
    results: {},
    inFlight: [],
    planAttempt: 0,
    planError: null,
  })
  function driver(ctx, saved = initial()) {
    let state = structuredClone(saved)
    let cancelled = false
    let disposed = false
    const save = () => ctx.checkpoints.write(codec.encode(state))
    return {
      checkpoint: () => codec.encode(state),
      cancel() {
        cancelled = true
      },
      dispose() {
        disposed = true
      },
      async step(signal) {
        if (disposed) throw new Error('DAG driver is disposed')
        if (cancelled || signal.aborted)
          return { outcome: 'turn-ended', phase: 'cancelled', reason: 'aborted' }
        // accept() rehydrates a recovered turn as well as claiming a fresh input.
        const input = await ctx.input.claim('next-turn')
        if (!input) return { outcome: 'idle', phase: 'idle' }
        if (state.stage !== 'input' && state.inputId !== null && input.id && input.id !== state.inputId)
          state = initial()
        if (state.stage === 'done') {
          if (input.id && input.id === state.inputId) {
            await ctx.events.finish('completed')
            return { outcome: 'turn-ended', phase: 'done', reason: 'completed' }
          }
          state = initial()
        }
        if (state.stage === 'input') {
          state.input = [...input.content]
          state.inputId = input.id ?? null
          state.stage = state.nodes === null ? 'plan' : 'tools'
          await save()
          return { outcome: 'running', phase: state.stage }
        }
        if (state.stage === 'plan') {
          const executorTools = (await ctx.turn.view())?.tools ?? []
          const text = await complete(
            ctx,
            state,
            plannerInstructions(executorTools, state.planError ?? undefined),
            state.input,
            signal,
          )
          let parseError
          try {
            state.nodes = modelPlan(text)
          } catch (error) {
            parseError = error instanceof Error ? error.message : 'Invalid DAG plan'
          }
          await ctx.events.emit('x/dag/planner', {
            attempt: (state.planAttempt ?? 0) + 1,
            reply: plannerTrace(text),
            truncated: text.length > 16_384,
            error: parseError === undefined ? null : plannerTrace(parseError),
          })
          if (parseError !== undefined) {
            if ((state.planAttempt ?? 0) >= 1) throw new Error(parseError)
            state.planAttempt = 1
            state.planError = plannerTrace(parseError)
            await save()
            return { outcome: 'running', phase: 'plan-repair' }
          }
          state.stage = 'tools'
          await save()
          return { outcome: 'running', phase: 'tools' }
        }
        if (state.stage === 'tools') {
          for (const id of state.inFlight) {
            const receipt = await ctx.effects.status('dag:' + state.inputId + ':tool:' + id)
            if (receipt.status === 'may-have-sent')
              throw new Error('DAG tool outcome is uncertain; reconcile invocation ' + receipt.invocationId)
            if (receipt.status === 'responded') {
              if (Array.isArray(receipt.result)) throw new Error('DAG expected a tool receipt')
              state.results[id] = {
                content: receipt.result.content,
                isError: receipt.result.isError ?? false,
              }
            }
          }
          if (state.inFlight.length) {
            state.inFlight = []
            await save()
          }

          const ready = state.nodes.filter(
            (node) =>
              !Object.hasOwn(state.results, node.id) &&
              node.after.every((id) => Object.hasOwn(state.results, id)),
          )
          if (ready.length) {
            const calls = ready.map((node) => ({
              invocationId: 'dag:' + state.inputId + ':tool:' + node.id,
              name: node.tool,
              args: argumentsFor(node.args, state.results, new Set(node.after)),
            }))
            state.inFlight = ready.map((node) => node.id)
            // Persist uncertainty BEFORE launching effects. Never blindly replay interrupted tools.
            await save()
            const outputs = await ctx.tools.batch(calls, signal)
            if (outputs.length !== ready.length)
              throw new Error('DAG batch returned the wrong number of results')
            for (let i = 0; i < ready.length; i++) {
              const output = outputs[i]
              state.results[ready[i].id] = { content: output.content, isError: output.isError ?? false }
            }
            state.inFlight = []
            await save()
            if (outputs.some((output) => output.isError)) {
              await ctx.events.finish('error', { code: 'DAG_TOOL_FAILED', message: 'DAG tool failed' })
              return { outcome: 'turn-ended', phase: 'failed', reason: 'error' }
            }
            return { outcome: 'running', phase: 'tools' }
          }
          state.stage = 'summary'
          await save()
          return { outcome: 'running', phase: 'summary' }
        }
        if (state.stage === 'summary') {
          if (!state.static) {
            const text = await complete(
              ctx,
              state,
              'Summarize the supplied DAG tool result receipts for the user. The Host executor has already run these tools; no tools are needed in this summary request.',
              [...state.input, { type: 'text', text: JSON.stringify(state.results) }],
              signal,
            )
            state.stage = 'done'
            await ctx.events.assistant(
              { content: [{ type: 'text', text }], stopReason: 'end_turn' },
              codec.encode(state),
            )
          } else {
            await ctx.events.emit('x/dag/result', { results: state.results })
            state.stage = 'done'
            await save()
          }
          await ctx.events.finish('completed')
          return { outcome: 'turn-ended', phase: 'done', reason: 'completed' }
        }
        throw new Error('Invalid DAG stage')
      },
    }
  }
  return {
    id: ID,
    version: VERSION,
    capabilities: ['tools', 'parallel', 'checkpoint', 'model'],
    codec,
    create: (ctx) => driver(ctx),
    resume(ctx, checkpoint) {
      const state = codec.decode(checkpoint)
      return driver(ctx, state)
    },
  }
}

export const plugin = {
  inject: ['loops'],
  apply(ctx, config) {
    registerLoopPlugin(ctx, SOURCE, createDagLoop(config))
  },
}
