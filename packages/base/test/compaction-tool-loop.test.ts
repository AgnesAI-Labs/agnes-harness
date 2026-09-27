import {
  CompactionRunner,
  type Event,
  presetDefaults,
  type ScanQuery,
  scanAll,
  ToolRegistry,
} from '@agnes/core'
import { actor, openSession, readTool } from '@agnes/core/testkit'
import { describe, expect, it } from 'vitest'
import { buildCompactionPlan } from '../extensions/compaction/src/plan.js'
import { IN_PROGRESS_NOTE } from '../extensions/compaction/src/prompts.js'
import {
  assertPaired,
  type SummaryFault,
  type ToolLoopProvider,
  toolLoopProvider,
} from './helpers/tool-loop-provider.js'

/**
 * Long tool loops driven end to end through the default base planner and core's compaction phase,
 * against a provider whose usage follows what it was actually sent. Every request the provider saw,
 * main and summary alike, has to keep each tool call paired with its result.
 */

const signal = () => new AbortController().signal
const SKILL = 'LOOP SKILL BODY'

type Setup = {
  window: number
  compactionWindow?: number
  separateCompactionModel?: boolean
  reserve: number
  keep: number
  resultChars: number
  answerAt: (step: number) => boolean
  tokenFactor?: number
  readArgs?: (step: number) => Record<string, unknown>
  summaryFaults?: ReadonlyMap<number, SummaryFault>
  /** Result text override for one read, by path. */
  resultFor?: (path: string, provider: ToolLoopProvider) => { text: string; terminate?: boolean } | undefined
}

async function open(o: Setup) {
  const provider = toolLoopProvider({
    primaryWindow: o.window,
    ...(o.compactionWindow ? { compactionWindow: o.compactionWindow } : {}),
    answerAt: o.answerAt,
    ...(o.tokenFactor ? { tokenFactor: o.tokenFactor } : {}),
    ...(o.readArgs ? { readArgs: o.readArgs } : {}),
    ...(o.summaryFaults ? { summaryFaults: o.summaryFaults } : {}),
  })
  const registry = new ToolRegistry()
  registry.add(
    readTool(async (args) => {
      const path = String((args as { path?: unknown }).path)
      const special = o.resultFor?.(path, provider)
      const text =
        special?.text ??
        `${path}: ${'lorem ipsum dolor sit amet '.repeat(o.resultChars / 27 + 1)}`.slice(0, o.resultChars)
      return {
        content: [{ type: 'text', text }],
        ...(special?.terminate ? { terminate: true } : {}),
      } as never
    }),
    { source: 'agnes/base', trust: 'builtin' },
  )
  const preset = presetDefaults()
  if (o.separateCompactionModel || o.compactionWindow) preset.model.id.compaction = 'compaction-model'
  preset.compaction.reserveTokens = o.reserve
  preset.compaction.keepRecentTokens = o.keep
  preset.budget.maxSteps = 200
  preset.telemetry.invariants = 'strict'
  const opened = await openSession({
    provider,
    registry,
    preset,
    runtimePromptPreloader: ({ prompt }) =>
      prompt.includes('LOOP-SKILL') ? { key: 'skill:loop@r1', note: SKILL } : undefined,
  })
  opened.session.compaction = new CompactionRunner({
    plan: async (payload, config) => buildCompactionPlan(payload, config),
    onCompact: async () => undefined,
  })
  return { ...opened, provider }
}

async function turn(session: Awaited<ReturnType<typeof open>>['session'], text: string) {
  await session.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
  return (await session.run({ until: 'turn-end', signal: signal() })).reason
}

type Metrics = ReturnType<typeof summarize>

function summarize(rows: Event[], provider: ToolLoopProvider) {
  const replaces = rows.filter((row) => typeof row.surfaceOp === 'object')
  const begins = rows.filter((row) => row.type === 'x/core/compaction-begin')
  const attempts = rows.filter(
    (row) => row.type === 'effect/intent' && (row.data as { kind?: string }).kind === 'compaction',
  ).length
  const mainInputs = provider.requests.flatMap((req, i) =>
    req.kind === 'summary' ? [] : [provider.inputs[i] as number],
  )
  const summaryOutputs = rows
    .filter(
      (row) => row.type === 'cost/ledger' && (row.data as { purpose?: string }).purpose === 'compaction',
    )
    .reduce((n, row) => n + (row.data as { tokens: { output: number } }).tokens.output, 0)
  return {
    mainSteps: provider.mainSteps,
    attempts,
    replaces: replaces.length,
    elided: begins.filter((row) => (row.data as { mode?: string }).mode === 'elided').length,
    failed: rows.filter((row) => row.type === 'x/core/compaction-failed').length,
    failedReasons: rows
      .filter((row) => row.type === 'x/core/compaction-failed')
      .map((row) => (row.data as { reason: string }).reason)
      .slice(0, 3),
    quotes: rows.filter(
      (row) => row.type === 'approval/asked' && (row.data as { kind?: string }).kind === 'budget',
    ).length,
    summaryRequests: provider.summaries,
    summaryOutputTokens: summaryOutputs,
    // Summary calls that led to no replace: each LLM-backed replace carries its effect id.
    wastedAttempts: attempts - begins.filter((row) => (row.data as { effectId?: string }).effectId).length,
    peakMainInput: Math.max(...mainInputs),
    overflows: provider.overflows,
    coldStarts: provider.coldStarts,
    firstInputAfterCompaction: mainRequestsAfterFirstSummary(provider)[0]?.input,
    unpaired: provider.requests.map(assertPaired).filter((problem) => problem !== undefined),
  }
}

async function measure(
  label: string,
  log: { lastSeq: number; scan: (q: ScanQuery) => Promise<Event[]> },
  provider: ToolLoopProvider,
  reasons: string[],
): Promise<Metrics & { rows: Event[] }> {
  // The whole ledger, a page at a time: one scan returns at most 500 rows.
  const rows = await scanAll((q) => log.scan(q), { fromSeq: 1, toSeq: log.lastSeq })
  const metrics = { reasons, ...summarize(rows, provider) }
  console.info(`compaction-tool-loop ${label}`, JSON.stringify(metrics))
  return { ...metrics, rows }
}

/** Main requests sent after the first summary request, with the provider's input count for each. */
function mainRequestsAfterFirstSummary(provider: ToolLoopProvider) {
  const first = provider.requests.findIndex((req) => req.kind === 'summary')
  return provider.requests.flatMap((req, i) =>
    i > first && req.kind !== 'summary' ? [{ req, input: provider.inputs[i] as number }] : [],
  )
}

describe('compaction inside long tool loops', () => {
  it('compacts a long first turn in a 128K window once and keeps going', async () => {
    const { session, log, provider } = await open({
      window: 128_000,
      reserve: 16_384,
      keep: 20_000,
      resultChars: 8000,
      answerAt: (step) => step >= 70,
    })
    const reasons = [await turn(session, 'read every file, LOOP-SKILL')]
    const m = await measure('first-turn-128k', log, provider, reasons)
    expect(reasons).toEqual(['completed'])
    expect(m.unpaired).toEqual([])
    expect(m.replaces).toBe(1)
    expect(m.quotes).toBe(0)
    expect(m.failed).toBe(0)
    // The persistent Skill note shifts the segment boundary; one replacement now summarizes two spans.
    expect(m.summaryRequests).toBe(2)
    expect(m.peakMainInput).toBeLessThan(128_000)
    expect(m.coldStarts).toBe(1)
    const instructions = provider.requests
      .filter((req) => req.kind === 'summary')
      .map((req) => (req.messages.at(-1)?.content[0] as { text?: string } | undefined)?.text)
    expect(instructions.some((instruction) => instruction?.includes('(turn continues below)'))).toBe(true)
    const after = mainRequestsAfterFirstSummary(provider)
    expect(after.length).toBeGreaterThan(0)
    expect(after[0]?.input).toBeLessThanOrEqual(45_000)
    for (const { req } of after) expect(JSON.stringify(req.messages)).toContain(SKILL)
  }, 60_000)

  it('compacts again each time a tool loop in a 32K window crosses the threshold', async () => {
    const { session, log, provider } = await open({
      window: 32_000,
      reserve: 4096,
      keep: 4000,
      resultChars: 6000,
      answerAt: (step) => step >= 60,
    })
    const reasons = [await turn(session, 'read every file')]
    const m = await measure('repeated-32k', log, provider, reasons)
    expect(reasons).toEqual(['completed'])
    expect(m.unpaired).toEqual([])
    expect(m.replaces).toBeGreaterThanOrEqual(3)
    expect(m.quotes).toBe(0)
    expect(m.failed).toBe(0)
    expect(m.summaryRequests).toBeLessThanOrEqual(2 * m.replaces)
    expect(m.peakMainInput).toBeLessThan(32_000)
    expect(m.coldStarts).toBe(m.replaces)
  }, 60_000)

  it('compacts a later turn opened right after a summary as one range', async () => {
    const { session, log, provider } = await open({
      window: 32_000,
      reserve: 4096,
      keep: 4000,
      resultChars: 6000,
      answerAt: (step) => step === 15 || step >= 55,
    })
    const reasons = [
      await turn(session, 'first pass'),
      await turn(session, `second pass: ${'y'.repeat(32_000)}`),
    ]
    const m = await measure('after-summary', log, provider, reasons)
    expect(reasons).toEqual(['completed', 'completed'])
    expect(m.unpaired).toEqual([])
    expect(m.replaces).toBeGreaterThanOrEqual(2)
    expect(m.quotes).toBe(0)
    expect(m.failed).toBe(0)
    expect(m.wastedAttempts).toBe(0)
    // The compaction inside the second turn's loop sees [summary, user, assistant, result, ...]: one
    // range, one request, not a main range holding only the old summary plus a prefix.
    const replaces = m.rows.filter((row) => typeof row.surfaceOp === 'object')
    const firstInLoop = replaces[1]
    const summaries = provider.requests.filter((req) => req.kind === 'summary')
    expect(summaries).toHaveLength(m.replaces)
    const instruction = summaries[1]?.messages.at(-1)?.content[0] as { text?: string } | undefined
    expect(instruction?.text).toContain(IN_PROGRESS_NOTE)
    expect(firstInLoop?.sourceEventSeqs?.[0]).toBe(replaces[0]?.seq)
  }, 60_000)

  const terminating: Pick<Setup, 'readArgs' | 'resultFor'> = {
    readArgs: (step) => ({ path: step === 4 ? 'stop' : `f${step}` }),
    resultFor: (path) =>
      path === 'stop' ? { text: `stop: ${'lorem ipsum '.repeat(500)}`, terminate: true } : undefined,
  }

  it('does not let a turn that ended on a tool result block later compaction', async () => {
    const { session, log, provider } = await open({
      window: 32_000,
      reserve: 4096,
      keep: 4000,
      resultChars: 6000,
      answerAt: (step) => step >= 45,
      ...terminating,
    })
    const reasons = [await turn(session, 'first pass')]
    const turnOneEnd = (await scanAll((q) => log.scan(q), { fromSeq: 1, toSeq: log.lastSeq }))
      .filter((row) => row.type === 'tool/result')
      .at(-1)?.seq
    reasons.push(await turn(session, 'second pass'))
    const m = await measure('after-result-end', log, provider, reasons)
    expect(reasons).toEqual(['completed', 'completed'])
    expect(m.unpaired).toEqual([])
    expect(m.replaces).toBeGreaterThanOrEqual(1)
    expect(m.quotes).toBe(0)
    expect(m.failed).toBe(0)
    const first = m.rows.find((row) => typeof row.surfaceOp === 'object')
    expect(first?.sourceEventSeqs).toContain(turnOneEnd)
    // The first compaction split turn two off as a prefix, and masking that prefix too is what
    // brings the context back down to about the kept window.
    expect(m.summaryRequests).toBeGreaterThan(m.replaces)
    expect(m.firstInputAfterCompaction).toBeLessThan(10_000)
  }, 60_000)

  it('completes a manual compaction after a turn that ended on a tool result', async () => {
    const { session, log, provider } = await open({
      window: 32_000,
      reserve: 4096,
      keep: 4000,
      resultChars: 6000,
      answerAt: () => false,
      ...terminating,
    })
    const reasons = [await turn(session, 'first pass')]
    await session.requestCompaction({ actor, admissionId: 's3-compact' })
    reasons.push((await session.run({ until: 'turn-end', signal: signal() })).reason)
    const m = await measure('manual-after-result-end', log, provider, reasons)
    expect(reasons).toEqual(['completed', 'completed'])
    expect(m.unpaired).toEqual([])
    // What the daemon reads for the K01 receipt: one end, no failure.
    expect(m.rows.filter((row) => row.type === 'x/core/compaction-end')).toHaveLength(1)
    expect(m.failed).toBe(0)
  }, 60_000)

  /**
   * Overflow: the provider's tokenizer counts 1.5x the estimate, and one read returns a result sized
   * so core's own count at the checkpoint stays under the threshold while the provider's count of the
   * next request is over the window. The overflow compaction keeps half the usual window, which the
   * oversized result alone exceeds, so only that last step is kept.
   */
  function overflowSetup(compactionWindow: number) {
    let hugeAt: number | undefined
    const setup: Setup = {
      window: 32_000,
      compactionWindow,
      reserve: 4096,
      keep: 4000,
      resultChars: 400,
      tokenFactor: 1.5,
      answerAt: (step) => hugeAt !== undefined && step >= hugeAt + 3,
      resultFor: (path, provider) => {
        const last = provider.inputs.at(-1) ?? 0
        if (hugeAt !== undefined || last < 14_500) return undefined
        hugeAt = provider.mainSteps
        return { text: `${path}: ${'z'.repeat(4 * (27_000 - last))}` }
      },
    }
    return setup
  }

  it('compacts an overflow with the model summary and carries the turn on', async () => {
    const { session, log, provider } = await open(overflowSetup(32_000))
    const reasons = [await turn(session, 'read every file')]
    const m = await measure('overflow-summary', log, provider, reasons)
    expect(reasons).toEqual(['completed'])
    expect(m.unpaired).toEqual([])
    expect(m.overflows).toBe(1)
    expect(m.replaces).toBe(1)
    expect(m.elided).toBe(0)
    expect(m.summaryRequests).toBe(1)
    expect(provider.requests.find((request) => request.kind === 'summary')?.model).toBe('compaction-model')
    expect(m.quotes).toBe(0)
    expect(m.failed).toBe(0)
  }, 60_000)

  it('elides an overflow without a request when the summary cannot fit the compaction window', async () => {
    const { session, log, provider } = await open({
      ...overflowSetup(4_000),
      separateCompactionModel: true,
    })
    const reasons = [await turn(session, 'read every file')]
    const m = await measure('overflow-elided', log, provider, reasons)
    expect(reasons).toEqual(['completed'])
    expect(m.unpaired).toEqual([])
    expect(m.overflows).toBe(1)
    expect(m.summaryRequests).toBe(0)
    expect(m.replaces).toBe(1)
    expect(m.elided).toBe(1)
    expect(m.quotes).toBe(0)
    expect(m.failed).toBe(0)
    const begin = m.rows.find((row) => row.type === 'x/core/compaction-begin')
    expect(begin?.data).toMatchObject({ mode: 'elided', cause: 'preflight-overflow' })
    expect(begin?.data).not.toHaveProperty('effectId')
    expect(
      m.rows.filter(
        (row) => row.type === 'cost/ledger' && (row.data as { purpose?: string }).purpose === 'compaction',
      ),
    ).toEqual([])
  }, 60_000)
})
