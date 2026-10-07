import { readFileSync } from 'node:fs'
import { loopCheckpointCodec, registerLoopPlugin, registerToolPolicyPlugin } from '@agnes/extension-api'
import { defineAgnesPlugin, defineLoop, defineTool, toolError } from '@agnes/plugin-runtime'

export const readMeta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe',
  costHint: {},
  deferLoading: false,
  requiresApproval: 'never',
}
export const writeMeta = {
  ...readMeta,
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  replay: 'never',
  requiresApproval: 'always',
}
export const result = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structured: data,
})
export function value(output) {
  if (output.isError)
    throw new Error(
      output.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    )
  // The MCP bridge exposes text; ordinary tools additionally expose structured output.
  return (
    output.structured ??
    JSON.parse(
      output.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    )
  )
}
export function tool(name, description, parameters, execute, meta = readMeta) {
  return defineTool({
    name,
    description,
    parameters,
    meta,
    async execute(args, ctx) {
      ctx.signal.throwIfAborted()
      try {
        return result(await execute(args, ctx))
      } catch (error) {
        ctx.signal.throwIfAborted()
        return toolError(error.message)
      }
    },
  })
}
export async function modelText(ctx, system, data, signal) {
  const request = await ctx.prepareRequest({
    slot: 'primary',
    system: readFileSync(new URL('./skills/playbook/SKILL.md', import.meta.url), 'utf8') + '\n\n' + system,
    tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(data) }] }],
  })
  const events = await ctx.model.complete(request, signal)
  if (events.some((e) => e.type === 'error')) throw new Error('Business model request failed')
  const text = events
    .filter((e) => e.type === 'text_delta')
    .map((e) => e.delta)
    .join('')
  if (!text.trim()) throw new Error('Business model returned no text')
  return text
}

/** Every bundle ships this small author-side helper so its tarball has no sibling imports. */
export function makeBundle({ name, tools, stages, readOnly = false, validateSettings = () => ({}) }) {
  const source = `@agnes-fde/${name}`
  const policy = {
    id: `fde.${name}`,
    version: '1.0.0',
    decide(input, signal) {
      signal.throwIfAborted()
      if (readOnly && (!input.policy.isReadOnly || input.policy.isDestructive))
        return { effect: 'deny', reason: 'This workflow permits reads only' }
      return input.policy.requiresApproval === 'always' ||
        input.policy.isDestructive ||
        !input.policy.isReadOnly
        ? { effect: 'ask', reason: 'A person must confirm this business action' }
        : { effect: 'allow', reason: 'Read-only business evidence' }
    },
  }
  function createFactory(settings = {}) {
    settings = validateSettings(settings)
    const codec = loopCheckpointCodec(1, (state) => {
      if (
        !state ||
        state.workflow !== name ||
        !Number.isInteger(state.index) ||
        state.index < 0 ||
        state.index > stages.length ||
        !state.settings ||
        typeof state.settings !== 'object' ||
        !state.data ||
        typeof state.data !== 'object' ||
        typeof state.input !== 'string' ||
        typeof state.pending !== 'boolean'
      )
        throw new Error('Invalid business checkpoint')
      validateSettings(state.settings)
      return state
    })
    const initial = () => ({
      workflow: name,
      index: 0,
      data: {},
      input: '',
      settings,
      pending: false,
    })
    function driver(ctx, state) {
      state = structuredClone(state)
      let closed = false
      let ended = false
      return {
        checkpoint: () => codec.encode(state),
        cancel() {
          closed = true
        },
        dispose() {
          closed = true
        },
        async step(signal) {
          signal.throwIfAborted()
          if (closed) return { outcome: 'turn-ended', phase: 'cancelled', reason: 'aborted' }
          if (ended) {
            if (!ctx.input.pending()) return { outcome: 'idle', phase: 'idle' }
            state = initial()
            ended = false
          }
          if (!state.input) {
            const input = await ctx.input.accept()
            if (!input) return { outcome: 'idle', phase: 'idle' }
            state.input = input.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
            if (!state.input.trim()) throw new Error('This fixture workflow needs text input')
            await ctx.checkpoints.write(codec.encode(state))
          }
          if (state.pending) {
            await ctx.events.finish('blocked', {
              code: 'FDE_OUTCOME_UNKNOWN',
              message: 'Inspect evidence before starting a new run; do not replay a pending stage.',
            })
            return { outcome: 'turn-ended', phase: 'unknown', reason: 'blocked' }
          }
          if (state.index === stages.length) {
            await ctx.events.finish('completed')
            ended = true
            return { outcome: 'turn-ended', phase: 'done', reason: 'completed' }
          }
          const stage = stages[state.index]
          // Record uncertainty before any model/tool effect. Resume never silently repeats a send.
          state.pending = true
          await ctx.checkpoints.write(codec.encode(state))
          try {
            const data = await stage.run(ctx, state, signal)
            signal.throwIfAborted()
            state.data = { ...state.data, ...data }
            state.index++
            state.pending = false
            await ctx.checkpoints.write(codec.encode(state))
            await ctx.events.emit('assistant/message', {
              content: [{ type: 'text', text: `${stage.name}:\n${JSON.stringify(data, null, 2)}` }],
            })
            return { outcome: 'running', phase: stage.name }
          } catch (error) {
            signal.throwIfAborted()
            await ctx.events.finish('error', { code: 'FDE_STAGE_FAILED', message: error.message })
            return { outcome: 'turn-ended', phase: 'failed', reason: 'error' }
          }
        },
      }
    }
    return defineLoop({
      id: `fde.${name}`,
      version: '1.0.0',
      capabilities: ['tools', 'model', 'checkpoint'],
      codec,
      create: (ctx) => driver(ctx, initial()),
      resume: (ctx, saved) => driver(ctx, codec.decode(saved)),
    })
  }
  const main = defineAgnesPlugin({
    inject: ['extension', 'loops', 'toolPolicies', 'skills'],
    apply(ctx, config = {}) {
      for (const definition of tools) {
        const off = ctx.extension().registerTool(definition)
        ctx.effect(() => off)
      }
      registerLoopPlugin(ctx, source, createFactory(config.workflow))
      registerToolPolicyPlugin(ctx, source, policy)
      const off = ctx.skills.register({
        name,
        description: `Business playbook for ${name}`,
        body: readFileSync(new URL('./skills/playbook/SKILL.md', import.meta.url), 'utf8'),
      })
      ctx.effect(() => off)
    },
  })
  return { main, factory: createFactory(), createFactory, policy }
}
