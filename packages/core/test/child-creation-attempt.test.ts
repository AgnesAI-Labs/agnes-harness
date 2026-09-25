import { describe, expect, it } from 'vitest'
import { recoverCreatingChildAttempts } from '../src/child/store.js'
import type { CreateDelegatedChildInput } from '../src/child/types.js'
import { MemoryStorage } from '../src/log/memory-storage.js'

async function fixture(now = 100): Promise<{
  storage: MemoryStorage
  input: CreateDelegatedChildInput
}> {
  const storage = new MemoryStorage({ clock: () => now })
  await storage.open('parent', { writerRunId: 'parent-writer', ttlMs: 1_000 })
  await storage.ensureRootScope('root', 1_000_000n)
  return {
    storage,
    input: {
      childKey: 'parent/child',
      parentKey: 'parent',
      boundarySeq: 0,
      creationId: 'creation:1',
      attemptId: 'attempt:1',
      attemptStartedAt: now,
      kind: 'spawn',
      rootTaskId: 'root',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 4,
      inputHash: 'a'.repeat(64),
      inputText: 'work',
      cwd: '/workspace',
      actorId: 'actor',
      isolation: 'shared',
      workspaceId: 'workspace:1',
      treeCapMicro: 1_000_000n,
      childCapMicro: null,
      writerRunId: 'child-writer',
    },
  }
}

describe('durable child creation attempts', () => {
  it('persists deferred before attach and fences a late old-attempt cancel', async () => {
    const { storage, input } = await fixture()
    const created = await storage.createDelegatedChild(input)
    expect(created.status).toBe('created')
    if (created.status !== 'created') return

    const deferred = await storage.deferCreatingChild({
      childKey: input.childKey,
      creationId: input.creationId,
      attemptId: 'attempt:1',
      expectedRevision: 1,
      deferredAt: 110,
    })
    await expect(
      storage.deferCreatingChild({
        childKey: input.childKey,
        creationId: input.creationId,
        attemptId: 'attempt:1',
        expectedRevision: 1,
        deferredAt: 999,
      }),
    ).resolves.toBe(deferred)
    expect(await storage.lookupByKey(input.childKey)).toMatchObject({
      creationPhase: 'deferred',
      creationRevision: 2,
      deferredFact: deferred,
    })

    const attached = await storage.beginChildAttempt({
      childKey: input.childKey,
      creationId: input.creationId,
      previousAttemptId: 'attempt:1',
      nextAttemptId: 'attempt:2',
      expectedRevision: 2,
      startedAt: 120,
    })
    expect(attached).toMatchObject({
      attemptId: 'attempt:2',
      creationPhase: 'creating',
      creationRevision: 3,
      attemptStartedAt: 120,
    })
    await expect(
      storage.cancelCreatingChild({
        childKey: input.childKey,
        creationId: input.creationId,
        attemptId: 'attempt:1',
        expectedRevision: 1,
        reason: 'open_failed',
        cancelledAt: 130,
      }),
    ).rejects.toMatchObject({ code: 'E_CAS' })

    const cancelled = await storage.cancelCreatingChild({
      childKey: input.childKey,
      creationId: input.creationId,
      attemptId: 'attempt:2',
      expectedRevision: 3,
      reason: 'workspace_closed',
      cancelledAt: 140,
    })
    await expect(
      storage.cancelCreatingChild({
        childKey: input.childKey,
        creationId: input.creationId,
        attemptId: 'attempt:2',
        expectedRevision: 3,
        reason: 'workspace_closed',
        cancelledAt: 999,
      }),
    ).resolves.toBe(cancelled)
    expect(cancelled).toEqual({
      childKey: input.childKey,
      creationId: input.creationId,
      attemptId: 'attempt:2',
      revision: 4,
      reason: 'workspace_closed',
      cancelledAt: 140,
    })
  })

  it('commits by exact attempt and never revives a committed child', async () => {
    const { storage, input } = await fixture()
    await storage.createDelegatedChild(input)
    const cas = {
      childKey: input.childKey,
      creationId: input.creationId,
      attemptId: 'attempt:1',
      expectedRevision: 1,
    }
    await expect(storage.commitCreatingChild(cas)).resolves.toBe(true)
    await expect(storage.commitCreatingChild(cas)).resolves.toBe(true)
    await expect(
      storage.cancelCreatingChild({
        ...cas,
        reason: 'open_failed',
        cancelledAt: 120,
      }),
    ).rejects.toMatchObject({ code: 'E_CAS' })
    expect(await storage.lookupByKey(input.childKey)).toMatchObject({
      creationPhase: 'committed',
      creationRevision: 2,
    })
  })

  it('recovery cancels only expired creating attempts without a live owner', async () => {
    const { storage, input } = await fixture()
    await storage.createDelegatedChild(input)
    const second = {
      ...input,
      childKey: 'parent/second',
      creationId: 'creation:2',
      attemptId: 'attempt:live',
      workspaceId: 'workspace:2',
    }
    await storage.createDelegatedChild(second)
    const cancelled = await recoverCreatingChildAttempts(storage, {
      staleBefore: 100,
      now: 200,
      liveAttemptIds: new Set(['attempt:live']),
    })
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]).toMatchObject({ attemptId: 'attempt:1', reason: 'open_failed' })
    expect(await storage.lookupByKey(second.childKey)).toMatchObject({ creationPhase: 'creating' })
  })

  it('settles a cancelled creation out of the active set in the same write', async () => {
    const { storage, input } = await fixture()
    await storage.createDelegatedChild({ ...input, maxFanOut: 1 })
    await recoverCreatingChildAttempts(storage, { staleBefore: 100, now: 200 })
    expect(await storage.lookupByKey(input.childKey)).toMatchObject({
      creationPhase: 'cancelled',
      state: 'failed',
      stateRevision: 2,
    })
    const next = await storage.createDelegatedChild({
      ...input,
      childKey: 'parent/next',
      creationId: 'creation:next',
      attemptId: 'attempt:next',
      workspaceId: 'workspace:next',
      maxFanOut: 1,
    })
    expect(next.status).toBe('created')

    await storage.createDelegatedChild({
      ...input,
      childKey: 'parent/closed',
      creationId: 'creation:closed',
      attemptId: 'attempt:closed',
      workspaceId: 'workspace:closed',
    })
    await storage.cancelCreatingChild({
      childKey: 'parent/closed',
      creationId: 'creation:closed',
      attemptId: 'attempt:closed',
      expectedRevision: 1,
      reason: 'workspace_closed',
      cancelledAt: 300,
    })
    expect(await storage.lookupByKey('parent/closed')).toMatchObject({ state: 'cancelled' })
  })
})
