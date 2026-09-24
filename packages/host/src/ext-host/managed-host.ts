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
import type { ExtensionOrder } from './extension-status-book.js'
import { type Lease, leaseFor, ROW_BOUND_LEASE_TTL_MS } from './lease.js'
import { mapResult } from './map-result.js'
import type { KernelPorts } from './ports.js'
import { preflightEmbeddedExtension, preflightExtension } from './preflight.js'

export type ExtensionSpec = {
  id: string
  package: string
  /** Resolved package version from Host inventory. */
  packageVersion: string
  dir: string
  trust: 'builtin' | 'trusted'
  enabled: boolean
  /** Runtime identity; boot callers should supply the package digest/revision when available. */
  integrity?: string
  revision?: string
}
export type ExtensionStatus = {
  id: string
  package: string
  version: string
  trust: 'builtin' | 'trusted'
  loaded: boolean
  integrity?: string
  revision?: string
  lease?: LeaseView
  isolation?: {
    mode: 'off' | 'preferred' | 'required'
    backend: 'in-process' | 'seatbelt' | 'unavailable'
    fallback: boolean
    reason?: string
    pid?: number
    protocol?: 1
  }
  error?: { code: string; message: string }
  /** Set when a plugin row has taken over this builtin's row; the value is the replacement's source id. */
  replacedBy?: string
}
type RecordState = {
  order: number
  spec: ExtensionSpec
  version: string
  loaded: boolean
  lease?: Lease
  bag: DisposerBag
  ac: AbortController
  shutdownSent?: boolean
  isolation?: ExtensionStatus['isolation']
  error?: ExtensionStatus['error']
  /** Loaded as a Host-owned dynamic row: exempt from the seam-package immutability veto, like the
   *  ids in `reloadableExtensions`, because its row must be able to unmount and be replaced. */
  reloadable?: boolean
}
type Options = {
  ports: KernelPorts
  shutdown(source: string, context: { reason: 'revoke' | 'reload'; lease: LeaseView }): Promise<void>
  loader: { import(file: string): Promise<Record<string, unknown>> }
  ceiling: readonly string[]
  seamPackages: ReadonlySet<string>
  /**
   * Extension ids exempt from seamPackages' owning-package guard (below, both call sites). Narrow,
   * explicit allowlist - not a general relaxation of the guard. Only sandbox and platform packages
   * remain static; dynamic seam implementations live in the ordinary Cordis tree and are not added
   * to seamPackages.
   * Default empty: nothing is exempt unless a caller opts in.
   */
  reloadableExtensions?: ReadonlySet<string>
  info: ExtensionContext['info']
  platform: ExtensionContext['platform']
  log: Logger
  audit?: (kind: string, detail: Record<string, unknown>) => unknown
  clock?: () => number
  /** Shared with the plugin-row status book so a merged listing keeps first-seen order. */
  order?: ExtensionOrder
}
/** Full loading lifecycle; assembly migration will replace the legacy tool-only host with this path. */

/**
 * When an extension may register tools, resources, hooks and the like. `factory` (every ordinary
 * extension): only while its factory runs. `lifetime`: for as long as it stays loaded -- granted
 * only to Host-owned dynamic rows (design 2026-09-21-resource-rows-design.md §3.7, D119), whose
 * supervisor registers a server's tools when its connection lands, again after a reconnect or a
 * `tools/list_changed`. Every other check is unchanged, and a revoked or unloaded extension is still
 * refused: `release` revokes the lease before anything else, and every registration asserts it alive.
 */
export type RegistrationWindow = 'factory' | 'lifetime'
/** What only a Host-owned dynamic row asks of `loadEmbedded` (design §3.7, D119). Ordinary loads
 *  pass nothing and keep both defaults: the factory-only window and the seam immutability veto. */
export type DynamicLoad = Readonly<{
  registration?: RegistrationWindow
  reloadable?: boolean
  /** Told when this extension's registrations change after its factory returned (coalesced per
   *  microtask). A published runtime generation copies registrations when it is created, so Host
   *  mirrors the owner into it again; otherwise bound sessions keep the stale tool wrappers. */
  onLateRegistration?: () => void
}>

export function createManagedExtHost(options: Options) {
  const o = {
    ...options,
    ceiling: [...options.ceiling],
    info: { ...options.info },
    seamPackages: new Set(options.seamPackages),
    reloadableExtensions: new Set(options.reloadableExtensions ?? []),
  }
  const clock = o.clock ?? (() => Date.now()),
    records = new Map<string, RecordState>()
  let localOrder = 0
  const nextOrder = () => o.order?.next() ?? localOrder++
  let closed = false,
    tail: Promise<unknown> = Promise.resolve()
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run)
    tail = next.catch(() => undefined)
    return next
  }
  const say = (kind: string, detail: Record<string, unknown>) => diagnostic(() => o.audit?.(kind, detail))
  const view = (r: RecordState): ExtensionStatus => ({
    id: r.spec.id,
    package: r.spec.package,
    version: r.version,
    trust: r.spec.trust,
    loaded: r.loaded,
    ...(r.spec.integrity ? { integrity: r.spec.integrity } : {}),
    ...(r.spec.revision ? { revision: r.spec.revision } : {}),
    ...(r.lease ? { lease: r.lease.view() } : {}),
    ...(r.isolation ? { isolation: { ...r.isolation } } : {}),
    ...(r.error ? { error: { ...r.error } } : {}),
  })
  const release = async (r: RecordState) => {
    r.loaded = false
    r.lease?.revoke('unloaded')
    delete r.lease
    r.ac.abort()
    const result = await r.bag.disposeAllAsync()
    if (result.failed) diagnostic(() => o.log.warn('extension cleanup incomplete'))
    return result.failed === 0 && o.ports.registrations(r.spec.id).length === 0
  }
  const load = async (
    spec: ExtensionSpec,
    factoryProvider?: () => ExtensionFactory | undefined | Promise<ExtensionFactory | undefined>,
    embeddedManifest?: ExtensionManifest,
    dynamic: DynamicLoad = {},
  ): Promise<ExtensionStatus> => {
    const registration = dynamic.registration ?? 'factory'
    const r: RecordState = {
      order: records.get(spec.id)?.order ?? nextOrder(),
      spec: { ...spec },
      version: '?',
      loaded: false,
      bag: dynamic.onLateRegistration
        ? new LateRegistrationBag(dynamic.onLateRegistration)
        : new DisposerBag(),
      ac: new AbortController(),
      ...(dynamic.reloadable ? { reloadable: true } : {}),
    }
    if (!spec.enabled) return view(r)
    let stage: LoadStage = 'identity',
      owns = false
    try {
      if (closed) throw new HostError('E_EXT_LOAD', 'extension host is closed')
      if (
        spec.trust !== 'builtin' ||
        typeof spec.package !== 'string' ||
        !spec.package ||
        typeof spec.packageVersion !== 'string' ||
        !spec.packageVersion ||
        spec.packageVersion.length > 128
      )
        throw new HostError('E_EXT_LOAD', 'invalid extension ownership')
      const previous = records.get(spec.id)
      if (previous && (previous.loaded || previous.bag.size || o.ports.registrations(spec.id).length))
        throw new HostError('E_EXT_LOAD', 'extension identity is already held')
      records.set(spec.id, r)
      owns = true
      stage = 'manifest'
      const checked = embeddedManifest
        ? {
            manifest: preflightEmbeddedExtension({
              id: spec.id,
              manifest: embeddedManifest,
              ceiling: o.ceiling,
              apiVersion: o.info.apiVersion,
            }),
            entry: '',
          }
        : preflightExtension({ ...spec, ceiling: o.ceiling, apiVersion: o.info.apiVersion })
      const { manifest, entry } = checked
      r.version = manifest.version
      stage = 'factory'
      const injectedFactory = await factoryProvider?.()
      let factory: ExtensionFactory
      if (injectedFactory) factory = injectedFactory
      else {
        if (embeddedManifest) throw new HostError('E_EXT_LOAD', 'embedded extension factory missing')
        stage = 'import'
        const module = await o.loader.import(entry)
        stage = 'export'
        if (typeof module.default !== 'function')
          throw new HostError('E_EXT_LOAD', 'extension factory missing')
        factory = module.default as ExtensionFactory
      }
      r.lease = leaseFor(manifest, { ttlMs: ROW_BOUND_LEASE_TTL_MS, now: clock(), clock })
      let registering = true
      const closeRegistration = () => {
        if (registration === 'factory') registering = false
      }
      const api = buildExtensionAPI({
        manifest,
        packageIdentity: spec.package,
        packageVersion: spec.packageVersion,
        trust: spec.trust,
        lease: r.lease,
        ports: o.ports,
        bag: r.bag,
        info: o.info,
        platform: o.platform,
        log: o.log,
        signal: r.ac.signal,
        isRegistering: () => registering,
      })
      try {
        const returned = await mapResult(factory(api), (value) => {
          closeRegistration()
          return value
        })
        if (typeof returned === 'function') r.bag.add(returned as () => void)
        else if (returned !== undefined) throw new HostError('E_EXT_LOAD', 'invalid extension disposer')
      } finally {
        closeRegistration()
      }
      if (r.bag instanceof LateRegistrationBag) r.bag.late = true
      r.loaded = true
      say('extension.loaded', { id: spec.id, package: spec.package, version: r.version })
    } catch (error) {
      if (owns) await release(r)
      r.error = loadError(error, stage)
      diagnostic(() => o.log.error('extension failed to load', { id: spec.id, ...r.error }))
      say('extension.failed', { id: spec.id, package: spec.package, ...r.error })
    }
    return view(r)
  }
  const mutable = (id: string): RecordState => {
    const r = records.get(id)
    if (
      !o.reloadableExtensions.has(id) &&
      !r?.reloadable &&
      (o.seamPackages.has(id) || (r && o.seamPackages.has(r.spec.package)))
    )
      throw new HostError('E_SEAM_IMMUTABLE', 'seam implementation package cannot be changed')
    if (closed || !r) throw new HostError('E_EXT_LOAD', 'extension is not available')
    return r
  }
  return {
    load: (
      spec: ExtensionSpec,
      factoryProvider?: () => ExtensionFactory | undefined | Promise<ExtensionFactory | undefined>,
    ) => {
      const snapshot = { ...spec }
      return serial(() => load(snapshot, factoryProvider))
    },
    loadEmbedded: (
      spec: ExtensionSpec,
      manifest: ExtensionManifest,
      factoryProvider: () => ExtensionFactory | undefined | Promise<ExtensionFactory | undefined>,
      options: DynamicLoad = {},
    ) => {
      const snapshot = { ...spec }
      const manifestSnapshot = structuredClone(manifest)
      return serial(() => load(snapshot, factoryProvider, manifestSnapshot, { ...options }))
    },
    loadAll: (specs: readonly ExtensionSpec[]) => {
      const snapshot = specs.map((spec) => ({ ...spec }))
      return serial(async () => {
        const out: ExtensionStatus[] = []
        for (const spec of snapshot) if (spec.enabled) out.push(await load(spec))
        return out
      })
    },
    revoke: (id: string, requestedReason: string) =>
      serial(async () => {
        const r = mutable(id)
        if (r.error?.code === 'E_LEASE_EXPIRED' && !r.bag.size && !o.ports.registrations(id).length) return
        const reason = ['operator', 'expired', 'budget', 'uninstall', 'market'].includes(requestedReason)
          ? requestedReason
          : 'operator'
        r.lease?.revoke(reason)
        r.error = { code: 'E_LEASE_EXPIRED', message: 'extension revoked' }
        r.loaded = false
        r.ac.abort()
        if (r.lease && !r.shutdownSent) {
          r.shutdownSent = true
          try {
            await o.shutdown(id, { reason: 'revoke', lease: r.lease.view() })
          } catch {
            diagnostic(() => o.log.warn('extension shutdown incomplete'))
          }
        }
        const clean = await release(r)
        say('extension.revoked', {
          id,
          package: r.spec.package,
          trust: r.spec.trust,
          reason,
          cleanupPending: !clean,
        })
        if (!clean) throw new HostError('E_EXT_LOAD', 'extension cleanup incomplete')
      }),
    status: () => [...records.values()].map(view),
    statusEntries: () => [...records.values()].map((r) => ({ order: r.order, status: view(r) })),
    setIsolation: (id: string, isolation: NonNullable<ExtensionStatus['isolation']>) => {
      const r = records.get(id)
      if (r) r.isolation = { ...isolation }
    },
    fail: (id: string, error: unknown) =>
      serial(async () => {
        const r = records.get(id)
        if (closed || !r?.loaded) return
        await release(r)
        r.error = loadError(error, 'factory')
        diagnostic(() => o.log.error('extension failed to load', { id, ...r.error }))
        say('extension.failed', { id, package: r.spec.package, ...r.error })
      }),
    leaseFor: (id: string) => records.get(id)?.lease?.view(),
    residue: (id: string) => [
      ...o.ports.registrations(id),
      ...(!records.get(id)?.loaded && records.get(id)?.bag.size ? ['disposer:pending'] : []),
    ],
    disposeAll: () =>
      serial(async () => {
        closed = true
        let failed = false
        for (const r of [...records.values()].reverse()) if (!(await release(r))) failed = true
        if (failed) throw new HostError('E_EXT_LOAD', 'extension cleanup incomplete')
      }),
  }
}
