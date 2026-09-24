import type { ToolContext, ToolDef } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceInvocationPort, type FsOps, type WorkspaceInvocationSource } from '../src/index.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, type Script, sent, toolTurn, usage } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, openWorldTool, readTool, shellTool, writeTool } from './helpers/open-session.js'

/**
 * Mirrors the real subagent_collect tool's declared meta (packages/base/extensions/subagent/src/tools.ts):
 * a write that is also destructive, but requiresApproval:'never' — the taint-vs-declaration
 * interaction this exemption is about only shows up when a tool both writes and declares 'never'.
 */
const subagentCollectTool = (): ToolDef =>
  ({
    name: 'subagent_collect',
    description: 'collect',
    parameters: Type.Object({}),
    meta: {
      isReadOnly: false,
      isDestructive: true,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'never' as const,
      costHint: undefined,
      deferLoading: undefined,
      requiresApproval: 'never' as const,
    },
    execute: async () => ({ content: [{ type: 'text' as const, text: 'collected' }] }),
  }) as never

async function atTools(scripts: Script[], registry: ToolRegistry, seams = fakeSeams()) {
  const s = await openSession({ provider: fakeProvider(scripts), registry, seams })
  await s.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
  await s.session.acceptInput()
  await s.session.runInference()
  return s
}

function replaceSnapshotMeta(
  session: Awaited<ReturnType<typeof atTools>>['session'],
  name: string,
  patch: Partial<ToolDef['meta']>,
): void {
  const turn = session.turn
  if (!turn) throw new Error('missing turn')
  const registered = turn.snapshot.byName.get(name)
  if (!registered) throw new Error(`missing ${name}`)
  const byName = new Map(turn.snapshot.byName)
  byName.set(name, { ...registered, meta: { ...registered.meta, ...patch } })
  session.turn = { ...turn, snapshot: { ...turn.snapshot, byName } }
}
const withTool = (t: unknown) => {
  const r = new ToolRegistry()
  r.add(t as never, { source: 's', trust: 'builtin' })
  return r
}

describe('tools phase', () => {
  it('holds one workspace invocation around context creation and every real tool capability', async () => {
    const events: string[] = []
    let finishHeldRead!: () => void
    let heldReadStarted!: () => void
    const heldStarted = new Promise<void>((resolve) => {
      heldReadStarted = resolve
    })
    const heldRead = new Promise<Uint8Array>((resolve) => {
      finishHeldRead = () => resolve(new Uint8Array([9]))
    })
    const workspaceFs: FsOps = {
      read: async (path) => {
        events.push(`fs.read:${path}`)
        if (path === 'held') {
          heldReadStarted()
          return heldRead
        }
        return new Uint8Array([1])
      },
      write: async (path) => {
        events.push(`fs.write:${path}`)
      },
      list: async (path) => {
        events.push(`fs.list:${path}`)
        return []
      },
      stat: async (path) => {
        events.push(`fs.stat:${path}`)
        return { kind: 'file', size: 0, mtimeMs: 0 }
      },
    }
    const seams = fakeSeams()
    const source: WorkspaceInvocationSource = {
      root: '/w',
      fs: workspaceFs,
      ready: async () => ({
        confine: async (argv) => {
          events.push('sandbox.confine')
          return ['confined', ...argv]
        },
      }),
      hookSnapshot: async () => ({ workspaceDigest: 'digest', policyRevision: 'policy', hooks: [] }),
      hookSandbox: {
        enforcement: () => ({ level: 'full', scope: ['process'] }),
        exec: async () => {
          events.push('sandbox.exec')
          return { code: 0, stdout: '', stderr: '', truncated: false }
        },
      },
      approval: seams.approval,
      checkpoint: {
        snapshot: async () => {
          events.push('checkpoint.snapshot')
          return { id: 'checkpoint' }
        },
        rewind: async () => undefined,
        list: async () => [],
      },
    }
    const release = vi.fn(() => {
      events.push('release')
    })
    let acquisitions = 0
    const workspaceInvocation = createWorkspaceInvocationPort(() => {
      acquisitions++
      events.push('acquire')
      return { source, release }
    })
    const fallbackFs: FsOps = {
      read: vi.fn(async () => {
        throw new Error('raw fs read bypass')
      }),
      write: vi.fn(async () => {
        throw new Error('raw fs write bypass')
      }),
      list: vi.fn(async () => {
        throw new Error('raw fs list bypass')
      }),
      stat: vi.fn(async () => {
        throw new Error('raw fs stat bypass')
      }),
    }
    const tool = {
      name: 'workspace_probe',
      description: 'workspace probe',
      parameters: Type.Object({}),
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        replay: 'safe',
        costHint: undefined,
        deferLoading: undefined,
        requiresApproval: undefined,
      },
      execute: async (_args: unknown, ctx: ToolContext) => {
        events.push('tool.context')
        await Promise.all([
          ctx.fs.read('read'),
          ctx.fs.write('write', 'data'),
          ctx.fs.list('list'),
          ctx.fs.stat('stat'),
          ctx.exec(['echo']),
          ctx.sandbox.confine(['echo']),
        ])
        void ctx.fs.read('held')
        events.push('tool.return')
        return { content: [{ type: 'text' as const, text: 'ok' }] }
      },
    } as unknown as ToolDef
    const registry = withTool(tool)
    const opened = await openSession({
      provider: fakeProvider([toolTurn('workspace_probe', {})]),
      registry,
      seams,
      workspaceInvocation,
      fsOps: fallbackFs,
    })
    await opened.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await opened.session.acceptInput()
    await opened.session.runInference()

    let settled = false
    const running = opened.session.runToolsPhase().finally(() => {
      settled = true
    })
    await heldStarted
    await Promise.resolve()
    expect(acquisitions).toBe(1)
    expect(events.indexOf('acquire')).toBeLessThan(events.indexOf('tool.context'))
    expect(events).toEqual(
      expect.arrayContaining([
        'fs.read:read',
        'fs.write:write',
        'fs.list:list',
        'fs.stat:stat',
        'checkpoint.snapshot',
        'sandbox.exec',
        'sandbox.confine',
        'tool.return',
        'fs.read:held',
      ]),
    )
    expect(settled).toBe(false)
    expect(release).not.toHaveBeenCalled()
    for (const operation of Object.values(fallbackFs)) expect(operation).not.toHaveBeenCalled()

    finishHeldRead()
    await expect(running).resolves.toEqual({ phase: 'checkpoint' })
    expect(release).toHaveBeenCalledOnce()
    expect(events.at(-1)).toBe('release')
  })

  it('leases and revokes cached workspace capabilities for a host-computer-use tool', async () => {
    const seams = fakeSeams()
    let releases = 0
    const workspaceInvocation = createWorkspaceInvocationPort(() => ({
      source: {
        root: '/w',
        fs: {
          read: async () => new Uint8Array(),
          write: async () => undefined,
          list: async () => [],
          stat: async () => ({ kind: 'file' as const, size: 0, mtimeMs: 0 }),
        },
        ready: async () => ({ confine: async (argv) => argv }),
        hookSnapshot: async () => ({ workspaceDigest: 'digest', policyRevision: 'policy', hooks: [] }),
        hookSandbox: seams.sandbox,
        approval: seams.approval,
        checkpoint: seams.checkpoint,
      },
      release: () => {
        releases++
      },
    }))
    let cached!: ToolContext
    const tool = {
      name: 'computer_use',
      description: 'computer',
      parameters: Type.Object({}),
      meta: {
        isReadOnly: false,
        isDestructive: false,
        isConcurrencySafe: false,
        isOpenWorld: false,
        replay: 'never',
        costHint: undefined,
        deferLoading: undefined,
        requiresApproval: 'never',
      },
      execute: async (_args: unknown, ctx: ToolContext) => {
        cached = ctx
        await Promise.all([ctx.fs.stat('.'), ctx.exec(['echo']), ctx.sandbox.confine(['echo'])])
        return { content: [{ type: 'text' as const, text: 'ok' }] }
      },
    } as unknown as ToolDef
    const registry = new ToolRegistry()
    registry.add(tool, {
      source: 'agnes/computer-use',
      trust: 'builtin',
      packageIdentity: '@agnes/base',
      packageVersion: '1.0.0',
      executionDomain: 'host-computer-use',
    })
    const opened = await openSession({
      provider: {
        ...fakeProvider([toolTurn('computer_use', {})]),
        models: () => [
          {
            id: 'primary',
            name: 'primary',
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
          },
        ],
      },
      registry,
      seams,
      workspaceInvocation,
      hostToolDispatch: { dispatch: async (input) => ({ phase: 'responded', result: await input.invoke() }) },
    })
    await opened.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await opened.session.acceptInput()
    await opened.session.runInference()
    await expect(opened.session.runToolsPhase()).resolves.toEqual({ phase: 'checkpoint' })
    expect(releases).toBe(1)
    await expect(cached.fs.stat('.')).rejects.toThrow('E_WORKSPACE_CLOSED')
    await expect(cached.exec(['echo'])).rejects.toThrow('E_WORKSPACE_CLOSED')
    await expect(cached.sandbox.confine(['echo'])).rejects.toThrow('E_WORKSPACE_CLOSED')
  })

  it('executes a read-only call with three-entry effect accounting and closes the step', async () => {
    const { session, log } = await atTools([toolTurn('read', { path: 'a' })], withTool(readTool()))
    expect(await session.runToolsPhase()).toEqual({ phase: 'checkpoint' })
    const types = (await log.scan({ fromSeq: 1, limit: 100 })).map((e) => e.type)
    const i = types.indexOf('tool/call')
    expect(types.slice(i + 4)).toEqual([
      'op.state',
      'effect/intent',
      'op.state',
      'op.state',
      'tool/result',
      'op.state',
      'effect/settled',
      'verifier/signal',
      'op.state',
      'verifier/signal',
      'step/end',
      'op.state',
    ])
    const res = (await log.scan({ type: 'tool/result', limit: 5 }))[0]
    expect(res?.data).toMatchObject({
      isError: false,
      enforcement: { level: 'full' },
      authz: { decisionId: 'n/a' },
    })
    expect((res?.data as { content: Array<{ text: string }> } | undefined)?.content[0]?.text).toBe(
      'read:{"path":"a"}',
    )
    // The result names the call it answers, so a rebuild can pair them.
    expect(res?.sourceEventSeqs).toEqual([(await log.scan({ type: 'tool/call', limit: 5 }))[0]?.seq])
    expect(res?.trust).toBe('trusted')
    expect(session.op()).toMatchObject({
      step: 1,
      phase: { kind: 'checkpoint', continuation: 'need_assistant' },
    })
    expect(session.pendingEffects()).toEqual([])
    // No approval was needed for a read-only, non-destructive tool.
    expect(await log.scan({ type: 'approval/asked', limit: 5 })).toHaveLength(0)
  })

  it('asks approval for a destructive tool; a rejection yields an error result and no effect', async () => {
    const ok = await atTools([toolTurn('shell', { command: 'rm' })], withTool(shellTool()))
    await ok.session.runToolsPhase()
    const asked = await ok.log.scan({ type: 'approval/asked', limit: 5 })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.data).toMatchObject({ kind: 'tool', risk: 'destructive' })
    expect((await ok.log.scan({ type: 'approval/decided', limit: 5 }))[0]?.data).toMatchObject({
      verdict: 'allowed-once',
      via: 'sync',
    })
    const no = await atTools(
      [toolTurn('shell', { command: 'rm' })],
      withTool(shellTool()),
      fakeSeams({ approval: { ask: async () => 'rejected', resume: async () => null } }),
    )
    await no.session.runToolsPhase()
    // Only the inference's intent: a refused call never becomes an effect, so there is nothing to settle.
    expect(await no.log.scan({ type: 'effect/intent', limit: 10 })).toHaveLength(1)
    expect((await no.log.scan({ type: 'tool/result', limit: 5 }))[0]?.data).toMatchObject({
      code: 'APPROVAL_REJECTED',
      isError: true,
    })
  })

  it('an approvalRequest hook can raise the risk/summary an approver is shown', async () => {
    let seenRequest: unknown
    const seams = fakeSeams({
      approval: {
        ask: async (req) => {
          seenRequest = req
          return 'allowed-once'
        },
        resume: async () => null,
      },
    })
    const s = await atTools([toolTurn('shell', { command: 'rm' })], withTool(shellTool()), seams)
    s.session.hooks = {
      ...s.session.hooks,
      approvalRequest: async (p) => {
        expect(p.request).toEqual({
          tool: 'shell',
          argv: { command: 'rm' },
          risk: 'destructive',
          actor: expect.objectContaining({ id: 'u' }),
          summary: expect.stringContaining('shell'),
        })
        return { request: { risk: 'always', summary: 'operator flagged this' } }
      },
    }
    await s.session.runToolsPhase()
    expect(seenRequest).toMatchObject({ risk: 'always', summary: 'operator flagged this' })
    const asked = await s.log.scan({ type: 'approval/asked', limit: 5 })
    expect(asked[0]?.data).toMatchObject({ risk: 'always', summary: 'operator flagged this' })
  })

  it('allowed-session covers later argv for the same owner/session/tool/scope', async () => {
    let asks = 0
    const seams = fakeSeams({
      approval: {
        ask: async () => {
          asks++
          return 'allowed-session'
        },
        resume: async () => null,
      },
    })
    const s = await atTools(
      [
        toolTurn('shell', { command: 'ls' }),
        toolTurn('shell', { command: 'ls' }),
        toolTurn('shell', { command: 'other' }),
      ],
      withTool(shellTool()),
      seams,
    )
    await s.session.runToolsPhase()
    await s.session.runInference()
    await s.session.runToolsPhase()
    expect(asks).toBe(1)
    await s.session.runInference()
    await s.session.runToolsPhase()
    // Session grants deliberately bind scope, not argv. The one-shot decision remains bound to
    // the exact call, while the resulting session capability covers later calls in this scope.
    expect(asks).toBe(1)
  })

  it('a hook denial refuses the call without asking anyone', async () => {
    let asks = 0
    const seams = fakeSeams({
      approval: {
        ask: async () => {
          asks++
          return 'allowed-once'
        },
        resume: async () => null,
      },
    })
    const s = await atTools([toolTurn('shell', { command: 'rm' })], withTool(shellTool()), seams)
    s.session.hooks = { ...s.session.hooks, toolCall: async () => ({ allow: false, reason: 'policy' }) }
    await s.session.runToolsPhase()
    expect(asks).toBe(0)
    expect((await s.log.scan({ type: 'tool/result', limit: 5 }))[0]?.data).toMatchObject({
      code: 'HOOK_DENIED',
    })
  })

  it('an authorize deny refuses the call, and require_approval turns into an ask', async () => {
    const denied = await atTools(
      [toolTurn('read', {})],
      withTool(readTool()),
      fakeSeams({
        principals: {
          authorize: async () => ({ decisionId: 'd1', effect: 'deny', reason: 'not your table' }),
        },
      }),
    )
    await denied.session.runToolsPhase()
    expect((await denied.log.scan({ type: 'tool/result', limit: 5 }))[0]?.data).toMatchObject({
      code: 'AUTHZ_DENIED',
      authz: { decisionId: 'd1' },
    })
    let asks = 0
    const gated = await atTools(
      [toolTurn('read', {})],
      withTool(readTool()),
      fakeSeams({
        principals: {
          authorize: async () => ({ decisionId: 'd2', effect: 'require_approval', reason: 'sensitive' }),
        },
        approval: {
          ask: async () => {
            asks++
            return 'allowed-once'
          },
          resume: async () => null,
        },
      }),
    )
    await gated.session.runToolsPhase()
    expect(asks).toBe(1)
    expect((await gated.log.scan({ type: 'tool/result', limit: 5 }))[0]?.data).toMatchObject({
      isError: false,
    })
  })

  it('a writing tool is refused when no sandbox enforces anything and the preset denies', async () => {
    const s = await atTools(
      [toolTurn('shell', { command: 'rm' })],
      withTool(shellTool()),
      fakeSeams({ sandbox: { enforcement: () => ({ level: 'none', scope: [] }) } }),
    )
    await s.session.runToolsPhase()
    expect((await s.log.scan({ type: 'tool/result', limit: 5 }))[0]?.data).toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    })
    expect(await s.log.scan({ type: 'effect/intent', limit: 10 })).toHaveLength(1)
  })

  it('a Pending approval parks the turn, closing the step in the same transaction', async () => {
    const s = await atTools(
      [toolTurn('shell', { command: 'rm' })],
      withTool(shellTool()),
      fakeSeams({
        approval: {
          ask: async () => ({ ticket: 'T1', expiresAt: '2026-09-08T00:00:00Z' }),
          resume: async () => null,
        },
      }),
    )
    expect(await s.session.runToolsPhase()).toEqual({ phase: 'terminal', reason: 'parked' })
    const tail = (await s.log.scan({ fromSeq: s.log.lastSeq - 3, limit: 4 })).map((e) => e.type)
    expect(tail).toEqual(['approval/asked', 'step/end', 'turn/end', 'op.state'])
    expect(s.session.op()).toBeNull()
    expect((await s.log.scan({ type: 'approval/asked', limit: 5 }))[0]?.data).toMatchObject({
      pending: { ticket: 'T1' },
    })
    expect((await s.log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({ reason: 'parked' })
  })

  it('a tool that runs past its deadline yields a partial error result naming the deadline', async () => {
    const s = await atTools([toolTurn('read', {})], withTool(readTool(() => new Promise(() => undefined))))
    s.session.preset = { ...s.session.preset, tools: { timeoutMs: 5, timeouts: {} } }
    await s.session.runToolsPhase()
    const res = (await s.log.scan({ type: 'tool/result', limit: 5 }))[0]
    expect(res?.data).toMatchObject({
      isError: true,
      code: 'CANCELLED',
      partial: true,
      cancelledBy: { id: 'timeout', role: 'system' },
    })
    expect((await s.log.scan({ type: 'effect/settled', limit: 10 }))[1]?.data).toMatchObject({
      outcome: 'aborted',
    })
  })

  it('a per-tool timeout overrides the default', async () => {
    const s = await atTools([toolTurn('read', {})], withTool(readTool(() => new Promise(() => undefined))))
    s.session.preset = { ...s.session.preset, tools: { timeoutMs: 60_000, timeouts: { read: 5 } } }
    await s.session.runToolsPhase()
    expect((await s.log.scan({ type: 'tool/result', limit: 5 }))[0]?.data).toMatchObject({
      code: 'CANCELLED',
    })
  })

  it('runs concurrency-safe calls in parallel and records results in model order', async () => {
    const order: string[] = []
    const tool = readTool(async (a) => {
      order.push(`start:${JSON.stringify(a)}`)
      await new Promise((res) => setTimeout(res, 5))
      order.push(`end:${JSON.stringify(a)}`)
      return { content: [{ type: 'text' as const, text: 'ok' }] }
    })
    const script: Script = [
      sent(),
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'read', args: { id: 1 }, ordinal: 0 },
        via: 'native',
      },
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'read', args: { id: 2 }, ordinal: 1 },
        via: 'native',
      },
      usage(),
      { type: 'done', reason: 'toolUse' },
    ]
    const s = await atTools([script], withTool(tool))
    await s.session.runToolsPhase()
    // Genuinely overlapping, not merely started in order: the second begins before the first ends,
    // which a serial scheduler cannot produce.
    expect(order).toEqual(['start:{"id":1}', 'start:{"id":2}', 'end:{"id":1}', 'end:{"id":2}'])
    const results = await s.log.scan({ type: 'tool/result', limit: 5 })
    expect(results.map((e) => (e.data as { toolUseId: string }).toolUseId.slice(0, 2))).toEqual(['t0', 't1'])
    // Both calls got their own arguments, read back from their own tool/call rows.
    expect(results.map((e) => (e.data as { content: Array<{ text: string }> }).content[0]?.text)).toEqual([
      'ok',
      'ok',
    ])
    expect(await s.log.scan({ type: 'step/end', limit: 5 })).toHaveLength(1)
  })

  it('a call that is not concurrency safe is a barrier', async () => {
    const order: string[] = []
    const tool = shellTool(async (a) => {
      order.push(`start:${JSON.stringify(a)}`)
      await new Promise((res) => setTimeout(res, 5))
      order.push(`end:${JSON.stringify(a)}`)
      return { content: [{ type: 'text' as const, text: 'ok' }] }
    })
    const script: Script = [
      sent(),
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'shell', args: { id: 1 }, ordinal: 0 },
        via: 'native',
      },
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'shell', args: { id: 2 }, ordinal: 1 },
        via: 'native',
      },
      usage(),
      { type: 'done', reason: 'toolUse' },
    ]
    const s = await atTools([script], withTool(tool))
    await s.session.runToolsPhase()
    expect(order).toEqual(['start:{"id":1}', 'end:{"id":1}', 'start:{"id":2}', 'end:{"id":2}'])
  })

  it('an open-world tool result is recorded untrusted and taints the turn', async () => {
    const openWorld = {
      ...(readTool() as unknown as { meta: Record<string, unknown> }),
      meta: { ...(readTool() as unknown as { meta: Record<string, unknown> }).meta, isOpenWorld: true },
    }
    const s = await atTools([toolTurn('read', {})], withTool(openWorld))
    await s.session.runToolsPhase()
    expect((await s.log.scan({ type: 'tool/result', limit: 5 }))[0]?.trust).toBe('untrusted')
    expect(s.tracker.state.taint.get('main')).toBe(true)
  })

  it('uses persisted result trust when live tool metadata changes after inference', async () => {
    const base = readTool() as ToolDef
    const tool: ToolDef = { ...base, meta: { ...base.meta, isOpenWorld: false } }
    const s = await atTools([toolTurn('read', {})], withTool(tool))
    replaceSnapshotMeta(s.session, 'read', { isOpenWorld: true })
    await s.session.runToolsPhase()
    expect((await s.log.scan({ type: 'tool/result', limit: 5 }))[0]?.trust).toBe('trusted')
    expect(s.tracker.state.taint.get('main')).toBe(false)
  })

  it('uses persisted scheduler safety when live tool metadata changes after inference', async () => {
    let active = 0
    let maxActive = 0
    const base = readTool(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active--
      return { content: [{ type: 'text' as const, text: 'ok' }] }
    }) as ToolDef
    const tool: ToolDef = { ...base, meta: { ...base.meta, isConcurrencySafe: false } }
    const script: Script = [
      sent(),
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'read', args: {}, ordinal: 0 },
        via: 'native',
      },
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'read', args: {}, ordinal: 1 },
        via: 'native',
      },
      usage(),
      { type: 'done', reason: 'toolUse' },
    ]
    const s = await atTools([script], withTool(tool))
    replaceSnapshotMeta(s.session, 'read', { isConcurrencySafe: true })
    await s.session.runToolsPhase()
    expect(maxActive).toBe(1)
  })

  it('a terminating tool leaves the checkpoint free to finish the turn', async () => {
    const stop = readTool(async () => ({
      content: [{ type: 'text' as const, text: 'done' }],
      terminate: true,
    }))
    const s = await atTools([toolTurn('read', {})], withTool(stop))
    await s.session.runToolsPhase()
    expect(s.session.op()?.phase).toMatchObject({ kind: 'checkpoint', continuation: 'may_finish' })
  })

  it('an unknown tool is refused rather than crashing the batch', async () => {
    const s = await atTools([toolTurn('read', {})], withTool(readTool()))
    // Take the tool away between the model asking for it and the phase running.
    const t = s.session.turn as NonNullable<typeof s.session.turn>
    s.session.turn = { ...t, snapshot: new ToolRegistry().snapshot(1) }
    expect(await s.session.runToolsPhase()).toEqual({ phase: 'checkpoint' })
    expect((await s.log.scan({ type: 'tool/result', limit: 5 }))[0]?.data).toMatchObject({
      code: 'TOOL_NOT_FOUND',
    })
  })
})

describe('tools phase — approval escalation, parking and failure (fix round 1)', () => {
  /**
   * The whole point of taint: an open-world result is text the harness did not write, and after one
   * lands, a call that *changes* something is a call the model may have been talked into. The
   * assertion is on the ask, not on the row's trust flag — an escalation clause that has never once
   * fired is indistinguishable from one that cannot.
   */
  it('a tainted turn escalates a write that asks for nothing in a clean turn', async () => {
    const registry = new ToolRegistry()
    registry.add(openWorldTool(), { source: 's', trust: 'builtin' })
    registry.add(writeTool(), { source: 's', trust: 'builtin' })
    const asks: Array<{ name?: string; taint: boolean }> = []
    const seams = fakeSeams({
      approval: {
        ask: async (req) => {
          asks.push({ ...(req.tool ? { name: req.tool.name } : {}), taint: req.taint })
          return 'allowed-once'
        },
        resume: async () => null,
      },
    })

    // Clean turn: the same write asks nobody.
    const clean = await atTools([toolTurn('write_note', { text: 'a' })], registry, seams)
    await clean.session.runToolsPhase()
    expect(asks).toHaveLength(0)
    expect((await clean.log.scan({ type: 'tool/result', limit: 5 }))[0]?.data).toMatchObject({
      isError: false,
    })

    // Tainted turn: the open-world result lands first, then the same write is escalated.
    const s = await atTools(
      [toolTurn('fetch_page', {}), toolTurn('write_note', { text: 'a' })],
      registry,
      seams,
    )
    await s.session.runToolsPhase()
    expect(s.tracker.state.taint.get('main')).toBe(true)
    // The counter carries the answer forward, so a resume that reads only op.state sees it too.
    expect(s.session.op()?.taint).toBe(true)
    await s.session.step() // checkpoint -> inference
    await s.session.step() // the second inference, which plans the write
    expect(await s.session.runToolsPhase()).toEqual({ phase: 'checkpoint' })
    expect(asks).toEqual([{ name: 'write_note', taint: true }])
    expect((await s.log.scan({ type: 'approval/asked', limit: 10 }))[0]?.data).toMatchObject({
      risk: 'destructive',
      kind: 'tool',
    })
  })

  /**
   * subagent_collect writes and is declared isDestructive, so without the subagent-management
   * exemption it would hit the exact same taint-escalation clause as write_note above once a
   * turn is tainted. It runs unattended (collecting a delegated child's result), so falling
   * through to "ask a human" here just means nobody answers — the tool's own requiresApproval:
   * 'never' has to stand even under taint.
   */
  it('a tainted turn does not escalate subagent_collect even though it writes', async () => {
    const registry = new ToolRegistry()
    registry.add(openWorldTool(), { source: 's', trust: 'builtin' })
    registry.add(subagentCollectTool(), { source: 's', trust: 'builtin' })
    const asks: Array<{ name?: string; taint: boolean }> = []
    const seams = fakeSeams({
      approval: {
        ask: async (req) => {
          asks.push({ ...(req.tool ? { name: req.tool.name } : {}), taint: req.taint })
          return 'allowed-once'
        },
        resume: async () => null,
      },
    })

    const s = await atTools([toolTurn('fetch_page', {}), toolTurn('subagent_collect', {})], registry, seams)
    await s.session.runToolsPhase()
    expect(s.tracker.state.taint.get('main')).toBe(true)
    await s.session.step() // checkpoint -> inference
    await s.session.step() // the second inference, which plans the collect
    expect(await s.session.runToolsPhase()).toEqual({ phase: 'checkpoint' })
    expect(asks).toEqual([])
    expect(await s.log.scan({ type: 'approval/asked', limit: 10 })).toHaveLength(0)
    expect((await s.log.scan({ type: 'tool/result', limit: 5 }))[0]?.data).toMatchObject({
      isError: false,
    })
  })

  /** Yolo overrides an ordinary destructive ask too, not just the subagent/taint exemptions above. */
  it('yolo skips the ask for an ordinary destructive tool', async () => {
    const asks: string[] = []
    const seams = fakeSeams({
      approval: {
        ask: async (req) => {
          asks.push(req.tool?.name ?? '')
          return 'allowed-once'
        },
        resume: async () => null,
      },
    })
    const s = await atTools([toolTurn('shell', { command: 'rm' })], withTool(shellTool()), seams)
    s.session.yolo = true
    await s.session.runToolsPhase()
    expect(asks).toEqual([])
    expect(await s.log.scan({ type: 'approval/asked', limit: 10 })).toHaveLength(0)
    expect((await s.log.scan({ type: 'tool/result', limit: 5 }))[0]?.data).toMatchObject({ isError: false })
  })

  /**
   * Two concurrency-safe calls both reach the park. Only one writes it, and it carries both asks:
   * the loser used to write a `step/end` into a turn its sibling had already closed, which threw
   * `E_RELATION` out of run() where the contract promises `{ reason: 'parked' }`.
   */
  it('parking inside a concurrent batch parks once and keeps every unanswered question', async () => {
    const script: Script = [
      sent(),
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'write_note', args: { id: 1 }, ordinal: 0 },
        via: 'native',
      },
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'write_note', args: { id: 2 }, ordinal: 1 },
        via: 'native',
      },
      usage(),
      { type: 'done', reason: 'toolUse' },
    ]
    const concurrent = {
      ...(writeTool() as unknown as { meta: Record<string, unknown> }),
      meta: {
        ...(writeTool() as unknown as { meta: Record<string, unknown> }).meta,
        isConcurrencySafe: true,
        requiresApproval: 'always',
      },
    }
    const s = await atTools(
      [script],
      withTool(concurrent),
      fakeSeams({
        approval: {
          ask: async () => ({ ticket: 'T1', expiresAt: '2026-09-08T00:00:00Z' }),
          resume: async () => null,
        },
      }),
    )
    expect(await s.session.runToolsPhase()).toEqual({ phase: 'terminal', reason: 'parked' })
    expect(s.session.op()).toBeNull()
    const tail = (await s.log.scan({ fromSeq: s.log.lastSeq - 4, limit: 5 })).map((e) => e.type)
    expect(tail).toEqual(['approval/asked', 'approval/asked', 'step/end', 'turn/end', 'op.state'])
    expect((await s.log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({ reason: 'parked' })
    // Exactly one step/end and one turn/end: the batch is closed once, not once per member.
    expect(await s.log.scan({ type: 'step/end', limit: 10 })).toHaveLength(1)
    expect(await s.log.scan({ type: 'turn/end', limit: 10 })).toHaveLength(1)
  })

  it('parking through run() returns the parked outcome rather than throwing', async () => {
    const concurrent = {
      ...(writeTool() as unknown as { meta: Record<string, unknown> }),
      meta: {
        ...(writeTool() as unknown as { meta: Record<string, unknown> }).meta,
        isConcurrencySafe: true,
        requiresApproval: 'always',
      },
    }
    const script: Script = [
      sent(),
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'write_note', args: { id: 1 }, ordinal: 0 },
        via: 'native',
      },
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'write_note', args: { id: 2 }, ordinal: 1 },
        via: 'native',
      },
      usage(),
      { type: 'done', reason: 'toolUse' },
    ]
    const s = await openSession({
      provider: fakeProvider([script]),
      registry: withTool(concurrent),
      seams: fakeSeams({
        approval: {
          ask: async () => ({ ticket: 'T1', expiresAt: '2026-09-08T00:00:00Z' }),
          resume: async () => null,
        },
      }),
    })
    await s.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    const out = await s.session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(out.reason).toBe('parked')
  })

  it('settles a deferred job when a sibling approval parks the batch', async () => {
    const deferred: ToolDef = {
      ...(readTool() as ToolDef),
      name: 'export_job',
      execute: async (_args, ctx) =>
        ({
          content: [{ type: 'text' as const, text: 'queued' }],
          deferred: {
            jobId: await ctx.artifacts.submitJob({
              idempotencyKey: 'park-job',
              payload: { prompt: 'park fixture' },
            }),
          },
        }) as never,
    }
    const write = writeTool() as ToolDef
    const asks: ToolDef = {
      ...write,
      meta: { ...write.meta, isConcurrencySafe: true, requiresApproval: 'always' as const },
    }
    const registry = new ToolRegistry()
    registry.add(deferred as never, { source: 's', trust: 'builtin' })
    registry.add(asks as never, { source: 's', trust: 'builtin' })
    const script: Script = [
      sent(),
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'export_job', args: {}, ordinal: 0 },
        via: 'native',
      },
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'write_note', args: {}, ordinal: 1 },
        via: 'native',
      },
      usage(),
      { type: 'done', reason: 'toolUse' },
    ]
    const s = await atTools(
      [script],
      registry,
      fakeSeams({
        approval: {
          ask: async () => ({ ticket: 'T1', expiresAt: '2026-09-08T00:00:00Z' }),
          resume: async () => null,
        },
      }),
    )

    expect(await s.session.runToolsPhase()).toEqual({ phase: 'terminal', reason: 'parked' })
    expect(s.session.pendingEffects()).toEqual([])
    expect((await s.log.scan({ type: 'tool/result', limit: 10 }))[0]?.data).toMatchObject({
      code: 'TOOL_OUTCOME_UNKNOWN',
      isError: true,
    })
    expect((await s.log.scan({ type: 'effect/settled', order: 'desc', limit: 1 }))[0]?.data).toMatchObject({
      outcome: 'unknown',
    })
  })

  /**
   * A tool that throws was not cancelled, did not come back partial, and nobody cancelled it. The
   * old catch block said all three, which also made "a cut settles aborted" unfalsifiable.
   */
  it('a tool that throws settles as an error, not as a cancellation by its own owner', async () => {
    const boom = readTool(async () => {
      throw new Error('boom')
    })
    const s = await atTools([toolTurn('read', {})], withTool(boom))
    expect(await s.session.runToolsPhase()).toEqual({ phase: 'checkpoint' })
    const res = (await s.log.scan({ type: 'tool/result', limit: 5 }))[0]?.data as Record<string, unknown>
    expect(res).toMatchObject({ isError: true })
    expect(res.code).toBeUndefined()
    expect(res.partial).toBeUndefined()
    expect(res.cancelledBy).toBeUndefined()
    expect((await s.log.scan({ type: 'effect/settled', limit: 10 })).at(-1)?.data).toMatchObject({
      outcome: 'error',
    })
    // And a real cut still settles 'aborted', so the two are now distinguishable.
    const hang = await atTools([toolTurn('read', {})], withTool(readTool(() => new Promise(() => undefined))))
    hang.session.preset = { ...hang.session.preset, tools: { timeoutMs: 5, timeouts: {} } }
    await hang.session.runToolsPhase()
    expect((await hang.log.scan({ type: 'effect/settled', limit: 10 })).at(-1)?.data).toMatchObject({
      outcome: 'aborted',
    })
  })

  it('a planned call whose tool/call row is outside the scan window is dropped, not run with no args', async () => {
    const seen: unknown[] = []
    const s = await atTools(
      [toolTurn('read', { path: 'a' })],
      withTool(
        readTool(async (a) => {
          seen.push(a)
          return { content: [{ type: 'text' as const, text: 'ok' }] }
        }),
      ),
    )
    const op = s.session.op() as { phase: { batch: { calls: Array<{ toolUseId: string }> } } }
    // Stand in for a counter and a ledger that disagree about which rows this batch covers.
    const planned = op.phase.batch.calls[0] as { toolUseId: string }
    planned.toolUseId = 'ghost'
    await s.session.runToolsPhase()
    expect(seen).toHaveLength(0)
    expect(await s.log.scan({ type: 'tool/result', limit: 5 })).toHaveLength(0)
    expect((await s.log.scan({ type: 'x/core/invariant', limit: 5 }))[0]?.data).toMatchObject({
      kind: 'tool-args-missing',
    })
    // The batch still closes rather than stalling the turn on a call it cannot run.
    expect(s.session.op()?.phase).toMatchObject({ kind: 'checkpoint' })
  })
})
