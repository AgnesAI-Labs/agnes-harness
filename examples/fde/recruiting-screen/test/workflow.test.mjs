import assert from 'node:assert/strict'
import { test } from 'vitest'
import { main, tools } from '../index.mjs'
import { value } from '../runtime.mjs'
import { runWorkflow } from './harness.mjs'

test('rubric uses minimized explicit evidence, shows unknowns and leaves hiring to a person', async () => {
  const run = await runWorkflow(main)
  assert.equal(run.finished[0], 'completed')
  assert.ok(run.checkpoint.state.data.deliverables.some((file) => file.ref.size > 0))
  assert.ok(run.calls.some((call) => call.name === 'present'))
  assert.ok(run.calls.some((call) => call.name === 'ask_user_question'))

  assert.ok(run.skills.includes('recruiting-screen'))
  const data = run.checkpoint.state.data
  assert.deepEqual(
    data.report.reviews.map(({ id, score }) => ({ id, score })),
    [
      { id: 'CAND-1', score: 7 },
      { id: 'CAND-2', score: 3 },
    ],
  )
  assert.equal(data.report.reviews[0].assessments[1].status, 'unknown')
  assert.equal(data.receipt.hiringDecision, false)
  assert.deepEqual(data.receipt.candidateIds, ['CAND-1', 'CAND-2'])
  assert.doesNotMatch(JSON.stringify(run.requests), /Synthetic Alex|fixture-A|Example College|"age"|"gender"/)
  const { candidates } = value(await tools[0].execute({}, { signal: new AbortController().signal }))
  assert.deepEqual(Object.keys(candidates[0]).sort(), ['evidence', 'id'])
})
test('human refusal preserves evidence but records no decision', async () => {
  const run = await runWorkflow(main, { approve: false })
  assert.equal(run.finished[0], 'error')
  assert.match(run.checkpoint.state.data.report.biasNotes.join('\n'), /Missing evidence means unknown/)
  assert.equal(run.checkpoint.state.data.receipt, undefined)
})
