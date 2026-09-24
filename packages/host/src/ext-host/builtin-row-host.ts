import type {
  ExtensionContext,
  ExtensionFactory,
  ExtensionManifest,
  LeaseView,
  Logger,
} from '@agnes/extension-api'
import { HostError } from '../errors.js'
import { buildExtensionAPI } from './api-proxy.js'
import { diagnostic, type LoadStage, loadError } from './diagnostics.js'
import { DisposerBag, LateRegistrationBag } from './disposers.js'
import type { ExtensionOwners } from './extension-owners.js'
import {
  type ExtensionOrder,
  ExtensionStatusBook,
  type OrderedExtensionStatus,
} from './extension-status-book.js'
import { type Lease, leaseFor, ROW_BOUND_LEASE_TTL_MS } from './lease.js'
import type { ExtensionSpec, ExtensionStatus } from './managed-host.js'
import { mapResult } from './map-result.js'
import type { KernelPorts } from './ports.js'
import { preflightEmbeddedExtension, preflightExtension } from './preflight.js'

export type BuiltinRowHostOptions = Readonly<{
  /** Shared with the plugin-row host: a row id is owned by one supplier at a time, whoever it is. */
  owners: ExtensionOwners
  order: ExtensionOrder
  ports: KernelPorts
  platform: ExtensionContext['platform']
  /** Starts `shutdown` for every open session; the source's handlers are captured before it awaits. */
  shutdown(source: string, context: { reason: 'revoke' | 'reload'; lease: LeaseView }): Promise<void>
  loader: { import(file: string): Promise<Record<string, unknown>> }
  ceiling: readonly string[]
  info: ExtensionContext['info']
  log: Logger
  audit?: (kind: string, detail: Record<string, unknown>) => unknown
  clock?: () => number
}>

export type BuiltinRowLoad = Readonly<{
  /** The `ext:` row that supplies the extension. */
  rowId: string
  spec: ExtensionSpec
  /** A manifest compiled into the release; without it the manifest is read from `spec.dir`. */
  embedded?: ExtensionManifest
  /**
   * Yields the factory: the isolation selector's answer, or nothing to fall back to the entry file.
   * Receives this load's token so an async failure report (an isolated child crashing after this
   * generation was evicted) can be told apart from the generation that is `current` now.
   */
  factory: (token: symbol) => ExtensionFactory | undefined | Promise<ExtensionFactory | undefined>
  /** Only Host-owned dynamic resource rows may register after their factory returns. */
  registration?: 'factory' | 'lifetime'
  /** Refresh session generation views when a live dynamic row changes its registrations. */
  onLateRegistration?: () => void
}>

export type BuiltinRowHandle = Readonly<{
  loaded: boolean
  error?: { code: string; message: string }
  /** Unloads the extension unless a newer owner has taken the row over. */
  release(reason: string): Promise<void>
}>

// A call rather than an inline comparison: the state changes across awaits, so it must not narrow.
const retired = (r: RowEntry): boolean => r.state === 'retired'

type RowEntry = {
  rowId: string
  spec: ExtensionSpec
  token: symbol
  version: string
  state: 'loading' | 'live' | 'retired'
  loaded: boolean
  lease?: Lease
  ac: AbortController
  /** What the extension registered through its API. Released first, synchronously. */
  registrations: DisposerBag
  /** What the factory returned. Released after `shutdown` has been dispatched. */
  own: DisposerBag
  isolation?: ExtensionStatus['isolation']
  error?: ExtensionStatus['error']
  /** The load itself failed; there is nothing to unload and the failure stays listed. */
  failed?: boolean
  retiring?: Promise<void>
}

/**
 * Builtin extensions supplied by an `ext:` row rather than by the managed host. The lifecycle is the
 * managed host's (admission, factory, lease, four-step unload) but ownership is per row, so a
 * plugin row that replaces the builtin, and the builtin coming back, hand over without colliding.
 */
export function createBuiltinRowHost(options: BuiltinRowHostOptions) {
  const clock = options.clock ?? (() => Date.now())
  const book = new ExtensionStatusBook(options.order)
  const current = new Map<string, RowEntry>()
  const leases = new Map<string, Lease>()

  const say = (kind: string, detail: Record<string, unknown>) =>
    diagnostic(() => options.audit?.(kind, detail))
  const view = (r: RowEntry): ExtensionStatus => ({
    id: r.spec.id,
    package: r.spec.package,
    version: r.version,
    trust: r.spec.trust,
    loaded: r.loaded,
    ...(r.spec.integrity ? { integrity: r.spec.integrity } : {}),
    ...(r.spec.revision ? { revision: r.spec.revision } : {}),
    ...(r.state !== 'retired' && r.lease ? { lease: r.lease.view() } : {}),
    ...(r.isolation ? { isolation: { ...r.isolation } } : {}),
    ...(r.error ? { error: { ...r.error } } : {}),
  })
  // A wind-down of an evicted record runs after its successor may already be listed.
  const publish = (r: RowEntry) => {
    if (current.get(r.spec.id) === r) book.set(view(r))
  }

  const retire = (r: RowEntry, reason: string): Promise<void> => {
    if (r.retiring) return r.retiring
    if (r.failed) return Promise.resolve()
    const wasLoaded = r.loaded
    r.state = 'retired'
    r.lease?.revoke(reason)
    if (wasLoaded) r.error = { code: 'E_LEASE_EXPIRED', message: 'extension revoked' }
    r.loaded = false
    r.ac.abort()
    // The handlers have to be captured before anything is released, and the registrations have to
    // be gone before this returns: a successor registers the same names right after taking the row.
    const shutdown =
      wasLoaded && r.lease
        ? options.shutdown(r.spec.id, { reason: 'revoke', lease: r.lease.view() }).catch(() => {
            diagnostic(() => options.log.warn('extension shutdown incomplete'))
          })
        : Promise.resolve()
    const first = r.registrations.disposeAll()
    publish(r)
    r.retiring = (async () => {
      await shutdown
      const own = await r.own.disposeAllAsync()
      if (first.failed) await r.registrations.disposeAllAsync()
      if (own.failed) diagnostic(() => options.log.warn('extension cleanup incomplete'))
      // A successor that took the row over registers under the same id, so the kernel's view of the
      // id can only be compared with nothing once no other record holds it.
      const successorHolds = current.get(r.spec.id) !== r
      const clean =
        own.failed === 0 &&
        r.registrations.size === 0 &&
        r.own.size === 0 &&
        (successorHolds || options.ports.registrations(r.spec.id).length === 0)
      if (leases.get(r.spec.id) === r.lease) leases.delete(r.spec.id)
      delete r.lease
      if (wasLoaded)
        say('extension.revoked', {
          id: r.spec.id,
          package: r.spec.package,
          trust: r.spec.trust,
          reason,
          cleanupPending: !clean,
        })
      if (!clean)
        say('extension.revoke_failed', {
          id: r.spec.id,
          row: r.rowId,
          message: 'extension cleanup incomplete',
        })
      publish(r)
    })()
    return r.retiring
  }

  const fail = async (r: RowEntry, error: unknown, stage: LoadStage) => {
    r.state = 'retired'
    r.failed = true
    r.loaded = false
    r.lease?.revoke('unloaded')
    r.ac.abort()
    await r.own.disposeAllAsync()
    await r.registrations.disposeAllAsync()
    if (leases.get(r.spec.id) === r.lease) leases.delete(r.spec.id)
    delete r.lease
    r.error = loadError(error, stage)
    diagnostic(() => options.log.error('extension failed to load', { id: r.spec.id, ...r.error }))
    say('extension.failed', { id: r.spec.id, package: r.spec.package, ...r.error })
    publish(r)
  }

  const run = async (input: BuiltinRowLoad, r: RowEntry) => {
    const { spec } = input
    let stage: LoadStage = 'identity'
    try {
      if (options.ports.registrations(spec.id).length)
        throw new HostError('E_EXT_LOAD', 'extension identity is already held')
      stage = 'manifest'
      const checked = input.embedded
        ? {
            manifest: preflightEmbeddedExtension({
              id: spec.id,
              manifest: input.embedded,
              ceiling: options.ceiling,
              apiVersion: options.info.apiVersion,
            }),
            entry: '',
          }
        : preflightExtension({
            id: spec.id,
            dir: spec.dir,
            ceiling: options.ceiling,
            apiVersion: options.info.apiVersion,
          })
      const { manifest, entry } = checked
      r.version = manifest.version
      stage = 'factory'
      const injected = await input.factory(r.token)
      let factory: ExtensionFactory
      if (injected) factory = injected
      else {
        if (input.embedded) throw new HostError('E_EXT_LOAD', 'embedded extension factory missing')
        stage = 'import'
        const module = await options.loader.import(entry)
        stage = 'export'
        if (typeof module.default !== 'function')
          throw new HostError('E_EXT_LOAD', 'extension factory missing')
        factory = module.default as ExtensionFactory
      }
      // Taken over while the factory was being prepared: nothing is registered yet, and a lease
      // issued now would never be revoked and would shadow the successor's.
      if (retired(r)) return
      const lease = leaseFor(manifest, { ttlMs: ROW_BOUND_LEASE_TTL_MS, now: clock(), clock })
      r.lease = lease
      leases.set(spec.id, lease)
      let registering = true
      const api = buildExtensionAPI({
        manifest,
        packageIdentity: spec.package,
        packageVersion: spec.packageVersion,
        trust: spec.trust,
        lease,
        ports: options.ports,
        bag: r.registrations,
        info: options.info,
        platform: options.platform,
        log: options.log,
        signal: r.ac.signal,
        isRegistering: () => registering,
      })
      try {
        const returned = await mapResult(factory(api), (value) => {
          if (input.registration !== 'lifetime') registering = false
          return value
        })
        if (typeof returned === 'function') r.own.add(returned as () => void)
        else if (returned !== undefined) throw new HostError('E_EXT_LOAD', 'invalid extension disposer')
      } finally {
        if (input.registration !== 'lifetime') registering = false
      }
      // Taken over while the factory was still running: the newer owner already released our
      // registrations, and the disposer that came back late has to go too.
      if (r.state === 'retired') {
        await r.own.disposeAllAsync()
        return
      }
      r.state = 'live'
      r.loaded = true
      if (r.registrations instanceof LateRegistrationBag) r.registrations.late = true
      publish(r)
      say('extension.loaded', { id: spec.id, package: spec.package, version: r.version })
    } catch (error) {
      if (r.state === 'retired') {
        await r.own.disposeAllAsync()
        return
      }
      await fail(r, error, stage)
    }
  }

  return Object.freeze({
    /** Loads `input.spec` as the row's extension. Never rejects: a failure is a listing, not a throw. */
    async load(input: BuiltinRowLoad): Promise<BuiltinRowHandle> {
      if (!input.spec.enabled) return Object.freeze({ loaded: false, release: async () => {} })
      const r: RowEntry = {
        rowId: input.rowId,
        spec: { ...input.spec },
        token: undefined as never,
        version: '?',
        state: 'loading',
        loaded: false,
        ac: new AbortController(),
        registrations: input.onLateRegistration
          ? new LateRegistrationBag(input.onLateRegistration)
          : new DisposerBag(),
        own: new DisposerBag(),
      }
      r.token =
        input.registration === 'lifetime'
          ? await options.owners.claimAndSettle(input.rowId, (reason) => retire(r, reason))
          : options.owners.claim(input.rowId, (reason) => retire(r, reason))
      current.set(r.spec.id, r)
      publish(r)
      await run(input, r)
      return handleOf(r)
    },
    /** The selector reports how the extension is supplied; it names the extension, not the row. */
    setIsolation(id: string, isolation: NonNullable<ExtensionStatus['isolation']>): void {
      const r = current.get(id)
      if (!r || r.state === 'retired') return
      r.isolation = { ...isolation }
      publish(r)
    },
    /**
     * A live extension whose runtime died: the listing turns into a failure and everything is
     * released. `token` identifies the generation that reported the crash; an isolated child keeps
     * its failure listener armed for as long as its generation's own wind-down takes (the shutdown
     * dispatch, then `own.disposeAllAsync()`), which can outlive a newer generation already taking
     * the row over. A report from a token that is no longer `current`'s is stale and ignored, so an
     * evicted generation's crash can never kill its successor.
     */
    fail(id: string, error: unknown, token?: symbol): Promise<void> {
      const r = current.get(id)
      if (r?.state !== 'live' || !r.loaded) return Promise.resolve()
      if (token !== undefined && r.token !== token) return Promise.resolve()
      return fail(r, error, 'factory')
    },
    leaseFor: (source: string): LeaseView | undefined => leases.get(source)?.view(),
    statusEntries: (): OrderedExtensionStatus[] => book.entries(),
  })

  function handleOf(r: RowEntry): BuiltinRowHandle {
    return Object.freeze({
      loaded: r.loaded,
      ...(r.error && !r.loaded ? { error: { ...r.error } } : {}),
      release: (reason: string) => options.owners.release(r.rowId, r.token, reason),
    })
  }
}

export type BuiltinRowHost = ReturnType<typeof createBuiltinRowHost>
