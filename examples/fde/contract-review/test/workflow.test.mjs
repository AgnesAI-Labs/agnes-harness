import assert from 'node:assert/strict'
import { driveLoop } from '@agnes/plugin-runtime/testkit'
import { test } from 'vitest'
import { factory, main, policy } from '../index.mjs'
import { runWorkflow } from './harness.mjs'

const context = {}
test('contract-review completes through the public loop and tool ports', async () => {
  const run = await runWorkflow(main, { context })
  assert.equal(run.finished[0], 'completed')
  const messages = run.events.filter((event) => event.type === 'assistant/message')
  assert.ok(messages.length > 0)
  assert.ok(messages.every((event) => event.data.stopReason === 'end_turn'))
  assert.ok(run.checkpoint.state.data.deliverables.some((file) => file.ref.size > 0))
  assert.ok(run.calls.some((call) => call.name === 'present'))

  assert.ok(run.skills.includes('contract-review'))
  const data = run.checkpoint.state.data
  assert.deepEqual(data.report.highRisk, ['C-2', 'C-3'])
  assert.match(data.report.markdown, /C-1: low/)
})
test('refusal and cancellation preserve workflow boundaries', async () => {
  const stop = new AbortController()
  stop.abort(new Error('Stopped'))
  await assert.rejects(driveLoop(factory, { signal: stop.signal }), /Stopped/)

  assert.equal(
    policy.decide(
      { policy: { isReadOnly: false, isDestructive: true, requiresApproval: 'always' } },
      new AbortController().signal,
    ).effect,
    'deny',
  )
  const stopped = new AbortController()
  stopped.abort()
  assert.throws(() => policy.decide({ policy: { isReadOnly: true } }, stopped.signal))
})
