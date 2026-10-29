import { hostPortRequest } from '@agnes/core'
import type { ToolContext } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { continueParked } from '../src/step/parked.js'
import { fakeProvider, type Script, sent, textTurn, usage } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'

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

async function open(run: Run, script: Script, ask?: Parameters<typeof fakeSeams>[0]) {
  const registry = new ToolRegistry()
  registry.add(remoteTool(run), { source: 's', trust: 'builtin' })
  const s = await openSession({
    provider: fakeProvider([script, textTurn('done')]),
    registry,
    seams: fakeSeams(ask),
  })
  await s.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
  await s.session.acceptInput()
  await s.session.runInference()
  return s
}
const results = async (s: Awaited<ReturnType<typeof open>>) =>
  (await s.log.scan({ type: 'tool/result', limit: 20 })).map(
    (row) => row.data as { code?: string; isError?: boolean; content: Array<{ text: string }> },
  )
const reconciliations = async (s: Awaited<ReturnType<typeof open>>) =>
  (await s.session.decisions.list()).filter((value) => value.request.spec.purpose === 'unknown-outcome')

describe('a refusal proved before any effect is a definite failure', () => {
  it('a Host-owned port refusing for parameters settles the call without asking whether it happened', async () => {
    const s = await open(
      (_args, ctx) => hostPortRequest(ctx, () => Promise.reject({ code: 'INVALID_PARAMS' }), daemonRefusal),
      calls('status'),
    )
    expect(await s.session.runToolsPhase()).not.toEqual({ phase: 'terminal', reason: 'parked' })
    const [result] = await results(s)
    expect(result).toMatchObject({ isError: true })
    expect(result?.code).not.toBe('TOOL_OUTCOME_UNKNOWN')
    expect(result?.content[0]?.text).toContain('refused the request before changing anything')
    expect(await reconciliations(s)).toEqual([])
  })

  it('the same code thrown by tool code is not proof, and a refusal after another effect is not either', async () => {
    const thrown = await open(async () => {
      throw Object.assign(new Error('bad'), { code: 'INVALID_PARAMS' })
    }, calls('status'))
    await thrown.session.runToolsPhase()
    expect((await results(thrown))[0]).toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' })
    expect(await reconciliations(thrown)).toHaveLength(1)

    const afterWrite = await open(async (_args, ctx) => {
      await ctx.fs.write('note.txt', 'x').catch(() => undefined)
      return hostPortRequest(ctx, () => Promise.reject({ code: 'INVALID_PARAMS' }), daemonRefusal)
    }, calls('status'))
    await afterWrite.session.runToolsPhase()
    expect((await results(afterWrite))[0]).toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' })
  })
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

  it('left open: the turn parks, the skipped call is closed as not started, and a later answer is consumed', async () => {
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
    expect(await s.session.runToolsPhase()).toEqual({ phase: 'terminal', reason: 'parked' })
    const [status, list] = await results(s)
    expect(status).toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' })
    expect(list).toMatchObject({ code: 'TOOL_NOT_STARTED', isError: true })
    expect(list?.content[0]?.text).toContain('remote_action was not run')
    expect(ran).toBe(0)

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
  })
})
