import { type RefinementWorkspacePort, refinementFacade, type WorkspaceSaveRequest } from '@agnes/core'
import { fakeProvider, openSession, textTurn } from '@agnes/core/testkit'
import { describe, expect, it } from 'vitest'
import type { HostSession } from '../../src/runtime/lifecycle/host.js'
import {
  refinementCommand,
  requestRefinement,
  rollbackRefinement,
  saveEntryToWorkspace,
} from '../../src/runtime/sessions/session-refinement.js'

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
    // The session's model has no known price: the user's own request needs the user's agreement first.
    await expect(requestRefinement(host, 'tests')).rejects.toMatchObject({
      data: { code: 'SEMANTIC_REJECTED', reason: 'unpriced' },
    })
    expect(session.state.refinementRuns.size).toBe(0)
    const { runId } = await requestRefinement(host, 'tests', undefined, true)
    // Manual mode still takes the user's own request.
    expect(session.state.refinementRuns.get(runId)).toMatchObject({
      trigger: { kind: 'manual', focus: 'tests', allowUnpriced: true },
    })
    // Through a worker command too, and only as a plain yes.
    const viaWorker = (await refinementCommand(host, 'refine', { allowUnpriced: true })) as { runId: string }
    expect(session.state.refinementRuns.get(viaWorker.runId)?.trigger.allowUnpriced).toBe(true)
    await expect(refinementCommand(host, 'refine', { allowUnpriced: 'yes' })).rejects.toMatchObject({
      data: { reason: 'unpriced' },
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

/** A host save path that records each request and answers as the real one does for the switch. */
function savePath(enabled: () => boolean) {
  const asked: WorkspaceSaveRequest[] = []
  const workspace: RefinementWorkspacePort = {
    save: async (request) => {
      asked.push(request)
      const on = enabled()
      return {
        receiptId: `rc-${asked.length}`,
        commandId: request.commandId,
        initiator: request.initiator,
        source: {
          sessionKey: request.session.key,
          kind: request.entry.kind,
          entryId: request.entry.id,
          contentHash: 'c'.repeat(64),
          initiator: request.initiator,
        },
        outcome: on ? 'saved' : 'refused',
        ...(on ? {} : { reason: 'refinement-off' as const }),
        steps: [{ step: 'switch', verdict: on ? 'pass' : 'fail' }],
        at: 1,
      }
    },
  }
  return { asked, workspace }
}

describe("saving to the workspace on the user's request", () => {
  it("/refine with saveTo queues a run whose result is saved as the user's", async () => {
    const path = savePath(() => true)
    const { session } = await openSession({
      provider: fakeProvider([textTurn('done')]),
      refinement: {
        settings: () => ({ enabled: true, mode: 'manual', revision: 'r' }),
        planner: () => planner,
        workspace: path.workspace,
      },
    })
    const { runId } = await requestRefinement(session as unknown as HostSession, 'build', 'workspace', true)
    expect(session.state.refinementRuns.get(runId)).toMatchObject({
      trigger: { kind: 'manual', focus: 'build', saveTo: 'workspace', allowUnpriced: true },
    })
    // Through a worker command too.
    const viaWorker = (await refinementCommand(session as unknown as HostSession, 'refine', {
      saveTo: 'workspace',
      allowUnpriced: true,
    })) as { runId: string }
    expect(session.state.refinementRuns.get(viaWorker.runId)?.trigger.saveTo).toBe('workspace')
    await session.close()
  })

  it('the single-entry save calls no model, and answers with the receipt', async () => {
    let enabled = true
    const path = savePath(() => enabled)
    const provider = fakeProvider([textTurn('done')])
    const { session } = await openSession({
      provider,
      refinement: {
        settings: () => ({ enabled, mode: 'manual', revision: 'r' }),
        planner: () => planner,
        workspace: path.workspace,
      },
    })
    const host = session as unknown as HostSession
    await refinementFacade(session).propose({
      rationale: 'r',
      evidenceSeqs: [1],
      edits: [{ op: 'upsert', kind: 'memory', id: 'm1', title: 'M', content: 'Fact.' }],
    })
    const calls = provider.requests.length
    const { receipt } = await saveEntryToWorkspace(host, { kind: 'memory', id: 'm1' })
    expect(receipt).toMatchObject({ outcome: 'saved', initiator: 'user' })
    expect(path.asked).toEqual([
      expect.objectContaining({ initiator: 'user', entry: expect.objectContaining({ id: 'm1' }) }),
    ])
    expect(provider.requests.length).toBe(calls)
    // The same through a worker command.
    const again = (await refinementCommand(host, 'refineSave', { kind: 'memory', id: 'm1' })) as {
      receipt: { initiator: string }
    }
    expect(again.receipt.initiator).toBe('user')
    // An entry that is not there is refused before the host is asked.
    await expect(saveEntryToWorkspace(host, { kind: 'memory', id: 'gone' })).rejects.toMatchObject({
      data: { code: 'SEMANTIC_REJECTED', reason: 'not-found' },
    })
    await expect(refinementCommand(host, 'refineSave', { kind: 'nope', id: 'm1' })).rejects.toThrow()
    // With refinement off the receipt says so, and the session ledger gains nothing.
    enabled = false
    const before = session.lastSeq
    const off = await saveEntryToWorkspace(host, { kind: 'memory', id: 'm1' })
    expect(off.receipt).toMatchObject({ outcome: 'refused', reason: 'refinement-off' })
    expect(session.lastSeq).toBe(before)
    await session.close()
  })
})
