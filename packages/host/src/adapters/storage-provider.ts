import { join } from 'node:path'
import { CoreError, type CoreErrorCode } from '@agnes/core'
import {
  defineProviderKind,
  DEFAULT_PERSISTENCE_PROVIDER_ID,
  definePersistenceProvider,
  PERSISTENCE_EFFECT,
  type PersistenceCommit,
  type PersistenceLeaseClaim,
  type PersistenceProvider,
  type PersistenceScanQuery,
  type PersistenceSessionStore,
} from '@agnes/extension-api'
import { HostError } from '../errors.js'
import { ProviderRegistry } from '../assemble/provider-registry.js'
import { createSqliteStorage, type SqliteStorage } from './storage-sqlite.js'

const PROVIDER_ID = /^[a-z][a-z0-9._-]{0,63}$/
const STORAGE_CODES = new Set<string>([
  'E_WRITER_LEASE',
  'E_CLOSED',
  'E_STORAGE_FAULT',
  'E_CAS',
  'E_SCAN_UNBOUNDED',
  'E_SCAN_TRUNCATED',
  'E_FORMAT',
])

/**
 * Built-in provider. `open` returns the same SQLite store `openAdapters` used before providers
 * existed, so the default path is still a `SqliteStorage` (child control and crash reclaim included).
 */
export const sqlitePersistenceProvider = definePersistenceProvider({
  id: DEFAULT_PERSISTENCE_PROVIDER_ID,
  version: '1',
  state: { effect: PERSISTENCE_EFFECT },
  open(options) {
    return createSqliteStorage({
      file: join(options.dataDir, 'sessions.db'),
      tablesDir: join(options.dataDir, 'tables'),
      ...(options.clock ? { clock: options.clock } : {}),
    }) as unknown as PersistenceSessionStore
  },
})

function asCore(error: unknown): unknown {
  if (error instanceof CoreError) return error
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && STORAGE_CODES.has(code))
      return new CoreError(code as CoreErrorCode, error.message)
  }
  return error
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw asCore(error)
  }
}

function unsupported(method: string): CoreError {
  return new CoreError('E_STORAGE_FAULT', `persistence provider does not implement ${method}`)
}

/**
 * Session methods go through the provider. Child control stays on SQLite: a store without those
 * methods is invisible to `hasChildControl`. Crash reclaim is an empty port so a non-sqlite store
 * is not asked to run the SQLite claim SQL. Package tables are the provider's own.
 */
function bridge(store: PersistenceSessionStore, id: string, dataDir: string): SqliteStorage {
  return {
    file: join(dataDir, `persistence-${id}`),
    journalMode: () => 'provider',
    coreTableNames: () => [],
    crashReclaim: {
      listExpired() {
        return []
      },
      claimForReclaim() {
        return null
      },
    },
    tables(owner: string) {
      return store.tables(owner)
    },
    open(key: string, claim: { writerRunId: string; ttlMs: number }) {
      return call(() => store.open(key, claim))
    },
    commit(key: string, tx: PersistenceCommit) {
      return call(() => store.commit(key, tx))
    },
    renew(key: string, runId: string, claim?: PersistenceLeaseClaim) {
      return call(() => store.renew(key, runId, claim))
    },
    release(key: string, runId: string) {
      return call(() => store.release(key, runId))
    },
    scan(key: string, query: PersistenceScanQuery) {
      return call(() => store.scan(key, query))
    },
    async scanIntegrity(key: string, query: { fromSeq: number; toSeq: number; limit: number }) {
      if (!store.scanIntegrity) throw unsupported('scanIntegrity')
      return call(() => store.scanIntegrity!(key, query))
    },
    registers(key: string) {
      return call(() => store.registers(key))
    },
    async createChild(parentKey: string, boundarySeq: number, childKey: string) {
      if (!store.createChild) throw unsupported('createChild')
      return call(() => store.createChild!(parentKey, boundarySeq, childKey))
    },
    async discardNewSession(key: string, runId: string, claim?: PersistenceLeaseClaim) {
      if (!store.discardNewSession) throw unsupported('discardNewSession')
      return call(() => store.discardNewSession!(key, runId, claim))
    },
    close() {
      return call(() => store.close())
    },
  } as unknown as SqliteStorage
}

function accept(provider: PersistenceProvider, source: string): PersistenceProvider {
  try {
    return definePersistenceProvider(provider)
  } catch (error) {
    throw new HostError('E_SEAM_INIT', error instanceof Error ? error.message : String(error), {
      detail: { provider: source, effect: PERSISTENCE_EFFECT },
    })
  }
}

export function createPersistenceProviderRegistry(
  modules: ReadonlyMap<string, { persistenceProvider?: PersistenceProvider }> | undefined,
  providers: readonly PersistenceProvider[] | undefined,
): ProviderRegistry<PersistenceProvider> {
  const registry = new ProviderRegistry(
    defineProviderKind<PersistenceProvider>({
      kind: 'persistence',
      restartRequired: true,
      validate: (provider) => {
        definePersistenceProvider(provider)
      },
      capabilities: () => ['sessions', 'tables'],
    }),
  )
  registry.register('@agnes/host', sqlitePersistenceProvider)
  const add = (provider: PersistenceProvider, source: string): void => {
    const checked = accept(provider, source)
    if (checked.id === DEFAULT_PERSISTENCE_PROVIDER_ID)
      throw new HostError('E_SEAM_INIT', 'the sqlite persistence provider is built in', {
        detail: { provider: checked.id, effect: PERSISTENCE_EFFECT },
      })
    registry.register(source, checked)
  }
  if (modules) {
    for (const [id, mod] of modules) if (mod.persistenceProvider) add(mod.persistenceProvider, id)
  }
  for (const provider of providers ?? []) add(provider, provider.id)
  return registry
}

/** Opens the provider selected at process start. The built-in id is `sqlite`. */
export async function openConfiguredPersistence(args: {
  dataDir: string
  providerId?: string
  modules?: ReadonlyMap<string, { persistenceProvider?: PersistenceProvider }>
  providers?: readonly PersistenceProvider[]
}): Promise<SqliteStorage> {
  const providerId = args.providerId ?? DEFAULT_PERSISTENCE_PROVIDER_ID
  if (!PROVIDER_ID.test(providerId))
    throw new HostError('E_SEAM_INIT', 'persistence.provider id is invalid', {
      detail: { provider: providerId, effect: PERSISTENCE_EFFECT },
    })
  const registry = createPersistenceProviderRegistry(args.modules, args.providers)
  const provider = registry.select('process', providerId)
  const store = await provider.open({ dataDir: args.dataDir })
  const storage =
    provider.id === DEFAULT_PERSISTENCE_PROVIDER_ID
      ? (store as unknown as SqliteStorage)
      : bridge(store, provider.id, args.dataDir)
  catalogs.set(storage, registry)
  return storage
}

const catalogs = new WeakMap<SqliteStorage, ProviderRegistry<PersistenceProvider>>()
/** The actual process-owned store selection, including embedding-supplied providers. */
export function persistenceProviderRegistry(
  storage: SqliteStorage,
): ProviderRegistry<PersistenceProvider> | undefined {
  return catalogs.get(storage)
}
