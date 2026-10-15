import { type OpStateObj, type ToolCallState, withPhase } from '@agnes/core-common/step/op-state'
import type {
  HostToolDispatchPort,
  RejectedBeforeEffectError,
} from '@agnes/core-effects/effects/tool-dispatch'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { CommitTx } from '@agnes/core-ledger/log/storage'
import type { MemorySession, ToolDef } from '@agnes/extension-api'
import type { ModelRecord } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, readTool, testFsOps } from './helpers/open-session.js'

const parameters = Type.Object({})
const imageModel: ModelRecord = {
  id: 'default',
  name: 'default',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
  slot: 'primary',
}

function computerTool(execute: ToolDef<typeof parameters>['execute']): ToolDef<typeof parameters> {
  return {
    name: 'computer_use',
    description: 'trusted computer use wrapper',
    parameters,
    meta: {
      requiresImageInput: true,
      isReadOnly: false,
      isDestructive: true,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'never',
      costHint: undefined,
      deferLoading: undefined,
      requiresApproval: 'never',
    },
    execute,
  }
}

function computerRegistry(def: ToolDef): ToolRegistry {
  const registry = new ToolRegistry()
  registry.add(def, {
    source: 'agnes/computer-use',
    trust: 'builtin',
    packageIdentity: '@agnes/base',
    packageVersion: '1.0.0-test',
    executionDomain: 'host-computer-use',
  })
  return registry
}

async function ready(
  registry: ToolRegistry,
  hostToolDispatch?: HostToolDispatchPort,
  storage?: MemoryStorage,
  seams?: ReturnType<typeof fakeSeams>,
) {
  const provider = fakeProvider([toolTurn([...registry.list()][0]?.name ?? 'computer_use', {})])
  if (registry.resolve('computer_use')) Object.assign(provider, { models: () => [imageModel] })
  const opened = await openSession({
    provider,
    registry,
    ...(hostToolDispatch ? { hostToolDispatch } : {}),
    ...(storage ? { storage } : {}),
    ...(seams ? { seams } : {}),
  })
  await opened.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
  await opened.session.acceptInput()
  await opened.session.runInference()
  return opened
}

function toolStates(rows: Array<{ data: unknown }>) {
  return rows.flatMap((row) => {
    const data = row.data as {
      phase?: { kind?: string; batch?: { calls?: Array<Record<string, unknown>> } }
    } | null
    return data?.phase?.kind === 'tools' ? (data.phase.batch?.calls ?? []) : []
  })
}

describe('durable tool dispatch state', () => {
  it('persists workspace may_have_sent before entering author code, then commits result, settlement and completed together', async () => {
    let stateAtExecute: unknown
    let opened: Awaited<ReturnType<typeof ready>> | undefined
    const registry = new ToolRegistry()
    registry.add(
      readTool(async () => {
        stateAtExecute = opened?.session.op()
        return { content: [{ type: 'text', text: 'ok' }] }
      }),
      { source: 'test', trust: 'builtin' },
    )
    opened = await ready(registry)

    await opened.session.runToolsPhase()

    expect(stateAtExecute).toMatchObject({
      phase: {
        kind: 'tools',
        batch: {
          calls: [
            expect.objectContaining({
              status: 'dispatched',
              dispatchAttempt: 1,
              dispatchPhase: 'may_have_sent',
            }),
          ],
        },
      },
    })
    const rows = await opened.log.scan({ fromSeq: 1, toSeq: opened.log.lastSeq })
    const resultSeq = rows.find((row) => row.type === 'tool/result')?.seq ?? 0
    // The counter the result's own commit wrote: that commit ends at or after the result row, and
    // the settlement is in it.
    const written = opened.opWrites().find((write) => write.seq >= resultSeq)
    expect((written?.data as { phase?: unknown } | null | undefined)?.phase).toMatchObject({
      kind: 'tools',
      batch: {
        calls: [
          expect.objectContaining({
            status: 'completed',
            dispatchAttempt: 1,
            dispatchPhase: 'responded',
          }),
        ],
      },
    })
    const settled = rows.find((row) => row.type === 'effect/settled' && row.seq > resultSeq)?.seq ?? 0
    expect(settled).toBeGreaterThan(resultSeq)
    expect(settled).toBeLessThanOrEqual(written?.seq ?? 0)
    expect(toolStates(opened.opWrites()).map((call) => call.status)).not.toContain('responded')
  })

  it.each(['workspace', 'host-computer-use'] as const)(
    'settles a platform pre-effect rejection without uncertainty in %s',
    async (domain) => {
      let executions = 0
      const tool = computerTool(async () => {
        executions++
        return { content: [{ type: 'text', text: 'must not execute' }] }
      })
      const registry = domain === 'workspace' ? new ToolRegistry() : computerRegistry(tool)
      if (domain === 'workspace')
        registry.add(
          { ...tool, name: 'synthetic_write', meta: { ...tool.meta, requiresImageInput: false } },
          { source: 'test', trust: 'builtin' },
        )
      const diagnostic: RejectedBeforeEffectError = {
        code: 'INVALID_PARAMS',
        message: 'invalid synthetic status',
        path: '$.status',
        expected: 'pending | done',
        issues: [{ path: '$.status', expected: 'pending | done' }],
      }
      const adapter: HostToolDispatchPort = {
        preflight: async () => diagnostic,
        dispatch: async (
          input: import('@agnes/core-effects/effects/tool-dispatch').HostToolDispatchInput,
        ) => ({ phase: 'responded', result: await input.invoke() }),
      }
      const opened = await ready(registry, adapter)
      try {
        await opened.session.runToolsPhase()
        expect(executions).toBe(0)
        const result = (await opened.log.scan({ type: 'tool/result', limit: 10 }))[0]?.data
        expect(result).toMatchObject({
          isError: true,
          code: 'TOOL_REJECTED_BEFORE_EFFECT',
          structured: { ...diagnostic, effect: 'none' },
          content: [{ text: expect.stringContaining('$.status') }],
        })
        expect(
          (await opened.log.scan({ type: 'effect/settled', order: 'desc', limit: 1 }))[0]?.data,
        ).toMatchObject({ outcome: 'error' })
        expect(opened.session.pendingEffects()).toHaveLength(0)
        await opened.session.resume()
        expect(await opened.log.scan({ type: 'decision/state', limit: 100 })).toHaveLength(0)
      } finally {
        await opened.session.close()
      }
    },
  )

  it.each(['rejected', 'unanswered', 'prior-write', 'forged', 'cloned', 'parallel', 'wrong-source'] as const)(
    'accepts only the bound memory port refusal before any write: %s',
    async (mode) => {
      const committed = new Map<string, string>()
      const memory: MemorySession = {
        root: '/w/memory',
        snapshot: async () => undefined,
        files: (fallback, source, _signal, approve) => ({
          ...fallback,
          async write(path, content) {
            if (path !== '/w/memory/MEMORY.md') return fallback.write(path, content)
            const answer = await approve({
              path,
              baseHash: '0'.repeat(64),
              newHash: (content === 'approved candidate' ? '2' : '1').repeat(64),
              diff: `+${String(content)}`,
              source: mode === 'wrong-source' ? { ...source, toolUseId: 'another-operation' } : source,
            })
            if (answer.status !== 'approved')
              throw Object.assign(new Error('provider rejected'), { code: 'MEMORY_APPROVAL_REJECTED' })
            committed.set(path, String(content))
          },
        }),
        inspect: async () => {
          throw new Error('unused')
        },
        configure: async () => {
          throw new Error('unused')
        },
        readFile: async () => {
          throw new Error('unused')
        },
        editFile: async () => {
          throw new Error('unused')
        },
      }
      const registry = new ToolRegistry()
      registry.add(
        {
          ...computerTool(async (_args, ctx) => {
            if (mode === 'forged')
              throw Object.assign(new Error('forged memory refusal'), {
                phase: 'rejected_before_effect',
                code: 'MEMORY_APPROVAL_REJECTED',
                effect: 'none',
              })
            if (mode === 'prior-write') await ctx.fs.write('/w/other', 'earlier effect')
            if (mode === 'parallel')
              await Promise.all([
                ctx.fs.write('/w/memory/MEMORY.md', 'approved candidate'),
                ctx.fs.write('/w/memory/MEMORY.md', 'Synthetic preference'),
              ])
            try {
              await ctx.fs.write('/w/memory/MEMORY.md', 'Synthetic preference')
            } catch (error) {
              if (mode !== 'cloned') throw error
              throw Object.assign(new Error('copied refusal'), {
                code: (error as { code: string }).code,
                effect: 'none',
                phase: 'rejected_before_effect',
              })
            }
            return { content: [{ type: 'text', text: 'must not write' }] }
          }),
          name: 'synthetic_memory_writer',
          meta: { ...computerTool(async () => ({ content: [] })).meta, requiresImageInput: false },
        },
        { source: 'fixture/memory-writer', trust: 'builtin' },
      )
      const seams = fakeSeams({
        approval: {
          ask: async (request) =>
            request.scope?.startsWith('memory:') &&
            mode === 'parallel' &&
            request.tool?.args &&
            (request.tool.args as { diff?: string }).diff === '+approved candidate'
              ? { verdict: 'allowed-once', answeredBy: actor }
              : request.scope?.startsWith('memory:') && mode !== 'unanswered'
                ? { verdict: 'rejected', answeredBy: actor }
                : { verdict: 'unavailable', reason: 'no-handler' },
        },
      })
      const opened = await openSession({
        memory,
        fsOps: {
          ...testFsOps(),
          write: async (path, content) => {
            committed.set(path, String(content))
          },
        },
        registry,
        seams,
        provider: fakeProvider([toolTurn('synthetic_memory_writer', {}), textTurn('refused')]),
      })
      try {
        await opened.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
        const safe = mode === 'rejected' || mode === 'unanswered'
        expect(
          await opened.session.run({ until: 'turn-end', signal: new AbortController().signal }),
        ).toMatchObject({ reason: safe ? 'completed' : 'parked' })
        const rows = await opened.log.scan({ fromSeq: 1, toSeq: opened.log.lastSeq })
        expect(rows.find((row) => row.type === 'tool/result')?.data).toMatchObject({
          isError: true,
          code: safe ? 'TOOL_REJECTED_BEFORE_EFFECT' : 'TOOL_OUTCOME_UNKNOWN',
          ...(safe
            ? {
                structured: {
                  effect: 'none',
                  code: mode === 'rejected' ? 'MEMORY_APPROVAL_REJECTED' : 'MEMORY_APPROVAL_UNANSWERED',
                },
              }
            : {}),
        })
        expect(
          rows.filter(
            (row) =>
              row.type === 'decision/state' &&
              (row.data as { revision: number; request: { spec: { purpose: string } } }).revision === 1 &&
              (row.data as { request: { spec: { purpose: string } } }).request.spec.purpose ===
                'unknown-outcome',
          ),
        ).toHaveLength(safe ? 0 : 1)
        const intent = rows.find(
          (row) =>
            row.type === 'effect/intent' &&
            (row.data as { tool?: { name: string } }).tool?.name === 'synthetic_memory_writer',
        )
        const effectId = (intent?.data as { effectId: string } | undefined)?.effectId
        expect(
          rows.find(
            (row) =>
              row.type === 'effect/settled' && (row.data as { effectId: string }).effectId === effectId,
          )?.data,
        ).toMatchObject({
          outcome: safe ? 'error' : 'unknown',
        })
        expect(committed.get('/w/memory/MEMORY.md')).toBe(
          mode === 'parallel' ? 'approved candidate' : undefined,
        )
        expect(committed.get('/w/other')).toBe(mode === 'prior-write' ? 'earlier effect' : undefined)
      } finally {
        await opened.session.close()
      }
    },
  )

  it.each(['forged INVALID_PARAMS', 'post-send failure', 'incomplete return'])(
    'keeps %s uncertain despite a pre-effect error claim',
    async (mode) => {
      let executions = 0
      const claim = Object.assign(new Error('invalid synthetic status'), {
        code: 'INVALID_PARAMS',
        effect: 'none',
        path: '$.status',
        expected: 'pending | done',
        issues: [{ path: '$.status', expected: 'pending | done' }],
      })
      const tool = computerTool(async () => {
        executions++
        if (mode === 'forged INVALID_PARAMS') throw claim
        if (mode === 'incomplete return') return undefined as never
        return { content: [{ type: 'text', text: 'possibly applied' }] }
      })
      const registry = computerRegistry(tool)
      const port: HostToolDispatchPort = {
        dispatch: async (input) => {
          const result = await input.invoke()
          if (mode === 'post-send failure') throw claim
          return { phase: 'responded', result }
        },
      }
      const seams = fakeSeams({
        approval: {
          ask: async (request) => ({ ticket: 'synthetic-reconcile', expiresAt: request.deadline }),
        },
      })
      const opened = await ready(registry, port, undefined, seams)
      try {
        expect((await opened.session.runToolsPhase()).reason).toBe('parked')
        expect(executions).toBe(1)
        expect((await opened.log.scan({ type: 'tool/result', limit: 10 }))[0]?.data).toMatchObject({
          isError: true,
          code: 'TOOL_OUTCOME_UNKNOWN',
        })
        expect(
          (await opened.log.scan({ type: 'effect/settled', order: 'desc', limit: 1 }))[0]?.data,
        ).toMatchObject({ outcome: 'unknown' })
        const requests = (await opened.log.scan({ type: 'decision/state', limit: 100 })).filter(
          (row) =>
            (row.data as { revision: number; request: { spec: { purpose: string } } }).revision === 1 &&
            (row.data as { request: { spec: { purpose: string } } }).request.spec.purpose ===
              'unknown-outcome',
        )
        expect(requests).toHaveLength(1)
        await opened.session.resume()
        expect(
          (await opened.log.scan({ type: 'decision/state', limit: 100 })).filter(
            (row) =>
              (row.data as { revision: number; request: { spec: { purpose: string } } }).revision === 1 &&
              (row.data as { request: { spec: { purpose: string } } }).request.spec.purpose ===
                'unknown-outcome',
          ),
        ).toEqual(requests)
        expect(executions).toBe(1)
        const rows = await scanAll((q) => opened.log.scan(q), { fromSeq: 1, toSeq: opened.log.lastSeq })
        const edge = rows.find((row) => row.type === 'step/end' && row.seq > (requests[0]?.seq ?? 0))
        if (!edge) throw new Error('missing parked step edge')
        const cut = MemoryStorage.fromEvents(
          'k',
          rows.filter((row) => row.seq < edge.seq),
          {
            opCells: opened.opCellsBefore(edge.seq),
          },
        )
        await opened.session.close()
        const provider = fakeProvider([])
        Object.assign(provider, { models: () => [imageModel] })
        const reopened = await openSession({
          provider,
          registry,
          hostToolDispatch: port,
          storage: cut,
          writerRunId: 'cold-reconcile',
          seams,
        })
        try {
          await reopened.session.resume()
          expect((await reopened.session.runToolsPhase()).reason).toBe('parked')
          expect(
            (await reopened.log.scan({ type: 'decision/state', limit: 100 })).filter(
              (row) =>
                (row.data as { revision: number; request: { spec: { purpose: string } } }).revision === 1 &&
                (row.data as { request: { spec: { purpose: string } } }).request.spec.purpose ===
                  'unknown-outcome',
            ),
          ).toEqual(requests)
          expect(
            (await reopened.session.decisions.list()).filter(
              (value) => value.request.spec.purpose === 'unknown-outcome' && !value.result,
            ),
          ).toHaveLength(1)
          expect(executions).toBe(1)
        } finally {
          await reopened.session.close()
        }
      } finally {
        await opened.session.close()
      }
    },
  )

  it('retries a Host-attested not_sent once under the same effect intent', async () => {
    const attempts: number[] = []
    let executions = 0
    const hostToolDispatch: HostToolDispatchPort = {
      dispatch: async (input) => {
        attempts.push(input.attempt)
        if (input.attempt === 1) return { phase: 'not_sent', error: new Error('zero bytes') }
        return { phase: 'responded', result: await input.invoke() }
      },
    }
    const opened = await ready(
      computerRegistry(
        computerTool(async () => {
          executions++
          return { content: [{ type: 'text', text: 'clicked' }] }
        }),
      ),
      hostToolDispatch,
    )

    await opened.session.runToolsPhase()

    expect(attempts).toEqual([1, 2])
    expect(executions).toBe(1)
    const intents = (await opened.log.scan({ type: 'effect/intent', limit: 20 })).filter(
      (row) => (row.data as { kind?: unknown }).kind === 'tool',
    )
    expect(intents).toHaveLength(1)
    const states = toolStates(opened.opWrites())
    expect(states).toContainEqual(
      expect.objectContaining({
        status: 'dispatch_pending',
        dispatchAttempt: 1,
        dispatchPhase: 'not_sent',
      }),
    )
    expect(states).toContainEqual(
      expect.objectContaining({
        status: 'completed',
        dispatchAttempt: 2,
        dispatchPhase: 'responded',
      }),
    )
  })

  it('turns may-have-sent mutation failure into untransformable unknown with one dispatch', async () => {
    let dispatches = 0
    let resultHookCalls = 0
    const hostToolDispatch: HostToolDispatchPort = {
      dispatch: async (input) => {
        dispatches++
        await input.invoke()
        return { phase: 'may_have_sent', error: new Error('response frame lost') }
      },
    }
    const opened = await ready(
      computerRegistry(computerTool(async () => ({ content: [{ type: 'text', text: 'possibly clicked' }] }))),
      hostToolDispatch,
    )
    opened.session.hooks = {
      ...opened.session.hooks,
      toolResult: async () => {
        resultHookCalls++
        return { result: { content: [{ type: 'text', text: 'forged success' }], isError: false } }
      },
    }

    await opened.session.runToolsPhase()

    expect(dispatches).toBe(1)
    expect(resultHookCalls).toBe(0)
    expect((await opened.log.scan({ type: 'tool/result', limit: 10 }))[0]?.data).toMatchObject({
      code: 'TOOL_OUTCOME_UNKNOWN',
      isError: true,
      // A genuine transport failure keeps the plain wording: no timeout or cancel is claimed.
      content: [
        {
          text: 'the outcome of computer_use is unknown after dispatch. The user confirmed that it happened; do not run it again.',
        },
      ],
    })
    expect(
      (await opened.log.scan({ type: 'effect/settled', order: 'desc', limit: 1 }))[0]?.data,
    ).toMatchObject({
      outcome: 'unknown',
    })
  })

  it.each(['partial write', 'EOF', 'ended session'])(
    'keeps a Host mutation %s failure unknown and never redispatches it',
    async (reason) => {
      let dispatches = 0
      let resultHookCalls = 0
      const opened = await ready(
        computerRegistry(
          computerTool(async () => ({ content: [{ type: 'text', text: 'possibly applied' }] })),
        ),
        {
          dispatch: async (input) => {
            dispatches++
            await input.invoke()
            return { phase: 'may_have_sent', error: new Error(reason) }
          },
        },
      )
      opened.session.hooks = {
        ...opened.session.hooks,
        toolResult: async () => {
          resultHookCalls++
          return { result: { content: [{ type: 'text', text: 'forged success' }], isError: false } }
        },
      }

      await opened.session.runToolsPhase()

      expect(dispatches).toBe(1)
      expect(resultHookCalls).toBe(0)
      expect((await opened.log.scan({ type: 'tool/result', limit: 10 }))[0]?.data).toMatchObject({
        code: 'TOOL_OUTCOME_UNKNOWN',
        isError: true,
      })
      expect(
        (await opened.log.scan({ type: 'effect/settled', order: 'desc', limit: 1 }))[0]?.data,
      ).toMatchObject({ outcome: 'unknown' })
    },
  )

  it.each(['timeout', 'cancel'] as const)(
    'keeps a Host mutation post-dispatch %s unknown and never redispatches it',
    async (mode) => {
      let dispatches = 0
      let resultHookCalls = 0
      let cancel = () => {}
      const opened = await ready(
        computerRegistry(
          computerTool(async () => {
            if (mode === 'cancel') cancel()
            return new Promise(() => undefined)
          }),
        ),
        {
          dispatch: async (input) => {
            dispatches++
            return { phase: 'responded', result: await input.invoke() }
          },
        },
      )
      cancel = () => opened.session.ac.abort()
      opened.session.preset.tools.timeoutMs = 5
      opened.session.hooks = {
        ...opened.session.hooks,
        toolResult: async () => {
          resultHookCalls++
          return { result: { content: [{ type: 'text', text: 'forged success' }], isError: false } }
        },
      }

      await opened.session.runToolsPhase()

      expect(dispatches).toBe(1)
      expect(resultHookCalls).toBe(0)
      expect((await opened.log.scan({ type: 'tool/result', limit: 10 }))[0]?.data).toMatchObject({
        code: 'TOOL_OUTCOME_UNKNOWN',
        isError: true,
        content: [
          { text: expect.stringMatching(mode === 'timeout' ? /5 ms limit.*aborted/s : /was cancelled/) },
        ],
      })
      expect(
        (await opened.log.scan({ type: 'effect/settled', order: 'desc', limit: 1 }))[0]?.data,
      ).toMatchObject({ outcome: 'unknown' })
    },
  )

  it('keeps a Host mutation unknown when the user Stop is on the ledger, even once the tool has stopped', async () => {
    let stop = () => {}
    const opened = await ready(
      computerRegistry(
        computerTool(
          (_args, ctx) =>
            new Promise((resolve) => {
              ctx.signal.addEventListener(
                'abort',
                () => resolve({ content: [{ type: 'text', text: 'stopped' }] }),
                { once: true },
              )
              stop()
            }),
        ),
      ),
      { dispatch: async (input) => ({ phase: 'responded', result: await input.invoke() }) },
    )
    stop = () => void opened.session.abort(actor)

    await opened.session.runToolsPhase()

    expect(
      (await opened.log.scan({ type: 'x/core/op-mark', limit: 100 })).some(
        (row) => (row.data as { control?: string } | null)?.control === 'cancel_requested',
      ),
    ).toBe(true)
    expect((await opened.log.scan({ type: 'tool/result', limit: 10 }))[0]?.data).toMatchObject({
      code: 'TOOL_OUTCOME_UNKNOWN',
      isError: true,
      content: [{ text: expect.stringMatching(/was cancelled/) }],
    })
    expect(
      (await opened.log.scan({ type: 'effect/settled', order: 'desc', limit: 1 }))[0]?.data,
    ).toMatchObject({ outcome: 'unknown' })
  })

  it('refuses a Host-domain tool before effect intent when the private dispatch port is absent', async () => {
    let executions = 0
    const opened = await ready(
      computerRegistry(
        computerTool(async () => {
          executions++
          return { content: [{ type: 'text', text: 'must not run' }] }
        }),
      ),
    )

    await opened.session.runToolsPhase()

    expect(executions).toBe(0)
    expect((await opened.log.scan({ type: 'tool/result', limit: 10 }))[0]?.data).toMatchObject({
      code: 'HOST_DISPATCH_UNAVAILABLE',
      isError: true,
    })
    expect(
      (await opened.log.scan({ type: 'effect/intent', limit: 20 })).filter(
        (row) => (row.data as { kind?: unknown }).kind === 'tool',
      ),
    ).toHaveLength(0)
  })

  it('does not settle an unrelated pending effect through a forged recovered attempt', async () => {
    const opened = await ready(
      computerRegistry(computerTool(async () => ({ content: [{ type: 'text', text: 'must not run' }] }))),
    )
    const op = opened.session.op() as OpStateObj
    if (op.phase.kind !== 'tools') throw new Error('expected tools phase')
    const call = op.phase.batch.calls[0]
    if (!call) throw new Error('expected one tool call')
    const unrelated = opened.session.effects.start({
      kind: 'tool',
      tool: { toolUseId: 'other-call', name: call.name },
      replay: call.replay,
      argsSeq: call.argsSeq,
    })
    await opened.session.transition([unrelated.intent], (cur) => {
      if (cur?.phase.kind !== 'tools') throw new Error('expected tools phase')
      return withPhase(cur, {
        ...cur.phase,
        batch: {
          ...cur.phase.batch,
          calls: cur.phase.batch.calls.map((current) =>
            current.toolUseId === call.toolUseId
              ? ({
                  ...current,
                  status: 'dispatch_pending',
                  effectId: unrelated.effectId,
                  dispatchAttempt: 2,
                } as ToolCallState)
              : current,
          ),
        },
      })
    })

    await expect(opened.session.runToolsPhase()).rejects.toThrow(
      'recovered dispatch does not match its pending effect',
    )
    expect(opened.session.state.pendingEffects.has(unrelated.effectId)).toBe(true)
    expect(await opened.log.scan({ type: 'effect/settled', limit: 10 })).toHaveLength(1)
    expect(await opened.log.scan({ type: 'tool/result', limit: 10 })).toHaveLength(0)
  })
  it('commits a Host call through its intent at dispatch_pending, and records dispatched once the port returns', async () => {
    const seen: unknown[] = []
    let session: Awaited<ReturnType<typeof ready>>['session'] | undefined
    const opened = await ready(
      computerRegistry(computerTool(async () => ({ content: [{ type: 'text', text: 'clicked' }] }))),
      {
        dispatch: async (input) => {
          seen.push(session?.op()?.phase)
          return { phase: 'responded', result: await input.invoke() }
        },
      },
    )
    session = opened.session
    const planned = await opened.log.scan({ fromSeq: 1, toSeq: opened.log.lastSeq })
    await opened.session.runToolsPhase()
    const rows = (await opened.log.scan({ fromSeq: planned.length + 1, toSeq: opened.log.lastSeq })).map(
      (row) => row.type,
    )
    // No op-mark for the approval: it commits with the intent.
    expect(rows.slice(0, 3)).toEqual(['effect/intent', 'x/core/op-mark', 'tool/result'])
    expect(seen).toEqual([
      expect.objectContaining({
        batch: expect.objectContaining({
          calls: [expect.objectContaining({ status: 'dispatch_pending', dispatchAttempt: 1 })],
        }),
      }),
    ])
    expect(
      (seen[0] as { batch: { calls: Array<Record<string, unknown>> } }).batch.calls[0],
    ).not.toHaveProperty('dispatchPhase')
    // Three commits move the call: intent, dispatched, and result with settlement.
    const writes = toolStates(opened.opWrites())
    expect(writes.map((call) => call.status)).toEqual([
      'planned',
      'dispatch_pending',
      'dispatched',
      'completed',
    ])
    expect(
      (await opened.log.scan({ type: 'x/core/op-mark', order: 'desc', limit: 5 })).map((row) => row.data),
    ).toContainEqual(
      expect.objectContaining({
        calls: [expect.objectContaining({ status: 'dispatched', dispatchAttempt: 1 })],
      }),
    )
  })

  it('reopens a Host call whose pre-dispatch commit failed as planned, and runs it once', async () => {
    const storage = new MemoryStorage()
    const failing = new Proxy(storage, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown
        if (property === 'commit')
          return (key: string, tx: CommitTx) =>
            tx.events.some((e) => e.type === 'effect/intent' && (e.data as { kind?: string }).kind === 'tool')
              ? Promise.reject(new Error('injected'))
              : (value as MemoryStorage['commit']).call(target, key, tx)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    let dispatches = 0
    const port: HostToolDispatchPort = {
      dispatch: async (input) => {
        dispatches++
        return { phase: 'responded', result: await input.invoke() }
      },
    }
    const tool = () => computerTool(async () => ({ content: [{ type: 'text', text: 'clicked' }] }))
    const first = await ready(computerRegistry(tool()), port, failing as MemoryStorage)
    await expect(first.session.runToolsPhase()).rejects.toThrow('injected')
    await first.log.close().catch(() => undefined)
    const provider = fakeProvider([textTurn('after')])
    Object.assign(provider, { models: () => [imageModel] })
    const reopened = await openSession({
      provider,
      registry: computerRegistry(tool()),
      hostToolDispatch: port,
      storage,
    })
    expect(toolStates([{ data: reopened.session.op() }])[0]?.status).toBe('planned')
    await reopened.session.resume()
    expect(
      (await reopened.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason,
    ).toBe('completed')
    expect(dispatches).toBe(1)
  })

  it('reopens a Host call that crashed at dispatch_pending as unknown, and never dispatches it again', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const inPort = new Promise<void>((resolve) => {
      entered = resolve
    })
    const first = await ready(
      computerRegistry(computerTool(async () => ({ content: [{ type: 'text', text: 'clicked' }] }))),
      {
        dispatch: async (input) => {
          entered()
          await gate
          return { phase: 'responded', result: await input.invoke() }
        },
      },
    )
    const running = first.session.runToolsPhase().catch(() => undefined)
    await inPort
    const rows = await scanAll((q) => first.log.scan(q), { fromSeq: 1, toSeq: first.log.lastSeq })
    const opCells = structuredClone(first.log.allRegisters().filter((row) => row.register === 'op.state'))
    release()
    await running
    let dispatches = 0
    const provider = fakeProvider([textTurn('after')])
    Object.assign(provider, { models: () => [imageModel] })
    const reopened = await openSession({
      provider,
      registry: computerRegistry(computerTool(async () => ({ content: [{ type: 'text', text: 'again' }] }))),
      hostToolDispatch: {
        dispatch: async (input) => {
          dispatches++
          return { phase: 'responded', result: await input.invoke() }
        },
      },
      storage: MemoryStorage.fromEvents('k', rows, { opCells }),
      key: 'k',
      writerRunId: 'reopened',
    })
    const call = toolStates([{ data: reopened.session.op() }])[0]
    expect(call).toMatchObject({ status: 'dispatch_pending', dispatchAttempt: 1 })
    expect(call).not.toHaveProperty('dispatchPhase')
    expect((await reopened.session.resume()).actions[0]?.action).toBe('unknown')
    expect(dispatches).toBe(0)
  })
  it.each(['responded', 'rejected_before_effect'] as const)(
    'reopens a Host %s call whose result commit failed as unknown, without redispatch',
    async (mode) => {
      const storage = new MemoryStorage()
      const failing = new Proxy(storage, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown
          if (property === 'commit')
            return (key: string, tx: CommitTx) =>
              tx.events.some((e) => e.type === 'tool/result')
                ? Promise.reject(new Error('injected'))
                : (value as MemoryStorage['commit']).call(target, key, tx)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      let dispatches = 0
      let preflights = 0
      const port: HostToolDispatchPort = {
        preflight: async () => {
          preflights++
          return mode === 'rejected_before_effect'
            ? {
                code: 'INVALID_PARAMS',
                message: 'invalid synthetic input',
                path: '$.status',
                expected: 'done',
              }
            : undefined
        },
        dispatch: async (input) => {
          dispatches++
          return { phase: 'responded', result: await input.invoke() }
        },
      }
      const tool = () => computerTool(async () => ({ content: [{ type: 'text', text: 'clicked' }] }))
      const first = await ready(computerRegistry(tool()), port, failing as MemoryStorage)
      await expect(first.session.runToolsPhase()).rejects.toThrow('injected')
      await first.log.close().catch(() => undefined)
      expect(dispatches).toBe(mode === 'responded' ? 1 : 0)
      const provider = fakeProvider([textTurn('after')])
      Object.assign(provider, { models: () => [imageModel] })
      const reopened = await openSession({
        provider,
        registry: computerRegistry(tool()),
        hostToolDispatch: port,
        storage,
      })
      expect(toolStates([{ data: reopened.session.op() }])[0]).toMatchObject({
        status: mode === 'responded' ? 'dispatched' : 'dispatch_pending',
        ...(mode === 'responded' ? { dispatchPhase: 'may_have_sent' } : {}),
        dispatchAttempt: 1,
      })
      expect((await reopened.session.resume()).actions[0]?.action).toBe('unknown')
      expect(dispatches).toBe(mode === 'responded' ? 1 : 0)
      expect(
        (await reopened.log.scan({ type: 'decision/state', limit: 100 })).filter(
          (row) =>
            (row.data as { revision: number; request: { spec: { purpose: string } } }).revision === 1 &&
            (row.data as { request: { spec: { purpose: string } } }).request.spec.purpose ===
              'unknown-outcome',
        ),
      ).toHaveLength(1)
      expect(preflights).toBe(1)
      await reopened.session.close()
    },
  )
})
