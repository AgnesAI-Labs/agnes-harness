import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeModel, fakeRequest } from '@agnes/ai/testkit'
import { runModelAdapter } from '@agnes/plugin-runtime/testkit'
import { adapter } from '../dist/index.js'

test('catalog and deterministic stream, including cancellation', async () => {
  const model = fakeModel({ id: 'demo-model', route: 'demo', api: adapter.api })
  const config = {
    routes: [{ route: 'demo', api: adapter.api, baseUrl: model.baseUrl, models: [model], keyless: true }],
  }
  const result = await runModelAdapter(adapter, {
    config,
    route: 'demo',
    request: fakeRequest({ route: 'demo', model: model.id }),
  })
  assert.equal(result.models[0].id, 'demo-model')
  assert.equal(result.events[0].type, 'text_delta')
  assert.deepEqual(result.events.at(-1), { type: 'done', reason: 'stop' })
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(
    runModelAdapter(adapter, { config, route: 'demo', request: fakeRequest(), signal: cancelled.signal }),
  )
})
