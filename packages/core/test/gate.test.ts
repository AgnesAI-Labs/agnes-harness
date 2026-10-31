import { presetDefaults } from '@agnes/core-common/step/preset'
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
import type { Operation } from '../src/step/session.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import {
  actor,
  immediateTimers,
  openSession,
  readTool,
  shellTool,
  writeTool,
} from './helpers/open-session.js'

const sig = () => new AbortController().signal

describe('contract completion review', () => {
  const operation: Operation = {
    name: 'test:review',
    slot: 'before-inference',
    replay: 'safe',
    applicable: async () => 'applied',
    run: async () => ({}),
    completionReviewNote: () => 'Check the final output against the original request below',
  }
  const request = 'Write only OK to result.txt'
  const input = { actor, content: [{ type: 'text' as const, text: request }] }
  const audits = async (h: Awaited<ReturnType<typeof openSession>>) =>
    (await h.log.scan({ type: 'x/core/completion-gate', limit: 10 })).map((e) => e.data)
  const run = (h: Awaited<ReturnType<typeof openSession>>) =>
    h.session.run({ until: 'turn-end', signal: sig() })

  it.each(['none', 'read', 'write', 'shell', 'nested', 'refused', 'failed'] as const)(
    'reviews admitted mutations once, using persisted policy (%s)',
    async (mode) => {
      const registry = new ToolRegistry()
      registry.add(
        readTool(async (_args, ctx) => {
          if (mode === 'nested') await ctx.tools.invoke('write_note', {})
          return { content: [{ type: 'text', text: 'read' }] }
        }),
        { source: 'test', trust: 'builtin' },
      )
      registry.add(
        writeTool(async () => {
          if (mode === 'failed') throw new Error('partial write failed')
          return { content: [{ type: 'text', text: 'written' }] }
        }),
        { source: 'test', trust: 'builtin' },
      )
      registry.add(shellTool(), { source: 'test', trust: 'builtin' })
      const mutates = ['write', 'shell', 'nested', 'failed'].includes(mode)
      const tool = mode === 'read' || mode === 'nested' ? 'read' : mode === 'shell' ? 'shell' : 'write_note'
      const provider = fakeProvider([
        ...(mode === 'none' ? [] : [toolTurn(tool, {})]),
        textTurn('candidate'),
        textTurn('checked'),
      ])
      const h = await openSession({
        provider,
        registry,
        operations: [operation],
        seams: fakeSeams({
          repair: { decide: async () => 'complete' },
          ...(mode === 'refused'
            ? {
                principals: {
                  authorize: async () => ({ decisionId: 'deny', effect: 'deny' as const, reason: 'test' }),
                },
              }
            : {}),
        }),
      })
      try {
        await h.session.enqueue('next-turn', input)
        expect((await run(h)).reason).toBe('completed')
        expect(provider.requests).toHaveLength((mode === 'none' ? 1 : 2) + Number(mutates))
        expect(await audits(h)).toEqual([
          {
            diagnostic: 'completion_gate_contract_review',
            status: mutates ? 'ran' : 'skipped:no_state_change',
          },
        ])
        const notes = await h.log.scan({ type: 'user/message', limit: 20 })
        expect(
          notes.filter(
            (e) =>
              (e.data as { kind?: string }).kind === 'runtime_context' &&
              JSON.stringify(e.data).includes('Check the final output'),
          ),
        ).toHaveLength(Number(mutates))
        if (mutates) {
          expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain(request)
          expect(await h.log.scan({ type: 'repair/decision', limit: 10 })).toHaveLength(1)
        }
      } finally {
        await h.session.close()
      }
    },
  )

  it('admits a check at the budget floors and reviews again only on a new mutating turn', async () => {
    const registry = new ToolRegistry()
    registry.add(writeTool(), { source: 'test', trust: 'builtin' })
    const scripts = [toolTurn('write_note', {}), textTurn('candidate'), textTurn('checked')]
    const provider = fakeProvider([...scripts, ...scripts])
    const h = await openSession({ provider, registry, operations: [operation] })
    try {
      for (let turn = 1; turn <= 2; turn++) {
        await h.session.enqueue('next-turn', { ...input, maxSteps: 5, budget: 10, timeLimitMs: 200_000 })
        expect((await run(h)).reason).toBe('completed')
        expect(provider.requests).toHaveLength(turn * 3)
        expect(await audits(h)).toEqual(
          Array.from({ length: turn }, () => ({
            diagnostic: 'completion_gate_contract_review',
            status: 'ran',
          })),
        )
      }
    } finally {
      await h.session.close()
    }
  })

  it.each([false, true])(
    'shares the plan/repair round when mutation comes after a failure=%s',
    async (later) => {
      const registry = new ToolRegistry()
      registry.add(writeTool(), { source: 'test', trust: 'builtin' })
      const provider = fakeProvider([
        ...(later ? [textTurn('draft')] : []),
        toolTurn('write_note', {}),
        textTurn('candidate'),
        textTurn('checked'),
      ])
      let turnChecks = 0
      const h = await openSession({
        provider,
        registry,
        operations: [operation],
        seams: fakeSeams({
          verifier: {
            verify: async (scope) =>
              scope === 'turn' && ++turnChecks === 1 && later
                ? { verdict: 'fail', reasons: ['schema_invalid'] }
                : { verdict: 'pass', reasons: [] },
          },
        }),
      })
      try {
        await h.session.enqueue('next-turn', input)
        await h.session.acceptInput()
        await h.session.append([
          h.session.ev(
            'plan.items',
            {
              items: Array.from({ length: 3 }, (_, id) => ({
                id: String(id),
                text: 'requirement',
                status: 'todo',
              })),
            },
            { register: 'plan.items' },
          ),
        ])
        expect((await run(h)).reason).toBe('completed')
        expect(provider.requests).toHaveLength(later ? 4 : 3)
        expect(await audits(h)).toEqual([
          ...(later
            ? [{ diagnostic: 'completion_gate_contract_review', status: 'skipped:no_state_change' }]
            : []),
          { diagnostic: 'completion_gate_contract_review', status: 'ran' },
        ])
        const repairs = await h.log.scan({ type: 'repair/decision', limit: 10 })
        expect(repairs.map((e) => (e.data as { decision: string }).decision)).toEqual(
          later ? ['repair', 'repair', 'complete'] : ['repair', 'complete'],
        )
      } finally {
        await h.session.close()
      }
    },
  )

  it.each([
    'deadline',
    'steps',
    'steps-plan',
    'credits',
    'quote_timeout',
    'child',
    'disabled',
    'prompt_unavailable',
  ] as const)('skips a review with a durable reason (%s)', async (reason) => {
    const preset = presetDefaults()
    if (reason === 'disabled') preset.completionGate.contractReview = false
    const registry = new ToolRegistry()
    registry.add(writeTool(), { source: 'test', trust: 'builtin' })
    const provider = fakeProvider([toolTurn('write_note', {}), textTurn('candidate')])
    const h = await openSession({
      provider,
      registry,
      preset,
      seams: fakeSeams({
        billing: {
          projected: async () =>
            reason === 'quote_timeout' && provider.calls === 2
              ? new Promise<never>(() => undefined)
              : { credits: 1, creditSource: 'estimated' as const },
        },
      }),
      ...(reason === 'quote_timeout' ? { timers: immediateTimers } : {}),
      operations: reason === 'prompt_unavailable' ? [] : [operation],
      ...(reason === 'child'
        ? {
            delegation: {
              kind: 'spawn' as const,
              creationId: 'child',
              rootTaskId: 'parent',
              generationDepth: 1,
            },
          }
        : {}),
    })
    try {
      await h.session.enqueue('next-turn', {
        ...input,
        ...(reason === 'deadline' ? { timeLimitMs: 1_000 } : {}),
        ...(reason === 'steps' ? { maxSteps: 3 } : {}),
        ...(reason === 'steps-plan' ? { maxSteps: 2 } : {}),
        ...(reason === 'credits' ? { budget: 4 } : {}),
        ...(reason === 'quote_timeout' ? { budget: 10 } : {}),
      })
      if (reason === 'steps-plan') {
        await h.session.acceptInput()
        await h.session.append([
          h.session.ev(
            'plan.items',
            {
              items: Array.from({ length: 3 }, (_, id) => ({
                id: String(id),
                text: 'requirement',
                status: 'todo',
              })),
            },
            { register: 'plan.items' },
          ),
        ])
      }
      expect((await run(h)).reason).toBe(reason === 'steps-plan' ? 'max_steps' : 'completed')
      expect(provider.requests).toHaveLength(2)
      expect(await audits(h)).toEqual([
        {
          diagnostic: 'completion_gate_contract_review',
          status: `skipped:${reason === 'steps-plan' ? 'steps' : reason === 'quote_timeout' ? 'credits' : reason}`,
        },
      ])
    } finally {
      await h.session.close()
    }
  })

  it.each(['abort', 'reopen'] as const)('retains one review across %s', async (mode) => {
    const registry = new ToolRegistry()
    registry.add(writeTool(), { source: 'test', trust: 'builtin' })
    const provider = fakeProvider([toolTurn('write_note', {}), textTurn('candidate'), textTurn('checked')])
    let h = await openSession({ provider, registry, operations: [operation] })
    try {
      await h.session.enqueue('next-turn', input)
      for (let i = 0; i < 30 && !(await audits(h)).length; i++) await h.session.step()
      expect((await audits(h))[0]).toMatchObject({ status: 'ran' })
      if (mode === 'abort') await h.session.abort()
      else {
        const storage = h.storage
        await h.session.close()
        h = await openSession({ provider, registry, operations: [operation], storage })
      }
      expect((await run(h)).reason).toBe(mode === 'abort' ? 'aborted' : 'completed')
      expect(await audits(h)).toHaveLength(1)
      expect(provider.requests).toHaveLength(mode === 'abort' ? 2 : 3)
      const ends = await h.log.scan({ type: 'turn/end', limit: 10 })
      expect(ends).toHaveLength(1)
      expect(ends[0]?.data).toMatchObject({ reason: mode === 'abort' ? 'aborted' : 'completed' })
    } finally {
      await h.session.close()
    }
  })
})

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
