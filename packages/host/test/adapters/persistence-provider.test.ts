import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { definePersistenceProvider, type PersistenceSessionStore } from '@agnes/extension-api'
import { persistenceContract, persistenceSqliteContract } from '@agnes/extension-api/testkit'
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
  persistenceSqliteContract('sqlite', () => {
    const dir = tempDir()
    return { open: () => sqlitePersistenceProvider.open({ dataDir: dir }) }
  })

  it('keeps the default adapter bundle on sqlite', async () => {
    const dir = tempDir()
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
      expect(bundle.storage.sqlite.dialect).toBe('sqlite')
      expect(existsSync(join(dir, 'sessions.db'))).toBe(true)
      expect('file' in bundle.storage).toBe(false)
    } finally {
      await bundle.close()
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
        return {
          ...store,
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
      const kv = bundle.storage.metadata.namespace('owner', 'config')
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
      expect(existsSync(join(dir, 'sessions.db'))).toBe(false)
    } finally {
      await bundle.close()
    }
  })

  it.each(['metadata', 'sqlite', 'childControl', 'reclaim', 'scanIntegrity'] as const)(
    'refuses a selected provider missing %s before publishing the store and closes it',
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
      ).rejects.toMatchObject({ code: 'E_SEAM_INIT', detail: { provider: 'incomplete' } })
      expect(closed).toBe(true)
    },
  )

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
    ).rejects.toMatchObject({ code: 'E_SEAM_INIT' })
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
    ).rejects.toMatchObject({ code: 'E_SEAM_INIT' })
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
