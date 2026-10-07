import assert from 'node:assert/strict'
import { test } from 'vitest'
import { main, tools } from '../index.mjs'
import { result } from '../runtime.mjs'
import { runWorkflow } from './harness.mjs'

test('local document QA preserves exact evidence and citations; no source refuses without inference', async () => {
  const run = await runWorkflow(main, { input: 'What is the refund window?' })
  assert.equal(run.finished[0], 'completed')
  assert.ok(run.checkpoint.state.data.deliverables.some((file) => file.ref.size > 0))
  assert.ok(run.calls.some((call) => call.name === 'present'))

  assert.ok(run.skills.includes('knowledge-qa'))
  assert.equal(
    run.calls.some((call) => call.name === 'web_search'),
    false,
  )
  assert.match(run.checkpoint.state.data.answer.markdown, /within 30 days/)
  assert.deepEqual(run.checkpoint.state.data.answer.citations, ['fixtures/docs/refunds.md#paragraph-2'])
  const refused = await runWorkflow(main, { input: 'Orbital telemetry specifications?', replies: [] })
  assert.equal(refused.checkpoint.state.data.answer.status, 'refused')
  assert.deepEqual(refused.checkpoint.state.data.answer.citations, [])
  assert.equal(refused.requests.length, 0)
})
test('a public retriever replacement supplies citations, and malformed sources fail closed', async () => {
  const retriever = {
    ...tools[0],
    name: 'customer_retrieve',
    execute: async () =>
      result({
        sources: [
          { quote: 'Fixture customer warranty lasts one year.', citation: 'customer/warranty.md#p1' },
        ],
      }),
  }
  const options = {
    input: 'Warranty?',
    config: { workflow: { retrieverTool: retriever.name, publicQuery: 'public warranty handbook' } },
    extraTools: [retriever],
  }
  const run = await runWorkflow(main, options)
  assert.deepEqual(run.checkpoint.state.data.answer.citations, ['customer/warranty.md#p1'])
  assert.deepEqual(run.calls.find((call) => call.name === 'web_search').args, {
    queries: ['public warranty handbook'],
  })
  const unavailable = await runWorkflow(main, { ...options, searchUnavailable: true })
  assert.equal(unavailable.checkpoint.state.data.publicResearch.available, false)
  assert.equal(unavailable.checkpoint.state.data.answer.status, 'sourced')
  const broken = await runWorkflow(main, {
    ...options,
    extraTools: [{ ...retriever, execute: async () => result({ sources: [{ quote: 'uncited' }] }) }],
  })
  assert.equal(broken.finished[0], 'error')
  assert.equal(broken.checkpoint.state.data.answer, undefined)
})
