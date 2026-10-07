import assert from 'node:assert/strict'
import { driveLoop } from '@agnes/plugin-runtime/testkit'
import { test } from 'vitest'
import { factory, main, parseCsv, policy } from '../index.mjs'
import { runWorkflow } from './harness.mjs'

const context = {}
test('data-report completes through the public loop and tool ports', async () => {
  const run = await runWorkflow(main, { context, planMode: true })
  assert.equal(run.finished[0], 'completed')
  assert.ok(run.checkpoint.state.data.deliverables.some((file) => file.ref.size > 0))
  assert.ok(run.calls.some((call) => call.name === 'present'))
  assert.equal(run.checkpoint.state.data.plan.approved, true)
  assert.match(run.calls.find((call) => call.name === 'exit_plan_mode').args.plan, /analyze|analyse/)

  assert.ok(run.skills.includes('data-report'))
  const data = run.checkpoint.state.data
  assert.equal(data.analysis.revenue, 45000)
  assert.equal(data.analysis.profit, 18000)
  assert.match(data.report.html, /<svg/)
  assert.ok(Object.values(run.files).includes(data.report.html))
  assert.ok(data.deliverables.some((file) => file.ref.mime === 'text/html'))
  assert.throws(() => parseCsv('month,revenue,cost\n2026-01,NaN,1'), /Invalid CSV/)
  assert.throws(() => parseCsv('month,revenue,cost\n"2026-01",1,1'), /unquoted/)
})
test('refusal and cancellation preserve workflow boundaries', async () => {
  const waiting = await runWorkflow(main, {
    planMode: true,
    parkTool: 'exit_plan_mode',
    stopAtApproval: true,
  })
  assert.equal(waiting.steps.at(-1).outcome, 'parked')
  assert.equal(waiting.checkpoint.state.approvalWaiting, true)
  assert.equal(waiting.checkpoint.state.data.analysis, undefined)
  assert.equal(Object.keys(waiting.files).length, 0)
  const approved = await runWorkflow(main, { planMode: true, parkTool: 'exit_plan_mode' })
  assert.equal(approved.finished[0], 'completed')
  assert.equal(approved.checkpoint.state.data.plan.approved, true)
  const refusedPlan = await runWorkflow(main, {
    planMode: true,
    parkTool: 'exit_plan_mode',
    nativeApprove: false,
  })
  assert.equal(refusedPlan.finished[0], 'error')
  assert.equal(refusedPlan.checkpoint.state.data.analysis, undefined)
  assert.equal(Object.keys(refusedPlan.files).length, 0)
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
  for (const [name, path, effect] of [
    ['write', `fde-output/data-report/${'a'.repeat(64)}/0-report.md`, 'allow'],
    ['write', 'fixtures/sales.csv', 'deny'],
    ['write', `fde-output/data-report/${'a'.repeat(64)}/../sales.csv`, 'deny'],
    ['edit', `fde-output/data-report/${'a'.repeat(64)}/0-report.md`, 'deny'],
  ]) {
    assert.equal(
      policy.decide(
        {
          policy: { isReadOnly: false, isDestructive: true },
          call: { name, args: { path } },
        },
        new AbortController().signal,
      ).effect,
      effect,
    )
  }
})
