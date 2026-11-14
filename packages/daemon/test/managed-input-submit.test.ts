import { describe, expect, it } from 'vitest'
import { inputProgress } from '../src/supervisor/managed-input-submit.js'
import { inputWorld, owner, receipt } from './fixtures/fake-input-ports.js'

const ownerMessage = (receiptId: string) => ({ kind: 'ownerMessage' as const, receiptId })

function world(over: Parameters<typeof inputWorld>[0] = {}) {
  const w = inputWorld(over)
  const admit = (sessionId: string, key: string, receiptId = `${sessionId}-${key}`) =>
    w.engine.admit(
      w.ctx(sessionId),
      { key, target: w.target(sessionId), input: ownerMessage(receiptId) },
      receipt(receiptId),
    )
  const legacy = (sessionId: string, key: string, text = 'old words') =>
    w.engine.admit(
      w.ctx(sessionId),
      { key, target: w.target(sessionId), input: { kind: 'legacyOwnerMessage', text, originalInbox: null } },
      undefined,
    )
  const row = (sessionId: string, key: string) => w.inputs.get(owner, sessionId, key)
  const busy = async (sessionId: string, ...keys: string[]) => {
    w.core.state.running.add(sessionId)
    for (const key of keys) await admit(sessionId, key)
    w.core.state.running.delete(sessionId)
  }
  return { ...w, admit, legacy, row, busy }
}

const refusedWith = (code: string) => ({ message: 'SEMANTIC_REJECTED', data: { code } })

describe('held owner inputs', () => {
  it('held inputs submit one at a time in admission order on idle', async () => {
    const w = world()
    w.open('s1')
    await w.busy('s1', 'k1', 'k2', 'k3')
    expect(w.core.state.submits).toEqual([])
    await w.engine.advance('s1')
    await w.engine.advance('s1')
    expect(w.core.state.submits.map((s) => s.text)).toEqual(['text of s1-k1'])
    w.core.take('s1')
    await w.engine.advance('s1')
    expect(w.row('s1', 'k1')?.state).toBe('consumed')
    expect(w.core.state.submits.map((s) => s.text)).toEqual(['text of s1-k1', 'text of s1-k2'])
    w.core.take('s1')
    await w.engine.advance('s1')
    w.core.take('s1')
    await w.engine.advance('s1')
    expect(['k1', 'k2', 'k3'].map((key) => w.row('s1', key)?.state)).toEqual([
      'consumed',
      'consumed',
      'consumed',
    ])
    expect(['k1', 'k2', 'k3'].map((key) => w.core.ran('s1', `text of s1-${key}`))).toEqual([1, 1, 1])
  })

  it('before submit: archived → retained sessionArchived; gates fail → needsOwner grantRevoked; open question → waitingQuestion', async () => {
    const w = world()
    for (const id of ['a', 'b', 'c', 'd']) w.open(id)
    for (const id of ['a', 'b', 'c', 'd']) await w.busy(id, 'k1')
    w.records.markArchived('a')
    w.core.state.archived.add('b')
    await w.engine.advance('a')
    await w.engine.advance('b')
    w.gates.pass = false
    await w.engine.advance('c')
    w.gates.pass = true
    w.core.state.questions.add('d')
    await w.engine.advance('d')
    expect(['a', 'b', 'c', 'd'].map((id) => [w.row(id, 'k1')?.state, w.row(id, 'k1')?.reason])).toEqual([
      ['retained', 'sessionArchived'],
      ['retained', 'sessionArchived'],
      ['needsOwner', 'grantRevoked'],
      ['waitingQuestion', 'questionOpen'],
    ])
    expect(w.core.state.submits).toEqual([])
  })

  it('waitingQuestion advances to enqueued after the question closes, on inputResult and on idle', async () => {
    const w = world()
    w.open('s1')
    w.open('s2')
    w.core.state.questions.add('s1')
    w.core.state.questions.add('s2')
    await w.admit('s1', 'k1')
    await w.admit('s2', 'k1')
    await w.engine.advance('s1')
    expect(w.row('s1', 'k1')?.state).toBe('waitingQuestion')
    w.core.state.questions.clear()
    expect(await w.engine.result(w.ctx('s1'), { key: 'k1' })).toMatchObject({
      state: 'enqueued',
      reason: 'eligible',
    })
    await w.engine.advance('s2')
    expect(w.row('s2', 'k1')).toMatchObject({ state: 'enqueued', reason: 'eligible' })
    expect(w.core.state.submits.map((s) => s.sessionId)).toEqual(['s1', 's2'])
  })

  it('first submit does not dedupe; a row with item_command_id but no confirmed submitted_seq resubmits with dedupe', async () => {
    let crash = true
    const w = world({
      faults: {
        afterSubmit() {
          if (crash) throw new Error('crash')
        },
      },
    })
    w.open('s1')
    await w.admit('s1', 'k1')
    crash = false
    const left = w.row('s1', 'k1')
    expect(left?.itemCommandId).toEqual(expect.any(String))
    expect(left?.submittedSeq).toBe(0)
    // An idle report neither resubmits an unconfirmed input nor scans the whole history for it.
    w.core.state.scans.length = 0
    await w.engine.advance('s1')
    expect(w.core.state.scans).toEqual([])
    await w.engine.result(w.ctx('s1'), { key: 'k1' })
    expect(w.core.state.submits.map((s) => s.dedupe)).toEqual([false])
    await w.engine.sweep()
    expect(w.core.state.submits.map((s) => [s.commandId, s.dedupe])).toEqual([
      [left?.itemCommandId, false],
      [left?.itemCommandId, true],
    ])
    expect(w.row('s1', 'k1')?.submittedSeq).toBe(w.core.state.inbox.get('s1')?.[0]?.seq)
    expect(w.core.state.inbox.get('s1')).toHaveLength(1)
    w.core.take('s1')
    await w.engine.advance('s1')
    expect(w.row('s1', 'k1')?.state).toBe('consumed')
    expect(w.core.ran('s1', 'text of s1-k1')).toBe(1)
  })

  it('consumed scan starts at submitted_seq and records turn and seq', async () => {
    const w = world()
    w.open('s1')
    await w.admit('s1', 'k0')
    w.core.take('s1')
    await w.engine.advance('s1')
    await w.admit('s1', 'k1')
    const submitted = w.row('s1', 'k1')
    expect(submitted?.submittedSeq).toBeGreaterThan(1)
    const message = w.core.take('s1')
    w.core.state.scans.length = 0
    await w.engine.advance('s1')
    expect(w.core.state.scans).toEqual([
      { sessionId: 's1', commandId: submitted?.itemCommandId, fromSeq: submitted?.submittedSeq },
    ])
    expect(w.row('s1', 'k1')).toMatchObject({
      state: 'consumed',
      consumedTurn: message?.turn,
      consumedSeq: message?.seq,
    })
  })

  it('withdraw on revoke: held → needsOwner grantRevoked; submitted → withdrawn then needsOwner; taken → consumed', async () => {
    const w = world()
    for (const id of ['held', 'queued', 'taken', 'legacy']) w.open(id)
    await w.busy('held', 'k1')
    await w.admit('queued', 'k1')
    await w.admit('taken', 'k1')
    const message = w.core.take('taken')
    await w.legacy('legacy', 'k1')
    await w.engine.withdraw(owner, '/elsewhere')
    expect(w.row('held', 'k1')?.state).toBe('enqueued')
    await w.engine.withdraw(owner)
    expect(w.row('held', 'k1')).toMatchObject({ state: 'needsOwner', reason: 'grantRevoked' })
    expect(w.row('queued', 'k1')).toMatchObject({
      state: 'needsOwner',
      reason: 'grantRevoked',
      submittedSeq: null,
    })
    expect(w.core.state.inbox.get('queued')).toEqual([])
    expect(w.row('taken', 'k1')).toMatchObject({ state: 'consumed', consumedSeq: message?.seq })
    expect(w.row('legacy', 'k1')?.state).toBe('recoveryUnknown')
    // A final row never moves again.
    const consumed = w.row('taken', 'k1')
    await w.engine.withdraw(owner)
    await w.engine.sweep()
    expect(w.row('taken', 'k1')).toEqual(consumed)
    expect(w.core.ran('queued', 'text of queued-k1')).toBe(0)
  })

  it('the engine never moves a consumed or retained row, though the records table would', async () => {
    const w = world()
    w.open('s1')
    await w.admit('s1', 'k1')
    w.core.take('s1')
    await w.engine.advance('s1')
    await w.legacy('s1', 'k2')
    await w.engine.decide('s1', 'k2', 'retain', w.row('s1', 'k2')?.version ?? 0)
    const progress = inputProgress({
      ports: { sessions: {}, records: w.records } as never,
      inputs: w.inputs,
      serial: (_key, work) => work(),
      gatesPass: async () => true,
      actor: () => ({}) as never,
    })
    for (const key of ['k1', 'k2']) {
      const final = w.row('s1', key)
      expect(final?.state).toMatch(/^(consumed|retained)$/u)
      expect(
        progress.move(final as NonNullable<typeof final>, { state: 'needsOwner', reason: 'grantRevoked' }),
      ).toBeUndefined()
      expect(w.row('s1', key)).toEqual(final)
    }
  })

  it('decide deliver / retain / discard bumps version, records by owner, refuses a stale version and a terminal row', async () => {
    const w = world()
    w.open('s1')
    await w.legacy('s1', 'keep')
    await w.legacy('s1', 'drop')
    const keep = w.row('s1', 'keep')
    await expect(w.engine.decide('s1', 'keep', 'retain', (keep?.version ?? 0) + 1)).rejects.toMatchObject(
      refusedWith('OWNER_INPUT_STALE'),
    )
    expect(await w.engine.decide('s1', 'keep', 'retain', keep?.version ?? 0)).toMatchObject({
      state: 'retained',
      reason: 'ownerRetained',
      version: (keep?.version ?? 0) + 1,
    })
    expect(w.row('s1', 'keep')?.history.at(-1)?.by).toBe('owner')
    const drop = w.row('s1', 'drop')
    expect(await w.engine.decide('s1', 'drop', 'discard', drop?.version ?? 0)).toMatchObject({
      state: 'retained',
      reason: 'ownerDiscarded',
    })
    expect(w.row('s1', 'drop')?.text).toBeNull()
    const kept = w.row('s1', 'keep')
    await expect(w.engine.decide('s1', 'keep', 'deliver', kept?.version ?? 0)).rejects.toMatchObject(
      refusedWith('OWNER_INPUT_FINAL'),
    )
    await expect(w.engine.decide('s1', 'missing', 'retain', 1)).rejects.toMatchObject(
      refusedWith('OWNER_INPUT_UNKNOWN'),
    )
    expect(w.core.state.submits).toEqual([])
  })

  it('deliver without stored text is refused; deliver re-runs the submit checks', async () => {
    const w = world()
    w.open('s1')
    await w.engine.admit(
      w.ctx('s1'),
      { key: 'blank', target: w.target('s1'), input: ownerMessage('r0') },
      undefined,
    )
    await expect(w.engine.decide('s1', 'blank', 'deliver', 2)).rejects.toMatchObject(
      refusedWith('OWNER_INPUT_NO_TEXT'),
    )
    await w.legacy('s1', 'old')
    w.gates.pass = false
    expect(await w.engine.decide('s1', 'old', 'deliver', w.row('s1', 'old')?.version ?? 0)).toMatchObject({
      state: 'needsOwner',
      reason: 'grantRevoked',
    })
    expect(
      w
        .row('s1', 'old')
        ?.history.slice(-2)
        .map((entry) => entry.by),
    ).toEqual(['owner', 'platform'])
    w.gates.pass = true
    // Withdrawn from the core inbox, then delivered again under a fresh id without dedupe.
    await w.admit('s1', 'k1')
    const first = w.row('s1', 'k1')?.itemCommandId
    await w.engine.withdraw(owner)
    expect(await w.engine.decide('s1', 'k1', 'deliver', w.row('s1', 'k1')?.version ?? 0)).toMatchObject({
      state: 'enqueued',
    })
    const last = w.core.state.submits.at(-1)
    expect(last).toMatchObject({ dedupe: false, commandId: expect.stringMatching(/:v\d+$/u) })
    expect(last?.commandId.startsWith(`${first}:v`)).toBe(true)
    expect(w.core.state.submits.filter((s) => s.text === 'old words')).toEqual([])
  })

  it('sweep advances every session with work and skips the rest', async () => {
    const w = world()
    for (const id of ['s1', 's2', 's3']) w.open(id)
    await w.busy('s1', 'k1')
    await w.busy('s3', 'k1')
    await w.admit('s2', 'k1')
    w.core.take('s2')
    await w.engine.advance('s2')
    expect(w.row('s2', 'k1')?.state).toBe('consumed')
    w.core.state.submits.length = 0
    w.core.state.scans.length = 0
    await w.engine.sweep()
    expect(w.core.state.submits.map((s) => s.sessionId).sort()).toEqual(['s1', 's3'])
    expect(w.core.state.scans.filter((s) => s.sessionId === 's2')).toEqual([])
  })
})
