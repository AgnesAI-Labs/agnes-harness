import { describe, expect, it } from 'vitest'
import { RECOVERY_CONTINUATION_TEXT } from '../src/supervisor/managed-input-admission.js'
import { inputWorld, owner, receipt } from './fixtures/fake-input-ports.js'

const refused = (reason: string) => ({ data: { code: 'CAPABILITY_DENIED', reason } })
const ownerMessage = (receiptId: string) => ({ kind: 'ownerMessage' as const, receiptId })

function world(over: Parameters<typeof inputWorld>[0] = {}) {
  const w = inputWorld(over)
  w.open('s1')
  const admit = (
    key: string,
    input: unknown,
    resolution = receipt('r1'),
    sessionId = 's1',
    target = w.target(sessionId),
  ) => w.engine.admit(w.ctx(sessionId), { key, target, input }, resolution)
  return { ...w, admit }
}

describe('owner input admission', () => {
  it('ownerMessage on an idle session submits once and returns enqueued eligible', async () => {
    const w = world()
    const result = await w.admit('k1', ownerMessage('r1'))
    expect(result).toMatchObject({ state: 'enqueued', reason: 'eligible', inputId: 'k1' })
    expect(w.core.state.submits).toEqual([
      {
        sessionId: 's1',
        commandId: expect.stringMatching(/:input:[0-9a-f]{32}$/u),
        dedupe: false,
        text: 'text of r1',
      },
    ])
    expect(w.core.state.inbox.get('s1')).toHaveLength(1)
  })

  it('busy session holds the input as enqueued busy without touching the core inbox', async () => {
    const w = world()
    w.core.state.running.add('s1')
    // Straight from queued to held: no extra transition while the session is busy.
    expect(await w.admit('k1', ownerMessage('r1'))).toMatchObject({
      state: 'enqueued',
      reason: 'busy',
      version: 2,
    })
    expect(w.core.state.submits).toEqual([])
    expect(w.inputs.get(owner, 's1', 'k1')?.text).toBe('text of r1')
  })

  it('identical repeat returns the stored result without a second submit', async () => {
    const w = world()
    const first = await w.admit('k1', ownerMessage('r1'))
    expect(await w.admit('k1', ownerMessage('r1'))).toEqual(first)
    expect(w.core.state.submits).toHaveLength(1)
  })

  it.each([
    ['target', ownerMessage('r1'), ownerMessage('r1'), { taskGeneration: 2 }],
    ['kind', ownerMessage('r1'), { kind: 'recoveryContinuation', turnEndSeq: 3 }, {}],
    ['receiptId', ownerMessage('r1'), ownerMessage('r2'), {}],
    [
      'turnEndSeq',
      { kind: 'recoveryContinuation', turnEndSeq: 5 },
      { kind: 'recoveryContinuation', turnEndSeq: 6 },
      {},
    ],
  ])(
    'same key with any different request throws OWNER_INPUT_KEY_REUSED: %s',
    async (_name, first, second, target) => {
      const w = world()
      await w.admit('k1', first)
      await expect(w.admit('k1', second, receipt('r2'), 's1', w.target('s1', target))).rejects.toMatchObject(
        refused('OWNER_INPUT_KEY_REUSED'),
      )
    },
  )

  it.each([
    ['startKey', { startKey: 'start-other' }],
    ['taskId', { taskId: 'task-2' }],
    ['generation', { taskGeneration: 2 }],
  ])('target mismatch throws OWNER_INPUT_TARGET_MISMATCH: %s', async (_name, target) => {
    const w = world()
    await expect(
      w.admit('k1', ownerMessage('r1'), receipt('r1'), 's1', w.target('s1', target)),
    ).rejects.toMatchObject(refused('OWNER_INPUT_TARGET_MISMATCH'))
    expect(w.inputs.get(owner, 's1', 'k1')).toBeUndefined()
  })

  it('an unbound session is bound only by its own manager naming its own start key', async () => {
    const w = world()
    w.open('s0', null)
    const stranger = { ...w.ctx('s0'), owner: 'another#row' }
    await expect(
      w.engine.admit(
        stranger,
        { key: 'k1', target: w.target('s0'), input: ownerMessage('r1') },
        receipt('r1'),
      ),
    ).rejects.toMatchObject(refused('OWNER_INPUT_TARGET_MISMATCH'))
    await expect(
      w.admit('k1', ownerMessage('r1'), receipt('r1'), 's0', w.target('s0', { startKey: 'start-s1' })),
    ).rejects.toMatchObject(refused('OWNER_INPUT_TARGET_MISMATCH'))
    expect(w.records.binding('s0')).toBeUndefined()
    expect(await w.admit('k1', ownerMessage('r1'), receipt('r1'), 's0')).toMatchObject({ state: 'enqueued' })
    expect(w.records.binding('s0')).toMatchObject({ taskId: 'task-1', taskGeneration: 1, inputDigest: null })
  })

  it('archived session throws SESSION_ARCHIVED, an owner archive in the Web included', async () => {
    const w = world()
    w.records.markArchived('s1')
    await expect(w.admit('k1', ownerMessage('r1'))).rejects.toMatchObject(refused('SESSION_ARCHIVED'))
    w.open('s2')
    w.core.state.archived.add('s2')
    await expect(w.admit('k1', ownerMessage('r1'), receipt('r1'), 's2')).rejects.toMatchObject(
      refused('SESSION_ARCHIVED'),
    )
    expect(w.inputs.get(owner, 's1', 'k1')).toBeUndefined()
    expect(w.inputs.get(owner, 's2', 'k1')).toBeUndefined()
  })

  it('gate failure at admission records and returns needsOwner grantRevoked without throwing', async () => {
    const w = world()
    w.gates.pass = false
    expect(await w.admit('k1', ownerMessage('r1'))).toMatchObject({
      state: 'needsOwner',
      reason: 'grantRevoked',
    })
    expect(w.inputs.get(owner, 's1', 'k1')?.state).toBe('needsOwner')
    expect(w.core.state.submits).toEqual([])
  })

  it('unresolved receipt returns needsOwner receiptUnknown; a changed pairing returns needsOwner pairingChanged', async () => {
    const w = world()
    const unknown = { kind: 'unresolved', receiptId: 'r1', reason: 'receiptUnknown' } as const
    const changed = { kind: 'unresolved', receiptId: 'r2', reason: 'pairingChanged' } as const
    expect(await w.admit('k1', ownerMessage('r1'), unknown)).toMatchObject({
      state: 'needsOwner',
      reason: 'receiptUnknown',
    })
    expect(await w.admit('k2', ownerMessage('r2'), changed)).toMatchObject({
      state: 'needsOwner',
      reason: 'pairingChanged',
    })
    expect(w.inputs.get(owner, 's1', 'k1')?.text).toBeNull()
    expect(w.inputs.get(owner, 's1', 'k2')?.text).toBeNull()
    expect(w.core.state.submits).toEqual([])
  })

  it('a resolution for another receipt than the request names returns needsOwner receiptUnknown and stores no text', async () => {
    const w = world()
    expect(await w.admit('k1', ownerMessage('r1'), receipt('r9', 'not this one'))).toMatchObject({
      state: 'needsOwner',
      reason: 'receiptUnknown',
    })
    expect(w.inputs.get(owner, 's1', 'k1')).toMatchObject({
      text: null,
      receiptId: null,
      contentDigest: null,
    })
    expect(w.core.state.submits).toEqual([])
    // The receipt the resolution named stays free for its own admission.
    expect(await w.admit('k2', ownerMessage('r9'), receipt('r9'))).toMatchObject({ state: 'enqueued' })
  })

  it('ownerMessage without a resolution is treated as receiptUnknown, and a text field in the request is ignored', async () => {
    const w = world()
    const smuggled = { ...ownerMessage('r1'), text: 'injected' }
    expect(
      await w.engine.admit(w.ctx('s1'), { key: 'k1', target: w.target('s1'), input: smuggled }, undefined),
    ).toMatchObject({
      state: 'needsOwner',
      reason: 'receiptUnknown',
    })
    expect(w.inputs.get(owner, 's1', 'k1')?.text).toBeNull()
    await w.admit('k2', { ...ownerMessage('r2'), text: 'injected' }, receipt('r2'))
    expect(w.core.state.submits.map((s) => s.text)).toEqual(['text of r2'])
    // The ignored field is not part of the request either: the same key without it is the same request.
    await expect(w.admit('k2', ownerMessage('r2'), receipt('r2'))).resolves.toMatchObject({ inputId: 'k2' })
  })

  it('one receipt binds one admission: a second key with the same receipt gets needsOwner receiptUnknown', async () => {
    const w = world()
    await w.admit('k1', ownerMessage('r1'))
    expect(await w.admit('k2', ownerMessage('r1'))).toMatchObject({
      state: 'needsOwner',
      reason: 'receiptUnknown',
    })
    expect(await w.admit('k2', ownerMessage('r1'))).toMatchObject({ state: 'needsOwner', version: 1 })
    expect(w.core.state.submits).toHaveLength(1)
  })

  it('open question records waitingQuestion and does not submit', async () => {
    const w = world()
    w.core.state.questions.add('s1')
    expect(await w.admit('k1', ownerMessage('r1'))).toMatchObject({
      state: 'waitingQuestion',
      reason: 'questionOpen',
    })
    expect(w.core.state.submits).toEqual([])
  })

  it('recoveryContinuation submits the platform text only for the latest cancelled or failed turn with no later start', async () => {
    const w = world()
    w.core.state.lastEnd.set('s1', { seq: 9, reason: 'interrupted', laterStart: false })
    expect(await w.admit('k1', { kind: 'recoveryContinuation', turnEndSeq: 9 })).toMatchObject({
      state: 'enqueued',
    })
    expect(w.core.state.submits.map((s) => s.text)).toEqual([RECOVERY_CONTINUATION_TEXT])
    for (const [sessionId, end, turnEndSeq] of [
      ['s2', { seq: 9, reason: 'error', laterStart: false }, 8],
      ['s3', { seq: 9, reason: 'completed', laterStart: false }, 9],
      ['s4', { seq: 9, reason: 'aborted', laterStart: true }, 9],
      ['s5', undefined, 9],
    ] as const) {
      w.open(sessionId)
      if (end) w.core.state.lastEnd.set(sessionId, end)
      const result = await w.admit('k1', { kind: 'recoveryContinuation', turnEndSeq }, undefined, sessionId)
      expect(result).toMatchObject({ state: 'recoveryUnknown', reason: 'recoveryUnverified' })
    }
    expect(w.core.state.submits).toHaveLength(1)
  })

  it('a queued row left by a crash after reserve is completed by the next admitInput', async () => {
    let crash = true
    const w = world({
      faults: {
        afterReserve() {
          if (crash) throw new Error('crash')
        },
      },
    })
    await expect(w.admit('k1', ownerMessage('r1'))).rejects.toThrow('crash')
    crash = false
    expect(await w.engine.result(w.ctx('s1'), { key: 'k1' })).toMatchObject({ state: 'queued' })
    await w.engine.sweep()
    expect(w.core.state.submits).toEqual([])
    expect(await w.admit('k1', ownerMessage('r1'))).toMatchObject({ state: 'enqueued', reason: 'eligible' })
    expect(w.core.state.submits).toHaveLength(1)
  })

  it('inputResult only reports admissions, even when a send has used the same key', async () => {
    const w = world()
    for (const state of ['pending', 'sent'] as const) {
      w.records.setSend(owner, 's1', 'send-key', state)
      expect(await w.engine.result(w.ctx('s1'), { key: 'send-key' })).toEqual({
        state: 'absent',
        historyCoverage: 'complete',
      })
    }
    expect(w.core.state.submits).toEqual([])
  })

  it('inputResult returns absent complete for both bound and unbound sessions', async () => {
    const w = world()
    w.open('s0', null)
    expect(await w.engine.result(w.ctx('s1'), { key: 'nope' })).toEqual({
      state: 'absent',
      historyCoverage: 'complete',
    })
    expect(await w.engine.result(w.ctx('s0'), { key: 'nope' })).toEqual({
      state: 'absent',
      historyCoverage: 'complete',
    })
  })

  it('every state change bumps version by one; reviewLocation encodes session and key; consumed carries turn and seq', async () => {
    const w = world()
    w.open('s/1 x')
    const result = await w.admit('k 1&x', ownerMessage('r1'), receipt('r1'), 's/1 x')
    expect(result).toMatchObject({ reviewLocation: '/?session=s%2F1%20x&ownerInput=k%201%26x' })
    const message = w.core.take('s/1 x')
    const consumed = await w.engine.result(w.ctx('s/1 x'), { key: 'k 1&x' })
    expect(consumed).toMatchObject({ state: 'consumed', turn: message?.turn, seq: message?.seq })
    const row = w.inputs.get(owner, 's/1 x', 'k 1&x')
    expect(row?.history.map((entry) => entry.version)).toEqual(
      Array.from({ length: row?.version ?? 0 }, (_, index) => index + 1),
    )
    expect(consumed).toMatchObject({ version: row?.version })
  })

  it('refuses malformed requests with INVALID_PARAMS before storing them', async () => {
    const w = world()
    for (const input of [
      ownerMessage('a\0b'),
      { kind: 'ownerMessage' },
      { kind: 'recoveryContinuation', turnEndSeq: 0 },
      { kind: 'legacyOwnerMessage', text: 'unsigned owner text', originalInbox: null },
      { kind: 'other' },
    ])
      await expect(w.admit('k1', input)).rejects.toMatchObject({ data: { code: 'INVALID_PARAMS' } })
    await expect(w.engine.result(w.ctx('s1'), { key: '' })).rejects.toMatchObject({
      data: { code: 'INVALID_PARAMS' },
    })
    expect(w.inputs.get(owner, 's1', 'k1')).toBeUndefined()

    await w.admit('retired-row', ownerMessage('r1'), {
      kind: 'unresolved',
      receiptId: 'r1',
      reason: 'receiptUnknown',
    })
    w.table.exec("UPDATE managed_session_inputs SET kind = 'legacyOwnerMessage' WHERE key = 'retired-row'")
    await w.admit('valid-row', ownerMessage('r2'), {
      kind: 'unresolved',
      receiptId: 'r2',
      reason: 'receiptUnknown',
    })
    expect(w.inputs.get(owner, 's1', 'retired-row')).toBeUndefined()
    await expect(w.admit('retired-row', ownerMessage('r3'), receipt('r3'))).rejects.toMatchObject(
      refused('OWNER_INPUT_KEY_REUSED'),
    )
    expect(w.inputs.attention(Number.MAX_SAFE_INTEGER, 10).map((entry) => entry.key)).toEqual(['valid-row'])
  })
})
