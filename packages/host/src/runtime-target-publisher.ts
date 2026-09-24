import { createHash } from 'node:crypto'
import { type Context, FiberState } from '@agnes/cordis'
import type { CurrentRuntimeLookup, CurrentSessionRuntime } from '@agnes/core'
import type { RuntimePluginSnapshot } from '@agnes/package-manager'
import {
  decodeRuntimeTargetArtifact,
  type EntryTreeTransactionJournal,
  encodeRuntimeTargetArtifact,
  type RuntimeConvergenceReport,
  type RuntimeTarget,
} from '@agnes/plugin-runtime/host'
import type { PackageModule } from './assemble/packages.js'
import {
  DEFAULT_TREE_START_TIMEOUT_MS,
  type HostBuiltinRowClaim,
  type HostPluginTreeBase,
  type HostPrivatePluginTreeInput,
} from './assemble/seams-cordis.js'
import type { PublicationGate } from './publication-gate.js'
import { type ResourceGeneration, ResourceGenerationCell } from './resource-generation-cell.js'
import { stageCandidateRuntime } from './runtime-candidate.js'
import { assertHotPolicyTarget } from './runtime-hot-policy.js'
import type { RuntimeMutationGate, RuntimeReadLease } from './runtime-mutation-gate.js'
import { pluginSnapshotIdentity, type RuntimePluginCatalogue } from './runtime-plugin-catalogue.js'
import { sessionOverlayDesired } from './runtime-session-overlay.js'
import { RuntimeStateCoordinator, type RuntimeStateSnapshot } from './runtime-state.js'
import {
  assembleRuntimeTargetOrdinaryCandidate,
  filterRuntimeTargetOrdinary,
  type RuntimeTargetOrdinaryAssembly,
  runtimeTargetOrdinaryRows,
} from './runtime-target-assembler.js'
import { loadRuntimeTargetClaims } from './runtime-target-claims.js'
import { buildRuntimeTargetConvergenceReport } from './runtime-target-report.js'
import {
  type RuntimeTargetResourceFactory,
  stageRuntimeTargetResourceCandidate,
} from './runtime-target-resources.js'
import { resolveRuntimeTargetBuiltinClaims } from './runtime-target-static-authority.js'

export type PublishedRuntimeTarget<Resources> = Readonly<{
  target: RuntimeTarget
  /** Core registry generation; deliberately independent from the complete artifact identity. */
  runtimeRegistryRevision: string
  report: RuntimeConvergenceReport
  ordinary: RuntimeTargetOrdinaryAssembly
  resources: ResourceGeneration<Resources>
}>

/**
 * Computes the session-registry generation for a complete target.
 *
 * Browser rows are intentionally omitted: they are part of the durable composite artifact but do
 * not register Core tools, hooks, or resources.  The remaining ordinary rows and the resource
 * half are conservative inputs; any change that cannot be proven registry-neutral gets a new
 * generation and therefore a COW session rebind.
 */
export function runtimeRegistryRevisionForTarget(target: RuntimeTarget): string {
  const ordinaryRows = target.tree.rows.filter(
    (row) => !row.id.startsWith('web:') && !row.plugin.startsWith('web:'),
  )
  const payload = {
    rows: ordinaryRows,
    resources: target.resource.resources,
    resourceRows: target.resource.rows,
    resourceRevision: target.resource.target.resourceRevision,
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export type RuntimeSessionScope<Overlay> = Readonly<{
  desired: unknown
  overlay: Overlay
  runtime?: CurrentSessionRuntime
  close(): void | Promise<void>
}>

export type RuntimeTargetPublisherState<Resources, Overlay> = Readonly<{
  current?: PublishedRuntimeTarget<Resources>
  /** Immutable-by-convention COW table; it is never mutated after publication. */
  sessionScopes: ReadonlyMap<string, RuntimeSessionScope<Overlay>>
}>

/** The part of a candidate target the pre-publish check reads. */
type CandidateRows = Readonly<{
  tree: Readonly<{ rows: readonly Readonly<{ id: string; plugin: string; disabled?: boolean }>[] }>
}>

export type RuntimeTargetPublisherOptions<Resources, Overlay = unknown> = Readonly<{
  catalogue: RuntimePluginCatalogue
  publication: PublicationGate
  mutation?: RuntimeMutationGate
  resourceFactory: RuntimeTargetResourceFactory<Resources>
  load(source: Readonly<RuntimePluginSnapshot>): Promise<PackageModule | undefined>
  trust(source: Readonly<RuntimePluginSnapshot>): 'builtin' | 'trusted' | undefined
  /**
   * Host-only static extras plus Host-static boot rows (preset/seam/builtin). Desired ordinary rows
   * overlay those static rows at candidate assembly; builtinClaims still come from staticClaims.
   */
  privateInput?(target: RuntimeTarget): Omit<HostPrivatePluginTreeInput, 'builtinClaims'>
  /**
   * Host-private builtin/preset/seam claims. They are not third-party catalogue snapshots and must
   * cover every `builtin:` ordinary row in the target.
   */
  staticClaims?(target: RuntimeTarget): readonly Readonly<HostBuiltinRowClaim>[]
  /** How long a candidate tree may take to start before the delivery is failed. Defaults to 30 s. */
  startTimeoutMs?: number
  /**
   * Rebuild one open session against the candidate published target. Required whenever apply() sees
   * open scopes; omission still fail-closes so a target change cannot drop overlay desired.
   */
  rebuildSessionScope?(
    sessionKey: string,
    desired: unknown,
    current: PublishedRuntimeTarget<Resources>,
  ): Promise<RuntimeSessionScope<Overlay>>
  /** Called only after the published pointer exchanges; failed candidates never reach consumers. */
  onPublished?(target: RuntimeTarget): void
  /**
   * Runs once the candidate tree has mounted every row and before anything is published. A throw
   * fails the candidate like any other apply failure.
   */
  verifyCandidate?(candidate: CandidateRows, tree: Readonly<{ root: Context }>): void | Promise<void>
}>

/**
 * The Host-owned one-pointer publisher for a complete target. Candidate construction never touches
 * a published tree/generation; RuntimeStateCoordinator performs the one synchronous exchange.
 */
export class RuntimeTargetPublisher<Resources, Overlay = unknown> {
  readonly #catalogue: RuntimePluginCatalogue
  readonly #resourceFactory: RuntimeTargetResourceFactory<Resources>
  readonly #load: (source: Readonly<RuntimePluginSnapshot>) => Promise<PackageModule | undefined>
  readonly #trust: (source: Readonly<RuntimePluginSnapshot>) => 'builtin' | 'trusted' | undefined
  readonly #privateInput: RuntimeTargetPublisherOptions<Resources, Overlay>['privateInput'] | undefined
  readonly #staticClaims: RuntimeTargetPublisherOptions<Resources, Overlay>['staticClaims'] | undefined
  readonly #rebuildSessionScope:
    | ((
        sessionKey: string,
        desired: unknown,
        current: PublishedRuntimeTarget<Resources>,
      ) => Promise<RuntimeSessionScope<Overlay>>)
    | undefined
  readonly #onPublished: ((target: RuntimeTarget) => void) | undefined
  readonly #verifyCandidate:
    | ((candidate: CandidateRows, tree: Readonly<{ root: Context }>) => void | Promise<void>)
    | undefined
  readonly #mutation: RuntimeMutationGate | undefined
  readonly #startTimeoutMs: number | undefined
  /** Which path the last apply() took; a transaction compensates itself, a candidate does not. */
  lastAttempt: 'transaction' | 'candidate' | undefined
  readonly #resources: ResourceGenerationCell<Resources>
  readonly #states: RuntimeStateCoordinator<RuntimeTargetPublisherState<Resources, Overlay>>

  constructor(options: RuntimeTargetPublisherOptions<Resources, Overlay>) {
    this.#catalogue = options.catalogue
    this.#resourceFactory = options.resourceFactory
    this.#load = options.load
    this.#trust = options.trust
    this.#privateInput = options.privateInput
    this.#verifyCandidate = options.verifyCandidate
    this.#staticClaims = options.staticClaims
    this.#rebuildSessionScope = options.rebuildSessionScope
    this.#startTimeoutMs = options.startTimeoutMs
    this.#onPublished = options.onPublished
    this.#mutation = options.mutation
    let states!: RuntimeStateCoordinator<RuntimeTargetPublisherState<Resources, Overlay>>
    this.#resources = new ResourceGenerationCell(() => states.current().value.current?.resources)
    states = new RuntimeStateCoordinator({
      initial: Object.freeze({ sessionScopes: new Map() }) as RuntimeTargetPublisherState<Resources, Overlay>,
      publication: options.publication,
      ...(options.mutation ? { mutation: options.mutation } : {}),
      retire: async (previous, next) => {
        const outcomes: Promise<unknown>[] = []
        if (previous.current && previous.current.ordinary.pluginTree !== next.current?.ordinary.pluginTree)
          outcomes.push(previous.current.ordinary.close())
        if (previous.current && previous.current.resources !== next.current?.resources)
          outcomes.push(this.#resources.retire(previous.current.resources))
        for (const [key, scope] of previous.sessionScopes) {
          if (next.sessionScopes.get(key) !== scope) outcomes.push(Promise.resolve(scope.close()))
        }
        if (outcomes.length === 0) return
        const settled = await Promise.allSettled(outcomes)
        const failures = settled.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []))
        if (failures.length) throw new AggregateError(failures, 'runtime target retirement failed')
      },
    })
    this.#states = states
  }

  current(): RuntimeStateSnapshot<RuntimeTargetPublisherState<Resources, Overlay>> {
    return this.#states.current()
  }

  /** Narrow Core adapter for the runtime view belonging to the currently published session scope. */
  currentRuntimeLookup(): CurrentRuntimeLookup {
    return Object.freeze({
      current: (sessionKey) => {
        const scope = this.#states.current().value.sessionScopes.get(sessionKey)
        if (!scope?.runtime)
          throw new Error(`E_RUNTIME_SESSION_UNAVAILABLE: no published runtime for ${sessionKey}`)
        return scope.runtime
      },
    })
  }

  /** Runs a session runtime operation while holding the mutation gate's read lease. */
  withCurrentRuntime<T>(
    sessionKey: string,
    callback: (runtime: CurrentSessionRuntime, lease: RuntimeReadLease) => T | PromiseLike<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.#states.withRead((lease) => {
      const scope = this.#states.current().value.sessionScopes.get(sessionKey)
      if (!scope?.runtime)
        throw new Error(`E_RUNTIME_SESSION_UNAVAILABLE: no published runtime for ${sessionKey}`)
      return callback(scope.runtime, lease)
    }, signal)
  }

  /** `rebuild` forces a fresh whole-tree candidate even when the live tree already matches `target`. */
  async apply(
    target: RuntimeTarget,
    options: Readonly<{ rebuild?: boolean }> = {},
  ): Promise<RuntimeStateSnapshot<RuntimeTargetPublisherState<Resources, Overlay>>> {
    assertHotPolicyTarget(target)
    let transactionTree: HostPluginTreeBase | undefined
    const publish = () =>
      this.#states.publish(
        async (base) => {
          const canonicalTarget = decodeRuntimeTargetArtifact(encodeRuntimeTargetArtifact(target))
          const ordinaryTarget = filterRuntimeTargetOrdinary(canonicalTarget)
          const registryRevision = runtimeRegistryRevisionForTarget(canonicalTarget)
          const registryChanged = base.value.current?.runtimeRegistryRevision !== registryRevision
          if (registryChanged && base.value.sessionScopes.size > 0 && !this.#rebuildSessionScope) {
            throw new Error('E_RUNTIME_SESSION_REBUILD_REQUIRED: runtime target has open session scopes')
          }
          const sources = this.#catalogue.select(ordinaryTarget)
          const claims = await loadRuntimeTargetClaims({
            target: ordinaryTarget,
            sources,
            load: this.#load,
            trust: this.#trust,
          })
          const privateInput = {
            ...this.#privateInput?.(canonicalTarget),
            builtinClaims: resolveRuntimeTargetBuiltinClaims(
              canonicalTarget,
              this.#staticClaims?.(canonicalTarget) ?? [],
              claims.privateInput.builtinClaims,
            ),
          }
          const current = base.value.current
          let ordinary: RuntimeTargetOrdinaryAssembly
          let ordinaryReused = false
          let transactionPreviousRows:
            | readonly Readonly<import('@agnes/plugin-runtime/host').EntryRow>[]
            | undefined
          let transactionChanged = false
          const prepareRows = current?.ordinary.pluginTree.prepareRows
          const applyPreparedRows = current?.ordinary.pluginTree.applyPreparedRows
          const compensateRows = current?.ordinary.pluginTree.compensateRows
          const desiredRows = runtimeTargetOrdinaryRows(ordinaryTarget, privateInput.bootRows)
          const incrementalSafe =
            options.rebuild !== true &&
            current !== undefined &&
            prepareRows !== undefined &&
            applyPreparedRows !== undefined &&
            canReuseRowImporter(current.ordinary.pluginTree.currentRows(), desiredRows)
          if (incrementalSafe && current && prepareRows && applyPreparedRows) {
            this.lastAttempt = 'transaction'
            transactionTree = current.ordinary.pluginTree
            transactionPreviousRows = current.ordinary.pluginTree.currentRows()
            try {
              const prepared = await prepareRows(desiredRows, {
                candidateImporter: claims.pluginImporter,
                builtinClaims: privateInput.builtinClaims,
                stepTimeoutMs: this.#startTimeoutMs ?? DEFAULT_TREE_START_TIMEOUT_MS,
              })
              if (prepared.operations.length > 0) {
                await applyPreparedRows(prepared)
                transactionChanged = true
                ordinary = Object.freeze({
                  target: ordinaryTarget,
                  sources,
                  pluginTree: current.ordinary.pluginTree,
                  close: current.ordinary.close,
                })
              } else {
                ordinary = current.ordinary
              }
            } catch (error) {
              // EntryTree normally compensates internally. If it reports a recovery-required
              // journal, give the Host adapter one explicit retry before the old published pointer
              // is allowed to remain visible; a failed retry is surfaced as a hard recovery error.
              const journal = (error as { journal?: EntryTreeTransactionJournal }).journal
              if (journal?.status === 'recovery-required' && compensateRows) {
                try {
                  await compensateRows(journal)
                } catch (recoveryError) {
                  throw new AggregateError(
                    [error, recoveryError],
                    'runtime target row transaction recovery failed',
                  )
                }
              }
              throw error
            }
            ordinaryReused = true
          } else {
            this.lastAttempt = 'candidate'
            ordinary = await assembleRuntimeTargetOrdinaryCandidate({
              target: ordinaryTarget,
              catalogue: this.#catalogue,
              createPluginImporter: () => claims.pluginImporter,
              ...(this.#startTimeoutMs === undefined ? {} : { startTimeoutMs: this.#startTimeoutMs }),
              privateInput,
            })
          }
          try {
            await this.#verifyCandidate?.(ordinaryTarget, { root: ordinary.pluginTree.root })
            const resources = this.#resources
            const reuseResources =
              current !== undefined && sameResourceGeneration(current.target, canonicalTarget)
            const resource = reuseResources
              ? undefined
              : await stageRuntimeTargetResourceCandidate({
                  target: canonicalTarget,
                  cell: resources,
                  factory: this.#resourceFactory,
                })
            const generation = resource?.consume() ?? current?.resources
            if (!generation)
              throw new Error('E_RUNTIME_TARGET_RESOURCE_INVARIANT: missing resource generation')
            const published = Object.freeze({
              target: canonicalTarget,
              runtimeRegistryRevision: registryRevision,
              report: buildRuntimeTargetConvergenceReport(
                ordinary.target,
                (id) => {
                  const fiber = ordinary.pluginTree.tree.fiber(id)
                  switch (fiber?.state) {
                    case FiberState.PENDING:
                      return 'pending'
                    case FiberState.LOADING:
                      return 'loading'
                    case FiberState.ACTIVE:
                      return 'active'
                    case FiberState.UNLOADING:
                      return 'waiting-drain'
                    default:
                      return 'failed'
                  }
                },
                (id) => {
                  // Same test as Cordis itself: a fiber waits while a service it injects has no provider.
                  const fiber = ordinary.pluginTree.tree.fiber(id)
                  if (fiber?.state !== FiberState.PENDING) return undefined
                  const missing = Object.keys(fiber.inject)
                    .filter((name) => fiber.ctx.get(name) === undefined)
                    .sort()
                  return `waiting for ${missing.length === 1 ? 'service' : 'services'}: ${missing.join(', ') || 'unknown'}`
                },
              ),
              ordinary,
              resources: generation,
            })
            const sessionScopes = registryChanged
              ? new Map<string, RuntimeSessionScope<Overlay>>()
              : new Map(base.value.sessionScopes)
            const rebuilt = new Map<string, RuntimeSessionScope<Overlay>>()
            const rebuild = this.#rebuildSessionScope
            try {
              if (registryChanged && rebuild) {
                for (const [sessionKey, scope] of base.value.sessionScopes) {
                  const next = await rebuild(sessionKey, scope.desired, published)
                  rebuilt.set(sessionKey, next)
                  sessionScopes.set(sessionKey, Object.freeze({ ...next, desired: scope.desired }))
                }
              }
            } catch (error) {
              for (const scope of [...rebuilt.values()].reverse())
                await Promise.resolve(scope.close()).catch(() => undefined)
              if (resource) await resources.retire(generation).catch(() => undefined)
              throw error
            }
            return stageCandidateRuntime({
              build(builder) {
                if (resource)
                  builder.onAbort('runtime-target-resource-generation', () => resources.retire(generation))
                if (!ordinaryReused) builder.onAbort('runtime-target-ordinary-tree', () => ordinary.close())
                for (const [sessionKey, scope] of rebuilt)
                  builder.onAbort(`runtime-session-scope:${sessionKey}`, () => scope.close())
                return Object.freeze({
                  current: published,
                  sessionScopes,
                })
              },
            })
          } catch (error) {
            if (
              transactionChanged &&
              current &&
              transactionPreviousRows &&
              prepareRows &&
              applyPreparedRows
            ) {
              try {
                // A package that was uninstalled or untrusted by this very delivery must not come
                // back through its rollback; every other row is restored as before.
                const eligible = transactionPreviousRows.filter((row) => {
                  const identity = pluginSnapshotIdentity(row.plugin)
                  if (!identity) return true
                  const source = this.#catalogue.get(identity.packageId, identity.snapshotId)
                  return source?.trusted === true
                })
                const restore = await prepareRows(eligible, {
                  stepTimeoutMs: this.#startTimeoutMs ?? DEFAULT_TREE_START_TIMEOUT_MS,
                })
                if (restore.operations.length > 0) await applyPreparedRows(restore)
              } catch (restoreError) {
                throw new AggregateError([error, restoreError], 'runtime target transaction recovery failed')
              }
            }
            if (!ordinaryReused) await ordinary.close().catch(() => undefined)
            throw error
          }
        },
        {
          precommit: (candidate, current) => {
            const previous = [...current.value.sessionScopes.keys()].sort()
            const next = [...candidate.sessionScopes.keys()].sort()
            if (previous.length !== next.length || previous.some((key, index) => key !== next[index])) {
              throw new Error('E_RUNTIME_SESSION_SET_CHANGED: open session set changed during target apply')
            }
          },
        },
      )
    const run = async () => {
      try {
        const snapshot = await publish()
        transactionTree?.commitPeriod?.()
        return snapshot
      } catch (error) {
        // Compensation and the outer rollback have finished by now, so the delivery's importer and
        // builtin claims can go; what stays live is what the previous delivery mounted.
        transactionTree?.rollbackPeriod?.()
        throw error
      }
    }
    // Candidate assembly and Host transaction activation may run plugin lifecycle code.  Keep the
    // whole controlled operation inside one mutation ticket; RuntimeStateCoordinator's nested
    // mutation call is re-entrant for this ticket and only PublicationGate remains a short CAS.
    const snapshot = this.#mutation ? await this.#mutation.mutate(() => run()) : await run()
    const publishedTarget = snapshot.value.current?.target
    if (publishedTarget) this.#onPublished?.(publishedTarget)
    return snapshot
  }

  async setSessionScope(
    sessionKey: string,
    desired: unknown,
    build: (current: PublishedRuntimeTarget<Resources>) => Promise<RuntimeSessionScope<Overlay>>,
  ): Promise<RuntimeStateSnapshot<RuntimeTargetPublisherState<Resources, Overlay>>> {
    if (!sessionKey) throw new TypeError('sessionKey is required')
    const run = () =>
      this.#states.publish(async (base) => {
        const current = base.value.current
        if (!current) throw new Error('E_RUNTIME_TARGET_UNAVAILABLE: no published runtime target')
        const overlayDesired = sessionOverlayDesired(desired)
        const scope = await build(current)
        return stageCandidateRuntime({
          build(builder) {
            builder.onAbort('runtime-session-scope', () => scope.close())
            const sessionScopes = new Map(base.value.sessionScopes)
            sessionScopes.set(sessionKey, Object.freeze({ ...scope, desired: overlayDesired }))
            return Object.freeze({ current, sessionScopes })
          },
        })
      })
    return this.#mutation ? this.#mutation.mutate(() => run()) : run()
  }

  async closeSessionScope(
    sessionKey: string,
  ): Promise<RuntimeStateSnapshot<RuntimeTargetPublisherState<Resources, Overlay>>> {
    const run = () =>
      this.#states.publish((base) => {
        if (!base.value.sessionScopes.has(sessionKey))
          return stageCandidateRuntime({ build: () => base.value })
        const sessionScopes = new Map(base.value.sessionScopes)
        sessionScopes.delete(sessionKey)
        return stageCandidateRuntime({
          build: () =>
            Object.freeze({
              ...(base.value.current ? { current: base.value.current } : {}),
              sessionScopes,
            }),
        })
      })
    return this.#mutation ? this.#mutation.mutate(() => run()) : run()
  }

  async close(): Promise<void> {
    const run = async (): Promise<void> => {
      // Move the one live pointer away from the generation first. ResourceGenerationCell intentionally
      // refuses to retire the generation still reachable through RuntimeState.
      if (this.#states.current().value.current) {
        await this.#states.publish(() =>
          stageCandidateRuntime({
            build: () => Object.freeze({ sessionScopes: new Map() }),
          }),
        )
      }
      await this.#states.drainRetirements()
      await this.#resources.drainRetirements()
    }
    if (this.#mutation) await this.#mutation.mutate(() => run())
    else await run()
  }
}

function sameResourceGeneration(left: RuntimeTarget, right: RuntimeTarget): boolean {
  return (
    left.resource.target.resourceRevision === right.resource.target.resourceRevision &&
    JSON.stringify(left.resource.resources) === JSON.stringify(right.resource.resources) &&
    JSON.stringify(left.resource.rows) === JSON.stringify(right.resource.rows)
  )
}

function canReuseRowImporter(
  current: readonly Readonly<import('@agnes/plugin-runtime/host').EntryRow>[],
  desired: readonly Readonly<import('@agnes/plugin-runtime/host').EntryRow>[],
): boolean {
  const byId = new Map(current.map((row) => [row.id, row]))
  return desired.every((row) => {
    if (row.disabled) return true
    const previous = byId.get(row.id)
    if (!previous || previous.mountIdentity !== row.mountIdentity) return true
    // Host-builtin claims may carry schema/config validation outside EntryTree's generic update
    // adapter.  Re-run the complete candidate path for their config changes; third-party rows
    // with a stable mount identity can use the live transaction safely.
    if (row.plugin.startsWith('builtin:')) {
      return JSON.stringify(previous.config) === JSON.stringify(row.config)
    }
    return true
  })
}
