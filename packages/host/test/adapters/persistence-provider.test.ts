import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createRefineHarness, packageStorage, RefineQueue } from '@agnes/base'
import {
  CoreError,
  defaultIds,
  LEDGER_INTEGRITY_ALGORITHM,
  makeVerifiedHead,
  SessionLogImpl,
} from '@agnes/core'
import { definePersistenceProvider, type PersistenceSessionStore } from '@agnes/extension-api'
import {
  persistenceContract,
  persistenceHostContract,
  persistenceSqliteContract,
} from '@agnes/extension-api/testkit/persistence-contract'
import { resolveProfile } from '@agnes/host-common/profile/resolve'
import type { LockState, ProfileFragment, ResolveEnv } from '@agnes/host-common/profile/types'
import { readNamedExports } from '@agnes/host-extensions/assemble/packages'
import { persistenceProviderRegistry } from '@agnes/host-infrastructure/adapters/storage-provider'
import { afterAll, describe, expect, it } from 'vitest'
import {
  openAdapters,
  openConfiguredPersistence,
  sqlitePersistenceProvider,
} from '../../src/runtime/adapters/index.js'

const env: ResolveEnv = {
  platform: { os: 'linux', arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-07T00:00:00Z',
}
const lock: LockState = {
  packages: {
    '@agnes/base': {
      version: '0.1.0',
      source: { type: 'builtin' as const, ref: 'builtin' },
      integrity: 'builtin:0.1.0',
      trust: 'builtin',
      enabled: true,
    },
    '@agnes/code': {
      version: '0.1.0',
      source: { type: 'builtin' as const, ref: 'builtin' },
      integrity: 'builtin:0.1.0',
      trust: 'builtin',
      enabled: true,
    },
    '@agnes/ai': {
      version: '0.1.0',
      source: { type: 'builtin' as const, ref: 'builtin' },
      integrity: 'builtin:0.1.0',
      trust: 'builtin',
      enabled: true,
    },
  },
}
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agh-persist-'))
  dirs.push(dir)
  return dir
}

function emptyStore(): PersistenceSessionStore {
  return {
    async open() {
      return { lastSeq: 0, formatVersion: 1, created: true }
    },
    async commit() {
      return { firstSeq: 1, seqs: [1] }
    },
    async renew() {},
    async release() {},
    async scan() {
      return []
    },
    async registers() {
      return []
    },
    async close() {},
  }
}

describe('persistence provider', () => {
  persistenceContract('sqlite', () => {
    const dir = tempDir()
    return { open: () => sqlitePersistenceProvider.open({ dataDir: dir }) }
  })
  persistenceHostContract('sqlite', () => {
    const dir = tempDir()
    return { open: () => sqlitePersistenceProvider.open({ dataDir: dir }) }
  })
  persistenceSqliteContract('sqlite', () => {
    const dir = tempDir()
    return { open: () => sqlitePersistenceProvider.open({ dataDir: dir }) }
  })

  it('keeps the default adapter bundle on sqlite', async () => {
    const dir = tempDir()
    const legacy = await sqlitePersistenceProvider.open({ dataDir: dir })
    if (!legacy.sqlite) throw new Error('SQLite port missing')
    const table = legacy.sqlite.tables('owner').table('persistence_kv')
    table.exec(
      'CREATE TABLE persistence_kv (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key))',
    )
    table.run('INSERT INTO persistence_kv VALUES (?, ?, ?)', [
      'config',
      'legacy',
      JSON.stringify({ enabled: true }),
    ])
    await legacy.close()
    const profile = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const bundle = await openAdapters(profile, { dataDir: dir, workspaceRoot: dir })
    try {
      expect(profile.persistence).toBeUndefined()
      expect(bundle.storage.capabilities).toMatchObject({
        ledger: true,
        metadata: true,
        childControl: true,
        reclaim: true,
        integrity: true,
        sqlite: true,
      })
      expect(bundle.storage.sqlite?.dialect).toBe('sqlite')
      expect(existsSync(join(dir, 'sessions.db'))).toBe(true)
      expect('file' in bundle.storage).toBe(false)
      const options = {
        storage: bundle.storage,
        key: 'checkpoint',
        writerRunId: 'checkpoint-writer',
        ttlMs: 60_000,
        ids: defaultIds(),
        clock: Date.now,
      }
      const writer = await SessionLogImpl.open(options)
      await writer.append([
        {
          type: 'user/message',
          data: { content: [{ type: 'text', text: 'checkpoint input' }] },
          actor: { id: 'owner', role: 'owner', org: 'local', deptPath: [], attrs: {} },
          origin: 'principal',
          trust: 'trusted',
        },
      ])
      await writer.close()
      const head = await bundle.storage.readVerifiedHead?.('checkpoint')
      expect(head?.throughSeq).toBe(1)
      expect(await bundle.storage.integrityDigestAt?.('checkpoint', 1)).toBe(head?.headDigest)
      expect((await bundle.storage.ledgerStats?.('checkpoint'))?.storedBytes).toBeGreaterThan(0)
      const reader = await SessionLogImpl.open(options)
      expect(reader.openStats.checkpoint).toEqual({ used: true, throughSeq: 1 })
      await reader.fullVerified()
      // The reader hashed its prefix already: a recheck checks the tail only and finishes at once.
      await reader.verifyHistory()
      expect(reader.historyVerified).toBe(true)
      await reader.verifyHistory({ rehashPrefix: true })
      expect(reader.historyVerified).toBe(false)
      await reader.fullVerified()
      await reader.close()
      await bundle.storage.deleteVerifiedHead?.('checkpoint')
      expect(await bundle.storage.readVerifiedHead?.('checkpoint')).toBeUndefined()
      const metadata = bundle.storage.metadata.namespace('owner', 'config')
      expect(metadata.get('legacy')).toEqual({ enabled: true })
      metadata.delete('legacy')
      expect(bundle.storage.metadata.namespace('owner', 'config').get('legacy')).toBeUndefined()
    } finally {
      await bundle.close()
    }
    await expect(bundle.storage.readVerifiedHead?.('checkpoint')).rejects.toMatchObject({ code: 'E_CLOSED' })
    const reopened = await openAdapters(profile, { dataDir: dir, workspaceRoot: dir })
    try {
      expect(reopened.storage.metadata.namespace('owner', 'config').get('legacy')).toBeUndefined()
    } finally {
      await reopened.close()
    }
  })

  it('refuses an unknown provider id', async () => {
    const dir = tempDir()
    const profile = await resolveProfile({ builtin: 'local-dev', lock }, env)
    await expect(
      openAdapters(profile, { dataDir: dir, workspaceRoot: dir, persistence: { provider: 'missing' } }),
    ).rejects.toMatchObject({
      code: 'E_PROVIDER_UNKNOWN',
      kind: 'persistence',
      provider: 'missing',
      operation: 'resolve',
      retryable: false,
    })
    expect(existsSync(join(dir, 'sessions.db'))).toBe(false)
  })

  it('uses a configured provider through the same public ports without opening the default store', async () => {
    const seen: string[] = []
    const provider = definePersistenceProvider({
      id: 'custom',
      version: '1.0.0',
      state: { effect: 'restart-required' },
      capabilities: sqlitePersistenceProvider.capabilities,
      async open(options) {
        mkdirSync(join(options.dataDir, 'custom'), { recursive: true })
        const store = await sqlitePersistenceProvider.open({ dataDir: join(options.dataDir, 'custom') })
        if (!store.metadata || !store.reclaim) throw new Error('fixture ports missing')
        const metadata = store.metadata
        const legacy = { ...store }
        for (const method of [
          'readVerifiedHead',
          'writeVerifiedHead',
          'deleteVerifiedHead',
          'integrityDigestAt',
          'ledgerStats',
        ] as const)
          delete legacy[method]
        return {
          ...legacy,
          metadata: { namespace: (owner, name) => Object.freeze(metadata.namespace(owner, name)) },
          reclaim: Object.freeze(store.reclaim),
          async scan(key, query) {
            seen.push('scan')
            return store.scan(key, query)
          },
        } satisfies PersistenceSessionStore
      },
    })
    const dir = tempDir()
    const profile = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const bundle = await openAdapters(profile, {
      dataDir: dir,
      workspaceRoot: dir,
      persistence: { provider: 'custom' },
      persistenceProviders: [provider],
    })
    try {
      await bundle.storage.open('k', { writerRunId: 'r', ttlMs: 60_000 })
      expect(await bundle.storage.scan('k', { limit: 1 })).toEqual([])
      expect(bundle.storage.readVerifiedHead).toBeUndefined()
      expect(seen).toEqual(['scan'])
      expect(bundle.storage.childControlFormat()).toBeGreaterThan(0)
      expect(bundle.storage.crashReclaim.listExpired(Date.now())).toEqual([])
      const kv = Object.freeze(bundle.storage.metadata.namespace('owner', 'config'))
      kv.set('enabled', true)
      expect(kv.get('enabled')).toBe(true)
      expect(() =>
        kv.transaction(() => {
          kv.set('enabled', false)
          throw new Error('rollback')
        }),
      ).toThrow('rollback')
      expect(kv.get('enabled')).toBe(true)
      expect(bundle.storage.metadata.namespace('other', 'config').get('enabled')).toBeUndefined()
      const second = await openAdapters(profile, {
        dataDir: dir,
        workspaceRoot: dir,
        persistence: { provider: 'custom' },
        persistenceProviders: [provider],
      })
      await bundle.close()
      try {
        expect(() => kv.get('enabled')).toThrow(/closed/)
        await expect(bundle.storage.registers('k')).rejects.toMatchObject({ code: 'E_CLOSED' })
        expect(second.storage.metadata.namespace('owner', 'config').get('enabled')).toBe(true)
        expect(await second.storage.registers('k')).toEqual([])
      } finally {
        await second.close()
      }
      expect(existsSync(join(dir, 'sessions.db'))).toBe(false)
    } finally {
      await bundle.close()
    }
  })

  it.each(['metadata', 'sqlite', 'childControl', 'reclaim', 'scanIntegrity'] as const)(
    'refuses a selected provider missing declared %s before publishing the store and closes it',
    async (port) => {
      let closed = false
      const provider = definePersistenceProvider({
        id: 'incomplete',
        version: '1.0.0',
        state: { effect: 'restart-required' },
        capabilities: sqlitePersistenceProvider.capabilities,
        async open(options) {
          const store = await sqlitePersistenceProvider.open(options)
          const partial = {
            ...store,
            close: async () => {
              closed = true
              await store.close()
            },
          }
          delete partial[port]
          return partial
        },
      })
      const dir = tempDir()
      const profile = await resolveProfile({ builtin: 'local-dev', lock }, env)
      await expect(
        openAdapters(profile, {
          dataDir: dir,
          workspaceRoot: dir,
          persistence: { provider: provider.id },
          persistenceProviders: [provider],
        }),
      ).rejects.toMatchObject({
        code: 'E_PROVIDER_INCOMPATIBLE',
        kind: 'persistence',
        provider: 'incomplete',
      })
      expect(closed).toBe(true)
    },
  )

  it('does not open SQLite storage for a pre-aborted construction signal', async () => {
    const ac = new AbortController()
    ac.abort(new Error('Stopped before open'))
    expect(() => sqlitePersistenceProvider.open({ dataDir: tempDir(), signal: ac.signal })).toThrow(
      'Stopped before open',
    )
  })

  it('refuses a provider that replaces sqlite or omits restart-required', async () => {
    const dir = tempDir()
    const profile = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const builtin = definePersistenceProvider({
      id: 'sqlite',
      version: '1.0.0',
      capabilities: { ledger: true },
      state: { effect: 'restart-required' },
      open: () => emptyStore(),
    })
    await expect(
      openAdapters(profile, { dataDir: dir, workspaceRoot: dir, persistenceProviders: [builtin] }),
    ).rejects.toMatchObject({ code: 'E_PROVIDER_DUPLICATE', kind: 'persistence' })
    await expect(
      openAdapters(profile, {
        dataDir: dir,
        workspaceRoot: dir,
        persistenceProviders: [
          {
            id: 'mem',
            version: '1.0.0',
            state: { effect: 'hot' },
            open: () => emptyStore(),
          } as unknown as typeof builtin,
        ],
      }),
    ).rejects.toMatchObject({ code: 'E_PROVIDER_INVALID', kind: 'persistence' })
  })

  it('reads providers.persistence from the user profile and omits the sqlite default', async () => {
    const omitted = await resolveProfile({ builtin: 'local-dev', lock, user: { name: 'local-dev' } }, env)
    const explicit = await resolveProfile(
      {
        builtin: 'local-dev',
        lock,
        user: { name: 'local-dev', providers: { persistence: { provider: 'sqlite' } } },
      },
      env,
    )
    const selected = await resolveProfile(
      {
        builtin: 'local-dev',
        lock,
        user: { name: 'local-dev', providers: { persistence: { provider: 'jsonl' } } },
      },
      env,
    )
    expect(omitted.persistence).toBeUndefined()
    expect(explicit.persistence).toBeUndefined()
    expect(explicit.hash).toBe(omitted.hash)
    expect(selected.persistence).toEqual({ provider: 'jsonl' })
    expect(selected.hash).not.toBe(omitted.hash)
    await expect(
      resolveProfile(
        {
          builtin: 'local-dev',
          lock,
          user: { name: 'local-dev', providers: { persistence: { provider: 'Bad' } } },
        },
        env,
      ),
    ).rejects.toMatchObject({ code: 'E_PROFILE_FRAGMENT_KEY' })
    await expect(
      resolveProfile(
        {
          builtin: 'local-dev',
          lock: { ...lock, workspace: { path: '/work', hash: 'sha256-workspace', manifestId: 'fixture' } },
          workspaceOverlay: {
            providers: { persistence: { provider: 'jsonl' } },
          } as unknown as ProfileFragment,
        },
        env,
      ),
    ).rejects.toMatchObject({ code: 'E_PROFILE_FRAGMENT_KEY', source: { layer: 'workspace' } })
  })

  it('copies a package persistenceProvider export', () => {
    const provider = definePersistenceProvider({
      id: 'jsonl',
      version: '1.0.0',
      capabilities: { ledger: true },
      state: { effect: 'restart-required' },
      open: () => emptyStore(),
    })
    expect(
      readNamedExports('example.jsonl', 'index.js', { persistenceProvider: provider }).persistenceProvider
        ?.id,
    ).toBe('jsonl')
    expect(() =>
      readNamedExports('example.sqlite', 'index.js', { persistenceProvider: { ...provider, id: 'sqlite' } }),
    ).toThrow(/sqlite/)
    expect(() => readNamedExports('example.bad', 'index.js', { persistenceProvider: { id: 'Bad' } })).toThrow(
      /persistenceProvider/,
    )
  })
})

it('runs the default accounting, refine and MCP domains on metadata without SQL', async () => {
  const { persistenceProvider } = await import(
    new URL('../../../../examples/persistence/src/index.ts', import.meta.url).href
  )
  const { BASE_SEAM_PROVIDERS, mcpCatalogHubFor } = await import('@agnes/base')
  const { fakeSeamInit } = await import('@agnes/base/testkit')
  const { toSeamAdapters } = await import('../../src/runtime/adapters/index.js')
  const dir = tempDir()
  const profile = await resolveProfile({ builtin: 'local-dev', lock }, env)
  const bundle = await openAdapters(profile, {
    dataDir: dir,
    workspaceRoot: dir,
    persistence: { provider: 'jsonl' },
    persistenceProviders: [persistenceProvider],
  })
  try {
    expect(bundle.storage.sqlite).toBeUndefined()
    await expect(
      bundle.storage.cancelCreatingChild({
        childKey: 'missing',
        creationId: 'missing',
        attemptId: 'missing',
        expectedRevision: 1,
        reason: 'open_failed',
        cancelledAt: 0,
      }),
    ).rejects.toBeInstanceOf(CoreError)
    await expect(
      bundle.storage.settleOrigin({
        permitId: 'missing',
        originSessionKey: 'missing',
        originCostSeq: 1,
        actualMicro: 1n,
        complete: true,
        creditSource: 'gateway',
      }),
    ).rejects.toBeInstanceOf(CoreError)
    const init = fakeSeamInit({ dataDir: dir, workspaceRoot: dir })
    init.adapters = toSeamAdapters(bundle, { owner: '@agnes/base' })
    const ledger = await BASE_SEAM_PROVIDERS.billing.create(init, new AbortController().signal)
    const cost = {
      sessionKey: 's',
      lane: 'main',
      turn: 1,
      step: 1,
      purpose: 'inference' as const,
      effectId: 'effect',
      model: 'm',
      tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
      credits: 11,
      creditSource: 'gateway' as const,
    }
    await ledger.record(cost)
    await ledger.record(cost)
    expect(await ledger.projected({ model: 'm', tokensEstimate: 500 })).toEqual({
      credits: 5,
      creditSource: 'estimated',
    })
    const harness = createRefineHarness(
      new RefineQueue(
        packageStorage(init.adapters.storage, 'refine_queue', {
          select: 'SELECT * FROM refine_queue',
          key: (r) => String(r.proposal_id),
        }),
      ),
      20,
    )
    expect(
      await harness.propose({
        proposalId: 'proposal',
        trigger: 'auto',
        edits: [{ op: 'delete', kind: 'memory', id: 'old' }],
        baseline: [],
        rationale: 'test',
        evidenceSeqs: [],
      }),
    ).toBe('queued')
    const hub = mcpCatalogHubFor(init)
    hub.upsert('server', [{ name: 'lookup', description: '查找订单', schema: '{}' }])
    expect(hub.search('查找', 10)).toEqual([{ name: 'lookup', score: 1 }])
    hub.remove('server')
    expect(hub.get('lookup')).toBeUndefined()
    expect(() => init.adapters.storage.table('unsupported')).toThrow(/does not support SQL/)
    expect(existsSync(join(dir, 'sessions.db'))).toBe(false)
  } finally {
    await bundle.close()
  }
  const reopened = await persistenceProvider.open({ dataDir: dir })
  try {
    const values = reopened.metadata.namespace('@agnes/base', 'usage_ledger').entries()
    expect(values).toHaveLength(1)
    expect(reopened.metadata.namespace('@agnes/base', 'refine_queue').get('row:proposal')).toMatchObject({
      status: 'queued',
    })
  } finally {
    await reopened.close()
  }
})

it('keeps process persistence live after registry teardown until session leases and Host references release', async () => {
  const dataDir = tempDir()
  const first = await openConfiguredPersistence({ dataDir })
  const second = await openConfiguredPersistence({ dataDir })
  try {
    await first.open('lease', { writerRunId: 'first', ttlMs: 60_000 })
    await persistenceProviderRegistry(first)!.dispose()
    await first.release('lease', 'first')
    await first.close()
    await second.open('lease', { writerRunId: 'second', ttlMs: 60_000 })
    await second.release('lease', 'second')
  } finally {
    await first.close()
    await second.close()
  }
  const reopened = await openConfiguredPersistence({ dataDir })
  try {
    await reopened.open('lease', { writerRunId: 'reopened', ttlMs: 60_000 })
    await reopened.release('lease', 'reopened')
  } finally {
    await reopened.close()
  }
})

describe('perf3-review: forwarded checkpoint provider operations', () => {
  const checkpoint = (key: string, throughSeq = 1) =>
    makeVerifiedHead({
      sessionKey: key,
      throughSeq,
      headDigest: 'a'.repeat(64),
      legacyThroughSeq: 0,
      algorithm: LEDGER_INTEGRITY_ALGORITHM,
      verifiedFullAtMs: 1,
      writtenAtMs: 1,
    })

  it('preserves session and independent-home namespaces and enforces forward-only writes through the bridge', async () => {
    const a = await openConfiguredPersistence({ dataDir: tempDir() }),
      b = await openConfiguredPersistence({ dataDir: tempDir() })
    try {
      const first = checkpoint('profile-a:session-a', 4),
        other = checkpoint('profile-b:session-b', 7)
      await a.writeVerifiedHead!(first)
      await a.writeVerifiedHead!(other)
      await b.writeVerifiedHead!(checkpoint(first.sessionKey, 9))
      expect(await a.readVerifiedHead!(first.sessionKey)).toEqual(first)
      expect(await a.readVerifiedHead!(other.sessionKey)).toEqual(other)
      expect((await b.readVerifiedHead!(first.sessionKey))?.throughSeq).toBe(9)
      expect(await b.readVerifiedHead!(other.sessionKey)).toBeUndefined()
      await a.writeVerifiedHead!(checkpoint(first.sessionKey, 2))
      expect((await a.readVerifiedHead!(first.sessionKey))?.throughSeq).toBe(4)
      await a.writeVerifiedHead!(checkpoint(first.sessionKey, 2), { force: true })
      expect((await a.readVerifiedHead!(first.sessionKey))?.throughSeq).toBe(2)
      await a.deleteVerifiedHead!(first.sessionKey)
      expect(await a.readVerifiedHead!(first.sessionKey)).toBeUndefined()
      expect(await a.readVerifiedHead!(other.sessionKey)).toEqual(other)
      expect((await b.readVerifiedHead!(first.sessionKey))?.throughSeq).toBe(9)
      expect(await a.integrityDigestAt!(other.sessionKey, 1)).toBeUndefined()
      expect(await a.ledgerStats!(other.sessionKey)).toEqual({ storedBytes: 0, maxRowBytes: 0 })
    } finally {
      await a.close()
      await b.close()
    }
  })

  it.each([
    'readVerifiedHead',
    'writeVerifiedHead',
    'deleteVerifiedHead',
    'integrityDigestAt',
    'ledgerStats',
  ] as const)('drains an in-flight %s before closing the provider store', async (method) => {
    let reached!: () => void,
      release!: () => void,
      closed = false
    const entered = new Promise<void>((resolve) => {
        reached = resolve
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
    const provider = definePersistenceProvider({
      id: 'review-drain',
      version: '1.0.0',
      state: { effect: 'restart-required' },
      capabilities: sqlitePersistenceProvider.capabilities,
      async open(options) {
        const store = await sqlitePersistenceProvider.open(options)
        const hold = async () => {
          reached()
          await gate
          expect(closed).toBe(false)
        }
        return {
          ...store,
          readVerifiedHead: async (key) => {
            await hold()
            return store.readVerifiedHead!(key)
          },
          writeVerifiedHead: async (head, options) => {
            await hold()
            return store.writeVerifiedHead!(head, options)
          },
          deleteVerifiedHead: async (key) => {
            await hold()
            return store.deleteVerifiedHead!(key)
          },
          integrityDigestAt: async (key, seq) => {
            await hold()
            return store.integrityDigestAt!(key, seq)
          },
          ledgerStats: async (key) => {
            await hold()
            return store.ledgerStats!(key)
          },
          close: async () => {
            closed = true
            await store.close()
          },
        } satisfies PersistenceSessionStore
      },
    })
    const storage = await openConfiguredPersistence({
      dataDir: tempDir(),
      providerId: provider.id,
      providers: [provider],
    })
    const invoke = () => {
      if (method === 'readVerifiedHead') return storage.readVerifiedHead!('a')
      if (method === 'writeVerifiedHead') return storage.writeVerifiedHead!(checkpoint('a'))
      if (method === 'deleteVerifiedHead') return storage.deleteVerifiedHead!('a')
      if (method === 'integrityDigestAt') return storage.integrityDigestAt!('a', 1)
      return storage.ledgerStats!('a')
    }
    const operation = invoke().then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    await entered
    let finished = false
    const closing = storage.close().then(() => {
      finished = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(closed).toBe(false)
    release()
    await operation
    await closing
    expect(closed).toBe(true)
    await expect(invoke()).rejects.toMatchObject({ code: 'E_CLOSED' })
  })
})

it('perf3-review: a legacy provider without optional methods fully verifies both cold and warm history', async () => {
  const directory = tempDir(),
    reads: number[] = []
  const provider = definePersistenceProvider({
    id: 'review-legacy',
    version: '1.0.0',
    state: { effect: 'restart-required' },
    capabilities: sqlitePersistenceProvider.capabilities,
    async open(options) {
      const store = await sqlitePersistenceProvider.open(options)
      const {
        readVerifiedHead: _read,
        writeVerifiedHead: _write,
        deleteVerifiedHead: _delete,
        integrityDigestAt: _digest,
        ledgerStats: _stats,
        ...legacy
      } = store
      return {
        ...legacy,
        scanIntegrity: async (key, query) => {
          const rows = await store.scanIntegrity!(key, query)
          reads.push(
            ...rows.map((row) => {
              const seq = row.event.seq
              if (seq === undefined) throw new Error('provider omitted sequence')
              return seq
            }),
          )
          return rows
        },
      }
    },
  })
  const storage = await openConfiguredPersistence({
    dataDir: directory,
    providerId: provider.id,
    providers: [provider],
  })
  const options = {
    storage,
    key: 'legacy',
    writerRunId: 'review-legacy',
    ttlMs: 60_000,
    ids: defaultIds(),
    clock: Date.now,
  }
  const writer = await SessionLogImpl.open(options)
  for (let i = 0; i < 5; i++)
    await writer.append([
      {
        type: 'user/message',
        data: { content: [{ type: 'text', text: `row-${i}` }] },
        actor: { id: 'human', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        origin: 'principal',
        trust: 'trusted',
      },
    ])
  await writer.close()
  reads.length = 0
  const log = await SessionLogImpl.open(options)
  try {
    expect(log.openStats.checkpoint).toEqual({ used: false, reason: 'unsupported' })
    expect(log.historyVerified).toBe(true)
    expect(reads).toEqual([1, 2, 3, 4, 5])
    reads.length = 0
    await log.verifyHistory()
    expect(log.historyVerified).toBe(true)
    expect(reads).toEqual([1, 2, 3, 4, 5])
    const db = new DatabaseSync(join(directory, 'sessions.db'))
    try {
      db.prepare(
        "UPDATE events SET data = json_set(data, '$.content[0].text', 'changed') WHERE session_key = ? AND seq = ?",
      ).run('legacy', 3)
    } finally {
      db.close()
    }
    await expect(log.verifyHistory()).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
    expect(log.faulted).toBe(true)
  } finally {
    await log.close()
    await storage.close()
  }
})
