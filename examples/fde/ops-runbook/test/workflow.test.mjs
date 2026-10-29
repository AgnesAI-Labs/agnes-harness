import assert from 'node:assert/strict'
import { driveLoop } from '@agnes/host/author-testkit'
import { test } from 'vitest'
import { factory, main } from '../index.mjs'
import { runWorkflow } from './harness.mjs'

const context = {
  exec: async (argv) => ({
    code: 0,
    stdout: argv[2].includes('restart acknowledged')
      ? 'synthetic-service: restart acknowledged'
      : 'synthetic-service: degraded',
    stderr: '',
    truncated: false,
  }),
  sandbox: { confine: async (argv) => argv, enforcement: () => ({ level: 'none', scope: [] }) },
}
test('ops-runbook completes through the public loop and tool ports', async () => {
  const run = await runWorkflow(main, { context })
  assert.equal(run.finished[0], 'completed')
  const native = await runWorkflow(main, { context, parkTool: 'shell' })
  assert.equal(native.finished[0], 'completed')
  assert.equal(native.checkpoint.state.data.diagnosticJob, 'fixture-job')
  assert.ok(run.checkpoint.state.data.deliverables.some((file) => file.ref.size > 0))
  assert.ok(run.calls.some((call) => call.name === 'present'))
  assert.ok(run.calls.some((call) => call.name === 'ask_user_question'))

  assert.ok(run.skills.includes('ops-runbook'))
  const data = run.checkpoint.state.data
  assert.equal(data.diagnostic.jobId, data.diagnosticJob)
  assert.ok(run.calls.some((call) => call.name === 'shell' && call.args.background === true))
  assert.ok(run.calls.some((call) => call.name === 'job_output' && call.args.jobId === data.diagnosticJob))
  assert.equal(data.verification.verified, true)
  assert.equal(data.action.status, 'simulated-restart')
  const scheduled = await runWorkflow(main, { context, input: '[scheduled-inspection] Daily diagnostic' })
  assert.equal(scheduled.finished[0], 'completed')
  assert.equal(scheduled.checkpoint.state.data.action.status, 'inspection-only')
  assert.ok(scheduled.calls.some((call) => call.name === 'present'))
  assert.ok(
    !scheduled.calls.some((call) =>
      ['ask_user_question', 'fde_ops_restart', 'fde_ops_verify'].includes(call.name),
    ),
  )
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
