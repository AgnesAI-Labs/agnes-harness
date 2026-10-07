import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { definePersistenceProvider, type PersistenceSessionStore } from '@agnes/extension-api'
import { persistenceContract } from '@agnes/extension-api/testkit'
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
    tables() {
      return {
        table: (name) => ({
          name,
          exec() {},
          run() {
            return { changes: 0 }
          },
          all: () => [],
          get: () => undefined,
          transaction: (fn) => fn(),
        }),
      }
    },
    async close() {},
  }
}

describe('persistence provider', () => {
  persistenceContract('sqlite', () => {
    const dir = tempDir()
    return { open: () => sqlitePersistenceProvider.open({ dataDir: dir }) }
  })

  it('keeps the default adapter bundle on sqlite', async () => {
    const dir = tempDir()
    const profile = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const bundle = await openAdapters(profile, { dataDir: dir, workspaceRoot: dir })
    try {
      expect(profile.persistence).toBeUndefined()
      expect(bundle.storage.journalMode()).toBe('wal')
      expect(bundle.storage.file).toBe(join(dir, 'sessions.db'))
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

  it('uses a configured provider and does not open sessions.db', async () => {
    const seen: string[] = []
    const provider = definePersistenceProvider({
      id: 'fake',
      version: '1.0.0',
      state: { effect: 'restart-required' },
      open() {
        const store = emptyStore()
        return {
          ...store,
          async commit() {
            seen.push('commit')
            return { firstSeq: 1, seqs: [1] }
          },
          async scan() {
            seen.push('scan')
            return []
          },
        }
      },
    })
    const dir = tempDir()
    const profile = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const bundle = await openAdapters(profile, {
      dataDir: dir,
      workspaceRoot: dir,
      persistence: { provider: 'fake' },
      persistenceProviders: [provider],
    })
    try {
      expect(bundle.storage.journalMode()).toBe('provider')
      expect(bundle.storage.file).toBe(join(dir, 'persistence-fake'))
      await bundle.storage.commit('k', {
        events: [
          {
            ts: '2026-09-07T00:00:00.000Z',
            id: '01',
            type: 'user/message',
            lane: 'main',
            v: 1,
            actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
            origin: 'principal',
            trust: 'trusted',
            data: {},
          },
        ],
        expectedWriterRunId: 'r',
      })
      await bundle.storage.scan('k', { limit: 1 })
      expect(seen).toEqual(['commit', 'scan'])
      expect(existsSync(join(dir, 'sessions.db'))).toBe(false)
    } finally {
      await bundle.close()
    }
  })

  it('refuses a provider that replaces sqlite or omits restart-required', async () => {
    const dir = tempDir()
    const profile = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const builtin = definePersistenceProvider({
      id: 'sqlite',
      version: '1.0.0',
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
