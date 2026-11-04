import { hostPortRequest } from '@agnes/core'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { ToolContext } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { continueParked } from '../src/step/parked.js'
import { fakeProvider, type Script, sent, textTurn, usage } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, testFsOps } from './helpers/open-session.js'

type Run = (
  args: { action: string },
  ctx: ToolContext,
) => Promise<{ content: Array<{ type: 'text'; text: string }> }>

// A never-replay tool that asks nobody before it runs: what mcp_manage is.
const remoteTool = (run: Run) =>
  ({
    name: 'remote_action',
    description: 'remote action',
    parameters: Type.Object({ action: Type.String() }),
    meta: {
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'never' as const,
      costHint: {},
      deferLoading: false,
      requiresApproval: 'never' as const,
    },
    execute: run,
  }) as never

const calls = (...actions: string[]): Script => [
  sent(),
  ...actions.map((action, ordinal) => ({
    type: 'toolcall_end' as const,
    call: { toolUseId: '', name: 'remote_action', args: { action } as never, ordinal },
    via: 'native' as const,
  })),
  usage(),
  { type: 'done', reason: 'toolUse' },
]

const daemonRefusal = (error: unknown) =>
  (error as { code?: unknown })?.code === 'INVALID_PARAMS'
    ? { code: 'INVALID_PARAMS', message: 'remote_action refused the request before changing anything' }
    : undefined

async function open(
  run: Run,
  script: Script,
  ask?: Parameters<typeof fakeSeams>[0],
  options: Pick<Parameters<typeof openSession>[0], 'fsOps'> = {},
) {
  const registry = new ToolRegistry()
  registry.add(remoteTool(run), { source: 's', trust: 'builtin' })
  const deps = {
    provider: fakeProvider([script, textTurn('done')]),
    registry,
    seams: fakeSeams(ask),
    ...(options.fsOps ? { fsOps: options.fsOps } : {}),
  }
  const s = await openSession(deps)
  await s.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
  await s.session.acceptInput()
  const fromSeq = s.log.lastSeq + 1
  await s.session.runInference()
  return { ...s, fromSeq }
}
const results = async (s: Awaited<ReturnType<typeof open>>) =>
  (await s.log.scan({ type: 'tool/result', fromSeq: s.fromSeq, limit: 20 })).map(
    (row) => row.data as { code?: string; isError?: boolean; content: Array<{ text: string }> },
  )
const reconciliations = async (s: Awaited<ReturnType<typeof open>>) =>
  (await s.session.decisions.list()).filter((value) => value.request.spec.purpose === 'unknown-outcome')

describe('a refusal proved before any effect is a definite failure', () => {
  it.each(['clean', 'forged', 'prior-write'] as const)(
    'settles a %s refusal using only owned proof',
    async (mode) => {
      const writes: Array<[string, string]> = []
      const s = await open(
        async (_args, ctx) => {
          if (mode === 'forged')
            throw Object.assign(new Error('bad'), { code: 'INVALID_PARAMS', effect: 'none' })
          if (mode === 'prior-write') await ctx.fs.write('note.txt', 'x')
          return hostPortRequest(ctx, () => Promise.reject({ code: 'INVALID_PARAMS' }), daemonRefusal)
        },
        calls('status'),
        // Leave uncertain effects pending so both paths must park for reconciliation.
        { approval: { ask: async () => ({ ticket: 'T1', expiresAt: '2099-01-01T00:00:00Z' }) } },
        {
          fsOps: {
            ...testFsOps(),
            write: async (path, content) => {
              writes.push([path, String(content)])
            },
          },
        },
      )
      const safe = mode === 'clean'
      try {
        const outcome = await s.session.runToolsPhase()
        const [result] = await results(s)
        expect(result).toMatchObject({
          isError: true,
          code: safe ? 'TOOL_REJECTED_BEFORE_EFFECT' : 'TOOL_OUTCOME_UNKNOWN',
        })
        if (safe) {
          expect(result).toMatchObject({ structured: { code: 'INVALID_PARAMS', effect: 'none' } })
          expect(result?.content[0]?.text).toContain('refused the request before changing anything')
          expect(
            await s.session.run({ until: 'turn-end', signal: new AbortController().signal }),
          ).toMatchObject({ reason: 'completed' })
        } else {
          expect(result).not.toHaveProperty('structured.effect', 'none')
          expect(outcome).toEqual({ phase: 'terminal', reason: 'parked' })
        }
        expect(await reconciliations(s)).toHaveLength(safe ? 0 : 1)
        const intent = (await s.log.scan({ type: 'effect/intent', fromSeq: s.fromSeq, limit: 10 })).find(
          (row) => (row.data as { tool?: { name: string } }).tool?.name === 'remote_action',
        )
        if (!intent) throw new Error('remote_action effect intent was not committed')
        const effectId = (intent.data as { effectId: string }).effectId
        const settlement = (await s.log.scan({ type: 'effect/settled', fromSeq: s.fromSeq, limit: 10 })).find(
          (row) => (row.data as { effectId: string }).effectId === effectId,
        )
        expect(settlement?.data).toMatchObject({ outcome: safe ? 'error' : 'unknown' })
        expect(writes).toEqual(mode === 'prior-write' ? [['note.txt', 'x']] : [])
        expect(s.session.pendingEffects()).toEqual([])
        expect(s.session.state.openStep.size).toBe(0)
      } finally {
        await s.session.close()
      }
    },
  )
})

describe('an unknown outcome the user answers', () => {
  const lost = async () => {
    throw new Error('connection lost after send')
  }

  it('answered while the call waits: consumed with the result, the model is told, the batch and turn go on', async () => {
    let ran = 0
    const s = await open(
      async (args) => {
        if (args.action === 'status') return lost()
        ran++
        return { content: [{ type: 'text', text: 'listed' }] }
      },
      calls('status', 'list'),
      { approval: { ask: async () => ({ verdict: 'allowed-session', answeredBy: actor }) } },
    )
    expect(await s.session.runToolsPhase()).not.toEqual({ phase: 'terminal', reason: 'parked' })
    const [status, list] = await results(s)
    expect(status).toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' })
    expect(status?.content[0]?.text).toContain('The user confirmed that it happened')
    expect(list?.content[0]?.text).toBe('listed')
    expect(ran).toBe(1)
    expect(await reconciliations(s)).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({ reason: 'answered' }),
        consumption: expect.any(Object),
      }),
    ])
    expect(await s.log.scan({ type: 'turn/end', limit: 5 })).toEqual([])
  })

  it('a "did not happen" answer is passed on as such', async () => {
    const s = await open(lost, calls('status'), {
      approval: { ask: async () => ({ verdict: 'rejected', answeredBy: actor }) },
    })
    await s.session.runToolsPhase()
    expect((await results(s))[0]?.content[0]?.text).toContain('The user confirmed that it did not happen')
  })

  it.each([false, true])(
    'left open: parks and consumes a late answer (retired review=%s)',
    async (legacyReview) => {
      let ran = 0
      const s = await open(
        async (args) => {
          if (args.action === 'status') return lost()
          ran++
          return { content: [{ type: 'text', text: 'listed' }] }
        },
        calls('status', 'list'),
        { approval: { ask: async () => ({ ticket: 'T1', expiresAt: '2099-01-01T00:00:00Z' }) } },
      )
      if (legacyReview)
        await s.session.append([
          s.session.ev(
            'x/core/completion-gate',
            {
              diagnostic: 'completion_gate_contract_review',
              status: 'ran',
            },
            { ignorable: true },
          ),
        ])
      const checkRestore = async (refused: boolean) => {
        const rows = await s.log.scan({ limit: 1000 })
        const storage = MemoryStorage.fromEvents('k', rows, {
          opCells: s.log.allRegisters().filter((row) => row.register === 'op.state'),
        })
        const provider = fakeProvider([textTurn('never called by open')])
        if (refused) {
          await expect(openSession({ storage, provider })).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
          expect(await storage.scan('k', { limit: 1000 })).toEqual(rows)
        } else {
          const restored = await openSession({ storage, provider })
          await restored.session.close()
        }
        expect(provider.calls).toBe(0)
      }
      expect(await s.session.runToolsPhase()).toEqual({ phase: 'terminal', reason: 'parked' })
      const [status, list] = await results(s)
      expect(status).toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' })
      expect(list).toMatchObject({ code: 'TOOL_NOT_STARTED', isError: true })
      expect(list?.content[0]?.text).toContain('remote_action was not run')
      expect(ran).toBe(0)

      await checkRestore(legacyReview)
      // An unrelated task may finish while the original unknown decision remains unanswered.
      await s.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'unrelated' }] })
      expect((await s.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      await checkRestore(legacyReview)
      const [open_] = await reconciliations(s)
      if (!open_) throw new Error('missing reconciliation')
      expect(open_).toMatchObject({ result: null, consumption: null })
      await s.session.decisions.answer(
        {
          handle: open_.handle,
          revision: open_.revision,
          commandId: 'later-answer',
          response: { option: 'allowed-session', value: null },
        },
        { actor, category: 'human', authorize() {} },
      )
      expect(await continueParked(s.session)).toBe('opened')
      expect((await reconciliations(s))[0]).toMatchObject({
        result: { reason: 'answered' },
        consumption: { operationId: open_.request.operationId },
      })
      await checkRestore(legacyReview)
      expect((await s.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      await checkRestore(false)
      await s.session.close()
    },
  )
})
