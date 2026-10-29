import { verifyLoopExecutionContract } from '@agnes/host/author-testkit'
import { expect, it } from 'vitest'
import { createJevLoopFactory } from '../src/index.js'
import { type FakeJev, fakeJev, PICK_RESPOND, withJev } from './helpers/fake-jev.js'

it('agnes.jev passes the public execution contract with a scripted Jev', async () => {
  // Invocation ids are scoped to a session, so each session the suite opens gets its own Jev.
  const sessions = new Map<string, FakeJev>()
  const jevFor = (key: string) => {
    const existing = sessions.get(key)
    if (existing) return existing
    const jev = fakeJev(() => ({ pick: PICK_RESPOND }))
    sessions.set(key, jev)
    return jev
  }
  const report = await verifyLoopExecutionContract(
    withJev(createJevLoopFactory(), (ctx) => jevFor(ctx.sessionKey)),
    { sideCall: true },
  )
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
