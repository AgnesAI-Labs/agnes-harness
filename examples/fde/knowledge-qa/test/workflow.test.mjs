import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main, tools } from '../index.mjs'
import { result } from '../runtime.mjs'
import { runWorkflow } from './harness.mjs'

test('local document QA preserves exact evidence and citations; no source refuses without inference', async () => {
  const run = await runWorkflow(main, { input: 'What is the refund window?' })
  assert.equal(run.finished[0], 'completed')
  assert.ok(run.skills.includes('knowledge-qa'))
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
    config: { workflow: { retrieverTool: retriever.name } },
    extraTools: [retriever],
  }
  const run = await runWorkflow(main, options)
  assert.deepEqual(run.checkpoint.state.data.answer.citations, ['customer/warranty.md#p1'])
  const broken = await runWorkflow(main, {
    ...options,
    extraTools: [{ ...retriever, execute: async () => result({ sources: [{ quote: 'uncited' }] }) }],
  })
  assert.equal(broken.finished[0], 'error')
  assert.equal(broken.checkpoint.state.data.answer, undefined)
})
