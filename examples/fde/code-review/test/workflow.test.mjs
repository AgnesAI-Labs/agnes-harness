import assert from 'node:assert/strict'
import { test } from 'node:test'
import { driveLoop } from '@agnes/plugin-runtime/testkit'
import { factory, main, policy } from '../index.mjs'
import { runWorkflow } from './harness.mjs'

test('review DAG joins independent checks with exact added-line evidence', async () => {
  const run = await runWorkflow(main)
  assert.equal(run.finished[0], 'completed')
  assert.ok(run.skills.includes('code-review'))
  const report = run.checkpoint.state.data.report
  assert.equal(report.status, 'needs-review')
  assert.deepEqual(
    report.findings.map(({ rule, file, line }) => ({ rule, file, line })),
    [
      { rule: 'debug-log', file: 'src/handler.js', line: 2 },
      { rule: 'dynamic-eval', file: 'src/handler.js', line: 3 },
    ],
  )
  assert.match(report.markdown, /return eval\(input\)/)
})
test('read-only review refuses writes and honors cancellation', async () => {
  const signal = new AbortController().signal
  assert.equal(
    policy.decide({ fullAccess: true, policy: { isReadOnly: false, isDestructive: true } }, signal).effect,
    'deny',
  )
  const stop = new AbortController()
  stop.abort(new Error('Review stopped'))
  await assert.rejects(driveLoop(factory, { signal: stop.signal }), /Review stopped/)
})
