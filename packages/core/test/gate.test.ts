import { presetDefaults, readPreset } from '@agnes/core-common/step/preset'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { CompactionRunner } from '../src/step/compaction.js'
import {
  compactionSettingsFor,
  compactionTriggerTokens,
  contextTokens,
  nearlyFull,
} from '../src/step/gate.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, writeTool } from './helpers/open-session.js'

const sig = () => new AbortController().signal

/** A model record as a real registry publishes it; only `route`/`id`/`contextWindow` matter here. */
const modelRecord = (route: string, id: string, contextWindow: number): ModelRecord => ({
  id,
  name: id,
  api: 'openai-completions',
  route,
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow,
  maxTokens: 1024,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})

describe('retired contract review', () => {
  it.each(
    ['main', 'secondary'].flatMap((lane) =>
      [
        { status: 'ran', trusted: true, ending: 'open', refused: true },
        { status: 'ran', trusted: true, ending: 'parked', refused: true },
        { status: 'ran', trusted: true, ending: 'parked-then-unrelated', refused: true },
        { status: 'ran', trusted: true, ending: 'completed', refused: false },
        { status: 'ran', trusted: true, ending: 'next-turn', refused: false },
        { status: 'ran', trusted: false, ending: 'open', refused: false },
        { status: 'skipped:disabled', trusted: true, ending: 'open', refused: false },
      ].map((row) => ({ ...row, lane })),
    ),
  )('restores historical review records safely: %j', async ({ status, trusted, ending, refused, lane }) => {
    const h = await openSession({ provider: fakeProvider([textTurn('done')]), lane })
    try {
      await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'work' }] })
      await h.session.step()
      await h.log.append([
        h.session.ev(
          'x/core/completion-gate',
          {
            diagnostic: 'completion_gate_contract_review',
            status,
          },
          {
            ignorable: true,
            ...(trusted ? {} : { origin: 'principal' as const, trust: 'untrusted' as const }),
          },
        ),
      ])
      if (ending === 'parked' || ending === 'parked-then-unrelated') await h.session.endTurn('parked')
      if (ending === 'parked-then-unrelated') {
        await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'unrelated' }] })
        expect((await h.session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
      }
      if (ending === 'completed' || ending === 'next-turn') {
        expect((await h.session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
      }
      if (ending === 'next-turn') {
        await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'new work' }] })
        await h.session.step()
      }
      const otherLane = lane === 'main' ? 'secondary' : 'main'
      await h.session.append([
        h.session.ev('turn/start', { turn: 1, trigger: 'prompt' }, { lane: otherLane }),
        h.session.ev('turn/end', { reason: 'completed', lastAssistantSeq: null }, { lane: otherLane }),
      ])
      const rows = await h.log.scan({ limit: 1000 })
      const storage = MemoryStorage.fromEvents('k', rows, {
        opCells: h.log.allRegisters().filter((row) => row.register === 'op.state'),
      })
      const provider = fakeProvider([textTurn('must not run during open')])
      if (refused) {
        await expect(openSession({ storage, provider, lane })).rejects.toMatchObject({
          code: 'E_UNSUPPORTED',
        })
        expect(await storage.scan('k', { limit: 1000 })).toEqual(rows)
      } else {
        const reopened = await openSession({ storage, provider, lane })
        await reopened.session.close()
      }
      expect(provider.calls).toBe(0)
    } finally {
      await h.session.close()
    }
  })
  it.each([false, true])(
    'finishes a mutating task without an extra review (legacy flag %s)',
    async (enabled) => {
      const registry = new ToolRegistry()
      registry.add(writeTool(), { source: 'test', trust: 'builtin' })
      const provider = fakeProvider([toolTurn('write_note', {}), textTurn('done')])
      const preset = readPreset({ completion_gate: { contract_review: enabled } }, 'legacy')
      const h = await openSession({ provider, registry, preset })
      try {
        await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'Write a note.' }] })
        expect((await h.session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
        expect(provider.calls).toBe(2)
        expect(await h.log.scan({ type: 'x/core/completion-gate', limit: 20 })).toEqual([])
      } finally {
        await h.session.close()
      }
    },
  )
})

describe('ordinary plan completion gate', () => {
  it.each([
    { enabled: true, minItems: 3, count: 3, repair: true },
    { enabled: false, minItems: 3, count: 3, repair: false },
    { enabled: true, minItems: 4, count: 3, repair: false },
  ])('preserves the configured plan gate: %j', async ({ enabled, minItems, count, repair }) => {
    const provider = fakeProvider([textTurn('draft'), textTurn('done')])
    const h = await openSession({
      provider,
      preset: { ...presetDefaults(), completionGate: { enabled, minItems } },
    })
    try {
      await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'work' }] })
      await h.session.acceptInput()
      await h.session.append([
        h.session.ev(
          'plan.items',
          {
            items: Array.from({ length: count }, (_, id) => ({
              id: String(id),
              text: 'requirement',
              status: 'todo',
            })),
          },
          { register: 'plan.items' },
        ),
      ])
      expect((await h.session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
      expect(provider.calls).toBe(repair ? 2 : 1)
      expect(
        (await h.log.scan({ type: 'repair/decision', limit: 10 })).map(
          (row) => (row.data as { decision: string }).decision,
        ),
      ).toEqual(repair ? ['repair', 'complete'] : [])
      const recovery = await h.log.scan({ type: 'x/core/verifier-recovery', limit: 10 })
      expect(
        recovery.some(
          (row) => (row.data as { diagnostic?: string }).diagnostic === 'completion_gate_stale_plan',
        ),
      ).toBe(repair)
      expect(await h.log.scan({ type: 'x/core/completion-gate', limit: 10 })).toEqual([])
    } finally {
      await h.session.close()
    }
  })
})

describe('contextTokens', () => {
  it('counts from the last non-interrupted ledger entry, not the whole surface', async () => {
    const { session } = await openSession({ provider: fakeProvider([textTurn('ok')]) })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hello' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    // textTurn's usage() reports input:10, output:5 -> the ledger row's own total is 15, and
    // nothing in the surface lands after that row in a plain text turn, so a correct reading adds
    // nothing on top of it.
    expect(contextTokens(session)).toBe(15)

    await session.enqueue('next-turn', { content: [{ type: 'text', text: '12345678' }], actor })
    // One step: acceptInput claims the queued prompt and writes it to the surface, before any new
    // inference (and therefore any new ledger row) runs.
    expect(await session.step()).toEqual({ outcome: 'running', phase: 'checkpoint' })
    // The new message lands after the first turn's ledger row, so it is estimated at chars/4
    // (8 chars -> 2) and added on top of the ledger's 15 instead of recounting the whole surface.
    expect(contextTokens(session)).toBe(17)
  })

  it('includes cache read and write tokens from the latest non-interrupted ledger row', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    await session.append([
      session.ev('cost/ledger', {
        purpose: 'inference',
        effectId: 'cached',
        tokens: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7 },
        creditSource: 'estimated',
        model: 'm',
      }),
    ])
    expect(contextTokens(session)).toBe(17)
    await session.append([
      session.ev('cost/ledger', {
        purpose: 'inference',
        effectId: 'interrupted',
        tokens: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100 },
        creditSource: 'estimated',
        model: 'm',
        interrupted: true,
      }),
    ])
    expect(contextTokens(session)).toBe(17)
  })
})

describe('checkpointRoutine compaction threshold', () => {
  it.each([
    [4096, 128000],
    [8192, 128000],
    [16384, 128000],
    [16385, 128000],
    [32000, 128000],
    [128000, 128000],
    [8192, 8192],
    [16384, 16384],
  ])(
    'answers short prompts within a %s-token window on a %s-token model without asking for a context exception',
    async (window, capacity) => {
      for (const defaults of [false, true]) {
        const provider = fakeProvider([textTurn('ok')])
        provider.models = () => [
          {
            ...modelRecord('default', 'big-model', capacity),
            ...(defaults ? { defaultSettings: { contextWindow: window } } : {}),
          },
        ]
        const { session, log } = await openSession({
          provider,
          compaction: new CompactionRunner({ plan: async () => null, onCompact: async () => undefined }),
          seams: fakeSeams({ approval: { ask: async () => 'rejected' } }),
        })
        if (!defaults)
          await session.setModel({
            slot: 'primary',
            route: 'default',
            model: 'big-model',
            contextWindow: window,
          })
        for (const text of ['hi', 'continue']) {
          await session.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
          expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
        }
        expect((await log.scan({ type: 'assistant/message', limit: 10 })).map((row) => row.data)).toEqual([
          expect.objectContaining({ content: [{ type: 'text', text: 'ok' }] }),
          expect.objectContaining({ content: [{ type: 'text', text: 'ok' }] }),
        ])
        expect(await log.scan({ type: 'decision/state', limit: 10 })).toEqual([])
        expect((await session.projectUI()).usage?.context.window).toBe(window)
      }
    },
  )

  it.each([undefined, 2048])(
    'passes the effective context window %s to compaction and usage',
    async (window) => {
      const provider = fakeProvider([textTurn('a')])
      Object.assign(provider, { models: () => [modelRecord('default', 'big-model', 3210)] })
      const { session } = await openSession({ provider })
      if (window !== undefined)
        await session.setModel({
          slot: 'primary',
          route: 'default',
          model: 'big-model',
          contextWindow: window,
        })
      const seen: number[] = []
      session.compaction = {
        shouldCompact: ({ contextWindow }) => {
          seen.push(contextWindow)
          return false
        },
        onOverflow: () => 'failure',
      }
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
      expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
      // The threshold is checked at both checkpoints a plain text turn passes through (before
      // inference and again on the way to stopGate); both must see the real window, not just one.
      expect(seen).toEqual([window ?? 3210, window ?? 3210])
      expect((await session.projectUI()).usage?.context.window).toBe(window ?? 3210)
    },
  )

  it('quotes the reserved-space threshold when no safe cut exists below the session budget', async () => {
    const provider = fakeProvider([
      textTurn('ok').map((event) =>
        event.type === 'usage' ? { ...event, tokens: { ...event.tokens, input: 9832 } } : event,
      ),
    ])
    provider.models = () => [modelRecord('default', 'big-model', 128000)]
    const { session, log } = await openSession({
      provider,
      seams: fakeSeams({ approval: { ask: async () => 'rejected' } }),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    await session.setModel({ slot: 'primary', route: 'default', model: 'big-model', contextWindow: 9999 })
    session.compaction = new CompactionRunner({ plan: async () => null, onCompact: async () => undefined })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'next' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('budget')
    const asked = await log.scan({ type: 'decision/state', limit: 10 })
    expect(
      (await session.decisions.list()).filter((value) => value.request.spec.purpose === 'budget'),
    ).toHaveLength(1)
    expect(asked[0]?.data).toMatchObject({
      request: {
        spec: {
          prompt: expect.stringContaining(
            'context 9838 tokens reached the 7500-token compaction threshold (9999-token session budget, 2499 reserved)',
          ),
        },
      },
    })
    expect(provider.requests).toHaveLength(1)
  })

  it('falls back to the default only when the provider publishes no matching record', async () => {
    const { session } = await openSession({ provider: fakeProvider([textTurn('a')]) })
    const seen: number[] = []
    session.compaction = {
      shouldCompact: ({ contextWindow }) => {
        seen.push(contextWindow)
        return false
      },
      onOverflow: () => 'failure',
    }
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    expect(seen).toEqual([128_000, 128_000])
  })
})

describe('compactionSettingsFor', () => {
  // The recent tail is kept next to the fixed prefix and the summary, so it may take only half of
  // what the trigger line leaves after the prefix: the first request after a compaction has to land
  // below the line, not on it. A prefix of 0 gives the old "half of the window minus the reserve".
  it.each([
    // [model capacity, session window, fixed prefix tokens, reserve, keep]
    [128_000, 128_000, 7000, 16_384, 20_000],
    [128_000, 70_000, 7000, 16_384, 20_000],
    [128_000, 20_000, 0, 5000, 7500],
    [128_000, 20_000, 6800, 5000, 4100],
    [128_000, 16_000, 6800, 4000, 2600],
    [128_000, 10_000, 8000, 2500, 0],
    // A model whose own window is small has no saved budget but the same arithmetic.
    [32_000, 32_000, 7000, 16_384, 4308],
  ])(
    'fits a %s-token model at a %s-token window with a %s-token fixed prefix',
    async (capacity, window, fixed, reserveTokens, keepRecentTokens) => {
      const provider = fakeProvider([])
      provider.models = () => [modelRecord('default', 'big-model', capacity)]
      const { session } = await openSession({ provider })
      await session.setModel({ slot: 'primary', route: 'default', model: 'big-model', contextWindow: window })
      expect(compactionSettingsFor(session, window, fixed)).toMatchObject({ reserveTokens, keepRecentTokens })
    },
  )
})

describe('nearlyFull', () => {
  it('is true only when less than half the reserve is left below the window', async () => {
    const { session } = await openSession({ provider: fakeProvider([textTurn('ok')]) })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hello' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    const used = compactionTriggerTokens(session)
    expect(used).toBeGreaterThan(0)
    // Exactly half the reserve left is still room to wait; one token less is not.
    expect(nearlyFull(session, used + 100, 200)).toBe(false)
    expect(nearlyFull(session, used + 99, 200)).toBe(true)
  })
})

describe('compactionTriggerTokens', () => {
  it('prefers a real provider.count() calibration over the reported-usage anchor when it is more recent', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    await session.append([
      session.ev('cost/ledger', {
        purpose: 'inference',
        effectId: 'e1',
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
        model: 'm',
      }),
    ])
    expect(contextTokens(session)).toBe(15)
    expect(compactionTriggerTokens(session)).toBe(15)
    const afterLedgerSeq = session.lastSeq
    await session.append([
      session.ev(
        'budget.state',
        {
          slot: 'primary',
          escalate: false,
          creditsUsed: 0,
          creditsCap: null,
          lastPreflight: { tokens: 999, source: 'count', seq: afterLedgerSeq },
        },
        { register: 'budget.state' },
      ),
    ])
    // The calibration is at least as recent as the ledger anchor, so it wins.
    expect(compactionTriggerTokens(session)).toBe(999)
    // contextTokens itself is unaffected: only the trigger consults the calibration.
    expect(contextTokens(session)).toBe(15)
  })

  it('ignores an estimate-sourced or stale calibration and falls back to the ledger anchor', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    await session.append([
      session.ev('cost/ledger', {
        purpose: 'inference',
        effectId: 'e1',
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
        model: 'm',
      }),
    ])
    const firstLedgerSeq = session.lastSeq
    // An estimate-sourced calibration is not consulted: it is the same chars-per-token estimate
    // this function would fall back to anyway, so preferring it would not be "consulting a
    // calibration."
    await session.append([
      session.ev(
        'budget.state',
        {
          slot: 'primary',
          escalate: false,
          creditsUsed: 0,
          creditsCap: null,
          lastPreflight: { tokens: 999, source: 'estimate', seq: firstLedgerSeq },
        },
        { register: 'budget.state' },
      ),
    ])
    expect(compactionTriggerTokens(session)).toBe(15)

    // A later cost/ledger row replaces the ledger anchor with a newer one; a count calibration
    // stamped with the *older* seq is now stale relative to it and must not win.
    await session.append([
      session.ev('cost/ledger', {
        purpose: 'inference',
        effectId: 'e2',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
        model: 'm',
      }),
    ])
    await session.append([
      session.ev(
        'budget.state',
        {
          slot: 'primary',
          escalate: false,
          creditsUsed: 0,
          creditsCap: null,
          lastPreflight: { tokens: 777, source: 'count', seq: firstLedgerSeq },
        },
        { register: 'budget.state' },
      ),
    ])
    expect(contextTokens(session)).toBe(2)
    expect(compactionTriggerTokens(session)).toBe(2)
  })
})
