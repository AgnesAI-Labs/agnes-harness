import assert from 'node:assert/strict'
import { test } from 'node:test'
import { driveLoop } from '@agnes/plugin-runtime/testkit'
import { factory, main, parseCsv, policy } from '../index.mjs'
import { runWorkflow } from './harness.mjs'

const context = {}
test('data-report completes through the public loop and tool ports', async () => {
  const run = await runWorkflow(main, { context })
  assert.equal(run.finished[0], 'completed')
  assert.ok(run.skills.includes('data-report'))
  const data = run.checkpoint.state.data
  assert.equal(data.analysis.revenue, 45000)
  assert.equal(data.analysis.profit, 18000)
  assert.match(data.report.html, /<svg/)
  assert.throws(() => parseCsv('month,revenue,cost\n2026-01,NaN,1'), /Invalid CSV/)
  assert.throws(() => parseCsv('month,revenue,cost\n"2026-01",1,1'), /unquoted/)
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
