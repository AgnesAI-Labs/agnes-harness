import assert from 'node:assert/strict'
import { test } from 'vitest'
import { driveLoop } from '@agnes/plugin-runtime/testkit'
import { factory, main } from '../index.mjs'
import { createFixture } from '../mcp/fixture.mjs'
import { runWorkflow } from './harness.mjs'

const context = {}
test('crm-assistant completes through the public loop and tool ports', async () => {
  const run = await runWorkflow(main, { context })
  assert.equal(run.finished[0], 'completed')
  assert.ok(run.checkpoint.state.data.deliverables.some((file) => file.ref.size > 0))
  assert.ok(run.calls.some((call) => call.name === 'present'))
  assert.ok(run.calls.some((call) => call.name === 'ask_user_question'))

  assert.ok(run.skills.includes('crm-assistant'))
  const data = run.checkpoint.state.data
  assert.equal(data.account.health, 'at-risk')
  assert.equal(data.receipt.status, 'simulated-recorded')
  assert.match(data.receipt.text, /3 open tickets/)
  const fixture = createFixture(),
    args = { id: 'A-100', text: 'Follow up', key: 'note-1' }
  assert.deepEqual(fixture.call('note', args), fixture.call('note', args))
  assert.throws(() => fixture.call('note', { ...args, text: 'Different note' }), /different note/)
  assert.throws(() => fixture.call('lookup', { id: 'missing' }), /Unknown CRM account/)
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
