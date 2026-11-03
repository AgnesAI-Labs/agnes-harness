import { refinementFacade } from '@agnes/core'
import { fakeProvider, openSession, textTurn } from '@agnes/core/testkit'
import { describe, expect, it } from 'vitest'
import type { HostSession } from '../../src/runtime/lifecycle/host.js'
import { requestRefinement, rollbackRefinement } from '../../src/runtime/sessions/session-refinement.js'

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

describe('withdrawing an applied refinement', () => {
  it('undoes it as a new refinement, also while refinement is off, or refuses with the reason', async () => {
    let enabled = true
    const { session } = await openSession({
      provider: fakeProvider([textTurn('done')]),
      refinement: { settings: () => ({ enabled, mode: 'manual', revision: 'r' }), planner: () => planner },
    })
    const host = session as unknown as HostSession
    const facade = refinementFacade(session)
    const edit = (content: string) => ({
      op: 'upsert' as const,
      kind: 'memory' as const,
      id: 'm1',
      title: 'M',
      content,
    })
    const write = async (content: string) => {
      const out = await facade.propose({ rationale: 'r', evidenceSeqs: [1], edits: [edit(content)] })
      expect(out).toHaveProperty('runId')
      const rows = await session.scan({ toSeq: session.lastSeq, type: 'harness/refine' })
      return rows.at(-1)?.seq as number
    }
    const first = await write('one')
    await facade.inspect({ op: 'get', id: 'memory/m1' })
    const second = await write('two')
    enabled = false
    await expect(rollbackRefinement(host, 999)).rejects.toMatchObject({
      data: { code: 'SEMANTIC_REJECTED', reason: 'not-found' },
    })
    // The first refinement's entry has changed since: a person has to decide.
    await expect(rollbackRefinement(host, first)).rejects.toMatchObject({
      data: { code: 'SEMANTIC_REJECTED', reason: 'changed-since', changed: ['memory/m1'] },
    })
    const { seq } = await rollbackRefinement(host, second)
    expect(seq).toBeGreaterThan(second)
    // A repeat is the same withdrawal; withdrawing the withdrawal itself is refused.
    await expect(rollbackRefinement(host, second)).resolves.toEqual({ seq })
    await expect(rollbackRefinement(host, seq)).rejects.toMatchObject({ data: { reason: 'is-rollback' } })
    expect([...session.state.registers.harnessEntries.values()][0]?.value).toMatchObject({ content: 'one' })
    await session.close()
  })
})
