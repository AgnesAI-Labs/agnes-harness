import assert from 'node:assert/strict'
import { driveLoop } from '@agnes/plugin-runtime/testkit'
import { test } from 'vitest'
import { factory, main } from '../index.mjs'
import { createFixture } from '../mcp/fixture.mjs'
import { runWorkflow } from './harness.mjs'

const context = {}
test('device-inspection completes through the public loop and tool ports', async () => {
  const run = await runWorkflow(main, { context })
  assert.equal(run.finished[0], 'completed')
  assert.ok(run.checkpoint.state.data.deliverables.some((file) => file.ref.size > 0))
  assert.ok(run.calls.some((call) => call.name === 'present'))
  assert.ok(run.calls.some((call) => call.name === 'ask_user_question'))

  assert.ok(run.skills.includes('device-inspection'))
  const data = run.checkpoint.state.data
  assert.equal(data.anomaly, true)
  assert.equal(data.verification.verified, true)
  assert.equal(data.verification.dry_run, true)
  assert.equal(data.verification.temperatureC, 38)
  const fixture = createFixture(),
    read = () => fixture.call('status', {}).structuredContent
  const dry = { key: 'preview', expectedVersion: 1, targetC: 25 }
  assert.equal(fixture.call('cool', dry).structuredContent.dry_run, true)
  assert.equal(read().temperatureC, 38)
  assert.deepEqual(fixture.call('cool', dry), fixture.call('receipt', { key: 'preview' }))
  assert.throws(() => fixture.call('cool', { ...dry, targetC: 24 }), /different action/)
  assert.throws(() => fixture.call('cool', { ...dry, key: 'bad', targetC: 31 }), /constrained action/)
  assert.throws(() => fixture.call('cool', { ...dry, key: 'stale', expectedVersion: 0 }), /Stale/)
  fixture.call('cool', { ...dry, key: 'sim-effect', dry_run: false })
  assert.equal(read().temperatureC, 25)
  assert.equal(read().version, 2)
  assert.throws(() => fixture.call('receipt', { key: 'missing' }), /Outcome unknown/)
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
