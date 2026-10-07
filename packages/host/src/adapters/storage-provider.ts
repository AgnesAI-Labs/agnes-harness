import type { Context } from '@agnes/cordis'
import {
  type ChildControlStore,
  CoreError,
  type CoreErrorCode,
  type Event,
  type IntegrityRow,
  type StorageAdapter,
} from '@agnes/core'
import {
  DEFAULT_PERSISTENCE_PROVIDER_ID,
  definePersistenceProvider,
  defineProviderKind,
  type PersistenceCapability,
  type PersistenceLeaseClaim,
  type PersistenceProvider,
  type PersistenceScanQuery,
  type PersistenceSessionStore,
  ProviderError,
} from '@agnes/extension-api'
import { ProviderLifetime } from '../assemble/provider-lifetime.js'
import { retainProcessStore } from './storage-live.js'
import { sqlitePersistenceProvider } from './storage-sqlite-provider.js'

export { sqlitePersistenceProvider } from './storage-sqlite-provider.js'

import { ProviderRegistry } from '../assemble/provider-registry.js'
import type { CrashReclaimStore, TableStore } from './storage-sqlite.js'

export interface HostPersistence extends StorageAdapter, ChildControlStore {
  readonly capabilities: import('@agnes/extension-api').PersistenceCapabilities
  readonly sqlite?: import('@agnes/extension-api').PersistenceSqlitePort
  readonly metadata: import('@agnes/extension-api').PersistenceMetadataPort
  readonly crashReclaim: CrashReclaimStore
  tables(owner: string): TableStore
}

/** Full Host requirements; SQL is an independent, optional extension capability. */
export const HOST_PERSISTENCE_REQUIREMENTS: readonly PersistenceCapability[] = [
  'ledger',
  'metadata',
  'child-control',
  'reclaim',
  'integrity',
]

const PROVIDER_ID = /^[a-z][a-z0-9._-]{0,63}$/
const STORAGE_CODES = new Set<string>([
  'E_WRITER_LEASE',
  'E_CLOSED',
  'E_STORAGE_FAULT',
  'E_CAS',
  'E_BUDGET',
  'E_SCAN_UNBOUNDED',
  'E_SCAN_TRUNCATED',
  'E_FORMAT',
])

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

function requireCapabilities(
  provider: PersistenceProvider,
  store: PersistenceSessionStore,
): asserts store is PersistenceSessionStore & {
  metadata: NonNullable<PersistenceSessionStore['metadata']>
  childControl: ChildControlStore
  reclaim: CrashReclaimStore
  scanIntegrity: NonNullable<PersistenceSessionStore['scanIntegrity']>
  createChild: NonNullable<PersistenceSessionStore['createChild']>
} {
  const missing = HOST_PERSISTENCE_REQUIREMENTS.filter((capability) => {
    switch (capability) {
      case 'ledger':
        return (
          !provider.capabilities.ledger ||
          ['open', 'commit', 'renew', 'release', 'scan', 'registers', 'close'].some(
            (method) => typeof store[method as keyof PersistenceSessionStore] !== 'function',
          )
        )
      case 'metadata':
        return !provider.capabilities.metadata || typeof store.metadata?.namespace !== 'function'
      case 'sqlite':
        return (
          !provider.capabilities.sqlite ||
          store.sqlite?.dialect !== 'sqlite' ||
          typeof store.sqlite.tables !== 'function'
        )
      case 'child-control':
        return (
          !provider.capabilities.childControl ||
          !store.childControl ||
          [
            'childControlFormat',
            'assertWritableFormat',
            'createDelegatedChild',
            'lookupByKey',
            'lookupByCreationId',
            'listByParent',
            'listByRoot',
            'listCreatingChildAttempts',
            'beginChildAttempt',
            'deferCreatingChild',
            'commitCreatingChild',
            'cancelCreatingChild',
            'casState',
            'nextOrdinal',
            'existsSession',
            'ensureRootScope',
            'scopeForChild',
            'reserve',
            'settleOrigin',
            'releaseReservation',
            'projectTree',
            'workspace',
          ].some((method) => typeof store.childControl?.[method as keyof ChildControlStore] !== 'function') ||
          typeof store.createChild !== 'function'
        )
      case 'reclaim':
        return (
          !provider.capabilities.reclaim ||
          typeof store.reclaim?.listExpired !== 'function' ||
          typeof store.reclaim.claimForReclaim !== 'function'
        )
      case 'integrity':
        return !provider.capabilities.integrity || typeof store.scanIntegrity !== 'function'
    }
    return true
  })
  if (
    provider.capabilities.sqlite &&
    (store.sqlite?.dialect !== 'sqlite' || typeof store.sqlite.tables !== 'function')
  )
    missing.push('sqlite')
  if (missing.length)
    throw new ProviderError(
      'E_PROVIDER_INCOMPATIBLE',
      `persistence provider ${provider.id} is missing required capabilities: ${missing.join(', ')}`,
      {
        kind: 'persistence',
        provider: provider.id,
        operation: 'open',
        hint: `Required capabilities: ${missing.join(', ')}`,
      },
    )
}

/** Every provider, including SQLite, is consumed through exactly these public ports. */
function bridge(
  store: Parameters<typeof requireCapabilities>[1],
  provider: PersistenceProvider,
): HostPersistence {
  requireCapabilities(provider, store)
  const childControl = store.childControl
  const children: ChildControlStore = {
    childControlFormat: (...args) => childControl.childControlFormat(...args),
    assertWritableFormat: (...args) => childControl.assertWritableFormat(...args),
    createDelegatedChild: (...args) => childControl.createDelegatedChild(...args),
    lookupByKey: (...args) => childControl.lookupByKey(...args),
    lookupByCreationId: (...args) => childControl.lookupByCreationId(...args),
    listByParent: (...args) => childControl.listByParent(...args),
    listByRoot: (...args) => childControl.listByRoot(...args),
    listCreatingChildAttempts: (...args) => childControl.listCreatingChildAttempts(...args),
    beginChildAttempt: (...args) => childControl.beginChildAttempt(...args),
    deferCreatingChild: (...args) => childControl.deferCreatingChild(...args),
    commitCreatingChild: (...args) => childControl.commitCreatingChild(...args),
    cancelCreatingChild: (...args) => childControl.cancelCreatingChild(...args),
    casState: (...args) => childControl.casState(...args),
    nextOrdinal: (...args) => childControl.nextOrdinal(...args),
    existsSession: (...args) => childControl.existsSession(...args),
    ensureRootScope: (...args) => childControl.ensureRootScope(...args),
    scopeForChild: (...args) => childControl.scopeForChild(...args),
    reserve: (...args) => childControl.reserve(...args),
    settleOrigin: (...args) => childControl.settleOrigin(...args),
    releaseReservation: (...args) => childControl.releaseReservation(...args),
    projectTree: (...args) => childControl.projectTree(...args),
    workspace: (...args) => childControl.workspace(...args),
    ...(childControl.updateWorkspace
      ? { updateWorkspace: childControl.updateWorkspace.bind(childControl) }
      : {}),
    ...(childControl.lookupWorkspaceByPath
      ? { lookupWorkspaceByPath: childControl.lookupWorkspaceByPath.bind(childControl) }
      : {}),
    ...(childControl.bumpWriterGeneration
      ? { bumpWriterGeneration: childControl.bumpWriterGeneration.bind(childControl) }
      : {}),
    ...(childControl.takeoverReservation
      ? { takeoverReservation: childControl.takeoverReservation.bind(childControl) }
      : {}),
    ...(childControl.writerGeneration
      ? { writerGeneration: childControl.writerGeneration.bind(childControl) }
      : {}),
    ...(childControl.peekReservation
      ? { peekReservation: childControl.peekReservation.bind(childControl) }
      : {}),
    ...(childControl.lookupReservationByIdentity
      ? { lookupReservationByIdentity: childControl.lookupReservationByIdentity.bind(childControl) }
      : {}),
    ...(childControl.clearWriterLease
      ? { clearWriterLease: childControl.clearWriterLease.bind(childControl) }
      : {}),
  }
  // Core recovery recognizes typed CAS/budget errors, independent of the provider's error class.
  for (const [key, operation] of Object.entries(children))
    Object.defineProperty(children, key, {
      enumerable: true,
      value: (...args: unknown[]) => {
        if (key === 'childControlFormat' || key === 'assertWritableFormat') {
          try {
            return Reflect.apply(operation, childControl, args)
          } catch (error) {
            throw asCore(error)
          }
        }
        return call(async () => Reflect.apply(operation, childControl, args))
      },
    })
  const discardNewSession = store.discardNewSession?.bind(store)
  const ledger = {
    capabilities: provider.capabilities,
    ...(store.sqlite ? { sqlite: store.sqlite } : {}),
    metadata: store.metadata,
    crashReclaim: store.reclaim,
    tables: (owner: string) => {
      if (!store.sqlite)
        throw new ProviderError(
          'E_PROVIDER_INCOMPATIBLE',
          `persistence provider ${provider.id} does not support SQL tables`,
          { kind: 'persistence', provider: provider.id, operation: 'tables' },
        )
      return store.sqlite.tables(owner)
    },
    open: (key: string, claim: { writerRunId: string; ttlMs: number }) => call(() => store.open(key, claim)),
    commit: (key: string, tx: Parameters<StorageAdapter['commit']>[1]) => call(() => store.commit(key, tx)),
    renew: (key: string, runId: string, claim?: PersistenceLeaseClaim) =>
      call(() => store.renew(key, runId, claim)),
    release: (key: string, runId: string) => call(() => store.release(key, runId)),
    scan: (key: string, query: PersistenceScanQuery) =>
      call(async () => (await store.scan(key, query)) as Event[]),
    scanIntegrity: (key: string, query: { fromSeq: number; toSeq: number; limit: number }) =>
      call(async () => (await store.scanIntegrity(key, query)) as IntegrityRow[]),
    registers: (key: string) => call(() => store.registers(key)),
    createChild: (parent: string, seq: number, child: string) =>
      call(() => store.createChild(parent, seq, child)),
    ...(discardNewSession
      ? {
          discardNewSession: (key: string, runId: string, claim?: PersistenceLeaseClaim) =>
            call(() => discardNewSession(key, runId, claim)),
        }
      : {}),
    close: () => call(() => store.close()),
  }
  return { ...children, ...ledger }
}

function accept(provider: PersistenceProvider, source: string): PersistenceProvider {
  try {
    return definePersistenceProvider(provider)
  } catch (error) {
    throw new ProviderError('E_PROVIDER_INVALID', error instanceof Error ? error.message : String(error), {
      kind: 'persistence',
      provider: provider.id ?? source,
      operation: 'register',
      cause: error,
    })
  }
}

/** Own stores even when a plugin opens one through the shared registration port. */
class PersistenceProviderRegistry extends ProviderRegistry<PersistenceProvider> {
  override register(
    source: string,
    provider: PersistenceProvider,
    owner?: Context,
    cleanup?: () => void | Promise<void>,
  ): () => Promise<void> {
    this.validate(source, provider)
    const lifetime = new ProviderLifetime('persistence', provider.id)
    const wrapped: PersistenceProvider = {
      ...provider,
      open: (options) =>
        lifetime
          .run(async (signal) => {
            const store = await provider.open({ ...options, signal })
            const instance = new ProviderLifetime('persistence', provider.id)
            const close = lifetime.own(() =>
              instance.close(() => {
                if (typeof store?.close === 'function') return store.close()
              }),
            )
            const valid =
              store &&
              ['open', 'commit', 'renew', 'release', 'scan', 'registers', 'close'].every(
                (key) => typeof store[key as keyof PersistenceSessionStore] === 'function',
              )
            if (!valid || signal.aborted) {
              await close()
              signal.throwIfAborted()
              throw new ProviderError(
                'E_PROVIDER_INVALID',
                'Persistence provider returned an invalid store',
                {
                  kind: 'persistence',
                  provider: provider.id,
                  operation: 'open',
                },
              )
            }
            const asynchronous = new Set<PropertyKey>([
              'open',
              'commit',
              'renew',
              'release',
              'scan',
              'registers',
              'scanIntegrity',
              'createChild',
              'discardNewSession',
            ])
            // Preserve optional provider methods and SQLite's extra host ports without inventing them.
            const view = new Proxy(store, {
              get(target, key) {
                if (key === 'close') return close
                const value: unknown = Reflect.get(target, key, target)
                if (typeof value !== 'function') return value
                return (...args: unknown[]) => {
                  if (owner) lifetime.assertActive()
                  instance.assertActive()
                  if (asynchronous.has(key))
                    return instance.run(
                      () => Reflect.apply(value, target, args),
                      owner ? lifetime.signal : undefined,
                    )
                  return Reflect.apply(value, target, args)
                }
              },
            })
            return { view, close }
          }, options.signal)
          .then(({ view, close }) => {
            // Startup stores outlive ordinary plugin registries. openAdapters' process reference
            // closes them after sessions release their leases; plugin-opened stores remain fiber-owned.
            if (!owner) lifetime.disown(close)
            return view
          }),
    }
    return super.register(source, wrapped, owner, () => lifetime.close(cleanup))
  }
}

export function createPersistenceProviderRegistry(
  modules: ReadonlyMap<string, { persistenceProvider?: PersistenceProvider }> | undefined,
  providers: readonly PersistenceProvider[] | undefined,
): ProviderRegistry<PersistenceProvider> {
  const registry = new PersistenceProviderRegistry(
    defineProviderKind<PersistenceProvider>({
      kind: 'persistence',
      restartRequired: true,
      validate: (provider) => {
        definePersistenceProvider(provider)
      },
      capabilities: (provider) => [
        'ledger',
        ...(provider.capabilities.metadata ? ['metadata'] : []),
        ...(provider.capabilities.childControl ? ['child-control'] : []),
        ...(provider.capabilities.reclaim ? ['reclaim'] : []),
        ...(provider.capabilities.integrity ? ['integrity'] : []),
        ...(provider.capabilities.sqlite ? ['sqlite'] : []),
      ],
    }),
  )
  registry.register('@agnes/host', sqlitePersistenceProvider)
  const add = (provider: PersistenceProvider, source: string): void => {
    const checked = accept(provider, source)
    if (checked.id === DEFAULT_PERSISTENCE_PROVIDER_ID)
      throw new ProviderError('E_PROVIDER_DUPLICATE', 'the sqlite persistence provider is built in', {
        kind: 'persistence',
        provider: checked.id,
        operation: 'register',
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
  signal?: AbortSignal
  providerId?: string
  modules?: ReadonlyMap<string, { persistenceProvider?: PersistenceProvider }>
  providers?: readonly PersistenceProvider[]
}): Promise<HostPersistence> {
  args.signal?.throwIfAborted()
  const providerId = args.providerId ?? DEFAULT_PERSISTENCE_PROVIDER_ID
  if (!PROVIDER_ID.test(providerId))
    throw new ProviderError('E_PROVIDER_INVALID', 'persistence.provider id is invalid', {
      kind: 'persistence',
      provider: providerId,
      operation: 'select',
    })
  const registry = createPersistenceProviderRegistry(args.modules, args.providers)
  const provider = registry.select('process', providerId)
  const storage = await retainProcessStore(args.dataDir, provider, async () => {
    const store = await provider.open({
      dataDir: args.dataDir,
      ...(args.signal ? { signal: args.signal } : {}),
    })
    try {
      return bridge(store, provider)
    } catch (error) {
      try {
        await store.close()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Persistence creation cleanup failed')
      }
      throw error
    }
  })
  if (args.signal?.aborted) {
    await storage.close()
    args.signal.throwIfAborted()
  }
  catalogs.set(storage, registry)
  return storage
}

const catalogs = new WeakMap<HostPersistence, ProviderRegistry<PersistenceProvider>>()
/** The actual process-owned store selection, including embedding-supplied providers. */
export function persistenceProviderRegistry(
  storage: HostPersistence,
): ProviderRegistry<PersistenceProvider> | undefined {
  return catalogs.get(storage)
}
