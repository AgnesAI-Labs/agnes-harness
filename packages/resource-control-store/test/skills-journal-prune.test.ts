import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jcs } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSkillResourceStore,
  RESOURCE_ALL_PERMISSIONS,
  type ResourceAuthority,
  SkillJournalStore,
} from '../src/index.js'
import type { ResourceOperationRecord } from '../src/skill-journal.js'

// prune() used to concatenate the kept non-terminal ("received")
// operations BEFORE the capped terminal ("finished") tail and then slice(-900) the combined array.
// Whenever retained + finished exceeded 900 (while retained itself stayed under the separate
// `>= 900` OVERLOADED guard), that slice trimmed from the FRONT -- i.e. it silently dropped the
// oldest still-pending operations instead of only capping terminal history.
//
// These tests seed the journal file directly (bypassing 1000+ real admit/settle round-trips) and
// then drive exactly one real effect() call through the public SkillResourceStore.call() API, so
// prune() is exercised via its real entry point (call -> effect -> prune), never invoked directly.

const hash = (value: unknown) => createHash('sha256').update(jcs(value), 'utf8').digest('hex')
const profile = 'local-dev'
const scope = { allowedProfiles: [profile] }
const authority: ResourceAuthority = {
  audience: 'admin',
  principalId: 'owner',
  clientId: 'client',
  permissions: RESOURCE_ALL_PERMISSIONS,
}
const method = '_agnes/v1/resources.desired.set' as const

function seedOperation(index: number, state: 'received' | 'succeeded'): ResourceOperationRecord {
  const timestamp = new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString()
  const resourceId = `skill/user/user-agnes/${hash(`seed-target-${index}`)}`
  const revision = hash(`seed-revision-${index}`)
  const params = {
    profile,
    resourceId,
    state: index % 2 === 0 ? 'enabled' : 'disabled',
    expectedRevision: revision,
    config: { kind: 'none' },
  }
  const payloadHash = hash({ method, payload: params })
  return {
    operation: {
      operationId: `resource-seed-${index}`,
      kind: method,
      state,
      profile,
      target: resourceId,
      revision,
      createdAt: timestamp,
      updatedAt: timestamp,
      progress: state === 'succeeded' ? 100 : 0,
    },
    owner: { principalId: authority.principalId, clientId: authority.clientId },
    command: { method, commandId: `seed-command-${index}`, payloadHash },
  }
}

async function seedJournal(directory: string, operations: readonly ResourceOperationRecord[]): Promise<void> {
  const journalStore = new SkillJournalStore(directory, scope)
  await journalStore.transact(profile, (journal) => ({
    next: { ...journal, operations },
    result: undefined,
  }))
}

let directory = ''
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = ''
})

describe('resource operation journal prune()', () => {
  it('keeps every non-terminal operation and only caps the terminal tail when retained + finished > 900', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skills-prune-'))
    // 850 non-terminal ("received") + 150 terminal ("succeeded") = 1000, the maximum a single
    // journal write may ever persist (SkillJournalStore.decode enforces operations.length <= 1000).
    const nonTerminal = Array.from({ length: 850 }, (_, i) => seedOperation(i, 'received'))
    const terminalOps = Array.from({ length: 150 }, (_, i) => seedOperation(850 + i, 'succeeded'))
    await seedJournal(directory, [...nonTerminal, ...terminalOps])

    const store = createSkillResourceStore({ directory, scope })
    store.setDeferredDrive(true) // isolate prune() from the async drive/adapter path

    // Trigger exactly one journaling effect() call; every such call runs prune() first.
    await store.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'trigger-refresh' },
      authority,
    )

    // The oldest non-terminal operation must survive prune() and remain gettable.
    await expect(
      store.call('_agnes/v1/resources.operation.get', { profile, operationId: 'resource-seed-0' }, authority),
    ).resolves.toMatchObject({ operationId: 'resource-seed-0', state: 'received' })
    // ...as must the newest one.
    await expect(
      store.call(
        '_agnes/v1/resources.operation.get',
        { profile, operationId: 'resource-seed-849' },
        authority,
      ),
    ).resolves.toMatchObject({ operationId: 'resource-seed-849', state: 'received' })

    // Idempotent replay of the oldest operation's original command must still return its original
    // receipt (not mint a second operationId), per the durable-admission contract.
    const replayParams = {
      profile,
      resourceId: `skill/user/user-agnes/${hash('seed-target-0')}`,
      state: 'enabled',
      expectedRevision: hash('seed-revision-0'),
      config: { kind: 'none' },
      clientId: 'client',
      commandId: 'seed-command-0',
    }
    await expect(store.call(method, replayParams, authority)).resolves.toMatchObject({
      operationId: 'resource-seed-0',
      state: 'received',
    })

    // Journal stays bounded: 850 retained + a 50-item finished budget (900 - 850) + the 1 new
    // refresh operation admitted by the trigger call above = 901.
    const journalStore = new SkillJournalStore(directory, scope)
    const finalCount = await journalStore.read(profile, (journal) => journal.operations.length)
    expect(finalCount).toBe(901)
  })

  it('leaves the journal untouched below the 1000-operation threshold', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skills-prune-below-'))
    const nonTerminal = Array.from({ length: 700 }, (_, i) => seedOperation(i, 'received'))
    const terminalOps = Array.from({ length: 299 }, (_, i) => seedOperation(700 + i, 'succeeded'))
    await seedJournal(directory, [...nonTerminal, ...terminalOps]) // 999 total, under the threshold

    const store = createSkillResourceStore({ directory, scope })
    store.setDeferredDrive(true)
    await store.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'trigger-refresh' },
      authority,
    )

    // Nothing pruned: all 999 seeded rows plus the 1 newly admitted refresh operation survive.
    const journalStore = new SkillJournalStore(directory, scope)
    const finalCount = await journalStore.read(profile, (journal) => journal.operations.length)
    expect(finalCount).toBe(1000)
    await expect(
      store.call('_agnes/v1/resources.operation.get', { profile, operationId: 'resource-seed-0' }, authority),
    ).resolves.toMatchObject({ operationId: 'resource-seed-0', state: 'received' })
  })

  it('keeps the newest 500 finished operations replayable when non-terminal is empty', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skills-prune-finished-only-'))
    // All 1000 seeded rows are terminal; the finished tail keeps its 500-row cap.
    const terminalOps = Array.from({ length: 1000 }, (_, i) => seedOperation(i, 'succeeded'))
    await seedJournal(directory, terminalOps)

    const store = createSkillResourceStore({ directory, scope })
    store.setDeferredDrive(true)
    await store.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'trigger-refresh' },
      authority,
    )

    // Oldest terminal history may legitimately be dropped (terminal history, unlike non-terminal
    // operations, is allowed to be capped): row 499 is the last one outside the newest-500 window.
    await expect(
      store.call(
        '_agnes/v1/resources.operation.get',
        { profile, operationId: 'resource-seed-499' },
        authority,
      ),
    ).rejects.toMatchObject({ data: { code: 'RESOURCE_OPERATION_UNAVAILABLE' } })
    await expect(
      store.call(
        '_agnes/v1/resources.operation.get',
        { profile, operationId: 'resource-seed-500' },
        authority,
      ),
    ).resolves.toMatchObject({ operationId: 'resource-seed-500', state: 'succeeded' })
    // The newest finished operations remain, and stay replayable.
    await expect(
      store.call(
        '_agnes/v1/resources.operation.get',
        { profile, operationId: 'resource-seed-999' },
        authority,
      ),
    ).resolves.toMatchObject({ operationId: 'resource-seed-999', state: 'succeeded' })
    const replayParams = {
      profile,
      resourceId: `skill/user/user-agnes/${hash('seed-target-999')}`,
      state: 'disabled',
      expectedRevision: hash('seed-revision-999'),
      config: { kind: 'none' },
      clientId: 'client',
      commandId: 'seed-command-999',
    }
    // A replay receipt is the original admission receipt (always 'received' for a non-cancel
    // kind), not the operation's current terminal state -- see the comment above `findCommand`'s
    // replay branch in skills.ts.
    await expect(store.call(method, replayParams, authority)).resolves.toMatchObject({
      operationId: 'resource-seed-999',
      state: 'received',
    })

    // 500 finished + the 1 new refresh operation.
    const journalStore = new SkillJournalStore(directory, scope)
    const finalCount = await journalStore.read(profile, (journal) => journal.operations.length)
    expect(finalCount).toBe(501)
  })
})
