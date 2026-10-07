import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main, policy, tools } from '../index.mjs'
import { runWorkflow } from './harness.mjs'

test('evidence audit distinguishes sourced controls, gaps and missing files with severity', async () => {
  const run = await runWorkflow(main)
  assert.equal(run.finished[0], 'completed')
  assert.ok(run.skills.includes('compliance-audit'))
  const { report } = run.checkpoint.state.data
  assert.deepEqual(report.gaps, ['CTRL-2', 'CTRL-3'])
  assert.deepEqual(
    report.findings.map(({ status, severity }) => ({ status, severity })),
    [
      { status: 'evidenced', severity: 'none' },
      { status: 'gap', severity: 'medium' },
      { status: 'missing', severity: 'high' },
    ],
  )
  assert.match(report.findings[0].quote, /Review completed/)
  assert.equal(report.findings[0].evidenceLink, 'fixtures/evidence/access-review.md#L3')
  assert.equal(report.findings[2].quote, null)
})
test('read-only policy and evidence path validation reject mutations and traversal', async () => {
  const signal = new AbortController().signal
  assert.equal(policy.decide({ policy: { isReadOnly: false, isDestructive: true } }, signal).effect, 'deny')
  const result = await tools[1].execute(
    {
      id: 'CTRL-1',
      requirement: 'fixture',
      evidence: '../outside.md',
      requiredPhrase: 'yes',
      severity: 'high',
    },
    { signal },
  )
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /local markdown filename/)
})
