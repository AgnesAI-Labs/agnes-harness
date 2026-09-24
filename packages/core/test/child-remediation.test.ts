import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelRecord, RequestBody } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it, vi } from 'vitest'
import { requireChildControl } from '../src/child/store.js'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { presetDefaults } from '../src/step/preset.js'
import type { SessionDeps } from '../src/step/session.js'
import { fakeProvider, sent, sentFor, textTurn, toolTurn, usage } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps, testWorkspaceInvocation } from './helpers/open-session.js'

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const catalogue = (): ModelRecord => ({
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

const vision = (): ModelRecord => ({ ...catalogue(), input: ['text', 'image'] })
const png = { type: 'image' as const, data: 'AAA', mimeType: 'image/png' }

function kernel(
  over: Partial<Parameters<typeof Kernel.create>[0]> = {},
  provider = Object.assign(fakeProvider([textTurn('ok')]), { models: () => [catalogue()] }),
) {
  return Kernel.create({
    storage: new MemoryStorage(),
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: {
      ...presetDefaults(),
      treeBudgetCredits: 100,
      generationLimit: 2,
      maxFanOut: 4,
      model: { ...presetDefaults().model, id: { primary: 'm1' }, retry: { maxAttempts: 2, baseDelayMs: 0 } },
    },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => 1_757_203_200_000,
    ...over,
  })
}

const sessionOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' }

function listedTool(name: string, description: string) {
  return {
    name,
    description,
    parameters: Type.Object({}),
    meta: {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'never' as const,
      costHint: undefined,
      deferLoading: undefined,
      requiresApproval: undefined,
    },
    execute: async () => ({ content: [{ type: 'text', text: 'x' }] }),
  } as never
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} was not created`)
  return value
}

describe('independent-review remediations R1–R9', () => {
  it('R1: a retry cannot resettle a spent permit or drive held negative', async () => {
    const retryThenOk = fakeProvider([
      [
        sent(),
        usage(),
        { type: 'error', reason: 'error', code: 'RATE_LIMIT', message: 'slow', retryable: true },
      ],
      textTurn('second'),
    ])
    Object.assign(retryThenOk, { models: () => [catalogue()] })
    const storage = new MemoryStorage()
    const k = kernel(
      {
        storage,
        provider: retryThenOk,
        preset: {
          ...presetDefaults(),
          treeBudgetCredits: 1,
          generationLimit: 1,
          maxFanOut: 4,
          model: {
            ...presetDefaults().model,
            id: { primary: 'm1' },
            retry: { maxAttempts: 2, baseDelayMs: 0 },
          },
        },
      },
      retryThenOk,
    )
    const parent = await k.session('parent', sessionOpts)
    await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await parent.run({ until: 'turn-end', signal: new AbortController().signal })
    const store = requireChildControl(storage)
    let usageTree = null
    for (let seq = 0; seq <= parent.lastSeq; seq += 1) {
      usageTree = await store.projectTree(`${parent.key}:main:${seq}`)
      if (usageTree) break
    }
    if (usageTree) {
      expect(usageTree.heldMicro >= 0n).toBe(true)
      expect(usageTree.settledMicro <= usageTree.capMicro).toBe(true)
    }
    expect(retryThenOk.calls).toBeLessThanOrEqual(1)
    await k.close()
  })

  it('R2: a grandchild cannot exceed the parent subtree cap', async () => {
    const storage = new MemoryStorage()
    const k = kernel({ storage })
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({
      parent: parent.key,
      cwd: '/w',
      input: 'child',
      budget: 2,
    })
    const childSession = k.get(child.key)
    await expect(
      childSession?.d.children.create({
        parent: child.key,
        cwd: '/w',
        input: 'grand',
        budget: 5,
      }),
    ).rejects.toMatchObject({ code: 'E_BUDGET' })
    await k.close()
  })

  it('R3: missing catalogue price/maxTokens falls back to the ledger projection instead of refusing', async () => {
    // A model resolved by a pinned id may legitimately never appear in the local static catalogue
    // snapshot (remote catalogues publish ids only). Missing/incomplete catalogue data now means
    // "no conservative upper bound available", not "refuse the turn": the request is still
    // admitted, holding against the ledger's own projectedCredits alone.
    const bare = fakeProvider([textTurn('sent anyway')])
    const k = kernel(
      {
        provider: bare,
        preset: { ...presetDefaults(), treeBudgetCredits: 10, generationLimit: 1, maxFanOut: 4 },
      },
      bare,
    )
    const parent = await k.session('parent', sessionOpts)
    await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const result = await parent.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(result.reason).toBe('completed')
    expect(bare.calls).toBe(1)
    await k.close()
  })

  it('R3: admitted inference puts catalogue maxTokens on the wire', async () => {
    const provider = Object.assign(fakeProvider([textTurn('ok')]), { models: () => [catalogue()] })
    const k = kernel({ provider }, provider)
    const parent = await k.session('parent', sessionOpts)
    await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await parent.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(provider.requests[0]?.sampling?.maxTokens).toBe(128)
    await k.close()
  })

  it('R4/R8: spawn persists start/inbox and restored generationDepth stays 1', async () => {
    const storage = new MemoryStorage()
    const hanging = Object.assign(fakeProvider([textTurn('hang')]), {
      models: () => [catalogue()],
      async *infer(req: RequestBody) {
        yield sentFor(req)
        await new Promise(() => undefined)
      },
    })
    const k = kernel({
      storage,
      provider: hanging,
      preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 4 },
    })
    const parent = await k.session('parent', sessionOpts)
    const child = required(
      await parent.d.children.createWithKind?.('spawn', {
        parent: parent.key,
        cwd: '/w',
        input: 'later',
        isolation: 'shared',
      }),
      'spawn child',
    )
    const start = (await storage.scan(child.key, { type: 'session/start', limit: 20 })).filter(
      (row) => (row.data as { key?: string }).key === child.key,
    )
    expect(start.length).toBeGreaterThan(0)
    const depth = (start[0]?.data as { delegation?: { generationDepth?: number } } | undefined)?.delegation
      ?.generationDepth
    expect(depth).toBe(1)
    await k.close()
    expect((await requireChildControl(storage).lookupByKey(child.key))?.generationDepth).toBe(1)
    const k2 = kernel({
      storage,
      provider: hanging,
      preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 4 },
    })
    const parent2 = await k2.session('parent', sessionOpts)
    await expect(parent2.d.children.resume?.(child.key)).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    await k2.close()
  })

  it('R5: resume uses the original boundary after the parent has progressed', async () => {
    const storage = new MemoryStorage()
    const provider = Object.assign(
      fakeProvider([textTurn('parent1'), textTurn('parent2'), textTurn('child')]),
      {
        models: () => [catalogue()],
      },
    )
    const k = kernel({ storage, provider }, provider)
    const parent = await k.session('parent', sessionOpts)
    const child = required(
      await parent.d.children.createWithKind?.('spawn', {
        parent: parent.key,
        cwd: '/w',
        input: 'later',
      }),
      'spawn child',
    )
    await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'more' }], actor })
    await parent.run({ until: 'turn-end', signal: new AbortController().signal })
    await expect(parent.d.children.resume?.(child.key)).resolves.toMatchObject({ key: child.key })
    await k.close()
  })

  it('R6: inspect after restart returns the child text and lastSeq', async () => {
    const storage = new MemoryStorage()
    const provider = Object.assign(fakeProvider([textTurn('persistent child answer')]), {
      models: () => [catalogue()],
    })
    const k = kernel({ storage, provider }, provider)
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'q' })
    await child.run('q')
    await k.close()
    const k2 = kernel({ storage, provider }, provider)
    const parent2 = await k2.session('parent', sessionOpts)
    const snap = await parent2.d.children.inspect?.(child.key)
    expect(snap?.text).toBe('persistent child answer')
    expect((snap?.lastSeq ?? 0) > 0).toBe(true)
    await k2.close()
  })

  it('R7: cancel after restart persists cancelled', async () => {
    const storage = new MemoryStorage()
    const k = kernel({ storage })
    const parent = await k.session('parent', sessionOpts)
    const child = required(
      await parent.d.children.createWithKind?.('spawn', {
        parent: parent.key,
        cwd: '/w',
        input: 'later',
      }),
      'spawn child',
    )
    await parent.d.children.cancel?.(child.key)
    expect((await requireChildControl(storage).lookupByKey(child.key))?.state).toBe('cancelled')
    await k.close()
  })

  it('R9: a completed child frees the fan-out slot without collect', async () => {
    const k = kernel({
      preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 2, maxFanOut: 1 },
    })
    const parent = await k.session('parent', sessionOpts)
    const first = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'one' })
    await first.run('one')
    expect(k.sessions.has(first.key)).toBe(false)
    await expect(
      parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'two' }),
    ).resolves.toMatchObject({ key: expect.stringContaining('parent/') })
    await k.close()
  })
})

describe('independent-review V1–V7', () => {
  it('V1: resume of a live spawn does not fail the child or steal its writer', async () => {
    const provider = Object.assign(fakeProvider([textTurn('spawned-ok')]), { models: () => [catalogue()] })
    const storage = new MemoryStorage()
    const k = kernel({ storage, provider }, provider)
    const parent = await k.session('parent', sessionOpts)
    const child = required(
      await parent.d.children.createWithKind?.('spawn', {
        parent: parent.key,
        cwd: '/w',
        input: 'hello',
      }),
      'spawn child',
    )
    await parent.d.children.resume?.(child.key)
    await expect.poll(async () => (await child.status())?.state, { timeout: 5_000 }).toBe('done')
    expect(provider.calls).toBeGreaterThan(0)
    expect((await child.status())?.text).toBe('spawned-ok')
    await k.close()
  })

  it('V2/v1: instance exit marks failed and resume from a new kernel is refused', async () => {
    const provider = Object.assign(fakeProvider([textTurn('recovered')]), { models: () => [catalogue()] })
    const storage = new MemoryStorage()
    const k = kernel({ storage, provider }, provider)
    const parent = await k.session('parent', sessionOpts)
    const child = required(
      await parent.d.children.createWithKind?.('spawn', {
        parent: parent.key,
        cwd: '/w',
        input: 'later',
      }),
      'spawn child',
    )
    await k.close()
    expect((await requireChildControl(storage).lookupByKey(child.key))?.state).toBe('failed')
    const k2 = kernel({ storage, provider }, provider)
    const parent2 = await k2.session('parent', sessionOpts)
    await expect(parent2.d.children.resume?.(child.key)).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    expect((await requireChildControl(storage).lookupByKey(child.key))?.state).toBe('failed')
    await k2.close()
  })

  it('V3: a foreign parent cancel does not mutate another parent child', async () => {
    const storage = new MemoryStorage()
    const k = kernel({ storage })
    const parentA = await k.session('parentA', { ...sessionOpts, writerRunId: 'ra' })
    const parentB = await k.session('parentB', { ...sessionOpts, writerRunId: 'rb' })
    const child = await parentB.d.children.create({ parent: parentB.key, cwd: '/w', input: 'keep' })
    await expect(parentA.d.children.cancel?.(child.key)).rejects.toMatchObject({ code: 'E_CHILD_NOT_FOUND' })
    expect((await requireChildControl(storage).lookupByKey(child.key))?.state).not.toBe('cancelled')
    await k.close()
  })

  it('V4: cancelling a parent aborts a running grandchild and keeps cancelled', async () => {
    let entered = false
    const hanging = Object.assign(fakeProvider([textTurn('should-not-finish')]), {
      models: () => [catalogue()],
      async *infer(req: RequestBody) {
        entered = true
        yield sentFor(req)
        await new Promise(() => undefined)
      },
    })
    const storage = new MemoryStorage()
    const k = kernel(
      {
        storage,
        provider: hanging,
        preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 2, maxFanOut: 4 },
      },
      hanging,
    )
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'child' })
    const childSession = required(k.get(child.key), 'child session')
    const grand = await childSession.d.children.create({ parent: child.key, cwd: '/w', input: 'grand' })
    void grand.run('grand').catch(() => undefined)
    await expect.poll(() => entered, { timeout: 5_000 }).toBe(true)
    await parent.d.children.cancel?.(child.key)
    expect(k.get(grand.key)?.ac.signal.aborted).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await requireChildControl(storage).lookupByKey(grand.key))?.state).toBe('cancelled')
    await k.close()
  })

  it('V5: ready is not published before the child own start event', async () => {
    const storage = new MemoryStorage()
    const seen: Array<{ state: string; ownStarts: number }> = []
    const orig = storage.casState.bind(storage)
    storage.casState = async (key, rev, next) => {
      const ok = await orig(key, rev, next)
      if (next === 'ready') {
        const rows = await storage.scan(key, { type: 'session/start', limit: 20 })
        const ownStarts = rows.filter((row) => (row.data as { key?: string }).key === key).length
        seen.push({ state: 'ready', ownStarts })
      }
      return ok
    }
    const k = kernel({ storage })
    const parent = await k.session('parent', sessionOpts)
    await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'atomic' })
    expect(seen.some((row) => row.state === 'ready' && row.ownStarts === 0)).toBe(false)
    expect(seen.some((row) => row.state === 'ready' && row.ownStarts > 0)).toBe(true)
    await k.close()
  })

  it('V6: maxTokens conservative bound refuses before any provider call', async () => {
    const provider = Object.assign(fakeProvider([textTurn('too expensive')]), { models: () => [catalogue()] })
    const k = kernel(
      {
        provider,
        seams: fakeSeams({
          ledger: { projected: async () => ({ credits: 0.00001, creditSource: 'estimated' }) },
        }),
        preset: {
          ...presetDefaults(),
          treeBudgetCredits: 0.0001,
          generationLimit: 1,
          maxFanOut: 4,
          model: { ...presetDefaults().model, id: { primary: 'm1' } },
        },
      },
      provider,
    )
    const parent = await k.session('parent', sessionOpts)
    await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const result = await parent.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(result.reason).toBe('budget')
    expect(provider.calls).toBe(0)
    await k.close()
  })

  it('V7: worktree bind cwd is the session cwd after resume', async () => {
    let entered = false
    const hanging = Object.assign(fakeProvider([textTurn('in-tree')]), {
      models: () => [catalogue()],
      async *infer(req: RequestBody) {
        entered = true
        yield sentFor(req)
        await new Promise(() => undefined)
      },
    })
    const storage = new MemoryStorage()
    const k = kernel({ storage, provider: hanging }, hanging)
    const parent = await k.session('parent', sessionOpts)
    const child = required(
      await parent.d.children.createWithKind?.('spawn', {
        parent: parent.key,
        cwd: '/w',
        input: 'later',
        isolation: 'worktree',
        start: false,
      }),
      'spawn child',
    )
    await storage.updateWorkspace?.(`ws:${child.key}`, { path: '/w/isolated-worktree' })
    await parent.d.children.resume?.(child.key)
    await expect.poll(() => entered, { timeout: 5_000 }).toBe(true)
    expect(k.get(child.key)?.d.cwd).toBe('/w/isolated-worktree')
    await k.close()
  })

  it('V7: a file tool writes only inside the bound git worktree', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-v7-git-')))
    execFileSync('git', ['init', '-b', 'main'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'v7@example.test'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'v7'], { cwd: root })
    writeFileSync(join(root, 'README.md'), 'root\n')
    writeFileSync(join(root, '.gitignore'), '.worktrees\n')
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root })
    mkdirSync(join(root, '.worktrees'))
    const tree = join(root, '.worktrees', 'agnes-child')
    execFileSync('git', ['worktree', 'add', '-b', 'agnes/subagent-v7', tree], { cwd: root })
    const provider = Object.assign(fakeProvider([toolTurn('mark', {}), textTurn('done')]), {
      models: () => [catalogue()],
    })
    const storage = new MemoryStorage()
    const k = kernel({ storage, provider }, provider)
    k.tools.add(
      {
        name: 'mark',
        description: 'mark',
        parameters: Type.Object({}),
        meta: {
          isReadOnly: false,
          isDestructive: false,
          isConcurrencySafe: true,
          isOpenWorld: false,
          replay: 'never',
          costHint: undefined,
          deferLoading: undefined,
          requiresApproval: undefined,
        },
        execute: async (_args: Record<string, never>, ctx: { cwd: string }) => {
          writeFileSync(join(ctx.cwd, 'only-child.txt'), 'child\n')
          return { content: [{ type: 'text', text: 'wrote' }] }
        },
      } as never,
      { source: 't', trust: 'builtin' },
    )
    const childFs = testFsOps()
    const childInvocation = testWorkspaceInvocation(childFs, fakeSeams(), tree)
    const parent = await k.session('parent', {
      ...sessionOpts,
      cwd: root,
      childWorkspaceRuntime: {
        reserve: async () => ({
          runtime: { fs: childFs, invocation: childInvocation },
          commit: () => true,
          close: async () => undefined,
        }),
      },
    })
    const child = required(
      await parent.d.children.createWithKind?.('spawn', {
        parent: parent.key,
        cwd: root,
        input: 'write',
        isolation: 'worktree',
        start: false,
      }),
      'spawn child',
    )
    await storage.updateWorkspace?.(`ws:${child.key}`, { path: tree })
    await parent.d.children.resume?.(child.key)
    await expect.poll(async () => (await child.status())?.state, { timeout: 5_000 }).toBe('done')
    expect(existsSync(join(tree, 'only-child.txt'))).toBe(true)
    expect(existsSync(join(root, 'only-child.txt'))).toBe(false)
    await k.close()
  })

  it('T1: a second kernel cannot resume another kernel live child', async () => {
    const storage = new MemoryStorage()
    const kA = kernel({ storage })
    const parentA = await kA.session('parent', sessionOpts)
    const child = required(
      await parentA.d.children.createWithKind?.('spawn', {
        parent: parentA.key,
        cwd: '/w',
        input: 'live',
      }),
      'spawn child',
    )
    await parentA.close()
    const kB = kernel({ storage })
    const parentB = await kB.session('parent', { ...sessionOpts, writerRunId: 'rB' })
    await expect(parentB.d.children.resume?.(child.key)).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    expect((await requireChildControl(storage).lookupByKey(child.key))?.state).toBe('ready')
    await kB.close()
    await kA.close()
  })

  it('T2: a cancelled child cannot be restarted by an old handle', async () => {
    const storage = new MemoryStorage()
    const provider = Object.assign(fakeProvider([textTurn('should-not-run')]), {
      models: () => [catalogue()],
    })
    const k = kernel({ storage, provider }, provider)
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'keep' })
    await parent.d.children.cancel?.(child.key)
    const before = provider.calls
    await expect(child.run('keep')).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    expect(provider.calls).toBe(before)
    expect((await requireChildControl(storage).lookupByKey(child.key))?.state).toBe('cancelled')
    await k.close()
  })

  it('S1: large tool definitions refuse before any provider call', async () => {
    const provider = Object.assign(fakeProvider([textTurn('should not send')]), {
      models: () => [catalogue()],
    })
    const k = kernel(
      {
        provider,
        seams: fakeSeams({
          ledger: { projected: async () => ({ credits: 0.00001, creditSource: 'estimated' }) },
        }),
        preset: {
          ...presetDefaults(),
          treeBudgetCredits: 0.02,
          generationLimit: 1,
          maxFanOut: 4,
          model: { ...presetDefaults().model, id: { primary: 'm1' } },
        },
      },
      provider,
    )
    for (let i = 0; i < 20; i += 1) {
      k.tools.add(listedTool(`probe_tool_${i}`, 'd'.repeat(2000)), { source: 't', trust: 'builtin' })
    }
    const parent = await k.session('parent', sessionOpts)
    await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const result = await parent.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(result.reason).toBe('budget')
    expect(provider.calls).toBe(0)
    await k.close()
  })

  it('S1: ordinary in-budget request with a small tool still runs', async () => {
    const provider = Object.assign(fakeProvider([textTurn('ok')]), { models: () => [catalogue()] })
    const k = kernel({ provider }, provider)
    k.tools.add(listedTool('tiny', 'tiny'), { source: 't', trust: 'builtin' })
    const parent = await k.session('parent', sessionOpts)
    await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const result = await parent.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(result.reason).toBe('completed')
    expect(provider.calls).toBe(1)
    await k.close()
  })

  it('S2: cancelling a ready child releases session, handle, and writer lease', async () => {
    const storage = new MemoryStorage()
    const k = kernel({ storage })
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'idle' })
    expect(k.sessions.has(child.key)).toBe(true)
    expect(parent.d.children.get?.(child.key)).toBeDefined()
    await parent.d.children.cancel?.(child.key)
    expect((await requireChildControl(storage).lookupByKey(child.key))?.state).toBe('cancelled')
    expect(k.sessions.has(child.key)).toBe(false)
    expect(parent.d.children.get?.(child.key)).toBeUndefined()
    await storage.open(child.key, { writerRunId: 'after-cancel', ttlMs: 1000 })
    await storage.release(child.key, 'after-cancel')
    expect(await parent.d.children.inspect?.(child.key)).toMatchObject({ state: 'error' })
    await parent.d.children.cancel?.(child.key)
    expect((await requireChildControl(storage).lookupByKey(child.key))?.state).toBe('cancelled')
    expect(await parent.d.children.inspect?.(child.key)).toMatchObject({ state: 'error' })
    await k.close()
  })

  it('ordinary session without tree budget still sends an image request', async () => {
    let countCalls = 0
    const provider = Object.assign(fakeProvider([textTurn('saw')]), {
      models: () => [vision()],
      count: async (request: RequestBody) => {
        countCalls++
        return { tokens: 17, source: 'provider' as const, boundHash: request.derivedHash }
      },
    })
    const k = kernel(
      {
        provider,
        preset: {
          ...presetDefaults(),
          treeBudgetCredits: null,
          generationLimit: 1,
          maxFanOut: 4,
          model: { ...presetDefaults().model, id: { primary: 'm1' } },
        },
      },
      provider,
    )
    const parent = await k.session('parent', sessionOpts)
    await parent.enqueue('next-turn', { content: [png], actor })
    const result = await parent.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(result.reason).toBe('completed')
    expect(provider.calls).toBe(1)
    expect(
      provider.requests[0]?.messages.some((message) =>
        message.content.some((block) => block.type === 'image'),
      ),
    ).toBe(true)
    expect(countCalls).toBe(1)
    await k.close()
  })

  it('ordinary image request fails closed before inference without count or fallback', async () => {
    const provider = Object.assign(fakeProvider([textTurn('must not see')]), { models: () => [vision()] })
    const k = kernel(
      {
        provider,
        preset: {
          ...presetDefaults(),
          treeBudgetCredits: null,
          generationLimit: 1,
          maxFanOut: 4,
          model: { ...presetDefaults().model, id: { primary: 'm1' } },
        },
      },
      provider,
    )
    const parent = await k.session('parent', sessionOpts)
    await parent.enqueue('next-turn', { content: [png], actor })
    expect((await parent.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'budget',
    )
    expect(provider.calls).toBe(0)
    await k.close()
  })

  it('tree-budget session uses one image-aware provider count before admission and reuses it', async () => {
    let countCalls = 0
    const provider = Object.assign(fakeProvider([textTurn('saw image')]), {
      models: () => [vision()],
      count: async (request: RequestBody) => {
        countCalls++
        return { tokens: 17, source: 'provider' as const, boundHash: request.derivedHash }
      },
    })
    const selected = presetDefaults()
    selected.treeBudgetCredits = 100
    selected.budget = { ...selected.budget, preflight: 'count' }
    const k = kernel({ provider, preset: selected }, provider)
    const parent = await k.session('parent', sessionOpts)
    let fallbackCalls = 0
    parent.d.imageInputTokenFallback = async ({ imageCount }) => {
      fallbackCalls++
      return { tokens: 17, imageCount }
    }
    await parent.enqueue('next-turn', { content: [png], actor })
    const result = await parent.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(result.reason).toBe('completed')
    expect(countCalls).toBe(1)
    expect(fallbackCalls).toBe(1)
    expect(provider.calls).toBe(1)
    // reserveTreeBudget adds the output clamp after the count. The token value remains safe for
    // admission, but its old boundHash cannot be relabelled as a count of the reminted request.
    expect(parent.latest('budget.state')).toMatchObject({
      lastPreflight: { tokens: 17, source: 'estimate' },
    })
    await k.close()
  })

  it.each(['unsupported', 'throw'] as const)(
    'tree-budget image uses the explicit whole-wire fallback after provider count is %s',
    async (mode) => {
      let countCalls = 0
      let fallbackInput: Parameters<NonNullable<SessionDeps['imageInputTokenFallback']>>[0] | undefined
      const provider = Object.assign(fakeProvider([textTurn('fallback image')]), {
        models: () => [vision()],
        count: async () => {
          countCalls++
          if (mode === 'throw') throw new Error('counter down')
          return { source: 'unsupported' as const }
        },
      })
      const k = kernel({ provider }, provider)
      const parent = await k.session('parent', sessionOpts)
      parent.d.imageInputTokenFallback = async (input) => {
        fallbackInput = input
        return { tokens: 23, imageCount: input.imageCount }
      }
      await parent.enqueue('next-turn', { content: [png], actor })
      const result = await parent.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(result.reason).toBe('completed')
      expect(countCalls).toBe(1)
      expect(provider.calls).toBe(1)
      expect(fallbackInput).toMatchObject({ imageCount: 1 })
      expect(fallbackInput?.media).toBeUndefined()
      expect(
        fallbackInput?.wire.messages.some((message) => message.content.some((b) => b.type === 'image')),
      ).toBe(true)
      await k.close()
    },
  )

  it.each([
    null,
    { source: 'bogus', tokens: 1, boundHash: 'a'.repeat(64) },
    { source: 'provider', tokens: 1, boundHash: 'a'.repeat(64), extra: true },
  ])('rejects an invalid count result and uses only the explicit image fallback', async (invalid) => {
    let fallbackCalls = 0
    const provider = Object.assign(fakeProvider([textTurn('fallback image')]), {
      models: () => [vision()],
      count: async () => invalid as never,
    })
    const k = kernel({ provider }, provider)
    const parent = await k.session('parent', sessionOpts)
    parent.d.imageInputTokenFallback = async ({ imageCount }) => {
      fallbackCalls++
      return { tokens: 23, imageCount }
    }
    await parent.enqueue('next-turn', { content: [png], actor })
    expect((await parent.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(fallbackCalls).toBeGreaterThan(0)
    expect(provider.calls).toBe(1)
    await k.close()
  })

  it.each(['count', 'fallback'] as const)(
    'cancellation while waiting for image %s prevents inference dispatch',
    async (mode) => {
      let startedResolve: (() => void) | undefined
      const started = new Promise<void>((resolve) => {
        startedResolve = resolve
      })
      const never = new Promise<never>(() => undefined)
      const provider = Object.assign(fakeProvider([textTurn('must not send')]), {
        models: () => [vision()],
        count: async () => {
          if (mode === 'count') {
            startedResolve?.()
            return never
          }
          return { source: 'unsupported' as const }
        },
      })
      const k = kernel({ provider }, provider)
      const parent = await k.session('parent', sessionOpts)
      if (mode === 'fallback')
        parent.d.imageInputTokenFallback = async () => {
          startedResolve?.()
          return never
        }
      await parent.enqueue('next-turn', { content: [png], actor })
      const controller = new AbortController()
      const running = parent.run({ until: 'turn-end', signal: controller.signal })
      await started
      controller.abort()
      expect((await running).reason).toBe('aborted')
      expect(provider.calls).toBe(0)
      await k.close()
    },
  )

  it('releases a tree reservation when count calibration denies before inference', async () => {
    const storage = new MemoryStorage()
    let permitId: string | undefined
    const originalReserve = storage.reserve.bind(storage)
    storage.reserve = async (request) => {
      const result = await originalReserve(request)
      if (result.ok) permitId = result.permitId
      return result
    }
    const provider = Object.assign(fakeProvider([textTurn('must not send')]), {
      models: () => [vision()],
      count: async () => ({ source: 'unsupported' as const }),
    })
    const selected = presetDefaults()
    selected.treeBudgetCredits = 1000
    selected.budget = { ...selected.budget, preflight: 'count', perRequestCap: 5, onExceed: 'deny' }
    const k = kernel(
      {
        storage,
        provider,
        preset: selected,
        seams: fakeSeams({
          ledger: {
            projected: async ({ tokensEstimate }) => ({
              credits: tokensEstimate,
              creditSource: 'estimated',
            }),
          },
        }),
      },
      provider,
    )
    const parent = await k.session('parent', sessionOpts)
    parent.d.imageInputTokenFallback = async ({ imageCount }) => ({ tokens: 10, imageCount })
    await parent.enqueue('next-turn', { content: [png], actor })
    expect((await parent.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'budget',
    )
    expect(provider.calls).toBe(0)
    expect(permitId).toBeDefined()
    expect(await storage.peekReservation(permitId as string)).toMatchObject({ status: 'released' })
    await k.close()
  })

  it('releases a tree reservation when the post-admission request clamp is invalid', async () => {
    const storage = new MemoryStorage()
    let permitId: string | undefined
    const originalReserve = storage.reserve.bind(storage)
    storage.reserve = async (request) => {
      const result = await originalReserve(request)
      if (result.ok) permitId = result.permitId
      return result
    }
    const provider = Object.assign(fakeProvider([textTurn('must not send')]), {
      models: () => [{ ...catalogue(), maxTokens: 128.5 } as ModelRecord],
    })
    const k = kernel({ storage, provider }, provider)
    const parent = await k.session('parent', sessionOpts)
    await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'hello' }], actor })
    expect((await parent.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'error',
    )
    expect(provider.calls).toBe(0)
    expect(permitId).toBeDefined()
    expect(await storage.peekReservation(permitId as string)).toMatchObject({ status: 'released' })
    await k.close()
  })

  it('releases a tree reservation when the durable inference intent commit fails', async () => {
    const storage = new MemoryStorage()
    let permitId: string | undefined
    const originalReserve = storage.reserve.bind(storage)
    storage.reserve = async (request) => {
      const result = await originalReserve(request)
      if (result.ok) permitId = result.permitId
      return result
    }
    const originalCommit = storage.commit.bind(storage)
    storage.commit = async (key, transaction) => {
      if (transaction.events.some((event) => event.type === 'effect/intent'))
        throw new Error('injected intent commit failure')
      return originalCommit(key, transaction)
    }
    const provider = Object.assign(fakeProvider([textTurn('must not send')]), {
      models: () => [catalogue()],
    })
    const k = kernel({ storage, provider }, provider)
    const parent = await k.session('parent', sessionOpts)
    await parent.enqueue('next-turn', { content: [{ type: 'text', text: 'hello' }], actor })
    expect((await parent.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'error',
    )
    expect(provider.calls).toBe(0)
    expect(permitId).toBeDefined()
    expect(await storage.peekReservation(permitId as string)).toMatchObject({ status: 'released' })
    await k.close()
  })

  it.each([
    null,
    async (): Promise<{ tokens: number; imageCount: number } | null> => ({ tokens: 0, imageCount: 1 }),
    async (): Promise<{ tokens: number; imageCount: number } | null> => ({ tokens: 23, imageCount: 2 }),
    async (): Promise<{ tokens: number; imageCount: number } | null> => null,
  ] as const)(
    'tree-budget image fails closed when its whole-wire fallback is missing or invalid',
    async (fallback) => {
      const provider = Object.assign(fakeProvider([textTurn('must not send')]), {
        models: () => [vision()],
        count: async () => ({ source: 'unsupported' as const }),
      })
      const k = kernel({ provider }, provider)
      const parent = await k.session('parent', sessionOpts)
      if (fallback) parent.d.imageInputTokenFallback = fallback
      await parent.enqueue('next-turn', { content: [png], actor })
      const result = await parent.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(result.reason).toBe('budget')
      expect(provider.calls).toBe(0)
      await k.close()
    },
  )

  it('inherited child tree budget still refuses an image when the child preset cap is null', async () => {
    const provider = Object.assign(fakeProvider([textTurn('text-ok'), textTurn('should not see')]), {
      models: () => [vision()],
    })
    const k = kernel({ provider }, provider)
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'text' })
    const cs = required(k.get(child.key), 'child session')
    cs.preset.treeBudgetCredits = null
    await cs.enqueue('next-turn', { content: [png], actor })
    const first = await cs.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(first.reason).toBe('completed')
    expect(provider.calls).toBe(1)
    const second = await cs.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(second.reason).toBe('budget')
    expect(provider.calls).toBe(1)
    await k.close()
  })

  it('singleflights concurrent opens for the same durable child row', async () => {
    const storage = new MemoryStorage()
    const k = kernel({ storage })
    const parent = await k.session('parent', sessionOpts)
    const originalSession = k.session.bind(k)
    let releaseOpen!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseOpen = resolve
    })
    let childOpens = 0
    vi.spyOn(k, 'session').mockImplementation(async (key, opts) => {
      if (key !== 'parent') {
        childOpens += 1
        await blocked
      }
      return originalSession(key, opts)
    })

    const first = parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'same' })
    await expect.poll(() => childOpens).toBe(1)
    const second = parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'same' })
    await Promise.resolve()
    expect(childOpens).toBe(1)
    releaseOpen()
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(childOpens).toBe(1)
    await k.close()
  })

  it('durably cancels before cleaning a partially opened child and retries transient cancellation writes', async () => {
    const storage = new MemoryStorage()
    const k = kernel({ storage })
    const parent = await k.session('parent', sessionOpts)
    const originalSession = k.session.bind(k)
    vi.spyOn(k, 'session').mockImplementationOnce(async (key, opts) => {
      await originalSession(key, opts)
      throw new Error('injected post-open failure')
    })
    const cancel = storage.cancelCreatingChild.bind(storage)
    let cancellationWrites = 0
    storage.cancelCreatingChild = async (input) => {
      cancellationWrites += 1
      if (cancellationWrites < 3) throw new Error('transient storage failure')
      return cancel(input)
    }

    await expect(parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'fails' })).rejects.toThrow(
      'injected post-open failure',
    )
    const [record] = await storage.listByParent(parent.key)
    expect(record).toMatchObject({ creationPhase: 'cancelled' })
    expect(cancellationWrites).toBe(3)
    expect(record && k.get(record.childKey)).toBeUndefined()
    await k.close()
  })

  it('keeps a recovery marker and clears the opening slot after permanent cancellation failure', async () => {
    const storage = new MemoryStorage()
    const k = kernel({ storage })
    const parent = await k.session('parent', sessionOpts)
    const originalSession = k.session.bind(k)
    vi.spyOn(k, 'session').mockImplementationOnce(async (key, opts) => {
      await originalSession(key, opts)
      throw new Error('injected post-open failure')
    })
    const cancel = storage.cancelCreatingChild.bind(storage)
    storage.cancelCreatingChild = async () => {
      throw new Error('permanent storage failure')
    }

    await expect(
      parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'recoverable' }),
    ).rejects.toBeInstanceOf(AggregateError)
    const [marker] = await storage.listByParent(parent.key)
    expect(marker).toMatchObject({ creationPhase: 'creating' })
    expect(marker && k.get(marker.childKey)).toBeUndefined()

    storage.cancelCreatingChild = cancel
    await expect(
      parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'recoverable' }),
    ).resolves.toMatchObject({ key: marker?.childKey })
    expect((await storage.lookupByKey(marker?.childKey ?? 'missing'))?.creationPhase).toBe('committed')
    await k.close()
  })

  it('passes one child workspace token through Kernel.session and delegates close to it once', async () => {
    const storage = new MemoryStorage()
    const identity = Object.freeze({
      sessionKey: 'child',
      workspaceId: 'workspace',
      authorityRevision: 1,
      canonicalRoot: '/w',
    })
    const runtime = Object.freeze({ fs: testFsOps(), identity })
    let reservations = 0
    let commits = 0
    let closes = 0
    let closePromise: Promise<void> | undefined
    const token = {
      runtime,
      commit: () => {
        commits += 1
        return true
      },
      close: () => {
        closePromise ??= Promise.resolve().then(() => {
          closes += 1
        })
        return closePromise
      },
    }
    const childWorkspaceRuntime = {
      reserve: async (parentKey: string, childKey: string) => {
        expect(parentKey).toBe('parent')
        expect(childKey).toMatch(/^parent\//)
        reservations += 1
        return token
      },
    }
    const k = kernel({ storage })
    const parent = await k.session('parent', { ...sessionOpts, childWorkspaceRuntime })
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'workspace' })
    const childSession = required(k.get(child.key), 'child session')
    expect(childSession.d.workspaceIdentity).toBe(identity)
    expect(childSession.d).not.toHaveProperty('workspaceRuntime')
    expect(childSession.d.workspaceLease).toBe(token)
    expect(childSession.d.childWorkspaceRuntime).toBe(childWorkspaceRuntime)
    expect({ reservations, commits, closes }).toEqual({ reservations: 1, commits: 1, closes: 0 })

    const firstClose = child.close()
    const secondClose = child.close()
    await Promise.all([firstClose, secondClose])
    expect(closes).toBe(1)
    await k.close()
  })

  it('cancels the durable attempt when the child workspace token loses commit/close race', async () => {
    const storage = new MemoryStorage()
    let closes = 0
    const closed = Promise.resolve()
    const childWorkspaceRuntime = {
      reserve: async () => ({
        runtime: { fs: testFsOps() },
        commit: () => false,
        close: () => {
          closes += 1
          return closed
        },
      }),
    }
    const k = kernel({ storage })
    const parent = await k.session('parent', { ...sessionOpts, childWorkspaceRuntime })
    await expect(
      parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'lost-race' }),
    ).rejects.toMatchObject({ code: 'E_WORKSPACE_CLOSED' })
    const [record] = await storage.listByParent(parent.key)
    expect(record).toMatchObject({ creationPhase: 'cancelled' })
    expect(record && k.get(record.childKey)).toBeUndefined()
    expect(closes).toBe(1)
    await k.close()
  })
})
