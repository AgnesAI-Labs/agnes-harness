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
  PERSISTENCE_EFFECT,
  type PersistenceCapability,
  type PersistenceLeaseClaim,
  type PersistenceProvider,
  type PersistenceScanQuery,
  type PersistenceSessionStore,
} from '@agnes/extension-api'
import { ProviderLifetime } from '../assemble/provider-lifetime.js'
import { sqlitePersistenceProvider } from './storage-sqlite-provider.js'

export { sqlitePersistenceProvider } from './storage-sqlite-provider.js'

import { ProviderRegistry } from '../assemble/provider-registry.js'
import { HostError } from '../errors.js'
import type { CrashReclaimStore, TableStore } from './storage-sqlite.js'

export interface HostPersistence extends StorageAdapter, ChildControlStore {
  readonly capabilities: import('@agnes/extension-api').PersistenceCapabilities
  readonly sqlite: import('@agnes/extension-api').PersistenceSqlitePort
  readonly metadata: import('@agnes/extension-api').PersistenceMetadataPort
  readonly crashReclaim: CrashReclaimStore
  tables(owner: string): TableStore
}

/** The current Host's SQL-backed seams and durable recovery/children require these ports. */
export const HOST_PERSISTENCE_REQUIREMENTS: readonly PersistenceCapability[] = [
  'ledger',
  'metadata',
  'sqlite',
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
  sqlite: NonNullable<PersistenceSessionStore['sqlite']>
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
  if (missing.length)
    throw new HostError(
      'E_SEAM_INIT',
      `persistence provider ${provider.id} is missing required capabilities: ${missing.join(', ')}`,
      { detail: { provider: provider.id, missing, effect: PERSISTENCE_EFFECT } },
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
  const discardNewSession = store.discardNewSession?.bind(store)
  const ledger = {
    capabilities: provider.capabilities,
    sqlite: store.sqlite,
    metadata: store.metadata,
    crashReclaim: store.reclaim,
    tables: (owner: string) => store.sqlite.tables(owner),
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
    throw new HostError('E_SEAM_INIT', error instanceof Error ? error.message : String(error), {
      detail: { provider: source, effect: PERSISTENCE_EFFECT },
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
    // Startup stores belong to openAdapters, which outlives ordinary plugin generations.
    if (!owner) return super.register(source, provider, owner, cleanup)
    this.validate(source, provider)
    const lifetime = new ProviderLifetime('persistence', provider.id)
    const wrapped: PersistenceProvider = {
      ...provider,
      open: (options) =>
        lifetime.run(async (signal) => {
          const store = await provider.open(options)
          const instance = new ProviderLifetime('persistence', provider.id)
          const close = lifetime.own(() => instance.close(() => store.close()))
          if (signal.aborted) {
            await close()
            signal.throwIfAborted()
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
          return new Proxy(store, {
            get(target, key) {
              if (key === 'close') return close
              const value: unknown = Reflect.get(target, key, target)
              if (typeof value !== 'function') return value
              return (...args: unknown[]) => {
                lifetime.assertActive()
                instance.assertActive()
                if (asynchronous.has(key))
                  return instance.run(() => Reflect.apply(value, target, args), lifetime.signal)
                return Reflect.apply(value, target, args)
              }
            },
          })
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
}): Promise<HostPersistence> {
  const providerId = args.providerId ?? DEFAULT_PERSISTENCE_PROVIDER_ID
  if (!PROVIDER_ID.test(providerId))
    throw new HostError('E_SEAM_INIT', 'persistence.provider id is invalid', {
      detail: { provider: providerId, effect: PERSISTENCE_EFFECT },
    })
  const registry = createPersistenceProviderRegistry(args.modules, args.providers)
  const provider = registry.select('process', providerId)
  const store = await provider.open({ dataDir: args.dataDir })
  let storage: HostPersistence
  try {
    storage = bridge(store, provider)
  } catch (error) {
    await store.close().catch(() => {})
    throw error
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
