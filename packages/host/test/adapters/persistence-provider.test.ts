import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreError } from '@agnes/core'
import { definePersistenceProvider, type PersistenceSessionStore } from '@agnes/extension-api'
import {
  persistenceContract,
  persistenceHostContract,
  persistenceSqliteContract,
} from '@agnes/extension-api/testkit/persistence-contract'
import { afterAll, describe, expect, it } from 'vitest'
import { openAdapters, sqlitePersistenceProvider } from '../../src/adapters/index.js'
import { readNamedExports } from '../../src/assemble/packages.js'
import { resolveProfile } from '../../src/profile/resolve.js'
import type { LockState, ProfileFragment, ResolveEnv } from '../../src/profile/types.js'

const env: ResolveEnv = {
  platform: { os: 'linux', arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-07T00:00:00Z',
}
const lock: LockState = {
  packages: {
    '@agnes/base': { version: '0.1.0', integrity: 'sha512-b', trust: 'builtin', enabled: true },
    '@agnes/code': { version: '0.1.0', integrity: 'sha512-c', trust: 'builtin', enabled: true },
    '@agnes/ai': { version: '0.1.0', integrity: 'sha512-a', trust: 'builtin', enabled: true },
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
      const metadata = bundle.storage.metadata.namespace('owner', 'config')
      expect(metadata.get('legacy')).toEqual({ enabled: true })
      metadata.delete('legacy')
      expect(bundle.storage.metadata.namespace('owner', 'config').get('legacy')).toBeUndefined()
    } finally {
      await bundle.close()
    }
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
        return {
          ...store,
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

  it('reads persistence.provider from the user profile and omits the sqlite default', async () => {
    const omitted = await resolveProfile({ builtin: 'local-dev', lock, user: { name: 'local-dev' } }, env)
    const explicit = await resolveProfile(
      { builtin: 'local-dev', lock, user: { name: 'local-dev', persistence: { provider: 'sqlite' } } },
      env,
    )
    const selected = await resolveProfile(
      { builtin: 'local-dev', lock, user: { name: 'local-dev', persistence: { provider: 'jsonl' } } },
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
          user: { name: 'local-dev', persistence: { provider: 'Bad' } },
        },
        env,
      ),
    ).rejects.toMatchObject({ code: 'E_PROFILE_FRAGMENT_KEY' })
    await expect(
      resolveProfile(
        {
          builtin: 'local-dev',
          lock: { ...lock, workspace: { path: '/work', hash: 'sha256-workspace', manifestId: 'fixture' } },
          workspaceOverlay: { persistence: { provider: 'jsonl' } } as unknown as ProfileFragment,
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
  const { seams, mcpCatalogHubFor } = await import('@agnes/base')
  const { fakeSeamInit } = await import('@agnes/base/testkit')
  const { toSeamAdapters } = await import('../../src/adapters/index.js')
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
    const ledger = await seams.ledger(init)
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
    const harness = await seams.harness(init)
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
