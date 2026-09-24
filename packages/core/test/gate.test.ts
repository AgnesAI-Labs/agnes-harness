import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { compactionTriggerTokens, contextTokens } from '../src/step/gate.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

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
    expect(await session.step()).toEqual({ phase: 'checkpoint' })
    // The new message lands after the first turn's ledger row, so it is estimated at chars/4
    // (8 chars -> 2) and added on top of the ledger's 15 instead of recounting the whole surface.
    expect(contextTokens(session)).toBe(17)
  })

  it('includes cache read and write tokens from the latest non-interrupted ledger row', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    await session.append([
      session.ev('cost/ledger', {
        purpose: 'compaction',
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
  it('passes the real model contextWindow to shouldCompact, not the fallback default', async () => {
    const provider = fakeProvider([textTurn('a')])
    Object.assign(provider, { models: () => [modelRecord('default', 'big-model', 321)] })
    const { session } = await openSession({ provider })
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
    expect(seen).toEqual([321, 321])
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
