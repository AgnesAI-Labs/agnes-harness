import { deferredRuntimePins } from './deferred-runtime-pins.js'
import { supervisorHostFacade } from './host-facade.js'
import { permissionRequest, workerPermissionReader } from './permission-requests.js'

export { supervisorHostFacade } from './host-facade.js'

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { collectPackageSkillFiles } from '@agnes/base'
import { openDaemonScheduleDb } from '@agnes/base/schedule'
import { createAppServerAdmin } from '@agnes/daemon-admin/app-server'
import { runningPackageIdentity } from '@agnes/daemon-admin/package-actual-identity'
import {
  activateDefaultHelpers,
  initializeDefaultHelpers,
  refreshDefaultHelpers,
} from '@agnes/daemon-admin/packages/default-helpers'
import {
  configurationReadOnly,
  createClientModuleRegistry,
  createPackageAdminService,
  createPackageReferences,
  denyPackageAdminAuthority,
  FilePackageOperationStore,
  localPackageAdminAuthority,
  localWebSkinReadAuthority,
  type PackageActivationAdapter,
  type PackageAdminAuthority,
  type PackageAdminAuthorityResolver,
  type PackageAdminService,
  type PackageOperationStore,
  type PackageProfileDirectory,
  type PackageReferenceFactReader,
  type RuntimePinsAdapter,
  registerPackageAdmin,
  requireLocalAdminAuthority,
  runtimeArtifactsFromStore,
  scopedPackageProfileDirectory,
} from '@agnes/daemon-admin/packages/index'
import { discoverLocalExamples } from '@agnes/daemon-admin/packages/local-examples'
import { pluginProposalSourceAdapter } from '@agnes/daemon-admin/packages/plugin-source'
import {
  createResourceControlService,
  createResourceControlStore,
  denyResourceAuthority,
  localResourceAuthority,
  type ResourceAuthorityResolver,
  type ResourceControlService,
  registerResourceControl,
} from '@agnes/daemon-admin/resources/index'
import {
  rebuildDesiredFromInventory,
  reconcileDesiredWebRows,
} from '@agnes/daemon-foundation/composite-desired'
import { JobsRepo } from '@agnes/daemon-foundation/jobs/repo'
import { Scheduler } from '@agnes/daemon-foundation/jobs/scheduler'
import { JobsService } from '@agnes/daemon-foundation/jobs/service'
import {
  type ReclaimRecord,
  type ReclaimStore,
  type ResumeReport,
  reclaimExpired,
  tableReclaimStore,
} from '@agnes/daemon-foundation/lease/reclaim'
import type { AttachedFeed } from '@agnes/daemon-foundation/local/attached'
import { type ConnectionState, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { NoticeSink } from '@agnes/daemon-foundation/local/notice'
import {
  type ClaimStore,
  type CommandJournal,
  type DirectoryPort,
  type JobsPort,
  MemoryClaims,
  MemoryJournal,
  type SessionLister,
  type SessionMetaRow,
} from '@agnes/daemon-foundation/local/ports'
import type { Disposer } from '@agnes/daemon-foundation/local/tail'
import type { PreviewSnapshotEntry, PreviewUpdate, Registry } from '@agnes/daemon-foundation/registry'
import { NonceTable, startClaimsGc, TableClaims } from '@agnes/daemon-foundation/storage/claims-table'
import { PersistentCommandJournal } from '@agnes/daemon-foundation/storage/command-journal'
import { CompositeTargetStore } from '@agnes/daemon-foundation/storage/composite-target-store'
import type { SessionWorkspacePort } from '@agnes/daemon-foundation/storage/lister'
import {
  MemorySessionWorkspaces,
  SessionWorkspaceIndex,
  StorageLister,
  TicketIndex,
} from '@agnes/daemon-foundation/storage/lister'
import {
  MemorySessionPrincipalOwnership,
  SessionPrincipalOwnershipIndex,
} from '@agnes/daemon-foundation/storage/session-ownership'
import {
  SessionPreferencesStore,
  withSessionPreferences,
} from '@agnes/daemon-foundation/storage/session-preferences'
import { MemorySidebarSessions } from '@agnes/daemon-foundation/storage/sidebar-memory'
import { SidebarSessions } from '@agnes/daemon-foundation/storage/sidebar-sessions'
import {
  type SourceAuthCredential,
  SourceAuthRotation,
} from '@agnes/daemon-foundation/storage/source-auth-rotation'
import type { TableHandle, Tables } from '@agnes/daemon-foundation/storage/table'
import {
  type WorkspaceBindingEnvelope,
  type WorkspaceCatalog,
  workspaceIdFor,
} from '@agnes/daemon-foundation/storage/workspaces'
import { PersistentArtifactReadAuthorityIndex } from '@agnes/daemon-rpc/local/artifact-read-authority'
import type { AuthConfig } from '@agnes/daemon-rpc/local/auth'
import { CommandQueue, runQueued } from '@agnes/daemon-rpc/local/command-queue'
import type { LockedPackageMutationStatusSource } from '@agnes/daemon-rpc/local/computer-use-control'
import { createFollowUpRunner } from '@agnes/daemon-rpc/local/follow-up-runner'
import { disposeFeeds, type Feed, registerAcp } from '@agnes/daemon-rpc/local/methods/acp'
import { registerAppServerAdmin } from '@agnes/daemon-rpc/local/methods/admin'
import { type AgnesContext, registerAgnes, requireSessionOwner } from '@agnes/daemon-rpc/local/methods/agnes'
import { type ArtifactReadRpcOptions, registerArtifactRead } from '@agnes/daemon-rpc/local/methods/artifacts'
import { type PublishChildEngines, registerConfiguration } from '@agnes/daemon-rpc/local/methods/config'
import { registerDiagnostics } from '@agnes/daemon-rpc/local/methods/diagnostics'
import { registerDoctor } from '@agnes/daemon-rpc/local/methods/doctor'
import { executeJournaledEffect, registerExtensions } from '@agnes/daemon-rpc/local/methods/extensions'
import { registerFactChain } from '@agnes/daemon-rpc/local/methods/fact-chain'
import { registerFeedback } from '@agnes/daemon-rpc/local/methods/feedback'
import { registerProfileServices } from '@agnes/daemon-rpc/local/methods/profile-services'
import { registerPromptTrace } from '@agnes/daemon-rpc/local/methods/prompt-trace'
import * as sessionPrefs from '@agnes/daemon-rpc/local/methods/session-preferences'
import {
  registerSessionSelection,
  sessionSelectionProvider,
} from '@agnes/daemon-rpc/local/methods/session-selection'
import { registerSurfaces } from '@agnes/daemon-rpc/local/methods/surfaces'
import { registerWorkspaces } from '@agnes/daemon-rpc/local/methods/workspaces'
import { createPlanCommands } from '@agnes/daemon-rpc/local/plan-commands'
import { type ApprovalRequest, PrompterRouter } from '@agnes/daemon-rpc/local/prompter'
import type { SessionEntry } from '@agnes/daemon-rpc/local/sessions'
import { coordinateSurfacesOnBoot } from '@agnes/daemon-surfaces/surfaces/boot-coordination'
import type { SurfaceController } from '@agnes/daemon-surfaces/surfaces/types'
import {
  ActivationInProgressError,
  type ConfigurationService,
  composeSecrets,
  compositionPreset,
  compositionSurfaceAllowed,
  createExtensionActivationBarrier,
  createFeedbackOwner,
  createPlatform,
  createSecretsEnv,
  createSecretsFile,
  createSqliteStorage,
  defaultProcessIdentity,
  type ExtensionActivationBarrier,
  type Host,
  HostError,
  type HostSession,
  initializeHome,
  initializeHomeLocked,
  overlayChildEngineTarget,
  type ProcessIdentity,
  RequestTraceStore,
  type ResolvedProfile,
  readFactChainBinding,
  resolveComposition,
  resolveFileSecretsDirectory,
  type ScanRead,
  sessionsDbPath,
} from '@agnes/host'
import { acquireObservability, installDiagnosticJournal, telemetrySnapshot } from '@agnes/observability'
import {
  activeRuntimePinId,
  createPackageManager,
  isRuntimePackageEligible,
  type LocalExamplesCatalog,
  localPluginRoots,
  PackageError,
  type PackageManager,
  snapshotPolicy,
} from '@agnes/package-manager'
import type { RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import {
  type ClientModuleEffectCallParams,
  type ClientModuleServiceCallParams,
  type EventEnvelope,
  type ExtensionCallParams,
  type ExtensionCallResult,
  HARNESS_VERSION,
  rpcError,
} from '@agnes/protocol'
import {
  deploymentMcpPolicy,
  installResourceServiceAdapters,
  writePackageSkillInventory,
} from '@agnes/resource-control-daemon'
import { type ActivationLinkPool, notifyLiveSessionWorkers } from '@agnes/resource-control-runtime'
import { hasPrivateDaclSync, windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import {
  artifactMediaReadReply,
  composeDefaultProductionProjectedArtifactRead,
  composeProductionArtifactRead,
  composeProductionProjectedArtifactRead,
  type ProductionArtifactAuthorityProjection,
  type ProductionArtifactReadAuthority,
} from './artifact-read.js'
import { startChildMaintenance } from './child-maintenance.js'
import { type Args, buildConfig, type DaemonConfig } from './config.js'
import { configurationApplication } from './configuration.js'
import { bindConnection } from './connection.js'
import { publishDaemonDiscovery, removeDaemonDiscovery } from './discovery.js'
import { daemonDoctor } from './doctor.js'
import { feedbackPorts } from './feedback-ports.js'
import { describeGenerationSessions } from './generation-sessions.js'
import { readRunningGenerationStatus } from './generation-status-read.js'
import { type JwksResolver, type JwksTransport, startJwksCache } from './jwks-cache.js'
import { closeWithAudit, installSignals, shutdownLadder } from './lifecycle.js'
import { createMcpManageRequests } from './mcp-manage-requests.js'
import { readModelSelectionCatalog, sharedSessionCatalog } from './model-adapter-lookup.js'
import { acquireDaemonMutationLock } from './mutation-lock.js'
import { acquireOwnerLock } from './owner-lock.js'
import { DaemonPluginByteVerification } from './plugin-byte-verification.js'
import { createPluginManageRequests } from './plugin-manage-requests.js'
import { registerPluginRuntimeIngress } from './plugin-runtime-ingress.js'
import { createSupervisorProfileServices } from './profile-services.js'
import { createProfileSurfaceController } from './profile-surfaces.js'
import {
  CompositeRuntimeDelivery,
  deliverDesiredToWorkers,
} from './publication/composite-runtime-delivery.js'
import {
  createCompositeReferenceFacts,
  createCompositeRuntimePins,
  createCompositeTargetActivation,
} from './publication/composite-target-activation.js'
import { createTargetReverter } from './publication/composite-target-revert.js'
import { deferPackageActivation } from './publication/deferred-package-activation.js'
import { createRuntimePinCoordinator } from './publication/runtime-pin-coordinator.js'
import { publishProbedRuntimeTarget } from './publication/runtime-target-publisher.js'
import { type RemoteEntry, WorkerRegistry } from './registry.js'
import { openDaemonLogs } from './runtime-log.js'
import { createRuntimeTargetProbeLauncher, spawnRuntimeTargetProbeWorker } from './runtime-target-probe.js'
import { type ScheduleCatalog, scheduledTasks } from './schedule-sessions.js'
import { callWorkerScheduling } from './scheduling-service.js'
import { canonicalPath, resolveDaemonProfile, resolveDaemonScope } from './scope.js'
import { workerClientServices } from './service-worker.js'
import { registerSessionMethods } from './session-methods.js'
import { recencyCursor } from './session-reads.js'
import { keepSharedWorker, type SharedWorkerKeeper } from './shared-keeper.js'
import { createSkillInstallRequests } from './skill-install-requests.js'
import { type SkillWatcher, startSkillWatcher } from './skill-watcher.js'
import { listenUnix } from './socket.js'
import { prepareDaemonSocketPaths } from './socket-paths.js'
import { installWindowsStopRequest } from './stop-request.js'
import { adaptHostTables, persistResolvedProfile } from './storage-adapters.js'
import { webhookSessions } from './webhook-sessions.js'
import { createAutomationEvents, deliverWorkerEvent } from './worker-events.js'
import { WorkerPool } from './worker-pool.js'
import { openWorkspaceCatalog } from './workspace-catalog.js'
import { PACKAGE_MANAGER_VERSION, workspaceDeployments } from './workspace-deployments.js'
import { listenWebSocket } from './ws.js'

/**
 * Bridges `WorkerRegistry` (`Registry<RemoteEntry>`) onto the concrete `Registry<SessionEntry>`
 * shape `registerAcp`/`registerAgnes` are typed against (`LocalContext.registry`).
 *
 * `registry.test.ts` spells out exactly why this is not a free assignment: a
 * `RemoteEntry` carries no `backlog` / `backlogTruncated` / `tailError` / `listenerErrors` (fields
 * `SessionRegistry`'s own tail bookkeeping uses internally - grepping `local/methods/acp.ts` and
 * `local/methods/agnes.ts` shows neither file ever reads them off an entry it was handed), and its
 * `session` is a `RemoteSession` wire proxy, not a real `HostSession`. That test's own comment marks
 * the fuller fix - making `LocalContext` / `AgnesContext` / `Feed` generic over the entry type, so a
 * real `WorkerRegistry` type-checks there directly - as "later work (a future startSupervisor
 * task)". This file is that task, and this class is the reconciliation: instead of touching three
 * already-landed, already-tested files to widen a type parameter, it wraps every entry `WorkerRegistry`
 * hands out in a view object that structurally satisfies `SessionEntry`, with exactly one unsound
 * line (`.session`'s cast) confined to `RemoteEntryView` below and exercised end-to-end by
 * `supervisor.e2e.test.ts`.
 */
class RemoteEntryView implements SessionEntry {
  readonly key: string
  readonly session: HostSession
  readonly generation: number
  readonly tail: SessionEntry['tail']
  readonly listeners: SessionEntry['listeners']
  readonly backlog: SessionEntry['backlog'] = []
  readonly backlogTruncated = false
  readonly tailError: unknown = null
  readonly listenerErrors: unknown[] = []
  readonly ac: AbortController

  constructor(private readonly e: RemoteEntry) {
    this.key = e.key
    // Unsound by construction, and confined to this one line: `RemoteSession`
    // (supervisor/remote-session.ts) implements exactly the subset of `HostSession` that
    // acp.ts/agnes.ts actually call on an entry's `.session` - enqueue / run / scan / setPreset /
    // setModel / setYolo / requestCompaction / projectUI / projectUIPatch / projectUIOpening /
    // projectUIHistory / lastSeq
    // (enumerated in this task's report) - never the full interface.
    // A call this package does not already make would fail at runtime ("not a function") rather than
    // at compile time; supervisor.e2e.test.ts is what actually proves the subset in use today is
    // covered, and reverse-verification in this task's report deliberately breaks this line once to
    // confirm the test would catch a regression here.
    this.session = e.session as unknown as HostSession
    this.generation = e.generation
    this.tail = e.tail
    this.listeners = e.listeners
    this.ac = e.ac
  }

  submitUiAction(
    input: import('@agnes/protocol').UiActionParams,
    credential: unknown,
    signal: AbortSignal,
  ): Promise<import('@agnes/protocol').UiActionReceipt> {
    return this.e.session.intelligentUi.actionFromCredential(input, credential, signal)
  }

  // The one field that must NOT be a snapshot: `session/prompt` (acp.ts) writes `entry.inflight = ...`
  // on one call and reads it back on a *different* call (a concurrent second prompt on the same
  // session, checking SESSION_BUSY) - both calls go through fresh `require()`/`get()` calls that each
  // construct a new `RemoteEntryView`, so a plain copied field would silently lose that write the
  // moment the first view was garbage collected, reopening the double-prompt race SESSION_BUSY exists
  // to close. A live accessor onto the underlying `RemoteEntry` keeps every view of the same entry
  // reading and writing the one shared value.
  get inflight(): SessionEntry['inflight'] {
    // `RemoteEntry['inflight'].promptId` is `unknown` (supervisor/registry.ts); `SessionEntry`'s is
    // the narrower `JsonRpcId`. Both sides only ever write `'prompt'` (acp.ts's own literal) into
    // this field, so the narrowing is safe in practice - the cast exists because the two already-
    // landed types were never unified to begin with, not because this view invents a new promptId.
    return this.e.inflight as SessionEntry['inflight']
  }
  set inflight(v: SessionEntry['inflight']) {
    this.e.inflight = v
  }

  sameEntry(other: SessionEntry): boolean {
    return other instanceof RemoteEntryView && other.e === this.e
  }
}

type SessionOpenRequest = Parameters<Registry<SessionEntry>['open']>[0] & { resume?: boolean }

export class SupervisorRegistry implements Registry<SessionEntry> {
  private readonly opening = new Map<
    string,
    {
      cwd: string
      preset: string | null
      permission: string | null
      agent: string | null
      bundles: string | null
      loop: string | null
      promise: Promise<SessionEntry>
    }
  >()

  constructor(
    private readonly inner: WorkerRegistry,
    private readonly workspaces: SessionWorkspacePort,
  ) {}
  async open(o: SessionOpenRequest): Promise<SessionEntry> {
    if (o.key) {
      const pending = this.opening.get(o.key)
      if (pending) {
        if (
          pending.cwd !== o.cwd ||
          pending.preset !== (o.preset ?? null) ||
          pending.permission !== (o.permission ?? null) ||
          pending.agent !== (o.agent === undefined ? null : JSON.stringify([o.agent, o.agentDigest])) ||
          pending.bundles !== (o.bundles === undefined ? null : JSON.stringify(o.bundles)) ||
          pending.loop !== (o.loop ? JSON.stringify(o.loop) : null)
        )
          throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: o.key })
        return pending.promise
      }
      const promise = this.openFresh(o)
      this.opening.set(o.key, {
        cwd: o.cwd,
        preset: o.preset ?? null,
        permission: o.permission ?? null,
        agent: o.agent === undefined ? null : JSON.stringify([o.agent, o.agentDigest]),
        bundles: o.bundles === undefined ? null : JSON.stringify(o.bundles),
        loop: o.loop ? JSON.stringify(o.loop) : null,
        promise,
      })
      try {
        return await promise
      } finally {
        if (this.opening.get(o.key)?.promise === promise) this.opening.delete(o.key)
      }
    }
    return this.openFresh(o)
  }

  private async openFresh(o: SessionOpenRequest): Promise<SessionEntry> {
    const persisted = o.key ? this.workspaces.get(o.key) : undefined
    if (o.key && persisted !== undefined && persisted !== o.cwd)
      throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: o.key })
    if (o.key && o.preset !== undefined) {
      const active = this.inner.get(o.key)
      const currentPreset = active
        ? await active.session.currentPreset()
        : this.workspaces.metadata(o.key)?.preset
      if (currentPreset !== null && currentPreset !== undefined && currentPreset !== o.preset)
        throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: o.key })
    }
    // Only a live worker reports the level; the durable projection does not record it, and `default`
    // names whatever the deployment default is, which only the Host resolves.
    if (o.key && o.permission !== undefined && o.permission !== 'default') {
      const active = this.inner.get(o.key)
      if (active && (await active.session.status()).permission !== o.permission)
        throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: o.key })
    }
    const cwd = persisted ?? o.cwd
    const wasOpen = o.key ? this.inner.get(o.key) !== undefined : false
    const entry = await this.inner.open({ ...o, cwd })
    try {
      this.workspaces.put(entry.key, entry.session.cwd)
      await this.workspaces.refresh(entry.key, entry.session, entry.generation)
    } catch (error) {
      // A mapping failure must not leave a freshly-created worker reachable without the durable
      // workspace needed to recover it. Existing live entries predate this call and stay owned by
      // their original opener.
      if (!wasOpen) await this.inner.close(entry.key).catch(() => undefined)
      throw error
    }
    return new RemoteEntryView(entry)
  }
  async fork(o: {
    parent: string
    at: number
    childKey?: string
    binding?: WorkspaceBindingEnvelope
    credential?: unknown
  }): Promise<SessionEntry> {
    const entry = await this.inner.fork(o)
    try {
      this.workspaces.put(entry.key, entry.session.cwd)
      await this.workspaces.refresh(entry.key, entry.session, entry.generation)
    } catch (error) {
      // The worker has already adopted the child at this point. If the durable workspace index
      // cannot own it, close that exact child so its workspace owner reference cannot leak.
      await this.inner.close(entry.key).catch(() => undefined)
      throw error
    }
    return new RemoteEntryView(entry)
  }
  get(key: string): SessionEntry | undefined {
    const e = this.inner.get(key)
    return e ? new RemoteEntryView(e) : undefined
  }
  /**
   * Opens `o.key` unless its lapsed claim's writer `runId` is alive here, or an open of the key is
   * already in flight. The check and the start of the open happen in the same tick.
   */
  openIfAbsent(
    o: Parameters<SupervisorRegistry['open']>[0] & { key: string },
    runId: string,
  ): Promise<SessionEntry> | null {
    if (this.opening.has(o.key) || this.inner.holds(o.key, runId)) return null
    return this.open(o)
  }
  require(key: string): SessionEntry {
    return new RemoteEntryView(this.inner.require(key))
  }
  subscribe(key: string, fn: (e: EventEnvelope) => void): Disposer {
    return this.inner.subscribe(key, fn)
  }
  subscribePreview(key: string, fn: (p: PreviewUpdate) => void, gap?: () => void): Disposer {
    return this.inner.subscribePreview(key, fn, gap)
  }
  previewSnapshot(key: string): Promise<PreviewSnapshotEntry[]> {
    return this.inner.previewSnapshot(key)
  }
  preset(key: string): Promise<string | null> {
    return this.inner.require(key).session.currentPreset()
  }
  status(
    key: string,
    cwd?: string,
  ): Promise<{ lastSeq: number; preset: string | null; permission?: string }> {
    const existing = this.inner.get(key)
    if (existing) return existing.session.status()
    throw rpcError('SESSION_NOT_FOUND', { sessionId: key, ...(cwd ? { cwd } : {}) })
  }
  keys(): string[] {
    return this.inner.keys()
  }
  close(key: string): Promise<void> {
    return this.inner.close(key)
  }
  closeAll(): Promise<void> {
    return this.inner.closeAll()
  }
}

/** Completes the durable principal handoff for an already-created fork. A rejected or failed CAS
 *  cannot leave the worker child live because no principal would be allowed to close it later. */
export async function activateForkOwnership(
  registry: Pick<Registry<SessionEntry>, 'close'>,
  entry: SessionEntry,
  activate: () => boolean,
): Promise<SessionEntry> {
  try {
    if (!activate())
      throw rpcError('CAPABILITY_DENIED', {
        method: 'session.fork',
        reason: 'session owner unavailable',
      })
    return entry
  } catch (error) {
    await registry.close(entry.key).catch(() => undefined)
    throw error
  }
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function supervisorLister(
  registry: SupervisorRegistry,
  workspaces: SessionWorkspacePort,
): SessionLister {
  return {
    async list(q) {
      const limit = Math.min(500, Math.max(1, q.limit ?? 50))
      const scope = q.sessionIds ? new Set(q.sessionIds) : undefined
      const after = recencyCursor(q.cursor)
      // The package-owned workspace index is the durable session directory. Unioning live keys
      // keeps a just-opened session visible even if its index write is being completed, while the
      // (activity, key) keyset cursor makes a restart-independent page boundary possible.
      const all = [...new Set([...workspaces.keys(), ...registry.keys()])]
        .filter((k) => !scope || scope.has(k))
        .filter((k) => !q.q || k.includes(q.q))
        .filter((k) => q.cwd === undefined || workspaces.get(k) === q.cwd)
        // ponytail: one metadata point read per candidate key; move to an indexed ORDER BY on
        // session_workspaces if local session counts reach the thousands.
        .map((key) => {
          const projected = workspaces.metadata(key)
          // Latest user message first; a session nobody has chatted in yet ranks by creation.
          return { key, projected, at: projected?.lastActiveAt || projected?.createdAt || '' }
        })
        .sort((a, b) => byCodeUnit(b.at, a.at) || byCodeUnit(a.key, b.key))
        .filter((row) => !after || row.at < after.at || (row.at === after.at && row.key > after.key))
      const page = all.slice(0, limit)
      const items: SessionMetaRow[] = []
      for (const { key, projected } of page) {
        const active = registry.get(key)
        let state: { lastSeq: number; preset: string | null; permission?: string } = projected
          ? { lastSeq: projected.lastSeq, preset: projected.preset }
          : { lastSeq: active?.session.lastSeq ?? 0, preset: null }
        if (active) {
          // An active worker can answer cheaply; historical rows use the durable event projection
          // and are never booted merely because a client listed sessions.
          try {
            state = await registry.status(key)
          } catch {
            // Keep the last durable projection if the worker exits during this read.
          }
        }
        const cwd = workspaces.get(key)
        items.push({
          sessionId: key,
          createdAt: projected?.createdAt ?? '',
          lastSeq: state.lastSeq,
          generation: active?.generation ?? projected?.generation ?? 0,
          // PageSessionMeta requires a string. `default` is the profile's unconfigured sentinel and
          // is used only when an old/incomplete projection has no recorded start preset.
          preset: state.preset ?? 'default',
          ...(state.permission ? { permission: state.permission } : {}),
          ...(projected?.loop ? { loop: projected.loop } : {}),
          ...(projected?.title ? { title: projected.title } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
        })
      }
      const last = page.at(-1)
      const cursor = all.length > limit && last ? JSON.stringify([last.at, last.key]) : undefined
      return { items, ...(cursor !== undefined ? { cursor } : {}) }
    },
  }
}

declare const AGNES_VERSION: string | undefined

export type StartSupervisorOptions = {
  packageBytes?: DaemonPluginByteVerification
  config: DaemonConfig
  profile: ResolvedProfile
  /** `join(home, 'profiles', profile.name)`. Not derivable from `profile.dataDir`: a profile's
   * home and its dataDir are configured independently and are not the same directory in general. */
  profileDir: string
  /** Existing ledger adapter's read port; reads never acquire a worker or writer claim. */
  sessionFactRead?: (sessionId: string) => ScanRead<import('@agnes/protocol').EventEnvelope>
  profileFile: string
  /** One daemon scope owns one canonical workspace skill root. Session cwd may vary, but profile
   * resource control never silently scans the daemon process cwd. */
  workspaceRoot?: string
  /** Optional local configuration authority; activation updates only future worker defaults. */
  configuration?: ConfigurationService
  reloadProfile?: (adminBundles?: readonly string[]) => Promise<ResolvedProfile>
  clock?: () => number
  workerExecPath?: string
  workerExecArgv?: string[]
  workerEntry?: string
  processIdentity?: (pid: number) => Promise<ProcessIdentity>
  /**
   * A privileged view of core's tables, used by crash reclaim. The sqliteTables test fixture can
   * provide this combined view; Host deliberately does not expose one in production today.
   */
  tables?: Tables
  /** Narrow production access to expired core claims and the op.state cell used for recovery. */
  reclaim?: ReclaimStore
  /** Package-owned tables. Production supplies Host's isolated `@agnes/daemon` table store here. */
  jobTables?: Pick<Tables, 'table'>
  /** Dedicated-schema capability for the fail-closed artifact authority index. */
  artifactAuthorityTable?: TableHandle
  /** Resolved remote credentials. Secret references are resolved only by the executable composition
   * root and never stored in the profile snapshot written for workers. */
  remoteAuth?: Omit<AuthConfig, 'transport'> & {
    /** Stable non-secret ids (normally unresolved SecretRefs) paired with runtime-resolved values. */
    sourceAuthCredentials?: SourceAuthCredential[]
  }
  jwksResolver?: JwksResolver
  jwksTransport?: JwksTransport
  ports?: Partial<{
    journal: CommandJournal
    claims: ClaimStore
    jobs: JobsPort
    lister: SessionLister
    directory: DirectoryPort
    resolveActor: NonNullable<AgnesContext['resolveActor']>
    verifyApprovalSource?: AgnesContext['verifyApprovalSource']
    /** Server-owned authenticated scope resolver plus bounded content-addressed artifact reader. */
    artifactRead: ArtifactReadRpcOptions
  }>
  /**
   * Trusted production authorities used to fit the local content-addressed store. An explicit
   * `ports.artifactRead` remains the higher-priority test/custom composition. Production storage
   * supplies the durable default when every explicit form is omitted.
   */
  artifactReadAuthority?: ProductionArtifactReadAuthority
  /** Complete durable writer/owner/read composition. Mutually exclusive with legacy/custom ports. */
  artifactAuthorityProjection?: ProductionArtifactAuthorityProjection
  /** Read-only Host mutation readiness; omission is the production fail-closed default. */
  lockedPackageMutations?: LockedPackageMutationStatusSource
  observability?: import('@agnes/observability').ObservabilityProvider
  audit?: (rec: unknown) => void
  /** Test/composition injection; production creates one global supervisor gate. */
  activationBarrier?: ExtensionActivationBarrier
  /** PackageAdmin is composed once and registered on every matching transport endpoint. */
  packageAdmin?: {
    service: PackageAdminService
    /** Explicit managed policy hook for remote WSS. Its absence is a hard deny. */
    webAuthority?: PackageAdminAuthorityResolver
    /** Defaults to the authenticated Unix owner authority. */
    unixAuthority?: PackageAdminAuthorityResolver
  }
  /** Durable Resource control composition. Missing Host adapters fail effects safely. */
  resources?: {
    service: ResourceControlService
    webAuthority?: ResourceAuthorityResolver
    unixAuthority?: ResourceAuthorityResolver
  }
  /** Default production package runtime. Tests may continue injecting a complete PackageAdmin. */
  packageRuntime?: {
    manager: PackageManager
    profileDirectory: PackageProfileDirectory
    operations: PackageOperationStore
    stateDirectory: string
    catalog?: LocalExamplesCatalog
    bindAgentResolver?(
      resolve: (profile: string, ref: string) => Promise<import('@agnes/protocol').AgentPlan>,
    ): void
    bindReferences?(reader: PackageReferenceFactReader): void
    bindActivation?(adapter: PackageActivationAdapter): void
    bindRuntimePins?(adapter: RuntimePinsAdapter): void
    /** Bound only after the Host-bearing worker is ready; never exposed on a public transport. */
    bindClientService?(
      dispatcher: (
        input: ClientModuleServiceCallParams & Readonly<{ packageId: string; extension: string }>,
      ) => Promise<ExtensionCallResult>,
    ): void
    bindClientEffect?(
      dispatcher: (
        input: ClientModuleEffectCallParams & Readonly<{ packageId: string; extension: string }>,
        authority: PackageAdminAuthority,
      ) => Promise<ExtensionCallResult>,
    ): void
    bindPluginTree?(
      store: CompositeTargetStore,
      workerGeneration?: () => number | undefined,
      publish?: (
        artifact: import('@agnes/plugin-runtime/host').RuntimeTargetArtifact,
        liveConfig?: boolean,
      ) => Promise<void>,
    ): void
  }
}

// The surface API has no versioned source of its own yet; the harness version comes from the protocol.
const DAEMON_SURFACE_API_VERSION = '1.0.0'

type Conn = { ep: LocalEndpoint; conn: ConnectionState }

export { deliverWorkerEvent } from './worker-events.js'

/**
 * Wires the daemon's one hook for "a resource-control mutation durably committed"
 * (`ResourceControlStore.setSuccessfulSnapshotHandler`, called only after a successful effect's
 * latest worker snapshot and terminal operation commit - resource-control-store/src/control-store.ts)
 * to a lightweight in-place notice, with a narrow heavyweight fallback:
 *  - `notifyLiveSessionWorkers` (@agnes/resource-control-runtime): tells every still-alive
 *    session/service worker (excluding the resource-lifecycle worker itself - see
 *    WorkerPool.activationLinks()) to refresh its own MCP/Skills snapshot before its next turn,
 *    in-process, without being killed. Fire-and-forget from this handler's own caller (the store) never waits on it. Resolves
 *    with the session keys whose notice did *not* deliver.
 *  - `registry.noteResourceSnapshotCommitted()`: called on every commit, synchronously and
 *    unconditionally, to advance the registry's resource epoch. That epoch fences out a worker caught
 *    mid-`acquire()` by this commit (registry.ts's `openFresh`) - a worker with no activation link
 *    yet, which therefore appears in neither the delivered nor the failed list below and cannot be
 *    covered by any retirement decision. Keeping the bump here, rather than as a side effect of
 *    retiring somebody, is what decouples "a snapshot changed" from "some session needs replacing".
 *  - `registry.retireSessions(failedKeys, 'resource-notify-failed')`: called only for those failed
 *    keys, as the fallback for a session the lightweight notice could not reach. A session whose
 *    notice delivered successfully is left alone: unconditionally retiring it too provides no
 *    coverage the lightweight path lacks and only pays an
 *    unnecessary process kill/respawn + MCP reconnect cost. `retireForResourceSnapshot()` itself is
 *    unchanged and still available as a general "retire every live session" capability; this handler
 *    simply no longer calls it.
 *
 * Resource-control-runtime's manager-level `apply`/`activate` callbacks cannot send this notice: `apply` runs
 * inside whichever worker process is bootstrapping (packages/resource-control-worker/src/
 * runtime-bootstrap.ts), including the resource-lifecycle worker itself, with no in-memory reference
 * to this daemon's WorkerPool. This function is the real "a resource actually changed" chokepoint that
 * *does* have one.
 *
 * Exported standalone (not inlined into `startSupervisor`) so this wiring is directly testable without
 * booting a full supervisor - see daemon/test/resource-snapshot-notify.test.ts.
 */
export function wireResourceSnapshotNotifications(o: {
  localResourceStore: { setSuccessfulSnapshotHandler(handler: (profile: string) => void): void }
  registry: {
    noteResourceSnapshotCommitted(): void
    retireSessions(keys: readonly string[], reason: string): void
  }
  pool: ActivationLinkPool
  log?: Pick<Console, 'warn'>
}): void {
  o.localResourceStore.setSuccessfulSnapshotHandler(() => {
    // Synchronously, before any notice goes out and regardless of how that notice fares: this is a
    // global fence, not a per-session outcome. A worker that is mid-`acquire()` right now has already
    // read the superseded snapshot and is in no notification list at all, so the bump has to happen at
    // the commit itself - and as early as possible, since any worker that reaches hello between the
    // commit and the bump would otherwise pass the fence holding old resources.
    o.registry.noteResourceSnapshotCommitted()
    void notifyLiveSessionWorkers(o.pool, o.log).then((failedKeys) => {
      if (failedKeys.length > 0) o.registry.retireSessions(failedKeys, 'resource-notify-failed')
    })
  })
}

/**
 * Assembles and runs one `agnesd` supervisor process: main-instance lock, worker pool, client and
 * worker unix sockets, per-connection RPC wiring, idle-worker reclaim. Startup takes the main lock,
 * opens worker and client listeners, wires connections, starts the idle timer, then reports ready.
 */
export async function startSupervisor(o: StartSupervisorOptions): Promise<{
  failed?: Promise<Error>
  close(): Promise<void>
  reclaimNow(): Promise<ReclaimRecord[]>
  /** Process-internal lifecycle hook used by deterministic idle-recovery verification. */
  evictIdleNow(): number
  /** Process-internal lifecycle hook used by deterministic worker-replacement verification: '@shared'
   *  is kept up from daemon start (P1) and so never idle-evicted, but a session must still recover
   *  cleanly when it is replaced (crash, restart) - this forces that without waiting for one. */
  retireSharedWorkerNow(): boolean
  socketPath: string
  owner: import('./owner-record.js').Owner
  /** Privileged Package activation coordination port; never exposed on the client wire. */
  activationBarrier: ExtensionActivationBarrier
  ws?: { url: string; token: string }
}> {
  const workerEntry = o.workerEntry
  if (workerEntry === undefined) throw new Error('supervisor requires a worker executable entry')
  prepareDaemonSocketPaths(o.config)
  if (o.profile.adapters?.secrets?.kind === 'file') secretsDirectory(o.profile, o.config)
  const composition = o.profile.composition
    ? resolveComposition(o.profile, {
        preset: compositionPreset(o.profile, o.profile.presets.default),
      }).selection
    : undefined
  if (composition?.surfaces !== undefined) {
    const { localWeb, ws, ...config } = o.config
    o = {
      ...o,
      config: {
        ...config,
        ...(localWeb && compositionSurfaceAllowed(composition, 'web') ? { localWeb } : {}),
        ...(ws && compositionSurfaceAllowed(composition, 'http') ? { ws } : {}),
      },
    }
  }
  if (o.config.ws && o.config.localWeb) throw new Error('choose local Web or remote WSS')
  const clock = o.clock ?? (() => Date.now())

  // Single-owner lock first: everything below allocates real resources (sockets, a worker pool), and
  // a second `agnesd` against the same canonical home must fail before any of that exists, not after.
  const ownerHome = await canonicalPath(o.config.home ?? o.config.dataDir)
  const lock = await acquireOwnerLock(ownerHome, {
    socketPath: o.config.socketPath,
    processIdentity: o.processIdentity ?? defaultProcessIdentity,
  })
  let dataGuard: { release(): void } | undefined
  let stopJwksCache: (() => Promise<void>) | undefined
  let localPluginWatcher: { refresh(): Promise<void>; close(): Promise<void> } | undefined
  let skillWatcher: SkillWatcher | undefined
  let sharedKeeper: SharedWorkerKeeper | undefined
  let workerPool: WorkerPool | undefined
  // Hoisted (rather than block-scoped inside `if (o.packageRuntime)`) so the real graceful-shutdown
  // ladder below (`closeSockets`) can reach it -- `startupCleanup` alone does NOT cover that path (see
  // its own comment at `startupCleanup.length = 0`: it is wiped the moment startup succeeds and only
  // ever fires on a startup abort, never on a later `close()`).
  let surfaceController: SurfaceController | undefined
  // One owner for this profile. Each request opens its own instance. The owner closes on
  // shutdown, not when a feedback operation is in flight, so a code change waits for restart.
  let feedbackOwner: ReturnType<typeof createFeedbackOwner> | undefined
  const startupCleanup: Array<() => void | Promise<void>> = []
  startupCleanup.push(() => feedbackOwner?.close())
  const cleanupStartup = async (): Promise<void> => {
    for (const cleanup of startupCleanup.reverse()) {
      try {
        await cleanup()
      } catch {
        // Preserve the startup error; every remaining cleanup still gets its turn.
      }
    }
    await workerPool?.waitForExitRecovery().catch(() => undefined)
    try {
      dataGuard?.release()
    } finally {
      await lock.release().catch(() => undefined)
    }
  }
  try {
    // Retain storage exclusivity and refuse a live pre-home-layout daemon during migration.
    if ((await canonicalPath(o.config.dataDir)) !== ownerHome)
      dataGuard = acquireDaemonMutationLock(o.config.dataDir)
    // The profile is worker input, not a startup marker. Persist it only after the owner lock is
    // held so a competing launch cannot overwrite the profile currently used by another daemon.
    await persistResolvedProfile(o.profileFile, o.profile)
    if (
      o.artifactAuthorityProjection !== undefined &&
      (o.ports?.artifactRead !== undefined || o.artifactReadAuthority !== undefined)
    )
      throw new Error('artifact authority projection conflicts with another artifact read composition')
    let projectedArtifactRead: ReturnType<typeof composeProductionProjectedArtifactRead> | undefined
    let artifactRead: ArtifactReadRpcOptions | undefined
    const conns = new Set<Conn>()
    const resourceControlDirectory = join(o.config.dataDir, 'resource-control')
    // Global MCP/user/package resource workers use a server-owned data root when this daemon was
    // not launched for one workspace. Caller-selected workspace ids still resolve only through the
    // registered WorkspaceCatalog below.
    const resourceWorkerRoot = o.workspaceRoot ?? resourceControlDirectory
    const resourceWorkerWorkspaceId = workspaceIdFor(resourceWorkerRoot)
    let workspaceCatalogRef: WorkspaceCatalog | undefined
    const bindResourceWorkspace = async (workspaceId?: string) => {
      if (!workspaceCatalogRef || (!o.workspaceRoot && !workspaceId)) return resourceWorkerWorkspaceId
      return (await workspaceCatalogRef.bind(workspaceId, resourceWorkerRoot)).workspaceId
    }
    const localResourceStore = o.resources
      ? undefined
      : createResourceControlStore({
          directory: resourceControlDirectory,
          scope: { allowedProfiles: [o.profile.name] },
          resolveWorkspaceId: bindResourceWorkspace,
        })
    const resourceControl: NonNullable<StartSupervisorOptions['resources']> =
      o.resources ??
      (() => {
        if (!localResourceStore) throw new Error('default resource store was not created')
        return { service: createResourceControlService(localResourceStore) }
      })()
    // Recovery is deliberately after the default store receives its service-worker adapters below.
    // Recovering an adapterless store advances rows to running without any possible execution.
    await localResourceStore?.writeWorkerSnapshot(o.profile.name)
    const packageSkillSnapshotPath = join(
      resourceControlDirectory,
      'worker-snapshots',
      `${o.profile.name}.package-skills.json`,
    )
    const resourceSkillLkgDirectory = join(resourceControlDirectory, 'skill-lkg', o.profile.name)
    if (createPlatform().snapshot().os === 'win32')
      windowsEnsurePrivateDirectorySync(resourceSkillLkgDirectory)
    else await mkdir(resourceSkillLkgDirectory, { recursive: true, mode: 0o700 })
    // Inventory verifies the lock and installed tree before any contribution reaches a worker.
    // A package-bearing profile therefore fails closed at startup rather than silently scanning a
    // user-controlled package directory.
    await writePackageSkillInventory(
      o.profile,
      o.profileDir,
      packageSkillSnapshotPath,
      collectPackageSkillFiles,
    )
    const activationBarrier = o.activationBarrier ?? createExtensionActivationBarrier()
    const commandQueue = new CommandQueue(undefined, (depth) => o.observability?.queueDepth(depth))
    startupCleanup.push(() => commandQueue.close())
    const notices = new NoticeSink({
      endpoints: () => [...conns],
      ...(o.audit ? { audit: o.audit } : {}),
      clock,
    })

    // Per session key, the connection whose `session/prompt` call currently holds `entry.inflight` -
    // set/cleared by the `onPromptStart`/`onPromptEnd` hooks each connection's own context installs
    // below (acp.ts calls them exactly around the window it holds `inflight`, so this can never observe
    // two connections "owning" the same session key at once; a concurrent second prompt is rejected
    // with SESSION_BUSY before either hook fires). This is what `PrompterRouter.originOf` needs and
    // `AgnesContext` has no field for: the in-process `createLocalEndpoint` form gets away with reading
    // `registry.get(key)?.inflight` directly because it only ever has one connection to attribute that
    // to - a supervisor with several concurrently-connected clients does not have that luxury.
    const inflightConn = new Map<string, ConnectionState>()

    const prompter = new PrompterRouter({
      resolveActor: async (conn, key) =>
        o.ports?.resolveActor
          ? o.ports.resolveActor(conn.credential, 'approval', key)
          : registry.require(key).session.resolveActor(conn.credential, 'approval'),
      ...(o.ports?.verifyApprovalSource ? { verifySource: o.ports.verifyApprovalSource } : {}),
      endpointFor: (conn) => {
        const found = [...conns].find((c) => c.conn === conn)
        // Every candidate PrompterRouter.ask() considers comes from `connections()` below, which is
        // drawn from this same `conns` set - so a candidate not found here would mean the set changed
        // between the two reads, which never happens within one synchronous filter/find pass.
        if (!found) throw new Error('endpointFor: connection not found among live connections')
        return found.ep
      },
      connections: () => [...conns].map((c) => c.conn),
      originOf: (key) => inflightConn.get(key),
      clock,
    })
    const jobTables = o.jobTables ?? o.tables
    const journal =
      o.ports?.journal ??
      (jobTables
        ? new PersistentCommandJournal(jobTables.table('command_journal'), clock)
        : new MemoryJournal(clock))
    await journal.gc(clock())
    const claims =
      o.ports?.claims ?? (jobTables ? new TableClaims(jobTables.table('auth_claims')) : new MemoryClaims())
    const nonces = jobTables ? new NonceTable(jobTables.table('auth_nonces')) : { consume: () => true }
    const persistentClaims = claims instanceof TableClaims ? claims : undefined
    const configuredSourceCredentials = o.remoteAuth?.sourceAuthCredentials
    const configuredSourceSecrets = o.remoteAuth?.sourceAuthSecrets
    const sourceRotation =
      configuredSourceCredentials?.length && jobTables
        ? new SourceAuthRotation(jobTables.table('source_auth_rotation'))
        : undefined
    sourceRotation?.configure(configuredSourceCredentials ?? [], clock())
    const ephemeralSourceKeyId = randomBytes(16).toString('hex')
    const runtimeSourceCredentials =
      configuredSourceCredentials ??
      configuredSourceSecrets?.map((secret, index) => ({ credentialId: `ephemeral:${index}`, secret }))
    const effectiveRemoteAuth = o.remoteAuth
      ? {
          ...o.remoteAuth,
          ...(runtimeSourceCredentials?.length
            ? {
                sourceAuthKeys: () =>
                  sourceRotation
                    ? sourceRotation.accepted(
                        configuredSourceCredentials ?? [],
                        clock(),
                        o.remoteAuth?.rotationGraceMs ?? 86_400_000,
                      )
                    : runtimeSourceCredentials.map((credential, index) => ({
                        secret: credential.secret,
                        keyId: `${ephemeralSourceKeyId}:${index}`,
                      })),
              }
            : {}),
        }
      : undefined
    if (effectiveRemoteAuth?.jwt?.jwksUrl && effectiveRemoteAuth.jwt) {
      stopJwksCache = await startJwksCache({
        url: effectiveRemoteAuth.jwt.jwksUrl,
        target: effectiveRemoteAuth.jwt,
        ...(o.jwksResolver ? { resolver: o.jwksResolver } : {}),
        ...(o.jwksTransport ? { transport: o.jwksTransport } : {}),
      })
      startupCleanup.push(() => stopJwksCache?.())
    }
    const tickets = jobTables ? new TicketIndex(jobTables.table('approval_tickets')) : undefined
    const workspaces: SessionWorkspacePort = jobTables
      ? new SessionWorkspaceIndex(jobTables.table('session_workspaces'))
      : new MemorySessionWorkspaces()
    const sessionOwnership = jobTables
      ? new SessionPrincipalOwnershipIndex(jobTables.table('session_principal_ownership'))
      : new MemorySessionPrincipalOwnership()
    projectedArtifactRead =
      o.artifactAuthorityProjection !== undefined
        ? composeProductionProjectedArtifactRead(o.config.dataDir, o.artifactAuthorityProjection)
        : o.artifactAuthorityTable &&
            jobTables &&
            sessionOwnership instanceof SessionPrincipalOwnershipIndex &&
            o.ports?.artifactRead === undefined &&
            o.artifactReadAuthority === undefined
          ? composeDefaultProductionProjectedArtifactRead(o.config.dataDir, {
              artifactAuthority: new PersistentArtifactReadAuthorityIndex(o.artifactAuthorityTable),
              sessionOwnership,
              limits: {
                maxArtifactBytes: Math.max(
                  100 * 1024 * 1024,
                  o.profile.computerUse?.capture.maxBytesPerImage ?? 0,
                ),
                maxResponseBytes: Math.max(
                  1024 * 1024,
                  o.profile.computerUse?.capture.maxBytesPerImage ?? 4 * 1024 * 1024,
                ),
              },
              operationTimeoutMs: 10_000,
              scopeTimeoutMs: 5_000,
              readTimeoutMs: 15_000,
            })
          : undefined
    artifactRead =
      projectedArtifactRead?.rpc ??
      (o.ports?.artifactRead !== undefined
        ? o.ports.artifactRead
        : o.artifactReadAuthority
          ? composeProductionArtifactRead(o.config.dataDir, o.artifactReadAuthority)
          : undefined)
    const workspaceCatalog = await openWorkspaceCatalog({
      dataDir: o.config.dataDir,
      tables: jobTables,
      sessions: workspaces,
      clock,
      workspaceRoot: o.workspaceRoot,
    })
    workspaceCatalogRef = workspaceCatalog
    const reclaimStore =
      o.reclaim ??
      (o.tables ? tableReclaimStore(o.tables.table('writer_claims'), o.tables.table('registers')) : undefined)
    tickets?.gc(clock())
    // `registry` is assigned right after `pool` is constructed, but `pool`'s own `onEvent` closure only
    // ever runs later (once a worker actually reports an event) - by which point `registry` is always
    // assigned. This breaks what would otherwise be a real circular dependency (WorkerPool needs a
    // registry to deliver events to; WorkerRegistry needs a pool to acquire links from).
    let registry!: WorkerRegistry
    let observeResourceMcpStatus:
      | ((input: {
          sessionKey: string
          serverId: string
          status: import('@agnes/protocol').McpStatus
        }) => void)
      | undefined
    const runtimeStore = jobTables
      ? new CompositeTargetStore(jobTables.table('composite_runtime'), o.profile.name)
      : undefined
    const notifyRuntimeTarget = (artifact: RuntimeTargetArtifact) =>
      notices.emit('tree_changed', {
        detail: {
          profile: o.profile.name,
          targetDigest: artifact.digest,
          identity: artifact.identity,
          hash: artifact.digest,
        },
      })
    let revertFailedDesired: (() => Promise<void>) | undefined
    const runtimeDelivery = runtimeStore
      ? new CompositeRuntimeDelivery(runtimeStore, {
          onFailureRecorded: () => revertFailedDesired?.(),
          onConverged: notifyRuntimeTarget,
        })
      : undefined
    const runtimeTargetProbe = runtimeStore
      ? createRuntimeTargetProbeLauncher({
          spawnWorker: spawnRuntimeTargetProbeWorker({
            executable: o.workerExecPath ?? process.execPath,
            args: [...(o.workerExecArgv ?? []), workerEntry],
          }),
        })
      : undefined
    const managementClients = {
      connections: () => [...conns].map((entry) => entry.conn),
      current: (key: string) => inflightConn.get(key),
      endpoint: (conn: ConnectionState) => [...conns].find((entry) => entry.conn === conn)?.ep,
      owner: (key: string) => sessionOwnership.resolve(key),
    }
    const skillInstallRequests = createSkillInstallRequests({
      directory: resourceControlDirectory,
      profile: o.profile.name,
      service: resourceControl.service,
      ...(resourceControl.unixAuthority ? { authority: resourceControl.unixAuthority } : {}),
      ...managementClients,
      workspace: (key) => workspaces.get(key),
    })
    let effectivePackageAdmin = o.packageAdmin
    const pluginManageRequests = createPluginManageRequests({
      directory: resourceControlDirectory,
      home: ownerHome,
      profile: o.profile.name,
      service: () => effectivePackageAdmin?.service,
      ...managementClients,
    })
    const mcpManageRequests = createMcpManageRequests({
      directory: resourceControlDirectory,
      profile: o.profile.name,
      service: resourceControl.service,
      ...(localResourceStore ? { store: localResourceStore } : {}),
      ...(resourceControl.unixAuthority ? { authority: resourceControl.unixAuthority } : {}),
      ...managementClients,
    })
    const verifyPermission = workerPermissionReader(sessionOwnership, () => pool.businessWorker()?.link)
    const permissionRequests = new Map<string, AbortController>()
    startupCleanup.push(() => {
      for (const controller of permissionRequests.values()) controller.abort('stopped')
    })
    const automationEvents = createAutomationEvents(sessionOwnership, notices, o.profile.name)
    const pool = new WorkerPool({
      config: o.config,
      profile: o.profile,
      profileFile: o.profileFile,
      resourceBootstrap: {
        ...(localResourceStore ? { snapshotPath: localResourceStore.snapshotPath(o.profile.name) } : {}),
        skillLkgDirectory: resourceSkillLkgDirectory,
        packageSkillSnapshotPath,
        mcpPolicy: deploymentMcpPolicy(process.env, o.profile.name),
      },
      clock,
      ...(o.workerExecPath ? { execPath: o.workerExecPath } : {}),
      ...(o.workerExecArgv ? { execArgv: o.workerExecArgv } : {}),
      workerEntry,

      ...(o.packageBytes && o.packageRuntime
        ? {
            preparePackageAdmission: async () => {
              await o.packageRuntime!.manager.runtimePluginSnapshots(o.profileDir)
              return o.packageBytes!.verification.admission()
            },
            onPackageByteFailure: (failure: import('@agnes/package-manager').ByteFailure) =>
              o.packageBytes!.fail(failure),
          }
        : {}),

      onEvent: (sessionKey, e) => {
        automationEvents.observe(sessionKey, e)
        if (e.type === 'turn/start') pool.resetSessionRequests(sessionKey)
        if (
          e.type === 'x/core/preset-switch' &&
          e.origin === 'system' &&
          (e.data as { fromPermission?: string }).fromPermission === 'full-access'
        ) {
          pool.revokeSessionRequests(sessionKey)
          pool.resetSessionRequests(sessionKey)
        }
        const control = e.data as { action?: unknown; outcome?: unknown }
        if (
          e.type === 'x/core/control' &&
          e.origin === 'principal' &&
          control.outcome === 'requested' &&
          (control.action === 'cancel' || control.action === 'interrupt')
        )
          pool.revokeSessionRequests(sessionKey)
        return deliverWorkerEvent(registry, tickets, clock, sessionKey, e, workspaces)
      },
      onPreview: (sessionKey, p) => registry.deliverPreview(sessionKey, p),
      onDecisionsChanged: (detail) => {
        if (detail.profile === o.profile.name) notices.emit('decisions_changed', { detail })
      },
      onResourceStatus: (input) => observeResourceMcpStatus?.(input),
      onRuntimeLog: (record) => o.audit?.(record),
      onLog: (input) => o.audit?.({ kind: 'worker.log', ...input }),
      onLifecycle: (phase, id) => o.observability?.lifecycle('worker', phase, undefined, id),
      onSessionFailure: (sessionKey, error) => registry.interrupt(sessionKey, error),
      ...(runtimeDelivery ? { runtimeDelivery } : {}),
      onRequest: async (sessionKey, f, workerSignal) => {
        if (f.method === 'scheduling')
          return callWorkerScheduling(schedules, workspaceCatalog, sessionKey, f.params, workerSignal)
        if (f.method === 'bound-wake') return profilePorts.ownedWake(f.params)
        if (['plugin-manage', 'mcp-manage', 'skill-install'].includes(f.method))
          return permissionRequest(
            f.permissionContext,
            resourceControlDirectory,
            () => {
              if (f.method === 'plugin-manage')
                return pluginManageRequests(sessionKey, f.requestId, f.method, f.params, workerSignal)
              if (f.method === 'mcp-manage')
                return mcpManageRequests(sessionKey, f.requestId, f.method, f.params, workerSignal)
              return skillInstallRequests(sessionKey, f.requestId, f.method, f.params, workerSignal)
            },
            () => verifyPermission(sessionKey),
          )
        if (f.method === 'plugin-manage-abort')
          return pluginManageRequests(sessionKey, f.requestId, f.method, f.params, workerSignal)
        if (f.method === 'mcp-manage-abort')
          return mcpManageRequests(sessionKey, f.requestId, f.method, f.params, workerSignal)
        if (f.method === 'skill-install-abort')
          return skillInstallRequests(sessionKey, f.requestId, f.method, f.params, workerSignal)
        const permissionKey = `${sessionKey}\0${f.requestId}`
        if (f.method === 'permission-abort') {
          const abort = f.params as { requestId?: unknown; reason?: unknown }
          if (typeof abort?.requestId === 'string')
            permissionRequests
              .get(`${sessionKey}\0${abort.requestId}`)
              ?.abort(abort.reason === 'deadline' ? 'deadline' : 'stopped')
          return undefined
        }
        if (f.method === 'permission') {
          const request = f.params as ApprovalRequest
          if (request.sessionKey !== sessionKey || permissionRequests.has(permissionKey))
            throw rpcError('INVALID_PARAMS')
          const controller = new AbortController()
          permissionRequests.set(permissionKey, controller)
          try {
            return await permissionRequest(
              f.permissionContext,
              resourceControlDirectory,
              () => prompter.ask(request, { signal: AbortSignal.any([workerSignal, controller.signal]) }),
              () => verifyPermission(sessionKey),
            )
          } finally {
            permissionRequests.delete(permissionKey)
          }
        }
        if (f.method === 'artifact-media-read') {
          if (!projectedArtifactRead?.workerRead) return undefined
          if (!f.params || typeof f.params !== 'object' || Array.isArray(f.params)) return undefined
          const descriptors = Object.getOwnPropertyDescriptors(f.params)
          if (
            Reflect.ownKeys(descriptors).length !== 3 ||
            !['lane', 'nodeSeq', 'sha256'].every(
              (key) =>
                descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key] ?? {}, 'value'),
            ) ||
            Reflect.ownKeys(descriptors).some(
              (key) => typeof key !== 'string' || !['lane', 'nodeSeq', 'sha256'].includes(key),
            )
          )
            return undefined
          const lane = descriptors.lane?.value
          const nodeSeq = descriptors.nodeSeq?.value
          const sha256 = descriptors.sha256?.value
          if (
            typeof lane !== 'string' ||
            lane.length < 1 ||
            lane.length > 64 ||
            !Number.isSafeInteger(nodeSeq) ||
            (nodeSeq as number) < 1 ||
            typeof sha256 !== 'string' ||
            !/^[a-f0-9]{64}$/u.test(sha256)
          )
            return undefined
          await registry.ensureArtifactAuthority(sessionKey, nodeSeq as number)
          const activeOwner = sessionOwnership.resolve(sessionKey)
          if (!activeOwner?.active) return undefined
          const result = await projectedArtifactRead.workerRead(
            { sessionId: sessionKey, laneId: lane, ownerId: activeOwner.principalId, sha256 },
            new AbortController().signal,
          )
          return artifactMediaReadReply(result, sha256)
        }
        // 'notice': declared on the wire (frames.ts) for a worker to relay a daemon notice, but nothing
        // in worker/main.ts constructs one yet (no `method: 'notice'` request-frame send site exists in
        // this package today) - this branch exists so a future worker-initiated notice has somewhere to
        // land instead of falling through unhandled; 'resumed' is the kind the plan's own sample used.
        notices.emit('resumed', { sessionId: sessionKey, detail: f.params })
        return undefined
      },
      notices,
    })
    runtimeStore?.onDesired((artifact) => {
      // Candidate publication can change static Skills without creating a package operation.
      skillWatcher?.changed({ rootKey: 'package' })
      pool.noteRuntimeTarget(artifact.digest)
      notifyRuntimeTarget(artifact)
      if (runtimeDelivery?.stageStartup(artifact)) return
      void deliverDesiredToWorkers(pool, artifact).catch((error) => {
        o.audit?.({
          kind: 'worker.log',
          sessionKey: '@shared',
          level: 'warn',
          message: `desired delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      })
    })
    registry = new WorkerRegistry(pool, projectedArtifactRead?.projection)
    // Resource lifecycle owns a profile-scoped service generation, independent of chat workers.
    if (localResourceStore) {
      const resourceAdapters = installResourceServiceAdapters({
        store: localResourceStore,
        pool,
        profile: o.profile,
        workspaceRoot: resourceWorkerRoot,
        resolveWorkspace: (workspaceId) => {
          if (!o.workspaceRoot && (!workspaceId || workspaceId === resourceWorkerWorkspaceId))
            return Promise.resolve({ workspaceId: resourceWorkerWorkspaceId, path: resourceWorkerRoot })
          return workspaceCatalog.bind(workspaceId, resourceWorkerRoot)
        },
        refreshPackageSkills: () =>
          writePackageSkillInventory(
            o.profile,
            o.profileDir,
            packageSkillSnapshotPath,
            collectPackageSkillFiles,
          ),
      })
      observeResourceMcpStatus = resourceAdapters.observeMcpStatus
      wireResourceSnapshotNotifications({ localResourceStore, registry, pool, log: console })
    }
    workerPool = pool
    o.packageBytes?.bindRuntime(pool, runtimeStore, notices, o.profile.name)
    startupCleanup.push(async () => {
      try {
        await pool.closeAll(o.config.limits.shutdownGraceMs)
      } finally {
        pool.killAll()
      }
    })
    // Runtime initialization may validate or bootstrap active extensions in a real service worker,
    // so the private listener must exist before initialize() can acquire that worker.
    const workersServer = await listenUnix(o.config.workersSocketPath, (socket) => pool.adopt(socket))
    startupCleanup.push(() => workersServer.close())
    let socketFailure: Error | undefined
    void workersServer.failed?.then((error) => {
      socketFailure = error
    })
    let clientServiceCall:
      | ((
          input: ClientModuleServiceCallParams & Readonly<{ packageId: string; extension: string }>,
        ) => Promise<ExtensionCallResult>)
      | undefined
    let clientEffectCall:
      | ((
          input: ClientModuleEffectCallParams & Readonly<{ packageId: string; extension: string }>,
          authority: PackageAdminAuthority,
        ) => Promise<ExtensionCallResult>)
      | undefined
    let stopClientModuleNotices: (() => void) | undefined
    let publishChildEngines: PublishChildEngines | undefined
    const hostFacade = supervisorHostFacade(o.profile, activationBarrier, pool)
    const host = hostFacade.host
    if (o.packageRuntime) {
      const packageRuntime = o.packageRuntime
      const packageProfileDirectory = await packageRuntime.profileDirectory(o.profile.name)
      // Surface wiring. Constructing the controller is cheap until start(); a profile that never
      // trusted a deploy directory pays nothing beyond this. Boot always coordinates surfaces.
      const surfaceSecretBackend =
        o.profile.adapters.secrets.kind === 'file'
          ? composeSecrets(
              createSecretsFile({ dir: secretsDirectory(o.profile, o.config) }),
              createSecretsEnv(),
            )
          : createSecretsEnv()
      if (o.packageRuntime.manager.localPluginRoots)
        await o.packageRuntime.manager.refreshLocalPlugins(packageProfileDirectory)
      let surfaceInventory = await o.packageRuntime.manager.inventory(packageProfileDirectory)
      const pinCoordinator = runtimeStore
        ? createRuntimePinCoordinator({
            store: runtimeStore,
            manager: o.packageRuntime.manager,
            profileDirectory: packageProfileDirectory,
          })
        : undefined
      await pinCoordinator?.recover()
      const basePackage = o.profile.packages.find((pkg) => pkg.id === '@agnes/base')
      if (runtimeStore && pinCoordinator && runtimeTargetProbe && basePackage) {
        const store = runtimeStore
        const coordinator = pinCoordinator
        const probe = runtimeTargetProbe
        const integrity = basePackage.integrity
        publishChildEngines = async (engines) => {
          try {
            const previous = store.desired()
            if (!previous) return 'restart-required'
            const artifact = overlayChildEngineTarget(previous, engines, integrity)
            if (artifact.digest !== previous.digest) await coordinator.publish(artifact, probe)
            return 'new-sessions'
          } catch {
            return 'restart-required'
          }
        }
      }
      if (runtimeStore && pinCoordinator && runtimeTargetProbe) {
        await activateDefaultHelpers({
          profileDir: o.profileDir,
          inventory: surfaceInventory,
          previous: runtimeStore.desired(),
          publish: (target) => pinCoordinator.publish(target, runtimeTargetProbe),
        })
        o.packageRuntime.bindReferences?.(
          createCompositeReferenceFacts(runtimeStore, () => pool.businessWorker()?.generation),
        )
        await refreshDefaultHelpers({
          profileDir: packageProfileDirectory,
          manager: packageRuntime.manager,
          previous: () => runtimeStore.desired(),
          publish: (target) => pinCoordinator.publish(target, runtimeTargetProbe),
        })
        surfaceInventory = await packageRuntime.manager.inventory(packageProfileDirectory)
      }
      // Bootstrap local sources through the existing pinned generation publication path.
      if (runtimeStore && pinCoordinator && runtimeTargetProbe) {
        for (const pkg of surfaceInventory.packages) {
          if (pkg.entry.source.type !== 'local' || pkg.localFailure || pkg.blockers.length) continue
          const previous = runtimeStore.desired()
          const target = rebuildDesiredFromInventory({
            previous,
            inventory: surfaceInventory,
            packageId: pkg.id,
            operation: pkg.enabled ? 'enable' : 'disable',
            configuration: (rowId) => runtimeStore.configAudit.value(pkg.id, rowId),
          })
          if (!target || target.digest === previous?.digest) continue
          try {
            await pinCoordinator.publish(target, runtimeTargetProbe)
          } catch {
            o.packageRuntime.manager.reportLocalPluginFailure(packageProfileDirectory, pkg.id)
          }
        }
      }
      surfaceController = createProfileSurfaceController(
        o.profile.name,
        surfaceInventory,
        (ref) => surfaceSecretBackend.resolve(ref),
        notices,
      )
      // Covers a startup ABORT only (thrown before this function returns a handle) -- see
      // `startupCleanup.length = 0` below, and cleanupStartup()'s own doc. The real graceful-stop
      // path is wired separately into `closeSockets` in the shutdown ladder further down.
      startupCleanup.push(() => surfaceController?.stop())
      await coordinateSurfacesOnBoot({
        ...(composition?.surfaces === undefined
          ? {}
          : { enabled: compositionSurfaceAllowed(composition, 'http') }),
        profileDir: o.profileDir,
        inventory: surfaceInventory,
        controller: surfaceController,
        harnessVersion: HARNESS_VERSION,
        surfaceApiVersion: DAEMON_SURFACE_API_VERSION,
        signal: new AbortController().signal,
      })
      let latestInventory = surfaceInventory
      // Older desired artifacts predate daemon-owned web rows. Repair this narrow slice before
      // normal delivery without rewriting unrelated ordinary or resource rows.
      if (runtimeStore) {
        const repaired = reconcileDesiredWebRows({
          desired: runtimeStore.desired(),
          inventory: latestInventory,
        })
        if (repaired && repaired.digest !== runtimeStore.desired()?.digest) {
          if (runtimeTargetProbe && pinCoordinator) await pinCoordinator.publish(repaired, runtimeTargetProbe)
          else runtimeStore.publishDesired(repaired)
        }
      }
      const targetReverter = runtimeStore
        ? createTargetReverter({
            store: runtimeStore,
            loadableSnapshots: async () => {
              const [inventory, pins] = await Promise.all([
                packageRuntime.manager.inventory(packageProfileDirectory),
                packageRuntime.manager.listRuntimePins(packageProfileDirectory),
              ])
              const eligible = new Set(
                inventory.packages.filter(isRuntimePackageEligible).map((pkg) => pkg.id),
              )
              return new Map(
                pins
                  .filter(
                    (pin) =>
                      pin.purpose === 'active' &&
                      eligible.has(pin.snapshot.packageId) &&
                      pin.pinId === activeRuntimePinId(pin.snapshot),
                  )
                  .map((pin) => [
                    `${pin.snapshot.packageId}@${pin.snapshot.integrity}`,
                    pin.snapshot.integrity,
                  ]),
              )
            },
            audit: (event) => o.audit?.(event),
          })
        : undefined
      revertFailedDesired = targetReverter
        ? () =>
            (pinCoordinator
              ? pinCoordinator.revert(() => targetReverter.revertFailedDesired())
              : targetReverter.revertFailedDesired()
            ).catch((error) => {
              o.audit?.({
                kind: 'worker.log',
                sessionKey: '@shared',
                level: 'warn',
                message: `reverting a failed target failed: ${error instanceof Error ? error.message : String(error)}`,
              })
            })
        : undefined
      const compositeActivation = runtimeStore
        ? createCompositeTargetActivation({
            store: runtimeStore,
            ...(revertFailedDesired ? { revertFailedDesired } : {}),
            settle: {
              timeoutMs: o.config.limits.workerStartupMs + 45_000,
              deliverable: () => !pool.isQuarantined('@shared'),
            },
            ...(runtimeTargetProbe ? { probe: runtimeTargetProbe } : {}),
            ...(pinCoordinator
              ? {
                  publish: (target, probe, base, admission) =>
                    pinCoordinator.publish(target, probe, base, undefined, admission),
                }
              : {}),
            ...(pinCoordinator ? { collectPins: pinCoordinator.collect } : {}),
            ...(pinCoordinator ? { revokePackage: pinCoordinator.revokePackage } : {}),
            ...(pinCoordinator ? { releaseRetiring: pinCoordinator.releaseRetiring } : {}),
            generationStatus: async () => {
              const status = await readRunningGenerationStatus(pool, o.config.limits.workerStartupMs)
              const running = (key: string) => registry.get(key)?.session.running === true
              return describeGenerationSessions(status, { lister, running })
            },
            publicationStatus: async () => {
              const worker = await pool.acquireSharedWorker()
              return (await worker.command(
                'pluginGenerations.publicationStatus',
                {},
                { timeoutMs: o.config.limits.workerStartupMs },
              )) as import('@agnes/protocol').PluginPublicationStatusResult
            },
            migrateSession: async (_profile, sessionId, principalId, migration) => {
              return registry.migrateGeneration(sessionId, principalId, sessionOwnership, async () => {
                const worker = await pool.acquireSharedWorker()
                // Retain the admission fence until the worker replies or exits. A command timeout
                // must not reopen admission while a durable pin write may still be running.
                return (await worker.command('pluginGenerations.migrate', {
                  sessionId,
                  operator: principalId,
                  ...(migration?.repin ? { repin: migration.repin } : {}),
                })) as import('@agnes/protocol').SessionGenerationMigrationResult
              })
            },
            collectGenerations: async () => {
              const worker = pool.businessWorker()
              if (worker)
                await worker.link.command(
                  'pluginGenerations.collect',
                  {},
                  { timeoutMs: o.config.limits.workerStartupMs },
                )
            },
            workerGeneration: () => pool.businessWorker()?.generation,
            workerStarting: () => pool.hasHostActivity('@shared'),
            desiredFor: async ({ packageId, operation, packageIds = [] }) => {
              latestInventory = await packageRuntime.manager.inventory(packageProfileDirectory)
              let previous = runtimeStore.desired()
              for (const member of [packageId, ...packageIds])
                previous = rebuildDesiredFromInventory({
                  previous,
                  inventory: latestInventory,
                  packageId: member,
                  operation,
                  configuration: (rowId) => runtimeStore.configAudit.value(member, rowId),
                })
              return previous
            },
            contributions: (packageId) =>
              latestInventory.packages.find((pkg) => pkg.id === packageId)?.contributions,
            surfaceRunningRevision: (packageId) =>
              surfaceController
                ?.snapshot()
                .instances.find((row) => row.package === packageId && row.state === 'healthy')?.revision,
            desiredSurfaceRevision: (packageId) =>
              latestInventory.packages.find((pkg) => pkg.id === packageId)?.entry.integrity,
            packageIdentity: (packageId) => {
              const pkg = latestInventory.packages.find((row) => row.id === packageId)
              // What the worker last applied wins; the installed entry is only the fallback for a
              // package that has no plugin row in the applied target (extension-only or surface packages).
              return (
                runningPackageIdentity({ lastGood: runtimeStore.lastGood(), packageId, pkg }) ??
                (pkg ? { version: pkg.entry.version, integrity: pkg.entry.integrity } : undefined)
              )
            },
            lifecycleEligible: (packageId) => {
              const pkg = latestInventory.packages.find((row) => row.id === packageId)
              return pkg !== undefined && isRuntimePackageEligible(pkg)
            },
            deliver: (artifact) => deliverDesiredToWorkers(pool, artifact),
          })
        : undefined
      const compositePins = runtimeStore
        ? createCompositeRuntimePins({
            store: runtimeStore,
            profile: o.profile.name,
            manager: o.packageRuntime.manager,
            profileDirectory: packageProfileDirectory,
            ...(pinCoordinator ? { coordinator: pinCoordinator } : {}),
          })
        : undefined
      if (runtimeStore)
        o.packageRuntime.bindReferences?.(
          createCompositeReferenceFacts(runtimeStore, () => pool.businessWorker()?.generation),
        )
      if (compositeActivation) o.packageRuntime.bindActivation?.(compositeActivation)
      if (o.packageRuntime.manager.localPluginRoots) {
        if (compositeActivation)
          o.packageRuntime.manager.bindLocalPluginReload({
            async reloadPlugin(id) {
              const inventory = await o.packageRuntime!.manager.inventory(packageProfileDirectory)
              const plugin = inventory.packages.find((pkg) => pkg.id === id)
              if (!plugin || plugin.localFailure)
                throw new Error('E_PLUGIN_RELOAD_METADATA: local plugin is unavailable')
              const result = await compositeActivation.reconcile({
                profile: o.profile.name,
                packageId: id,
                operationId: `local-reload:${id}`,
                operation: 'update',
                signal: new AbortController().signal,
              })
              if (result.error) throw new Error(result.error.code)
            },
          })
        const watcher = o.packageRuntime.manager.watchLocalPlugins(packageProfileDirectory)
        localPluginWatcher = watcher
        startupCleanup.push(() => watcher.close())
      }
      if (compositePins) o.packageRuntime.bindRuntimePins?.(compositePins)
      if (runtimeStore)
        o.packageRuntime.bindPluginTree?.(
          runtimeStore,
          () => pool.businessWorker()?.generation,
          runtimeTargetProbe
            ? async (artifact, liveConfig) => {
                await revertFailedDesired?.()
                const apply =
                  liveConfig && runtimeDelivery
                    ? async (target: RuntimeTargetArtifact) => {
                        const link = await pool.acquireSharedWorker().catch(() => {
                          throw new Error('E_RUNTIME_TARGET_OUTCOME_UNKNOWN')
                        })
                        const worker = pool.businessWorker()
                        if (!worker || worker.link !== link)
                          throw new Error('E_RUNTIME_TARGET_OUTCOME_UNKNOWN')
                        const restore = async () => {
                          const current = runtimeStore.desired()
                          const worker = pool.businessWorker()
                          if (!current || !worker) throw new Error('E_RUNTIME_TARGET_OUTCOME_UNKNOWN')
                          const restored = await runtimeDelivery.applyBeforeCommit(
                            worker.generation,
                            current,
                            () => worker.link.offerRuntimeTarget(current),
                          )
                          if (
                            !restored.report.ok ||
                            !worker.link.alive ||
                            pool.businessWorker()?.generation !== restored.generation
                          )
                            throw new Error('E_RUNTIME_TARGET_OUTCOME_UNKNOWN')
                        }
                        let receipt: Awaited<ReturnType<CompositeRuntimeDelivery['applyBeforeCommit']>>
                        try {
                          receipt = await runtimeDelivery.applyBeforeCommit(worker.generation, target, () =>
                            link.offerRuntimeTarget(target),
                          )
                        } catch (error) {
                          // A Host publication can fail after some composition containers applied.
                          if (error instanceof Error && error.name === 'PluginConfigRefused') {
                            try {
                              await restore()
                            } catch {
                              throw new Error('E_RUNTIME_TARGET_OUTCOME_UNKNOWN')
                            }
                          }
                          throw error
                        }
                        if (!link.alive || pool.businessWorker()?.generation !== receipt.generation)
                          throw new Error('E_RUNTIME_TARGET_OUTCOME_UNKNOWN')
                        return {
                          ...receipt,
                          isCurrent: () =>
                            link.alive && pool.businessWorker()?.generation === receipt.generation,
                          restore,
                        }
                      }
                    : undefined
                if (pinCoordinator)
                  await pinCoordinator.publish(artifact, runtimeTargetProbe, undefined, apply)
                else
                  await publishProbedRuntimeTarget({
                    store: runtimeStore,
                    artifact,
                    probe: runtimeTargetProbe,
                    ...(apply ? { apply } : {}),
                  })
              }
            : undefined,
        )
      void revertFailedDesired?.()
      effectivePackageAdmin ??= {
        service: createPackageAdminService({
          resolveAgent: hostFacade.resolveApplicationAgent,
          authoringHome: ownerHome,
          manager: o.packageRuntime.manager,
          profileDirectory: o.packageRuntime.profileDirectory,
          operations: o.packageRuntime.operations,
          ...(o.packageRuntime.catalog ? { catalog: o.packageRuntime.catalog } : {}),
          ...(compositeActivation ? { activation: compositeActivation } : {}),
          ...(compositePins ? { runtimePins: compositePins } : {}),
          ...(runtimeStore ? { pluginTree: runtimeStore } : {}),
          ...(pinCoordinator ? { revokeRuntimePackage: pinCoordinator.revokePackage } : {}),
          workerGeneration: () => pool.businessWorker()?.generation,
          clientServiceCall: async (input) => {
            if (!clientServiceCall) throw rpcError('CAPABILITY_DENIED')
            return await clientServiceCall(input)
          },
          clientEffectCall: async (input, authority) => {
            if (!clientEffectCall) throw rpcError('CAPABILITY_DENIED')
            return await clientEffectCall(input, authority)
          },
          clientModules: createClientModuleRegistry({
            composition: () => composition,
            snapshotDirectory: (profile) => join(o.config.dataDir, 'daemon', 'client-modules', profile),
            runtimeArtifacts: () =>
              runtimeArtifactsFromStore(runtimeStore, pool.businessWorker()?.generation),
          }),
        }),
      }
    }
    runtimeDelivery?.completeStartup()
    if (effectivePackageAdmin) {
      stopClientModuleNotices = effectivePackageAdmin.service.subscribeClientModules((event) =>
        notices.emit('packages_changed', { detail: event }),
      )
      startupCleanup.push(() => {
        stopClientModuleNotices?.()
        effectivePackageAdmin?.service.closeClientModules()
      })
      await effectivePackageAdmin.service.rebuildClientModules(o.profile.name)
    }
    const supervisorRegistry = new SupervisorRegistry(registry, workspaces)
    o.packageRuntime?.bindAgentResolver?.(hostFacade.resolveApplicationAgent)
    const services = workerClientServices(pool, () => host.profile)
    clientServiceCall = services.dispatchClientService
    o.packageRuntime?.bindClientService?.(services.dispatchClientService)
    const dispatchClientEffect = async (
      input: ClientModuleEffectCallParams & Readonly<{ packageId: string; extension: string }>,
      authority: PackageAdminAuthority,
    ): Promise<ExtensionCallResult> => {
      const params: ExtensionCallParams & { commandId: string } = {
        sessionId: input.sessionId,
        extension: input.extension,
        service: input.service,
        commandId: input.commandId,
        input: input.input,
      }
      const credential = Object.freeze({
        kind: 'surface-service' as const,
        source: 'client-web',
        subjectCredential: Object.freeze({ kind: 'local' }),
        grants: Object.freeze([{ extension: input.extension, name: input.service, range: '*' }]),
      })
      let invocation: ReturnType<ExtensionActivationBarrier['admit']>
      try {
        invocation = activationBarrier.admit('service')
      } catch (error) {
        if (error instanceof ActivationInProgressError)
          throw rpcError('OVERLOADED', { reason: error.reason, operationId: error.operationId })
        throw error
      }
      return await invocation.run(async () => {
        const inspection = await services.inspectService(params, credential)
        if (inspection.kind !== 'effect') throw rpcError('CAPABILITY_DENIED')
        const serviceId = `service:client-web:${input.extension}/${input.service}`
        return await executeJournaledEffect({
          journal,
          commandQueue,
          callService: services.callService,
          params,
          credential,
          signal: new AbortController().signal,
          serviceId,
          identity: {
            principalId: authority.principalId,
            clientId: authority.clientId,
            sessionId: `client-module:${input.rowId}:${input.sessionId}`,
            commandId: input.commandId,
          },
          bindingKind: 'client-module.effect',
        })
      })
    }
    clientEffectCall = dispatchClientEffect
    o.packageRuntime?.bindClientEffect?.(dispatchClientEffect)
    const profileApplication = o.configuration
      ? await configurationApplication({
          service: o.configuration,
          profile: o.profile,
          ...(o.reloadProfile ? { reloadProfile: o.reloadProfile } : {}),
          activate: async (next) => {
            // A starting worker must keep reading its original immutable profile artifact.
            const profileFile = `${o.profileFile}.${next.hash}.json`
            await persistResolvedProfile(profileFile, next)
            await pool.applyModelProfile({ profile: next, profileFile })
            hostFacade.update(next)
          },
        })
      : undefined
    const modelCatalog = readModelSelectionCatalog({
      worker: () => pool.businessWorker()?.link,
      profile: () => host.profile,
      profileDir: o.profileDir,
      sources: () => o.packageRuntime?.manager.runtimePluginSnapshots(o.profileDir) ?? Promise.resolve([]),
    })
    const sessionSelection = sessionSelectionProvider(
      o.configuration,
      () => sharedSessionCatalog(pool),
      modelCatalog,
    )
    const preferences = new SessionPreferencesStore(jobTables?.table('session_preferences'))
    const sidebarSessions = jobTables
      ? new SidebarSessions(
          jobTables.table('session_workspaces'),
          workspaces,
          o.sessionFactRead ? (key, query) => o.sessionFactRead!(key)(query) : undefined,
        )
      : new MemorySidebarSessions(workspaces, sessionOwnership, preferences, () => workspaceCatalog.list())
    startupCleanup.push(() => sidebarSessions.close())
    const rawLister =
      o.ports?.lister ??
      (o.tables
        ? new StorageLister(o.tables.table('events'), o.tables.table('writer_claims'), workspaces)
        : supervisorLister(supervisorRegistry, workspaces))

    const lister = withSessionPreferences(rawLister, preferences)

    const jobsRepo = jobTables ? new JobsRepo(jobTables.table('jobs'), clock) : undefined
    const schedules = jobTables
      ? scheduledTasks({
          db: openDaemonScheduleDb(jobTables.table('schedules')),
          clock,
          socketPath: o.config.socketPath,
          serverIdentity: lock.owner,
          sources: {
            workspaces: async () => (await workspaceCatalog.list()).items,
            normalize: async (path) => (await workspaceCatalog.validate(path)).path,
            catalog: async () =>
              (await (
                await pool.acquireSharedWorker()
              ).command('session.catalog', {}, { timeoutMs: 31_000 })) as ScheduleCatalog,
            presets: () => host.profile.presets.allowed,
          },
        })
      : undefined
    automationEvents.schedules = schedules
    if (schedules) startupCleanup.push(() => schedules.close())
    const profilePorts = createSupervisorProfileServices({
      runtime: o.packageRuntime,
      profile: o.profile.name,
      pool,
      repo: jobsRepo,
      profileHash: host.profile.hash,
      clock,
      ownership: sessionOwnership,
      workspaces: workspaceCatalog,
      registry,
    })
    const boundWakes = profilePorts.boundWakes
    const scheduler = jobsRepo
      ? new Scheduler({
          repo: jobsRepo,
          boundWake: profilePorts.boundWake,
          registry: supervisorRegistry,
          notices,
          clock,
          owner: `agnesd-${lock.owner.processStartId}`,
          limits: {
            tickMs: o.config.limits.jobsTickMs,
            lockMs: o.config.limits.jobsLockMs,
            maxStalled: o.config.limits.jobsMaxStalled,
          },
          workspaces: workspaceCatalog,
          ownership: sessionOwnership,
          activationBarrier,
          ...(schedules ? schedules.hooks : {}),
        })
      : undefined
    const jobs =
      jobsRepo && scheduler
        ? new JobsService({
            repo: jobsRepo,
            get profileHash() {
              return host.profile.hash
            },
            clock,
            onCancel: (jobId) => scheduler.abort(jobId),
          })
        : undefined
    const selectedJobs = o.ports?.jobs ?? jobs

    // The listener is live before restart recovery can acquire a resource-only worker.
    if (localResourceStore) await resourceControl.service.recover()
    if (localResourceStore) {
      const watcher = await startSkillWatcher({
        service: resourceControl.service,
        profile: o.profile.name,
        catalog: workspaceCatalog,
        ...(effectivePackageAdmin ? { packages: effectivePackageAdmin.service } : {}),
        ...(o.workspaceRoot ? { defaultWorkspaceRoot: resourceWorkerRoot } : {}),
        log: console,
      })
      skillWatcher = watcher
      startupCleanup.push(() => watcher.close())
    }
    // The shared worker is up from here on rather than from the first session.
    const keeper = keepSharedWorker({
      acquire: () => pool.acquireSharedWorker(),
      onRetry: (listener) => pool.onBootRetry(listener),
      log: console,
    })
    sharedKeeper = keeper
    startupCleanup.push(() => keeper.close())

    let reclaimIntake = true
    const reclaimAbort = new AbortController()
    let reclaiming = Promise.resolve<ReclaimRecord[]>([])
    const reclaim = async (): Promise<ReclaimRecord[]> => {
      if (!reclaimStore) return []
      const records = await reclaimExpired({
        store: reclaimStore,
        now: clock(),
        openForResume: async (sessionKey, runId) => {
          if (!sessionOwnership.resolve(sessionKey))
            throw new Error(`session owner unavailable for ${sessionKey}`)
          const binding = await workspaceCatalog.restoreBinding(sessionKey)
          const opening = supervisorRegistry.openIfAbsent(
            { key: sessionKey, cwd: binding.canonicalRoot, binding, resume: true },
            runId,
          )
          if (!opening) return null
          const entry = await opening
          return { session: { resume: () => entry.session.resume() as Promise<ResumeReport> } }
        },
        notices,
        signal: reclaimAbort.signal,
      })
      for (const record of records) {
        if (!reclaimIntake) break
        if (record.resumed) scheduler?.recordResume(record.sessionKey)
      }
      return records
    }
    const reclaimNow = (): Promise<ReclaimRecord[]> => {
      const admitted = (): Promise<ReclaimRecord[]> => (reclaimIntake ? reclaim() : Promise.resolve([]))
      const requested = reclaiming.then(admitted, admitted)
      // Keep the serialization tail fulfilled after a failed manual/periodic pass while returning
      // the original rejection to its caller. A later doctor/manual pass must still be able to run.
      reclaiming = requested.catch(() => [])
      return requested
    }
    if (reclaimStore) await reclaimNow()
    const reclaimTimer = reclaimStore
      ? setInterval(() => {
          void reclaimNow().catch(() => undefined)
        }, 30_000)
      : undefined
    reclaimTimer?.unref()
    if (reclaimTimer) startupCleanup.push(() => clearInterval(reclaimTimer))
    const childMaintenance = startChildMaintenance({ dbPath: sessionsDbPath(o.config.dataDir) })
    startupCleanup.push(() => childMaintenance.stop())

    const resolveActor: NonNullable<AgnesContext['resolveActor']> =
      o.ports?.resolveActor ??
      (async (credential, surface, sessionId) => {
        if (!sessionId)
          throw rpcError('CAPABILITY_DENIED', {
            method: 'resolveActor',
            reason: 'session identity context unavailable',
          })
        return registry.require(sessionId).session.resolveActor(credential, surface)
      })
    const resolveNewSessionActor: Host['resolveActor'] =
      o.profile.seams?.principals?.provider === 'local'
        ? async (_credential, surface) => ({
            id: 'local',
            org: 'local',
            role: 'owner',
            deptPath: [],
            attrs: { surface },
          })
        : async () => {
            throw rpcError('CAPABILITY_DENIED', {
              method: 'session/new',
              reason: 'new session actor authority unavailable',
            })
          }
    const continueTrigger = createFollowUpRunner(
      { commandQueue, activationBarrier, onPromptEnd: (id) => registry.retireAtTurnBoundary(id) },
      async () => undefined,
    )
    const triggerSessions = webhookSessions(o.config.socketPath, lock.owner, async (input) => {
      const entry = supervisorRegistry.require(input.sessionKey)
      // Only this backend closure can mint trigger identity/provenance; no chat RPC accepts it.
      await runQueued(commandQueue, entry.key, entry.ac.signal, () =>
        entry.session.enqueue('next-turn', {
          content: [{ type: 'text', text: input.prompt }],
          actor: {
            id: `webhook:${input.trigger.ruleId}`,
            org: 'webhook',
            role: 'trigger',
            deptPath: [],
            attrs: { ...input.trigger, unattendedApproval: input.unattendedApproval ?? 'notify' },
          },
          origin: 'system',
          trust: 'untrusted',
          kind: 'follow_up',
          commandId: `webhook:${input.trigger.deliveryId}`,
        }),
      )
      continueTrigger(entry)
    })
    startupCleanup.push(() => triggerSessions.close())
    const appServerAdmin = createAppServerAdmin({
      triggerSession: triggerSessions.create,
      credentialConfigurations: async () => {
        if (!runtimeStore) throw new Error('credential reference inspection unavailable')
        return runtimeStore.credentialConfigurations()
      },
      home: o.config.home ?? dirname(dirname(o.profileDir)),
      dataDir: o.config.dataDir,
      profileDir: o.profileDir,
      resolveProfile: o.reloadProfile ?? (async () => o.profile),
      workspaces: () => workspaceCatalog.list(),
      plan: createPlanCommands({
        activationBarrier,
        journal,
        commandQueue,
        callService: services.callService,
        inspectService: services.inspectService,
        resolveService: services.resolveService,
      }),
      memory: async (input) => {
        const link = await pool.acquireSharedWorker()
        return (await link.command('memory.manage', input)) as Pick<
          import('@agnes/protocol/gen/app-server').AdminMemoryResult,
          'inspection' | 'file'
        >
      },
    })
    automationEvents.triggers = appServerAdmin.observeTriggerSession
    // Display queries read release registrations and source-bound published descriptions.
    // Each request verifies the current files and grants; none starts a worker for its catalog.
    const adapterLookup = modelCatalog
    const endpoint = (transport: 'unix' | 'ws'): { ep: LocalEndpoint; onClose: () => void } => {
      // `local` is the Unix identity and only a pre-auth placeholder for WSS. The lifecycle bearer
      // admits an HTTP upgrade but establishes no application principal; authGate replaces this value
      // from the verified initialize credential before any authenticated method can run.
      const principalId = 'local'
      const ep = new LocalEndpoint({
        clock,
        principalId,
        profile: o.profile.name,
        ...(o.audit ? { audit: o.audit } : {}),
      })
      registerPluginRuntimeIngress(ep, pool, transport)
      const feeds = new Map<string, Feed>()
      const attached = new Map<string, AttachedFeed>()
      const artifactReadConfigured = artifactRead !== undefined
      const factRead: (key: string) => ScanRead<import('@agnes/protocol').EventEnvelope> =
        o.sessionFactRead ?? ((key) => (query) => cx.registry.require(key).session.scan(query))
      const cx: AgnesContext = {
        profileFeatures: profilePorts.features,
        sessionServices: {
          activationBarrier,
          journal,
          commandQueue,
          callService: services.callService,
          inspectService: services.inspectService,
          resolveService: services.resolveService,
        },
        host,
        registry: supervisorRegistry,
        prompter,
        clock,
        agnesVersion: typeof AGNES_VERSION === 'string' ? AGNES_VERSION : '0.0.0',
        quiescenceWaitMs: 2_000,
        configuration: o.configuration !== undefined,
        modelAdapters: adapterLookup,
        // The WSS lifecycle bearer is only an upgrade gate. initialize still requires one of the
        // configured remote credentials; missing/local auth on WSS is always refused.
        auth: {
          config: {
            transport,
            ...(transport === 'ws' ? effectiveRemoteAuth : {}),
            ...(transport === 'ws' && o.config.localWeb ? { localWeb: true } : {}),
          },
          nonces,
          clock,
        },
        commandQueue,
        activationBarrier,
        workspaces: workspaceCatalog,
        // @agnes/base's principals seam is fixed to org=local and the worker opens with the same
        // local credential. Any custom principals seam stays closed before a worker exists.
        resolveNewSessionActor,
        sessionOwnership,
        ...(sidebarSessions ? { sidebarSessions } : {}),
        hasSessionFact: (sessionId: string) =>
          supervisorRegistry.get(sessionId) !== undefined ||
          workspaceCatalog.sessionPath(sessionId) !== undefined,
        limits: {
          subscribeBufferEvents: o.config.limits.subscribeBufferEvents,
          subscribeBufferBytes: o.config.limits.subscribeBufferBytes,
        },
        journal,
        claims,
        ...(selectedJobs ? { jobs: selectedJobs } : {}),
        ...(schedules ? { schedules } : {}),
        lister,
        ...(o.ports?.directory ? { directory: o.ports.directory } : {}),
        resolveActor,
        ...(o.ports?.verifyApprovalSource ? { verifyApprovalSource: o.ports.verifyApprovalSource } : {}),
        ...(tickets ? { tickets } : {}),
        authKind: 'local',
        credentialKind: 'local',
        artifactRead: artifactReadConfigured,
        ...(o.lockedPackageMutations !== undefined
          ? { lockedPackageMutations: o.lockedPackageMutations }
          : {}),
        ...(host.computerUse ? { computerUse: host.computerUse } : {}),
        forkSession: async (sessionId, at, childKey, credential, principalId) => {
          const denyFork = (): never => {
            throw rpcError('CAPABILITY_DENIED', {
              method: 'session.fork',
              reason: 'session owner unavailable',
            })
          }
          const ownerPrincipal = principalId ?? denyFork()
          if (!Number.isSafeInteger(at) || at < 1)
            throw rpcError('SEMANTIC_REJECTED', { reason: 'fork boundary must be a completed turn/end' })
          const ownedChildKey = childKey ?? `agnes:fork:${randomUUID()}`
          try {
            if (sessionOwnership.resolve(sessionId)?.principalId !== ownerPrincipal) denyFork()
            if (!sessionOwnership.inherit(sessionId, ownedChildKey, ownerPrincipal, at)) denyFork()
          } catch {
            denyFork()
          }
          try {
            const parentBinding = await workspaceCatalog.restoreBinding(sessionId)
            const childBinding = await workspaceCatalog.authorizeAndBind(
              ownedChildKey,
              parentBinding.canonicalRoot,
            )
            const created = await supervisorRegistry.fork({
              parent: sessionId,
              at,
              childKey: ownedChildKey,
              binding: childBinding,
              ...(credential === undefined ? {} : { credential }),
            })
            const entry = await activateForkOwnership(supervisorRegistry, created, () =>
              sessionOwnership.activateFork(sessionId, created.key, ownerPrincipal, at),
            )
            await sessionPrefs.copyForkBookmarks(preferences, factRead(sessionId), sessionId, at, entry.key)
            return { result: { sessionId: entry.key } }
          } catch (error) {
            if ((error as { code?: unknown }).code === 'E_LANE_BUSY')
              throw rpcError('SESSION_BUSY', { sessionId, reason: 'fork requires an idle parent' })
            throw error
          }
        },
        onPromptStart: (sessionId) => inflightConn.set(sessionId, ep.conn),
        onPromptEnd: (sessionId) => {
          inflightConn.delete(sessionId)
          registry.retireAtTurnBoundary(sessionId)
        },
      }
      registerConfiguration(
        ep,
        o.configuration,
        profileApplication?.apply,
        profileApplication?.present,
        publishChildEngines,
        async () => (await sessionSelection?.modelAdapters())?.flatMap((adapter) => adapter.models) ?? [],
      )
      registerAppServerAdmin(
        ep,
        appServerAdmin,
        transport === 'unix'
          ? (effectivePackageAdmin?.unixAuthority ?? localPackageAdminAuthority())
          : denyPackageAdminAuthority,
        effectivePackageAdmin?.service,
      )
      sessionPrefs.registerSessionPreferences(ep, lister, preferences)
      registerSessionMethods(ep, pool, cx)
      registerWorkspaces(ep, workspaceCatalog, {
        running: (id) => Boolean(registry.get(id)?.inflight || registry.get(id)?.session.running),
        archive: (id) => {
          preferences.archive(id, true)
        },
      })
      registerAcp(ep, cx, feeds, attached)
      registerAgnes(ep, cx, feeds, attached)
      registerDoctor(ep, {
        home: o.config.home ?? dirname(dirname(o.profileDir)),
        profile: o.profile.name,
        dataDir: o.config.dataDir,
        ...(o.configuration ? { configuration: o.configuration } : {}),
        connection: async () => true,
      })
      if (effectivePackageAdmin)
        registerFeedback(ep, {
          authority:
            transport === 'unix'
              ? (effectivePackageAdmin.unixAuthority ?? localPackageAdminAuthority())
              : (effectivePackageAdmin.webAuthority ?? denyPackageAdminAuthority),
          owner: (id, context) => requireSessionOwner(cx)('feedback', id, context),
          actor: async (id, context) => {
            if (!cx.resolveActor) throw rpcError('CAPABILITY_DENIED')
            return cx.resolveActor(context.conn.credential, 'session', id)
          },
          serialize: (id, signal, work) => runQueued(cx.commandQueue, id, signal, work),
          open: async (context, input, actor, signal) => {
            const sessionId = input.sessionId,
              writable = input.action !== 'list'
            const resolveAuthority =
              transport === 'unix'
                ? (effectivePackageAdmin!.unixAuthority ?? localPackageAdminAuthority())
                : (effectivePackageAdmin!.webAuthority ?? denyPackageAdminAuthority)
            const authority = resolveAuthority(context)
            if (!authority) throw rpcError('CAPABILITY_DENIED')
            feedbackOwner ??= createFeedbackOwner(o.profile.name)
            return feedbackOwner.bind({
              actor,
              signal,
              ...(sessionId === undefined ? {} : { sessionId }),
              authority: feedbackPorts({
                context,
                profile: o.profile.name,
                authority,
                packages: effectivePackageAdmin!.service,
                ids: sessionOwnership.activeSessionIds(context.conn.principalId),
                authorize: async (id) => {
                  if (!writable || sessionId !== id || !cx.resolveActor) throw rpcError('CAPABILITY_DENIED')
                  requireLocalAdminAuthority(context, resolveAuthority, true)
                  requireSessionOwner(cx)('feedback', id, context)
                  const actor = await cx.resolveActor(context.conn.credential, 'session', id)
                  requireLocalAdminAuthority(context, resolveAuthority, true)
                  requireSessionOwner(cx)('feedback', id, context)
                  return actor
                },
                session: (id) => registry.require(id).session,
                scan: async (id, types) => {
                  requireSessionOwner(cx)('feedback', id, context)
                  const scan =
                    o.sessionFactRead?.(id) ??
                    ((
                      query: Parameters<
                        import('@agnes/host').ScanRead<import('@agnes/protocol').EventEnvelope>
                      >[0],
                    ) => registry.require(id).session.scan(query))
                  const rows: import('@agnes/protocol').EventEnvelope[] = []
                  let fromSeq = 1,
                    bytes = 0
                  while (rows.length <= 4096) {
                    const page = await scan({
                      type: [...types],
                      order: 'asc',
                      fromSeq,
                      limit: Math.min(100, 4097 - rows.length),
                    })
                    bytes += Buffer.byteLength(JSON.stringify(page), 'utf8')
                    if (bytes > 4 * 1024 * 1024)
                      throw rpcError('SEMANTIC_REJECTED', { reason: 'FEEDBACK_READ_LIMIT' })
                    rows.push(...page)
                    if (rows.length <= 4096 && page.length < 100) return rows
                    fromSeq = page.at(-1)!.seq + 1
                  }
                  throw rpcError('SEMANTIC_REJECTED', { reason: 'FEEDBACK_READ_LIMIT' })
                },
              }),
            })
          },
        })
      registerFactChain(ep, {
        requireSessionOwner: requireSessionOwner(cx),
        scan: factRead,
        traces: new RequestTraceStore(o.config.dataDir, o.profile.name),
        binding: (key, generationId) => readFactChainBinding(o.profileDir, key, generationId),
        ...(effectivePackageAdmin
          ? {
              candidate: async (
                candidateId: string,
                context: import('@agnes/daemon-foundation/local/endpoint').CallContext,
              ) =>
                (await effectivePackageAdmin!.service.candidateEvidence?.(
                  o.profile.name,
                  candidateId,
                  (transport === 'unix'
                    ? (effectivePackageAdmin!.unixAuthority ?? localPackageAdminAuthority())
                    : (effectivePackageAdmin!.webAuthority ?? denyPackageAdminAuthority))(context),
                )) as import('@agnes/protocol').AuthoringCandidate,
            }
          : {}),
      })
      registerPromptTrace(ep, {
        authority:
          transport === 'unix'
            ? (effectivePackageAdmin?.unixAuthority ?? localPackageAdminAuthority())
            : denyPackageAdminAuthority,
        readOnly: (context) =>
          configurationReadOnly(async () =>
            effectivePackageAdmin?.service.call(
              '_agnes/v1/packages.list',
              { profile: o.profile.name },
              localPackageAdminAuthority(['packages.read'])(context),
            ),
          ),
        dataDir: o.config.dataDir,
        profile: o.profile.name,
        reviewEnabled: o.profile.approvals.mode === 'auto-review',
        registry: cx.registry,
        requireSessionOwner: requireSessionOwner(cx),
        preview: async (config) => {
          const link = await pool.acquireSharedWorker()
          return (await link.command(
            'systemPrompt.defaults',
            { config },
            { timeoutMs: 31_000 },
          )) as import('@agnes/protocol').SystemPromptSnapshot
        },
      })
      registerDiagnostics(ep, {
        authority:
          transport === 'unix'
            ? (effectivePackageAdmin?.unixAuthority ?? localPackageAdminAuthority())
            : (effectivePackageAdmin?.webAuthority ?? denyPackageAdminAuthority),
        readOnly: (context) =>
          configurationReadOnly(async () =>
            effectivePackageAdmin?.service.call(
              '_agnes/v1/packages.list',
              { profile: o.profile.name },
              localPackageAdminAuthority(['packages.read'])(context),
            ),
          ),
        requireSessionOwner: requireSessionOwner(cx),
        registry: cx.registry,
        sessionSnapshot: (key) => workspaces.metadata(key),
        exporterHealth: async () => {
          const worker = pool.businessWorker()
          if (!worker) return { workerState: 'idle' }
          if (!worker.link.alive) return { workerState: 'unavailable' }
          try {
            return {
              workerState: 'available',
              workerHealth: (await worker.link.command(
                'observability.health',
                {},
                { timeoutMs: 3000 },
              )) as import('@agnes/observability').ObservabilityHealth,
            }
          } catch {
            return { workerState: 'unavailable' }
          }
        },
        dataDir: o.config.dataDir,
        home: o.config.home ?? o.config.dataDir,
        telemetry: () => telemetrySnapshot(o.config.home ?? o.config.dataDir),
        profileHash: o.profile.hash,
        ...(composition
          ? { compositionHash: createHash('sha256').update(JSON.stringify(composition)).digest('hex') }
          : {}),
        generations: async () => {
          const worker = pool.businessWorker()
          return worker?.link.alive
            ? worker.link.command('pluginGenerations.status', {}, { timeoutMs: 3000 })
            : undefined
        },
        doctor: async () =>
          (
            await daemonDoctor({
              dataDir: o.config.dataDir,
              home: ownerHome,
              clock,
              ...(scheduler ? { scheduler } : {}),
            })
          ).sections,
      })
      if (artifactReadConfigured) registerArtifactRead(ep, artifactRead as ArtifactReadRpcOptions)
      if (effectivePackageAdmin)
        registerPackageAdmin(
          ep,
          effectivePackageAdmin.service,
          transport === 'unix'
            ? (effectivePackageAdmin.unixAuthority ?? localPackageAdminAuthority())
            : // The loopback Web listener is authenticated as the local owner and is not an
              // administration channel; it gets the one skin read the workbench needs. A remote WSS
              // listener, and every other non-Unix transport, keeps the deny-by-default grant
              // (design §23.3).
              o.config.localWeb
              ? (effectivePackageAdmin.webAuthority ?? localWebSkinReadAuthority)
              : (effectivePackageAdmin.webAuthority ?? denyPackageAdminAuthority),
        )
      registerSessionSelection(
        ep,
        sessionSelection,
        transport === 'unix'
          ? (effectivePackageAdmin?.unixAuthority ?? localPackageAdminAuthority())
          : (effectivePackageAdmin?.webAuthority ?? denyPackageAdminAuthority),
        {
          async snapshot() {
            const link = await pool.acquireSharedWorker()
            const catalog = (await link.command('session.catalog', {}, { timeoutMs: 31_000 })) as Pick<
              import('@agnes/protocol').RuntimeAdminSnapshot,
              'providers' | 'presets' | 'permissions' | 'publication' | 'bundles' | 'security'
            >
            const localPluginFolders = o.packageRuntime?.manager.localPluginRoots
            if (!localPluginFolders)
              throw rpcError('CAPABILITY_DENIED', { reason: 'local plugin roots unavailable' })
            return {
              providers: catalog.providers,
              presets: catalog.presets,
              ...(catalog.permissions ? { permissions: catalog.permissions } : {}),
              ...(catalog.bundles ? { bundles: catalog.bundles } : {}),
              ...(catalog.security ? { security: catalog.security } : {}),
              localPluginFolders,
              workspaceDeployments: await workspaceDeployments(o.packageRuntime, o.profile.name),
              ...(catalog.publication ? { publication: catalog.publication } : {}),
            }
          },
          async reloadLocal() {
            if (!localPluginWatcher)
              throw rpcError('CAPABILITY_DENIED', { reason: 'local plugin watcher unavailable' })
            await localPluginWatcher.refresh()
          },
        },
      )
      registerResourceControl(
        ep,
        resourceControl.service,
        transport === 'unix'
          ? (resourceControl.unixAuthority ?? localResourceAuthority())
          : (resourceControl.webAuthority ?? denyResourceAuthority),
      )
      registerProfileServices(
        ep,
        profilePorts.services,
        boundWakes,
        activationBarrier,
        requireSessionOwner(cx),
      )
      registerExtensions(ep, {
        activationBarrier,
        journal,
        commandQueue,
        callService: services.callService,
        inspectService: services.inspectService,
        resolveServiceSession: async (sessionId, call) => {
          const userId = call.conn.credential?.userId
          const subjectPrincipal =
            typeof userId === 'string' && userId.length > 0
              ? call.conn.credentialKind === 'jwt'
                ? `jwt:${userId}`
                : call.conn.credentialKind === 'sso'
                  ? `portal:${userId}`
                  : undefined
              : undefined
          let owner: ReturnType<typeof sessionOwnership.resolve>
          try {
            owner = sessionOwnership.resolve(sessionId)
          } catch {
            throw rpcError('CAPABILITY_DENIED')
          }
          if (!subjectPrincipal || !owner || owner.principalId !== subjectPrincipal)
            throw rpcError('CAPABILITY_DENIED')
          let binding: Awaited<ReturnType<typeof workspaceCatalog.restoreBinding>>
          try {
            binding = await workspaceCatalog.restoreBinding(sessionId)
          } catch {
            throw rpcError('INTERNAL_ERROR', { code: 'E_WORKSPACE_REQUIRED', sessionId })
          }
          await supervisorRegistry.open({
            key: sessionId,
            cwd: binding.canonicalRoot,
            binding,
            resume: true,
          })
          return sessionId
        },
      })
      // Lets `agnes serve`'s separate OS process (see runWebCommand) bridge createMountProxy's
      // lookup() across the connection this same endpoint() closure serves; reads the live
      // `surfaceController` set below by the same startup sequence.
      // M4 (final review, Minor): gated the same way `registerPackageAdmin`/`registerResourceControl`
      // above restrict themselves off remote WSS -- this method's only real consumer is the local CLI
      // process bridging the same-machine `agnes serve` process boundary (see
      // `packages/cli/launch/surface-mounts.ts`); a remote WSS client has no legitimate reason to read
      // where a locally-spawned Surface's loopback listener lives.
      if (transport === 'unix') registerSurfaces(ep, { snapshot: () => surfaceController?.snapshot() })
      const entry: Conn = { ep, conn: ep.conn }
      conns.add(entry)
      const onClose = () => {
        conns.delete(entry)
        disposeFeeds(feeds)
      }
      return { ep, onClose }
    }
    const server = await listenUnix(o.config.socketPath, (socket) => {
      const { ep, onClose } = endpoint('unix')
      bindConnection(socket, ep, { onClose })
    })
    startupCleanup.push(() => server.close())
    void server.failed?.then((error) => {
      socketFailure = error
    })
    const health: { failed?: Promise<Error> } = {
      failed: Promise.race(
        [workersServer.failed, server.failed].filter((value): value is Promise<Error> => value !== undefined),
      ),
    }
    const wsToken = o.config.ws || o.config.localWeb ? randomBytes(32).toString('base64url') : undefined
    const wsServer =
      (o.config.ws || o.config.localWeb) && wsToken
        ? await listenWebSocket({
            ...(o.config.localWeb
              ? { addr: o.config.localWeb.addr, localOrigin: o.config.localWeb.origin }
              : (o.config.ws as NonNullable<DaemonConfig['ws']>)),
            token: wsToken,
            endpoint: () => {
              const { ep, onClose } = endpoint('ws')
              return { endpoint: ep, onClose }
            },
          })
        : undefined
    if (wsServer) startupCleanup.push(() => wsServer.close())

    const evictIdleNow = (): number =>
      pool.evictIdle(clock(), (sessionKey) => !!registry.get(sessionKey)?.inflight)
    const retireSharedWorkerNow = (): boolean => pool.retireSharedWorkerNow()
    const evict = setInterval(() => {
      evictIdleNow()
    }, 60_000)
    evict.unref()
    startupCleanup.push(() => clearInterval(evict))
    const stopClaimsGc = persistentClaims ? startClaimsGc(persistentClaims, clock) : undefined
    if (stopClaimsGc) startupCleanup.push(stopClaimsGc)
    scheduler?.start()

    // From this point the returned handle owns every resource. Startup cleanup must not race a
    // successful handle's close path.
    if (socketFailure) throw socketFailure
    startupCleanup.length = 0
    let closePromise: Promise<void> | undefined
    const close = (): Promise<void> =>
      (closePromise ??= shutdownLadder({
        graceMs: o.config.limits.shutdownGraceMs,
        stopAccepting: async () => {
          reclaimIntake = false
          reclaimAbort.abort(new Error('daemon shutdown'))
          stopClientModuleNotices?.()
          stopClientModuleNotices = undefined
          effectivePackageAdmin?.service.closeClientModules()
          clearInterval(evict)
          if (reclaimTimer) clearInterval(reclaimTimer)
          const stopJwks = stopJwksCache
          const watcher = skillWatcher
          sharedKeeper?.close()
          const results = await Promise.allSettled([
            ...(watcher ? [Promise.resolve().then(() => watcher.close())] : []),
            ...(localPluginWatcher ? [localPluginWatcher.close()] : []),
            Promise.resolve().then(() => stopClaimsGc?.()),
            Promise.resolve().then(() => scheduler?.stopIntake()),
            ...[...conns].map(({ ep }) => Promise.resolve().then(() => ep.stopIntake())),
            Promise.resolve().then(() => server.stopAccepting()),
            ...(wsServer ? [Promise.resolve().then(() => wsServer.stopAccepting())] : []),
            ...(stopJwks ? [Promise.resolve().then(() => stopJwks())] : []),
          ])
          const errors = results
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map((result) => result.reason)
          if (errors.length) throw new AggregateError(errors, 'failed to stop daemon intake')
        },
        notify: () => notices.emit('shutting_down', { detail: {} }),
        closeWorkers: async (graceMs, signal) => {
          const errors: unknown[] = []
          // Abort scheduled turns before awaiting either of the earlier drains. If one of those
          // consumes the whole grace period, no scheduler continuation may retain a live heartbeat
          // or settle a row after the shutdown ladder releases the owner lock.
          scheduler?.abortActive()
          const run = async (action: () => void | Promise<void>): Promise<void> => {
            try {
              await action()
            } catch (error) {
              errors.push(error)
            }
          }
          await run(() => commandQueue.close())
          if (signal.aborted) return
          await run(async () => void (await reclaiming))
          if (signal.aborted) return
          await run(() => scheduler?.stop())
          if (signal.aborted) return
          await run(() => registry.closeAll())
          if (signal.aborted) return
          await run(() => pool.closeAll(graceMs))
          if (errors.length) throw new AggregateError(errors, 'failed to close daemon workers')
        },
        killWorkers: () => pool.killAll(),
        closeSockets: async () => {
          await sidebarSessions?.close()
          await triggerSessions.close()
          const results = await Promise.allSettled([
            ...[...conns].map(({ ep }) => Promise.resolve().then(() => ep.close())),
            Promise.resolve().then(() => server.close()),
            ...(wsServer ? [Promise.resolve().then(() => wsServer.close())] : []),
            Promise.resolve().then(() => workersServer.close()),
            // A Surface is a separate OS child process fed by the mount-proxy HTTP forwarder that
            // whichever process owns the browser-facing `createWebServer` listener builds from the
            // mount-proxy RPC path (`packages/cli/launch/surface-mounts.ts`'s `fetchSurfaceMountProxy`,
            // reading `_agnes/v1/surfaces.mounts` -- see `local/methods/surfaces.ts`), never from this
            // file's own `server` (the daemon's private RPC socket) -- not by the worker pool, so it
            // has nothing to drain during closeWorkers. By the time closeSockets runs, stopAccepting
            // has already stopped admitting new browser connections, so it is safe (and symmetric with
            // the daemon's own listeners) to stop it
            // here, alongside them, rather than earlier (during closeWorkers, where the Surface would
            // still be serving established requests routed through workers' service calls) or later
            // (releaseLock, which is about the owner lock and durable turn recovery, not sockets).
            // (Note: this runs concurrently with the other closures in the same Promise.allSettled,
            // not strictly after every in-flight proxied request drains -- the same convention
            // workersServer.close() already uses here; this is a "stop alongside", not a guaranteed
            // ordering of request completion.)
            Promise.resolve().then(() => surfaceController?.stop()),
          ])
          const errors = results
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map((result) => result.reason)
          if (errors.length) throw new AggregateError(errors, 'failed to close daemon sockets')
        },
        releaseLock: async () => {
          // A forced worker exit can begin durable turn recovery after the graceful phase timed
          // out. Fence the runtime only after that recovery settles, then release ownership.
          // Sockets and workers are already stopped, so closing the feedback owner does not cut
          // an in-flight feedback RPC.
          await pool.waitForExitRecovery()
          await feedbackOwner?.close().catch(() => undefined)
          feedbackOwner = undefined
          try {
            dataGuard?.release()
          } finally {
            await lock.release()
          }
        },
        log: (message) => console.error(message),
      }))
    return {
      ...health,
      activationBarrier,
      socketPath: o.config.socketPath,
      owner: { ...lock.owner },
      ...(wsServer && wsToken ? { ws: { url: wsServer.url, token: wsToken } } : {}),
      reclaimNow,
      evictIdleNow,
      retireSharedWorkerNow,
      close,
    }
  } catch (error) {
    await cleanupStartup()
    throw error
  }
}

type SupervisorHandle = Awaited<ReturnType<typeof startSupervisor>>

/**
 * Opens the Host-owned storage used by the real supervisor process and gives jobs an isolated
 * package table store. The core ledger database is opened only because `createSqliteStorage` owns
 * the lifetime of both its core adapter and package stores; no raw SQLite handle crosses into
 * daemon.
 *
 * Package tables remain isolated in `tables('@agnes/daemon')`; crash reclaim receives Host's narrow
 * operation-only port, never a raw core SQLite handle.
 */
export async function startProductionSupervisor(
  o: Omit<StartSupervisorOptions, 'tables' | 'jobTables' | 'artifactAuthorityTable'>,
  deps: {
    createStorage?: typeof createSqliteStorage
    start?: typeof startSupervisor
  } = {},
): Promise<SupervisorHandle> {
  const observability = acquireObservability(o.config.home ?? o.config.dataDir)
  const stopDiagnostics = installDiagnosticJournal(o.config.home ?? o.config.dataDir)
  observability.lifecycle('daemon', 'start')
  o = {
    ...o,
    observability,
  }

  let storage: ReturnType<typeof createSqliteStorage>
  try {
    prepareDaemonSocketPaths(o.config)
    storage = (deps.createStorage ?? createSqliteStorage)({
      file: join(o.config.dataDir, 'sessions.db'),
      tablesDir: join(o.config.dataDir, 'tables'),
      ...(o.clock ? { clock: o.clock } : {}),
    })
  } catch (error) {
    stopDiagnostics()
    await o.packageBytes?.close()
    await observability.dispose()
    throw error
  }
  let supervisor: SupervisorHandle
  try {
    const start = () =>
      (deps.start ?? startSupervisor)({
        ...o,
        jobTables: adaptHostTables(storage.tables('@agnes/daemon')),
        artifactAuthorityTable: adaptHostTables(
          storage.tables('@agnes/daemon/artifact-read-authority'),
        ).table('artifact_read_authority'),
        reclaim: storage.crashReclaim,
        sessionFactRead: o.sessionFactRead ?? ((key) => (query) => storage.scan(key, query)),
      })
    supervisor = await (o.packageBytes ? o.packageBytes.verification.run(start) : start())
  } catch (error) {
    stopDiagnostics()
    await o.packageBytes?.close()
    await observability.dispose()
    try {
      await storage.close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'supervisor startup and storage cleanup failed')
    }
    throw error
  }

  let closePromise: Promise<void> | undefined
  const close = async (): Promise<void> => {
    try {
      let supervisorError: unknown
      try {
        await supervisor.close()
      } catch (error) {
        supervisorError = error
      }
      try {
        await storage.close()
      } catch (storageError) {
        if (supervisorError !== undefined)
          throw new AggregateError([supervisorError, storageError], 'supervisor and storage shutdown failed')
        throw storageError
      }
      if (supervisorError !== undefined) throw supervisorError
    } finally {
      await o.packageBytes?.close()
      observability.lifecycle('daemon', 'stop')
      await observability.dispose()
      stopDiagnostics()
    }
  }
  return {
    ...(supervisor.failed ? { failed: supervisor.failed } : {}),
    activationBarrier: supervisor.activationBarrier,
    socketPath: supervisor.socketPath,
    owner: { ...supervisor.owner },
    ...(supervisor.ws ? { ws: supervisor.ws } : {}),
    reclaimNow: () => supervisor.reclaimNow(),
    evictIdleNow: () => supervisor.evictIdleNow(),
    retireSharedWorkerNow: () => supervisor.retireSharedWorkerNow(),
    close() {
      closePromise ??= close()
      return closePromise
    },
  }
}

/**
 * `agnesd` startup uses Host's shared profile reader and configuration service, builds the daemon
 * config, starts the supervisor, and wires
 * SIGTERM/SIGINT to a graceful `close()`.
 */
export type RunAgnesdDeps = {
  /** Enterprise directory implementations live outside daemon; the executable composition root
   * can fit one here without replacing the supervisor or weakening its credential gate. */
  directory?: DirectoryPort
  startProduction?: typeof startProductionSupervisor
  secrets?: { resolve(ref: string): string }
  localWeb?: { addr: string; origin: string }
  workerExecPath?: string
  workerExecArgv?: string[]
  workerEntry?: string
  resolveScope?: typeof resolveDaemonScope
  resolveProfile?: typeof resolveDaemonProfile
  publishDiscovery?: typeof publishDaemonDiscovery
  removeDiscovery?: typeof removeDaemonDiscovery
  /** Injection seam for enterprise composition. An unconfigured WSS still has no package grant. */
  packageAdmin?: StartSupervisorOptions['packageAdmin']
  resources?: StartSupervisorOptions['resources']
}

/** `runAgnesd` accepts a partial argument object so embedded launchers can rely on scope defaults. */
export type RunAgnesdArgs = Partial<Args>

/** Where a `kind: 'file'` secrets adapter reads. A profile path wins. Otherwise the directory is
 * the credential store's `<home>/secrets`, and a store left under `<dataDir>/secrets` is moved there. */
function secretsDirectory(profile: ResolvedProfile, config: DaemonConfig): string {
  return resolveFileSecretsDirectory({
    path: profile.adapters.secrets.path,
    dataDir: config.dataDir,
    ...(config.home !== undefined ? { home: config.home } : {}),
  })
}

export async function runAgnesd(args: RunAgnesdArgs = {}, deps: RunAgnesdDeps = {}): Promise<void> {
  const platform = createPlatform().snapshot()
  const scope = await (deps.resolveScope ?? resolveDaemonScope)({
    env: process.env,
    ...(platform.os === 'win32' ? { initializeHome: true } : {}),
    ...(args.home !== undefined ? { home: args.home } : {}),
    ...(args.profile !== undefined ? { profile: args.profile } : {}),
    ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
    ...(args.dataDir !== undefined ? { dataDir: args.dataDir } : {}),
  })
  if (!deps.resolveScope) {
    if (platform.os === 'win32')
      await initializeHomeLocked(scope.home, scope.profile, { dataDir: scope.dataDir })
    else initializeHome(scope.home, scope.profile)
  }
  const resolver = deps.resolveProfile ?? resolveDaemonProfile
  const loadProfile = async (
    options: Parameters<typeof resolveDaemonProfile>[1] = {},
  ): Promise<Awaited<ReturnType<typeof resolveDaemonProfile>>> => {
    try {
      return await resolver(scope, options)
    } catch (error) {
      // Preserve a corrupt package lock as recovery evidence. Host can still resolve the configured
      // profile with an empty lock overlay; PackageManager remains the authoritative lock reader and
      // exposes the profile as read-only rather than replacing its bytes during boot.
      if (!(error instanceof HostError) || error.code !== 'E_LOCK_MISMATCH') throw error
      return await resolveDaemonProfile(scope, { ...options, ignorePackageLock: true })
    }
  }
  const loaded = await loadProfile()
  const { profile, configuration } = loaded
  const reloadProfile = async (adminBundles?: readonly string[]): Promise<ResolvedProfile> => {
    return (await loadProfile({ configuration, ...(adminBundles !== undefined ? { adminBundles } : {}) }))
      .profile
  }
  // `buildConfig`'s own doc comment: the OS/transport shape comes from the caller, which already went
  // through host's platform adapter above - never a raw runtime OS check of this package's own.
  const ipc: 'unix' | 'pipe' = platform.os === 'win32' ? 'pipe' : 'unix'
  const config = buildConfig({
    args: { profile: scope.profile, ...args, dataDir: scope.dataDir },
    profile,
    home: scope.home,
    ipc,
  })
  prepareDaemonSocketPaths(config)
  const localWeb =
    deps.localWeb ??
    (args.localWebAddr !== undefined || args.localWebOrigin !== undefined
      ? { addr: args.localWebAddr ?? '127.0.0.1:0', origin: args.localWebOrigin ?? '' }
      : undefined)
  if (localWeb) {
    if (!localWeb.addr || !localWeb.origin)
      throw new Error('local Web requires both address and exact origin')
    config.localWeb = localWeb
    delete config.ws
  }
  let remoteAuth: StartSupervisorOptions['remoteAuth']
  if (config.ws) {
    const resolver =
      deps.secrets ??
      (profile.adapters.secrets.kind === 'file'
        ? composeSecrets(
            createSecretsFile({
              dir: secretsDirectory(profile, config),
            }),
            createSecretsEnv(),
          )
        : createSecretsEnv())
    config.ws = { ...config.ws, cert: resolver.resolve(config.ws.cert), key: resolver.resolve(config.ws.key) }
    const transportAuth = profile.transports.find((transport) => transport.kind === 'ws-tls')?.auth
    const sourceAuthCredentials = transportAuth?.sourceAuthSecrets?.map((credentialId) => ({
      credentialId,
      secret: resolver.resolve(credentialId),
    }))
    const jwt = transportAuth?.jwt
    if (sourceAuthCredentials?.length || (jwt?.issuer && (jwt.secret || jwt.jwks))) {
      remoteAuth = {
        ...(sourceAuthCredentials?.length ? { sourceAuthCredentials } : {}),
        ...(transportAuth?.rotationGraceMs !== undefined
          ? { rotationGraceMs: transportAuth.rotationGraceMs }
          : {}),
        ...(jwt?.issuer && (jwt.secret || jwt.jwks)
          ? {
              jwt: {
                issuer: jwt.issuer,
                ...(jwt.secret ? { secret: resolver.resolve(jwt.secret) } : {}),
                ...(jwt.jwks ? { jwksUrl: jwt.jwks } : {}),
              },
            }
          : {}),
      }
    }
  }
  // PackageManager is the only lockfile writer. Establish the scoped directory first, then stamp
  // the already-resolved Host profile through its public bootstrap API. A damaged existing lock is
  // deliberately left in place: PackageAdmin reads expose its safe failure and the BFF enters
  // recovery/read-only mode instead of daemon startup replacing forensic state with a new lock.
  const packageProfileDirectory = scopedPackageProfileDirectory({
    profile: scope.profile,
    profileDir: scope.profileDir,
    profilesRoot: join(scope.home, 'profiles'),
  })
  const checkedProfileDir = await packageProfileDirectory(scope.profile)
  if (platform.os === 'win32') {
    for (const directory of [scope.home, scope.dataDir, join(scope.home, 'profiles'), checkedProfileDir])
      if (!hasPrivateDaclSync(directory))
        throw Object.assign(new Error('E_HOME_UNSAFE'), { code: 'E_HOME_UNSAFE' })
  } else await mkdir(checkedProfileDir, { recursive: true, mode: 0o700 })
  const profileDir = await packageProfileDirectory(scope.profile)
  const packageBytes = new DaemonPluginByteVerification(profileDir, scope.dataDir, scope.profile)
  try {
    let runtimeReferenceReader: PackageReferenceFactReader | undefined
    const packageManager = createPackageManager({
      byteVerification: packageBytes.verification,
      dataDir: scope.dataDir,
      agnesVersion: PACKAGE_MANAGER_VERSION,
      cwd: scope.workspace,
      localPlugins: localPluginRoots(scope.home, scope.workspace),
      sourceAdapters: [pluginProposalSourceAdapter(join(scope.dataDir, 'resource-control'))],
      references: createPackageReferences((input) => {
        if (!runtimeReferenceReader)
          throw new PackageError('E_EXT_LOAD', 'runtime reference authority is unavailable')
        return runtimeReferenceReader(input)
      }),
    })
    try {
      const initializePolicy = () => snapshotPolicy(profileDir, profile, '0.0.0')
      if (deps.packageAdmin) await initializePolicy()
      else await initializeDefaultHelpers({ profileDir, manager: packageManager, initializePolicy })
    } catch (error) {
      // Helper inventory can encounter the same damaged lock before policy initialization.
      // Keep the recovery-only admin surface available; never replace or trust the damaged state.
      if (!(error instanceof PackageError) || error.legacyCode !== 'E_LOCK_MISMATCH') throw error
    }
    let packageActivation: PackageActivationAdapter | undefined
    const deferredActivation = deferPackageActivation(() => packageActivation)
    // Mirrors deferredActivation above: defaultPackageAdmin.service is constructed synchronously,
    // before startProductionSupervisor awaits runtime.initialize() and calls bindRuntimePins with the
    // real adapter, so the Service instance needs a stable object that reads the closure variable
    // lazily at call time rather than the (still-undefined) value captured at construction.
    let packageRuntimePins: RuntimePinsAdapter | undefined
    let packagePluginTree: CompositeTargetStore | undefined
    let packageAgentResolver:
      | ((profile: string, ref: string) => Promise<import('@agnes/protocol').AgentPlan>)
      | undefined
    let packageWorkerGeneration: (() => number | undefined) | undefined
    let packagePluginTreePublisher:
      | ((artifact: RuntimeTargetArtifact, liveConfig?: boolean) => Promise<void>)
      | undefined
    let packageClientServiceCall:
      | ((
          input: ClientModuleServiceCallParams & Readonly<{ packageId: string; extension: string }>,
        ) => Promise<ExtensionCallResult>)
      | undefined
    let packageClientEffectCall:
      | ((
          input: ClientModuleEffectCallParams & Readonly<{ packageId: string; extension: string }>,
          authority: PackageAdminAuthority,
        ) => Promise<ExtensionCallResult>)
      | undefined
    const deferredPins = deferredRuntimePins(() => packageRuntimePins)
    const packageOperations = new FilePackageOperationStore(join(scope.daemonDir, 'package-operations'))
    const localExamplesCatalog = await discoverLocalExamples(scope.workspace)
    // An explicitly injected resource service owns its own durable recovery; the default store
    // is recovered only after its service-worker adapters are installed in startSupervisor.
    const resourceService = deps.resources?.service
    if (resourceService) await resourceService.recover()
    const defaultPackageAdmin = {
      service: createPackageAdminService({
        resolveAgent: async (profile, ref) => {
          if (!packageAgentResolver) throw rpcError('CAPABILITY_DENIED')
          return packageAgentResolver(profile, ref)
        },
        authoringHome: scope.home,
        manager: packageManager,
        profileDirectory: packageProfileDirectory,
        operations: packageOperations,
        ...(localExamplesCatalog ? { catalog: localExamplesCatalog } : {}),
        activation: deferredActivation,
        runtimePins: deferredPins,
        pluginTree: () => packagePluginTree,
        pluginTreePublisher: async (artifact, liveConfig) => {
          const publish = packagePluginTreePublisher
          if (!publish) throw new Error('E_PACKAGE_STATE: runtime target publisher is unavailable')
          await publish(artifact, liveConfig)
        },
        workerGeneration: () => packageWorkerGeneration?.(),
        clientServiceCall: async (input) => {
          if (!packageClientServiceCall) throw rpcError('CAPABILITY_DENIED')
          return await packageClientServiceCall(input)
        },
        clientEffectCall: async (input, authority) => {
          if (!packageClientEffectCall) throw rpcError('CAPABILITY_DENIED')
          return await packageClientEffectCall(input, authority)
        },
        clientModules: createClientModuleRegistry({
          composition: () =>
            profile.composition
              ? resolveComposition(profile, {
                  preset: compositionPreset(profile, profile.presets.default),
                }).selection
              : undefined,
          snapshotDirectory: (profileName) => join(scope.daemonDir, 'client-modules', profileName),
          runtimeArtifacts: () => runtimeArtifactsFromStore(packagePluginTree, packageWorkerGeneration?.()),
        }),
      }),
    }

    const { record: audit, close: flushAudit } = openDaemonLogs(scope.dataDir)
    const sup = await (deps.startProduction ?? startProductionSupervisor)({
      packageBytes,
      audit,
      config,
      profile,
      profileDir: scope.profileDir,
      profileFile: scope.profileFile,
      workspaceRoot: scope.workspace,
      configuration,
      reloadProfile,
      ...(deps.workerExecPath ? { workerExecPath: deps.workerExecPath } : {}),
      ...(deps.workerExecArgv ? { workerExecArgv: deps.workerExecArgv } : {}),
      ...(deps.workerEntry ? { workerEntry: deps.workerEntry } : {}),
      ...(remoteAuth ? { remoteAuth } : {}),
      ...(deps.directory ? { ports: { directory: deps.directory } } : {}),
      packageAdmin: deps.packageAdmin ?? defaultPackageAdmin,
      ...(deps.resources ? { resources: deps.resources } : {}),
      ...(!deps.packageAdmin
        ? {
            packageRuntime: {
              manager: packageManager,
              profileDirectory: packageProfileDirectory,
              operations: packageOperations,
              stateDirectory: join(scope.daemonDir, 'package-activation'),
              ...(localExamplesCatalog ? { catalog: localExamplesCatalog } : {}),
              bindAgentResolver(resolve) {
                packageAgentResolver = resolve
              },
              bindReferences(reader: PackageReferenceFactReader) {
                runtimeReferenceReader = reader
              },
              bindActivation(adapter: PackageActivationAdapter) {
                packageActivation = adapter
              },
              bindRuntimePins(adapter: RuntimePinsAdapter) {
                packageRuntimePins = adapter
              },
              bindPluginTree(store, workerGeneration, publish) {
                packagePluginTree = store
                packageWorkerGeneration = workerGeneration
                packagePluginTreePublisher = publish
              },
              bindClientService(dispatcher) {
                packageClientServiceCall = dispatcher
              },
              bindClientEffect(dispatcher) {
                packageClientEffectCall = dispatcher
              },
            },
          }
        : {}),
    }).catch(async (error) => {
      await closeWithAudit(async () => {
        throw error
      }, flushAudit)
      throw error
    })
    let socketFailure: Error | undefined
    void sup.failed?.then((error) => {
      socketFailure = error
    })
    try {
      await (deps.publishDiscovery ?? publishDaemonDiscovery)(scope, {
        owner: sup.owner,
        socketPath: sup.socketPath,
        profileHash: profile.hash,
        ...(localWeb && sup.ws ? { web: { ...sup.ws, origin: localWeb.origin } } : {}),
      })
      if (socketFailure) throw socketFailure
    } catch (error) {
      await (deps.removeDiscovery ?? removeDaemonDiscovery)(scope, sup.owner.generation).catch(
        () => undefined,
      )
      await closeWithAudit(async () => {
        try {
          await sup.close()
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'daemon discovery and cleanup failed')
        }
        throw error
      }, flushAudit)
      throw error
    }
    let closing: Promise<void> | undefined
    let stopWatching = () => {}
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        stopWatching()
        // Remove the generation-bound descriptor while the supervisor still owns its lock. A new
        // daemon can therefore never be erased by cleanup from an older process.
        await (deps.removeDiscovery ?? removeDaemonDiscovery)(scope, sup.owner.generation).catch(
          () => undefined,
        )
        await closeWithAudit(() => sup.close(), flushAudit)
      })())
    installSignals(close)
    void sup.failed?.then(() => {
      console.error('agnesd local listener failed; shutting down')
      void close().then(
        () => process.exit(1),
        () => process.exit(1),
      )
    })
    stopWatching = installWindowsStopRequest(scope.home, sup.owner, close)
    console.error(`agnesd listening on ${sup.socketPath}`)
    if (sup.ws)
      console.error(`agnesd WebSocket listening on ${sup.ws.url}; bearer token available to launcher`)
  } catch (error) {
    await packageBytes.close()
    throw error
  }
}
