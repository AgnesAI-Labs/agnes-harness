import { CHILD_CONTROL_FORMAT } from '@agnes/core-child-control/child/types'
import { presetDefaults } from '@agnes/core-common/step/preset'
import { CoreError } from '@agnes/core-common/types'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { Kernel } from '../src/kernel.js'
import type { SessionImpl } from '../src/step/session.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'

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
    for (const session of sessions) expect((await session.projectUI()).yolo).toBe(enabled)
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
