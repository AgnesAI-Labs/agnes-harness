import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main } from '../index.mjs'
import { markdownDownload } from '../client/index.js'
import { runWorkflow } from './harness.mjs'

test('meeting evidence exports owners/dates and a complete downloadable markdown payload before sending', async () => {
  const run = await runWorkflow(main)
  assert.equal(run.finished[0], 'completed')
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
  const download = markdownDownload({ status: 'completed', resultPreview: JSON.stringify(data.exported) })
  assert.equal(download.download, 'meeting-actions.md')
  assert.equal(decodeURIComponent(download.href.split(',')[1]), data.exported.markdown)
  assert.equal(markdownDownload({ status: 'completed', resultPreview: '{"markdown":' }), null)
  assert.equal(data.receipt.externalDelivery, false)
})
test('refused send retains the export without a receipt and pending recovery never repeats it', async () => {
  const run = await runWorkflow(main, { approve: false })
  assert.equal(run.finished[0], 'error')
  assert.match(run.checkpoint.state.data.exported.markdown, /due 2026-10-09/)
  assert.equal(run.checkpoint.state.data.receipt, undefined)
  const resumed = await runWorkflow(main, { checkpoint: run.checkpoint })
  assert.equal(resumed.finished[0], 'blocked')
  assert.equal(resumed.checkpoint.state.data.receipt, undefined)
})
