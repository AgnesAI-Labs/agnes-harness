import type { ToolDef } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import type { SeamImplementations } from '../src/effects/seams.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { canonicalJson, sha256Hex } from '../src/request/hash.js'
import { withPhase } from '../src/step/op-state.js'
import { fakeProvider, sent, textTurn, toolTurn, usage } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, openWorldTool, readTool } from './helpers/open-session.js'

/**
 * The shape base's loop-hygiene verifierT0 blind-casts `input` into
 * (packages/base/extensions/loop-hygiene/src/verifier.ts). Core constructs it; these tests pin what
 * each of the four verify call sites actually hands over, because a field that is missing or
 * mistyped does not fail here — it fails inside the seam, where wrap.ts reads it as
 * 'verifier unavailable'.
 */
type Captured = { scope: 'tool' | 'step' | 'turn' | 'task'; input: Record<string, unknown> }

const spySeams = (captured: Captured[]): SeamImplementations =>
  fakeSeams({
    verifier: {
      verify: async (scope, input) => {
        captured.push({ scope, input: input as Record<string, unknown> })
        return { verdict: 'pass', reasons: [] }
      },
    },
  })

const expectContract = (input: Record<string, unknown> | undefined): void => {
  expect(input).toBeDefined()
  const x = input as Record<string, unknown>
  expect(Array.isArray(x.toolCalls)).toBe(true)
  for (const c of x.toolCalls as Array<Record<string, unknown>>) {
    expect(typeof c.name).toBe('string')
    expect(c).toHaveProperty('args')
    expect(typeof c.schemaOk).toBe('boolean')
  }
  expect(typeof x.deviations).toBe('number')
  expect(Array.isArray(x.recentToolKeys)).toBe(true)
  expect(Array.isArray(x.surfaceTailHashes)).toBe(true)
  expect(typeof x.newToolResults).toBe('number')
}

const withRead = (): ToolRegistry => {
  const r = new ToolRegistry()
  r.add(readTool() as never, { source: 's', trust: 'builtin' })
  return r
}

const sig = () => new AbortController().signal

const readyDeferred = async () => {
  const deferred: ToolDef = {
    ...(readTool() as ToolDef),
    name: 'export_job',
    execute: async (_args, ctx) =>
      ({
        content: [{ type: 'text' as const, text: 'queued' }],
        deferred: {
          jobId: await ctx.artifacts.submitJob({
            idempotencyKey: 'deferred-provenance-fixture',
            payload: { prompt: 'fixture' },
          }),
        },
      }) as never,
  }
  const registry = new ToolRegistry()
  registry.add(deferred as never, { source: 's', trust: 'builtin' })
  const opened = await openSession({
    provider: fakeProvider([toolTurn('export_job', {})]),
    registry,
    seams: fakeSeams({
      artifacts: {
        poll: async (jobId) => ({
          jobId,
          status: 'done',
          ref: { sha256: 'c'.repeat(64), size: 1, mime: 'text/plain' },
        }),
      },
    }),
  })
  await opened.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
  await opened.session.acceptInput()
  await opened.session.runInference()
  expect(await opened.session.runToolsPhase()).toEqual({ phase: 'deferred' })
  return opened
}

describe('verify input contract', () => {
  it('tool, step and turn scopes carry the real call, its schema verdict and the finish reason', async () => {
    const captured: Captured[] = []
    const { session } = await openSession({
      provider: fakeProvider([toolTurn('read', { path: 'a' }), textTurn('done')]),
      registry: withRead(),
      seams: spySeams(captured),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    expect(captured.map((c) => c.scope)).toEqual(['tool', 'step', 'turn'])
    for (const c of captured) expectContract(c.input)

    // tools.ts approveAndExecute: exactly the call that just ran, with the dispatch's own
    // schema-validation result, against this step's deviation count.
    const tool = captured[0]?.input
    expect(tool?.toolCalls).toEqual([{ name: 'read', args: { path: 'a' }, schemaOk: true }])
    expect(tool?.deviations).toBe(0)
    expect(tool?.lastFinishReason).toBe('tool_use')

    // tools.ts runToolsPhase: the same step read back from the ledger, call included.
    const step = captured[1]?.input
    expect(step?.toolCalls).toEqual([{ name: 'read', args: { path: 'a' }, schemaOk: true }])
    expect(step?.deviations).toBe(0)
    expect(step?.lastFinishReason).toBe('tool_use')

    // gate.ts stopGate: the whole turn, with the repeated-write and no-progress projections.
    const turn = captured[2]?.input
    expect(turn?.toolCalls).toEqual([{ name: 'read', args: { path: 'a' }, schemaOk: true }])
    expect(turn?.recentToolKeys).toEqual([`read|${canonicalJson({ path: 'a' })}`])
    expect(turn?.surfaceTailHashes).toEqual([sha256Hex(''), sha256Hex('done')])
    expect(turn?.newToolResults).toBe(0)
    expect(turn?.deviations).toBe(0)
    expect(turn?.lastFinishReason).toBe('stop')
  })

  it('counts format/deviation rows into deviations at every scope', async () => {
    const captured: Captured[] = []
    const { session } = await openSession({
      // A call the parser recovered from text (via 'inline_json') writes one format/deviation row.
      provider: fakeProvider([
        [
          sent(),
          {
            type: 'toolcall_end',
            call: { toolUseId: '', name: 'read', args: { path: 'a' }, ordinal: 0 },
            via: 'inline_json',
          },
          usage(),
          { type: 'done', reason: 'toolUse' },
        ],
        textTurn('done'),
      ]),
      registry: withRead(),
      seams: spySeams(captured),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    expect(captured.map((c) => c.scope)).toEqual(['tool', 'step', 'turn'])
    for (const c of captured) {
      expectContract(c.input)
      expect(c.input.deviations).toBe(1)
    }
    expect(captured[2]?.input.recentToolKeys).toEqual([`read|${canonicalJson({ path: 'a' })}`])
  })

  it('turn scope on a text-only turn: empty projections and a stop finish reason', async () => {
    const captured: Captured[] = []
    const { session } = await openSession({
      provider: fakeProvider([textTurn('ok')]),
      seams: spySeams(captured),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    expect(captured.map((c) => c.scope)).toEqual(['turn'])
    const turn = captured[0]?.input
    expectContract(turn)
    expect(turn?.toolCalls).toEqual([])
    expect(turn?.recentToolKeys).toEqual([])
    expect(turn?.surfaceTailHashes).toEqual([sha256Hex('ok')])
    expect(turn?.newToolResults).toBe(0)
    expect(turn?.deviations).toBe(0)
    expect(turn?.lastFinishReason).toBe('stop')
  })

  it('step scope on the deferred-resume path reads the still-open step from the ledger', async () => {
    const captured: Captured[] = []
    const deferred: ToolDef = {
      ...(readTool() as ToolDef),
      name: 'export_job',
      execute: async (_args, ctx) =>
        ({
          content: [{ type: 'text' as const, text: 'queued' }],
          deferred: {
            jobId: await ctx.artifacts.submitJob({
              idempotencyKey: 'verify-input-fixture',
              payload: { prompt: 'fixture' },
            }),
          },
        }) as never,
    }
    const registry = new ToolRegistry()
    registry.add(deferred as never, { source: 's', trust: 'builtin' })
    const { session } = await openSession({
      provider: fakeProvider([toolTurn('export_job', {}), textTurn('done')]),
      registry,
      seams: spySeams(captured),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await session.acceptInput()
    await session.runInference()
    expect(await session.runToolsPhase()).toEqual({ phase: 'deferred' })
    // session.ts runDeferred: the poll settles the job and the step verify runs against the
    // still-open step before step/end is written.
    expect(await session.runDeferred()).toEqual({ phase: 'checkpoint' })
    const step = captured.find((c) => c.scope === 'step')?.input
    expectContract(step)
    expect(step?.toolCalls).toEqual([{ name: 'export_job', args: {}, schemaOk: true }])
    expect(step?.deviations).toBe(0)
    expect(step?.lastFinishReason).toBe('tool_use')
    expect((await session.d.log.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.trust).toBe(
      'trusted',
    )
  })

  it('keeps an open-world deferred result untrusted using the durable call policy', async () => {
    const deferred: ToolDef = {
      ...(openWorldTool() as ToolDef),
      name: 'export_external_job',
      execute: async (_args, ctx) =>
        ({
          content: [{ type: 'text' as const, text: 'queued' }],
          deferred: {
            jobId: await ctx.artifacts.submitJob({
              idempotencyKey: 'open-world-deferred',
              payload: { prompt: 'fixture' },
            }),
          },
        }) as never,
    }
    const registry = new ToolRegistry()
    registry.add(deferred as never, { source: 's', trust: 'builtin' })
    const { session, log, tracker } = await openSession({
      provider: fakeProvider([toolTurn('export_external_job', {})]),
      registry,
      seams: fakeSeams({
        artifacts: {
          poll: async (jobId) => ({
            jobId,
            status: 'done',
            ref: { sha256: 'f'.repeat(64), size: 3, mime: 'text/plain' },
          }),
        },
      }),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await session.acceptInput()
    await session.runInference()
    const turn = session.turn
    const registered = turn?.snapshot.byName.get('export_external_job')
    if (!turn || !registered) throw new Error('missing inferred tool snapshot')
    const byName = new Map(turn.snapshot.byName)
    byName.set('export_external_job', {
      ...registered,
      meta: { ...registered.meta, isOpenWorld: false },
    })
    session.turn = { ...turn, snapshot: { ...turn.snapshot, byName } }
    expect(await session.runToolsPhase()).toEqual({ phase: 'deferred' })
    expect(await session.runDeferred()).toEqual({ phase: 'checkpoint' })
    expect((await log.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.trust).toBe('untrusted')
    expect(tracker.state.taint.get('main')).toBe(true)
  })

  it.each([
    ['policy hash mismatch', (data: Record<string, unknown>) => ({ ...data, policyHash: '0'.repeat(64) })],
    ['toolUseId mismatch', (data: Record<string, unknown>) => ({ ...data, toolUseId: 'other-call' })],
  ])('fails closed on deferred %s', async (_case, tamper) => {
    const deferred: ToolDef = {
      ...(readTool() as ToolDef),
      name: 'export_job',
      execute: async (_args, ctx) =>
        ({
          content: [{ type: 'text' as const, text: 'queued' }],
          deferred: {
            jobId: await ctx.artifacts.submitJob({
              idempotencyKey: 'mismatched-policy-hash',
              payload: { prompt: 'fixture' },
            }),
          },
        }) as never,
    }
    const registry = new ToolRegistry()
    registry.add(deferred as never, { source: 's', trust: 'builtin' })
    const { session, log } = await openSession({
      provider: fakeProvider([toolTurn('export_job', {})]),
      registry,
      seams: fakeSeams({
        artifacts: {
          poll: async (jobId) => ({
            jobId,
            status: 'done',
            ref: { sha256: 'a'.repeat(64), size: 1, mime: 'text/plain' },
          }),
        },
      }),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await session.acceptInput()
    await session.runInference()
    expect(await session.runToolsPhase()).toEqual({ phase: 'deferred' })
    const scan = session.d.log.scan.bind(session.d.log)
    vi.spyOn(session.d.log, 'scan').mockImplementation(async (query) => {
      const rows = await scan(query)
      return rows.map((row) =>
        row.type === 'tool/call' ? { ...row, data: tamper(row.data as Record<string, unknown>) } : row,
      )
    })
    expect(await session.runDeferred()).toEqual({ phase: 'checkpoint' })
    expect((await log.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.trust).toBe('untrusted')
  })

  it('fails closed when a deferred marker is not trusted Core output', async () => {
    const { session, log } = await readyDeferred()
    const scan = session.d.log.scan.bind(session.d.log)
    vi.spyOn(session.d.log, 'scan').mockImplementation(async (query) =>
      (await scan(query)).map((row) =>
        row.type === 'x/core/deferred-job'
          ? { ...row, origin: 'ext:hostile', trust: 'untrusted' as const }
          : row,
      ),
    )
    expect(await session.runDeferred()).toEqual({ phase: 'checkpoint' })
    expect((await log.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.trust).toBe('untrusted')
  })

  it('fails closed when a deferred result points at an untrusted tool call', async () => {
    const { session, log } = await readyDeferred()
    const scan = session.d.log.scan.bind(session.d.log)
    vi.spyOn(session.d.log, 'scan').mockImplementation(async (query) =>
      (await scan(query)).map((row) =>
        row.type === 'tool/call' ? { ...row, origin: 'ext:hostile', trust: 'untrusted' as const } : row,
      ),
    )
    expect(await session.runDeferred()).toEqual({ phase: 'checkpoint' })
    expect((await log.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.trust).toBe('untrusted')
  })

  it('fails closed when a legacy deferred marker borrows a call outside the open step', async () => {
    const { session, log } = await readyDeferred()
    const op = session.op()
    if (op?.phase.kind !== 'deferred') throw new Error('missing deferred phase')
    await session.transition(
      [],
      withPhase(op, {
        ...op.phase,
        jobs: op.phase.jobs.map((job) => ({ jobId: job.jobId, toolUseId: job.toolUseId })),
      }),
    )
    const scan = session.d.log.scan.bind(session.d.log)
    const [marker] = await scan({ type: 'x/core/deferred-job', order: 'asc', limit: 1 })
    const [call] = await scan({ type: 'tool/call', order: 'asc', limit: 1 })
    if (!marker || !call) throw new Error('missing deferred provenance rows')
    const priorSeq = 1
    vi.spyOn(session.d.log, 'scan').mockImplementation(async (query) => {
      if (query.type === 'x/core/deferred-job')
        return (await scan(query)).map((row) => ({ ...row, sourceEventSeqs: [priorSeq] }))
      if (query.fromSeq === priorSeq && query.toSeq === priorSeq && query.limit === 1)
        return [{ ...call, seq: priorSeq }]
      return scan(query)
    })
    expect(await session.runDeferred()).toEqual({ phase: 'checkpoint' })
    expect((await log.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.trust).toBe('untrusted')
  })

  it('fails closed when a legacy deferred marker is duplicated beyond the first scan page', async () => {
    const deferred: ToolDef = {
      ...(readTool() as ToolDef),
      name: 'export_job',
      execute: async (_args, ctx) =>
        ({
          content: [{ type: 'text' as const, text: 'queued' }],
          deferred: {
            jobId: await ctx.artifacts.submitJob({
              idempotencyKey: 'legacy-paginated-marker',
              payload: { prompt: 'fixture' },
            }),
          },
        }) as never,
    }
    const registry = new ToolRegistry()
    registry.add(deferred as never, { source: 's', trust: 'builtin' })
    const { session, log } = await openSession({
      provider: fakeProvider([toolTurn('export_job', {})]),
      registry,
      seams: fakeSeams({
        artifacts: {
          poll: async (jobId) => ({
            jobId,
            status: 'done',
            ref: { sha256: 'b'.repeat(64), size: 1, mime: 'text/plain' },
          }),
        },
      }),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await session.acceptInput()
    await session.runInference()
    expect(await session.runToolsPhase()).toEqual({ phase: 'deferred' })

    const op = session.op()
    if (op?.phase.kind !== 'deferred') throw new Error('missing deferred phase')
    await session.transition(
      [],
      withPhase(op, {
        ...op.phase,
        jobs: op.phase.jobs.map((job) => ({ jobId: job.jobId, toolUseId: job.toolUseId })),
      }),
    )
    const [marker] = await log.scan({ type: 'x/core/deferred-job', order: 'asc', limit: 1 })
    if (marker?.sourceEventSeqs?.length !== 1) throw new Error('missing deferred marker')
    const markerSources = marker.sourceEventSeqs
    await log.append([
      ...Array.from({ length: 999 }, (_, index) =>
        session.ev(
          'x/core/deferred-job',
          { jobId: `decoy-${index}`, toolUseId: 'other-call' },
          { ignorable: true, sourceEventSeqs: markerSources },
        ),
      ),
      session.ev('x/core/deferred-job', marker.data, {
        ignorable: true,
        sourceEventSeqs: markerSources,
      }),
    ])

    expect(await session.runDeferred()).toEqual({ phase: 'checkpoint' })
    expect((await log.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.trust).toBe('untrusted')
  })
})
