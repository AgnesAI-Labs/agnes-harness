import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { loopCheckpointCodec, registerLoopPlugin, registerToolPolicyPlugin } from '@agnes/extension-api'
import {
  defineAgnesPlugin,
  defineLoop,
  defineTool,
  drainDeferredToolInvocations,
  toolError,
} from '@agnes/plugin-runtime'

/** Only a backend-linked successful collector receipt can continue a business review. */
async function submittedAnswers(ctx, input, surfaceId, signal) {
  if (input.kind !== 'follow_up' || input.trust !== 'untrusted') return undefined
  const prefix = 'Intelligent UI action result: '
  const content = input.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  if (!content.startsWith(prefix)) return undefined
  let receipt
  try {
    receipt = JSON.parse(content.slice(prefix.length))
  } catch {
    return undefined
  }
  if (
    receipt.status !== 'succeeded' ||
    receipt.surfaceId !== surfaceId ||
    typeof receipt.invocationId !== 'string'
  )
    return undefined
  const original = await ctx.deferredInvocations?.read(receipt.invocationId, signal)
  if (
    original?.state !== 'succeeded' ||
    original.resultSeq !== receipt.resultSeq ||
    original.invocation.source !== 'agnes/intelligent-ui' ||
    original.invocation.tool !== 'ui_submit' ||
    original.invocation.sessionKey !== ctx.sessionKey ||
    original.invocation.lane !== ctx.lane ||
    original.invocation.actor.id !== input.actor.id ||
    original.invocation.actor.org !== input.actor.org ||
    original.invocation.args?.surfaceId !== surfaceId
  )
    return undefined
  const answers = original.invocation.args.answers
  return answers && Object.keys(answers).length === 1 && ['Proceed', 'Cancel'].includes(answers.proceed)
    ? answers
    : undefined
}

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
export function text(output) {
  return output.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}
export function checked(output) {
  if (output.isError) throw new Error(text(output))
  return output
}
export function value(output) {
  checked(output)
  return output.structured ?? JSON.parse(text(output))
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
  const prose = events
    .filter((e) => e.type === 'text_delta')
    .map((e) => e.delta)
    .join('')
  if (!prose.trim()) throw new Error('Business model returned no text')
  return prose
}
export async function isDemo(ctx) {
  return (await ctx.turn.view())?.model.id === 'demo-model'
}

/** Publish generated files via official tools, never through a bespoke download renderer. */
async function publish(ctx, state, name, signal) {
  const data = state.data
  const markdown =
    data.exported?.markdown ??
    data.report?.markdown ??
    data.answer?.markdown ??
    `# ${name}\n\n\u0060\u0060\u0060json\n${JSON.stringify(data, null, 2)}\n\u0060\u0060\u0060\n`
  const documents = [{ name: 'report.md', content: markdown }]
  if (data.report?.html) documents.push({ name: 'report.html', content: data.report.html })
  const files = []
  for (const document of documents) {
    const path = `fde-output/${name}/${state.outputKey}/${state.index}-${document.name}`
    // Existing output must be observed; write itself enforces absence, permissions and stale versions.
    await ctx.tools.execute({ name: 'read', args: { path } }, signal)
    checked(await ctx.tools.execute({ name: 'write', args: { path, content: document.content } }, signal))
    files.push({
      path,
      name: document.name,
      description: `${name}: ${state.index === state.stageCount - 1 ? 'final' : 'review draft'}`,
    })
  }
  return (
    checked(await ctx.tools.execute({ name: 'present', args: { files } }, signal)).details?.deliverables ?? []
  )
}

/** Included in every tarball; official tools are supplied by the installed standard preset. */
export function makeBundle({ name, tools, stages, readOnly = false, validateSettings = () => ({}) }) {
  const source = `@agnes-fde/${name}`
  const outputPath = new RegExp(`^fde-output/${name}/[a-f0-9]{64}/[0-9]+-report\\.(md|html)$`)
  const policy = {
    id: `fde.${name}`,
    version: '4.0.0',
    decide(input, signal) {
      signal.throwIfAborted()
      if (['ui_render', 'ui_update', 'ui_close', 'ui_submit'].includes(input.call?.name))
        return { effect: 'allow', reason: 'Session presentation and authenticated answer collection only' }
      if (input.call?.name === 'exit_plan_mode')
        return { effect: 'ask', reason: 'Approve the workflow plan through the official ticket' }
      if (input.call?.name === 'write' && outputPath.test(input.call.args?.path ?? ''))
        return {
          effect: 'allow',
          reason: 'Generated report output only; official write enforces observation',
        }
      if (readOnly && (!input.policy.isReadOnly || input.policy.isDestructive))
        return { effect: 'deny', reason: 'Business evidence is read-only' }
      return input.policy.requiresApproval === 'always' ||
        input.policy.isDestructive ||
        !input.policy.isReadOnly
        ? { effect: 'ask', reason: 'Business choice does not replace tool authorization' }
        : { effect: 'allow', reason: 'Read-only business evidence' }
    },
  }
  const plan =
    '# ' +
    name +
    ' workflow plan\n\n' +
    stages.map((stage, i) => i + 1 + '. ' + stage.name).join('\n') +
    '\n\nPresent generated reports. Keep source evidence read-only where configured. Business actions require a separate Proceed/Cancel answer and backend tool permission; unknown effects are never replayed.'
  const workflow = [
    {
      name: 'approve-plan',
      approval: true,
      async run(ctx, state, signal) {
        const active = (await ctx.turn.view())?.prompt.sections.some((section) => section.id === 'plan-mode')
        if (!active && !state.approvalCall) return { plan: { required: false } }
        checked(await ctx.tools.execute({ name: 'exit_plan_mode', args: { plan } }, signal))
        return { plan: { required: true, approved: true } }
      },
    },
    ...stages,
    {
      name: 'present-deliverables',
      async run(ctx, state, signal) {
        return { deliverables: await publish(ctx, state, name, signal) }
      },
    },
  ]
  function createFactory(settings = {}) {
    settings = validateSettings(settings)
    const codec = loopCheckpointCodec(4, (state) => {
      if (
        !state ||
        state.workflow !== name ||
        !Number.isInteger(state.index) ||
        state.index < 0 ||
        state.index > workflow.length ||
        !state.data ||
        typeof state.data !== 'object' ||
        typeof state.input !== 'string' ||
        typeof state.pending !== 'boolean' ||
        typeof state.approvalWaiting !== 'boolean' ||
        (state.explanation !== null && typeof state.explanation !== 'string') ||
        (state.approvalCall !== null &&
          (typeof state.approvalCall?.invocationId !== 'string' ||
            typeof state.approvalCall?.name !== 'string' ||
            !state.approvalCall.args ||
            typeof state.approvalCall.args !== 'object')) ||
        (state.approvalWaiting && (!state.pending || !state.approvalCall)) ||
        !state.settings ||
        typeof state.settings !== 'object' ||
        !Number.isInteger(state.confirmed) ||
        state.confirmed < -1 ||
        state.confirmed >= workflow.length ||
        typeof state.outputKey !== 'string' ||
        (state.outputKey && !/^[a-f0-9]{64}$/.test(state.outputKey)) ||
        state.stageCount !== workflow.length
      )
        throw new Error('Invalid business checkpoint')
      if (
        state.waiting &&
        (typeof state.waiting.id !== 'string' ||
          !state.waiting.id ||
          state.waiting.questions?.length !== 1 ||
          state.waiting.questions[0].id !== 'proceed' ||
          typeof state.waiting.questions[0].question !== 'string' ||
          JSON.stringify(state.waiting.questions[0].options) !== JSON.stringify(['Proceed', 'Cancel']))
      )
        throw new Error('Invalid pending question')
      validateSettings(state.settings)
      return state
    })
    const initial = () => ({
      workflow: name,
      index: 0,
      stageCount: workflow.length,
      data: {},
      input: '',
      settings,
      pending: false,
      approvalWaiting: false,
      approvalCall: null,
      explanation: null,
      waiting: null,
      confirmed: -1,
      outputKey: '',
    })
    function driver(ctx, saved) {
      let state = structuredClone(saved),
        closed = false,
        ended = false
      const save = () => ctx.checkpoints.write(codec.encode(state))
      async function park() {
        await save()
        await ctx.events.finish('parked')
        return { outcome: 'parked', phase: 'waiting-for-answer', reason: 'parked' }
      }
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
          if (state.approvalWaiting) {
            const continuation = await ctx.input.resumeParked()
            if (continuation === 'waiting' || continuation === false)
              return { outcome: 'parked', phase: 'tool-approval', reason: 'parked' }
            if (continuation === 'blocked')
              return { outcome: 'turn-ended', phase: 'approval-blocked', reason: 'blocked' }
            try {
              await ctx.tools.resume(state.approvalCall.invocationId, signal)
            } catch (error) {
              signal.throwIfAborted()
              if (error.code === 'PARKED' || error.code === 'E_LANE_BUSY')
                return { outcome: 'parked', phase: 'tool-approval', reason: 'parked' }
              throw error
            }
            // Re-enter only this exact call: Core returns its bound receipt, never dispatches it twice.
            state.approvalWaiting = false
            state.pending = false
            await save()
          }
          if (state.pending) {
            if (!(await ctx.input.accept()))
              return { outcome: 'turn-ended', phase: 'unknown', reason: 'blocked' }
            await ctx.events.finish('blocked', {
              code: 'FDE_OUTCOME_UNKNOWN',
              message: 'Inspect evidence before starting a new run; do not replay a pending stage.',
            })
            return { outcome: 'turn-ended', phase: 'unknown', reason: 'blocked' }
          }
          if (state.waiting) {
            if (ctx.turn.continuation() === 'checkpoint') {
              const boundary = await ctx.turn.checkpoint(signal)
              if (boundary.outcome !== 'running') return boundary
            }
            const deferred = await drainDeferredToolInvocations(ctx, signal)
            if (deferred) return deferred
            if (ctx.turn.continuation() === 'tools') return await ctx.tools.drain(signal)
            if (!state.waiting.input) {
              if (ctx.turn.continuation()) await ctx.turn.endStep()
              const input = ctx.turn.continuation()
                ? await ctx.input.claim('next-step')
                : await ctx.input.accept()
              if (!input) return await park()
              state.waiting.input = input
              await save()
              if (ctx.turn.continuation() === 'checkpoint')
                return { outcome: 'running', phase: 'answer-input' }
            }
            const answers = await submittedAnswers(ctx, state.waiting.input, state.waiting.id, signal)
            delete state.waiting.input
            if (!answers) return await park()
            state.waiting = null
            if (answers.proceed !== 'Proceed') {
              // A cancelled workflow cannot be reopened at its action stage.
              state.pending = true
              await save()
              await ctx.events.finish('error', {
                code: 'FDE_CANCELLED',
                message: 'The person cancelled the business action',
              })
              return { outcome: 'turn-ended', phase: 'cancelled', reason: 'error' }
            }
            state.confirmed = state.index
            await save()
          }
          if (!state.input) {
            const input = await ctx.input.accept()
            if (!input) return { outcome: 'idle', phase: 'idle' }
            state.input = input.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
            if (!state.input.trim()) throw new Error('This fixture workflow needs text input')
            state.outputKey = createHash('sha256').update(`${ctx.sessionKey}\0${input.id}`).digest('hex')
            await save()
          }
          if (state.index === workflow.length) {
            await ctx.events.finish('completed')
            ended = true
            return { outcome: 'turn-ended', phase: 'done', reason: 'completed' }
          }
          const stage = workflow[state.index]
          state.pending = true
          await save()
          try {
            const question = stage.confirm?.(state)
            if (question && state.confirmed !== state.index) {
              state.data.draftDeliverables = await publish(ctx, state, name, signal)
              const questions = [{ id: 'proceed', question, options: ['Proceed', 'Cancel'] }]
              const output = checked(
                await ctx.tools.execute({ name: 'ask_user_question', args: { questions } }, signal),
              )
              // Never mistake the tool's waiting message for permission to execute an action.
              if (output.details?.status !== 'pending' || typeof output.details?.surfaceId !== 'string')
                throw new Error('Official question did not return a persisted pending request')
              state.waiting = { id: output.details.surfaceId, questions }
              state.pending = false
              return await park()
            }
            const needsApproval = stage.approval || (question && state.confirmed === state.index)
            const activePlan = (await ctx.turn.view())?.prompt.sections.some(
              (section) => section.id === 'plan-mode',
            )
            if (
              needsApproval &&
              (stage.name !== 'approve-plan' || activePlan || state.approvalCall) &&
              state.explanation === null
            ) {
              // A model response also supplies the original assistant edge for Core's ticket continuation.
              state.explanation = await modelText(
                ctx,
                'Briefly explain the next fixed workflow step without changing it. Plan approval does not authorize later business actions.',
                { stage: stage.name, plan },
                signal,
              )
              await save()
            }
            const stageCtx = needsApproval
              ? {
                  ...ctx,
                  tools: {
                    ...ctx.tools,
                    async execute(call, callSignal) {
                      const invocationId =
                        'fde:' +
                        state.outputKey +
                        ':' +
                        state.index +
                        ':' +
                        createHash('sha256').update(JSON.stringify(call)).digest('hex')
                      if (state.approvalCall && state.approvalCall.invocationId !== invocationId)
                        throw new Error('Approval receipt does not match the original call')
                      state.approvalCall = { ...call, invocationId }
                      await save()
                      return ctx.tools.execute(state.approvalCall, callSignal)
                    },
                  },
                }
              : ctx
            const data = await stage.run(stageCtx, state, signal)
            signal.throwIfAborted()
            state.data = { ...state.data, ...data }
            state.index++
            state.pending = false
            state.approvalCall = null
            state.explanation = null
            await save()
            await ctx.events.assistant(
              {
                content: [{ type: 'text', text: `${stage.name}:\n${JSON.stringify(data, null, 2)}` }],
                stopReason: 'end_turn',
              },
              codec.encode(state),
            )
            return { outcome: 'running', phase: stage.name }
          } catch (error) {
            signal.throwIfAborted()
            if (error.code === 'PARKED') {
              // Core already closed the turn. Never try to finish it a second time.
              state.approvalWaiting = state.approvalCall !== null
              await save()
              return { outcome: 'parked', phase: 'tool-approval', reason: 'parked' }
            }
            await ctx.events.finish('error', { code: 'FDE_STAGE_FAILED', message: error.message })
            return { outcome: 'turn-ended', phase: 'failed', reason: 'error' }
          }
        },
      }
    }
    return defineLoop({
      id: `fde.${name}`,
      version: '4.0.0',
      capabilities: ['tools', 'model', 'checkpoint', 'deferred-invocations'],
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
      registerToolPolicyPlugin(ctx, source, {
        ...policy,
        async decide(input, signal) {
          // Consume the shipped policy through its public registry, preserving /plan write/exec denial.
          const base = await ctx.toolPolicies.resolve('default').decide(input, signal)
          return base.effect === 'deny' ? base : policy.decide(input, signal)
        },
      })
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
