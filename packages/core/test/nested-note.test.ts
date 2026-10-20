import { presetDefaults } from '@agnes/core-common/step/preset'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { ToolContext, ToolDef } from '@agnes/extension-api'
import type { RequestBody } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import type { SessionImpl } from '../src/step/session.js'
import { answerToolDecision } from './helpers/decision.js'
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

const PREFIX = '[nested result]\n'
const approver = { ...actor, id: 'approver' }
const stopper = { ...actor, id: 'stopper' }
const signal = () => new AbortController().signal

/** A tool that writes, needs no approval in a clean turn, and is named the way the copy names it. */
const write = (fn?: () => Promise<{ content: Array<{ type: 'text'; text: string }> }>): ToolDef => ({
  ...(writeTool(fn) as ToolDef),
  name: 'write',
})

/** `outer`, a never-replay tool whose code invokes other tools through its context. */
const outer = (body: (ctx: ToolContext) => Promise<unknown>): ToolDef =>
  ({
    name: 'outer',
    description: 'outer',
    parameters: Type.Object({}),
    meta: {
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'never' as const,
      costHint: undefined,
      deferLoading: undefined,
      requiresApproval: undefined,
    },
    execute: async (_args: unknown, ctx: ToolContext) => {
      await body(ctx)
      return { content: [{ type: 'text' as const, text: 'outer complete' }] }
    },
  }) as never

const registryOf = (...tools: ToolDef[]) => {
  const r = new ToolRegistry()
  for (const tool of tools) r.add(tool as never, { source: 's', trust: 'builtin' })
  return r
}

/** `outer` invokes `shell`, which asks for approval; the turn parks on that question. */
async function parkedOnNestedShell(shell: ToolDef = shellTool() as ToolDef) {
  let now = 1_757_203_200_000
  const clock = () => now
  const storage = new MemoryStorage()
  const provider = fakeProvider([toolTurn('outer', {}), textTurn('done')])
  const h = await openSession({
    provider,
    storage,
    clock,
    registry: registryOf(
      shell,
      outer((ctx) => ctx.tools.invoke('shell', { command: 'click' })),
    ),
    seams: fakeSeams({
      approval: { ask: async () => ({ ticket: 't', expiresAt: new Date(now + 1000).toISOString() }) },
    }),
  })
  await h.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
  expect((await h.session.run({ until: 'turn-end', signal: signal() })).reason).toBe('parked')
  return {
    ...h,
    provider,
    advance: (ms: number) => {
      now += ms
    },
  }
}

type Message = RequestBody['messages'][number]
const texts = (m: Message) =>
  ((m as { content?: Array<{ type: string; text?: string }> }).content ?? []).flatMap((b) =>
    b.type === 'text' ? [b.text ?? ''] : [],
  )
const isNote = (m: Message) => m.role === 'user' && (texts(m)[0] ?? '').startsWith(PREFIX)

/** The `[nested result]` notes committed to the ledger, as their text blocks. */
async function ledgerNotes(log: Awaited<ReturnType<typeof openSession>>['log']) {
  const rows = await log.scan({ type: 'user/message', fromSeq: 1, toSeq: log.lastSeq, limit: 1000 })
  return rows.flatMap((row) => {
    const data = row.data as { kind?: string; content?: Array<{ type: string; text?: string }> }
    const blocks = (data.content ?? []).flatMap((b) => (b.type === 'text' ? [b.text ?? ''] : []))
    return data.kind === 'runtime_context' && (blocks[0] ?? '').startsWith(PREFIX) ? [blocks] : []
  })
}

describe('[nested result] notes', () => {
  it('approval resume adds a note and leaves earlier messages unchanged', async () => {
    const h = await parkedOnNestedShell()
    await answerToolDecision(h.session, 1, 'allowed-once', approver)
    expect((await h.session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    const [before, after] = h.provider.requests
    if (!before || !after) throw new Error('missing requests')
    const notes = after.messages.filter(isNote)
    expect(notes).toHaveLength(1)
    expect(texts(notes[0] as Message)).toEqual([
      `${PREFIX}The nested call shell inside outer ran after approval (status: ok). Do not run it again. Preview:`,
      'ran',
    ])
    expect(JSON.stringify(after.messages)).not.toMatch(/"name":"shell"/)
    // The park ended the turn, so the only request before it holds the prompt. The resumed request
    // keeps that prefix as it was; between it and the note sit only the outer call and its result.
    const at = after.messages.findIndex(isNote)
    const outerId = (after.messages[1] as { toolCalls?: Array<{ toolUseId: string }> }).toolCalls?.[0]
      ?.toolUseId
    expect(after.messages.slice(0, at)).toEqual([
      ...before.messages,
      expect.objectContaining({ role: 'assistant', toolCalls: [expect.objectContaining({ name: 'outer' })] }),
      expect.objectContaining({ role: 'tool_result', toolUseId: outerId }),
    ])
  })

  it('preview is untrusted', async () => {
    const shell = shellTool(async () => ({ content: [{ type: 'text', text: 'page text' }] })) as ToolDef
    const h = await parkedOnNestedShell({ ...shell, meta: { ...shell.meta, isOpenWorld: true } })
    await answerToolDecision(h.session, 1, 'allowed-once', approver)
    expect((await h.session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    const note = h.provider.requests[1]?.messages.find(isNote)
    if (!note) throw new Error('missing note')
    const [header, preview] = texts(note)
    // The header is the harness's own text; only the result's preview is data.
    expect(header).toBe(
      `${PREFIX}The nested call shell inside outer ran after approval (status: ok). Do not run it again. Preview:`,
    )
    expect(preview).toMatch(/^<untrusted id="[^"]+" bytes="9">page text<\/untrusted id="[^"]+">$/)
  })

  it('rejection writes the rejected note', async () => {
    const h = await parkedOnNestedShell()
    await answerToolDecision(h.session, 1, 'rejected', approver)
    expect((await h.session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    expect(h.provider.requests[1]?.messages.filter(isNote).map(texts)).toEqual([
      [
        `${PREFIX}The user rejected the nested call shell inside outer; it did not run. Do not retry it without asking.`,
      ],
    ])
  })

  it('deadline writes the deadline note', async () => {
    const h = await parkedOnNestedShell()
    h.advance(86_400_000)
    await h.storage.renew(h.session.key, h.session.writerRunId)
    expect((await h.session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    expect(h.provider.requests[1]?.messages.filter(isNote).map(texts)).toEqual([
      [`${PREFIX}Approval for the nested call shell inside outer expired; it did not run.`],
    ])
  })

  it('unknown outcome writes the unknown note', async () => {
    const preset = presetDefaults()
    const h = await openSession({
      provider: fakeProvider([toolTurn('outer', {}), textTurn('done')]),
      registry: registryOf(
        write(() => new Promise(() => undefined)),
        outer((ctx) => ctx.tools.invoke('write', {}).catch(() => undefined)),
      ),
      preset: { ...preset, tools: { ...preset.tools, timeouts: { write: 5 } } },
    })
    await h.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await h.session.run({ until: 'turn-end', signal: signal() })
    expect(await ledgerNotes(h.log)).toEqual([
      [
        `${PREFIX}The outcome of the nested call write inside outer is unknown; check the current state before running it again.`,
      ],
    ])
  })

  it('deferred nested job writes the deferred note', async () => {
    const job: ToolDef = {
      ...(readTool() as ToolDef),
      name: 'export_job',
      execute: async (_args, ctx) =>
        ({
          content: [{ type: 'text' as const, text: 'queued' }],
          deferred: {
            jobId: await ctx.artifacts.submitJob({ idempotencyKey: 'nested-job', payload: { prompt: 'x' } }),
          },
        }) as never,
    }
    const h = await openSession({
      provider: fakeProvider([toolTurn('outer', {}), textTurn('done')]),
      registry: registryOf(
        job,
        outer((ctx) => ctx.tools.invoke('export_job', {})),
      ),
      preset: { ...presetDefaults(), deferred: { pollMs: 1 } },
      timers: immediateTimers,
    })
    await h.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect((await h.session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    // The fake artifact seam reports the job done with no artifact, which is a failed job.
    expect(await ledgerNotes(h.log)).toEqual([
      [
        `${PREFIX}The nested call export_job inside outer finished later (status: error). Preview:`,
        'artifact job completed without a result',
      ],
    ])
  })

  it('outer cancel after a nested write writes the outer-failure note', async () => {
    const held: { s?: SessionImpl } = {}
    const h = await openSession({
      provider: fakeProvider([toolTurn('outer', {}), textTurn('done')]),
      registry: registryOf(
        write(),
        outer(async (ctx) => {
          await ctx.tools.invoke('write', {})
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener('abort', () => resolve(), { once: true })
            void held.s?.abort(stopper)
          })
        }),
      ),
    })
    held.s = h.session
    await h.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await h.session.run({ until: 'turn-end', signal: signal() })
    const outerResult = (await h.log.scan({ type: 'tool/result', limit: 10 })).at(-1)?.data
    expect(outerResult).toMatchObject({ code: 'CANCELLED' })
    expect(await ledgerNotes(h.log)).toEqual([
      [
        `${PREFIX}outer ended with CANCELLED after these nested calls had results: write ok. Check the current state before running them again.`,
      ],
    ])
  })

  /**
   * `outer` invokes `write`, which completes, then hangs -- in its own code, or inside a second
   * nested call that never returns. The process dies there and a new one reopens the ledger.
   */
  async function crashedAfterNestedWrite(hangIn: 'outer' | 'nested') {
    let wrote!: () => void
    const written = new Promise<void>((resolve) => {
      wrote = resolve
    })
    const hang: ToolDef = {
      ...write(() => {
        wrote()
        return new Promise(() => undefined)
      }),
      name: 'hang',
    }
    const registry = registryOf(
      write(),
      hang,
      outer(async (ctx) => {
        await ctx.tools.invoke('write', {})
        if (hangIn === 'nested') await ctx.tools.invoke('hang', {})
        wrote()
        await new Promise(() => undefined)
      }),
    )
    const original = await openSession({ provider: fakeProvider([toolTurn('outer', {})]), registry })
    await original.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await original.session.acceptInput()
    await original.session.runInference()
    void original.session.runToolsPhase()
    await written
    const prefix = await original.log.scan({ fromSeq: 1, toSeq: original.log.lastSeq, limit: 10_000 })
    return openSession({
      provider: fakeProvider([]),
      registry,
      storage: MemoryStorage.fromEvents('k', prefix, {
        opCells: original.opCellsBefore((prefix.at(-1)?.seq ?? 0) + 1),
      }),
      writerRunId: 'reopen',
    })
  }

  it.each([
    ['resumed', 'outer', 'continue', 'TOOL_OUTCOME_UNKNOWN'],
    ['resumed with a nested child still pending', 'nested', 'continue', 'CHILD_INTERRUPTED'],
    ['closed', 'outer', 'close', 'TOOL_OUTCOME_UNKNOWN'],
  ] as const)(
    'crash recovery after a nested write writes the outer-failure note when %s',
    async (_case, hangIn, mode, code) => {
      const reopened = await crashedAfterNestedWrite(hangIn)
      try {
        await reopened.session.resume({ mode })
        const outerResult = (await reopened.log.scan({ type: 'tool/result', limit: 20 })).find(
          (row) => (row.data as { code?: string }).code === code,
        )
        expect(outerResult).toBeDefined()
        expect(await ledgerNotes(reopened.log)).toEqual([
          [
            `${PREFIX}outer ended with ${code} after these nested calls had results: write ok. Check the current state before running them again.`,
          ],
        ])
      } finally {
        await reopened.session.close()
      }
    },
  )

  it('closing a session with a nested call still running writes the unknown note', async () => {
    const reopened = await crashedAfterNestedWrite('nested')
    try {
      await reopened.session.resume({ mode: 'close' })
      const notes = await ledgerNotes(reopened.log)
      expect(notes).toContainEqual([
        `${PREFIX}The outcome of the nested call hang inside outer is unknown; check the current state before running it again.`,
      ])
    } finally {
      await reopened.session.close()
    }
  })

  it('consumed nested results write no note', async () => {
    const provider = fakeProvider([toolTurn('outer', {}), textTurn('done')])
    const h = await openSession({
      provider,
      registry: registryOf(
        readTool() as ToolDef,
        outer((ctx) => ctx.tools.invoke('read', {})),
      ),
    })
    await h.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect((await h.session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    expect(await ledgerNotes(h.log)).toEqual([])
    expect(JSON.stringify(provider.requests)).not.toContain('[nested result]')
  })
})
