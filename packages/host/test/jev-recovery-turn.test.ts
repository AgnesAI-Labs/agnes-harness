import {
  budgetOverrideEvent,
  MemoryStorage,
  openTracked,
  SessionImpl,
  scanAll,
  TURN_BUDGET_EVENT,
} from '@agnes/core'
import { actor, fakeProvider, openSession } from '@agnes/core/testkit'
import type { IntentId, RecordId, RuntimeLedger, RuntimeRecord, TurnId } from '@agnes/jev-runtime'
import { describe, expect, it } from 'vitest'
import { claimJevRecoveryTurn } from '../src/runtime/jev-recovery-turn.js'

const owner = { id: 'jevloop', version: '1' }
const selection = { backend: 'jev', endpoint: 'https://decision.invalid', model: 'jev-test' }
const binding = 'x/host/jev-loop/turn-decision'

function unknown(turn: TurnId, suffix = ''): RuntimeRecord[] {
  const id = (name: string) => `${name}${suffix}` as RecordId
  const intentId = `intent${suffix}` as IntentId
  const base = { version: 1 as const, turn }
  return [
    {
      ...base,
      id: id('request'),
      kind: 'model.requested',
      call: {
        purpose: 'decision',
        backend: selection.backend,
        endpoint: selection.endpoint,
        requestedModel: selection.model,
        codec: 'systemone-json-v1',
        input: {},
        inputCursor: null,
      },
    },
    {
      ...base,
      id: id('response'),
      kind: 'model.settled',
      requested: id('request'),
      settlement: { output: {} },
    },
    {
      ...base,
      id: id('selected'),
      kind: 'decision.selected',
      requested: id('request'),
      phase: 'ACT',
      operation: 'write',
      confidence: 0.9,
    },
    {
      ...base,
      id: id('intended'),
      kind: 'action.intended',
      decision: id('selected'),
      intent: {
        id: intentId,
        tool: 'write',
        toolRevision: 'v1',
        arguments: { path: 'note.txt', content: 'desired' },
        effectClass: 'workspace_mutation',
        environmentEpoch: 'epoch' as never,
      },
    },
    { ...base, id: id('dispatching'), kind: 'action.dispatching', intentId, epoch: 'epoch' as never },
    {
      ...base,
      id: id('settled'),
      kind: 'action.settled',
      intentId,
      effect: 'unknown',
      observations: [],
      outcome: { kind: 'error', content: [], directive: { conclude: false, additions: [] } },
    },
  ]
}

async function fixture(
  options: {
    binding?: boolean
    duplicateBinding?: boolean
    duplicateBudget?: boolean
    untrustedBinding?: boolean
    budget?: number
    records?: RuntimeRecord[]
  } = {},
) {
  const baseline = await openSession({ provider: fakeProvider([]) })
  await baseline.session.close()
  const tracked = await openTracked({
    storage: new MemoryStorage(),
    key: 'recovery',
    writerRunId: 'recovery-writer',
    ttlMs: 60_000,
    clock: baseline.session.d.clock,
    ids: baseline.session.d.ids,
    runtimeIdentity: owner,
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
  })
  const session = new SessionImpl({ ...baseline.session.d, ...tracked, loopIdentity: owner })
  await session.start()
  const runtimeId = `${session.key}:${session.lane}:1` as TurnId
  const records = options.records ?? unknown(runtimeId)
  const ledger: RuntimeLedger<number> = {
    read: async () => records.map((record, index) => ({ cursor: index + 1, record })),
    commit: async () => {
      throw new Error('claim must not write the portable ledger')
    },
    cursorText: String,
  }
  const decision = () =>
    session.ev(
      binding,
      { turn: 1, itemId: 'original', selection },
      { ignorable: true, ...(options.untrustedBinding ? { trust: 'untrusted' as const } : {}) },
    )
  const budget = () =>
    budgetOverrideEvent(TURN_BUDGET_EVENT, actor, {
      turn: 1,
      itemId: 'original',
      creditsCap: options.budget ?? 7,
    })
  await session.d.log.append([
    session.ev(
      'user/message',
      { itemId: 'original', kind: 'prompt', content: [{ type: 'text', text: 'Original task' }] },
      { origin: 'principal', actor, trust: 'trusted', surfaceOp: 'append' },
    ),
    session.ev('turn/start', { turn: 1, trigger: 'prompt' }),
    ...(options.binding === false ? [] : [decision()]),
    ...(options.duplicateBinding ? [decision()] : []),
    budget(),
    ...(options.duplicateBudget ? [budget()] : []),
    ...[1, 2, 3, 4].flatMap((step) => [
      session.ev('step/start', { turn: 1, step }),
      session.ev('step/end', { turn: 1, step }),
    ]),
    session.ev('turn/end', { reason: 'blocked', lastAssistantSeq: null }),
  ])
  const rows = () => scanAll((query) => session.scan(query), { toSeq: session.lastSeq })
  const claim = (signal = new AbortController().signal) =>
    session.locked(() => claimJevRecoveryTurn(session, ledger, signal))
  return { session, ledger, records, runtimeId, rows, claim, close: () => session.close() }
}

describe('Jev closed-turn effect recovery presentation', () => {
  it('opens real presentation with the original logical identity, selection and cap without new input', async () => {
    const h = await fixture({ budget: 0 })
    try {
      const before = await h.rows()
      const result = await h.claim()
      expect(result).toEqual({ turn: 2, runtimeTurn: 1, selection, budget: 0 })
      expect(h.session.state.openTurn.get(h.session.lane)?.turn).toBe(2)
      const rows = (await h.rows()).slice(before.length)
      expect(rows.map((row) => row.type)).toEqual(['turn/start', binding, TURN_BUDGET_EVENT])
      expect(rows[0]?.data).toEqual({ turn: 2, trigger: 'follow_up', continues: { turn: 1, step: 4 } })
      expect(rows[1]).toMatchObject({
        origin: 'system',
        trust: 'trusted',
        data: { turn: 2, runtimeTurn: 1, selection },
      })
      expect(rows[2]?.data).toEqual({ turn: 2, itemId: 'original', creditsCap: 0 })
      expect((await h.rows()).filter((row) => row.type === 'user/message')).toHaveLength(1)
    } finally {
      await h.close()
    }
  })

  it('keeps the original portable turn and cap across repeated closed continuations', async () => {
    const h = await fixture()
    try {
      await h.claim()
      await h.session.d.log.append([
        ...[1, 2].flatMap((step) => [
          h.session.ev('step/start', { turn: 2, step }),
          h.session.ev('step/end', { turn: 2, step }),
        ]),
        h.session.ev('turn/end', { reason: 'blocked', lastAssistantSeq: null }),
      ])
      expect(await h.claim()).toEqual({ turn: 3, runtimeTurn: 1, selection, budget: 7 })
      expect((await h.rows()).filter((row) => row.type === 'turn/start').at(-1)?.data).toEqual({
        turn: 3,
        trigger: 'follow_up',
        continues: { turn: 2, step: 2 },
      })
    } finally {
      await h.close()
    }
  })

  it('falls back to the original durable decision coordinates when its private binding is absent', async () => {
    const h = await fixture({ binding: false })
    try {
      expect((await h.claim())?.selection).toEqual(selection)
    } finally {
      await h.close()
    }
  })

  it.each(['no-unknown', 'host-cancel', 'portable-cancel', 'signal-cancel'] as const)(
    'does not create presentation after %s',
    async (mode) => {
      const h = await fixture(mode === 'no-unknown' ? { records: [] } : {})
      try {
        if (mode === 'host-cancel')
          await h.session.d.log.append([
            h.session.ev('runtime/cancel', { runtime: owner, turnId: h.runtimeId, by: actor }),
          ])
        if (mode === 'portable-cancel')
          h.records.push({
            version: 1,
            id: 'cancelled' as RecordId,
            turn: h.runtimeId,
            kind: 'run.stopped',
            reason: 'cancelled',
            detail: 'User cancelled',
            unresolved: ['intent' as IntentId],
          })
        const controller = new AbortController()
        if (mode === 'signal-cancel') controller.abort()
        const before = h.session.lastSeq
        expect(await h.claim(controller.signal)).toBeUndefined()
        expect(h.session.lastSeq).toBe(before)
        expect(h.session.state.openTurn.has(h.session.lane)).toBe(false)
      } finally {
        await h.close()
      }
    },
  )

  it('does not revive a cancellation on an earlier presentation continuation', async () => {
    const h = await fixture()
    try {
      await h.claim()
      await h.session.d.log.append([
        h.session.ev('runtime/cancel', {
          runtime: owner,
          turnId: `${h.session.key}:${h.session.lane}:2`,
          by: actor,
        }),
        h.session.ev('turn/end', { reason: 'blocked', lastAssistantSeq: null }),
      ])
      const before = h.session.lastSeq
      expect(await h.claim()).toBeUndefined()
      expect(h.session.lastSeq).toBe(before)
    } finally {
      await h.close()
    }
  })

  it.each(['foreign', 'noncanonical', 'multiple'] as const)(
    'rejects %s logical identities before appending',
    async (mode) => {
      const h = await fixture()
      try {
        if (mode === 'multiple')
          h.records.push(...unknown(`${h.session.key}:${h.session.lane}:2` as TurnId, '-second'))
        else {
          const turn = (
            mode === 'foreign' ? 'other:lane:1' : `${h.session.key}:${h.session.lane}:01`
          ) as TurnId
          h.records.splice(0, h.records.length, ...unknown(turn))
        }
        const before = h.session.lastSeq
        await expect(h.claim()).rejects.toMatchObject({ code: 'E_RELATION' })
        expect(h.session.lastSeq).toBe(before)
      } finally {
        await h.close()
      }
    },
  )

  it.each([{ duplicateBinding: true }, { duplicateBudget: true }, { untrustedBinding: true }])(
    'rejects ambiguous or untrusted binding %j',
    async (options) => {
      const h = await fixture(options)
      try {
        const before = h.session.lastSeq
        await expect(h.claim()).rejects.toMatchObject({ code: 'E_RELATION' })
        expect(h.session.lastSeq).toBe(before)
      } finally {
        await h.close()
      }
    },
  )

  it.each(['changed-cap', 'changed-selection', 'wrong-predecessor', 'wrong-step'] as const)(
    'rejects a continuation with %s',
    async (mode) => {
      const h = await fixture()
      try {
        await h.session.d.log.append([
          h.session.ev('turn/start', {
            turn: 2,
            trigger: 'follow_up',
            continues: { turn: mode === 'wrong-predecessor' ? 0 : 1, step: mode === 'wrong-step' ? 0 : 4 },
          }),
          h.session.ev(
            binding,
            {
              turn: 2,
              runtimeTurn: 1,
              selection: mode === 'changed-selection' ? { ...selection, model: 'other' } : selection,
            },
            { ignorable: true },
          ),
          budgetOverrideEvent(TURN_BUDGET_EVENT, actor, {
            turn: 2,
            itemId: 'original',
            creditsCap: mode === 'changed-cap' ? 8 : 7,
          }),
          h.session.ev('turn/end', { reason: 'blocked', lastAssistantSeq: null }),
        ])
        const before = h.session.lastSeq
        await expect(h.claim()).rejects.toMatchObject({ code: 'E_RELATION' })
        expect(h.session.lastSeq).toBe(before)
      } finally {
        await h.close()
      }
    },
  )

  it('does not append when cancellation arrives while reading the portable prefix', async () => {
    const h = await fixture()
    try {
      const controller = new AbortController()
      const ledger = {
        ...h.ledger,
        read: async () => {
          const entries = await h.ledger.read()
          controller.abort()
          return entries
        },
      }
      const before = h.session.lastSeq
      expect(
        await h.session.locked(() => claimJevRecoveryTurn(h.session, ledger, controller.signal)),
      ).toBeUndefined()
      expect(h.session.lastSeq).toBe(before)
    } finally {
      await h.close()
    }
  })
})
