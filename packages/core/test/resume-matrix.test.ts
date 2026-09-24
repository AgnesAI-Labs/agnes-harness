// Exercises core Task 39's full-phase resume matrix against prefixes cut from real sessions. The
// deferred fixture proves a returned job survives the tools -> deferred phase edge before the
// poller gets a chance to finish it.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { openTracked } from '../src/reduce/tracker.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { canonicalJson, sha256Hex } from '../src/request/hash.js'
import { deferredEffectId } from '../src/step/deferred.js'
import { presetDefaults } from '../src/step/preset.js'
import type { Event } from '../src/types.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { noTimers, openSession, readTool, shellTool } from './helpers/open-session.js'

const dir = fileURLToPath(new URL('../fixtures/crash/', import.meta.url))
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith('.jsonl'))
  .sort()
const load = (f: string): Event[] =>
  readFileSync(dir + f, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Event)

const PHASE_KINDS = ['checkpoint', 'inference', 'tools', 'compaction', 'deferred', 'failure_drain']
const EXPECTED_REASON: Record<string, readonly string[]> = {
  checkpoint: ['completed'],
  inference: ['completed', 'error'],
  tools: ['completed', 'parked'],
  compaction: ['completed'],
  deferred: ['completed'],
  failure_drain: ['error', 'completed'],
}

const registry = (): ToolRegistry => {
  const r = new ToolRegistry()
  r.add(readTool(), { source: 's', trust: 'builtin' })
  r.add(shellTool(), { source: 's', trust: 'builtin' })
  return r
}

const dataOf = (e: Event): Record<string, unknown> => e.data as Record<string, unknown>
const pollingTimers = {
  setTimeout: (fn: () => void, ms: number) => {
    if (ms === 2_000) queueMicrotask(fn)
    return 0
  },
  clearTimeout: () => undefined,
}

describe('resume matrix (core Task 39)', () => {
  it('keeps deferred effect identities within protocol limits for maximum-size source ids', () => {
    const id = deferredEffectId('j'.repeat(128), 't'.repeat(128))
    expect(id).toMatch(/^job-[0-9a-f]{64}$/)
    expect(id.length).toBeLessThanOrEqual(128)
    expect(deferredEffectId('t'.repeat(128), 'j'.repeat(128))).not.toBe(id)
  })

  it('at least one fixture exists for every op.state phase kind', () => {
    expect(fixtures.length).toBeGreaterThan(0)
    const kinds = new Set<string>()
    for (const f of fixtures) {
      const rows = load(f)
      const cut = rows.at(-1)
      expect(cut?.type, f).toBe('op.state')
      const kind = ((cut?.data as { phase?: { kind?: unknown } } | null)?.phase?.kind ?? null) as
        | string
        | null
      expect(kind, `${f}: filename must describe the actual crash cut`).toBe(f.split('-')[1])
      if (kind) kinds.add(kind)
    }
    for (const k of PHASE_KINDS) expect([...kinds], k).toContain(k)
  })

  it('every fixture folds cleanly: the register table needs no rebuild on open', async () => {
    for (const f of fixtures) {
      const storage = MemoryStorage.fromEvents('k', load(f))
      const ids = defaultIds(() => 1_757_203_200_000)
      const { registersRebuilt } = await openTracked({
        storage,
        key: 'k',
        writerRunId: 'r',
        ttlMs: 60_000,
        ids,
        clock: () => 1_757_203_200_000,
        timers: noTimers,
      })
      expect(registersRebuilt, f).toBe(false)
    }
  })

  it('a crash fixture with a live writer lease refuses takeover through its deadline, then resumes', async () => {
    let now = 100
    const storage = MemoryStorage.fromEvents('k', load(fixtures[0] as string), {
      clock: () => now,
      lease: { writerRunId: 'dead-writer', ttlMs: 50 },
    })
    const open = () =>
      openSession({
        provider: fakeProvider([]),
        storage,
        key: 'k',
        clock: () => now,
      })

    await expect(open()).rejects.toThrow('E_WRITER_LEASE')
    now = 150
    await expect(open()).rejects.toThrow('E_WRITER_LEASE')
    now = 151
    const { session } = await open()
    expect(session.lastSeq).toBe(load(fixtures[0] as string).at(-1)?.seq)
    await expect(session.resume({ mode: 'close' })).resolves.toMatchObject({
      state: 'resumed',
      phase: 'terminal',
    })
    expect(session.op()).toBeNull()
    await session.close()
  })

  for (const f of fixtures) {
    it(`${f}: continue resume does not throw and leaves no call unresolved outside a park`, async () => {
      const storage = MemoryStorage.fromEvents('k', load(f))
      const { session, log } = await openSession({
        provider: fakeProvider([textTurn('after'), textTurn('after2'), textTurn('after3')]),
        registry: registry(),
        storage,
        key: 'k',
        timers: pollingTimers,
      })
      const hadOpenTurn = session.op() !== null
      const rep = await session.resume()
      expect(rep.state).toBe(hadOpenTurn ? 'resumed' : 'idle')
      await session.run({ until: 'turn-end', signal: new AbortController().signal })
      const all = await log.scan({ fromSeq: 1, limit: 100_000 })
      const lastEnd = [...all].reverse().find((e) => e.type === 'turn/end')
      const phase = f.split('-')[1] as string
      expect(EXPECTED_REASON[phase], f).toContain(dataOf(lastEnd as Event).reason)
      // A turn that ended parked is allowed to leave a sibling call unresolved: v0.1's
      // unknown-outcome path stops the whole turn without touching calls it had not reached yet.
      // Anything else - completed, error, aborted, budget, max_steps - must not.
      if (dataOf(lastEnd as Event).reason !== 'parked') {
        const calls = all.filter((e) => e.type === 'tool/call')
        const results = all.filter((e) => e.type === 'tool/result')
        for (const c of calls)
          expect(
            results.some((r) => dataOf(r).toolUseId === dataOf(c).toolUseId),
            `${f}: ${dataOf(c).toolUseId} has no matching tool/result`,
          ).toBe(true)
      }
    })

    it(`${f}: close mode synthesizes closers, tombstones op.state, and leaves no open turn`, async () => {
      const storage = MemoryStorage.fromEvents('k', load(f))
      const { session, log } = await openSession({
        provider: fakeProvider([]),
        registry: registry(),
        storage,
        key: 'k',
      })
      await session.resume({ mode: 'close' })
      expect(session.op()).toBeNull()
      expect(session.pendingEffects()).toEqual([])
      const all = await log.scan({ fromSeq: 1, limit: 100_000 })
      const lastEnd = [...all].reverse().find((e) => e.type === 'turn/end')
      expect(dataOf(lastEnd as Event).reason).toBe('interrupted')
      const calls = all.filter((e) => e.type === 'tool/call')
      const results = all.filter((e) => e.type === 'tool/result')
      for (const c of calls)
        expect(
          results.some((r) => dataOf(r).toolUseId === dataOf(c).toolUseId),
          `${f}: ${dataOf(c).toolUseId} has no matching tool/result after close`,
        ).toBe(true)
    })
  }

  it('interrupted child effects surface to the parent as CHILD_INTERRUPTED (recovery.unknownChild = model)', async () => {
    const f = fixtures.find((x) => x.includes('-tools-child'))
    expect(f, 'a tools-child fixture must exist').toBeDefined()
    const events = load(f as string)
    const storage = MemoryStorage.fromEvents('k', events)
    const childIntent = events.find(
      (e) => e.type === 'effect/intent' && dataOf(e).parentEffectId !== undefined,
    )
    expect(childIntent, 'the fixture must carry a still-pending child effect').toBeDefined()
    const parentEffectId = dataOf(childIntent as Event).parentEffectId as string
    const parentIntent = events.find(
      (e) => e.type === 'effect/intent' && dataOf(e).effectId === parentEffectId,
    )
    const parentToolUseId = (dataOf(parentIntent as Event).tool as { toolUseId: string }).toolUseId
    const childToolUseId = (dataOf(childIntent as Event).tool as { toolUseId: string }).toolUseId

    const { session, log } = await openSession({
      provider: fakeProvider([textTurn('after')]),
      registry: registry(),
      storage,
      key: 'k',
    })
    await session.resume()

    const results = (await log.scan({ type: 'tool/result', limit: 100 })).map((e) => dataOf(e))
    const parentResult = results.find((r) => r.toolUseId === parentToolUseId)
    expect(parentResult).toMatchObject({ code: 'CHILD_INTERRUPTED', isError: true })
    const content = parentResult?.content as Array<{ type: string; text?: string }>
    expect(JSON.parse(content[0]?.text ?? '{}')).toMatchObject({
      interrupted: true,
      effects: [{ kind: 'tool' }],
    })
    const childResult = results.find((r) => r.toolUseId === childToolUseId)
    expect(childResult).toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN', isError: true })
    expect(await log.scan({ type: 'x/core/child-interrupted', limit: 5 })).toHaveLength(1)
    // Both the parent and the child are settled - nothing from this subtree is left pending.
    expect(session.pendingEffects()).toEqual([])
  })

  it('parks for a human after closing an interrupted child subtree when policy requires it', async () => {
    const f = fixtures.find((x) => x.includes('-tools-child'))
    expect(f, 'a tools-child fixture must exist').toBeDefined()
    const preset = { ...presetDefaults(), recovery: { unknownChild: 'human' as const } }
    const { session, log } = await openSession({
      provider: fakeProvider([]),
      storage: MemoryStorage.fromEvents('k', load(f as string)),
      key: 'k',
      preset,
      seams: fakeSeams({ approval: { ask: async () => 'rejected' } }),
    })

    expect((await session.resume()).actions).toContainEqual({
      effectId: expect.any(String),
      action: 'unknown',
    })
    expect(session.op()).toBeNull()
    expect((await log.scan({ type: 'approval/asked', order: 'desc', limit: 1 }))[0]?.data).toMatchObject({
      kind: 'unknown-outcome',
    })
    expect((await log.scan({ type: 'turn/end', order: 'desc', limit: 1 }))[0]?.data).toMatchObject({
      reason: 'parked',
    })
    expect(session.pendingEffects()).toEqual([])
  })

  it('a pending effect whose tool is missing on resume is unknown and parked instead of declared not-found', async () => {
    const f = fixtures.find((x) => {
      if (!x.includes('-tools-batch')) return false
      const rows = load(x)
      const settled = new Set(
        rows.filter((row) => row.type === 'effect/settled').map((row) => dataOf(row).effectId as string),
      )
      return rows.some(
        (row) =>
          row.type === 'effect/intent' &&
          dataOf(row).kind === 'tool' &&
          !settled.has(dataOf(row).effectId as string),
      )
    })
    expect(f, 'a tools-batch fixture must exist').toBeDefined()
    const storage = MemoryStorage.fromEvents('k', load(f as string))
    const { session, log } = await openSession({
      provider: fakeProvider([textTurn('after')]),
      // Empty: simulates the tool having been removed from the profile since the crash.
      registry: new ToolRegistry(),
      storage,
      key: 'k',
    })
    const rep = await session.resume()
    expect(rep.actions.some((a) => a.action === 'unknown')).toBe(true)
    const results = await log.scan({ type: 'tool/result', limit: 20 })
    expect(results.some((e) => dataOf(e).code === 'TOOL_OUTCOME_UNKNOWN')).toBe(true)
    expect(
      (await log.scan({ type: 'x/core/tool-policy-refused-on-resume', limit: 5 }))[0]?.data,
    ).toMatchObject({ reason: expect.stringMatching(/tool-definition-missing|persisted-policy-missing/) })
    // Not re-run: the tool is gone, and the human reconciliation path parks safely.
    expect(session.pendingEffects()).toEqual([])
  })

  it('reopens a real pending safe call and replays only from its matching persisted policy envelope', async () => {
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const stalled = new Promise<{ content: Array<{ type: 'text'; text: string }> }>((resolve) => {
      release = () => resolve({ content: [{ type: 'text', text: 'first process returned' }] })
    })
    const execute = vi.fn(async () => {
      entered()
      return stalled
    })
    const tools = new ToolRegistry()
    tools.add(readTool(execute), { source: 'agnes/tools-core', trust: 'builtin' })
    const original = await openSession({ provider: fakeProvider([toolTurn('read', {})]), registry: tools })
    await original.session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'go' }],
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    })
    await original.session.acceptInput()
    expect(await original.session.runInference()).toEqual({ phase: 'tools' })
    const running = original.session.runToolsPhase()
    await started

    const crashPrefix = await original.log.scan({ fromSeq: 1, toSeq: original.log.lastSeq, limit: 10_000 })
    expect(crashPrefix.at(-1)?.type).toBe('op.state')
    expect(original.session.pendingEffects()).toHaveLength(1)

    const reopenedExecute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'replayed' }],
    }))
    const reopenedTools = new ToolRegistry()
    reopenedTools.add(readTool(reopenedExecute), { source: 'agnes/tools-core', trust: 'builtin' })
    const reopened = await openSession({
      provider: fakeProvider([]),
      registry: reopenedTools,
      storage: MemoryStorage.fromEvents('k', crashPrefix),
      writerRunId: 'reopened',
    })
    try {
      expect(await reopened.session.resume()).toMatchObject({
        phase: 'tools',
        actions: [{ action: 'rerun' }],
      })
      expect(await reopened.session.runToolsPhase()).toEqual({ phase: 'checkpoint' })
      expect(reopenedExecute).toHaveBeenCalledTimes(1)
      expect(
        await reopened.log.scan({ type: 'x/core/tool-policy-refused-on-resume', limit: 5 }),
      ).toHaveLength(0)
    } finally {
      await reopened.session.close()
      release()
      await running
      await original.session.close()
    }
  })

  it('parks a reopened call when op.state policy binding disagrees with its tool/call ledger row', async () => {
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const stalled = new Promise<{ content: Array<{ type: 'text'; text: string }> }>((resolve) => {
      release = () => resolve({ content: [{ type: 'text', text: 'first process returned' }] })
    })
    const tools = new ToolRegistry()
    tools.add(
      readTool(async () => {
        entered()
        return stalled
      }),
      { source: 'agnes/tools-core', trust: 'builtin' },
    )
    const original = await openSession({ provider: fakeProvider([toolTurn('read', {})]), registry: tools })
    await original.session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'go' }],
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    })
    await original.session.acceptInput()
    await original.session.runInference()
    const running = original.session.runToolsPhase()
    await started
    const crashPrefix = structuredClone(
      await original.log.scan({ fromSeq: 1, toSeq: original.log.lastSeq, limit: 10_000 }),
    )
    const stateRow = [...crashPrefix].reverse().find((row) => row.type === 'op.state')
    const state = stateRow?.data as {
      phase?: {
        kind?: string
        batch?: { calls?: Array<{ policyHash?: string; resolvedPolicy?: Record<string, unknown> }> }
      }
    }
    if (state.phase?.kind !== 'tools' || !state.phase.batch?.calls?.[0])
      throw new Error('missing persisted call state')
    const persisted = state.phase.batch.calls[0]
    if (!persisted.resolvedPolicy) throw new Error('missing persisted policy')
    persisted.resolvedPolicy = { ...persisted.resolvedPolicy, replay: 'never' }
    persisted.policyHash = sha256Hex(canonicalJson(persisted.resolvedPolicy))

    const reopened = await openSession({
      provider: fakeProvider([]),
      registry: tools,
      storage: MemoryStorage.fromEvents('k', crashPrefix),
      writerRunId: 'reopened-tampered',
    })
    try {
      expect(await reopened.session.resume()).toMatchObject({ actions: [{ action: 'unknown' }] })
      expect(reopened.session.op()).toBeNull()
      expect(
        (await reopened.log.scan({ type: 'x/core/tool-policy-refused-on-resume', limit: 5 }))[0]?.data,
      ).toMatchObject({ reason: 'ledger-state-policy-mismatch' })
      expect(await reopened.log.scan({ type: 'tool/result', order: 'desc', limit: 1 })).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ code: 'TOOL_OUTCOME_UNKNOWN' }) }),
      ])
    } finally {
      await reopened.session.close()
      release()
      await running
      await original.session.close()
    }
  })

  it('polls a deferred job with the preset delay, then lands its artifact link and resumes', async () => {
    const f = fixtures.find((x) => x.split('-')[1] === 'deferred')
    expect(f, 'a deferred fixture must exist').toBeDefined()
    let polls = 0
    const waits: number[] = []
    const timers = {
      setTimeout: (fn: () => void, ms: number) => {
        // Lease-renew timers deliberately remain dormant. Only the short deferred poll wait fires.
        if (ms === 7) queueMicrotask(fn)
        waits.push(ms)
        return 0
      },
      clearTimeout: () => undefined,
    }
    const preset = { ...presetDefaults(), deferred: { pollMs: 7 } }
    const { session, log } = await openSession({
      provider: fakeProvider([textTurn('after job')]),
      storage: MemoryStorage.fromEvents('k', load(f as string)),
      key: 'k',
      preset,
      timers,
      seams: fakeSeams({
        artifacts: {
          poll: async (jobId) =>
            ++polls === 1
              ? { jobId, status: 'running' }
              : {
                  jobId,
                  status: 'done',
                  ref: { sha256: 'd'.repeat(64), size: 1, mime: 'text/csv' },
                },
        },
      }),
    })

    expect(await session.resume()).toMatchObject({
      phase: 'deferred',
      actions: [{ action: 'poll' }],
    })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(polls).toBe(2)
    expect(waits).toContain(7)
    const result = (await log.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]
    expect(result?.data).toMatchObject({
      isError: false,
      content: [{ type: 'resource_link', uri: `artifact://${'d'.repeat(64)}`, mimeType: 'text/csv' }],
    })
    expect(result?.trust).toBe('untrusted')
    expect(session.latest('artifact/job', 'job-1')).toMatchObject({ status: 'done' })
    expect(session.pendingEffects()).toEqual([])
  })

  it('recovers the durable job mapping when killed before tools hands off to deferred', async () => {
    const f = fixtures.find((x) => x.includes('-tools-deferred-ready'))
    expect(f, 'a tools-deferred-ready fixture must exist').toBeDefined()
    let polls = 0
    const { session, log } = await openSession({
      provider: fakeProvider([textTurn('after job')]),
      storage: MemoryStorage.fromEvents('k', load(f as string)),
      key: 'k',
      seams: fakeSeams({
        artifacts: {
          poll: async (jobId) => {
            polls++
            return {
              jobId,
              status: 'done',
              ref: { sha256: 'e'.repeat(64), size: 2, mime: 'application/json' },
            }
          },
        },
      }),
      timers: pollingTimers,
    })

    expect(await session.resume()).toMatchObject({
      phase: 'tools',
      actions: [{ action: 'poll' }],
    })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(polls).toBe(1)
    expect((await log.scan({ type: 'tool/result', limit: 10 }))[0]?.data).toMatchObject({
      isError: false,
      content: [{ uri: `artifact://${'e'.repeat(64)}` }],
    })
  })

  it('keeps a deferred phase and its call open when polling fails', async () => {
    const f = fixtures.find((x) => x.split('-')[1] === 'deferred')
    expect(f, 'a deferred fixture must exist').toBeDefined()
    const { session, log } = await openSession({
      provider: fakeProvider([]),
      storage: MemoryStorage.fromEvents('k', load(f as string)),
      key: 'k',
      seams: fakeSeams({
        artifacts: {
          poll: async () => {
            throw new Error('offline')
          },
        },
      }),
    })

    await session.resume()
    expect(await session.step()).toEqual({ phase: 'deferred' })
    expect(session.op()?.phase.kind).toBe('deferred')
    expect(await log.scan({ type: 'tool/result', limit: 20 })).toHaveLength(0)
    expect(session.state.openStep.get('main')).toMatchObject({ turn: 1, step: 1 })
  })

  it('records a failed deferred job, closes its step, and resumes the saved phase', async () => {
    const f = fixtures.find((x) => x.split('-')[1] === 'deferred')
    expect(f, 'a deferred fixture must exist').toBeDefined()
    const { session, log } = await openSession({
      provider: fakeProvider([]),
      storage: MemoryStorage.fromEvents('k', load(f as string)),
      key: 'k',
      seams: fakeSeams({
        artifacts: {
          poll: async (jobId) => ({ jobId, status: 'failed', error: 'renderer crashed' }),
        },
      }),
    })

    await session.resume()
    expect(await session.step()).toEqual({ phase: 'checkpoint' })
    expect(session.op()?.phase.kind).toBe('checkpoint')
    expect(session.state.openStep.get('main')).toBeUndefined()
    expect(session.latest('artifact/job', 'job-1')).toMatchObject({
      status: 'failed',
      error: 'renderer crashed',
    })
    expect((await log.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.data).toMatchObject({
      code: 'JOB_FAILED',
      isError: true,
      content: [{ text: 'renderer crashed' }],
    })
    expect(session.pendingEffects()).toEqual([])
  })

  it('does not spend the in-process edge guard while a real deferred job is still running', async () => {
    const f = fixtures.find((x) => x.split('-')[1] === 'deferred')
    expect(f, 'a deferred fixture must exist').toBeDefined()
    let polls = 0
    const preset = {
      ...presetDefaults(),
      budget: { ...presetDefaults().budget, maxSteps: 2 },
      deferred: { pollMs: 1 },
    }
    const timers = {
      setTimeout: (fn: () => void, ms: number) => {
        if (ms === 1) queueMicrotask(fn)
        return 0
      },
      clearTimeout: () => undefined,
    }
    const { session } = await openSession({
      provider: fakeProvider([textTurn('after job')]),
      storage: MemoryStorage.fromEvents('k', load(f as string)),
      key: 'k',
      preset,
      timers,
      seams: fakeSeams({
        artifacts: {
          poll: async (jobId) =>
            ++polls <= 110
              ? { jobId, status: 'running' }
              : {
                  jobId,
                  status: 'done',
                  ref: { sha256: 'f'.repeat(64), size: 1, mime: 'text/plain' },
                },
        },
      }),
    })

    await session.resume()
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(polls).toBe(111)
  })

  it('close mode answers a deferred call as unknown in the same terminal close', async () => {
    const f = fixtures.find((x) => x.split('-')[1] === 'deferred')
    expect(f, 'a deferred fixture must exist').toBeDefined()
    const { session, log } = await openSession({
      provider: fakeProvider([]),
      storage: MemoryStorage.fromEvents('k', load(f as string)),
      key: 'k',
    })

    const closeStartsAt = session.lastSeq + 1
    await session.resume({ mode: 'close' })
    const tail = await log.scan({ fromSeq: closeStartsAt, toSeq: session.lastSeq })
    expect(tail.map((row) => row.type)).toEqual([
      'effect/settled',
      'tool/result',
      'x/core/resume-closed',
      'step/end',
      'turn/end',
      'op.state',
    ])
    expect(tail.find((row) => row.type === 'tool/result')?.data).toMatchObject({
      code: 'TOOL_OUTCOME_UNKNOWN',
    })
    expect(tail.find((row) => row.type === 'effect/settled')?.data).toMatchObject({
      outcome: 'unknown',
    })
    expect(session.op()).toBeNull()
  })

  it('cancelling a deferred phase closes the pending call instead of losing it', async () => {
    const f = fixtures.find((x) => x.split('-')[1] === 'deferred')
    expect(f, 'a deferred fixture must exist').toBeDefined()
    const { session, log } = await openSession({
      provider: fakeProvider([]),
      storage: MemoryStorage.fromEvents('k', load(f as string)),
      key: 'k',
    })
    await session.resume()
    await session.abort()

    expect(await session.step()).toEqual({ phase: 'terminal', reason: 'aborted' })
    expect((await log.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.data).toMatchObject({
      code: 'TOOL_OUTCOME_UNKNOWN',
      isError: true,
    })
    expect((await log.scan({ type: 'effect/settled', order: 'desc', limit: 1 }))[0]?.data).toMatchObject({
      outcome: 'unknown',
    })
    expect((await log.scan({ type: 'turn/end', order: 'desc', limit: 1 }))[0]?.data).toMatchObject({
      reason: 'aborted',
    })
    expect(session.op()).toBeNull()
    expect(session.state.openStep.get('main')).toBeUndefined()
    expect(session.pendingEffects()).toEqual([])
  })

  it('does not poll a deferred marker for a job the session never submitted', async () => {
    let polls = 0
    const r = new ToolRegistry()
    r.add(
      readTool(
        async () =>
          ({
            content: [{ type: 'text', text: 'forged' }],
            deferred: { jobId: 'foreign-job' },
          }) as never,
      ),
      { source: 's', trust: 'builtin' },
    )
    const { session, log } = await openSession({
      provider: fakeProvider([toolTurn('read', {}), textTurn('after')]),
      registry: r,
      seams: fakeSeams({
        artifacts: {
          poll: async (jobId) => {
            polls++
            return { jobId, status: 'running' }
          },
        },
      }),
    })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'go' }],
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    })

    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(polls).toBe(0)
    expect((await log.scan({ type: 'tool/result', limit: 10 }))[0]?.data).toMatchObject({
      code: 'JOB_FAILED',
      isError: true,
    })
    expect(await log.scan({ type: 'x/core/deferred-job', limit: 10 })).toHaveLength(0)
  })
})
