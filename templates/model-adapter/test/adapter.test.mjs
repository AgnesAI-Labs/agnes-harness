import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runModelAdapter } from '@agnes/host/author-testkit'
import { adapter } from '../dist/index.js'

test('catalog and deterministic stream, including cancellation', async () => {
  const model = {
    id: 'demo-model',
    name: 'Demo',
    route: 'demo',
    api: adapter.api,
    baseUrl: 'https://demo.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    toolCallFormats: ['native'],
    thinkingReplay: 'native',
    contract_id: null,
  }
  const request = {
    kind: 'inference',
    sessionKey: 'adapter-test',
    slot: 'primary',
    route: 'demo',
    model: model.id,
    contractId: null,
    derivedHash: '0'.repeat(64),
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
  }
  const config = {
    routes: [{ route: 'demo', api: adapter.api, baseUrl: model.baseUrl, models: [model], keyless: true }],
  }
  const result = await runModelAdapter(adapter, {
    config,
    route: 'demo',
    request: request,
  })
  assert.equal(result.models[0].id, 'demo-model')
  assert.equal(result.events[0].type, 'text_delta')
  assert.deepEqual(result.events.at(-1), { type: 'done', reason: 'stop' })
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(runModelAdapter(adapter, { config, route: 'demo', request, signal: cancelled.signal }))
})
