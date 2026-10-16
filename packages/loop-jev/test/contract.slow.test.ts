import { verifyLoopExecutionContract } from '@agnes/host/author-testkit'
import { expect, it } from 'vitest'
import { createJevLoopFactory } from '../src/index.js'

it('agnes.jev passes the public execution contract', async () => {
  const report = await verifyLoopExecutionContract(createJevLoopFactory(), { sideCall: true })
  expect(report.checks).toEqual([
    'cost-settlement',
    'missing-usage',
    'cancel',
    'approval-rejection',
    'unknown-outcome',
    'cold-restore',
    'stale-scope',
    'parallel-generations',
    'side-call',
    'side-call-deadline',
    'side-call-cancel',
    'side-call-revocation',
    'side-call-estimated-cost',
  ])
}, 120_000)
