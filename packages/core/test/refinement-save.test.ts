import { canonicalJson } from '@agnes/core-common/request/hash'
import type { Event } from '@agnes/core-common/types'
import { initialState, reduce } from '@agnes/core-ledger/reduce/reducer'
import { REFINEMENT_SAVE_EVENT, type SaveReceipt } from '@agnes/core-ledger/reduce/refinement-save'
import type { LedgerState } from '@agnes/core-ledger/reduce/state'
import { encodeLedgerState } from '@agnes/core-ledger/testkit/encode-ledger-state'
import { describe, expect, it } from 'vitest'
import { recoverRefinement } from '../src/refinement/facade.js'
import { contentHash } from '../src/refinement/validity.js'
import {
  type RefinementWorkspacePort,
  saveToWorkspace,
  type WorkspaceSaveRequest,
} from '../src/refinement/workspace.js'
import * as reference from './helpers/reference-reducer.js'
import { BODY, open, output, QUOTE, REQUEST, upsert } from './helpers/refinement-session.js'
import { ofType } from './helpers/side-call-session.js'

const receiptFor = (request: WorkspaceSaveRequest, over: Partial<SaveReceipt> = {}): SaveReceipt => ({
  receiptId: `rc-${request.commandId}`,
  commandId: request.commandId,
  initiator: request.initiator,
  source: {
    sessionKey: request.session.key,
    kind: request.entry.kind,
    entryId: request.entry.id,
    contentHash: 'b'.repeat(64),
    initiator: request.initiator,
  },
  outcome: 'saved',
  steps: [{ step: 'switch', verdict: 'pass' }],
  target: { kind: 'memory-paragraph', paragraphId: 'r0123456789', fileHash: 'f'.repeat(64) },
  at: 1,
  ...over,
})

/** A host path that records what it was asked and answers with `answer`. */
function port(answer: (request: WorkspaceSaveRequest) => SaveReceipt = (r) => receiptFor(r)) {
  const asked: WorkspaceSaveRequest[] = []
  const workspace: RefinementWorkspacePort = {
    save: async (request) => {
      asked.push(request)
      return answer(request)
    },
  }
  return { asked, workspace }
}

/** A session with one session-level memory entry `build`, applied from a manual plan. */
async function withEntry(o: Parameters<typeof open>[0] = {}) {
  const t = await open({
    answers: [() => output({ edits: [upsert('build', { quote: QUOTE })], evidenceIds: ['e1'] })],
    ...o,
  })
  expect(await t.say(REQUEST)).toMatchObject({ reason: 'completed' })
  expect(await t.refine()).toMatchObject({ state: 'applied' })
  return t
}

describe('saving a session entry into the workspace', () => {
  it('asks the host with the entry, its level and its evidence from the ledger, and records the receipt', async () => {
    const host = port()
    const t = await withEntry({ workspace: host.workspace })
    const outcome = await saveToWorkspace(t.session, { initiator: 'user', kind: 'memory', id: 'build' })
    expect(outcome).toMatchObject({ receipt: { outcome: 'saved' } })
    expect(host.asked).toHaveLength(1)
    const request = host.asked[0] as WorkspaceSaveRequest
    expect(request).toMatchObject({
      initiator: 'user',
      session: {
        key: t.session.key,
        lane: 'main',
        workspaceRoot: t.session.workspaceRoot,
        child: false,
      },
      settingsRevision: 'r1',
      entry: {
        kind: 'memory',
        id: 'build',
        version: 1,
        title: 'build',
        content: `${BODY} (build)`,
        contentHash: contentHash(`${BODY} (build)`),
        applicability: 'session',
      },
      confirmations: 0,
    })
    expect(request.evidenceSeqs.length).toBeGreaterThan(0)
    for (const seq of request.evidenceSeqs) {
      expect(seq).toBeGreaterThanOrEqual(1)
      expect(seq).toBeLessThanOrEqual(request.session.lastSeq)
    }
    const rows = ofType(await t.rows(), REFINEMENT_SAVE_EVENT)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ origin: 'system', trust: 'trusted', lane: 'refinement' })
    expect(t.session.state.refinementSaves.get(`rc-${request.commandId}`)).toMatchObject({
      outcome: 'saved',
      seq: (rows[0] as Event).seq,
    })
    // The receipt row carries structure and hashes, never the entry's title or text.
    expect(JSON.stringify(rows[0]?.data)).not.toContain(BODY)
    await t.session.close()
  })

  it('an explicit evidence list and command id are passed through unchanged', async () => {
    const host = port()
    const t = await withEntry({ workspace: host.workspace })
    await saveToWorkspace(t.session, {
      initiator: 'model',
      kind: 'memory',
      id: 'build',
      commandId: 'cmd-7',
      evidenceSeqs: [1],
      runId: 'run-9',
    })
    expect(host.asked[0]).toMatchObject({ commandId: 'cmd-7', evidenceSeqs: [1], runId: 'run-9' })
    await t.session.close()
  })

  it('writes no row when the host refuses because refinement is off', async () => {
    const host = port((request) => receiptFor(request, { outcome: 'refused', reason: 'refinement-off' }))
    const t = await withEntry({ workspace: host.workspace })
    const before = t.session.lastSeq
    expect(
      await saveToWorkspace(t.session, { initiator: 'model', kind: 'memory', id: 'build' }),
    ).toMatchObject({
      receipt: { reason: 'refinement-off' },
    })
    expect(t.session.lastSeq).toBe(before)
    await t.session.close()
  })

  it('without a host path, or for an entry that is not there, nothing is asked or written', async () => {
    const t = await withEntry()
    const before = t.session.lastSeq
    expect(await saveToWorkspace(t.session, { initiator: 'user', kind: 'memory', id: 'build' })).toEqual({
      refused: 'unavailable',
    })
    const host = port()
    const u = await withEntry({ workspace: host.workspace })
    expect(await saveToWorkspace(u.session, { initiator: 'user', kind: 'memory', id: 'missing' })).toEqual({
      refused: 'not-found',
    })
    expect(host.asked).toHaveLength(0)
    expect(t.session.lastSeq).toBe(before)
    await t.session.close()
    await u.session.close()
  })

  it('the reference reducer folds the receipt rows the same way, and old ledgers are unchanged', async () => {
    const host = port()
    const t = await withEntry({ workspace: host.workspace })
    await saveToWorkspace(t.session, { initiator: 'user', kind: 'memory', id: 'build' })
    let ours: LedgerState = initialState()
    let theirs = reference.initialState()
    let withoutSaves: LedgerState = initialState()
    for (const row of await t.rows()) {
      ours = reduce(ours, row)
      theirs = reference.reduce(theirs, row)
      if (row.type !== REFINEMENT_SAVE_EVENT) withoutSaves = reduce(withoutSaves, row)
    }
    // The reference predates how the planning call's cost is counted, so credits are left out here.
    const encode = (state: unknown) =>
      canonicalJson({ ...encodeLedgerState(state as LedgerState), creditsUsed: 0 })
    expect(encode(ours)).toBe(encode(theirs))
    expect(ours.refinementSaves.size).toBe(1)
    // The receipt rows touch nothing but their own table: without them the state is the same, row for
    // row, with an empty table, and the reference reducer agrees on that ledger too.
    expect(withoutSaves.refinementSaves.size).toBe(0)
    expect(encode({ ...ours, refinementSaves: new Map(), lastSeq: withoutSaves.lastSeq })).toBe(
      encode(withoutSaves),
    )
    let theirsWithout = reference.initialState()
    for (const row of await t.rows())
      if (row.type !== REFINEMENT_SAVE_EVENT) theirsWithout = reference.reduce(theirsWithout, row)
    expect(encode(withoutSaves)).toBe(encode(theirsWithout))
    await t.session.close()
  })
})

describe('saves whose outcome was not known', () => {
  it('the session records how they ended once the host has settled them', async () => {
    const settledIds: string[][] = []
    let final: SaveReceipt | undefined
    const workspace: RefinementWorkspacePort = {
      save: async (request) => {
        final = receiptFor(request)
        return receiptFor(request, { outcome: 'unknown' })
      },
      settled: async (_root, ids) => {
        settledIds.push([...ids])
        return final ? [final] : []
      },
    }
    const t = await withEntry({ workspace })
    const outcome = await saveToWorkspace(t.session, { initiator: 'user', kind: 'memory', id: 'build' })
    const receiptId = (outcome as { receipt: SaveReceipt }).receipt.receiptId
    expect(t.session.state.refinementSaves.get(receiptId)?.outcome).toBe('unknown')
    await recoverRefinement(t.session)
    expect(settledIds).toEqual([[receiptId]])
    expect(t.session.state.refinementSaves.get(receiptId)?.outcome).toBe('saved')
    // Nothing left unknown: the next recovery asks nothing.
    await recoverRefinement(t.session)
    expect(settledIds).toHaveLength(1)
    await t.session.close()
  })
})
