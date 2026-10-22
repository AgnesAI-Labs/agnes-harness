import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jcs } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSkillResourceStore,
  RESOURCE_ALL_PERMISSIONS,
  type ResourceAuthority,
  type ResourceEffectAdmission,
  SkillJournalStore,
} from '../src/index.js'
import type { ResourceOperationRecord } from '../src/skill-journal.js'

const persistence = vi.hoisted(() => ({ afterFlush: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'sync')
            return async () => {
              await target.sync()
              persistence.afterFlush?.()
            }
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
})

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
  persistence.afterFlush = undefined
  vi.restoreAllMocks()
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

it.each([
  ['queued', 'epoch'],
  ['queued', 'deadline'],
  ['temp-written', 'epoch'],
  ['temp-written', 'deadline'],
])(
  'Skill journal refuses %s writes after losing %s and preserves durable state',
  async (boundary, failure) => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skill-lease-boundary-'))
    const store = new SkillJournalStore(directory, scope)
    await store.transact(profile, (journal) => ({
      next: { ...journal, priorities: { 'skill/seed': 100 } },
      result: undefined,
    }))
    const file = join(directory, `${profile}.skills.json`)
    const before = await readFile(file, 'utf8')
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    let epoch = 0
    const admission: ResourceEffectAdmission = {
      verify: async () => {
        if (epoch !== 0) throw new Error('epoch revoked')
      },
      assertActive: () => {
        if (Date.now() >= now + 1_000) throw new Error('deadline expired')
      },
    }
    const revoke = () => {
      if (failure === 'epoch') epoch++
      else clock.mockReturnValue(now + 1_000)
    }
    let release = () => {}
    let queued: Promise<void> | undefined
    if (boundary === 'queued') {
      let enter!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      queued = store.transact(profile, async (journal) => {
        enter()
        await held
        return { next: journal, result: undefined }
      })
      await entered
    } else persistence.afterFlush = revoke
    const pending = store.transact(
      profile,
      (journal) => ({ next: { ...journal, priorities: { 'skill/seed': 200 } }, result: undefined }),
      admission,
    )
    const refused = expect(pending).rejects.toThrow(failure)
    try {
      if (boundary === 'queued') revoke()
      release()
      await queued
      await refused
      expect(await readFile(file, 'utf8')).toBe(before)
      expect((await store.read(profile, (journal) => journal.priorities))['skill/seed']).toBe(100)
      expect(await readdir(directory)).toEqual([`${profile}.skills.json`])
      // This independent human administration remains valid and never inherits a failed lease.
      persistence.afterFlush = undefined
      await store.transact(profile, (journal) => ({
        next: { ...journal, priorities: { 'skill/seed': 200 } },
        result: undefined,
      }))
      expect((await store.read(profile, (journal) => journal.priorities))['skill/seed']).toBe(200)
    } finally {
      release()
      clock.mockRestore()
    }
  },
)

it.each(['revocation', 'abort', 'expiry', 'epoch', 'stale-proof'])(
  'shared proof: refuses Skill journal %s at final publication',
  async (loss) => {
    const { permissionEffectAdmission } = await import('@agnes/protocol')
    let active = true,
      now = 0,
      epoch = 0,
      version = 1
    const controller = new AbortController()
    const proof = permissionEffectAdmission({
      signals: [controller.signal],
      expiresAt: 10,
      clock: () => now,
      unavailable: () => Error('permission unavailable'),
      assertBound: () => {
        if (!active || epoch !== 0 || version !== 1) throw Error('permission unavailable')
      },
    })
    const lose = () => {
      if (loss === 'revocation') active = false
      if (loss === 'abort') controller.abort()
      if (loss === 'expiry') now = 10
      if (loss === 'epoch') epoch++
      if (loss === 'stale-proof') version++
    }
    directory = await mkdtemp(join(tmpdir(), 'agh-skill-proof-'))
    const store = new SkillJournalStore(directory, scope)
    await seedJournal(directory, [])
    const file = join(directory, `${profile}.skills.json`)
    const before = await readFile(file, 'utf8')
    // Inject loss only after the durability boundary, after the final async verifier returns.
    let flushed = false
    persistence.afterFlush = () => {
      flushed = true
    }
    const finalAdmission = {
      ...proof,
      verify: async () => {
        await proof.verify()
        if (flushed) lose()
      },
    }
    await expect(
      store.transact(
        profile,
        (journal) => ({
          next: { ...journal, removed: ['skill/reviewed'] },
          result: undefined,
        }),
        finalAdmission,
      ),
    ).rejects.toThrow('permission unavailable')
    expect(await readFile(file, 'utf8')).toBe(before)
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    // Refusal leaves durable operation rows unchanged.
    expect(await store.read(profile, (journal) => journal.operations)).toEqual([])
  },
)
