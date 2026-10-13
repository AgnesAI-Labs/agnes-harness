import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPluginTestHost, driveLoop, runModelAdapter } from '@agnes/host/author-testkit'
import { adapter, factory, model, modelId, route, toolPlugin } from '../dist/index.js'

const config = {
  routes: [{ route, api: adapter.id, baseUrl: model.baseUrl, models: [model], keyless: true }],
}
const request = {
  kind: 'inference',
  sessionKey: 'community-demo',
  slot: 'primary',
  route,
  model: modelId,
  contractId: null,
  derivedHash: '0'.repeat(64),
  system: 'Return only a JSON array of DAG nodes',
  tools: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Join the demo values' }] }],
}

/** The loop context of one turn: the real demo adapter and tools behind the public ports. */
async function fixture(finish) {
  const host = await createPluginTestHost(toolPlugin, { exportName: 'toolPlugin' })
  const instance = adapter.create(config)
  const events = [],
    batches = [],
    finishes = []
  let checkpoint,
    open = true
  const stream = (body, signal) =>
    instance.stream(body.route, body, {
      signal,
      toolNames: [],
      sessionKey: body.sessionKey,
      timeoutMs: { firstToken: 1000, total: 1000 },
    })
  const complete = async (body, signal) => {
    const result = []
    for await (const event of stream(body, signal)) result.push(event)
    return result
  }
  const context = {
    sessionKey: 'community-demo',
    lane: 'main',
    input: {
      accept: async () => (open ? { id: 'one', content: request.messages[0].content } : null),
      pending: () => open,
    },
    model: { complete, stream },
    tools: {
      execute: (call, signal) => host.invoke(call.name, call.args, signal),
      batch: async (calls, signal) => {
        batches.push(calls.map((call) => call.name))
        return Promise.all(calls.map((call) => host.invoke(call.name, call.args, signal)))
      },
    },
    events: {
      assistant: async (data, saved) => {
        events.push({ type: 'assistant/message', data })
        checkpoint = structuredClone(saved)
      },
      emit: async (type, data) => {
        events.push({ type, data })
      },
      // Core answers a finish with the outcome the turn ended with; the driver has to return it.
      finish: async (reason) => {
        finishes.push(reason)
        const outcome = finish(reason)
        open = outcome.outcome === 'running'
        return outcome
      },
    },
    checkpoints: {
      read: () => checkpoint ?? null,
      write: async (next) => {
        checkpoint = structuredClone(next)
      },
    },
    wait: {
      park: async () => {
        throw new Error('Unexpected park')
      },
      wake() {},
    },
  }
  return {
    context,
    instance,
    host,
    complete,
    events,
    batches,
    finishes,
    checkpoint: () => checkpoint,
    async dispose() {
      await instance.dispose()
      await host.dispose()
    },
  }
}

test('DAG uses the real demo adapter to plan, batches tools and joins before summarizing', async () => {
  const f = await fixture((reason) => ({ outcome: 'turn-ended', phase: 'terminal', reason }))
  try {
    // driveLoop schedules by the same rule as the Host: a step without a valid outcome fails here.
    const run = await driveLoop(factory, { context: f.context, maxSteps: 10 })
    assert.deepEqual(
      run.steps.map((step) => step.outcome),
      ['running', 'running', 'running', 'running', 'running', 'turn-ended'],
    )
    assert.deepEqual(run.steps.at(-1), { outcome: 'turn-ended', phase: 'terminal', reason: 'completed' })
    assert.deepEqual(f.finishes, ['completed'])
    assert.deepEqual(f.batches, [['community_echo', 'community_echo'], ['community_join']])
    assert.deepEqual(f.events.at(-1), {
      type: 'assistant/message',
      data: { content: [{ type: 'text', text: 'left + right' }], stopReason: 'end_turn' },
    })
    assert.equal(f.checkpoint().state.stage, 'done')
    assert.equal(factory.id, 'community.dag')
    await f.instance.dispose()
    await assert.rejects(f.complete(request, new AbortController().signal))
  } finally {
    await f.dispose()
  }
  assert.equal(f.host.tools.size, 0)
})

test('DAG hands back a completion the stop gate parked, without running its tools again', async () => {
  const f = await fixture(() => ({ outcome: 'parked', phase: 'terminal', reason: 'parked' }))
  try {
    const run = await driveLoop(factory, { context: f.context, maxSteps: 10 })
    assert.deepEqual(run.steps.at(-1), { outcome: 'parked', phase: 'terminal', reason: 'parked' })
    assert.deepEqual(f.finishes, ['completed'])
    assert.deepEqual(f.batches, [['community_echo', 'community_echo'], ['community_join']])
  } finally {
    await f.dispose()
  }
})

test('adapter exposes configured models and refuses cancellation and unsupported selections', async () => {
  const result = await runModelAdapter(adapter, { config, route, request })
  assert.equal(result.models[0].id, modelId)
  assert.equal(JSON.parse(result.events[0].delta).length, 3)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(runModelAdapter(adapter, { config, route, request, signal: aborted.signal }))
  await assert.rejects(
    runModelAdapter(adapter, { config, route, request: { ...request, model: 'missing' } }),
    /Unknown demo route\/model/,
  )
})
