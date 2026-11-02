import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { presetDefaults } from '@agnes/core-common/step/preset'
import { createSqliteStorage } from '@agnes/host'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kernel } from '../../packages/core/src/kernel.js'
import { CompactionRunner } from '../../packages/core/src/step/compaction.js'
import { testFsOps, testWorkspaceInvocation } from '../../packages/core/test/helpers/open-session.js'
import {
  actor,
  defaultLoops,
  type FakeProvider,
  fakeProvider,
  fakeSeams,
  noTimers,
  readTool,
  type Script,
  textTurn,
  toolTurn,
} from '../../packages/core/testkit/index.js'
import { type LedgerEvent, openLedgerReadOnly } from './ledger-source.js'
import { collectDbSessions, computeTriggerStats } from './trigger-stats.js'

// The ledger below is written by the real core (Kernel, sessions, compaction runner) onto a real
// SQLite file, driven only by the fake provider: no model, no network, no key. The stats tool then
// reads that file through its read-only path.

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
const signal = () => new AbortController().signal

type ModelRecord = ReturnType<FakeProvider['models']>[number]

const model = (): ModelRecord => ({
  id: 'm1',
  name: 'm1',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  // Wide enough that only the explicit compaction requests below compact, never the threshold.
  contextWindow: 1_000_000,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})

const failedSummary: Script = [
  { type: 'error', reason: 'error', code: 'TRANSPORT', message: 'summary unavailable', retryable: false },
]

let dir: string
let file: string
let events: LedgerEvent[]

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rsi-real-ledger-'))
  file = join(dir, 'sessions.db')
  const storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
  // One scripted answer per inference call, in the order the sessions below make them.
  const provider = fakeProvider([
    // main turn 1: the same tool fails three times, then the turn ends
    toolTurn('read', { path: 'a' }),
    toolTurn('read', { path: 'b' }),
    toolTurn('read', { path: 'c' }),
    textTurn('first done'),
    // main turn 2
    textTurn('second done'),
    // main turn 3: a requested compaction that succeeds (its summary is the one call here)
    textTurn('S'),
    // main turn 4, after the compaction
    textTurn('fourth done'),
    // main turn 5: a requested compaction whose summary request fails
    failedSummary,
    // main turn 6
    textTurn('sixth done'),
    // fork child: the same tool fails three times in its own turn
    toolTurn('read', { path: 'x' }),
    toolTurn('read', { path: 'y' }),
    toolTurn('read', { path: 'z' }),
    textTurn('child done'),
  ])
  Object.assign(provider, { models: () => [model()] })
  const seams = fakeSeams()
  const k = Kernel.create({
    operations: [],
    loops: defaultLoops(),
    storage: storage as never,
    seams,
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: presetDefaults(),
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => 1_757_203_200_000,
  })
  k.tools.add(
    readTool(async () => {
      throw new Error('disk quota exceeded')
    }),
    { source: 'agnes/base', trust: 'builtin' },
  )
  const opts = {
    actor,
    resolvedProfileHash: 'h1',
    cwd: '/w',
    workspaceInvocation: testWorkspaceInvocation(testFsOps(), seams),
  }
  const main = await k.session('main-session', { ...opts, writerRunId: 'r1' })
  const prompt = async (text: string) => {
    await main.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
    expect((await main.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
  }
  const compact = async (admissionId: string) => {
    await main.requestCompaction({ actor, admissionId })
    expect((await main.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
  }
  main.compaction = new CompactionRunner({
    plan: async (payload) => {
      const nodes = payload.getSurface()
      const first = nodes[0]
      const penultimate = nodes.at(-2)
      const last = nodes.at(-1)
      if (!first || !penultimate || !last) throw new Error('nothing to compact')
      return {
        keepFromSeq: last.seq,
        summarizeRange: [first.seq, penultimate.seq] as [number, number],
        prompts: { system: 'Summarize.', history: 'Summarize the history.' },
        maxTokens: 50,
        details: { readFiles: [], modifiedFiles: [] },
      }
    },
    onCompact: async () => undefined,
  })
  await prompt('first')
  await prompt('second')
  await compact('compaction-ok')
  await prompt('fourth')
  await compact('compaction-failing')
  await prompt('sixth')

  const child = await k.session('child-session', {
    ...opts,
    writerRunId: 'r2',
    parent: { key: 'main-session', boundarySeq: main.lastSeq },
  })
  await child.enqueue('next-turn', { content: [{ type: 'text', text: 'child' }], actor })
  expect((await child.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')

  await k.close()
  await storage.close()
  const reader = openLedgerReadOnly(file)
  events = reader.events('main-session')
  reader.close()
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('trigger stats over a ledger written by the core', () => {
  it('reads the event types the core really writes', () => {
    const types = (type: string) => events.filter((e) => e.type === type)
    expect(types('turn/start')).toHaveLength(6)
    expect(types('x/core/compaction-end')).toHaveLength(1)
    expect(types('x/core/compaction-failed')).toHaveLength(1)
    const results = types('tool/result')
    expect(results).toHaveLength(3)
    for (const result of results) {
      expect(result.data).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('disk quota exceeded') }],
      })
      expect(result.origin).toBe('tool:read')
      expect(result.sourceEventSeqs).toHaveLength(1)
    }
  })

  it('counts repeated failures, compactions and the turns left after one', () => {
    const reader = openLedgerReadOnly(file)
    const main = new Map([['main-session', reader.events('main-session')]])
    reader.close()
    const stats = computeTriggerStats(main)
    expect(stats.sessions).toBe(1)
    // Turns 1 to 6: two prompts, a successful compaction, a prompt, a failed compaction, a prompt.
    expect(stats.turns).toBe(6)
    expect(stats.repeatedFailure.turns).toBe(1)
    expect(stats.repeatedFailure.turnRate).toBeCloseTo(1 / 6)
    expect(stats.compaction.ok).toBe(1)
    expect(stats.compaction.failed).toBe(1)
    expect(stats.compaction.per100Turns).toBeCloseTo((1 / 6) * 100)
    // Turns 4, 5 and 6 start after the compaction; the compacting turn itself runs no further step.
    expect(stats.compaction.remainingTurnsAfter).toEqual({ n: 1, p50: 3, p90: 3, max: 3 })
    expect(stats.compaction.remainingStepsInTurnAfter).toEqual({ n: 1, p50: 0, p90: 0, max: 0 })
    // The repeated failure and the compaction are far apart in time: no limit removes either.
    expect(stats.autoTriggers.raw).toBe(2)
  })

  it('leaves the fork child out of the CLI path', () => {
    const reader = openLedgerReadOnly(file)
    const all = reader.sessions()
    const childErrors = reader
      .events('child-session')
      .filter((e) => e.type === 'tool/result' && (e.data as { isError?: boolean }).isError)
    reader.close()
    expect(childErrors).toHaveLength(3)
    expect(all.map((s) => [s.key, s.parentKey])).toEqual(
      expect.arrayContaining([
        ['main-session', null],
        ['child-session', 'main-session'],
      ]),
    )
    const collected = collectDbSessions(file)
    expect([...collected.keys()]).toEqual(['main-session'])
    const stats = computeTriggerStats(collected)
    // The child failed the same tool three times in its own turn; none of that is counted.
    expect(stats.sessions).toBe(1)
    expect(stats.turns).toBe(6)
    expect(stats.repeatedFailure.turns).toBe(1)
    expect(stats.compaction).toMatchObject({ ok: 1, failed: 1 })
  })
})
