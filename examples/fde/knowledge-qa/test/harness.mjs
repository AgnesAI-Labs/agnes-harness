import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { resolveToolCallPolicy } from '@agnes/extension-api'
import { createPluginTestHost, driveLoop } from '@agnes/host/author-testkit'
import { createSkillCandidateRegistry, createSkillCordisService } from '@agnes/resource-control-runtime'
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { readMeta, writeMeta } from '../runtime.mjs'

/** Synthetic authenticated action and its original successful queue receipt, for Loop tests. */
export function surfaceAnswerInput(surfaceId, answer) {
  const receipt = {
    surfaceId,
    commandId: 'fixture-answer',
    invocationId: 'fixture-invocation',
    status: 'succeeded',
    resultSeq: 3,
  }
  return {
    kind: 'follow_up',
    origin: 'system',
    trust: 'untrusted',
    commandId: 'ui-result:fixture-answer',
    content: [{ type: 'text', text: 'Intelligent UI action result: ' + JSON.stringify(receipt) }],
    fixtureAnswers: { proceed: answer },
  }
}

/** Script official public tool-port results; no copies of official runtime implementations. */
function officialFixtures({ searchUnavailable = false, planState } = {}) {
  const files = new Map(),
    observed = new Set(),
    calls = []
  const object = (fields) => Type.Object(fields, { additionalProperties: false })
  const definitions = new Map()
  const add = (name, parameters, execute, meta = readMeta) =>
    definitions.set(name, { name, parameters, execute, meta })
  const output = (data, details) => ({
    content: [{ type: 'text', text: data }],
    ...(details ? { details } : {}),
  })
  add(
    'exit_plan_mode',
    object({ plan: Type.String({ minLength: 1, maxLength: 100000 }) }),
    () => {
      planState.active = false
      return output('Plan approved. Plan mode is off; write and exec tools are available.')
    },
    { ...writeMeta, isDestructive: false, requiresApproval: 'never' },
  )
  add(
    'ask_user_question',
    object({
      questions: Type.Array(
        object({ id: Type.String(), question: Type.String(), options: Type.Array(Type.String()) }),
        { minItems: 1, maxItems: 4 },
      ),
    }),
    () => output('Waiting for your answer.', { surfaceId: `question-${calls.length}`, status: 'pending' }),
  )
  add('read', object({ path: Type.String() }), ({ path }) => {
    if (!files.has(path)) return { ...output('read failed: ENOENT'), isError: true }
    observed.add(path)
    return output(files.get(path))
  })
  add(
    'write',
    object({ path: Type.String(), content: Type.String() }),
    ({ path, content }) => {
      if (files.has(path) && !observed.has(path)) return { ...output('FS_NOT_OBSERVED'), isError: true }
      files.set(path, content)
      observed.add(path)
      return output('created report', { path })
    },
    writeMeta,
  )
  add(
    'present',
    object({
      files: Type.Array(object({ path: Type.String(), name: Type.String(), description: Type.String() }), {
        minItems: 1,
        maxItems: 16,
      }),
    }),
    ({ files: requested }) => {
      const deliverables = requested.map(({ path, name, description }) => {
        assert.ok(files.has(path), 'present needs an existing output file')
        const bytes = new TextEncoder().encode(files.get(path))
        return {
          name,
          description,
          ref: {
            sha256: createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
            mime: name.endsWith('.html') ? 'text/html' : 'text/markdown',
          },
        }
      })
      return {
        content: [
          { type: 'text', text: 'Presented fixture reports' },
          ...deliverables.map(({ ref }) => ({ type: 'ref', ref })),
        ],
        details: { deliverables },
      }
    },
  )
  add(
    'web_search',
    object({ queries: Type.Array(Type.String(), { minItems: 1, maxItems: 4 }) }),
    ({ queries }) =>
      searchUnavailable
        ? { ...output('WEB_SEARCH_UNAVAILABLE'), isError: true }
        : output(
            `[${queries[0]}] Public fixture handbook\nhttps://example.org/handbook\nPublic fixture context`,
          ),
  )
  add(
    'shell',
    object({ command: Type.String(), background: Type.Boolean(), timeoutMs: Type.Integer() }),
    () => output('background job fixture-job started', { jobId: 'fixture-job', status: 'running' }),
    writeMeta,
  )
  add('job_output', object({ jobId: Type.String(), waitMs: Type.Integer() }), () =>
    output('synthetic-service: degraded\n[completed; exit 0]', {
      jobId: 'fixture-job',
      status: 'completed',
      code: 0,
      truncated: false,
    }),
  )
  return { files, calls, definitions }
}

export async function runWorkflow(
  main,
  {
    approve = true,
    checkpoint,
    context = {},
    config,
    input = 'Run the synthetic workflow.',
    replies,
    extraTools = [],
    answer = 'Proceed',
    stopAtQuestion = false,
    receiptAvailable = true,
    searchUnavailable = false,
    planMode = false,
    approvePlan = true,
    parkTool = null,
    stopAtApproval = false,
    nativeApprove = true,
  } = {},
) {
  const planState = { active: planMode }
  const loops = new Map(),
    policies = new Map([
      [
        'default',
        {
          id: 'default',
          decide(input) {
            if (planState.active && input.call.name !== 'exit_plan_mode' && !input.policy.isReadOnly)
              return { effect: 'deny', reason: 'Plan mode blocks writes and exec' }
            return { effect: 'allow', reason: 'Scripted default policy' }
          },
        },
      ],
    ])
  const skills = createSkillCandidateRegistry({ barrier: { quiesce: async (_id, publish) => publish({}) } })
  const registry = (map) => ({
    resolve(id) {
      if (!map.has(id)) throw new Error('Missing public provider: ' + id)
      return map.get(id)
    },
    register(_source, provider) {
      map.set(provider.id, provider)
      return async () => {
        map.delete(provider.id)
      }
    },
  })
  const host = await createPluginTestHost(main, {
    context,
    config,
    services: {
      loops: registry(loops),
      toolPolicies: registry(policies),
      skills: createSkillCordisService(skills),
    },
  })
  const fixtures = officialFixtures({ searchUnavailable, planState })
  let parkedCall = null
  const nativeReceipts = new Map()
  try {
    for (const definition of extraTools) host.tools.set(definition.name, definition)
    const factory = [...loops.values()][0],
      policy = [...policies.values()].find((entry) => entry.id !== 'default')
    const execute = async (call, signal, continuation = false) => {
      fixtures.calls.push(structuredClone(call))
      const definition = host.tools.get(call.name) ?? fixtures.definitions.get(call.name)
      if (!definition) throw new Error('Unregistered tool: ' + call.name)
      assert.ok(Value.Check(definition.parameters, call.args), 'Invalid public tool arguments: ' + call.name)
      const decision = await policy.decide(
        { policy: resolveToolCallPolicy(definition, call.args), call },
        signal,
      )
      if (!continuation && call.name === parkTool) {
        parkedCall = structuredClone(call)
        throw Object.assign(new Error('PARKED'), { code: 'PARKED' })
      }
      const allowed = call.name === 'exit_plan_mode' ? approvePlan : approve
      if (
        decision.effect === 'deny' ||
        (decision.effect === 'ask' && !allowed) ||
        (continuation && !nativeApprove)
      )
        return { content: [{ type: 'text', text: 'Human refused the business action' }], isError: true }
      const result = host.tools.has(call.name)
        ? await host.invoke(call.name, call.args, signal)
        : await definition.execute(call.args)
      if (call.name === 'exit_plan_mode') turnView.prompt.sections = []
      return result
    }
    const turnView = {
      turnId: 1,
      step: 0,
      cancelled: false,
      history: [],
      tools: [],
      model: { slot: 'primary', id: 'demo-model', capabilities: null },
      prompt: {
        sections: planMode
          ? [{ id: 'plan-mode', order: 160, source: '@agnes/base', text: 'Plan mode is active.' }]
          : [],
        runtime: {},
      },
      budget: { maxSteps: null, stepsUsed: 0, creditsUsed: 0, perRequestCap: null, onExceed: 'deny' },
    }
    const requests = []
    const drive = async (saved, text) => {
      const decorate = (ctx) => ({
        ...ctx,
        deferredInvocations: {
          sessionKey: ctx.sessionKey,
          lane: ctx.lane,
          notify: async () => {},
          next: async () => null,
          read: async (id) =>
            receiptAvailable && typeof text === 'object' && text.fixtureAnswers && id === 'fixture-invocation'
              ? {
                  state: 'succeeded',
                  seq: 4,
                  resultSeq: 3,
                  invocation: {
                    id,
                    source: 'agnes/intelligent-ui',
                    sessionKey: ctx.sessionKey,
                    lane: ctx.lane,
                    actor: { id: 'test', org: 'test', role: 'owner', deptPath: [], attrs: {} },
                    tool: 'ui_submit',
                    args: {
                      surfaceId: JSON.parse(
                        text.content[0].text.slice('Intelligent UI action result: '.length),
                      ).surfaceId,
                      answers: text.fixtureAnswers,
                    },
                  },
                }
              : null,
        },
        input: {
          ...ctx.input,
          resumeParked: async () => (parkedCall ? 'opened' : 'waiting'),
        },
        tools: {
          ...ctx.tools,
          execute: (call, signal) =>
            nativeReceipts.has(call.invocationId)
              ? Promise.resolve(nativeReceipts.get(call.invocationId))
              : ctx.tools.execute(call, signal),
          resume: async (invocationId, signal) => {
            assert.equal(invocationId, parkedCall.invocationId)
            const result = await execute(parkedCall, signal, true)
            // Also exercise a tool/result-only recovered receipt without transient UI details.
            nativeReceipts.set(parkedCall.invocationId, {
              content: result.content,
              ...(result.isError ? { isError: true } : {}),
            })
            return nativeReceipts.get(invocationId)
          },
        },
      })
      const drivenFactory = {
        ...factory,
        create: (ctx) => factory.create(decorate(ctx)),
        resume: (ctx, checkpoint) => factory.resume(decorate(ctx), checkpoint),
      }
      const run = await driveLoop(drivenFactory, {
        until: 'idle',
        checkpoint: saved,
        turnView,
        inputs: saved?.state.approvalWaiting
          ? []
          : [typeof text === 'object' ? text : { content: [{ type: 'text', text }] }],
        replies:
          replies ??
          Array.from({ length: 3 }, () => [
            { type: 'text_delta', delta: 'Reviewed fixture evidence.' },
            { type: 'done', reason: 'stop' },
          ]),
        tools: { execute, batch: (calls, signal) => Promise.all(calls.map((call) => execute(call, signal))) },
      })
      requests.push(...run.requests)
      return run
    }
    let run = await drive(checkpoint, input)
    if (!stopAtApproval && run.checkpoint.state.approvalWaiting) run = await drive(run.checkpoint, input)
    if (!stopAtQuestion && run.checkpoint.state.waiting) {
      const waiting = run.checkpoint.state.waiting
      run = await drive(run.checkpoint, surfaceAnswerInput(waiting.id, answer))
    }
    if (!stopAtApproval && run.checkpoint.state.approvalWaiting) run = await drive(run.checkpoint, input)
    return {
      ...run,
      requests,
      calls: fixtures.calls,
      files: Object.fromEntries(fixtures.files),
      skills: skills
        .snapshot()
        .list()
        .map((skill) => skill.name),
    }
  } finally {
    await host.dispose()
  }
}
