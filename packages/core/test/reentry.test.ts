import type { ToolDef } from '@agnes/extension-api'
import type { ModelRecord } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it, vi } from 'vitest'
import { MemoryStorage } from '../src/log/memory-storage.js'
import type { StorageAdapter } from '../src/log/storage.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { presetDefaults } from '../src/step/preset.js'
import type { Operation, SlotOperation } from '../src/step/session.js'
import { fakeProvider, type Script, sent, textTurn, toolTurn, usage } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, readTool, shellTool } from './helpers/open-session.js'

const meta = {
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: 'never' as const,
  costHint: undefined,
  deferLoading: undefined,
  requiresApproval: undefined,
}

describe('re-entry and slots', () => {
  it('serializes unsafe child tools invoked by concurrent safe parents', async () => {
    let active = 0
    let peak = 0
    let parentsEntered = 0
    let releaseParents!: () => void
    const bothParentsEntered = new Promise<void>((resolve) => {
      releaseParents = resolve
    })
    const r = new ToolRegistry()
    const child = readTool(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return { content: [{ type: 'text' as const, text: 'child' }] }
    }) as ToolDef
    child.meta = { ...child.meta, isConcurrencySafe: false }
    r.add(child, { source: 's', trust: 'builtin' })
    r.add(
      {
        name: 'run_code',
        description: 'x',
        parameters: Type.Object({}),
        meta: { ...meta, isReadOnly: true, isConcurrencySafe: true, replay: 'safe' },
        execute: async (
          _args: unknown,
          ctx: { tools: { invoke(name: string, args: unknown): Promise<unknown> } },
        ) => {
          parentsEntered++
          if (parentsEntered === 2) releaseParents()
          await bothParentsEntered
          await ctx.tools.invoke('read', {})
          return { content: [{ type: 'text', text: 'parent complete' }] }
        },
      } as never,
      { source: 's', trust: 'builtin' },
    )
    const parallelParents: Script = [
      sent(),
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'run_code', args: {}, ordinal: 0 },
        via: 'native',
      },
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'run_code', args: {}, ordinal: 1 },
        via: 'native',
      },
      usage(),
      { type: 'done', reason: 'toolUse' },
    ]
    const { session } = await openSession({
      provider: fakeProvider([parallelParents, textTurn('ok')]),
      registry: r,
      preset: { ...presetDefaults(), disclosure: 'code' },
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(peak).toBe(1)
  })

  it('allows a nested safe parent to invoke two safe children concurrently', async () => {
    let childrenEntered = 0
    let releaseChildren!: () => void
    const bothChildrenEntered = new Promise<void>((resolve) => {
      releaseChildren = resolve
    })
    const r = new ToolRegistry()
    for (const name of ['safe_a', 'safe_b']) {
      r.add(
        {
          ...(readTool() as ToolDef),
          name,
          execute: async () => {
            childrenEntered++
            if (childrenEntered === 2) releaseChildren()
            await bothChildrenEntered
            return { content: [{ type: 'text' as const, text: name }] }
          },
        },
        { source: 's', trust: 'builtin' },
      )
    }
    r.add(
      {
        name: 'middle',
        description: 'middle',
        parameters: Type.Object({}),
        meta: { ...meta, isReadOnly: true, isConcurrencySafe: true, replay: 'safe' },
        execute: async (
          _args: unknown,
          ctx: { tools: { invoke(name: string, args: unknown): Promise<unknown> } },
        ) => {
          await Promise.all([ctx.tools.invoke('safe_a', {}), ctx.tools.invoke('safe_b', {})])
          return { content: [{ type: 'text', text: 'middle complete' }] }
        },
      } as never,
      { source: 's', trust: 'builtin' },
    )
    r.add(
      {
        name: 'run_code',
        description: 'root',
        parameters: Type.Object({}),
        meta: { ...meta, isReadOnly: true, isConcurrencySafe: true, replay: 'safe' },
        execute: async (
          _args: unknown,
          ctx: { tools: { invoke(name: string, args: unknown): Promise<unknown> } },
        ) => {
          await ctx.tools.invoke('middle', {})
          return { content: [{ type: 'text', text: 'root complete' }] }
        },
      } as never,
      { source: 's', trust: 'builtin' },
    )
    const { session } = await openSession({
      provider: fakeProvider([toolTurn('run_code', {}), textTurn('ok')]),
      registry: r,
      preset: { ...presetDefaults(), disclosure: 'code' },
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(childrenEntered).toBe(2)
  })

  it('cancels a queued unsafe child when its safe parent times out', async () => {
    let releaseBlockerStarted!: () => void
    const blockerStarted = new Promise<void>((resolve) => {
      releaseBlockerStarted = resolve
    })
    const childExecute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'child' }] }))
    const child = readTool(childExecute) as ToolDef
    child.meta = { ...child.meta, isConcurrencySafe: false }
    const r = new ToolRegistry()
    r.add(child, { source: 's', trust: 'builtin' })
    r.add(
      {
        name: 'blocker',
        description: 'blocker',
        parameters: Type.Object({}),
        meta: { ...meta, isReadOnly: true, isConcurrencySafe: true, replay: 'safe' },
        execute: async () => {
          releaseBlockerStarted()
          await new Promise((resolve) => setTimeout(resolve, 30))
          return { content: [{ type: 'text', text: 'blocker complete' }] }
        },
      } as never,
      { source: 's', trust: 'builtin' },
    )
    r.add(
      {
        name: 'run_code',
        description: 'root',
        parameters: Type.Object({}),
        meta: { ...meta, isReadOnly: true, isConcurrencySafe: true, replay: 'safe' },
        execute: async (
          _args: unknown,
          ctx: { tools: { invoke(name: string, args: unknown): Promise<unknown> } },
        ) => {
          await blockerStarted
          await ctx.tools.invoke('read', {})
          return { content: [{ type: 'text', text: 'unexpected' }] }
        },
      } as never,
      { source: 's', trust: 'builtin' },
    )
    const parallelParents: Script = [
      sent(),
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'run_code', args: {}, ordinal: 0 },
        via: 'native',
      },
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'blocker', args: {}, ordinal: 1 },
        via: 'native',
      },
      usage(),
      { type: 'done', reason: 'toolUse' },
    ]
    const defaults = presetDefaults()
    const { session, log } = await openSession({
      provider: fakeProvider([parallelParents, textTurn('ok')]),
      registry: r,
      preset: {
        ...defaults,
        disclosure: 'hybrid',
        tools: {
          ...defaults.tools,
          timeouts: { ...defaults.tools.timeouts, run_code: 10, blocker: 100, read: 100 },
        },
      },
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    const calls = await log.scan({ type: 'tool/call', limit: 20 })
    expect(calls.map((row) => (row.data as { name?: string }).name)).toContain('read')
    const blockerCall = calls.find((row) => (row.data as { name?: string }).name === 'blocker')
    const blockerToolUseId = (blockerCall?.data as { toolUseId?: string } | undefined)?.toolUseId
    expect(blockerToolUseId).toBeDefined()
    const blockerResult = (await log.scan({ type: 'tool/result', limit: 20 })).find(
      (row) => (row.data as { toolUseId?: string }).toolUseId === blockerToolUseId,
    )
    expect(blockerResult?.data).not.toMatchObject({ code: 'TOOL_NOT_DISCLOSED' })
    const readCall = calls.find((row) => (row.data as { name?: string }).name === 'read')
    const readToolUseId = (readCall?.data as { toolUseId?: string } | undefined)?.toolUseId
    expect(
      (await log.scan({ type: 'tool/result', limit: 20 })).find(
        (row) => (row.data as { toolUseId?: string }).toolUseId === readToolUseId,
      )?.data,
    ).toMatchObject({ code: 'CANCELLED', isError: true })
    expect(childExecute).not.toHaveBeenCalled()
  })

  it('a tool can invoke another tool at depth 1 with a child effect', async () => {
    const r = new ToolRegistry()
    const child = readTool() as ToolDef
    child.execute = async () => ({
      content: [{ type: 'text', text: 'child text' }],
      structured: { rows: 2 },
    })
    r.add(child, { source: 's', trust: 'builtin' })
    let nestedStructured: unknown
    r.add(
      {
        name: 'run_code',
        description: 'x',
        parameters: Type.Object({}),
        meta,
        execute: async (
          _a: unknown,
          ctx: {
            tools: {
              invoke(
                n: string,
                a: unknown,
              ): Promise<{ content: Array<{ text?: string }>; structured?: unknown }>
            }
          },
        ) => {
          const r1 = await ctx.tools.invoke('read', { p: 1 })
          nestedStructured = r1.structured
          return { content: [{ type: 'text', text: `child:${r1.content[0]?.text}` }] }
        },
      } as never,
      { source: 's', trust: 'builtin' },
    )
    const { session, log, opWrites } = await openSession({
      provider: fakeProvider([toolTurn('run_code', { code: '…' }), textTurn('ok')]),
      registry: r,
      // 'run_code' is the one tool name the default 'standard' disclosure policy withholds
      // (discloseTools, inference.ts) — the model never calling it itself is exactly the case
      // 'code' disclosure exists for.
      preset: { ...presetDefaults(), disclosure: 'code' },
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    const intents = (await log.scan({ type: 'effect/intent', limit: 20 })).map(
      (e) => e.data as { kind: string; effectId?: string; parentEffectId?: string },
    )
    const tools = intents.filter((i) => i.kind === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[1]?.parentEffectId).toBe(tools[0]?.effectId)
    const results = await log.scan({ type: 'tool/result', limit: 10 })
    expect(results.map((e) => (e.data as { toolUseId: string }).toolUseId.slice(0, 2))).toEqual(['t1', 't0'])
    const states = opWrites()
    expect(
      states.some((row) => {
        const state = row.data as {
          phase?: {
            kind?: string
            batch?: {
              calls?: Array<{
                name?: string
                resolvedPolicy?: unknown
                executionDomain?: unknown
                definitionFingerprint?: unknown
                policyHash?: unknown
              }>
            }
          }
        } | null
        const nested = state?.phase?.batch?.calls?.find((call) => call.name === 'read')
        return (
          state?.phase?.kind === 'tools' &&
          nested?.resolvedPolicy !== undefined &&
          nested.executionDomain === 'workspace' &&
          typeof nested.definitionFingerprint === 'string' &&
          typeof nested.policyHash === 'string'
        )
      }),
    ).toBe(true)
    expect(nestedStructured).toEqual({ rows: 2 })
  })

  it('persists a nested approval request, parks the owner batch, and resumes only the nested call', async () => {
    const r = new ToolRegistry()
    const nestedRead = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'too deep' }] }))
    r.add(readTool(nestedRead), { source: 's', trust: 'builtin' })
    const execute = vi.fn(
      async (_args: unknown, ctx: { tools: { invoke(name: string, args: unknown): Promise<unknown> } }) => {
        try {
          await ctx.tools.invoke('read', {})
          return { content: [{ type: 'text' as const, text: 'depth limit bypassed' }] }
        } catch (error) {
          return {
            content: [{ type: 'text' as const, text: String((error as { code?: string }).code) }],
          }
        }
      },
    )
    const shell = shellTool() as ToolDef
    shell.execute = execute as ToolDef['execute']
    r.add(shell, { source: 's', trust: 'builtin' })
    r.add(
      {
        name: 'run_code',
        description: 'x',
        parameters: Type.Object({}),
        meta,
        execute: async (
          _args: unknown,
          ctx: { tools: { invoke(name: string, args: unknown): Promise<unknown> } },
        ) => {
          await ctx.tools.invoke('shell', { command: 'click' })
          return { content: [{ type: 'text', text: 'parent complete' }] }
        },
      } as never,
      { source: 's', trust: 'builtin' },
    )
    let receipt: { requestId: string; bindingHash: string; expiresAt: string } | undefined
    const seams = fakeSeams({
      approval: {
        ask: async (request) => {
          const expiresAt = '2999-01-01T00:00:00.000Z'
          receipt = { requestId: request.requestId, bindingHash: request.bindingHash, expiresAt }
          return { ticket: 'nested-ticket', expiresAt }
        },
        resume: async (ticket) => (ticket === 'nested-ticket' ? (receipt ?? null) : null),
      },
    })
    const h = await openSession({
      provider: fakeProvider([toolTurn('run_code', {}), textTurn('done')]),
      registry: r,
      seams,
      preset: { ...presetDefaults(), disclosure: 'code', depthLimit: 1 },
    })
    await h.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect((await h.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'parked',
    )
    expect(execute).not.toHaveBeenCalled()
    const asked = (await h.log.scan({ type: 'approval/asked', limit: 10 }))[0]
    expect(asked?.data).toMatchObject({ kind: 'tool' })
    await h.session.resumeApproval('nested-ticket', 'allowed-once', { ...actor, id: 'approver' })
    expect((await h.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(execute).toHaveBeenCalledTimes(1)
    expect(nestedRead).not.toHaveBeenCalled()
    const calls = await h.log.scan({ type: 'tool/call', limit: 10 })
    const nested = calls.find((row) => (row.data as { name?: string }).name === 'shell')
    expect(nested?.data).toMatchObject({ depth: 1, parentEffectId: expect.any(String) })
    if (!nested) throw new Error('missing nested tool call')
    const nestedToolUseId = (nested.data as { toolUseId?: string }).toolUseId
    expect(
      (await h.log.scan({ type: 'tool/result', limit: 10 })).filter(
        (row) => (row.data as { toolUseId?: string }).toolUseId === nestedToolUseId,
      ),
    ).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          content: [expect.objectContaining({ text: 'E_DEPTH_EXCEEDED' })],
        }),
      }),
    ])
    const nestedIntent = (await h.log.scan({ type: 'effect/intent', limit: 20 })).find(
      (row) => (row.data as { tool?: { toolUseId?: string } }).tool?.toolUseId === nestedToolUseId,
    )
    expect(nestedIntent?.data).not.toHaveProperty('parentEffectId')
  })

  it('closes a persisted nested call as not-started before replaying its safe parent after a crash', async () => {
    let hookEntered!: () => void
    let releaseHook!: () => void
    const entered = new Promise<void>((resolve) => {
      hookEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseHook = resolve
    })
    const childExecute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'read' }] }))
    const r = new ToolRegistry()
    r.add(readTool(childExecute), { source: 's', trust: 'builtin' })
    r.add(
      {
        name: 'run_code',
        description: 'x',
        parameters: Type.Object({}),
        meta: { ...meta, isReadOnly: true, isConcurrencySafe: true, replay: 'safe' },
        execute: async (
          _args: unknown,
          ctx: { tools: { invoke(name: string, args: unknown): Promise<unknown> } },
        ) => {
          await ctx.tools.invoke('read', {})
          return { content: [{ type: 'text', text: 'parent complete' }] }
        },
      } as never,
      { source: 's', trust: 'builtin' },
    )
    const original = await openSession({
      provider: fakeProvider([toolTurn('run_code', {})]),
      registry: r,
      preset: { ...presetDefaults(), disclosure: 'code' },
    })
    const pass = original.session.hooks.toolCall
    original.session.hooks = {
      ...original.session.hooks,
      toolCall: async (payload) => {
        if (payload.name === 'read') {
          hookEntered()
          await gate
        }
        return pass(payload)
      },
    }
    await original.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await original.session.acceptInput()
    await original.session.runInference()
    const running = original.session.runToolsPhase()
    await entered
    const crashPrefix = await original.log.scan({ fromSeq: 1, toSeq: original.log.lastSeq, limit: 10_000 })
    const oldNested = crashPrefix.find(
      (row) => row.type === 'tool/call' && (row.data as { depth?: number }).depth === 1,
    )
    expect(oldNested).toBeDefined()
    if (!oldNested) throw new Error('missing old nested call')
    const oldNestedToolUseId = (oldNested.data as { toolUseId?: string }).toolUseId
    expect(
      crashPrefix.some(
        (row) =>
          row.type === 'effect/intent' &&
          (row.data as { parentEffectId?: string }).parentEffectId !== undefined,
      ),
    ).toBe(false)

    const reopened = await openSession({
      provider: fakeProvider([]),
      registry: r,
      storage: MemoryStorage.fromEvents('k', crashPrefix, {
        opCells: original.opCellsBefore((crashPrefix.at(-1)?.seq ?? 0) + 1),
      }),
      writerRunId: 'nested-reopen',
      preset: { ...presetDefaults(), disclosure: 'code' },
    })
    try {
      expect(await reopened.session.resume()).toMatchObject({ actions: [{ action: 'rerun' }] })
      expect(await reopened.session.runToolsPhase()).toEqual({ phase: 'checkpoint' })
      expect(childExecute).toHaveBeenCalledTimes(1)
      const results = await reopened.log.scan({ type: 'tool/result', limit: 20 })
      expect(
        results.find((row) => (row.data as { toolUseId?: string }).toolUseId === oldNestedToolUseId)?.data,
      ).toMatchObject({ code: 'TOOL_NOT_STARTED' })
    } finally {
      await reopened.session.close()
      releaseHook()
      await running
      await original.session.close()
    }
  })

  it('recursively closes a depth-2 call persisted before its child effect intent', async () => {
    let hookEntered!: () => void
    let releaseHook!: () => void
    const entered = new Promise<void>((resolve) => {
      hookEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseHook = resolve
    })
    const leafExecute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'leaf' }] }))
    const r = new ToolRegistry()
    r.add(readTool(leafExecute), { source: 's', trust: 'builtin' })
    r.add(
      {
        name: 'middle',
        description: 'x',
        parameters: Type.Object({}),
        meta: { ...meta, isReadOnly: true, isConcurrencySafe: true, replay: 'safe' },
        execute: async (
          _args: unknown,
          ctx: { tools: { invoke(name: string, args: unknown): Promise<unknown> } },
        ) => {
          await ctx.tools.invoke('read', {})
          return { content: [{ type: 'text', text: 'middle complete' }] }
        },
      } as never,
      { source: 's', trust: 'builtin' },
    )
    r.add(
      {
        name: 'run_code',
        description: 'x',
        parameters: Type.Object({}),
        meta: { ...meta, isReadOnly: true, isConcurrencySafe: true, replay: 'safe' },
        execute: async (
          _args: unknown,
          ctx: { tools: { invoke(name: string, args: unknown): Promise<unknown> } },
        ) => {
          await ctx.tools.invoke('middle', {})
          return { content: [{ type: 'text', text: 'parent complete' }] }
        },
      } as never,
      { source: 's', trust: 'builtin' },
    )
    const original = await openSession({
      provider: fakeProvider([toolTurn('run_code', {})]),
      registry: r,
      preset: { ...presetDefaults(), disclosure: 'code', depthLimit: 2 },
    })
    const pass = original.session.hooks.toolCall
    original.session.hooks = {
      ...original.session.hooks,
      toolCall: async (payload) => {
        if (payload.name === 'read') {
          hookEntered()
          await gate
        }
        return pass(payload)
      },
    }
    await original.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await original.session.acceptInput()
    await original.session.runInference()
    const running = original.session.runToolsPhase()
    await entered
    const crashPrefix = await original.log.scan({ fromSeq: 1, toSeq: original.log.lastSeq, limit: 10_000 })
    const leafCall = crashPrefix.find(
      (row) => row.type === 'tool/call' && (row.data as { depth?: number }).depth === 2,
    )
    expect(leafCall).toBeDefined()
    if (!leafCall) throw new Error('missing depth-2 call')
    const leafToolUseId = (leafCall.data as { toolUseId: string }).toolUseId
    expect(
      crashPrefix.filter(
        (row) => row.type === 'effect/intent' && (row.data as { kind?: string }).kind === 'tool',
      ),
    ).toHaveLength(2)

    const reopened = await openSession({
      provider: fakeProvider([]),
      registry: r,
      storage: MemoryStorage.fromEvents('k', crashPrefix, {
        opCells: original.opCellsBefore((crashPrefix.at(-1)?.seq ?? 0) + 1),
      }),
      writerRunId: 'depth-2-reopen',
      preset: { ...presetDefaults(), disclosure: 'code', depthLimit: 2 },
    })
    try {
      expect(await reopened.session.resume()).toMatchObject({ actions: [{ action: 'unknown' }] })
      expect(leafExecute).not.toHaveBeenCalled()
      expect(
        (await reopened.log.scan({ type: 'tool/result', limit: 20 })).find(
          (row) => (row.data as { toolUseId?: string }).toolUseId === leafToolUseId,
        )?.data,
      ).toMatchObject({ code: 'TOOL_NOT_STARTED' })
      const resumedOp = reopened.session.op()
      expect(resumedOp?.phase).toMatchObject({ kind: 'tools' })
      if (resumedOp?.phase.kind !== 'tools') throw new Error('missing resumed tools phase')
      expect(resumedOp.phase.batch.calls.find((call) => call.toolUseId === leafToolUseId)?.status).toBe(
        'completed',
      )
    } finally {
      await reopened.session.close()
      releaseHook()
      await running
      await original.session.close()
    }
  })

  it('finds a depth-2 approval call through an already-settled intermediate effect', async () => {
    let rootHookEntered!: () => void
    let releaseRootHook!: () => void
    const entered = new Promise<void>((resolve) => {
      rootHookEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseRootHook = resolve
    })
    const r = new ToolRegistry()
    r.add(shellTool(), { source: 's', trust: 'builtin' })
    r.add(
      {
        name: 'middle',
        description: 'x',
        parameters: Type.Object({}),
        meta: { ...meta, isReadOnly: true, isConcurrencySafe: true, replay: 'safe' },
        execute: async (
          _args: unknown,
          ctx: { tools: { invoke(name: string, args: unknown): Promise<unknown> } },
        ) => {
          await ctx.tools.invoke('shell', { command: 'click' })
          return { content: [{ type: 'text', text: 'middle complete' }] }
        },
      } as never,
      { source: 's', trust: 'builtin' },
    )
    r.add(
      {
        name: 'run_code',
        description: 'x',
        parameters: Type.Object({}),
        meta: { ...meta, isReadOnly: true, isConcurrencySafe: true, replay: 'safe' },
        execute: async (
          _args: unknown,
          ctx: { tools: { invoke(name: string, args: unknown): Promise<unknown> } },
        ) => {
          await ctx.tools.invoke('middle', {})
          return { content: [{ type: 'text', text: 'parent complete' }] }
        },
      } as never,
      { source: 's', trust: 'builtin' },
    )
    const seams = fakeSeams({
      approval: {
        ask: async () => ({ ticket: 'depth-2-ticket', expiresAt: '2999-01-01T00:00:00.000Z' }),
        resume: async () => null,
      },
    })
    const original = await openSession({
      provider: fakeProvider([toolTurn('run_code', {})]),
      registry: r,
      seams,
      preset: { ...presetDefaults(), disclosure: 'code', depthLimit: 2 },
    })
    const pass = original.session.hooks.toolResult
    original.session.hooks = {
      ...original.session.hooks,
      toolResult: async (payload) => {
        if (payload.name === 'run_code') {
          rootHookEntered()
          await gate
        }
        return pass ? pass(payload) : {}
      },
    }
    await original.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await original.session.acceptInput()
    await original.session.runInference()
    const running = original.session.runToolsPhase()
    await entered
    const crashPrefix = await original.log.scan({ fromSeq: 1, toSeq: original.log.lastSeq, limit: 10_000 })
    const shellCall = crashPrefix.find(
      (row) => row.type === 'tool/call' && (row.data as { depth?: number }).depth === 2,
    )
    const middleCall = crashPrefix.find(
      (row) => row.type === 'tool/call' && (row.data as { depth?: number }).depth === 1,
    )
    expect(shellCall).toBeDefined()
    expect(original.session.pendingEffects()).toHaveLength(1)
    if (!shellCall || !middleCall) throw new Error('missing nested calls')
    const shellToolUseId = (shellCall.data as { toolUseId: string }).toolUseId
    const middleToolUseId = (middleCall.data as { toolUseId: string }).toolUseId
    const crashState = original.opCellsBefore((crashPrefix.at(-1)?.seq ?? 0) + 1)[0]?.data as
      | {
          phase?: {
            kind?: string
            batch?: { calls?: Array<{ toolUseId?: string; effectId?: string }> }
          }
        }
      | undefined
    expect(crashState?.phase?.batch?.calls?.find((call) => call.toolUseId === middleToolUseId)).toMatchObject(
      { effectId: expect.any(String) },
    )

    const reopened = await openSession({
      provider: fakeProvider([]),
      registry: r,
      storage: MemoryStorage.fromEvents('k', crashPrefix, {
        opCells: original.opCellsBefore((crashPrefix.at(-1)?.seq ?? 0) + 1),
      }),
      writerRunId: 'depth-2-approval-reopen',
      preset: { ...presetDefaults(), disclosure: 'code', depthLimit: 2 },
    })
    try {
      expect(await reopened.session.resume()).toMatchObject({ actions: [{ action: 'rerun' }] })
      expect(
        (await reopened.log.scan({ type: 'tool/result', limit: 20 })).find(
          (row) => (row.data as { toolUseId?: string }).toolUseId === shellToolUseId,
        )?.data,
      ).toMatchObject({ code: 'TOOL_NOT_STARTED' })
      const resumedOp = reopened.session.op()
      if (resumedOp?.phase.kind !== 'tools') throw new Error('missing resumed tools phase')
      expect(
        resumedOp.phase.batch.calls
          .filter((call) => call.toolUseId === shellToolUseId || call.toolUseId === middleToolUseId)
          .map((call) => call.status),
      ).toEqual(['completed', 'completed'])
    } finally {
      await reopened.session.close()
      releaseRootHook()
      await running
      await original.session.close()
    }
  })

  it('depth beyond preset.depthLimit is a catchable error inside the tool', async () => {
    const r = new ToolRegistry()
    r.add(
      {
        name: 'deep',
        description: 'x',
        parameters: Type.Object({}),
        meta,
        execute: async (_a: unknown, ctx: { tools: { invoke(n: string, a: unknown): Promise<unknown> } }) => {
          try {
            await ctx.tools.invoke('deep', {})
            return { content: [{ type: 'text', text: 'no' }] }
          } catch (e) {
            return { content: [{ type: 'text', text: String((e as { code?: string }).code) }] }
          }
        },
      } as never,
      { source: 's', trust: 'builtin' },
    )
    const { session, log } = await openSession({
      provider: fakeProvider([toolTurn('deep', {}), textTurn('ok')]),
      registry: r,
      preset: { ...presetDefaults(), depthLimit: 1 },
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const rows = await log.scan({ type: 'tool/result', limit: 10 })
    const texts = rows.map((e) => (e.data as { content: Array<{ text: string }> }).content[0]?.text)
    expect(texts).toContain('E_DEPTH_EXCEEDED')
  })

  it('before-inference and after-core operations run in slot order and their effects land', async () => {
    const seen: string[] = []
    const mk = (name: string, slot: SlotOperation['slot'], order: number): Operation => ({
      name,
      slot,
      order,
      replay: 'safe',
      applicable: async () => 'applied',
      run: async () => {
        seen.push(name)
        return {
          effects: [{ type: `x/agnes/${name}/ran`, origin: 'system', trust: 'trusted', actor, data: {} }],
        }
      },
    })
    const { session, log } = await openSession({
      provider: fakeProvider([textTurn('ok')]),
      operations: [
        mk('b2', 'before-inference', 2),
        mk('a1', 'after-core', 1),
        mk('b1', 'before-inference', 1),
      ],
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(seen).toEqual(['b1', 'b2', 'a1'])
    expect(await log.scan({ type: 'x/agnes/a1/ran', limit: 5 })).toHaveLength(1)
  })

  it('setPreset records a switch and applies on the next request', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([textTurn('ok')]) })
    await session.setPreset({ ...presetDefaults(), name: 'code', disclosure: 'code' })
    expect(session.preset.name).toBe('code')
    expect((await log.scan({ type: 'x/core/preset-switch', limit: 5 }))[0]?.data).toEqual({
      from: 'standard',
      to: 'code',
    })
  })
})

const modelRecord = (route: string, id: string): ModelRecord => ({
  id,
  name: id,
  api: 'openai-completions',
  route,
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})

describe('setModel', () => {
  it('switches the resolved route/model for a slot and the next request uses it', async () => {
    const provider = fakeProvider([textTurn('a'), textTurn('b')])
    Object.assign(provider, {
      models: () => [modelRecord('default', 'model-a'), modelRecord('escalation-route', 'model-b')],
    })
    const { session } = await openSession({ provider })
    const seq = await session.setModel({ slot: 'primary', route: 'escalation-route', model: 'model-b' })
    expect(seq).toBeGreaterThan(0)
    expect(session.preset.model.route.primary).toBe('escalation-route')
    expect(session.preset.model.id.primary).toBe('model-b')
  })

  it('records the switch as an ignorable audit event, the same family as setPreset', async () => {
    const provider = fakeProvider([textTurn('a')])
    Object.assign(provider, { models: () => [modelRecord('r', 'm')] })
    const { session, log } = await openSession({ provider })
    await session.setModel({ slot: 'primary', route: 'r', model: 'm' })
    const rows = await log.scan({ type: 'x/core/model-switch', limit: 5 })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.data).toEqual({
      slot: 'primary',
      from: { route: 'default', model: null },
      to: { route: 'r', model: 'm' },
    })
  })

  it('refuses a route/model pair the provider does not publish, and changes nothing', async () => {
    const provider = fakeProvider([textTurn('a')])
    Object.assign(provider, { models: () => [modelRecord('r', 'm')] })
    const { session, log } = await openSession({ provider })
    await expect(session.setModel({ slot: 'primary', route: 'r', model: 'ghost' })).rejects.toMatchObject({
      code: 'E_MODEL_UNKNOWN',
    })
    expect(session.preset.model.id.primary).toBeUndefined()
    expect(await log.scan({ type: 'x/core/model-switch', limit: 5 })).toHaveLength(0)
  })

  it('an optional thinking level is written into the same slot and the same audit event', async () => {
    const provider = fakeProvider([textTurn('a')])
    Object.assign(provider, {
      models: () => [{ ...modelRecord('r', 'm'), reasoning: true, thinkingLevelMap: { high: 'high' } }],
    })
    const { session, log } = await openSession({ provider })
    await session.setModel({ slot: 'primary', route: 'r', model: 'm', thinking: 'high' })
    expect(session.preset.model.thinking.primary).toBe('high')
    const rows = await log.scan({ type: 'x/core/model-switch', limit: 5 })
    expect(rows[0]?.data).toEqual({
      slot: 'primary',
      from: { route: 'default', model: null },
      to: { route: 'r', model: 'm', thinking: 'high' },
    })
  })

  it('omitting thinking leaves the slot at whatever level it already had', async () => {
    const provider = fakeProvider([textTurn('a'), textTurn('b')])
    Object.assign(provider, {
      models: () => [{ ...modelRecord('r', 'm'), reasoning: true, thinkingLevelMap: { high: 'high' } }],
    })
    const { session } = await openSession({ provider })
    await session.setModel({ slot: 'primary', route: 'r', model: 'm', thinking: 'high' })
    await session.setModel({ slot: 'primary', route: 'r', model: 'm' })
    expect(session.preset.model.thinking.primary).toBe('high')
  })

  it('switching to a non-reasoning model clears a carried-forward thinking level instead of keeping it', async () => {
    // Round 1's fix (`sel.thinking ?? priorThinking`) carried a slot's prior thinking level forward
    // unconditionally, with no check against the NEW model being switched to. This is the exact
    // sequence that regression let through: set thinking on a reasoning model, then switch the same
    // slot to a model that doesn't support thinking at all, omitting `thinking` on that second call.
    const provider = fakeProvider([textTurn('a'), textTurn('b')])
    Object.assign(provider, {
      models: () => [
        { ...modelRecord('r', 'reasoner'), reasoning: true, thinkingLevelMap: { high: 'high' } },
        modelRecord('gw', 'plain'),
      ],
    })
    const { session } = await openSession({ provider })
    await session.setModel({ slot: 'primary', route: 'r', model: 'reasoner', thinking: 'high' })
    expect(session.preset.model.thinking.primary).toBe('high')
    await session.setModel({ slot: 'primary', route: 'gw', model: 'plain' })
    expect(session.preset.model.thinking.primary).toBeUndefined()
  })

  it('a static preset-declared thinking level (never set via setModel) is cleared when the switch lands on an incompatible model', async () => {
    // Round 1's regression test above ('switching to a non-reasoning model clears...') only proves
    // the clamp for a value setModel itself just wrote. This proves it for a value that was baked
    // into the preset passed to openSession — slot 'primary' carries 'medium' from presetDefaults()
    // itself, no prior setModel call ever touched it.
    const provider = fakeProvider([textTurn('a')])
    Object.assign(provider, { models: () => [modelRecord('gw', 'plain')] })
    const { session } = await openSession({
      provider,
      preset: { ...presetDefaults(), model: { ...presetDefaults().model, thinking: { primary: 'medium' } } },
    })
    expect(session.preset.model.thinking.primary).toBe('medium')
    await session.setModel({ slot: 'primary', route: 'gw', model: 'plain' })
    expect(session.preset.model.thinking.primary).toBeUndefined()
  })

  it('a static preset-declared thinking level is preserved when the switch lands on a model whose thinkingLevelMap still honors it', async () => {
    const provider = fakeProvider([textTurn('a')])
    Object.assign(provider, {
      models: () => [
        { ...modelRecord('r', 'reasoner'), reasoning: true, thinkingLevelMap: { medium: 'medium' } },
      ],
    })
    const { session } = await openSession({
      provider,
      preset: { ...presetDefaults(), model: { ...presetDefaults().model, thinking: { primary: 'medium' } } },
    })
    expect(session.preset.model.thinking.primary).toBe('medium')
    await session.setModel({ slot: 'primary', route: 'r', model: 'reasoner' })
    expect(session.preset.model.thinking.primary).toBe('medium')
  })

  it('refuses a thinking level the target model does not support, and changes nothing', async () => {
    const provider = fakeProvider([textTurn('a')])
    Object.assign(provider, { models: () => [{ ...modelRecord('r', 'm'), reasoning: false }] })
    const { session, log } = await openSession({ provider })
    await expect(
      session.setModel({ slot: 'primary', route: 'r', model: 'm', thinking: 'high' }),
    ).rejects.toMatchObject({ code: 'E_MODEL_UNKNOWN' })
    expect(session.preset.model.id.primary).toBeUndefined()
    expect(await log.scan({ type: 'x/core/model-switch', limit: 5 })).toHaveLength(0)
  })

  it("refuses a thinking level absent from the model's declared thinkingLevelMap", async () => {
    const provider = fakeProvider([textTurn('a')])
    Object.assign(provider, {
      models: () => [{ ...modelRecord('r', 'm'), reasoning: true, thinkingLevelMap: { low: 'low' } }],
    })
    const { session } = await openSession({ provider })
    await expect(
      session.setModel({ slot: 'primary', route: 'r', model: 'm', thinking: 'high' }),
    ).rejects.toMatchObject({ code: 'E_MODEL_UNKNOWN' })
  })

  it('a storage failure while committing the switch leaves s.preset exactly as it was', async () => {
    // Binding each method explicitly, the same way test/session-log.test.ts's local `wrap` helper
    // does — a plain object spread over a MemoryStorage instance copies none of its prototype
    // methods and silently produces a StorageAdapter missing open/scan/renew/etc.
    //
    // The failure has to be switched on after `openSession` (which itself commits a `session/start`
    // row), not from the first commit: the fault this test is about is specific to the switch's own
    // append, not to every write this session ever makes.
    const storage = new MemoryStorage()
    let fail = false
    const broken: StorageAdapter = {
      open: storage.open.bind(storage),
      commit: async (k, tx) => {
        if (fail) throw new Error('disk full')
        return storage.commit(k, tx)
      },
      renew: storage.renew.bind(storage),
      release: storage.release.bind(storage),
      scan: storage.scan.bind(storage),
      scanIntegrity: storage.scanIntegrity.bind(storage),
      registers: storage.registers.bind(storage),
      createChild: storage.createChild.bind(storage),
      close: storage.close.bind(storage),
    }
    const provider = fakeProvider([textTurn('a')])
    Object.assign(provider, { models: () => [modelRecord('r', 'm')] })
    const { session } = await openSession({ provider, storage: broken as never })
    fail = true
    const before = session.preset.model.id.primary
    await expect(session.setModel({ slot: 'primary', route: 'r', model: 'm' })).rejects.toThrow(/disk full/)
    expect(session.preset.model.id.primary).toBe(before)
  })

  it('two concurrent setModel calls for different slots both land — proving serialization, not just sequential calls', async () => {
    // This is the test R1 explicitly asks for ("并发调用按提交序列线性化，测试不能只覆盖顺序调用"):
    // without s.locked() serializing the whole read-spread-write body across the await on
    // s.d.log.append, both calls would read the same pre-switch s.preset, compute their spread from
    // that same stale snapshot, and whichever assignment lands last would silently erase the other
    // slot's update — a classic read-modify-write race, not merely two calls racing to finish.
    const provider = fakeProvider([textTurn('a'), textTurn('b')])
    Object.assign(provider, { models: () => [modelRecord('r', 'm1'), modelRecord('r', 'm2')] })
    const { session, log } = await openSession({ provider })
    await Promise.all([
      session.setModel({ slot: 'primary', route: 'r', model: 'm1' }),
      session.setModel({ slot: 'escalation', route: 'r', model: 'm2' }),
    ])
    expect(session.preset.model.id.primary).toBe('m1')
    expect(session.preset.model.id.escalation).toBe('m2')
    expect(await log.scan({ type: 'x/core/model-switch', limit: 5 })).toHaveLength(2)
  })

  it('a setPreset racing a setModel still lands both, in whichever order they actually committed', async () => {
    const provider = fakeProvider([textTurn('a'), textTurn('b')])
    Object.assign(provider, { models: () => [modelRecord('r', 'm')] })
    const { session, log } = await openSession({ provider })
    await Promise.all([
      session.setPreset({ ...presetDefaults(), name: 'code' }),
      session.setModel({ slot: 'primary', route: 'r', model: 'm' }),
    ])
    // setPreset replaces the whole view, so if it had landed after setModel without reading setModel's
    // already-committed change, it would silently revert the model override to presetDefaults()'s own
    // (unset) primary slot. Asserting both survived, regardless of which committed first, is what
    // "survives commit-order linearization" actually means here — not asserting one specific order.
    expect(session.preset.name).toBe('code')
    expect(session.preset.model.id.primary).toBe('m')
    expect(await log.scan({ type: 'x/core/preset-switch', limit: 5 })).toHaveLength(1)
    expect(await log.scan({ type: 'x/core/model-switch', limit: 5 })).toHaveLength(1)
  })
})

describe('setYolo', () => {
  const operator = { ...actor, id: 'authenticated-operator' }

  it('flips the in-memory flag and records the switch as an ignorable audit event', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([textTurn('ok')]) })
    expect(session.yolo).toBe(false)
    const seq = await session.setYolo(true, operator)
    expect(seq).toBeGreaterThan(0)
    expect(session.yolo).toBe(true)
    expect((await log.scan({ type: 'x/core/yolo-switch', limit: 5 }))[0]).toMatchObject({
      actor: operator,
      origin: 'system',
      trust: 'trusted',
      lane: 'main',
      data: {
        version: 1,
        to: true,
        operatorId: operator.id,
        sessionKey: 'k',
        lane: 'main',
        profileHash: null,
        sessionOwner: { id: actor.id, org: actor.org },
      },
    })
  })

  it('can be turned back off, recording a second switch', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([textTurn('ok')]) })
    await session.setYolo(true, operator)
    await session.setYolo(false, operator)
    expect(session.yolo).toBe(false)
    expect(await log.scan({ type: 'x/core/yolo-switch', limit: 5 })).toHaveLength(2)
  })

  it('restores only the latest switch for the same session owner and profile metadata', async () => {
    const original = await openSession({
      provider: fakeProvider([textTurn('ok')]),
      resolvedProfileHash: 'sha256-profile',
    })
    await original.session.setYolo(true, operator)
    const events = await original.log.scan({ fromSeq: 1, limit: 100 })
    await original.session.close()

    const reopened = await openSession({
      provider: fakeProvider([textTurn('ok')]),
      storage: MemoryStorage.fromEvents('k', events),
      writerRunId: 'yolo-reopen',
      resolvedProfileHash: 'sha256-profile',
    })
    expect(reopened.session.yolo).toBe(true)
    await reopened.session.close()
  })

  it('fails closed when the authenticated session owner changes', async () => {
    const original = await openSession({ provider: fakeProvider([textTurn('ok')]) })
    await original.session.setYolo(true, operator)
    const events = await original.log.scan({ fromSeq: 1, limit: 100 })
    await original.session.close()

    const reopened = await openSession({
      provider: fakeProvider([textTurn('ok')]),
      storage: MemoryStorage.fromEvents('k', events),
      writerRunId: 'foreign-owner-reopen',
      actor: { ...actor, id: 'different-session-owner' },
    })
    expect(reopened.session.yolo).toBe(false)
    await reopened.session.close()
  })

  it('fails closed when the resolved profile changes', async () => {
    const original = await openSession({
      provider: fakeProvider([textTurn('ok')]),
      resolvedProfileHash: 'sha256-profile-a',
    })
    await original.session.setYolo(true, operator)
    const events = await original.log.scan({ fromSeq: 1, limit: 100 })
    await original.session.close()

    const reopened = await openSession({
      provider: fakeProvider([textTurn('ok')]),
      storage: MemoryStorage.fromEvents('k', events),
      writerRunId: 'changed-profile-reopen',
      resolvedProfileHash: 'sha256-profile-b',
    })
    expect(reopened.session.yolo).toBe(false)
    await reopened.session.close()
  })

  it('rejects a hostile operator without invoking accessors or appending a grant', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([textTurn('ok')]) })
    const getter = vi.fn(() => 'forged')
    const hostile = Object.defineProperty({}, 'id', { enumerable: true, get: getter })
    await expect(session.setYolo(true, hostile as never)).rejects.toMatchObject({ code: 'E_ENVELOPE' })
    expect(getter).not.toHaveBeenCalled()
    expect(session.yolo).toBe(false)
    expect(await log.scan({ type: 'x/core/yolo-switch', limit: 5 })).toEqual([])
  })

  it('rejects a non-boolean direct call instead of coercing it into a bypass', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([textTurn('ok')]) })
    await expect(session.setYolo('false' as never, operator)).rejects.toMatchObject({ code: 'E_ENVELOPE' })
    expect(session.yolo).toBe(false)
    expect(await log.scan({ type: 'x/core/yolo-switch', limit: 5 })).toEqual([])
  })

  it.each([
    ['legacy', { to: true }, 'main'],
    [
      'corrupt metadata',
      {
        version: 1,
        to: true,
        operatorId: operator.id,
        sessionKey: 'different-session',
        lane: 'main',
        profileHash: null,
        sessionOwner: { id: actor.id, org: actor.org },
      },
      'main',
    ],
    [
      'other-lane',
      {
        version: 1,
        to: true,
        operatorId: operator.id,
        sessionKey: 'k',
        lane: 'side',
        profileHash: null,
        sessionOwner: { id: actor.id, org: actor.org },
      },
      'side',
    ],
  ])(
    'fails closed for a latest %s switch instead of falling back to an older grant',
    async (_name, data, lane) => {
      const original = await openSession({ provider: fakeProvider([textTurn('ok')]) })
      await original.session.setYolo(true, operator)
      await original.log.append([
        {
          type: 'x/core/yolo-switch',
          origin: 'system',
          trust: 'trusted',
          actor: operator,
          lane,
          data,
          ignorable: true,
        },
      ])
      const events = await original.log.scan({ fromSeq: 1, limit: 100 })
      await original.session.close()

      const reopened = await openSession({
        provider: fakeProvider([textTurn('ok')]),
        storage: MemoryStorage.fromEvents('k', events),
        writerRunId: `invalid-yolo-${_name}`,
      })
      expect(reopened.session.yolo).toBe(false)
      await reopened.session.close()
    },
  )
})
