import type { ToolDef } from '@agnes/extension-api'
import type { ModelRecord } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import type { HostToolDispatchPort } from '../src/effects/tool-dispatch.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { type OpStateObj, type ToolCallState, withPhase } from '../src/step/op-state.js'
import { fakeProvider, toolTurn } from './helpers/fake-provider.js'
import { actor, openSession, readTool } from './helpers/open-session.js'

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

async function ready(registry: ToolRegistry, hostToolDispatch?: HostToolDispatchPort) {
  const provider = fakeProvider([toolTurn([...registry.list()][0]?.name ?? 'computer_use', {})])
  if (registry.resolve('computer_use')) Object.assign(provider, { models: () => [imageModel] })
  const opened = await openSession({
    provider,
    registry,
    ...(hostToolDispatch ? { hostToolDispatch } : {}),
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
  it('persists workspace may_have_sent before entering author code, then records responded before settle', async () => {
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
    const resultIndex = rows.findIndex((row) => row.type === 'tool/result')
    expect(rows[resultIndex + 1]?.type).toBe('op.state')
    expect((rows[resultIndex + 1]?.data as { phase?: unknown } | undefined)?.phase).toMatchObject({
      kind: 'tools',
      batch: {
        calls: [
          expect.objectContaining({
            status: 'responded',
            dispatchAttempt: 1,
            dispatchPhase: 'responded',
          }),
        ],
      },
    })
    expect(rows.slice(resultIndex + 2).some((row) => row.type === 'effect/settled')).toBe(true)
  })

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
    const states = toolStates(await opened.log.scan({ type: 'op.state', limit: 100 }))
    expect(states).toContainEqual(
      expect.objectContaining({
        status: 'dispatch_pending',
        dispatchAttempt: 1,
        dispatchPhase: 'not_sent',
      }),
    )
    expect(states).toContainEqual(
      expect.objectContaining({
        status: 'responded',
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
      })
      expect(
        (await opened.log.scan({ type: 'effect/settled', order: 'desc', limit: 1 }))[0]?.data,
      ).toMatchObject({ outcome: 'unknown' })
    },
  )

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
})
