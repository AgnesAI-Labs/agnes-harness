import type { HookPayloadMap } from '@agnes/extension-api'
import type { ModelRecord, ThinkingLevel } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { CompactionRunner } from '../src/step/compaction.js'
import { discloseTools } from '../src/step/inference.js'
import { withPhase } from '../src/step/op-state.js'
import { presetDefaults } from '../src/step/preset.js'
import { fakeProvider, type Script, sent, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, readTool } from './helpers/open-session.js'

const signal = () => new AbortController().signal

/** Memory storage that records the event types of every commit, to tell one transaction from two. */
function countingStorage() {
  const storage = new MemoryStorage()
  const commits: string[][] = []
  const commit = storage.commit.bind(storage)
  storage.commit = async (key, tx) => {
    commits.push(tx.events.map((event) => event.type))
    return commit(key, tx)
  }
  return { storage, commits }
}

const errorTurn: Script = [
  {
    type: 'error',
    reason: 'error',
    code: 'TRANSPORT',
    message: 'summary unavailable',
    retryable: false,
  },
]

// The summary model gets a wider window than the primary one here: these fixtures exercise the
// summary request itself, which would not fit a 100-token window next to its own output cap.
function model(id: string, slot: ModelRecord['slot'], contextWindow = 100): ModelRecord {
  return {
    id,
    name: id,
    api: 'openai-completions',
    route: 'default',
    baseUrl: 'https://example.invalid/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 4096,
    toolCallFormats: ['native'],
    thinkingReplay: 'native',
    contract_id: null,
    ...(slot ? { slot } : {}),
  }
}

async function history(summaryScript: Script = textTurn('SUMMARY')) {
  const provider = fakeProvider([textTurn('old-one'), textTurn('old-two'), summaryScript, textTurn('final')])
  provider.models = () => [model('answer-model', 'primary'), model('summary-model', 'compaction', 1000)]
  const opened = await openSession({ provider })
  opened.session.preset.compaction.reserveTokens = 80
  for (const prompt of ['one {{HISTORY}}', 'two']) {
    await opened.session.enqueue('next-turn', { content: [{ type: 'text', text: prompt }], actor })
    expect((await opened.session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
  }
  return { ...opened, provider }
}

function plan(payload: HookPayloadMap['before_compact']) {
  const surface = payload.getSurface()
  const first = surface[0]
  const penultimate = surface.at(-2)
  const last = surface.at(-1)
  if (!first || !penultimate || !last) throw new Error('test plan needs a compactable surface')
  return {
    keepFromSeq: last.seq,
    summarizeRange: [first.seq, penultimate.seq] as [number, number],
    prompts: { system: 'summarize safely', history: 'ledger history for it' },
    maxTokens: 77,
    details: { readFiles: ['read.txt'], modifiedFiles: ['write.txt'] },
  }
}

function runner(onCompact: (p: HookPayloadMap['compact']) => Promise<void> = async () => undefined) {
  return new CompactionRunner({ plan: async (payload) => plan(payload), onCompact })
}

describe('production compaction phase', () => {
  it('reserves against the resolved compaction target rather than the primary model', async () => {
    const { session, provider } = await history()
    provider.models = () => [
      {
        ...model('answer-model', 'primary'),
        cost: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      },
      {
        ...model('summary-model', 'compaction', 1000),
        route: 'summary-route',
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]
    session.preset.model.route = { ...session.preset.model.route, compaction: 'summary-route' }
    session.preset.model.id = { ...session.preset.model.id, compaction: 'summary-model' }
    session.preset.treeBudgetCredits = 1
    session.compaction = runner()
    await session.requestCompaction({ actor, admissionId: 'target-bound-compaction' })

    expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    expect(provider.requests[2]).toMatchObject({
      kind: 'summary',
      slot: 'compaction',
      route: 'summary-route',
      model: 'summary-model',
    })
  })

  it('runs an idle manual request through the same runner and ends without an inference detour', async () => {
    const { session, log, provider } = await history()
    session.compaction = runner()
    const marker = await session.requestCompaction({
      actor,
      admissionId: 'manual-compaction-command',
      instructions: 'keep the launch decision',
    })
    expect(session.op()?.phase).toMatchObject({
      kind: 'compaction',
      reason: 'requested',
      plan: { customInstructions: 'keep the launch decision' },
    })
    expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    expect(provider.requests).toHaveLength(3)
    expect(provider.requests[2]).toMatchObject({ kind: 'summary', slot: 'compaction' })
    expect((await log.scan({ type: 'x/core/manual-compaction', limit: 5 }))[0]).toMatchObject({
      seq: marker,
      data: {
        admissionId: 'manual-compaction-command',
        instructions: 'keep the launch decision',
      },
    })
    expect(await log.scan({ type: 'x/core/compaction-end', limit: 5 })).toHaveLength(1)
  })

  it('C2: compaction does not change the system string of the next turn request', async () => {
    const { session, provider } = await history()
    session.compaction = runner()
    // requests[1] is the second ordinary turn's own inference, the one immediately before this
    // enqueue triggers compaction; requests[3] is the post-compaction turn's inference, right after
    // the replace. Both are `kind: 'inference'` requests to the primary model, not the summary call.
    const before = provider.requests[1]
    if (before?.kind !== 'inference') throw new Error('missing pre-compaction baseline request')
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'x'.repeat(40) }], actor })
    expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    const after = provider.requests[3]
    if (after?.kind !== 'inference') throw new Error('missing post-compaction request')
    expect(after.system).toBe(before.system)
    // The messages array did change — this pins that the invariant is about `system` specifically,
    // not a coincidence of nothing having changed at all.
    expect(after.messages).not.toEqual(before.messages)
  })

  it('uses the before_compact plan, the compaction model slot, one replace transaction and compact hook', async () => {
    const { session, log, provider } = await history()
    const observed: HookPayloadMap['compact'][] = []
    session.compaction = new CompactionRunner({
      plan: async () => {
        throw new Error('the fitted before_compact hook is authoritative')
      },
      onCompact: async () => {
        throw new Error('the fitted compact hook is authoritative')
      },
    })
    let beforePayload: (HookPayloadMap['before_compact'] & { toolCalls?: unknown[] }) | undefined
    session.hooks = {
      ...session.hooks,
      beforeCompact: async (payload) => {
        beforePayload = payload
        return { kind: 'handled', plan: plan(payload) }
      },
      compact: async (payload) => {
        observed.push(payload)
      },
    }
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'x'.repeat(40) }], actor })
    expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')

    expect(beforePayload).toMatchObject({ contextWindow: 100, reason: 'threshold', toolCalls: [] })
    expect(provider.requests[2]).toMatchObject({
      kind: 'summary',
      slot: 'compaction',
      route: 'default',
      model: 'summary-model',
      sampling: { maxTokens: 77 },
      tools: [],
    })
    // The replayed segment is now a real message array, not one flattened string: the literal
    // `{{HISTORY}}` the first prompt embedded travels through unsubstituted (it is just user text
    // now, not a template target), and each turn is its own role-tagged message.
    const summaryMessages = provider.requests[2]?.messages ?? []
    expect(summaryMessages.slice(0, 2).map((m) => m.role)).toEqual(['user', 'assistant'])
    const [firstMessage, secondMessage] = summaryMessages
    if (!firstMessage || !secondMessage) throw new Error('missing replayed summary messages')
    expect((firstMessage.content[0] as { text: string }).text).toBe('one {{HISTORY}}')
    expect((secondMessage.content[0] as { text: string }).text).toBe('old-one')
    // The trailing instruction, verbatim, is the last message.
    const lastMessage = summaryMessages.at(-1)
    if (!lastMessage) throw new Error('missing trailing instruction message')
    expect(lastMessage.role).toBe('user')
    expect((lastMessage.content[0] as { text: string }).text).toBe('ledger history for it')
    const rows = await log.scan({ fromSeq: 1, limit: 500 })
    const replacements = rows.filter((row) => typeof row.surfaceOp === 'object')
    expect(replacements).toHaveLength(1)
    expect(replacements[0]?.data).toEqual({
      content: [{ type: 'text', text: 'SUMMARY' }],
      stopReason: 'end_turn',
    })
    expect(replacements[0]?.sourceEventSeqs).toHaveLength(4)
    const replaceIndex = rows.findIndex((row) => row.seq === replacements[0]?.seq)
    expect(rows.slice(replaceIndex - 1, replaceIndex + 4).map((row) => row.type)).toEqual([
      'x/core/compaction-begin',
      'assistant/message',
      'cost/ledger',
      'effect/settled',
      'x/core/compaction-end',
    ])
    expect(
      (await log.scan({ type: 'effect/intent', limit: 20 })).find(
        (row) => (row.data as { kind?: string }).kind === 'compaction',
      )?.data,
    ).toMatchObject({
      kind: 'compaction',
      replay: 'never',
      slot: 'compaction',
    })
    expect((await log.scan({ type: 'cost/ledger', limit: 20 })).at(-2)?.data).toMatchObject({
      purpose: 'compaction',
      model: 'summary-model',
    })
    expect(session.surface().map((node) => node.kind)).toEqual(['summary', 'user', 'assistant'])
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({ replaceSeq: replacements[0]?.seq, range: expect.any(Array) })
    expect(await log.scan({ type: 'turn/end', limit: 20 })).toHaveLength(3)
  })

  it('settles a failed summary without a replace and continues after a threshold attempt', async () => {
    const { session, log } = await history(errorTurn)
    session.compaction = runner()
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'x'.repeat(40) }], actor })
    expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    expect((await log.scan({ fromSeq: 1, limit: 500 })).filter((row) => row.surfaceOp)).toEqual([])
    const failed = await log.scan({ type: 'x/core/compaction-failed', limit: 10 })
    expect(failed).toHaveLength(1)
    // A final provider error that is not about the summary's shape is reported, never elided.
    expect((failed[0]?.data as { reason?: string } | undefined)?.reason).toBe(
      'summary request failed: summary provider error TRANSPORT',
    )
    expect(await log.scan({ type: 'x/core/compaction-begin', limit: 10 })).toEqual([])
    expect((await log.scan({ type: 'effect/settled', limit: 20 })).at(-2)?.data).toMatchObject({
      outcome: 'error',
    })
    expect((await log.scan({ type: 'cost/ledger', limit: 20 })).at(-2)?.data).toMatchObject({
      purpose: 'compaction',
    })
    expect(session.pendingEffects()).toEqual([])
  })

  it('rejects a summary that is not smaller than the content it replaces and writes no replace', async () => {
    // The original segment being replaced is a handful of short turns (well under 100 estimated
    // tokens); this summary is thousands of characters, so it is unambiguously larger under
    // nodeTokens/estimateTokens's real arithmetic regardless of estimator rounding.
    const { session, log } = await history(textTurn('X'.repeat(4000)))
    session.compaction = runner()
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'x'.repeat(40) }], actor })
    expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    expect((await log.scan({ fromSeq: 1, limit: 500 })).filter((row) => row.surfaceOp)).toEqual([])
    const failed = await log.scan({ type: 'x/core/compaction-failed', limit: 10 })
    expect(failed).toHaveLength(1)
    expect(String((failed[0]?.data as { reason?: string } | undefined)?.reason)).toContain('estimated tokens')
    const reason = (failed[0]?.data as { reason?: string } | undefined)?.reason ?? ''
    expect(reason.startsWith('summary is not smaller than the replaced content')).toBe(true)
    expect(reason).toMatch(/; elided fallback not smaller \(\d+ >= \d+ estimated tokens\)$/)
    expect(await log.scan({ type: 'x/core/compaction-begin', limit: 10 })).toEqual([])
    expect((await log.scan({ type: 'effect/settled', limit: 20 })).at(-2)?.data).toMatchObject({
      outcome: 'error',
    })
    expect((await log.scan({ type: 'cost/ledger', limit: 20 })).at(-2)?.data).toMatchObject({
      purpose: 'compaction',
    })
  })

  it('uses the default planner only when no hook handles the attempt and passes the live preset', async () => {
    const { session, provider } = await history()
    session.preset.compaction.keepRecentTokens = 37
    let config: { keepRecentTokens: number } | undefined
    session.compaction = new CompactionRunner({
      plan: async (_payload, value) => {
        config = value
        return null
      },
      onCompact: async () => undefined,
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'x'.repeat(40) }], actor })
    expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    expect(config).toEqual({ keepRecentTokens: 37 })
    expect(provider.requests).toHaveLength(3)
  })

  it.each([
    ['all-null hook', async () => ({ kind: 'handled' as const, plan: null })],
    [
      'multiple non-null hooks',
      async () => {
        throw new Error('multiple compaction plans supplied')
      },
    ],
  ])('does not fall back or replace for %s', async (_label, beforeCompact) => {
    const { session, log, provider } = await history()
    session.compaction = new CompactionRunner({
      plan: async () => {
        throw new Error('default planner must not run')
      },
      onCompact: async () => undefined,
    })
    session.hooks = { ...session.hooks, beforeCompact }
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'x'.repeat(40) }], actor })
    expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    expect(provider.requests).toHaveLength(3)
    expect((await log.scan({ fromSeq: 1, limit: 500 })).filter((row) => row.surfaceOp)).toEqual([])
  })

  it('rejects an invalid hook range before inference and writes no replace', async () => {
    const { session, log, provider } = await history()
    session.compaction = runner()
    session.hooks = {
      ...session.hooks,
      beforeCompact: async (payload) => {
        const nodes = payload.getSurface()
        const first = nodes[0]
        const kept = nodes.at(-1)
        if (!first || !kept) throw new Error('missing surface')
        return {
          kind: 'handled',
          plan: {
            keepFromSeq: kept.seq,
            summarizeRange: [first.seq, kept.seq],
            prompts: { system: 'S', history: 'summarize it' },
            maxTokens: 10,
            details: { readFiles: [], modifiedFiles: [] },
          },
        }
      },
    }
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'x'.repeat(40) }], actor })
    await session.run({ until: 'turn-end', signal: signal() })
    expect(provider.requests).toHaveLength(3)
    expect((await log.scan({ fromSeq: 1, limit: 500 })).filter((row) => row.surfaceOp)).toEqual([])
    expect(await log.scan({ type: 'x/core/compaction-failed', limit: 5 })).toHaveLength(1)
  })

  it('materializes and runs the split-turn prefix request in parallel, then joins both summaries', async () => {
    const provider = fakeProvider([
      // Long enough (unlike the tiny 'MAIN'/'PREFIX' summaries) that the combined summary text,
      // "[turn prefix]" glue included, stays comfortably below the size guard's shadowed-token sum.
      textTurn('old-one-summarized-away'),
      textTurn('old-two-summarized-away'),
      textTurn('MAIN'),
      textTurn('PREFIX'),
      textTurn('final'),
    ])
    provider.models = () => [model('answer-model', 'primary'), model('summary-model', 'compaction', 1000)]
    const { session, log } = await openSession({ provider })
    session.preset.compaction.reserveTokens = 80
    for (const prompt of ['one', 'two']) {
      await session.enqueue('next-turn', { content: [{ type: 'text', text: prompt }], actor })
      await session.run({ until: 'turn-end', signal: signal() })
    }
    let spanSeqs: number[] = []
    session.compaction = new CompactionRunner({
      plan: async (payload) => {
        const nodes = payload.getSurface()
        const [first, second, prefixFirst, prefixLast] = nodes
        const kept = nodes.at(-1)
        if (!first || !second || !prefixFirst || !prefixLast || !kept)
          throw new Error('test plan needs a split surface')
        spanSeqs = [first.seq, second.seq, prefixFirst.seq, prefixLast.seq]
        return {
          keepFromSeq: kept.seq,
          summarizeRange: [first.seq, second.seq],
          turnPrefixRange: [prefixFirst.seq, prefixLast.seq],
          prompts: {
            system: 'S',
            history: 'summarize the main range',
            prefix: 'summarize the prefix range',
          },
          maxTokens: 100,
          details: { readFiles: [], modifiedFiles: [] },
        }
      },
      onCompact: async () => undefined,
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'x'.repeat(40) }], actor })
    expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    expect(provider.requests.slice(2, 4).map((request) => request.kind)).toEqual(['summary', 'summary'])
    const prefixMessages = provider.requests[3]?.messages ?? []
    expect(prefixMessages[0]?.content[0]).toEqual({ type: 'text', text: 'two' })
    // The prefix segment reuses the same envelope cache as the main segment: 'old-two' is the same
    // node already rendered (and cached) by the main summary request above.
    expect(prefixMessages.at(-1)?.content[0]).toEqual({ type: 'text', text: 'summarize the prefix range' })
    const replacement = (await log.scan({ fromSeq: 1, limit: 500 })).find((row) => row.surfaceOp)
    if (!replacement || typeof replacement.surfaceOp !== 'object')
      throw new Error('missing split-turn replacement')
    expect(replacement?.data).toMatchObject({
      content: [{ type: 'text', text: 'MAIN\n\n[turn prefix]\nPREFIX' }],
    })
    // The replace masks the prefix it summarized, not only the main range.
    expect(replacement.sourceEventSeqs).toEqual(spanSeqs)
    expect(replacement.surfaceOp.end).toBe(spanSeqs[3])
    expect(replacement.sourceEventSeqs).toContain(spanSeqs[2])
    expect(session.surface().map((node) => node.kind)).toEqual(['summary', 'user', 'assistant'])
    // The user left on the surface is the retained one, not the summarized prefix's.
    expect(replacement.sourceEventSeqs).not.toContain(
      session.surface().find((node) => node.kind === 'user')?.seq,
    )
  })

  it('keeps tool-call detail metadata scoped to the summarized ranges, not the retained suffix', async () => {
    const provider = fakeProvider([
      toolTurn('read', { path: 'old.ts' }),
      textTurn('old done'),
      toolTurn('read', { path: 'retained.ts' }),
      textTurn('retained done'),
      textTurn('SUMMARY'),
      textTurn('final'),
    ])
    provider.models = () => [model('answer-model', 'primary'), model('summary-model', 'compaction', 1000)]
    const registry = new ToolRegistry()
    registry.add(readTool(), { source: 'agnes/base', trust: 'builtin' })
    const { session, log } = await openSession({ provider, registry })
    session.preset.compaction.reserveTokens = 80
    for (const prompt of ['one', 'two']) {
      await session.enqueue('next-turn', { content: [{ type: 'text', text: prompt }], actor })
      await session.run({ until: 'turn-end', signal: signal() })
    }
    let seenCalls: unknown[] = []
    session.compaction = new CompactionRunner({
      plan: async (payload) => {
        seenCalls = (payload as typeof payload & { toolCalls: unknown[] }).toolCalls
        const nodes = payload.getSurface()
        const keep = nodes.findIndex((node) => node.type === 'user/message' && node.seq !== nodes[0]?.seq)
        const first = nodes[0]
        const kept = nodes[keep]
        const end = nodes[keep - 1]
        if (!first || !kept || !end) throw new Error('missing retained turn')
        return {
          keepFromSeq: kept.seq,
          summarizeRange: [first.seq, end.seq],
          prompts: { system: 'S', history: 'summarize it' },
          maxTokens: 100,
          details: { readFiles: ['old.ts', 'retained.ts'], modifiedFiles: [] },
        }
      },
      onCompact: async () => undefined,
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'x'.repeat(40) }], actor })
    await session.run({ until: 'turn-end', signal: signal() })
    // A same-call hook chooses the range, so pre-plan call arguments stay hidden rather than leaking
    // the retained suffix. A future two-phase hook contract can populate this safely.
    expect(seenCalls).toEqual([])
    expect((await log.scan({ type: 'x/core/compaction-begin', limit: 5 }))[0]?.data).toMatchObject({
      details: { readFiles: ['old.ts'], modifiedFiles: [] },
    })
  })

  it('replays the previous summary node in place instead of extracting it into a template', async () => {
    const provider = fakeProvider([
      textTurn('old-one'),
      textTurn('old-two'),
      textTurn('FIRST SUMMARY'),
      textTurn('after first'),
      textTurn('SECOND SUMMARY'),
      textTurn('after second'),
    ])
    provider.models = () => [model('answer-model', 'primary'), model('summary-model', 'compaction', 1000)]
    const { session, log } = await openSession({ provider })
    session.preset.compaction.reserveTokens = 80
    for (const prompt of ['one', 'two']) {
      await session.enqueue('next-turn', { content: [{ type: 'text', text: prompt }], actor })
      await session.run({ until: 'turn-end', signal: signal() })
    }
    session.compaction = new CompactionRunner({
      plan: async (payload) => {
        const nodes = payload.getSurface()
        const first = nodes[0]
        const end = nodes.at(-2)
        const kept = nodes.at(-1)
        if (!first || !end || !kept) throw new Error('missing compactable history')
        return {
          keepFromSeq: kept.seq,
          summarizeRange: [first.seq, end.seq],
          ...(payload.previousSummarySeq === undefined
            ? {}
            : { previousSummarySeq: payload.previousSummarySeq }),
          prompts: {
            system: 'S',
            history: payload.previousSummarySeq === undefined ? 'summarize it' : 'update the summary above',
          },
          maxTokens: 100,
          details: { readFiles: [], modifiedFiles: [] },
        }
      },
      onCompact: async () => undefined,
    })
    for (const prompt of ['x'.repeat(40), 'y'.repeat(40)]) {
      await session.enqueue('next-turn', { content: [{ type: 'text', text: prompt }], actor })
      await session.run({ until: 'turn-end', signal: signal() })
    }
    const replacements = (await log.scan({ fromSeq: 1, limit: 500 })).filter((row) => row.surfaceOp)
    expect(replacements).toHaveLength(2)
    expect(replacements[1]?.sourceEventSeqs?.[0]).toBe(replacements[0]?.seq)
    expect(session.surface().filter((node) => node.kind === 'summary')).toHaveLength(1)
    const secondMessages = provider.requests[4]?.messages ?? []
    // The previous summary node is the first message, rendered like any assistant message — not
    // extracted into a <previous_summary> template slot. Wire messages carry no `seq` (see
    // to-provider.ts's toWireMessage): that field is internal bookkeeping, dropped at the wire
    // boundary along with everything else core does not intend a provider to see.
    expect(secondMessages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'FIRST SUMMARY' }],
    })
    expect(secondMessages[2]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'after first' }],
    })
    expect(secondMessages.at(-1)?.content[0]).toEqual({ type: 'text', text: 'update the summary above' })
  })

  it('routes an overflow compaction failure to failure_drain without closing the turn itself', async () => {
    const { session, log } = await history(errorTurn)
    session.compaction = runner()
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'overflow' }], actor })
    expect(await session.step()).toEqual({ phase: 'checkpoint' })
    const op = session.op()
    if (op?.phase.kind !== 'checkpoint') throw new Error('missing checkpoint')
    await session.transition(
      [],
      withPhase(op, {
        kind: 'compaction',
        reason: 'overflow',
        resumeAfter: op.phase,
      }),
    )
    expect(await session.runCompaction()).toEqual({ phase: 'failure_drain' })
    expect(session.op()?.phase).toMatchObject({ kind: 'failure_drain', error: { code: 'OVERFLOW' } })
    expect(await log.scan({ type: 'turn/end', limit: 20 })).toHaveLength(2)
    expect((await log.scan({ fromSeq: 1, limit: 500 })).filter((row) => row.surfaceOp)).toEqual([])
    const failed = await log.scan({ type: 'x/core/compaction-failed', limit: 10 })
    expect((failed[0]?.data as { reason?: string } | undefined)?.reason).toBe(
      'summary request failed: summary provider error TRANSPORT',
    )
    expect(await log.scan({ type: 'x/core/compaction-begin', limit: 10 })).toEqual([])
  })

  it('records an unavailable internal compaction phase instead of silently pretending it ran', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([]) })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'compact' }], actor })
    expect(await session.step()).toEqual({ phase: 'checkpoint' })
    const op = session.op()
    if (op?.phase.kind !== 'checkpoint') throw new Error('missing checkpoint')
    await session.transition(
      [],
      withPhase(op, { kind: 'compaction', reason: 'requested', resumeAfter: op.phase }),
    )
    expect(await session.runCompaction()).toEqual({ phase: 'checkpoint' })
    expect((await log.scan({ type: 'x/core/compaction-failed', limit: 5 }))[0]?.data).toEqual({
      reason: 'compaction runner unavailable',
    })
  })

  describe('a split-turn prefix holding tool batches', () => {
    const parallel: Script = [
      sent(),
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'read', args: { path: 'p' }, ordinal: 0 },
        via: 'native',
      },
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'read', args: { path: 'q' }, ordinal: 1 },
        via: 'native',
      },
      {
        type: 'usage',
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        credits: 1,
        creditSource: 'estimated',
      },
      { type: 'done', reason: 'toolUse' },
    ]

    /**
     * One short turn, then a tool turn stopped at the checkpoint after `batches` tool steps, where a
     * threshold compaction runs with `choose` picking main range, prefix and kept node by index.
     */
    async function compactMidTurn(
      turnScripts: Script[],
      batches: number,
      choose: (nodes: ReturnType<HookPayloadMap['before_compact']['getSurface']>) => {
        main: [number, number]
        prefix: [number, number]
        keep: number
      },
    ) {
      const provider = fakeProvider([textTurn('first answer'), ...turnScripts])
      const registry = new ToolRegistry()
      registry.add(readTool(), { source: 'agnes/base', trust: 'builtin' })
      const opened = await openSession({ provider, registry })
      const { session } = opened
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hello' }], actor })
      await session.run({ until: 'turn-end', signal: signal() })
      session.compaction = new CompactionRunner({
        plan: async (payload) => {
          const nodes = payload.getSurface()
          const { main, prefix, keep } = choose(nodes)
          const at = (i: number) => (nodes[i] as { seq: number }).seq
          return {
            keepFromSeq: at(keep),
            summarizeRange: [at(main[0]), at(main[1])],
            turnPrefixRange: [at(prefix[0]), at(prefix[1])],
            prompts: { system: 'S', history: 'summarize the main range', prefix: 'summarize the prefix' },
            maxTokens: 100,
            details: { readFiles: [], modifiedFiles: [] },
          }
        },
        onCompact: async () => undefined,
      })
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'read files' }], actor })
      while (provider.calls < 1 + batches || session.op()?.phase.kind !== 'checkpoint') await session.step()
      const op = session.op()
      if (op?.phase.kind !== 'checkpoint') throw new Error('expected a checkpoint')
      await session.transition(
        [],
        withPhase(op, { kind: 'compaction', reason: 'threshold', resumeAfter: op.phase }),
      )
      const callsBefore = provider.calls
      await session.runCompaction()
      return { ...opened, provider, summaryRequests: provider.calls - callsBefore }
    }

    it('masks a prefix that holds a whole tool batch, leaving one summary before the cut', async () => {
      const { session, log, provider, summaryRequests } = await compactMidTurn(
        [
          toolTurn('read', { path: 'a' }),
          toolTurn('read', { path: 'b' }),
          textTurn('MAIN'),
          textTurn('PREFIX'),
          textTurn('done'),
        ],
        2,
        // [u1, a2, u3, a4, r5, a6, r7]: main [u1, a2], prefix [u3, a4, r5], keep a6.
        () => ({ main: [0, 1], prefix: [2, 4], keep: 5 }),
      )
      expect(summaryRequests).toBe(2)
      expect(session.surface().map((node) => node.kind)).toEqual(['summary', 'assistant', 'tool_result'])
      expect(await log.scan({ type: 'x/core/compaction-failed', limit: 5 })).toEqual([])
      expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
      expect(session.surface().filter((node) => node.kind === 'summary')).toHaveLength(1)
      // The next request carries the bridge between the summary and the kept assistant.
      expect(
        provider.requests
          .at(-1)
          ?.messages.slice(0, 3)
          .map((m) => m.role),
      ).toEqual(['assistant', 'user', 'assistant'])
    })

    it('refuses a prefix that splits a parallel batch without opening an effect', async () => {
      const { log, summaryRequests } = await compactMidTurn(
        [parallel, textTurn('done')],
        1,
        // [u1, a2, u3, a4, r5, r6]: prefix [u3, a4, r5] leaves r6 behind the summary; keep r6's index.
        () => ({ main: [0, 1], prefix: [2, 4], keep: 5 }),
      )
      expect(summaryRequests).toBe(0)
      const failed = await log.scan({ type: 'x/core/compaction-failed', limit: 5 })
      expect(failed.map((row) => (row.data as { reason: string }).reason)).toEqual([
        'E_SURFACE_RANGE: replace range splits a tool call from its result',
      ])
      const intents = await log.scan({ type: 'effect/intent', limit: 50 })
      expect(intents.filter((row) => (row.data as { kind?: string }).kind === 'compaction')).toEqual([])
    })

    it('refuses a main range that ends on a call whose results open the prefix', async () => {
      // [u1, a2, u3, a4, r5, a6, r7]: the whole span [u1..r5] is closed, but the main request alone
      // would end on a4's call with no result.
      const { log, summaryRequests } = await compactMidTurn(
        [toolTurn('read', { path: 'a' }), toolTurn('read', { path: 'b' }), textTurn('done')],
        2,
        () => ({ main: [0, 3], prefix: [4, 4], keep: 5 }),
      )
      expect(summaryRequests).toBe(0)
      const failed = await log.scan({ type: 'x/core/compaction-failed', limit: 5 })
      expect(failed.map((row) => (row.data as { reason: string }).reason)).toEqual([
        'E_SURFACE_RANGE: replace range splits a tool call from its result',
      ])
    })
  })

  it('counts an assistant message by its call arguments too, in the surface and in the size guard', async () => {
    const provider = fakeProvider([
      toolTurn('read', { path: 'x'.repeat(8000) }),
      textTurn('done'),
      textTurn('S'.repeat(4000)),
    ])
    const registry = new ToolRegistry()
    registry.add(
      readTool(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
      { source: 'agnes/base', trust: 'builtin' },
    )
    const { session, log } = await openSession({ provider, registry })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'write it' }], actor })
    expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    let seen: ReturnType<HookPayloadMap['before_compact']['getSurface']> = []
    session.compaction = new CompactionRunner({
      plan: async (payload) => {
        seen = payload.getSurface()
        const first = seen[0]
        const end = seen.at(-2)
        const kept = seen.at(-1)
        if (!first || !end || !kept) throw new Error('needs a finished tool turn')
        return {
          keepFromSeq: kept.seq,
          summarizeRange: [first.seq, end.seq],
          prompts: { system: 'S', history: 'summarize it' },
          maxTokens: 2000,
          details: { readFiles: [], modifiedFiles: [] },
        }
      },
      onCompact: async () => undefined,
    })
    await session.requestCompaction({ actor, admissionId: 'args-estimate' })
    expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    const caller = seen.find((node) => node.type === 'assistant/message')
    expect(caller?.tokensEstimate).toBeGreaterThanOrEqual(2000)
    // A 1000-token summary is smaller than the 2000-token call it replaces, so the guard lets it through.
    expect(await log.scan({ type: 'x/core/compaction-failed', limit: 5 })).toEqual([])
    expect((await log.scan({ fromSeq: 1, limit: 500 })).filter((row) => row.surfaceOp)).toHaveLength(1)
  })
})

async function disclosureSession(agentCallable: boolean) {
  const preset = presetDefaults()
  preset.disclosure = 'hybrid'
  preset.compaction.agentCallable = agentCallable
  const compact = readTool()
  ;(compact as { name: string }).name = 'compact'
  const { session } = await openSession({ provider: fakeProvider([]), preset })
  session.d.registry.add(compact as never, { source: 'agnes/base', trust: 'builtin' })
  await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
  await session.acceptInput()
  return session
}

it('does not disclose compact when the default session has no runnable compaction mechanism', async () => {
  const session = await disclosureSession(true)
  expect(discloseTools(session)).not.toContain('compact')
})

it('discloses compact for a real runner only when the resolved preset makes it agent-callable', async () => {
  const session = await disclosureSession(false)
  session.compaction = runner()
  expect(discloseTools(session)).not.toContain('compact')
  session.preset.compaction.agentCallable = true
  expect(discloseTools(session)).toContain('compact')
  session.preset.compaction.enabled = false
  expect(discloseTools(session)).not.toContain('compact')
})

describe('CompactionRunner hysteresis', () => {
  const params = (contextTokens: number, cache?: { cacheRead: number; input: number }) => ({
    contextTokens,
    contextWindow: 100,
    reserveTokens: 20,
    ...(cache ? { cache } : {}),
  })

  it('defers exactly once when marginally over budget with a warm cache, then compacts', () => {
    const r = new CompactionRunner({ plan: async () => null, onCompact: async () => undefined })
    // window 100, reserve 20 -> threshold 80. contextTokens 85 is 5 over, within half the reserve
    // (10), so it is "marginal"; cacheRead 8 of 10 total is 80% warm.
    const marginalWarm = params(85, { cacheRead: 8, input: 2 })
    expect(r.shouldCompact(marginalWarm)).toBe(false)
    expect(r.shouldCompact(marginalWarm)).toBe(true)
  })

  it('does not defer when over budget by more than half the reserve, warm cache or not', () => {
    const r = new CompactionRunner({ plan: async () => null, onCompact: async () => undefined })
    // 15 over a 20-token reserve is more than half of it.
    expect(r.shouldCompact(params(95, { cacheRead: 9, input: 1 }))).toBe(true)
  })

  it('does not defer when the cache is cold', () => {
    const r = new CompactionRunner({ plan: async () => null, onCompact: async () => undefined })
    expect(r.shouldCompact(params(85, { cacheRead: 1, input: 9 }))).toBe(true)
  })

  it('does not defer when there is no cache signal at all', () => {
    const r = new CompactionRunner({ plan: async () => null, onCompact: async () => undefined })
    expect(r.shouldCompact(params(85))).toBe(true)
  })

  it('resets the deferral once a check finds the turn back under threshold', () => {
    const r = new CompactionRunner({ plan: async () => null, onCompact: async () => undefined })
    const marginalWarm = params(85, { cacheRead: 8, input: 2 })
    expect(r.shouldCompact(marginalWarm)).toBe(false)
    expect(r.shouldCompact(params(70))).toBe(false)
    // The deferral was consumed by the first check and then reset by the under-threshold one, so a
    // later marginal-and-warm turn gets its own fresh deferral rather than compacting immediately.
    expect(r.shouldCompact(marginalWarm)).toBe(false)
  })
})

// A real DeepSeek V4 run: the summary request spent its whole max_tokens on reasoning and stopped with
// finish_reason=length. core ignored the stop reason, so an empty summary failed with no recorded
// cause, and a summary cut off mid-sentence would have replaced the history it was meant to keep.
describe('summary stopped at the token cap', () => {
  const capped = (visible: string): Script => [
    sent(),
    { type: 'thinking_delta', delta: 'deliberating about what to keep' },
    ...(visible ? [{ type: 'text_delta' as const, delta: visible }] : []),
    {
      type: 'usage',
      tokens: { input: 500, output: 2048, cacheRead: 0, cacheWrite: 0, reasoning: 2048 - visible.length },
      credits: 1,
      creditSource: 'estimated',
    },
    { type: 'done', reason: 'length' },
  ]

  async function compactWith(summary: Script) {
    const provider = fakeProvider([textTurn('old-one'), textTurn('old-two'), summary])
    const { storage, commits } = countingStorage()
    const opened = await openSession({ provider, storage })
    for (const prompt of ['one '.repeat(200), 'two '.repeat(200)]) {
      await opened.session.enqueue('next-turn', { content: [{ type: 'text', text: prompt }], actor })
      expect((await opened.session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    }
    opened.session.compaction = new CompactionRunner({
      plan: async (payload: HookPayloadMap['before_compact']) => {
        const surface = payload.getSurface()
        const first = surface[0]
        const penultimate = surface.at(-2)
        const last = surface.at(-1)
        if (!first || !penultimate || !last) throw new Error('needs a compactable surface')
        return {
          keepFromSeq: last.seq,
          summarizeRange: [first.seq, penultimate.seq] as [number, number],
          prompts: { system: 'summarize', history: 'summarize the segment' },
          maxTokens: 2048,
          details: { readFiles: [], modifiedFiles: [] },
        }
      },
      onCompact: async () => undefined,
    })
    await opened.session.requestCompaction({ actor, admissionId: 'manual' })
    expect((await opened.session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    const rows = await opened.log.scan({ fromSeq: 1, limit: 500 })
    return {
      reasons: rows
        .filter((row) => row.type === 'x/core/compaction-failed')
        .map((row) => (row.data as { reason: string }).reason),
      replaced: rows.filter((row) => row.surfaceOp),
      begins: rows.filter((row) => row.type === 'x/core/compaction-begin'),
      ends: rows.filter((row) => row.type === 'x/core/compaction-end'),
      commits,
    }
  }

  it('records the length stop as the elided compaction cause when no summary text arrived', async () => {
    const { reasons, replaced, begins, ends, commits } = await compactWith(capped(''))
    // A manual compaction whose summary cannot be trusted now falls back to the mechanical one.
    expect(reasons).toEqual([])
    expect(replaced).toHaveLength(1)
    expect(ends).toHaveLength(1)
    expect(begins[0]?.data).toMatchObject({ mode: 'elided', cause: expect.stringMatching(/max_tokens/) })
    expect(replaced[0]?.origin).toBe('system')
    // The failed call's spend, its error settlement and the replace land in one transaction.
    expect(
      commits.find((types) => types.includes('assistant/message') && types.includes('x/core/compaction-end')),
    ).toEqual(expect.arrayContaining(['cost/ledger', 'effect/settled', 'x/core/compaction-begin']))
  })

  it('does not commit a summary that was truncated at the cap', async () => {
    const truncated = 'Goal: read big.txt. Progress: read sections 1-7 and'
    const { reasons, replaced } = await compactWith(capped(truncated))
    expect(reasons).toEqual([])
    expect(replaced).toHaveLength(1)
    const text =
      (replaced[0]?.data as { content?: Array<{ text: string }> } | undefined)?.content?.[0]?.text ?? ''
    expect(text.startsWith('[compaction] No model summary')).toBe(true)
    expect(text).not.toContain(truncated)
  })
})

// D-3: on a max_tokens cutoff, retry exactly once with thinking forced to the lowest level. The
// budget scaling above (plan.maxTokens off reserveTokens) is the primary fix for this failure mode;
// this is a cheap second layer for a model that still burns even the larger budget on reasoning.
describe('length-cap retry', () => {
  const capped = (visible: string): Script => [
    sent(),
    { type: 'thinking_delta', delta: 'deliberating about what to keep' },
    ...(visible ? [{ type: 'text_delta' as const, delta: visible }] : []),
    {
      type: 'usage',
      tokens: { input: 500, output: 2048, cacheRead: 0, cacheWrite: 0, reasoning: 2048 - visible.length },
      credits: 1,
      creditSource: 'estimated',
    },
    { type: 'done', reason: 'length' },
  ]

  async function compactWithScripts(scripts: Script[], configuredThinking?: ThinkingLevel) {
    const provider = fakeProvider([textTurn('old-one'), textTurn('old-two'), ...scripts])
    const opened = await openSession({ provider })
    for (const prompt of ['one '.repeat(200), 'two '.repeat(200)]) {
      await opened.session.enqueue('next-turn', { content: [{ type: 'text', text: prompt }], actor })
      expect((await opened.session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    }
    if (configuredThinking !== undefined) opened.session.preset.model.thinking.compaction = configuredThinking
    opened.session.compaction = new CompactionRunner({
      plan: async (payload: HookPayloadMap['before_compact']) => {
        const surface = payload.getSurface()
        const first = surface[0]
        const penultimate = surface.at(-2)
        const last = surface.at(-1)
        if (!first || !penultimate || !last) throw new Error('needs a compactable surface')
        return {
          keepFromSeq: last.seq,
          summarizeRange: [first.seq, penultimate.seq] as [number, number],
          prompts: { system: 'summarize', history: 'summarize the segment' },
          maxTokens: 2048,
          details: { readFiles: [], modifiedFiles: [] },
        }
      },
      onCompact: async () => undefined,
    })
    await opened.session.requestCompaction({ actor, admissionId: 'manual' })
    expect((await opened.session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    const rows = await opened.log.scan({ fromSeq: 1, limit: 500 })
    return {
      reasons: rows
        .filter((row) => row.type === 'x/core/compaction-failed')
        .map((row) => (row.data as { reason: string }).reason),
      replaced: rows.filter((row) => row.surfaceOp),
      begins: rows.filter((row) => row.type === 'x/core/compaction-begin'),
      provider,
    }
  }

  it('retries once with thinking forced to low, then falls back to an elided compaction', async () => {
    const { reasons, replaced, begins, provider } = await compactWithScripts([capped(''), capped('')])
    // old-one, old-two, first summary attempt, retry attempt — no third attempt.
    expect(provider.calls).toBe(4)
    expect(provider.requests.at(-1)?.sampling?.thinking).toBe('low')
    expect(reasons).toEqual([])
    expect(replaced).toHaveLength(1)
    expect(begins[0]?.data).toMatchObject({ mode: 'elided', cause: expect.stringMatching(/max_tokens/) })
  })

  it('does not retry when the configured level is already low or below', async () => {
    const { provider } = await compactWithScripts([capped('')], 'low')
    // old-one, old-two, one summary attempt — no retry call.
    expect(provider.calls).toBe(3)
  })

  it('commits the retry summary when it succeeds within budget', async () => {
    const { reasons, replaced } = await compactWithScripts([capped(''), textTurn('Goal: recovered summary')])
    expect(replaced).not.toEqual([])
    expect(reasons).toEqual([])
  })
})

describe('routing a summary that is unavailable', () => {
  const read = readTool(async (args) => ({
    content: [{ type: 'text', text: `${JSON.stringify(args)} ${'content line. '.repeat(300)}` }],
  }))
  const failure = (retryable: boolean): Script => [
    {
      type: 'error',
      reason: 'error',
      code: retryable ? 'RATE_LIMIT' : 'TRANSPORT',
      message: 'no',
      retryable,
    },
  ]

  /** One finished three-read turn, then a compaction attempt entered by hand from the next turn. */
  async function toolHistory(
    summaryScripts: Script[],
    windows: { primary?: number; compaction?: number } = {},
  ) {
    const provider = fakeProvider([
      toolTurn('read', { path: 'a' }),
      toolTurn('read', { path: 'b' }),
      toolTurn('read', { path: 'c' }),
      textTurn('read all three'),
      ...summaryScripts,
      textTurn('after'),
    ])
    const sizes = { primary: windows.primary ?? 100_000, compaction: windows.compaction ?? 100_000 }
    provider.models = () => [
      { ...model('answer-model', 'primary'), contextWindow: sizes.primary },
      { ...model('summary-model', 'compaction'), contextWindow: sizes.compaction },
    ]
    const registry = new ToolRegistry()
    registry.add(read, { source: 'agnes/base', trust: 'builtin' })
    const { storage, commits } = countingStorage()
    const seams = fakeSeams()
    const opened = await openSession({ provider, registry, storage, seams })
    opened.session.preset.telemetry.invariants = 'strict'
    await opened.session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'read three files' }],
      actor,
    })
    expect((await opened.session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    let planned = 0
    const runner = new CompactionRunner({
      plan: async (payload) => {
        const nodes = payload.getSurface()
        const first = nodes[0]
        const end = nodes.at(-2)
        const kept = nodes.at(-1)
        if (!first || !end || !kept) throw new Error('needs a finished turn and the next prompt')
        planned = nodes.slice(0, -1).reduce((n, node) => n + (node.tokensEstimate ?? 0), 0)
        return {
          keepFromSeq: kept.seq,
          summarizeRange: [first.seq, end.seq] as [number, number],
          prompts: { system: 'S', history: 'summarize it' },
          maxTokens: 2000,
          details: { readFiles: [], modifiedFiles: [] },
        }
      },
      onCompact: async () => undefined,
    })
    opened.session.compaction = runner
    await opened.session.enqueue('next-turn', { content: [{ type: 'text', text: 'next' }], actor })
    expect(await opened.session.step()).toEqual({ phase: 'checkpoint' })
    const enter = async (reason: 'threshold' | 'overflow' | 'requested') => {
      const op = opened.session.op()
      if (op?.phase.kind !== 'checkpoint') throw new Error('expected a checkpoint')
      await opened.session.transition(
        [],
        withPhase(op, { kind: 'compaction', reason, resumeAfter: op.phase }),
      )
      return opened.session.runCompaction()
    }
    const outcome = async () => {
      const rows = await opened.log.scan({ fromSeq: 1, limit: 1000 })
      return {
        rows,
        replaces: rows.filter((row) => typeof row.surfaceOp === 'object'),
        begins: rows.filter((row) => row.type === 'x/core/compaction-begin'),
        ends: rows.filter((row) => row.type === 'x/core/compaction-end'),
        failed: rows.filter((row) => row.type === 'x/core/compaction-failed'),
        spends: rows.filter(
          (row) => row.type === 'cost/ledger' && (row.data as { purpose?: string }).purpose === 'compaction',
        ),
      }
    }
    return { ...opened, provider, commits, seams, runner, sizes, enter, outcome, planned: () => planned }
  }

  /** The elided replace was written, as one transaction with the failed call's spend when there was one. */
  async function expectElided(
    h: Awaited<ReturnType<typeof toolHistory>>,
    cause: RegExp,
    withCall: boolean,
    priorFailures = 0,
  ) {
    const o = await h.outcome()
    expect(o.failed).toHaveLength(priorFailures)
    expect(o.replaces).toHaveLength(1)
    expect(o.ends).toHaveLength(1)
    expect(o.replaces[0]?.origin).toBe('system')
    expect(o.begins[0]?.data).toMatchObject({ mode: 'elided', cause: expect.stringMatching(cause) })
    const tx = h.commits.find((types) => types.includes('x/core/compaction-end')) ?? []
    if (withCall) {
      expect(tx).toEqual(
        expect.arrayContaining([
          'cost/ledger',
          'effect/settled',
          'x/core/compaction-begin',
          'assistant/message',
        ]),
      )
      expect((o.begins[0]?.data as { effectId?: string } | undefined)?.effectId).toBeDefined()
    } else {
      expect(o.spends).toEqual([])
      expect(o.begins[0]?.data).not.toHaveProperty('effectId')
      expect(o.ends[0]?.data).not.toHaveProperty('effectId')
    }
    expect(h.runner.transientFailures).toBe(0)
    return o
  }

  it('goes straight to the elided compaction when the summary request cannot fit its window', async () => {
    const h = await toolHistory([], { compaction: 2500 })
    expect(await h.enter('threshold')).toEqual({ phase: 'checkpoint' })
    // The provider saw only the first turn's four requests: no summary request was sent.
    expect(h.provider.calls).toBe(4)
    await expectElided(h, /preflight-overflow/, false)
  })

  it('uses the summary model when the request fits exactly, and elides at one token more', async () => {
    const exact = await toolHistory([textTurn('Goal: read three files. Progress: done.')])
    // segment + output cap + system + instruction, the same sum the check makes
    const need = (planned: number) => planned + 2000 + Math.ceil(1 / 4) + Math.ceil('summarize it'.length / 4)
    exact.provider.models = () => [
      { ...model('answer-model', 'primary'), contextWindow: 100_000 },
      { ...model('summary-model', 'compaction'), contextWindow: need(exact.planned()) },
    ]
    // The window is read after planning, so the first call only fixes the planned size.
    const first = exact.runner.options.plan
    exact.runner.options.plan = async (payload, config) => {
      const plan = await first(payload, config)
      const size = need(exact.planned())
      exact.provider.models = () => [
        { ...model('answer-model', 'primary'), contextWindow: 100_000 },
        { ...model('summary-model', 'compaction'), contextWindow: size },
      ]
      return plan
    }
    await exact.enter('threshold')
    expect(exact.provider.calls).toBe(5)
    expect((await exact.outcome()).begins[0]?.data).not.toHaveProperty('mode')

    const over = await toolHistory([])
    const plan = over.runner.options.plan
    over.runner.options.plan = async (payload, config) => {
      const result = await plan(payload, config)
      const size = need(over.planned()) - 1
      over.provider.models = () => [
        { ...model('answer-model', 'primary'), contextWindow: 100_000 },
        { ...model('summary-model', 'compaction'), contextWindow: size },
      ]
      return result
    }
    await over.enter('threshold')
    expect(over.provider.calls).toBe(4)
    await expectElided(over, /preflight-overflow/, false)
  })

  const errorOf = (code: string, retryable: boolean): Script => [
    { type: 'error', reason: 'error', code: code as never, message: 'no', retryable },
  ]

  it.each([
    ['a summary that calls a tool', toolTurn('read', { path: 'x' }), /tool/],
    ['an empty summary', textTurn(''), /empty/],
    ['a summary request over its window', errorOf('OVERFLOW', false), /OVERFLOW/],
  ])('elides after %s', async (_label, script, cause) => {
    const h = await toolHistory([script])
    expect(await h.enter('threshold')).toEqual({ phase: 'checkpoint' })
    expect(h.provider.calls).toBe(5)
    await expectElided(h, cause, true)
  })

  // A broken or exhausted compaction route has to show up as a failure, not as a lossy fallback.
  describe.each(['threshold', 'overflow', 'requested'] as const)('from a %s compaction', (reason) => {
    const reported = async (h: Awaited<ReturnType<typeof toolHistory>>, code: RegExp) => {
      const outcome = await h.enter(reason)
      expect(outcome).toEqual(reason === 'overflow' ? { phase: 'failure_drain' } : { phase: 'checkpoint' })
      const o = await h.outcome()
      expect(o.replaces).toEqual([])
      expect(o.begins).toEqual([])
      expect(o.failed).toHaveLength(1)
      expect((o.failed[0]?.data as { reason?: string } | undefined)?.reason).toMatch(code)
      expect(h.runner.transientFailures).toBe(0)
    }

    it.each([
      ['AUTH', false],
      ['AUTH', true],
      ['NO_MODEL', false],
      ['NO_ADAPTER', false],
      ['FORMAT', false],
      ['CONTRACT_MISMATCH', false],
      ['TRANSPORT', false],
      ['QUOTA', false],
      ['QUOTA', true],
    ])('reports %s (retryable %s) instead of eliding', async (code, retryable) => {
      await reported(await toolHistory([errorOf(code, retryable)]), new RegExp(code))
    })

    it.each(['AUTH', 'NO_MODEL', 'QUOTA'])('reports a thrown %s instead of eliding', async (code) => {
      const h = await toolHistory([])
      h.provider.infer = (req) => {
        if (req.kind !== 'summary') throw new Error('only the summary request is expected here')
        throw Object.assign(new Error(`${code}: route broken`), { code })
      }
      await reported(h, new RegExp(code))
    })
  })

  it('treats a thrown error without a code as transient: elided during overflow, retried at threshold', async () => {
    const throwing = async (reason: 'overflow' | 'threshold') => {
      const h = await toolHistory([])
      h.provider.infer = () => {
        throw new Error('socket hang up')
      }
      await h.enter(reason)
      return h
    }
    await expectElided(await throwing('overflow'), /transport/, true)
    const threshold = await throwing('threshold')
    const o = await threshold.outcome()
    expect(o.replaces).toEqual([])
    expect(threshold.runner.transientFailures).toBe(1)
  })

  it('elides when the summary is not smaller than what it replaces', async () => {
    const h = await toolHistory([textTurn('X'.repeat(40_000))])
    await h.enter('threshold')
    await expectElided(h, /not smaller/, true)
  })

  it('elides at once on a retryable failure during overflow', async () => {
    const h = await toolHistory([failure(true)])
    expect(await h.enter('overflow')).toEqual({ phase: 'checkpoint' })
    await expectElided(h, /RATE_LIMIT/, true)
  })

  it('retries a first transient threshold failure, then elides the second in a row', async () => {
    const h = await toolHistory([failure(true), failure(true)])
    await h.enter('threshold')
    const o = await h.outcome()
    expect(o.replaces).toEqual([])
    expect(o.failed).toHaveLength(1)
    expect(h.runner.transientFailures).toBe(1)
    await h.enter('threshold')
    await expectElided(h, /RATE_LIMIT/, true, 1)
  })

  it('elides a first transient threshold failure once the window has less than half the reserve left', async () => {
    const h = await toolHistory([failure(true)], { primary: 5000 })
    await h.enter('threshold')
    await expectElided(h, /RATE_LIMIT/, true)
  })

  it('keeps a first transient threshold failure retryable, and a success resets the count', async () => {
    const h = await toolHistory([failure(true), textTurn('Goal: read three files. Progress: done.')])
    await h.enter('threshold')
    let o = await h.outcome()
    expect(o.replaces).toEqual([])
    expect(o.begins).toEqual([])
    expect(o.failed).toHaveLength(1)
    expect(h.runner.transientFailures).toBe(1)
    await h.enter('threshold')
    o = await h.outcome()
    expect(o.replaces).toHaveLength(1)
    expect(o.begins[0]?.data).not.toHaveProperty('mode')
    expect(h.runner.transientFailures).toBe(0)
  })

  it('counts transient threshold failures within one turn only', async () => {
    const h = await toolHistory([failure(true), textTurn('answer'), failure(true)])
    await h.enter('threshold')
    expect(h.runner.transientFailures).toBe(1)
    expect((await h.session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    await h.session.enqueue('next-turn', { content: [{ type: 'text', text: 'again' }], actor })
    expect(await h.session.step()).toEqual({ phase: 'checkpoint' })
    // The previous turn's failure does not count against this one: retried, not elided.
    await h.enter('threshold')
    const o = await h.outcome()
    expect(o.replaces).toEqual([])
    expect(o.failed).toHaveLength(2)
    expect(h.runner.transientFailures).toBe(1)
  })

  it('reports a transient failure of a manual compaction instead of eliding', async () => {
    const h = await toolHistory([failure(true)])
    await h.enter('requested')
    const o = await h.outcome()
    expect(o.replaces).toEqual([])
    expect(o.failed).toHaveLength(1)
  })

  it.each(['threshold', 'overflow', 'requested'] as const)(
    'never elides when the tree budget refuses the %s summary',
    async (reason) => {
      const h = await toolHistory([])
      h.session.preset.treeBudgetCredits = 1
      h.seams.ledger.projected = async () => ({ credits: 1000, creditSource: 'estimated' })
      // A refused tree reservation ends the turn with `budget` from inside the summary call, and the
      // compaction then fails writing its own settlement (E_ENVELOPE). That predates this routing
      // and is left as it is; what matters here is that no elided replace is written instead.
      await h.enter(reason).catch(() => undefined)
      const o = await h.outcome()
      expect(o.replaces).toEqual([])
      expect(o.begins).toEqual([])
      expect(o.rows.filter((row) => row.type === 'turn/end').at(-1)?.data).toMatchObject({ reason: 'budget' })
      expect(h.provider.calls).toBe(4)
    },
  )

  it('never elides a cancelled summary', async () => {
    const h = await toolHistory([])
    const infer = h.provider.infer.bind(h.provider)
    h.provider.infer = (req, options) => {
      if (req.kind === 'summary') h.session.ac.abort()
      return infer(req, options)
    }
    await h.enter('threshold')
    const o = await h.outcome()
    expect(o.replaces).toEqual([])
    expect((o.failed[0]?.data as { reason?: string } | undefined)?.reason).toBe('compaction cancelled')
  })

  it('does not check the threshold again before the next request refreshes the context count', async () => {
    // The summary request itself was large, so its spend row leaves a context anchor far over the
    // threshold until the next ordinary request replaces it.
    const heavy: Script = [
      sent(),
      { type: 'text_delta', delta: 'Goal: read three files. Progress: done.' },
      {
        type: 'usage',
        tokens: { input: 150_000, output: 20, cacheRead: 0, cacheWrite: 0 },
        credits: 1,
        creditSource: 'estimated',
      },
      { type: 'done', reason: 'stop' },
    ]
    const h = await toolHistory([heavy])
    expect(await h.enter('overflow')).toEqual({ phase: 'checkpoint' })
    expect((await h.session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    const o = await h.outcome()
    expect(o.begins).toHaveLength(1)
    expect(h.provider.requests.filter((req) => req.kind === 'summary')).toHaveLength(1)
    expect(
      o.rows.filter(
        (row) => row.type === 'approval/asked' && (row.data as { kind?: string }).kind === 'budget',
      ),
    ).toEqual([])
  })
})
