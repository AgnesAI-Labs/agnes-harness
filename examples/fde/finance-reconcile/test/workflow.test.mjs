import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main, tools } from '../index.mjs'
import { value } from '../runtime.mjs'
import { runWorkflow } from './harness.mjs'

test('exact cents reconciliation flags unmatched evidence and approves balanced simulation entries', async () => {
  const run = await runWorkflow(main)
  assert.equal(run.finished[0], 'completed')
  assert.ok(run.skills.includes('finance-reconcile'))
  const { report, receipt } = run.checkpoint.state.data
  assert.deepEqual(report.matched, ['TX-1'])
  assert.deepEqual(
    report.proposals.map(({ id, amountCents }) => ({ id, amountCents })),
    [
      { id: 'TX-2', amountCents: 5000 },
      { id: 'TX-3', amountCents: 7525 },
    ],
  )
  assert.deepEqual(report.unresolved, ['TX-4'])
  assert.equal(receipt.posted, false)
  for (const entry of receipt.entries)
    assert.equal(
      entry.lines.reduce((sum, line) => sum + line.signedCents, 0),
      0,
    )
})
test('denial produces no posting receipt; duplicate IDs and date differences cannot be silently matched', async () => {
  const run = await runWorkflow(main, { approve: false })
  assert.equal(run.finished[0], 'error')
  assert.equal(run.checkpoint.state.data.receipt, undefined)
  const signal = new AbortController().signal
  const row = { id: 'X', date: '2026-10-01', amountCents: 10, currency: 'USD', description: 'fixture' }
  const duplicate = await tools[1].execute({ bank: [row, row], book: [] }, { signal })
  assert.equal(duplicate.isError, true)
  assert.match(duplicate.content[0].text, /Duplicate transaction/)
  const date = value(
    await tools[1].execute({ bank: [row], book: [{ ...row, date: '2026-10-02' }] }, { signal }),
  )
  assert.deepEqual(date.proposals, [])
  assert.deepEqual(date.unresolved, ['X'])
})
