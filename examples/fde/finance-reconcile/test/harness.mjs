import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { resolveToolCallPolicy } from '@agnes/extension-api'
import { createPluginTestRegistration } from '@agnes/host/testkit/plugin-registration'
import { createPluginTestHost, driveLoop } from '@agnes/plugin-runtime/testkit'
import { answerPrefix } from '@agnes/protocol'
import { createSkillCandidateRegistry, createSkillCordisService } from '@agnes/resource-control-runtime'
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { readMeta, writeMeta } from '../runtime.mjs'

/** Script official public tool-port results; no copies of official runtime implementations. */
function officialFixtures({ searchUnavailable = false } = {}) {
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
    'ask_user_question',
    object({
      questions: Type.Array(
        object({ id: Type.String(), question: Type.String(), options: Type.Array(Type.String()) }),
        { minItems: 1, maxItems: 4 },
      ),
    }),
    () => output('Waiting for your answer.', { questionId: `question-${calls.length}`, status: 'pending' }),
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
    searchUnavailable = false,
  } = {},
) {
  const loops = new Map(),
    policies = new Map()
  const skills = createSkillCandidateRegistry({ barrier: { quiesce: async (_id, publish) => publish({}) } })
  const registry = (map) => ({
    register(_source, provider) {
      map.set(provider.id, provider)
      return async () => {
        map.delete(provider.id)
      }
    },
  })
  const registration = createPluginTestRegistration()
  const host = await createPluginTestHost(main, {
    context,
    config,
    registration: {
      ...registration,
      install(root, origins) {
        registration.install(root, origins)
        root.provide('loops', registry(loops))
        root.provide('toolPolicies', registry(policies))
        root.provide('skills', createSkillCordisService(skills))
      },
    },
  })
  const fixtures = officialFixtures({ searchUnavailable })
  try {
    for (const definition of extraTools) host.tools.set(definition.name, definition)
    const factory = [...loops.values()][0],
      policy = [...policies.values()][0]
    const execute = async (call, signal) => {
      fixtures.calls.push(structuredClone(call))
      const definition = host.tools.get(call.name) ?? fixtures.definitions.get(call.name)
      if (!definition) throw new Error('Unregistered tool: ' + call.name)
      assert.ok(Value.Check(definition.parameters, call.args), 'Invalid public tool arguments: ' + call.name)
      const decision = policy.decide({ policy: resolveToolCallPolicy(definition, call.args), call }, signal)
      if (decision.effect === 'deny' || (decision.effect === 'ask' && !approve))
        return { content: [{ type: 'text', text: 'Human refused the business action' }], isError: true }
      return host.tools.has(call.name)
        ? host.invoke(call.name, call.args, signal)
        : definition.execute(call.args)
    }
    const turnView = {
      turnId: 1,
      step: 0,
      cancelled: false,
      history: [],
      tools: [],
      model: { slot: 'primary', id: 'demo-model', capabilities: null },
      prompt: { sections: [], runtime: {} },
      budget: { maxSteps: null, stepsUsed: 0, creditsUsed: 0, perRequestCap: null, onExceed: 'deny' },
    }
    const requests = []
    const drive = async (saved, text) => {
      const run = await driveLoop(factory, {
        until: 'idle',
        checkpoint: saved,
        turnView,
        inputs: [{ content: [{ type: 'text', text }] }],
        replies: replies ?? [
          [
            { type: 'text_delta', delta: 'Reviewed fixture evidence.' },
            { type: 'done', reason: 'stop' },
          ],
        ],
        tools: { execute, batch: (calls, signal) => Promise.all(calls.map((call) => execute(call, signal))) },
      })
      requests.push(...run.requests)
      return run
    }
    let run = await drive(checkpoint, input)
    if (!stopAtQuestion && run.checkpoint.state.waiting) {
      const waiting = run.checkpoint.state.waiting
      run = await drive(run.checkpoint, answerPrefix(waiting.id) + JSON.stringify({ proceed: answer }))
    }
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
