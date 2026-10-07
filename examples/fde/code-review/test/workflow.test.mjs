import assert from 'node:assert/strict'
import { driveLoop } from '@agnes/plugin-runtime/testkit'
import { test } from 'vitest'
import { factory, main, policy, tools } from '../index.mjs'
import { value } from '../runtime.mjs'
import { runWorkflow } from './harness.mjs'

test('review DAG joins independent checks with exact added-line evidence', async () => {
  const run = await runWorkflow(main)
  assert.equal(run.finished[0], 'completed')
  assert.ok(run.checkpoint.state.data.deliverables.some((file) => file.ref.size > 0))
  assert.ok(run.calls.some((call) => call.name === 'present'))

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
  const removed = value(
    await tools[2].execute(
      {
        diff: '--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-return eval(input)\n+return JSON.parse(input)\n',
      },
      { signal: new AbortController().signal },
    ),
  )
  assert.deepEqual(removed.findings, [])
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
