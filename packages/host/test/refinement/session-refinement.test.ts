import { fakeProvider, openSession, textTurn } from '@agnes/core/testkit'
import { describe, expect, it } from 'vitest'
import type { HostSession } from '../../src/runtime/lifecycle/host.js'
import { requestRefinement } from '../../src/runtime/sessions/session-refinement.js'

const planner = { buildPrompt: () => ({}) as never, parseOutput: () => ({ error: 'unused' }) }

describe('a manual refinement request', () => {
  it('queues a run on the session, or is refused with the reason and writes nothing', async () => {
    let enabled = false
    const { session } = await openSession({
      provider: fakeProvider([textTurn('done')]),
      refinement: { settings: () => ({ enabled, mode: 'manual', revision: 'r' }), planner: () => planner },
    })
    const host = session as unknown as HostSession
    await expect(requestRefinement(host, 'tests')).rejects.toMatchObject({
      data: { code: 'SEMANTIC_REJECTED', reason: 'refinement-off' },
    })
    expect(session.state.refinementRuns.size).toBe(0)
    enabled = true
    const { runId } = await requestRefinement(host, 'tests')
    // Manual mode still takes the user's own request.
    expect(session.state.refinementRuns.get(runId)).toMatchObject({
      trigger: { kind: 'manual', focus: 'tests' },
    })
    await session.close()
  })
})
