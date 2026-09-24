import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ModelRecord } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { requireChildControl } from '../src/child/store.js'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { mintFrom } from '../src/request/mint.js'
import { toProviderRequest } from '../src/request/to-provider.js'
import { presetDefaults } from '../src/step/preset.js'
import { CoreError } from '../src/types.js'
import { fakeProvider, sent, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, shellTool, testFsOps, testWorkspaceInvocation } from './helpers/open-session.js'

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const model = (): ModelRecord => ({
  id: 'm1',
  name: 'm1',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})

function kernel(over: Partial<Parameters<typeof Kernel.create>[0]> = {}) {
  const provider = fakeProvider([textTurn('root'), textTurn('child')])
  Object.assign(provider, { models: () => [model()] })
  return Kernel.create({
    storage: new MemoryStorage(),
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits: 10, generationLimit: 2, maxFanOut: 4 },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => 1_757_203_200_000,
    ...over,
  })
}

const sessionOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' }

describe('tree budget on the live inference path', () => {
  it('binds the catalogue maxTokens into the permit and refuses a second 8-of-10 spend', async () => {
    const storage = new MemoryStorage()
    const expensiveTool = [
      sent(),
      {
        type: 'toolcall_end' as const,
        call: { toolUseId: '', name: 'delegate', args: {}, ordinal: 0 },
        via: 'native' as const,
      },
      {
        type: 'usage' as const,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        credits: 8,
        creditSource: 'estimated' as const,
      },
      { type: 'done' as const, reason: 'toolUse' as const },
    ]
    const provider = fakeProvider([expensiveTool, textTurn('after')])
    Object.assign(provider, { models: () => [model()] })
    const seams = fakeSeams({
      ledger: { projected: async () => ({ credits: 8, creditSource: 'estimated' }) },
    })
    const k = kernel({
      storage,
      provider,
      seams,
    })
    let childError: unknown
    const box: { parent?: Awaited<ReturnType<Kernel['session']>> } = {}
    k.tools.add(
      {
        name: 'delegate',
        description: 'delegate',
        parameters: Type.Object({}),
        meta: {
          isReadOnly: false,
          isDestructive: false,
          isConcurrencySafe: true,
          isOpenWorld: true,
          replay: 'never',
          costHint: undefined,
          deferLoading: undefined,
          requiresApproval: undefined,
        },
        execute: async () => {
          const parent = box.parent
          if (!parent) return { content: [{ type: 'text', text: 'missing parent' }], isError: true }
          const child = await parent.d.children.create({
            parent: parent.key,
            cwd: '/w',
            input: 'more',
          })
          await child.run('more').catch((error: unknown) => {
            childError = error
          })
          return { content: [{ type: 'text', text: 'delegated' }] }
        },
      } as never,
      { source: 't', trust: 'builtin' },
    )
    const parent = await k.session('parent', {
      ...sessionOpts,
      workspaceInvocation: testWorkspaceInvocation(testFsOps(), seams),
    })
    box.parent = parent
    await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await parent.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(provider.requests.some((req) => req.sampling?.maxTokens === 128)).toBe(true)
    expect(childError).toBeInstanceOf(CoreError)
    await k.close()
  })

  it('shares reserveTreeBudget with compaction', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/step/compaction.ts', import.meta.url)), 'utf8')
    expect(src.includes('reserveTreeBudget(')).toBe(true)
  })

  it('maps maxTokens onto the provider wire body', () => {
    const wire = toProviderRequest(
      mintFrom({
        kind: 'turn',
        model: { slot: 'primary', route: 'default', model: 'm1' },
        contractId: null,
        sections: [{ id: 's', order: 0, text: 'hi', source: 'test' }],
        messages: [{ role: 'user', seq: 1 as never, content: [{ type: 'text', text: 'q' }] }],
        tools: [],
        nonce: '0123456789abcdef0123456789abcdef',
        maxTokens: 128,
      }),
      { sessionKey: 'k', derivedHash: 'a'.repeat(64) },
    )
    expect(wire.sampling?.maxTokens).toBe(128)
  })
})

describe('reservation crash windows', () => {
  it('recovers an identical reservation identity without double holding and rejects rebinding', async () => {
    const storage = new MemoryStorage()
    await storage.ensureRootScope('root', 10_000_000n)
    const request = {
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 2_000_000n,
      effectId: 'effect-idempotent',
      requestHash: 'a'.repeat(64),
      writerGeneration: 1,
    }
    const [first, concurrent] = await Promise.all([storage.reserve(request), storage.reserve(request)])
    const sequential = await storage.reserve(request)
    expect(first).toMatchObject({ ok: true, existing: false, status: 'held' })
    expect(concurrent).toMatchObject({ ok: true, existing: true, status: 'held' })
    expect(sequential).toMatchObject({ ok: true, existing: true, status: 'held' })
    if (!first.ok || !concurrent.ok || !sequential.ok) return
    expect(concurrent.permitId).toBe(first.permitId)
    expect(sequential.permitId).toBe(first.permitId)
    expect((await storage.projectTree('root'))?.heldMicro).toBe(2_000_000n)
    await expect(
      storage.lookupReservationByIdentity('root', request.effectId, request.requestHash),
    ).resolves.toMatchObject({ permitId: first.permitId, status: 'held' })

    for (const conflict of [
      { ...request, requestHash: 'b'.repeat(64) },
      { ...request, qMicro: 3_000_000n },
      { ...request, scopeIds: ['root:other'] },
      { ...request, writerGeneration: 2 },
    ])
      await expect(storage.reserve(conflict)).resolves.toMatchObject({ ok: false, reason: 'invalid' })

    await storage.settleOrigin({
      permitId: first.permitId,
      originSessionKey: 's',
      originCostSeq: 1,
      actualMicro: null,
      complete: false,
      creditSource: 'unknown',
    })
    await expect(storage.reserve(request)).resolves.toMatchObject({
      ok: true,
      existing: true,
      status: 'unknown',
      permitId: first.permitId,
    })
  })

  it('releases an unused hold and keeps unknown spend from freeing the cap', async () => {
    const storage = new MemoryStorage()
    await storage.ensureRootScope('root', 10_000_000n)
    const first = await storage.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 8_000_000n,
      effectId: 'a',
      requestHash: 'default/m1/128',
      writerGeneration: 1,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await storage.releaseReservation(first.permitId)
    const again = await storage.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 8_000_000n,
      effectId: 'b',
      requestHash: 'default/m1/128',
      writerGeneration: 1,
    })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    await storage.settleOrigin({
      permitId: again.permitId,
      originSessionKey: 's',
      originCostSeq: 9,
      actualMicro: null,
      complete: false,
      creditSource: 'unknown',
    })
    const blocked = await storage.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 3_000_000n,
      effectId: 'c',
      requestHash: 'default/m1/128',
      writerGeneration: 1,
    })
    expect(blocked).toMatchObject({ ok: false, reason: 'cap' })
    expect((await storage.projectTree('root'))?.unknownHeld).toBe(true)
    await expect(
      storage.settleOrigin({
        permitId: again.permitId,
        originSessionKey: 's',
        originCostSeq: 9,
        actualMicro: 1_000_000n,
        complete: true,
        creditSource: 'estimated',
      }),
    ).rejects.toThrow('cost origin conflicts')
  })

  it('rejects a stale writer generation', async () => {
    const storage = new MemoryStorage()
    await storage.ensureRootScope('root', 10_000_000n)
    await storage.bumpWriterGeneration('root')
    await storage.bumpWriterGeneration('root')
    const stale = await storage.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 1n,
      effectId: 'old',
      requestHash: 'h',
      writerGeneration: 1,
    })
    expect(stale).toMatchObject({ ok: false, reason: 'invalid' })
    const live = await storage.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 1n,
      effectId: 'new',
      requestHash: 'h',
      writerGeneration: 3,
    })
    expect(live.ok).toBe(true)
    await expect(
      storage.reserve({
        rootTaskId: 'root',
        scopeIds: ['root:root'],
        qMicro: 1n,
        effectId: 'future',
        requestHash: 'h',
        writerGeneration: 4,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('binds a cost origin to exactly one permit and leaves a colliding hold untouched', async () => {
    const storage = new MemoryStorage()
    await storage.ensureRootScope('root', 10_000_000n)
    const first = await storage.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 2_000_000n,
      effectId: 'first',
      requestHash: 'a'.repeat(64),
      writerGeneration: 1,
    })
    const second = await storage.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 3_000_000n,
      effectId: 'second',
      requestHash: 'b'.repeat(64),
      writerGeneration: 1,
    })
    if (!first.ok || !second.ok) throw new Error('expected reservations')
    const origin = { originSessionKey: 's', originCostSeq: 44 }
    await storage.settleOrigin({
      permitId: first.permitId,
      writerGeneration: 1,
      ...origin,
      actualMicro: 1_000_000n,
      complete: true,
      creditSource: 'estimated',
    })
    await expect(
      storage.settleOrigin({
        permitId: second.permitId,
        writerGeneration: 1,
        ...origin,
        actualMicro: 1_000_000n,
        complete: true,
        creditSource: 'estimated',
      }),
    ).rejects.toThrow('cost origin conflicts')
    await expect(storage.peekReservation(second.permitId)).resolves.toMatchObject({ status: 'held' })
    await expect(storage.projectTree('root')).resolves.toMatchObject({
      settledMicro: 1_000_000n,
      heldMicro: 3_000_000n,
    })
  })
})

describe('recovery descriptor and close reasons', () => {
  it('keeps the original cwd on the durable record and does not cancel spawn on dispose', async () => {
    const storage = new MemoryStorage()
    const k = kernel({ storage })
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.createWithKind?.('spawn', {
      parent: parent.key,
      cwd: '/child-cwd',
      input: 'async',
    })
    if (!child) throw new Error('expected spawn handle')
    expect((await storage.lookupByKey(child.key))?.cwd).toBe('/child-cwd')
    await child.close()
    expect((await storage.lookupByKey(child.key))?.state).toBe('recovery_pending')
    expect((await storage.lookupByKey(child.key))?.cwd).toBe('/child-cwd')
    await k.close()
  })

  it('explicit cancel marks the durable record cancelled', async () => {
    const storage = new MemoryStorage()
    const k = kernel({ storage })
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'x' })
    await child.cancel?.()
    expect((await storage.lookupByKey(child.key))?.state).toBe('cancelled')
    await k.close()
  })

  it('returns the same child for a repeated creationId and does not start a second run', async () => {
    const storage = new MemoryStorage()
    await storage.ensureRootScope('root', 10_000_000n)
    const input = {
      childKey: 'parent/c1',
      parentKey: 'parent',
      boundarySeq: 1 as const,
      creationId: 'parent:main:direct:1',
      kind: 'spawn' as const,
      rootTaskId: 'root',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 4,
      inputHash: 'abc',
      inputText: 'async',
      cwd: '/w',
      actorId: 'u',
      isolation: 'shared' as const,
      workspaceId: 'ws1',
      treeCapMicro: 10_000_000n,
      childCapMicro: null,
      writerRunId: 'w',
    }
    await storage.open('parent', { writerRunId: 'r1', ttlMs: 1000 })
    const first = await storage.createDelegatedChild(input)
    const second = await storage.createDelegatedChild({ ...input, childKey: 'parent/c2', workspaceId: 'ws2' })
    expect(first.status).toBe('created')
    expect(second.status).toBe('existing')
    if (second.status === 'existing') expect(second.record.childKey).toBe('parent/c1')
  })

  it('does not re-run a replay:never tool after abort', async () => {
    let runs = 0
    const k = kernel()
    k.tools.add(
      shellTool(async () => {
        runs += 1
        await new Promise(() => undefined)
        return { content: [{ type: 'text', text: 'never' }] }
      }),
      { source: 't', trust: 'builtin' },
    )
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'tool' })
    const running = child.run('tool')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await child.cancel?.()
    await running.catch(() => undefined)
    expect(runs).toBeLessThanOrEqual(1)
    await k.close()
  })
})

describe('old backend capability', () => {
  it('refuses a storage object without child control', () => {
    expect(() => requireChildControl({})).toThrow(CoreError)
  })
})

describe('parent close reasons and late approval', () => {
  it('does not cancel spawn on parent turn complete or parent close, and marks kernel close as recovery', async () => {
    const storage = new MemoryStorage()
    const k = kernel({ storage })
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.createWithKind?.('spawn', {
      parent: parent.key,
      cwd: '/w',
      input: 'async',
    })
    if (!child) throw new Error('expected spawn handle')
    await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await parent.run({ until: 'turn-end', signal: new AbortController().signal })
    expect((await storage.lookupByKey(child.key))?.state).toBe('ready')
    await parent.close()
    expect((await storage.lookupByKey(child.key))?.state).toBe('ready')
    await k.close()
    expect((await storage.lookupByKey(child.key))?.state).toBe('failed')
  })

  it('does not execute a tool when approval arrives after cancel', async () => {
    let allow: ((verdict: 'allowed-once') => void) | undefined
    let asked!: () => void
    const sawAsk = new Promise<void>((resolve) => {
      asked = resolve
    })
    let runs = 0
    const storage = new MemoryStorage()
    const provider = fakeProvider([toolTurn('shell', {})])
    Object.assign(provider, { models: () => [model()] })
    const k = kernel({
      storage,
      provider,
      seams: fakeSeams({
        approval: {
          ask: async () => {
            asked()
            return await new Promise<'allowed-once'>((resolve) => {
              allow = resolve
            })
          },
        },
      }),
    })
    k.tools.add(
      shellTool(async () => {
        runs += 1
        return { content: [{ type: 'text', text: 'ran' }] }
      }),
      { source: 't', trust: 'builtin' },
    )
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'tool' })
    const running = child.run('tool')
    await sawAsk
    expect((await storage.lookupByKey(child.key))?.state).toBe('waiting_approval')
    await child.cancel?.()
    allow?.('allowed-once')
    await running.catch(() => undefined)
    expect(runs).toBe(0)
    expect((await storage.lookupByKey(child.key))?.state).toBe('cancelled')
    await k.close()
  })
})

describe('subagent cost isolation', () => {
  it('records subagent/cost without changing parent lastLedgerTokens', async () => {
    const k = kernel()
    const parent = await k.session('parent', sessionOpts)
    expect(parent.state.lastLedgerTokens).toBeNull()
    expect(parent.state.creditsUsed).toBe(0)
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'cost' })
    await child.run('cost')
    expect(parent.state.lastLedgerTokens).toBeNull()
    expect(parent.state.creditsUsed).toBe(0)
    const rows = await parent.scan({ type: 'subagent/cost', limit: 5 })
    expect(rows[0]?.data).toMatchObject({
      childKey: child.key,
      originSessionKey: child.key,
      complete: true,
      credits: 1,
    })
    await k.close()
  })
})
