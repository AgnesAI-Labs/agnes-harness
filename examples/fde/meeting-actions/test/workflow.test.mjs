import assert from 'node:assert/strict'
import { answerPrefix } from '@agnes/protocol'
import { test } from 'vitest'
import { main } from '../index.mjs'
import { runWorkflow } from './harness.mjs'

test('meeting evidence exports owners/dates and a complete downloadable markdown payload before sending', async () => {
  const run = await runWorkflow(main)
  assert.equal(run.finished[0], 'completed')
  assert.ok(run.checkpoint.state.data.deliverables.some((file) => file.ref.size > 0))
  assert.ok(run.calls.some((call) => call.name === 'present'))
  assert.ok(run.calls.some((call) => call.name === 'ask_user_question'))

  assert.ok(run.skills.includes('meeting-actions'))
  const data = run.checkpoint.state.data
  assert.deepEqual(
    data.notes.actions.map(({ owner, due }) => ({ owner, due })),
    [
      { owner: 'Morgan', due: '2026-10-09' },
      { owner: 'Casey', due: '2026-10-12' },
    ],
  )
  assert.match(data.exported.markdown, /Release to the pilot cohort/)
  assert.equal(data.deliverables[0].ref.mime, 'text/markdown')
  assert.ok(Object.values(run.files).includes(data.exported.markdown))
  assert.equal(data.receipt.externalDelivery, false)
})
test('refused send retains the export without a receipt and pending recovery never repeats it', async () => {
  const native = await runWorkflow(main, { parkTool: 'fde_meeting_send' })
  assert.equal(native.finished[0], 'completed')
  assert.equal(native.checkpoint.state.data.receipt.externalDelivery, false)
  const nativeDenied = await runWorkflow(main, { parkTool: 'fde_meeting_send', nativeApprove: false })
  assert.equal(nativeDenied.finished[0], 'error')
  assert.equal(nativeDenied.checkpoint.state.data.receipt, undefined)
  const waiting = await runWorkflow(main, { stopAtQuestion: true })
  assert.equal(waiting.steps.at(-1).outcome, 'parked')
  assert.equal(waiting.checkpoint.state.data.receipt, undefined)
  const invalid = await runWorkflow(main, {
    checkpoint: waiting.checkpoint,
    input: 'Proceed',
    stopAtQuestion: true,
  })
  assert.equal(invalid.steps.at(-1).outcome, 'parked')
  assert.equal(invalid.checkpoint.state.data.receipt, undefined)
  const cancelled = await runWorkflow(main, {
    checkpoint: waiting.checkpoint,
    stopAtQuestion: true,
    input: answerPrefix(waiting.checkpoint.state.waiting.id) + JSON.stringify({ proceed: 'Cancel' }),
  })
  assert.equal(cancelled.finished[0], 'error')
  assert.equal(cancelled.checkpoint.state.data.receipt, undefined)

  const run = await runWorkflow(main, { approve: false })
  assert.equal(run.finished[0], 'error')
  assert.match(run.checkpoint.state.data.exported.markdown, /due 2026-10-09/)
  assert.equal(run.checkpoint.state.data.receipt, undefined)
  const resumed = await runWorkflow(main, { checkpoint: run.checkpoint })
  assert.equal(resumed.finished[0], 'blocked')
  assert.equal(resumed.checkpoint.state.data.receipt, undefined)
})
