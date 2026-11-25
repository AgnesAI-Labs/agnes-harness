import { CHILD_CONTROL_FORMAT } from '@agnes/core-child-control/child/types'
import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { presetDefaults } from '@agnes/core-common/step/preset'
import { CoreError } from '@agnes/core-common/types'
import { buildToolContext } from '@agnes/core-effects/effects/tool-context'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { childControls } from '../src/child/pause-control.js'
import { ROLE_DELEGATION } from '../src/child/roles.js'
import { readChildCheckpoint, snapshotFromLedger } from '../src/child/status.js'
import { childSessionToolFilter } from '../src/child/tool-filter.js'
import { Kernel } from '../src/kernel.js'
import { applyChildControl, controlledChildTree } from '../src/loop/child-controls.js'
import type { SessionImpl } from '../src/step/session.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, sent, sentFor, textTurn } from './helpers/fake-provider.js'

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

import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function kernel(
  over: Partial<Parameters<typeof Kernel.create>[0]> & { treeBudgetCredits?: number | null } = {},
) {
  const { treeBudgetCredits = 100, ...rest } = over
  return Kernel.create({
    loops: defaultLoops(),
    storage: new MemoryStorage(),
    seams: fakeSeams(),
    provider: Object.assign(fakeProvider([textTurn('child says hi'), textTurn('second')]), {
      models: () => [catalogue()],
    }),
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits, generationLimit: 1, maxFanOut: 2 },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => 1_757_203_200_000,
    ...rest,
  })
}

const sessionOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' }

async function invalidatesProjection(
  sessions: SessionImpl[],
  change: () => unknown | Promise<unknown>,
  enabled: boolean,
) {
  const releases: (() => void)[] = []
  const rows = sessions.map(
    (session) =>
      new Promise<unknown>((resolve) => {
        releases.push(
          session.onAppended((events) => {
            const notice = events.find((event) => event.type === 'x/core/permission-projection-invalidated')
            if (!notice) return
            resolve(notice)
          }),
        )
      }),
  )
  try {
    await change()
    for (const notice of await Promise.all(rows)) {
      expect(notice).toMatchObject({ origin: 'system', trust: 'trusted', ignorable: true })
      expect((notice as { data: unknown }).data).toEqual({})
    }
    for (const session of sessions) {
      if (session.closingOrClosed) {
        expect(session.yolo).toBe(false)
        await expect(session.projectUI()).rejects.toMatchObject({ code: 'E_CLOSED' })
      } else expect((await session.projectUI()).yolo).toBe(enabled)
    }
  } finally {
    for (const release of releases) release()
  }
}

describe('Kernel child lifecycle (generation, fan-out, budget)', () => {
  it('refuses a child when generationLimit is 0 and does not start a model', async () => {
    const provider = fakeProvider([textTurn('should not run')])
    const k = kernel({
      provider,
      preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 0, maxFanOut: 4 },
    })
    const parent = await k.session('parent', sessionOpts)
    const calls = provider.requests?.length ?? 0
    await expect(
      parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'nope' }),
    ).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })
    expect(provider.requests?.length ?? 0).toBe(calls)
    expect(k.sessions.size).toBe(1)
    await k.close()
  })

  it('admits one generation and refuses a grandchild even if tool nesting depth is 0', async () => {
    const k = kernel({
      preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 4 },
    })
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'first' })
    const childSession = k.get(child.key)
    expect(childSession?.generationDepth).toBe(1)
    await expect(
      childSession?.d.children.create({ parent: child.key, cwd: '/w', input: 'grand' }),
    ).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })
    await child.run('first')
    await k.close()
  })

  it.each([false, true])(
    'counts concurrent reservations and readmits continuable children (resident=%s)',
    async (resident) => {
      const k = kernel({
        preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 2, maxFanOut: 1 },
      })
      const parent = await k.session('parent', sessionOpts)
      const first = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'one', resident })
      await expect(
        parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'two' }),
      ).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })
      await first.run('one')
      const second = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'two', resident })
      expect(second.key).not.toBe(first.key)
      if (resident) {
        expect(await parent.d.children.list!()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: first.key, status: 'idle', continuable: true }),
          ]),
        )
        const before = k.get(first.key)!.lastSeq
        await expect(
          parent.d.children.sendMessage!(first.key, 'queued continuation', new AbortController().signal),
        ).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })
        expect(k.get(first.key)!.lastSeq).toBe(before)
        await expect(first.run('continue')).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })
        await second.run('two')
        const resumed = await Promise.allSettled([first.run('continue'), second.run('continue')])
        expect(resumed.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(resumed.find((result) => result.status === 'rejected')).toMatchObject({
          status: 'rejected',
          reason: { code: 'E_CHILD_LIMIT' },
        })
      }
      await k.close()
    },
  )

  it('delegates with a built-in default tree budget when tree_budget_credits is missing', async () => {
    // Every shipped preset left this unset, which used to refuse every fork/spawn outright — a
    // missing knob, not a deliberate "no subagents" decision. The factory falls back to
    // DEFAULT_TREE_BUDGET_CREDITS instead of throwing E_BUDGET.
    const k = kernel({
      preset: { ...presetDefaults(), treeBudgetCredits: null, generationLimit: 2, maxFanOut: 4 },
    })
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'x' })
    expect(child.key).toBeDefined()
    await parent.enqueue('next-turn', {
      actor,
      content: [{ type: 'text', text: 'bounded' }],
      budget: 1,
      hardBudget: true,
    })
    await parent.acceptInput()
    await expect(
      parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'unreserved' }),
    ).rejects.toMatchObject({ code: 'E_BUDGET' })
    await k.close()
  })

  it('refuses own budget inherit mode', async () => {
    const k = kernel({
      preset: {
        ...presetDefaults(),
        treeBudgetCredits: 100,
        budgetInherit: 'own',
        generationLimit: 2,
        maxFanOut: 4,
      },
    })
    const parent = await k.session('parent', sessionOpts)
    await expect(
      parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'x' }),
    ).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    await k.close()
  })

  it('atomically admits only one of two overlapping reservations against a tree cap of 10', async () => {
    const storage = new MemoryStorage()
    await storage.ensureRootScope('root', 10_000_000n)
    const first = await storage.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 8_000_000n,
      effectId: 'a',
      requestHash: 'a',
      writerGeneration: 1,
    })
    const second = await storage.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 8_000_000n,
      effectId: 'b',
      requestHash: 'b',
      writerGeneration: 1,
    })
    expect(first).toEqual({ ok: true, permitId: 'p1', status: 'held', existing: false })
    expect(second).toMatchObject({ ok: false, reason: 'cap' })
  })

  it('inspect of an unknown key does not create a session or take a writer', async () => {
    const storage = new MemoryStorage()
    const open = vi.spyOn(storage, 'open')
    const k = kernel({ storage })
    const parent = await k.session('parent', sessionOpts)
    const inspect = parent.d.children.inspect
    expect(inspect).toBeTypeOf('function')
    await expect(inspect?.('missing-child')).resolves.toBeNull()
    expect(await storage.existsSession('missing-child')).toBe(false)
    expect(open).toHaveBeenCalledTimes(1)
    await k.close()
  })

  it('rejects a child-control format newer than this runtime', async () => {
    const storage = new MemoryStorage({ childControlFormat: CHILD_CONTROL_FORMAT + 1 })
    const k = kernel({ storage })
    const parent = await k.session('parent', sessionOpts)
    await expect(
      parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'x' }),
    ).rejects.toMatchObject({ code: 'E_FORMAT' })
    await k.close()
    expect(storage.childControlFormat()).toBe(CHILD_CONTROL_FORMAT + 1)
    expect(await storage.listByParent(parent.key)).toEqual([])
    const reopened = kernel({ storage })
    await reopened.session('parent', { ...sessionOpts, writerRunId: 'after-format-refusal' })
    await reopened.close()
  })

  it('keeps a durable child record after the in-memory handle is closed', async () => {
    const storage = new MemoryStorage()
    const k = kernel({ storage })
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'keep' })
    await child.run('keep')
    await child.close()
    const record = await storage.lookupByKey(child.key)
    expect(record?.state).toBe('completed')
    expect(await storage.existsSession(child.key)).toBe(true)
    await k.close()
  })
})

describe('CoreError', () => {
  it('is the class thrown for child limit failures', () => {
    expect(new CoreError('E_CHILD_LIMIT', 'x')).toBeInstanceOf(Error)
  })
})

it('children inherit the full-access chooser and lose stale admissions when the parent switches or closes', async () => {
  const k = kernel()
  try {
    const parent = await k.session('permission-parent', sessionOpts)
    const principal = { ...actor, id: 'full-access-chooser' }
    await parent.setYolo(true, principal)
    const handle = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'sign' })
    const child = k.get(handle.key)!
    expect(child.yolo).toBe(true)
    expect(child.permissionContext).toMatchObject({ policy: 'full-access', actor: principal })
    const port = child.decisions.port({
      owner: 'fixture/child',
      sourcePackage: '@fixture/child',
      packageVersion: '1',
      operationId: 'sign',
      alive() {},
    })
    const spec = {
      key: 'signature',
      purpose: 'business.confirm',
      subject: { revision: 0 },
      prompt: 'Sign?',
      options: ['allowed-once', 'rejected'],
      presentation: { en: { title: 'Sign', fields: [], responseValue: 'I confirm.' } },
      responseSchema: { type: 'string', enum: ['I confirm.'] },
    }
    const decision = await port.request(spec)
    expect((await port.get(decision)).result).toMatchObject({
      code: 'full-access',
      answeredBy: { id: principal.id },
    })
    const admission = await port.admit!(decision)
    await invalidatesProjection([child], () => parent.setYolo(false, actor), false)
    expect(child.yolo).toBe(false)
    expect(child.permissionContext.policy).not.toBe('full-access')
    expect(() => admission.assertActive()).toThrow('AUTHORITY_REVOKED')
    await child.setYolo(true, principal)
    expect(child.permissionContext.policy).not.toBe('full-access')
    await invalidatesProjection([child], () => parent.setYolo(true, principal), true)
    expect(() => admission.assertActive()).toThrow('AUTHORITY_REVOKED')
    const fresh = await port.request({ ...spec, key: 'fresh' })
    const active = await port.admit!(fresh)
    await invalidatesProjection([child], () => parent.close(), false)
    expect(() => active.assertActive()).toThrow()
    expect(child.permissionContext.policy).not.toBe('full-access')
  } finally {
    await k.close()
  }
})

it('invalidates live descendants on rebind and follows only their current parent without child switches', async () => {
  const k = kernel({
    preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 3, maxFanOut: 4 },
  })
  try {
    const parent = await k.session('original-parent', sessionOpts)
    const other = await k.session('replacement-parent', sessionOpts)
    await parent.setYolo(true, { ...actor, id: 'original-chooser' })
    const first = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'child' })
    const child = k.get(first.key)!
    const second = await child.d.children.create({ parent: child.key, cwd: '/w', input: 'grandchild' })
    const grandchild = k.get(second.key)!
    const descendants = [child, grandchild]
    await invalidatesProjection(descendants, () => parent.setYolo(false, actor), false)
    await invalidatesProjection(descendants, () => parent.setYolo(true, actor), true)
    await invalidatesProjection(descendants, () => child.inheritAutomaticPermissions(other), false)
    await parent.setYolo(false, actor)
    await parent.setYolo(true, actor)
    for (const session of descendants) expect((await session.projectUI()).yolo).toBe(false)
    const principal = { ...actor, id: 'replacement-chooser' }
    await invalidatesProjection(descendants, () => other.setYolo(true, principal), true)
    for (const session of descendants) expect(session.permissionContext.actor.id).toBe(principal.id)
    const failedNotice = vi
      .spyOn(child.d.log, 'append')
      .mockRejectedValueOnce(new Error('notification storage failed'))
    await other.setYolo(false, actor)
    failedNotice.mockRestore()
    for (const session of descendants) expect(session.permissionContext.policy).not.toBe('full-access')
    await invalidatesProjection(descendants, () => other.setYolo(true, principal), true)
    await invalidatesProjection(descendants, () => child.inheritAutomaticPermissions(undefined), false)
    await invalidatesProjection(descendants, () => child.inheritAutomaticPermissions(other), true)
    await invalidatesProjection(descendants, () => other.close(), false)
    for (const session of descendants) {
      // Forks retain their parent's historical rows; no switch may attest a choice for the child.
      const switches = await session.d.log.scan({ type: 'x/core/yolo-switch', limit: 20 })
      expect(
        switches.filter((row) => (row.data as { sessionKey?: string }).sessionKey === session.key),
      ).toEqual([])
    }
  } finally {
    await k.close()
  }
})

it("appends the projection notice only when a child's permission binding really changes", async () => {
  const k = kernel({
    preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 3, maxFanOut: 4 },
  })
  try {
    const parent = await k.session('notice-parent', sessionOpts)
    const other = await k.session('notice-other', sessionOpts)
    const created = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'child' })
    const child = k.get(created.key)!
    const notices = async () => {
      // The append is not awaited by the caller that triggers it, so let it land first.
      await new Promise((resolve) => setTimeout(resolve, 20))
      return (await child.d.log.scan({ type: 'x/core/permission-projection-invalidated', limit: 20 })).length
    }
    // Opening the child bound it to its parent for the first time: nothing changed, nothing is recorded.
    expect(await notices()).toBe(0)
    // Opening it again under the same parent (the already-open path of `Kernel.session`) changes nothing.
    child.inheritAutomaticPermissions(parent)
    expect(await notices()).toBe(0)
    // A real permission switch of the parent is recorded exactly once and wakes the live child.
    await invalidatesProjection([child], () => parent.setYolo(true, actor), true)
    expect(await notices()).toBe(1)
    // So is rebinding it to a different parent.
    await invalidatesProjection([child], () => child.inheritAutomaticPermissions(other), false)
    expect(await notices()).toBe(2)
    // Binding it to the parent it already has is not a change.
    child.inheritAutomaticPermissions(other)
    expect(await notices()).toBe(2)
  } finally {
    await k.close()
  }
})

it('reopened children cannot recover full access from a copied preset without their live parent', async () => {
  const storage = new MemoryStorage()
  const preset = {
    ...presetDefaults(),
    permission: 'full-access' as const,
    treeBudgetCredits: 100,
    generationLimit: 1,
    maxFanOut: 2,
  }
  const first = kernel({ storage, preset })
  const parent = await first.session('reopen-parent', sessionOpts)
  await parent.setYolo(true, actor)
  const handle = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'inspect' })
  expect(first.get(handle.key)?.permissionContext.policy).toBe('full-access')
  await first.close()
  const second = kernel({ storage, preset })
  try {
    const orphan = await second.session(handle.key, { ...sessionOpts, writerRunId: 'reopen-child' })
    expect(orphan.yolo).toBe(false)
    expect(orphan.permissionContext.policy).not.toBe('full-access')
    await orphan.setYolo(true, actor)
    expect(orphan.permissionContext.policy).not.toBe('full-access')
  } finally {
    await second.close()
  }
})

it('preserves idle resident and paused checkpoint children across parent close and reopens them on resume/sendMessage', async () => {
  const storage = new MemoryStorage()
  const provider = Object.assign(
    fakeProvider([
      textTurn('idle turn 1'),
      textTurn('paused turn 1'),
      textTurn('idle turn 2'),
      textTurn('paused turn 2'),
    ]),
    { models: () => [catalogue()] },
  )
  const preset = { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 8 }
  const first = kernel({ storage, provider, preset })
  const parent1 = await first.session('resume-parent', sessionOpts)
  const idleChild = await parent1.d.children.create({
    parent: parent1.key,
    cwd: '/w',
    input: 'keep idle',
    resident: true,
  })
  await idleChild.run('keep idle')
  const pausedChild = await parent1.d.children.create({
    parent: parent1.key,
    cwd: '/w',
    input: 'keep paused',
    resident: true,
  })
  await pausedChild.run('keep paused')
  await parent1.d.children.pause!(pausedChild.key, { reason: 'parent_pause' })
  // A non-idle ready child must still be cancelled when the parent closes.
  const readyChild = await parent1.d.children.create({
    parent: parent1.key,
    cwd: '/w',
    input: 'cancel ready',
  })
  await first.close()

  expect((await storage.lookupByKey(idleChild.key))?.state).toBe('idle')
  expect((await storage.lookupByKey(pausedChild.key))?.state).toBe('paused')
  expect((await storage.lookupByKey(readyChild.key))?.state).toBe('cancelled')

  const second = kernel({ storage, provider, preset })
  try {
    const parent2 = await second.session('resume-parent', { ...sessionOpts, writerRunId: 'r2' })
    const listing = await parent2.d.children.list!()
    expect(listing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: idleChild.key, status: 'idle', continuable: true }),
        expect.objectContaining({ id: pausedChild.key, status: 'paused' }),
        expect.objectContaining({ id: readyChild.key, status: 'cancelled', continuable: false }),
      ]),
    )

    // Turn-2 continuation of the preserved idle resident child succeeds in the fresh Kernel.
    const sentIdle = await parent2.d.children.sendMessage!(
      idleChild.key,
      'follow up idle',
      new AbortController().signal,
    )
    expect(sentIdle.messageId).toBeTruthy()
    await vi.waitFor(async () => {
      const snap = await parent2.d.children.inspect!(idleChild.key)
      expect(snap?.text).toBe('idle turn 2')
      expect(snap?.idle).toBe(true)
    })

    // Turn-2 resume + continuation of the preserved paused checkpoint child succeeds in the fresh Kernel.
    await parent2.d.children.resume!(pausedChild.key)
    const sentPaused = await parent2.d.children.sendMessage!(
      pausedChild.key,
      'follow up paused',
      new AbortController().signal,
    )
    expect(sentPaused.messageId).toBeTruthy()
    await vi.waitFor(async () => {
      const snap = await parent2.d.children.inspect!(pausedChild.key)
      expect(snap?.text).toBe('paused turn 2')
      expect(snap?.idle).toBe(true)
    })

    // Terminated child still refuses with E_UNSUPPORTED and its state in the error message.
    await expect(
      parent2.d.children.sendMessage!(readyChild.key, 'too late', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'E_UNSUPPORTED', message: expect.stringContaining('cancelled') })
  } finally {
    await second.close()
  }
})

it.each(['removed', 'replaced'] as const)(
  'preserves cold Continue and Collect while refusing a %s retained tool filter',
  async (corruption) => {
    const storage = new MemoryStorage()
    const provider = Object.assign(
      fakeProvider([textTurn('filtered turn 1'), textTurn('filtered turn 2'), textTurn('web turn 3')]),
      { models: () => [catalogue()] },
    )
    const preset = { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 8 }
    const first = kernel({ storage, provider, preset })
    const parent1 = await first.session('filter-parent', sessionOpts)
    const restricted = await parent1.d.children.create({
      parent: parent1.key,
      cwd: '/w',
      input: 'restricted child',
      resident: true,
      toolFilter: { allow: ['only_this'] },
    })
    await restricted.run('restricted child')
    expect(childSessionToolFilter(first.get(restricted.key)!)).toEqual({ allow: ['only_this'], deny: [] })

    // Keep the authority fields intact while corrupting the independently sealed filter.
    const unbound = await parent1.d.children.create({
      parent: parent1.key,
      cwd: '/w',
      input: 'unbound child',
      resident: true,
      toolFilter: { allow: ['only_this'] },
    })
    await unbound.run('unbound child')
    const unboundSession = first.get(unbound.key)!
    const [prior] = await unboundSession.scan({ type: 'x/core/child-retained', limit: 1 })
    const { toolFilter: _removed, ...sealed } = (
      prior!.data as {
        binding: { toolFilter: unknown; digest: string }
      }
    ).binding
    const binding = {
      ...sealed,
      ...(corruption === 'replaced' ? { toolFilter: { allow: ['unexpected_tool'], deny: [] } } : {}),
    }
    await unboundSession.append([
      unboundSession.ev('x/core/child-retained', { childKey: unbound.key, binding }, { ignorable: true }),
    ])
    await first.close()

    const second = kernel({ storage, provider, preset })
    try {
      const parent2 = await second.session('filter-parent', { ...sessionOpts, writerRunId: 'r2' })

      // 1. Cold collect returns 'idle' immediately (not 'running') with completion identity and text.
      const ctx = buildToolContext(
        {
          sessionKey: parent2.key,
          lane: parent2.lane,
          turn: 1,
          step: 1,
          depth: 0,
          generationDepth: 0,
          actor,
          cwd: '/w',
          workspaceRoot: '/w',
          runtime: parent2.d.runtime,
          preset: parent2.preset,
          children: parent2.d.children,
          fsOps: testFsOps(),
          netFetch: async () => new Response(''),
          log: parent2.d.logger,
          invoke: async () => ({ content: [] }),
          listTools: () => [],
          appendPlan: async () => 1,
          requestCompaction: () => {},
          progress: () => {},
          artifactJobEvent: async () => {},
          lease: { remainingMs: () => 5000 },
        },
        {
          toolUseId: 'collect-cold',
          name: 'subagent_collect',
          signal: new AbortController().signal,
          timeoutMs: 5000,
          outputMaxBytes: 32768,
        },
      )
      const collected = await ctx.subagent.collect(restricted.key, { wait: true })
      expect(collected).toMatchObject({
        childKey: restricted.key,
        status: 'idle',
        text: 'filtered turn 1',
      })
      const snap = await parent2.d.children.inspect!(restricted.key)
      expect(snap?.idle).toBe(true)
      expect(snap?.completionId).toBeTruthy()
      expect(snap?.completionSeq).toBeGreaterThan(0)

      expect(collected.completionId).toBe(snap?.completionId)
      expect(collected.completionSeq).toBe(snap?.completionSeq)

      // 2. Web control tree exposes controls.continue/pause/retain for pinned idle child, false for unbound child.
      const tree = await controlledChildTree(parent2)
      expect(tree.find((row) => row.id === restricted.key)?.controls).toMatchObject({
        continue: true,
        pause: true,
        retain: true,
      })
      expect(tree.find((row) => row.id === unbound.key)?.controls).toMatchObject({
        continue: false,
        pause: false,
        retain: false,
        close: true,
      })

      // 3. Unbound child fails closed on cold sendMessage, Web continue/retain, and direct retainChild.
      await expect(
        parent2.d.children.sendMessage!(unbound.key, 'should fail', new AbortController().signal),
      ).rejects.toMatchObject({ code: 'E_RELATION' })
      await expect(
        applyChildControl(parent2, unbound.key, 'continue', actor, 'adm-unbound', 'should fail'),
      ).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
      await expect(
        applyChildControl(parent2, unbound.key, 'retain', actor, 'adm-bad-retain'),
      ).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
      await expect(
        applyChildControl(parent2, unbound.key, 'pause', actor, 'adm-bad-pause'),
      ).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
      // Backend contract still refuses direct retainChild without a valid pinned binding.
      await expect(
        (parent2.d.children as unknown as { controls(): { retainChild(k: string): Promise<unknown> } })
          .controls()
          .retainChild(unbound.key),
      ).rejects.toMatchObject({ code: 'E_RELATION' })

      await applyChildControl(parent2, restricted.key, 'retain', actor, 'adm-cold-retain')
      expect(second.get(restricted.key)).toBeUndefined()
      await applyChildControl(parent2, restricted.key, 'pause', actor, 'adm-cold-pause')
      const paused = (await storage.lookupByKey(restricted.key))!
      const checkpoint = await readChildCheckpoint(parent2, paused)
      expect(checkpoint.binding?.toolFilter).toEqual({ allow: ['only_this'], deny: [] })
      expect(await ctx.subagent.collect(restricted.key, { wait: true })).toMatchObject({ status: 'paused' })
      await applyChildControl(parent2, restricted.key, 'resume', actor, 'adm-cold-resume')

      // 4. Cold Web continue reopens the restricted child AND preserves its exact toolFilter.
      await applyChildControl(parent2, restricted.key, 'continue', actor, 'adm-web-1', 'continue from web')
      await vi.waitFor(async () => {
        const s = await parent2.d.children.inspect!(restricted.key)
        expect(s?.text).toBe('web turn 3')
        expect(s?.idle).toBe(true)
      })
      expect(childSessionToolFilter(second.get(restricted.key)!)).toEqual({ allow: ['only_this'], deny: [] })
    } finally {
      await second.close()
    }
  },
)

function signalGate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('shuts down a paused in-flight driver without a terminal child or turn outcome', async () => {
  const storage = new MemoryStorage()
  const entered = signalGate()
  const release = signalGate()
  const provider = {
    models: () => [catalogue()],
    async *infer(req: Parameters<ReturnType<typeof fakeProvider>['infer']>[0]) {
      yield sentFor(req, sent())
      entered.resolve()
      await release.promise
      yield { type: 'text_delta', delta: 'settled work' } as const
      yield { type: 'done', reason: 'stop' } as const
    },
  }
  const first = kernel({ storage, provider })
  const root = await first.session('pause-in-flight', sessionOpts)
  const child = await root.d.children.createWithKind!('spawn', {
    parent: root.key,
    cwd: '/w',
    input: 'pause this work',
    resident: true,
  })
  const running = child.run('pause this work').catch(() => undefined)
  await entered.promise
  const live = first.get(child.key)!
  const pausing = root.d.children.pause!(child.key)
  await vi.waitFor(async () => expect(await live.controls.paused()).toBe(true))
  release.resolve()
  await expect(pausing).resolves.toMatchObject({ status: 'paused' })
  await first.close()
  await running
  expect(await storage.lookupByKey(child.key)).toMatchObject({ state: 'paused' })
  expect(await storage.scan(child.key, { type: 'turn/end', limit: 1 })).toHaveLength(0)

  const second = kernel({ storage, provider })
  try {
    const reopened = await second.session(root.key, { ...sessionOpts, writerRunId: 'r2' })
    await reopened.d.children.resume!(child.key)
    await vi.waitFor(async () =>
      expect(await reopened.d.children.inspect!(child.key)).toMatchObject({
        status: 'idle',
        text: 'settled work',
      }),
    )
  } finally {
    await second.close()
  }
})

it.each(['idle', 'paused'] as const)(
  'controls a cold grandchild with a %s intermediate owner',
  async (state) => {
    const storage = new MemoryStorage()
    const preset = { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 2, maxFanOut: 8 }
    const first = kernel({ storage, preset })
    const root = await first.session('nested-cold', sessionOpts)
    const parent = await root.d.children.create({
      parent: root.key,
      cwd: '/w',
      input: 'middle',
      resident: true,
    })
    await parent.run('middle')
    const middle = first.get(parent.key)!
    const child = await middle.d.children.create({
      parent: middle.key,
      cwd: '/w',
      input: 'grandchild',
      resident: true,
    })
    await child.run('grandchild')
    if (state === 'paused') await root.d.children.pause!(parent.key)
    await first.close()

    const second = kernel({ storage, preset })
    try {
      const reopened = await second.session(root.key, { ...sessionOpts, writerRunId: 'r2' })
      expect(second.get(parent.key)).toBeUndefined()
      expect(await controlledChildTree(reopened)).toMatchObject([
        { id: parent.key, status: state },
        { id: child.key, parentId: parent.key, status: 'idle', controls: { pause: true } },
      ])
      await applyChildControl(reopened, child.key, 'pause', actor, 'grandchild-pause')
      expect(await storage.lookupByKey(parent.key)).toMatchObject({ state })
      expect(await storage.lookupByKey(child.key)).toMatchObject({ state: 'paused' })
      await applyChildControl(reopened, child.key, 'resume', actor, 'grandchild-resume')
      await applyChildControl(reopened, child.key, 'close', actor, 'grandchild-close')
      expect(await storage.lookupByKey(child.key)).toMatchObject({ state: 'completed' })
    } finally {
      await second.close()
    }
  },
)

function makeToolContext(parent: SessionImpl) {
  return buildToolContext(
    {
      sessionKey: parent.key,
      lane: parent.lane,
      turn: 1,
      step: 1,
      depth: 0,
      generationDepth: 0,
      actor,
      cwd: '/w',
      workspaceRoot: '/w',
      runtime: parent.d.runtime,
      preset: parent.preset,
      children: parent.d.children,
      fsOps: testFsOps(),
      netFetch: async () => new Response(''),
      log: parent.d.logger,
      invoke: async () => ({ content: [] }),
      listTools: () => [],
      appendPlan: async () => 1,
      requestCompaction: () => {},
      progress: () => {},
      artifactJobEvent: async () => {},
      lease: { remainingMs: () => 5000 },
    },
    {
      toolUseId: 'subagent-tool',
      name: 'subagent_collect',
      signal: new AbortController().signal,
      timeoutMs: 5000,
      outputMaxBytes: 32768,
    },
  )
}

it('fails retryably on cold ledger read error without ACK, preserves list tolerance and zero-seq cancel (#04)', async () => {
  const storage = new MemoryStorage()
  const provider = Object.assign(fakeProvider([textTurn('real completed text')]), {
    models: () => [catalogue()],
  })
  const first = kernel({ storage, provider })
  const parent1 = await first.session('cold-read-parent', sessionOpts)
  const completed = await parent1.d.children.createWithKind!('spawn', {
    parent: parent1.key,
    cwd: '/w',
    input: 'finish work',
  })
  await completed.run('finish work')
  const deferredCancelled = await parent1.d.children.createWithKind!('spawn', {
    parent: parent1.key,
    cwd: '/w',
    input: 'never started',
    start: false,
  })
  await parent1.d.children.cancel!(deferredCancelled.key)
  await first.close()

  const second = kernel({ storage, provider })
  try {
    const parent2 = await second.session('cold-read-parent', { ...sessionOpts, writerRunId: 'r2' })
    const ctx = makeToolContext(parent2)
    const origScan = storage.scan.bind(storage)
    let failReads = true
    vi.spyOn(storage, 'scan').mockImplementation(async (key, q) => {
      if (failReads && key === completed.key) throw new Error('transient EIO')
      return origScan(key, q)
    })

    // List degrades gracefully to known durable state; snapshotFromLedger omits claimable completionId.
    const listing = await parent2.d.children.list!()
    expect(listing.find((row) => row.id === completed.key)).toMatchObject({ status: 'completed' })
    const snap = await snapshotFromLedger(parent2, (await storage.lookupByKey(completed.key))!)
    expect(snap.ledgerReadFailed).toBe(true)
    expect(snap.completionId).toBeUndefined()
    expect(snap.completionSeq).toBeUndefined()

    // Explicit collect throws a retryable error and writes NO collected ACK.
    await expect(ctx.subagent.collect(completed.key)).rejects.toMatchObject({
      code: 'E_STORAGE_FAULT',
      detail: expect.objectContaining({ retryable: true }),
    })
    const acksDuringFault = await parent2.scan({ type: 'x/core/child-result-collected', limit: 20 })
    expect(
      acksDuringFault.filter((row) => (row.data as { childKey?: string }).childKey === completed.key),
    ).toEqual([])

    // Once storage recovers, collect returns the real text and completion identity and writes the ACK.
    failReads = false
    const recovered = await ctx.subagent.collect(completed.key)
    expect(recovered).toMatchObject({
      childKey: completed.key,
      status: 'completed',
      text: 'real completed text',
    })
    expect(recovered.completionId).toBeTruthy()
    expect(recovered.completionSeq).toBeGreaterThan(0)
    const acksAfter = await parent2.scan({ type: 'x/core/child-result-collected', limit: 20 })
    expect(
      acksAfter.some(
        (row) =>
          (row.data as { childKey?: string; resultSeq?: number }).childKey === completed.key &&
          (row.data as { resultSeq?: number }).resultSeq === recovered.completionSeq,
      ),
    ).toBe(true)

    // Legitimate zero-seq cancel still collects and ACKs cleanly.
    const cancelledRes = await ctx.subagent.collect(deferredCancelled.key)
    expect(cancelledRes).toMatchObject({
      childKey: deferredCancelled.key,
      status: 'cancelled',
      completionSeq: 0,
    })
    expect(cancelledRes.completionId).toBeTruthy()
  } finally {
    vi.restoreAllMocks()
    await second.close()
  }
})

it('settles cold cancel to cancelled when stopped, keeps cancelling when unconfirmed/leased, and reconciles CAS races (#05)', async () => {
  const storage = new MemoryStorage()
  const preset = { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 1 }
  const provider = Object.assign(
    fakeProvider([textTurn('paused a'), textTurn('fresh b'), textTurn('unconfirmed c')]),
    { models: () => [catalogue()] },
  )
  const first = kernel({ storage, provider, preset })
  const parent1 = await first.session('cold-cancel-parent', sessionOpts)
  const childA = await parent1.d.children.createWithKind!('spawn', {
    parent: parent1.key,
    cwd: '/w',
    input: 'pause me',
    resident: true,
  })
  await childA.run('pause me')
  await parent1.d.children.pause!(childA.key)
  await first.close()

  const second = kernel({ storage, provider, preset })
  try {
    const parent2 = await second.session('cold-cancel-parent', { ...sessionOpts, writerRunId: 'r2' })
    const ctx = makeToolContext(parent2)

    // Cold paused child with no live writer lease settles to cancelled and frees the fan-out slot.
    const cancelled = await ctx.subagent.cancel(childA.key)
    expect(cancelled).toMatchObject({
      childKey: childA.key,
      status: 'cancelled',
      executionState: 'cancelled',
    })
    expect((await storage.lookupByKey(childA.key))?.state).toBe('cancelled')
    expect((await parent2.d.children.list!()).find((row) => row.id === childA.key)).toMatchObject({
      status: 'cancelled',
      executionState: 'cancelled',
    })
    expect(await ctx.subagent.collect(childA.key)).toMatchObject({
      status: 'cancelled',
      executionState: 'cancelled',
    })

    // Fan-out slot (maxFanOut=1) is free after cold cancel settled to cancelled.
    const childB = await parent2.d.children.createWithKind!('spawn', {
      parent: parent2.key,
      cwd: '/w',
      input: 'second slot',
      resident: true,
    })
    await childB.run('second slot')
    await parent2.d.children.pause!(childB.key)
    // Inject an unconfirmed stop receipt and drop local handle by reopening in a third kernel.
    const childBSession = second.get(childB.key)!
    await childBSession.append([
      childBSession.ev(
        'x/core/child-stop-receipt',
        {
          childKey: childB.key,
          toolUseId: 't1',
          toolName: 'write_note',
          cancelRequestedAt: 1,
          toolReturnedAt: null,
          terminalConfirmedAt: null,
          disposition: 'timed_out_unknown',
        },
        { ignorable: true },
      ),
    ])
    await second.close()

    const third = kernel({ storage, provider, preset })
    try {
      const parent3 = await third.session('cold-cancel-parent', { ...sessionOpts, writerRunId: 'r3' })
      const ctx3 = makeToolContext(parent3)
      const unconfirmed = await ctx3.subagent.cancel(childB.key)
      expect(unconfirmed).toMatchObject({
        childKey: childB.key,
        status: 'running',
        executionState: 'cancelling',
      })
      expect((await storage.lookupByKey(childB.key))?.state).toBe('cancelling')
      expect((await parent3.d.children.list!()).find((row) => row.id === childB.key)).toMatchObject({
        status: 'running',
        executionState: 'cancelling',
      })
      expect(await ctx3.subagent.collect(childB.key)).toMatchObject({
        status: 'running',
        executionState: 'cancelling',
      })
      // Unconfirmed cancelling child still holds the fan-out slot.
      await expect(
        parent3.d.children.createWithKind!('spawn', {
          parent: parent3.key,
          cwd: '/w',
          input: 'blocked by cancelling',
        }),
      ).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })

      // CAS race: if the child moves to completed concurrently, cancel re-reads and reports completed.
      const rowB = (await storage.lookupByKey(childB.key))!
      // Create a fresh cold child C whose casState('cancelling') races with an external 'completed' transition.
      const fourth = kernel({
        storage,
        provider,
        preset: { ...preset, maxFanOut: 4 },
      })
      try {
        const parent4 = await fourth.session('cold-cancel-race', { ...sessionOpts, writerRunId: 'r4' })
        const childC = await parent4.d.children.createWithKind!('spawn', {
          parent: parent4.key,
          cwd: '/w',
          input: 'race child',
          resident: true,
        })
        await childC.run('race child')
        await parent4.d.children.pause!(childC.key)
        await fourth.close()
        const fifth = kernel({ storage, provider, preset: { ...preset, maxFanOut: 4 } })
        try {
          const parent5 = await fifth.session('cold-cancel-race', { ...sessionOpts, writerRunId: 'r5' })
          const origCas = storage.casState.bind(storage)
          let raced = false
          vi.spyOn(storage, 'casState').mockImplementation(async (k, rev, next, adm) => {
            if (!raced && k === childC.key && next === 'cancelling') {
              raced = true
              await origCas(k, rev, 'completed')
              return false
            }
            return origCas(k, rev, next, adm)
          })
          const racedRes = await makeToolContext(parent5).subagent.cancel(childC.key)
          expect(racedRes).toMatchObject({
            childKey: childC.key,
            status: 'completed',
            executionState: 'completed',
          })
          expect((await storage.lookupByKey(childC.key))?.state).toBe('completed')
          expect(rowB.state).toBe('cancelling')
        } finally {
          vi.restoreAllMocks()
          await fifth.close()
        }
      } finally {
        await fourth.close()
      }
    } finally {
      await third.close()
    }
  } finally {
    await second.close()
  }
})

it('reopens a cold paused role ancestor through its pinned composition without cancelling on reopen failure (#06 & #18)', async () => {
  const storage = new MemoryStorage()
  const rootPreset = { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 2, maxFanOut: 8 }
  const rolePreset = {
    ...presetDefaults(),
    name: 'role-specialist',
    permission: 'read-only' as const,
    treeBudgetCredits: 100,
    generationLimit: 2,
    maxFanOut: 8,
  }
  const roleRef = { ref: '@test/app#specialist' as const, title: { en: 'Specialist' } }
  const provider = Object.assign(
    fakeProvider([
      textTurn('role turn 1'),
      textTurn('grandchild turn 1'),
      textTurn('forged grandchild turn 1'),
      textTurn('grandchild turn 2'),
    ]),
    { models: () => [catalogue()] },
  )

  const openRoleIn = (hostKernel: Kernel, failNext: () => boolean, count: { reopens: number }) => ({
    list: async () => [roleRef],
    resolve: async (parent: SessionImpl) => ({
      role: roleRef,
      open: async (key: string, options: Parameters<Kernel['session']>[1]) => {
        const s = await hostKernel.session(key, {
          ...options,
          preset: rolePreset,
          policyDigest: 'role-policy-digest',
        })
        await s.append([
          s.ev(
            ROLE_DELEGATION,
            {
              role: roleRef,
              parentKey: parent.key,
              actor,
              tools: ['read_only'],
              generationLimit: 2,
              maxFanOut: 8,
              permission: 'read-only',
              approvalPolicy: 'never',
              parentPolicy: 'default',
              sandboxRequired: false,
              filesystem: fakeSeams().sandbox.fsPolicy(),
            },
            { ignorable: true },
          ),
        ])
        return s
      },
    }),
    reopen: async (key: string, options: Parameters<Kernel['session']>[1]) => {
      count.reopens += 1
      if (failNext()) throw new CoreError('E_UNSUPPORTED', 'injected role reopen failure')
      return hostKernel.session(key, {
        ...options,
        preset: rolePreset,
        policyDigest: 'role-policy-digest',
      })
    },
  })

  const firstRoleKernel = kernel({ storage, provider, preset: rolePreset })
  const count = { reopens: 0 }
  const firstRootKernel = kernel({
    storage,
    provider,
    preset: rootPreset,
    childRoles: openRoleIn(firstRoleKernel, () => false, count),
  })
  const root1 = await firstRootKernel.session('role-tree-root', sessionOpts)
  const roleHandle = await root1.d.children.createWithKind!('spawn', {
    parent: root1.key,
    cwd: '/w',
    input: 'role parent',
    role: roleRef.ref,
    resident: true,
    toolFilter: { allow: ['read_only'] },
  })
  await roleHandle.run('role parent')
  const roleSession = firstRoleKernel.get(roleHandle.key)!
  // Grandchild G under role R (different preset & policyDigest from root!) with narrow toolFilter.
  const grand = await roleSession.d.children.create({
    parent: roleSession.key,
    cwd: '/w',
    input: 'grandchild work',
    resident: true,
    toolFilter: { allow: ['read_only'] },
  })
  await grand.run('grandchild work')
  // Second grandchild G2 whose retained authority is forged to root's authority (with valid self-digest).
  const forged = await roleSession.d.children.create({
    parent: roleSession.key,
    cwd: '/w',
    input: 'forged grandchild',
    resident: true,
    toolFilter: { allow: ['read_only'] },
  })
  await forged.run('forged grandchild')
  const forgedSession = firstRoleKernel.get(forged.key)!
  const rootAuthority = sha256Hex(
    canonicalJson({
      profile: root1.d.resolvedProfileHash,
      policy: root1.d.policyDigest,
      preset: root1.preset,
      actor: root1.d.actor,
      loop: root1.loop,
    }),
  )
  const forgedPinned = {
    authority: rootAuthority,
    generationDepth: 2,
    cwd: '/w',
    toolFilter: { allow: ['read_only'], deny: [] },
  }
  await forgedSession.append([
    forgedSession.ev(
      'x/core/child-retained',
      {
        childKey: forged.key,
        binding: {
          ...forgedPinned,
          digest: sha256Hex(canonicalJson({ childKey: forged.key, ...forgedPinned })),
        },
      },
      { ignorable: true },
    ),
  ])

  await root1.d.children.pause!(roleHandle.key)
  const pausedRoleBefore = { ...(await storage.lookupByKey(roleHandle.key))! }
  const roleCheckpointBefore = await readChildCheckpoint(root1, pausedRoleBefore)
  await firstRootKernel.close()
  await firstRoleKernel.close()

  let injectReopenFail = true
  const secondRoleKernel = kernel({ storage, provider, preset: rolePreset })
  const secondRootKernel = kernel({
    storage,
    provider,
    preset: rootPreset,
    childRoles: openRoleIn(secondRoleKernel, () => injectReopenFail, count),
  })
  try {
    const root2 = await secondRootKernel.session('role-tree-root', { ...sessionOpts, writerRunId: 'r2' })
    // #18: Cold tree shows valid grandchild as continuable even when intermediate role has different preset/policy.
    const tree = await controlledChildTree(root2)
    expect(tree.find((row) => row.id === grand.key)?.controls).toMatchObject({
      continue: true,
      pause: true,
      retain: true,
    })

    // #06: Injected role reopen failure MUST NOT mutate paused role ancestor R to cancelled.
    await expect(applyChildControl(root2, grand.key, 'pause', actor, 'adm-fail')).rejects.toThrow(
      'injected role reopen failure',
    )
    expect(await storage.lookupByKey(roleHandle.key)).toMatchObject({
      state: 'paused',
      stateRevision: pausedRoleBefore.stateRevision,
    })
    expect(await readChildCheckpoint(root2, (await storage.lookupByKey(roleHandle.key))!)).toEqual(
      roleCheckpointBefore,
    )
    expect(await storage.lookupByKey(grand.key)).toMatchObject({ state: 'idle' })

    // #06: Clear failure — pausing grandchild reopens role R through pinned Host composition, keeping R paused.
    injectReopenFail = false
    const reopensBefore = count.reopens
    await applyChildControl(root2, grand.key, 'pause', actor, 'adm-pause-g')
    expect(count.reopens).toBeGreaterThan(reopensBefore)
    expect(await storage.lookupByKey(roleHandle.key)).toMatchObject({
      state: 'paused',
      stateRevision: pausedRoleBefore.stateRevision,
    })
    expect(await secondRoleKernel.get(roleHandle.key)!.controls.paused()).toBe(true)
    expect(childSessionToolFilter(secondRoleKernel.get(roleHandle.key)!)).toEqual({
      allow: ['read_only'],
      deny: [],
    })
    expect(await storage.lookupByKey(grand.key)).toMatchObject({ state: 'paused' })

    // #18: Resume and continue valid grandchild under direct role parent's pinned authority; toolFilter preserved.
    await applyChildControl(root2, grand.key, 'resume', actor, 'adm-resume-g')
    await applyChildControl(root2, grand.key, 'continue', actor, 'adm-cont-g', 'follow up under role')
    await vi.waitFor(async () => {
      const snap = await secondRoleKernel.get(roleHandle.key)!.d.children.inspect!(grand.key)
      expect(snap?.text).toBe('grandchild turn 2')
      expect(snap?.idle).toBe(true)
    })
    expect(childSessionToolFilter(secondRoleKernel.get(grand.key)!)).toEqual({
      allow: ['read_only'],
      deny: [],
    })

    // #18: Grandchild whose binding was forged with root's authority is refused under direct role parent's authority.
    await expect(
      applyChildControl(root2, forged.key, 'continue', actor, 'adm-forged', 'should refuse'),
    ).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
  } finally {
    await secondRootKernel.close()
    await secondRoleKernel.close()
  }
})

it('refuses a forged-authority cold grandchild when direct parent is reopened on demand (#18)', async () => {
  const storage = new MemoryStorage()
  const rootPreset = { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 2, maxFanOut: 8 }
  const rolePreset = {
    ...presetDefaults(),
    name: 'role-b',
    permission: 'read-only' as const,
    treeBudgetCredits: 100,
    generationLimit: 2,
    maxFanOut: 8,
  }
  const roleRef = { ref: '@test/app#spec2' as const, title: { en: 'Spec2' } }
  const provider = Object.assign(fakeProvider([textTurn('r1'), textTurn('g1')]), {
    models: () => [catalogue()],
  })
  const makeRoles = (hostKernel: Kernel) => ({
    list: async () => [roleRef],
    resolve: async (parent: SessionImpl) => ({
      role: roleRef,
      open: async (key: string, options: Parameters<Kernel['session']>[1]) => {
        const s = await hostKernel.session(key, { ...options, preset: rolePreset, policyDigest: 'p-role' })
        await s.append([
          s.ev(
            ROLE_DELEGATION,
            {
              role: roleRef,
              parentKey: parent.key,
              actor,
              tools: [],
              generationLimit: 2,
              maxFanOut: 8,
              permission: 'read-only',
              approvalPolicy: 'never',
              parentPolicy: 'default',
              sandboxRequired: false,
              filesystem: fakeSeams().sandbox.fsPolicy(),
            },
            { ignorable: true },
          ),
        ])
        return s
      },
    }),
    reopen: async (key: string, options: Parameters<Kernel['session']>[1]) =>
      hostKernel.session(key, { ...options, preset: rolePreset, policyDigest: 'p-role' }),
  })
  const rk1 = kernel({ storage, provider, preset: rolePreset })
  const k1 = kernel({ storage, provider, preset: rootPreset, childRoles: makeRoles(rk1) })
  const root1 = await k1.session('forged-root', sessionOpts)
  const role = await root1.d.children.createWithKind!('spawn', {
    parent: root1.key,
    cwd: '/w',
    input: 'role',
    role: roleRef.ref,
    resident: true,
  })
  await role.run('role')
  const roleSession = rk1.get(role.key)!
  const forged = await roleSession.d.children.create({
    parent: roleSession.key,
    cwd: '/w',
    input: 'forged',
    resident: true,
  })
  await forged.run('forged')
  const forgedSession = rk1.get(forged.key)!
  const pinned = { authority: 'wrong-authority', generationDepth: 2, cwd: '/w' }
  await forgedSession.append([
    forgedSession.ev(
      'x/core/child-retained',
      {
        childKey: forged.key,
        binding: { ...pinned, digest: sha256Hex(canonicalJson({ childKey: forged.key, ...pinned })) },
      },
      { ignorable: true },
    ),
  ])
  await k1.close()
  await rk1.close()

  const rk2 = kernel({ storage, provider, preset: rolePreset })
  const k2 = kernel({ storage, provider, preset: rootPreset, childRoles: makeRoles(rk2) })
  try {
    const root2 = await k2.session('forged-root', { ...sessionOpts, writerRunId: 'r2' })
    await expect(
      applyChildControl(root2, forged.key, 'continue', actor, 'adm-forged-cold', 'nope'),
    ).rejects.toMatchObject({
      code: 'E_RELATION',
      detail: expect.objectContaining({ reason: 'BINDING_AUTHORITY_MISMATCH' }),
    })
  } finally {
    await k2.close()
    await rk2.close()
  }
})

it('hides pause and retain for legacy cold idle children missing a pinned binding', async () => {
  const storage = new MemoryStorage()
  const k = kernel({ storage })
  try {
    const parent = await k.session('legacy-idle-root', sessionOpts)
    await storage.ensureRootScope('root', 10_000_000n)
    const created = await storage.createDelegatedChild({
      fresh: true,
      childKey: `${parent.key}/legacy`,
      parentKey: parent.key,
      boundarySeq: 0,
      creationId: 'legacy-1',
      kind: 'spawn',
      rootTaskId: 'root',
      runtimeOwnerSessionKey: parent.key,
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 4,
      inputHash: 'h',
      inputText: 'legacy idle child',
      cwd: '/w',
      actorId: actor.id,
      isolation: 'shared',
      workspaceId: 'ws:legacy',
      treeCapMicro: 10_000_000n,
      childCapMicro: null,
      writerRunId: 'w',
    })
    if (created.status !== 'created') throw new Error('expected created')
    await storage.casState(created.record.childKey, created.record.stateRevision, 'idle')
    const tree = await controlledChildTree(parent)
    expect(tree.find((row) => row.id === created.record.childKey)?.controls).toMatchObject({
      pause: false,
      retain: false,
      continue: false,
      close: true,
    })
    await expect(
      applyChildControl(parent, created.record.childKey, 'pause', actor, 'adm-legacy-pause'),
    ).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    await expect(
      applyChildControl(parent, created.record.childKey, 'retain', actor, 'adm-legacy-retain'),
    ).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    await expect(parent.d.children.pause!(created.record.childKey)).rejects.toMatchObject({
      code: 'E_RELATION',
    })
    await expect(childControls(parent).retainChild(created.record.childKey)).rejects.toMatchObject({
      code: 'E_RELATION',
    })
  } finally {
    await k.close()
  }
})
