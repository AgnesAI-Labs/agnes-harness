import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPluginTestRegistration } from '@agnes/host/testkit'
import { createPluginTestHost, runModelAdapter } from '@agnes/plugin-runtime/testkit'
import { adapter, factory, model, modelId, route, toolPlugin } from '../dist/index.js'

const config = {
  routes: [{ route, api: adapter.api, baseUrl: model.baseUrl, models: [model], keyless: true }],
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

test('DAG uses the real demo adapter to plan, batches tools and joins before summarizing', async () => {
  const host = await createPluginTestHost(toolPlugin, { registration: createPluginTestRegistration() })
  const instance = adapter.create(config)
  const events = [],
    batches = []
  const signal = new AbortController().signal
  let checkpoint,
    finished = false
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
  const driver = factory.create({
    sessionKey: 'community-demo',
    lane: 'main',
    input: {
      accept: async () => (finished ? null : { id: 'one', content: request.messages[0].content }),
      pending: () => !finished,
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
      emit: async (type, data) => {
        events.push({ type, data })
      },
      finish: async (reason) => {
        assert.equal(reason, 'completed')
        finished = true
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
  })
  try {
    for (let i = 0; i < 10 && !finished; i++) await driver.step(signal)
    assert.equal(finished, true)
    assert.deepEqual(batches, [['community_echo', 'community_echo'], ['community_join']])
    assert.deepEqual(events.at(-1), {
      type: 'assistant/message',
      data: { content: [{ type: 'text', text: 'left + right' }], stopReason: 'end_turn' },
    })
    assert.equal(checkpoint.state.stage, 'done')
    assert.equal(factory.id, 'community.dag')
    await instance.dispose()
    await assert.rejects(complete(request, signal))
  } finally {
    await driver.dispose()
    await instance.dispose()
    await host.dispose()
  }
  assert.equal(host.tools.size, 0)
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
