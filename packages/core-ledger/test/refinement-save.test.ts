import type { Event } from '@agnes/core-common/types'
import { validateAgainst } from '@agnes/protocol'
import { UITimeline } from '@agnes/protocol/gen/agnes-v1'
import { describe, expect, it } from 'vitest'
import { UIProjectionCell } from '../src/project/ui.js'
import { foldEvents } from '../src/reduce/reducer.js'
import { checkedReceipt, REFINEMENT_SAVE_EVENT, type SaveReceipt } from '../src/reduce/refinement-save.js'
import { initialState } from '../src/reduce/state.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }

function row(seq: number, data: unknown, extra: Partial<Event> = {}): Event {
  return {
    seq,
    ts: '2026-11-03T00:00:00Z',
    id: `01J6ZM2Q3R4S5T6V7W8X9Y0Z${String(seq).padStart(2, '0')}`,
    type: REFINEMENT_SAVE_EVENT,
    data,
    actor,
    origin: 'system',
    trust: 'trusted',
    lane: 'refinement',
    ignorable: true,
    v: 1,
    ...extra,
  } as Event
}

const receipt = (over: Partial<SaveReceipt> = {}): SaveReceipt => ({
  receiptId: 'rc-1',
  commandId: 'cmd-1',
  initiator: 'model',
  source: {
    sessionKey: 's-1',
    kind: 'memory',
    entryId: 'build',
    contentHash: 'a'.repeat(64),
    initiator: 'model',
  },
  outcome: 'saved',
  steps: [
    { step: 'switch', verdict: 'pass' },
    { step: 'revocation', verdict: 'pass' },
    { step: 'confirmations', verdict: 'skip' },
    { step: 'rules', verdict: 'pass' },
    { step: 'memory-mode', verdict: 'pass' },
    { step: 'capacity', verdict: 'pass' },
  ],
  target: { kind: 'memory-paragraph', paragraphId: 'r0123456789', fileHash: 'f'.repeat(64) },
  at: 1,
  ...over,
})

describe('the save receipt fold', () => {
  it('folds Core receipt rows by receipt id, a later row of the same receipt replacing the earlier', () => {
    const state = foldEvents([
      row(1, { version: 1, ...receipt({ outcome: 'unknown' }) }),
      row(2, { version: 1, ...receipt() }),
      row(3, { version: 1, ...receipt({ receiptId: 'rc-2', outcome: 'refused', reason: 'user-revoked' }) }),
    ])
    expect(state.refinementSaves.get('rc-1')).toEqual({ ...receipt(), seq: 2 })
    expect(state.refinementSaves.get('rc-2')).toMatchObject({
      outcome: 'refused',
      reason: 'user-revoked',
      seq: 3,
    })
  })

  it('ignores rows that are not Core’s own, of another version, or carry anything else', () => {
    const state = foldEvents([
      row(1, { version: 1, ...receipt({ receiptId: 'a' }) }, { origin: 'principal' } as Partial<Event>),
      row(2, { version: 1, ...receipt({ receiptId: 'b' }) }, { trust: 'untrusted' }),
      row(3, { version: 2, ...receipt({ receiptId: 'c' }) }),
      row(4, { version: 1, ...receipt({ receiptId: 'd' }), title: 'Build rules' }),
      row(5, { version: 1, ...receipt({ receiptId: 'e', outcome: 'done' as never }) }),
      row(6, { version: 1, ...receipt({ receiptId: 'f' }), source: { ...receipt().source, content: 'x' } }),
    ])
    expect([...state.refinementSaves.keys()]).toEqual([])
  })

  it('a fork starts its saves over, and a ledger without receipt rows folds as before', () => {
    const forked = foldEvents([
      row(1, { version: 1, ...receipt() }),
      {
        ...row(2, {}),
        type: 'session/start',
        lane: 'main',
        data: { parent: { sessionKey: 'p', boundarySeq: 1 } },
      } as Event,
    ])
    expect(forked.refinementSaves.size).toBe(0)
    expect(foldEvents([]).refinementSaves).toEqual(initialState().refinementSaves)
  })

  it('checkedReceipt keeps exactly the receipt fields and refuses free text', () => {
    expect(checkedReceipt(receipt())).toEqual(receipt())
    expect(checkedReceipt({ ...receipt(), reason: 'because I said so' })).toBeUndefined()
    // A reason a later build adds is kept as it is, so its records stay readable here.
    expect(
      checkedReceipt({ ...receipt(), outcome: 'refused', reason: 'skill-review-pending' }),
    ).toMatchObject({
      reason: 'skill-review-pending',
    })
    expect(checkedReceipt({ ...receipt(), reason: `x${'-y'.repeat(40)}` })).toBeUndefined()
    expect(checkedReceipt({ ...receipt(), steps: [{ step: 'switch', verdict: 'pass', note: 'x' }] })).toEqual(
      receipt({ steps: [{ step: 'switch', verdict: 'pass' }] }),
    )
    expect(checkedReceipt({ ...receipt(), target: { kind: 'file', path: '/x' } })).toBeUndefined()
  })
})

describe('the save receipt timeline node', () => {
  it('one node per receipt, updated in place, with the outcome and reason only', async () => {
    const cell = new UIProjectionCell('k', 'main')
    cell.apply([
      row(1, { version: 1, ...receipt({ outcome: 'unknown' }) }),
      row(2, { version: 1, ...receipt({ receiptId: 'rc-2', outcome: 'refused', reason: 'memory-off' }) }),
      row(3, { version: 1, ...receipt() }),
    ])
    const timeline = await cell.view()
    const nodes = timeline.nodes.filter((node) => node.kind === 'refinement-save')
    expect(nodes).toEqual([
      {
        kind: 'refinement-save',
        id: row(1, {}).id,
        seq: 1,
        state: 'saved',
        initiator: 'model',
        target: 'workspace-memory',
      },
      {
        kind: 'refinement-save',
        id: row(2, {}).id,
        seq: 2,
        state: 'refused',
        reason: 'memory-off',
        initiator: 'model',
        target: 'workspace-memory',
      },
    ])
    const verdict = validateAgainst(UITimeline, {
      sessionId: 'k',
      upto: 3,
      generation: 1,
      opState: null,
      pendingInputs: [],
      nodes: timeline.nodes,
      turns: [],
    })
    expect(verdict.ok).toBe(true)
    expect(JSON.stringify(nodes)).not.toContain('build')
  })

  it('save rows render initiator, outcome and reason without text', async () => {
    const cell = new UIProjectionCell('k', 'main')
    const skill = receipt({
      receiptId: 'rc-3',
      initiator: 'user',
      source: { ...receipt().source, kind: 'skill', entryId: 'deploy-notes', initiator: 'user' },
      outcome: 'refused',
      reason: 'unavailable',
    })
    delete skill.target
    cell.apply([
      row(1, { version: 1, ...receipt({ initiator: 'auto', outcome: 'refused', reason: 'memory-full' }) }),
      row(2, { version: 1, ...skill }),
    ])
    const nodes = (await cell.view()).nodes.filter((node) => node.kind === 'refinement-save')
    expect(nodes.map((node) => node.kind === 'refinement-save' && [node.initiator, node.target])).toEqual([
      ['auto', 'workspace-memory'],
      ['user', 'workspace-skill'],
    ])
    const text = JSON.stringify(nodes)
    for (const hidden of ['build', 'deploy-notes', 'r0123456789', 'f'.repeat(64), 's-1', 'cmd-1'])
      expect(text).not.toContain(hidden)
  })

  it('a promotion to user memory names user memory and whether this workspace reads it', async () => {
    const cell = new UIProjectionCell('k', 'main')
    const user = (over: Partial<SaveReceipt>) =>
      receipt({ initiator: 'auto', layer: 'user', userMemoryRead: false, ...over })
    cell.apply([
      row(1, { version: 1, ...user({ receiptId: 'u-1' }) }),
      row(2, { version: 1, ...user({ receiptId: 'u-2', outcome: 'refused', reason: 'user-memory-budget' }) }),
    ])
    const timeline = await cell.view()
    const nodes = timeline.nodes.filter((node) => node.kind === 'refinement-save')
    expect(nodes).toEqual([
      expect.objectContaining({ state: 'saved', target: 'user-memory', userMemoryRead: false }),
      expect.objectContaining({ state: 'refused', reason: 'user-memory-budget', target: 'user-memory' }),
    ])
    expect(
      validateAgainst(UITimeline, {
        sessionId: 'k',
        upto: 2,
        generation: 1,
        opState: null,
        pendingInputs: [],
        nodes: timeline.nodes,
        turns: [],
      }).ok,
    ).toBe(true)
    // Only Core's values: a receipt with another layer is not one a save writes.
    expect(checkedReceipt({ ...receipt(), layer: 'everywhere' })).toBeUndefined()
    expect(checkedReceipt({ ...receipt(), userMemoryRead: 'yes' })).toBeUndefined()
    expect(checkedReceipt(user({}))).toEqual(user({}))
  })

  it('a reason this build does not know is left off the line', async () => {
    const cell = new UIProjectionCell('k', 'main')
    cell.apply([
      row(1, { version: 1, ...receipt({ outcome: 'refused', reason: 'skill-review-pending' as never }) }),
    ])
    const [node] = (await cell.view()).nodes.filter((n) => n.kind === 'refinement-save')
    expect(node).toMatchObject({ state: 'refused' })
    expect(node).not.toHaveProperty('reason')
  })
})
