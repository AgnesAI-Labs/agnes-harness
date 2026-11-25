import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capToMicrocredits } from '@agnes/core-child-control/child/credits'
import { requireChildControl } from '@agnes/core-child-control/child/store'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { CreateDelegatedChildInput } from '@agnes/extension-api'
import { createSqliteStorage } from '@agnes/host-infrastructure/adapters/storage-sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  childPromptBinding,
  childPromptSections,
  compactChildHandoff,
  RESULT_DELIVERY_GUIDANCE,
} from '../src/child/child-prompt-budget.js'
import { recoverChildCompletions } from '../src/child/completion-notice.js'
import {
  ChildNoticeCoalescer,
  completionBatch,
  deliverCoalescedChildCompletion,
  pollWaitMetadata,
} from '../src/child/notice-coalescer.js'
import {
  ChildAdmissionGuard,
  computeRemainingTreeCredits,
  formatSpawnBudgetRefusal,
} from '../src/child/tree-admission.js'
import {
  checkUncertainRetryFence,
  listUncertainEffects,
  markUncertainEffectsVerified,
  recordUncertainEffect,
  resolveUncertainEffectFromHuman,
  restoreUncertainEffectFence,
} from '../src/execution/turn/unknown-outcome-fence.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, writeTool } from './helpers/open-session.js'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  while (cleanup.length) await cleanup.pop()?.()
})

async function budgetStore(backend: 'memory' | 'sqlite', cap: number) {
  const sqlite = () => {
    const dir = mkdtempSync(join(tmpdir(), 'item07-budget-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    cleanup.push(() => storage.close())
    return storage
  }
  const storage = backend === 'sqlite' ? sqlite() : new MemoryStorage()
  await storage.open('parent', { writerRunId: 'writer', ttlMs: 10_000 })
  const store = requireChildControl(storage)
  await store.ensureRootScope('root', capToMicrocredits(cap))
  const input = (id: string, budget: number | null) => childInput(cap, id, budget)
  return { store, input }
}

function childInput(cap: number, id: string, budget: number | null): CreateDelegatedChildInput {
  return {
    childKey: `parent/${id}`,
    creationId: id,
    attemptId: `attempt/${id}`,
    parentKey: 'parent',
    boundarySeq: 0,
    kind: 'spawn',
    rootTaskId: 'root',
    runtimeOwnerSessionKey: 'parent',
    generationDepth: 1,
    generationLimit: 3,
    maxFanOut: 4,
    inputHash: 'task',
    inputText: 'work',
    cwd: '/w',
    actorId: 'owner',
    isolation: 'shared',
    workspaceId: `ws/${id}`,
    treeCapMicro: capToMicrocredits(cap),
    childCapMicro: budget === null ? null : capToMicrocredits(budget),
    writerRunId: 'writer',
  }
}

describe.each(['memory', 'sqlite'] as const)('%s child admission', (backend) => {
  it.each([
    [3, 2],
    [15, 10],
  ])('admits one of three concurrent requests under a %i-credit tree', async (cap, budget) => {
    const { store, input } = await budgetStore(backend, cap)
    const outcomes = await Promise.allSettled(
      ['a', 'b', 'c'].map((id) => ChildAdmissionGuard.reserve(store, input(id, budget))),
    )
    const winners = outcomes.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    expect(winners).toHaveLength(1)
    expect(await store.listByRoot('root')).toHaveLength(1)
    for (const result of outcomes) {
      if (result.status === 'rejected')
        expect(formatSpawnBudgetRefusal(result.reason)).toMatchObject({
          isError: true,
          details: { code: 'E_BUDGET', remainingCredits: cap - budget, requestedCredits: budget },
        })
    }
    expect(await computeRemainingTreeCredits(store, 'root')).toBe(cap - budget)
    await winners[0]?.release()
    expect(await computeRemainingTreeCredits(store, 'root')).toBe(cap)
  })

  it.each(['completed', 'cancelled', 'failed'] as const)(
    'returns only unspent cap when a child is %s',
    async (state) => {
      const { store, input } = await budgetStore(backend, 3)
      const guard = await ChildAdmissionGuard.reserve(store, input('a', 2))
      await guard.bind(async (r) => {
        expect(await store.commitCreatingChild({ ...r, expectedRevision: r.creationRevision })).toBe(true)
      })
      guard.commit()
      await guard.release()
      const reservation = await store.reserve({
        rootTaskId: 'root',
        scopeIds: guard.record.ancestorScopeIds,
        qMicro: 500_000n,
        effectId: 'charge',
        requestHash: 'h',
        writerGeneration: 1,
      })
      if (!reservation.ok) throw new Error('expected child spend reservation')
      expect(await computeRemainingTreeCredits(store, 'root')).toBe(1)
      await store.settleOrigin({
        permitId: reservation.permitId,
        originSessionKey: guard.record.childKey,
        originCostSeq: 1,
        actualMicro: 250_000n,
        complete: true,
        creditSource: 'estimated',
      })
      expect(await computeRemainingTreeCredits(store, 'root')).toBe(1)
      expect(await store.casState(guard.record.childKey, guard.record.stateRevision, state)).toBe(true)
      expect(await computeRemainingTreeCredits(store, 'root')).toBe(2.75)
      await (await ChildAdmissionGuard.reserve(store, input('replacement', 2.75))).release()
    },
  )

  it.each(['throw', 'abort'])('releases the only slot and cap after %s during bind', async (failure) => {
    const { store, input } = await budgetStore(backend, 1)
    const req = { ...input('a', 1), maxFanOut: 1 }
    const first = await ChildAdmissionGuard.reserve(store, req)
    const observer = await ChildAdmissionGuard.reserve(store, req)
    await observer.release()
    await expect(
      ChildAdmissionGuard.reserve(store, { ...input('b', 1), maxFanOut: 1 }),
    ).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })
    const controller = new AbortController()
    await expect(
      first.bind(async () => {
        if (failure === 'throw') throw new Error(failure)
        controller.abort(new Error('abort'))
      }, controller.signal),
    ).rejects.toThrow(failure)
    await Promise.all([first.release(), first.release()])
    expect(await store.lookupByKey(req.childKey)).toMatchObject({
      state: 'failed',
      creationPhase: 'cancelled',
    })
    await (await ChildAdmissionGuard.reserve(store, { ...input('b', 1), maxFanOut: 1 })).release()
  })

  it('accounts for unbounded children and keeps their floor out of spend', async () => {
    const { store, input } = await budgetStore(backend, 3)
    const first = await ChildAdmissionGuard.reserve(store, input('unbounded', null))
    expect(await computeRemainingTreeCredits(store, 'root', 4)).toBe(2.25)
    await expect(ChildAdmissionGuard.reserve(store, input('too-big', 3))).rejects.toMatchObject({
      code: 'E_BUDGET',
    })
    await first.release()
    expect(await computeRemainingTreeCredits(store, 'root', 4)).toBe(3)
  })
})

const mutation = {
  toolUseId: 'u1',
  name: 'payment_charge',
  args: { paymentId: 'p1', amount: 15 },
  resolvedPolicy: { isReadOnly: false, replay: 'never' },
}
const read = { name: 'payment_status', args: { paymentId: 'p1' }, isReadOnly: true }
async function fenceSession(storage = new MemoryStorage(), key = 'test') {
  const { session } = await openSession({ key, storage, provider: fakeProvider([]) })
  cleanup.push(() => session.close())
  return session
}

describe('uncertain outcomes', () => {
  it('blocks a canonical or same-payment retry until a matching successful read', async () => {
    const s = await fenceSession()
    let effects = 0
    const dispatch = async (call: typeof mutation) => {
      const refused = await checkUncertainRetryFence(s, call)
      if (refused) return refused.code
      effects++
      await recordUncertainEffect(s, call, 'effect1')
      return 'TOOL_OUTCOME_UNKNOWN'
    }
    expect(await dispatch(mutation)).toBe('TOOL_OUTCOME_UNKNOWN')
    const retry = { ...mutation, toolUseId: 'u2', args: { amount: 15, paymentId: 'p1' } }
    expect(await dispatch(retry)).toBe('E_VERIFICATION_REQUIRED')
    await markUncertainEffectsVerified(s, 'files', { name: 'list_files', args: {}, isReadOnly: true })
    await markUncertainEffectsVerified(s, 'other', { ...read, args: { paymentId: 'p2' } })
    await markUncertainEffectsVerified(s, 'write', { ...read, isReadOnly: false })
    expect(await dispatch({ ...retry, args: { amount: 16, paymentId: 'p1' } })).toBe(
      'E_VERIFICATION_REQUIRED',
    )
    expect(effects).toBe(1)
    expect(await listUncertainEffects(s)).toMatchObject([
      { toolName: mutation.name, effectId: 'effect1', argsHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ])
    await markUncertainEffectsVerified(s, 'read', read)
    expect(await checkUncertainRetryFence(s, retry)).toBeUndefined()
  })

  it('hydrates a real unknown settlement without a live marker and consumes the parked human answer', async () => {
    const storage = new MemoryStorage()
    const registry = new ToolRegistry()
    let effects = 0
    registry.add(
      writeTool(async () => {
        effects++
        throw new Error('connection lost after send')
      }),
      { source: 'test', trust: 'builtin' },
    )
    const args = {}
    const { session } = await openSession({
      storage,
      registry,
      provider: fakeProvider([toolTurn('write_note', args), textTurn('done')]),
      seams: fakeSeams({
        approval: { ask: async () => ({ ticket: 'T1', expiresAt: '2099-01-01T00:00:00Z' }) },
      }),
    })
    cleanup.push(() => session.close())
    const run = () => session.run({ until: 'turn-end', signal: new AbortController().signal })
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'run' }] })
    expect((await run()).reason).toBe('parked')
    const retry = { ...mutation, name: 'write_note', args }
    expect((await checkUncertainRetryFence(session, retry))?.code).toBe('E_VERIFICATION_REQUIRED')
    const question = (await session.decisions.list()).find((d) => d.request.owner === 'core/unknown-outcome')
    if (!question) throw new Error('missing reconciliation')
    await session.decisions.answer(
      {
        handle: question.handle,
        revision: question.revision,
        commandId: 'human-answer',
        response: { option: 'allowed-once', value: null },
      },
      { actor, category: 'human', authorize() {} },
    )
    expect((await run()).reason).toBe('completed')
    await session.close()
    expect((await checkUncertainRetryFence(await fenceSession(storage, 'k'), retry))?.code).toBe(
      'E_ALREADY_APPLIED',
    )
    expect(effects).toBe(1)
  })

  it.each(['pending', 'verified', 'happened', 'not-happened'] as const)(
    'restores %s from ledger and isolates sessions',
    async (answer) => {
      const storage = new MemoryStorage()
      const s = await fenceSession(storage)
      await recordUncertainEffect(s, mutation, 'effect1')
      if (answer === 'verified') await markUncertainEffectsVerified(s, 'read', read)
      if (answer === 'happened' || answer === 'not-happened')
        await resolveUncertainEffectFromHuman(s, 'u1', answer)
      await s.close()
      const resumed = await fenceSession(storage)
      await restoreUncertainEffectFence(resumed)
      if (answer === 'happened') {
        await markUncertainEffectsVerified(resumed, 'later-read', read)
        await resolveUncertainEffectFromHuman(resumed, 'u1', 'not-happened')
      }
      expect((await checkUncertainRetryFence(resumed, mutation))?.code).toBe(
        answer === 'pending'
          ? 'E_VERIFICATION_REQUIRED'
          : answer === 'happened'
            ? 'E_ALREADY_APPLIED'
            : undefined,
      )
      expect(await checkUncertainRetryFence(await fenceSession(storage, 'other'), mutation)).toBeUndefined()
    },
  )

  it.each([
    [{ verifiesTools: ['payment_charge'] }, {}],
    [{ discoveryGroup: 'payments' }, {}],
    [{ name: 'payment_inspect' }, {}],
    [{}, { paymentId: 'p1' }],
    [{}, { path: '/reports/payments' }],
  ] as const)('accepts a correlated read %j %j', async (meta, args) => {
    const s = await fenceSession()
    await recordUncertainEffect(
      s,
      { ...mutation, args: { ...mutation.args, path: '/reports/payments/q1' }, discoveryGroup: 'payments' },
      'effect',
    )
    await markUncertainEffectsVerified(s, 'status', { name: 'lookup', isReadOnly: true, args, ...meta })
    expect(await checkUncertainRetryFence(s, mutation)).toBeUndefined()
  })
})

function notice(id: number) {
  return {
    childKey: `p/${id}`,
    commandId: `command-${id}`,
    resultSeq: id + 10,
    system: {
      source: 'agnes/child',
      type: 'child-completed',
      data: { result: `closing-${id}`, status: 'completed' },
      summary: `closing-${id}`,
    },
  }
}

function queue(options = {}) {
  vi.useFakeTimers()
  const controller = new AbortController()
  const owner = { parentKey: 'p', parentEpoch: controller.signal }
  const wakes: ReturnType<typeof completionBatch>[] = []
  const q = new ChildNoticeCoalescer(
    owner,
    async (entries) => {
      wakes.push(completionBatch(entries))
    },
    options,
  )
  return { q, wakes, owner, controller }
}

describe('background completion notices', () => {
  it('coalesces three completions, deduplicates command IDs and flushes as the last child goes idle', async () => {
    const { q, wakes, owner } = queue()
    const deliveries = [q.enqueue(owner, notice(1)), q.enqueue(owner, notice(1))]
    vi.advanceTimersByTime(45)
    deliveries.push(q.enqueue(owner, notice(2)))
    expect(wakes).toHaveLength(0)
    deliveries.push(q.enqueue(owner, { ...notice(3), omitClosingText: true }, true))
    expect(wakes).toHaveLength(1)
    expect(wakes[0]).toMatchObject({
      type: 'child-batch-completed',
      presentation: { kind: 'child-completed', status: 'completed' },
      data: {
        children: [1, 2, 3].map((i) => ({
          childKey: `p/${i}`,
          commandId: `command-${i}`,
          resultSeq: i + 10,
        })),
      },
    })
    expect(JSON.stringify(wakes)).not.toContain('closing-3')
    await Promise.all(deliveries)
  })

  it('delivers concurrent durable completions to one actual inbox item and deduplicates regrouped retries', async () => {
    const storage = new MemoryStorage()
    const parent = await fenceSession(storage, 'parent')
    await storage.ensureRootScope('root', capToMicrocredits(3))
    const records = await Promise.all(
      ['a', 'b', 'c'].map(async (key) => {
        const guard = await ChildAdmissionGuard.reserve(storage, {
          ...childInput(3, key, 1),
          creationId: `parent:main:background:${key}`,
        })
        return guard.bind(async (row) => {
          await storage.commitCreatingChild({ ...row, expectedRevision: row.creationRevision })
          await storage.casState(row.childKey, row.stateRevision, 'completed')
          return row
        })
      }),
    )
    const deliver = (r: (typeof records)[number]) => deliverCoalescedChildCompletion(parent, r, 'completed')
    await Promise.all(records.map(deliver))
    for (const r of records) await deliver(r)
    await recoverChildCompletions(parent)
    const inbox = parent.latest('inbox') as {
      items: { system: { data: { children: { childKey: string }[] } } }[]
    }
    expect(inbox.items).toHaveLength(1)
    expect(inbox.items[0]?.system.data.children.map((c) => c.childKey).sort()).toEqual([
      'parent/a',
      'parent/b',
      'parent/c',
    ])
  })

  it('honors the quiet window, hard deadline and zero-window mode', async () => {
    const { q, owner, wakes } = queue()
    const deliveries = [q.enqueue(owner, notice(1))]
    vi.advanceTimersByTime(100)
    deliveries.push(q.enqueue(owner, notice(2)))
    vi.advanceTimersByTime(120)
    deliveries.push(q.enqueue(owner, notice(3)))
    vi.advanceTimersByTime(79)
    expect(wakes).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(wakes).toHaveLength(1)
    deliveries.push(q.enqueue(owner, notice(4)))
    vi.advanceTimersByTime(150)
    expect(wakes).toHaveLength(2)
    await Promise.all(deliveries)
    const immediate = queue({ coalesceWindowMs: 0 })
    await immediate.q.enqueue(immediate.owner, notice(1))
    expect(immediate.wakes).toHaveLength(1)
    expect([0, 1, 2, 3, 4, 5].map((i) => pollWaitMetadata(i).suggestedWaitMs)).toEqual([
      5000, 10000, 30000, 60000, 300000, 300000,
    ])
  })

  it('drops stale epochs at flush and ignores a foreign owner', async () => {
    const { q, owner, controller, wakes } = queue()
    const delivery = q.enqueue(owner, notice(1))
    await q.enqueue({ ...owner, parentKey: 'elsewhere' }, notice(2), true)
    await q.enqueue({ ...owner, parentEpoch: new AbortController().signal }, notice(3), true)
    controller.abort()
    vi.advanceTimersByTime(150)
    await delivery
    expect(wakes).toEqual([])
  })
})

it('slims the shipped spawn prompt, preserves role and safety text, and bounds the structured handoff', () => {
  const sections = ['persona', 'channel-style', 'tools-available', 'coding-doctrine'].map((id, order) => ({
    id,
    order,
    source: id === 'tools-available' ? '@agnes/code' : `@agnes/code/prompts/${id}.md`,
    text: readFileSync(new URL(`../../code/prompts/${id}.md`, import.meta.url), 'utf8'),
  }))
  const role = {
    id: 'role',
    order: 10,
    source: 'deployment',
    text: 'Only inspect tickets. Never send a message.',
  }
  const tools = { id: 'tools:sdk', order: 150, source: '@agnes/code', text: 'ticket_get(id)' }
  sections.push(role, tools)
  const full = sections.map((s) => s.text).join('\n')
  const slim = childPromptBinding('spawn')?.provider.compose({}, sections) ?? []
  expect(slim).toEqual(expect.arrayContaining([role, tools, sections[3]]))
  const text = slim.map((s) => s.text).join('\n')
  expect(text.length).toBeLessThan(full.length * 0.6)
  expect(text).toContain(RESULT_DELIVERY_GUIDANCE)
  expect(childPromptSections('fork', sections)).toEqual(sections)
  const compact = compactChildHandoff('f'.repeat(3000), ['p'.repeat(250), '/verified'], 'r'.repeat(2000))
  expect(compact).toMatchObject({ verifiedPaths: ['/verified'], truncated: true })
  expect(JSON.stringify(compact).length).toBeLessThan(1200)
})
