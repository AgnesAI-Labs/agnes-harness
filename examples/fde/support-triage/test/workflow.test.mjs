import assert from 'node:assert/strict'
import { test } from 'node:test'
import { driveLoop } from '@agnes/plugin-runtime/testkit'
import { factory, main } from '../index.mjs'
import { runWorkflow } from './harness.mjs'

const context = {}
test('support-triage completes through the public loop and tool ports', async () => {
  const run = await runWorkflow(main, { context })
  assert.equal(run.finished[0], 'completed')
  assert.ok(run.skills.includes('support-triage'))
  const data = run.checkpoint.state.data
  assert.equal(data.classification.priority, 'urgent')
  assert.equal(data.receipt.status, 'simulated-sent')
  assert.equal(data.receipt.draft, data.draft)
})
test('refusal and cancellation preserve workflow boundaries', async () => {
  const stop = new AbortController()
  stop.abort(new Error('Stopped'))
  await assert.rejects(driveLoop(factory, { signal: stop.signal }), /Stopped/)

  const denied = await runWorkflow(main, { approve: false, context })
  assert.equal(denied.finished[0], 'error')
  assert.equal(denied.checkpoint.state.data.receipt ?? denied.checkpoint.state.data.action, undefined)
  const resumed = await runWorkflow(main, { checkpoint: denied.checkpoint, context })
  assert.equal(resumed.finished[0], 'blocked')
})
