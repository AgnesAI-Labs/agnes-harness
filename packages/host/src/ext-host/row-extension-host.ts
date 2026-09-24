import { createHash, randomUUID } from 'node:crypto'
import { type Context, type Fiber, Service } from '@agnes/cordis'
import {
  type ExtensionContext,
  ExtensionError,
  type ExtensionManifest,
  type LeaseView,
  type Logger,
  type PluginExtensionAPI,
} from '@agnes/extension-api'
import type { RowOrigin, RowOriginLookup } from '@agnes/plugin-runtime/host'
import { BUILTIN_HOOK_RANKS } from '../assemble/ext-rows.js'
import { HostError } from '../errors.js'
import { diagnostic, loadError } from './diagnostics.js'
import { DisposerBag } from './disposers.js'
import { ExtensionOwners } from './extension-owners.js'
import {
  type ExtensionOrder,
  ExtensionStatusBook,
  type OrderedExtensionStatus,
} from './extension-status-book.js'
import { type Lease, leaseFor, ROW_BOUND_LEASE_TTL_MS } from './lease.js'
import type { ExtensionStatus } from './managed-host.js'
import type { KernelPorts } from './ports.js'
import { buildRowExtensionAPI, OBSERVE_HOOK_EVENTS } from './row-extension-api.js'

export type RowExtensionHostOptions = Readonly<{
  mcpManage?: import('../resources/mcp-manage-port.js').McpManageBridge
  pluginManage?: import('../resources/plugin-manage-port.js').PluginManageBridge
  skillInstall?: import('../resources/skill-install-port.js').SkillInstallBridge
  info: ExtensionContext['info']
  log: Logger
  audit?: (kind: string, detail: Record<string, unknown>) => unknown
  order: ExtensionOrder
  /** Shared with builtin rows, so a builtin and its plugin replacement take turns holding a row id. */
  owners?: ExtensionOwners
  clock?: () => number
  /** Version and integrity Host inventory knows for a snapshot a row was mounted from. */
  describePackage?(
    packageId: string,
    snapshotId: string,
  ): Readonly<{ version?: string; integrity?: string }> | undefined
}>

/** Everything that only exists once the kernel does. */
export type RowExtensionActivation = Readonly<{
  ports: KernelPorts
  platform: ExtensionContext['platform']
  /**
   * Starts `shutdown` for every open session with the source's handlers as they are at call time,
   * so the caller may release them right after the synchronous part returns.
   */
  shutdown(source: string, context: { reason: 'revoke' | 'reload'; lease: LeaseView }): Promise<void>
  /** True when a tool name belongs to a builtin extension whose row is not `rowId`. */
  reservedTool(name: string, rowId: string): boolean
  /** Hook events a replacement of the row must register, keyed by row id. */
  governance: ReadonlyMap<string, readonly string[] | 'unreadable'>
}>

type Pending = {
  kind: 'tool' | 'hook'
  name: string
  create: (ports: KernelPorts) => () => void | Promise<void>
  cancelled: boolean
  release?: () => void | Promise<void>
}

type RowRecord = {
  rowId: string
  source: string
  packageId: string
  packageVersion: string
  snapshotId: string
  integrity?: string
  token: symbol
  fiber: Fiber
  lease: Lease
  ac: AbortController
  bag: DisposerBag
  pending: Set<Pending>
  /** How many live registrations the row holds per hook event. */
  hookEvents: Map<string, number>
  api: PluginExtensionAPI
  state: 'dormant' | 'live' | 'retired'
  /** Host has listed this row at some point, so a later failure is worth reporting. */
  announced: boolean
  loaded: boolean
  error?: { code: string; message: string }
  retiring?: Promise<void>
}

// What a row sees for `ctx.platform` in the moment before the Host has read its real platform.
const FALLBACK_PLATFORM: ExtensionContext['platform'] = Object.freeze({
  shell: 'posix',
  fs: Object.freeze({ caseSensitive: true, pathSep: '/' }),
  terminal: Object.freeze({ color: false }),
})

const semver = /^\d+\.\d+\.\d+(?:[-+].*)?$/

/** `plugin/<hash>`: a fixed-shape owner id for a row id, which itself cannot be one (it has a colon). */
export function pluginRowSource(rowId: string): string {
  return `plugin/${createHash('sha256').update(rowId).digest('hex').slice(0, 16)}`
}

function manifestLikeFor(source: string, version: string): ExtensionManifest {
  return {
    id: source,
    version: semver.test(version) ? version : '0.0.0',
    apiRange: '*',
    entry: './index.js',
    capabilities: {
      tools: { prefix: '' },
      hooks: [...OBSERVE_HOOK_EVENTS],
      events: true,
    },
  } as ExtensionManifest
}

/**
 * Registrations made by plugin rows through `ctx.extension()`: who owns them, what wind-down they
 * get when the row goes, and what `Host.extensions()` shows for them.
 */
export function createRowExtensionHost(options: RowExtensionHostOptions) {
  const clock = options.clock ?? (() => Date.now())
  const owners = options.owners ?? new ExtensionOwners()
  const book = new ExtensionStatusBook(options.order)
  const records = new Map<string, RowRecord>()
  const sources = new Map<string, string>()
  const leases = new Map<string, Lease>()
  const byFiber = new WeakMap<Fiber, RowRecord>()
  let activation: RowExtensionActivation | undefined

  const say = (kind: string, detail: Record<string, unknown>) =>
    diagnostic(() => options.audit?.(kind, detail))
  const view = (r: RowRecord): ExtensionStatus => ({
    id: r.source,
    package: r.packageId,
    version: r.packageVersion,
    trust: 'trusted',
    loaded: r.loaded && r.state === 'live',
    ...(r.integrity ? { integrity: r.integrity } : {}),
    revision: r.snapshotId,
    ...(r.state === 'live' && r.loaded ? { lease: r.lease.view() } : {}),
    ...(r.error ? { error: { ...r.error } } : {}),
  })
  // A dormant row is not known to Host yet: it is neither listed nor audited until the kernel exists.
  const publish = (r: RowRecord) => {
    if (r.state !== 'dormant') book.set(view(r))
  }
  const registrationOf = (r: RowRecord, entry: Pending) => {
    entry.release = r.bag.add(entry.create(activation?.ports as KernelPorts))
    say('extension.registered', {
      id: r.source,
      row: r.rowId,
      package: r.packageId,
      kind: entry.kind,
      name: entry.name,
    })
  }

  const retire = (r: RowRecord, reason: string): Promise<void> => {
    if (r.retiring) return r.retiring
    const wasLive = r.state === 'live'
    const wasLoaded = r.loaded
    r.state = 'retired'
    if (records.get(r.rowId) === r) records.delete(r.rowId)
    if (sources.get(r.source) === r.rowId) sources.delete(r.source)
    // The shutdown dispatch has to see the handlers, so it starts before anything is released.
    let shutdown: Promise<void> = Promise.resolve()
    if (wasLive && wasLoaded && activation)
      shutdown = activation
        .shutdown(r.source, { reason: 'revoke', lease: r.lease.view() })
        .catch(() => undefined)
    r.lease.revoke(reason)
    r.ac.abort()
    r.pending.clear()
    r.loaded = false
    const first = r.bag.disposeAll()
    r.retiring = (async () => {
      await shutdown
      if (first.failed) await r.bag.disposeAllAsync()
      if (leases.get(r.source) === r.lease) leases.delete(r.source)
      if (!wasLive) return
      // A successor row registers under the same source, so its registrations are not residue.
      const successorHolds = records.get(r.rowId) !== undefined && records.get(r.rowId) !== r
      const residue = successorHolds ? [] : (activation?.ports.registrations(r.source) ?? [])
      const clean = residue.length === 0 && r.bag.size === 0
      // A row that never finished loading is reported by its own failure, not as revoked.
      if (wasLoaded)
        say('extension.revoked', {
          id: r.source,
          row: r.rowId,
          package: r.packageId,
          trust: 'trusted',
          reason,
          cleanupPending: !clean,
        })
      if (!clean) {
        say('extension.revoke_failed', {
          id: r.source,
          row: r.rowId,
          message: 'extension cleanup incomplete',
        })
        r.error = { code: 'E_EXT_LOAD', message: 'extension cleanup incomplete' }
      }
      // An evicted record winds down after its successor may already be listed.
      const successor = records.get(r.rowId)
      if (!successor || successor === r) book.set(view(r))
    })()
    return r.retiring
  }

  // A row that throws is unloaded by its fiber before this callback runs, so a failure is recorded
  // even on a retired record; a success that arrives after the row went away is not.
  const settled = (r: RowRecord, failure?: unknown) => {
    if (failure === undefined) {
      if (r.state === 'retired') return
      r.loaded = true
    } else {
      if (!r.announced) return
      r.error = loadError(failure, 'factory')
      diagnostic(() => options.log.error('extension failed to load', { id: r.source, ...r.error }))
    }
    if (r.state === 'dormant') return
    book.set(view(r))
    if (failure === undefined)
      say('extension.loaded', { id: r.source, package: r.packageId, version: r.packageVersion })
    else say('extension.failed', { id: r.source, package: r.packageId, ...r.error })
  }

  const flush = (r: RowRecord) => {
    r.state = 'live'
    r.announced = true
    for (const entry of [...r.pending]) {
      r.pending.delete(entry)
      if (entry.cancelled) continue
      try {
        if (entry.kind === 'tool' && activation?.reservedTool(entry.name, r.rowId))
          throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'tool name is reserved for a builtin extension')
        registrationOf(r, entry)
      } catch (error) {
        r.error = loadError(error, 'factory')
        say('extension.failed', { id: r.source, package: r.packageId, ...r.error })
      }
    }
    if (r.loaded && !r.error)
      say('extension.loaded', { id: r.source, package: r.packageId, version: r.packageVersion })
    publish(r)
  }

  const create = (fiber: Fiber, origin: Readonly<RowOrigin>): RowRecord => {
    const rowId = origin.rowId
    const source = pluginRowSource(rowId)
    const holder = sources.get(source)
    if (holder !== undefined && holder !== rowId)
      throw new HostError('E_EXT_LOAD', 'extension source is already held by another row')
    const info = options.describePackage?.(origin.packageId, origin.snapshotId)
    const packageVersion = info?.version ?? origin.snapshotId
    const lease = leaseFor(manifestLikeFor(source, packageVersion), {
      ttlMs: ROW_BOUND_LEASE_TTL_MS,
      now: clock(),
      clock,
    })
    const ac = new AbortController()
    const bag = new DisposerBag()
    const token = owners.claim(rowId, (reason) => retire(record, reason))
    const record: RowRecord = {
      rowId,
      source,
      packageId: origin.packageId,
      packageVersion,
      snapshotId: origin.snapshotId,
      ...(info?.integrity ? { integrity: info.integrity } : {}),
      token,
      fiber,
      lease,
      ac,
      bag,
      pending: new Set(),
      hookEvents: new Map(),
      api: undefined as never,
      state: activation ? 'live' : 'dormant',
      announced: activation !== undefined,
      loaded: false,
    }
    records.set(rowId, record)
    sources.set(source, rowId)
    leases.set(source, lease)
    const installLeaseId = randomUUID()
    const requestSkillInstall = options.skillInstall
    const requestMcpManage = options.mcpManage
    const requestPluginManage = options.pluginManage
    record.api = buildRowExtensionAPI({
      ...(requestMcpManage
        ? {
            mcpManage: (invocation, signal) =>
              requestMcpManage(
                {
                  ...invocation,
                  packageId: origin.packageId,
                  snapshotId: origin.snapshotId,
                  rowId,
                  leaseId: installLeaseId,
                },
                signal,
              ),
          }
        : {}),
      ...(requestPluginManage
        ? {
            pluginManage: (invocation, signal) =>
              requestPluginManage(
                {
                  ...invocation,
                  packageId: origin.packageId,
                  snapshotId: origin.snapshotId,
                  rowId,
                  leaseId: installLeaseId,
                },
                signal,
              ),
          }
        : {}),
      ...(requestSkillInstall
        ? {
            skillInstall: (invocation, signal) =>
              requestSkillInstall(
                {
                  ...invocation,
                  packageId: origin.packageId,
                  snapshotId: origin.snapshotId,
                  rowId,
                  leaseId: installLeaseId,
                },
                signal,
              ),
          }
        : {}),
      source,
      version: packageVersion,
      packageIdentity: origin.packageId,
      packageVersion,
      lease,
      signal: ac.signal,
      ports: () => (record.state === 'live' ? activation?.ports : undefined),
      reservedTool: (name) => activation?.reservedTool(name, rowId) ?? false,
      // A row claiming a builtin's own row id (e.g. `ext:agnes/hooks-runner`) inherits that
      // builtin's fixed dispatch rank; an ordinary third-party row id is never in this table, so it
      // gets none (third-party-transform-directive-hooks design §3 point 3). Forging the row id
      // itself is not a new risk here: `rowId` already gates tool reservation and the governance
      // check below the same way.
      ...(BUILTIN_HOOK_RANKS.get(rowId) !== undefined
        ? { hookRank: BUILTIN_HOOK_RANKS.get(rowId) as number }
        : {}),
      info: options.info,
      platform: () => activation?.platform ?? FALLBACK_PLATFORM,
      log: options.log,
      attach(kind, name, make) {
        const entry: Pending = { kind, name, create: make, cancelled: false }
        if (kind === 'hook') record.hookEvents.set(name, (record.hookEvents.get(name) ?? 0) + 1)
        if (record.state === 'live') registrationOf(record, entry)
        else record.pending.add(entry)
        let released = false
        return () => {
          if (kind === 'hook' && !released) {
            released = true
            const left = (record.hookEvents.get(name) ?? 1) - 1
            if (left > 0) record.hookEvents.set(name, left)
            else record.hookEvents.delete(name)
          }
          entry.cancelled = true
          record.pending.delete(entry)
          return entry.release?.()
        }
      },
    })
    void fiber.await().then(
      () => settled(record),
      (error: unknown) => settled(record, error),
    )
    publish(record)
    return record
  }

  const rowFiberOf = (start: Fiber, origins: RowOriginLookup) => {
    for (let fiber = start; ; fiber = fiber.parent.fiber) {
      const origin = origins.lookup(fiber)
      if (origin) return { fiber, origin }
      if (fiber === fiber.parent.fiber) return undefined
    }
  }

  const treeRootOf = (start: Fiber): Fiber => {
    let fiber = start
    while (fiber !== fiber.parent.fiber) fiber = fiber.parent.fiber
    return fiber
  }

  const apiFor = (caller: Context, origins: RowOriginLookup): PluginExtensionAPI => {
    const found = rowFiberOf(caller.fiber, origins)
    if (!found || found.origin.trustTier !== 'third-party')
      throw new ExtensionError(
        'E_CAPABILITY_UNDECLARED',
        'ctx.extension() is only available to third-party plugin rows',
      )
    const existing = byFiber.get(found.fiber)
    if (existing && existing.state !== 'retired') return existing.api
    // A row that lost its id to a newer owner must not take it back: that would evict the owner.
    if (existing && owners.has(existing.rowId))
      throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'this extension row was replaced by a newer one')
    const record = create(found.fiber, found.origin)
    byFiber.set(found.fiber, record)
    try {
      found.fiber.effect(
        () => () => {
          if (byFiber.get(found.fiber) === record) byFiber.delete(found.fiber)
          return owners.release(record.rowId, record.token, 'unload')
        },
        'plugin-extension',
      )
    } catch (error) {
      byFiber.delete(found.fiber)
      void retire(record, 'unload')
      throw error
    }
    return record.api
  }

  return Object.freeze({
    /** Provides the `extension` service on one tree's root. Called once per root. */
    installRoot(root: Context, origins: RowOriginLookup): void {
      class ExtensionFacade extends Service {
        constructor(context: Context) {
          super(context, 'extension')
        }
        [Service.invoke](this: { ctx: Context }) {
          return apiFor(this.ctx, origins)
        }
      }
      new ExtensionFacade(root)
    },
    /** Called once the kernel exists: rows mounted earlier now get their registrations. */
    activate(input: RowExtensionActivation): void {
      if (activation) throw new HostError('E_EXT_LOAD', 'row extension host is already active')
      activation = input
      for (const record of [...records.values()]) if (record.state === 'dormant') flush(record)
    },
    /** A replacement of a governance builtin has to register everything the builtin declared. */
    assertReplacements(
      rows: readonly Readonly<{ id: string; plugin: string; disabled?: boolean }>[],
      candidate: Readonly<{ root: Context }>,
    ): void {
      if (!activation) return
      for (const row of rows) {
        const required = activation.governance.get(row.id)
        if (!required || row.disabled || row.plugin.startsWith('builtin:')) continue
        if (required === 'unreadable')
          throw new HostError('E_EXT_LOAD', `replacement of ${row.id} refused: its manifest cannot be read`)
        // Only a row of the candidate tree counts: the id may still be held by the tree being replaced.
        const record = records.get(row.id)
        const held =
          record && treeRootOf(record.fiber) === candidate.root.fiber ? record.hookEvents : undefined
        const missing = required.filter((event) => !held?.has(event))
        if (missing.length)
          throw new HostError(
            'E_EXT_LOAD',
            `replacement of ${row.id} must register hooks: ${missing.join(', ')}`,
          )
      }
    },
    leaseFor: (source: string): LeaseView | undefined => leases.get(source)?.view(),
    statusEntries: (): OrderedExtensionStatus[] => book.entries(),
    /** The plugin row that has taken over a builtin extension's row, as its source id. */
    replacedBy: (extensionId: string): string | undefined => {
      const record = records.get(`ext:${extensionId}`)
      return record?.state === 'live' ? record.source : undefined
    },
    /** Resolves once every eviction started so far has finished. */
    settled: () => owners.settled(),
  })
}

export type RowExtensionHost = ReturnType<typeof createRowExtensionHost>
