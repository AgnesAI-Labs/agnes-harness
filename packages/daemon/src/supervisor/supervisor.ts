import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ActivationInProgressError,
  type ConfigurationService,
  composeSecrets,
  createExtensionActivationBarrier,
  createFileAudit,
  createPlatform,
  createSecretsEnv,
  createSecretsFile,
  createSqliteStorage,
  defaultProcessIdentity,
  type ExtensionActivationBarrier,
  type Host,
  HostError,
  type HostSession,
  type TableStore as HostTableStore,
  type PresetDoc,
  type ProcessIdentity,
  type ResolvedPreset,
  type ResolvedProfile,
  resolveWorkspaceDirectory,
  sessionsDbPath,
} from '@agnes/host'
import {
  activeRuntimePinId,
  createPackageManager,
  isRuntimePackageEligible,
  type LocalExamplesCatalog,
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
  rpcError,
} from '@agnes/protocol'
import {
  deploymentMcpPolicy,
  installResourceServiceAdapters,
  writePackageSkillInventory,
} from '@agnes/resource-control-daemon'
import { type ActivationLinkPool, notifyLiveSessionWorkers } from '@agnes/resource-control-runtime'
import { renameWriteThrough, windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import { rebuildDesiredFromInventory, reconcileDesiredWebRows } from '../composite-desired.js'
import { CompositeRuntimeDelivery, deliverDesiredToWorkers } from '../composite-runtime-delivery.js'
import {
  createCompositeReferenceFacts,
  createCompositeRuntimePins,
  createCompositeTargetActivation,
} from '../composite-target-activation.js'
import { createTargetReverter } from '../composite-target-revert.js'
import { type Args, buildConfig, type DaemonConfig } from '../config.js'
import { deferPackageActivation } from '../deferred-package-activation.js'
import { JobsRepo } from '../jobs/repo.js'
import { Scheduler } from '../jobs/scheduler.js'
import { JobsService } from '../jobs/service.js'
import {
  type ReclaimRecord,
  type ReclaimStore,
  type ResumeReport,
  reclaimExpired,
  tableReclaimStore,
} from '../lease/reclaim.js'
import { PersistentArtifactReadAuthorityIndex } from '../local/artifact-read-authority.js'
import type { AttachedFeed } from '../local/attached.js'
import type { AuthConfig } from '../local/auth.js'
import { CommandQueue } from '../local/command-queue.js'
import type { LockedPackageMutationStatusSource } from '../local/computer-use-control.js'
import { type ConnectionState, LocalEndpoint } from '../local/endpoint.js'
import { disposeFeeds, type Feed, registerAcp } from '../local/methods/acp.js'
import {
  type AgnesContext,
  indexApprovalTicket,
  registerAgnes,
  requireSessionOwner,
} from '../local/methods/agnes.js'
import { type ArtifactReadRpcOptions, registerArtifactRead } from '../local/methods/artifacts.js'
import { registerConfiguration } from '../local/methods/config.js'
import { registerDiagnostics } from '../local/methods/diagnostics.js'
import { executeJournaledEffect, registerExtensions } from '../local/methods/extensions.js'
import { registerSessionPreferences } from '../local/methods/session-preferences.js'
import { registerSurfaces } from '../local/methods/surfaces.js'
import { registerWorkspaces } from '../local/methods/workspaces.js'
import { NoticeSink } from '../local/notice.js'
import {
  type ClaimStore,
  type CommandJournal,
  type DirectoryPort,
  type JobsPort,
  MemoryClaims,
  MemoryJournal,
  type SessionLister,
  type SessionMetaRow,
} from '../local/ports.js'
import { type ApprovalRequest, PrompterRouter } from '../local/prompter.js'
import type { SessionEntry } from '../local/sessions.js'
import type { Disposer } from '../local/tail.js'
import { runningPackageIdentity } from '../package-actual-identity.js'
import { activateDefaultHelpers, initializeDefaultHelpers } from '../packages/default-helpers.js'
import {
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
  runtimeArtifactsFromStore,
  scopedPackageProfileDirectory,
} from '../packages/index.js'
import { discoverLocalExamples } from '../packages/local-examples.js'
import { pluginProposalSourceAdapter } from '../packages/plugin-source.js'
import type { PreviewSnapshotEntry, PreviewUpdate, Registry } from '../registry.js'
import {
  createResourceControlService,
  createResourceControlStore,
  denyResourceAuthority,
  localResourceAuthority,
  type ResourceAuthorityResolver,
  type ResourceControlService,
  registerResourceControl,
} from '../resources/index.js'
import { createRuntimePinCoordinator } from '../runtime-pin-coordinator.js'
import { publishProbedRuntimeTarget } from '../runtime-target-publisher.js'
import { NonceTable, startClaimsGc, TableClaims } from '../storage/claims-table.js'
import { PersistentCommandJournal } from '../storage/command-journal.js'
import { CompositeTargetStore } from '../storage/composite-target-store.js'
import type { SessionWorkspacePort, TicketPort } from '../storage/lister.js'
import {
  MemorySessionWorkspaces,
  SessionWorkspaceIndex,
  StorageLister,
  TicketIndex,
} from '../storage/lister.js'
import {
  MemorySessionPrincipalOwnership,
  SessionPrincipalOwnershipIndex,
} from '../storage/session-ownership.js'
import { SessionPreferencesStore, withSessionPreferences } from '../storage/session-preferences.js'
import { type SourceAuthCredential, SourceAuthRotation } from '../storage/source-auth-rotation.js'
import type { TableHandle, Tables } from '../storage/table.js'
import {
  MemoryWorkspaceBindings,
  MemoryWorkspaceStore,
  type WorkspaceBindingEnvelope,
  WorkspaceBindingIndex,
  WorkspaceCatalog,
  WorkspaceIndex,
  workspaceIdFor,
} from '../storage/workspaces.js'
import { createSurfaceArtifactResolver } from '../surfaces/artifact-resolver.js'
import { coordinateSurfacesOnBoot } from '../surfaces/boot-coordination.js'
import { createSurfaceController } from '../surfaces/controller.js'
import { createSurfaceSecretResolver } from '../surfaces/secret-resolver.js'
import type { SurfaceController } from '../surfaces/types.js'
import {
  artifactMediaReadReply,
  composeDefaultProductionProjectedArtifactRead,
  composeProductionArtifactRead,
  composeProductionProjectedArtifactRead,
  type ProductionArtifactAuthorityProjection,
  type ProductionArtifactReadAuthority,
} from './artifact-read.js'
import { startChildMaintenance } from './child-maintenance.js'
import { configurationApplication } from './configuration.js'
import { bindConnection } from './connection.js'
import { publishDaemonDiscovery, removeDaemonDiscovery } from './discovery.js'
import { type JwksResolver, type JwksTransport, startJwksCache } from './jwks-cache.js'
import { closeWithAudit, installSignals, shutdownLadder } from './lifecycle.js'
import { createMcpManageRequests } from './mcp-manage-requests.js'
import { acquireOwnerLock } from './owner-lock.js'
import { createPluginManageRequests } from './plugin-manage-requests.js'
import { type RemoteEntry, WorkerRegistry } from './registry.js'
import { createRuntimeTargetProbeLauncher, spawnRuntimeTargetProbeWorker } from './runtime-target-probe.js'
import { resolveDaemonProfile, resolveDaemonScope } from './scope.js'
import {
  workerComputerUseStatusSource,
  workerServiceCaller,
  workerServiceInspector,
} from './service-worker.js'
import { keepSharedWorker, type SharedWorkerKeeper } from './shared-keeper.js'
import { createSkillInstallRequests } from './skill-install-requests.js'
import { type SkillWatcher, startSkillWatcher } from './skill-watcher.js'
import { listenUnix } from './socket.js'
import { prepareDaemonSocketPaths } from './socket-paths.js'
import { watchWindowsStopRequest } from './stop-request.js'
import { WorkerPool } from './worker-pool.js'
import { listenWebSocket } from './ws.js'

/**
 * Bridges `WorkerRegistry` (`Registry<RemoteEntry>`) onto the concrete `Registry<SessionEntry>`
 * shape `registerAcp`/`registerAgnes` are typed against (`LocalContext.registry`).
 *
 * `registry.test.ts` (daemon Task 17) spells out exactly why this is not a free assignment: a
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
 * `supervisor-e2e.test.ts`.
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
    // at compile time; supervisor-e2e.test.ts is what actually proves the subset in use today is
    // covered, and reverse-verification in this task's report deliberately breaks this line once to
    // confirm the test would catch a regression here.
    this.session = e.session as unknown as HostSession
    this.generation = e.generation
    this.tail = e.tail
    this.listeners = e.listeners
    this.ac = e.ac
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

export class SupervisorRegistry implements Registry<SessionEntry> {
  private readonly opening = new Map<
    string,
    { cwd: string; preset: string | null; promise: Promise<SessionEntry> }
  >()

  constructor(
    private readonly inner: WorkerRegistry,
    private readonly workspaces: SessionWorkspacePort,
  ) {}
  async open(o: {
    key?: string
    cwd: string
    binding?: WorkspaceBindingEnvelope
    preset?: string
    credential?: unknown
    resume?: boolean
  }): Promise<SessionEntry> {
    if (o.key) {
      const pending = this.opening.get(o.key)
      if (pending) {
        if (pending.cwd !== o.cwd || pending.preset !== (o.preset ?? null))
          throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: o.key })
        return pending.promise
      }
      const promise = this.openFresh(o)
      this.opening.set(o.key, { cwd: o.cwd, preset: o.preset ?? null, promise })
      try {
        return await promise
      } finally {
        if (this.opening.get(o.key)?.promise === promise) this.opening.delete(o.key)
      }
    }
    return this.openFresh(o)
  }

  private async openFresh(o: {
    key?: string
    cwd: string
    binding?: WorkspaceBindingEnvelope
    preset?: string
    credential?: unknown
    resume?: boolean
  }): Promise<SessionEntry> {
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
  status(key: string, cwd?: string): Promise<{ lastSeq: number; preset: string | null }> {
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

/**
 * A `Host`-shaped facade for the per-connection `AgnesContext.host` field: the supervisor process
 * holds no kernel at all ("supervisor 不持内核" - the daemon design's own name for this split), so
 * there is no real `Assembled` route/preset table to build a genuine `Host` from without also
 * assembling one (which is exactly what a worker process is for). Grepping every `cx.host.` access
 * in `local/methods/acp.ts` and `local/methods/agnes.ts` shows the RPC handlers only ever touch
 * `.profile` and `.validatePresetSwitch` / `.validateModelSwitch` - `.kernel`, `.provider`,
 * `.createSession` etc. are never read on this path (session lifecycle goes through
 * `SupervisorRegistry` / `WorkerRegistry` / `WorkerPool` instead), so those are stubbed to fail
 * loudly rather than silently if some future change ever reaches them.
 */
export function supervisorHostFacade(
  initial: ResolvedProfile,
  activationBarrier: ExtensionActivationBarrier,
  pool: Pick<WorkerPool, 'acquireSharedWorker'>,
): {
  host: Host
  update(profile: ResolvedProfile): void
} {
  let profile = initial
  const facade = {
    activationBarrier,
    get profile() {
      return profile
    },
    get kernel(): never {
      throw new Error('supervisor host facade: kernel is not available (the supervisor holds no kernel)')
    },
    get provider(): never {
      throw new Error('supervisor host facade: provider is not available (the supervisor holds no kernel)')
    },
    providerFingerprint: null,
    runtimes: [] as ResolvedProfile['runtimes'],
    computerUse: initial.computerUse.enabled ? workerComputerUseStatusSource(pool, () => profile) : undefined,
    presets: {} as Record<string, PresetDoc>,
    createSession(): Promise<HostSession> {
      throw new Error(
        'supervisor host facade: createSession is not available - session lifecycle goes through ' +
          'SupervisorRegistry/WorkerRegistry, never cx.host directly',
      )
    },
    extensions: () => [],
    async close() {
      // No-op: this facade owns no resources of its own to release.
    },
    /**
     * Best-effort, profile-only check: the supervisor has the raw `ResolvedProfile` but no assembled
     * preset table, so this can only check `presets.allowed` (the same check `session/new` already
     * makes directly against `cx.host.profile`), not a preset's hard requirements or its real
     * resolved view. That is not a gap in enforcement: `worker/commands.ts`'s own `setPreset` case
     * calls the REAL host's `validatePresetSwitch` again, with the real assembled route table,
     * before ever calling `session.setPreset()` - this daemon-side check is a fast, friendly
     * rejection, not the security boundary. `resolved.view` is deliberately just the preset NAME
     * (not a real `PresetView`): `RemoteSession.setPreset` forwards it as the wire's `preset` field
     * verbatim, and the worker re-derives the real view from that name itself.
     */
    validatePresetSwitch(name: string): ResolvedPreset {
      if (!profile.presets.allowed.includes(name))
        throw new HostError('E_PRESET_UNSUPPORTED', `preset ${name} is not in presets.allowed`, {
          detail: { preset: name },
        })
      return { view: name, doc: {} as PresetDoc, chain: [], hash: '' } as unknown as ResolvedPreset
    },
    /** The supervisor checks the sealed declaration before forwarding. The worker repeats the full
     * assembled-provider check (including the published catalogue), so this is not the final gate. */
    validateModelSwitch(sel: { route: string; model: string }): void {
      const route = profile.provider.routes?.find((candidate) => candidate.route === sel.route)
      const modelDeclared =
        route?.models === undefined || route.models.some((model) => model.id === sel.model)
      // Route and model go in `detail` only: an account route (`account-acct-<uuid>`) in the message
      // trips HostError's leak check, and the code-less error it throws instead reaches the client
      // as INTERNAL rather than PRESET_SWITCH_REJECTED.
      if (!route || !modelDeclared)
        throw new HostError('E_MODEL_UNSUPPORTED', 'the requested model is not declared', {
          detail: { route: sel.route, model: sel.model },
        })
    },
  }
  return {
    host: facade as unknown as Host,
    update(next: ResolvedProfile) {
      profile = next
    },
  }
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Decodes the `[activity, key]` keyset position this lister issued for the previous page. */
function recencyCursor(cursor: string | undefined): { at: string; key: string } | undefined {
  if (cursor === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(cursor)
  } catch {
    value = undefined
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    typeof value[1] !== 'string'
  )
    throw rpcError('INVALID_PARAMS', { reason: 'session list cursor is malformed' })
  return { at: value[0], key: value[1] }
}

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
        let state = projected
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

/** Atomically replace the default profile consumed by workers acquired after activation. */
async function persistResolvedProfile(file: string, profile: ResolvedProfile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    const windows = createPlatform().os === 'win32'
    await writeFile(temporary, JSON.stringify(profile), { mode: 0o600, ...(windows ? { flush: true } : {}) })
    if (windows) await renameWriteThrough(temporary, file)
    else await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export type StartSupervisorOptions = {
  config: DaemonConfig
  profile: ResolvedProfile
  /** `join(home, 'profiles', profile.name)`. Not derivable from `profile.dataDir`: a profile's
   * home and its dataDir are configured independently and are not the same directory in general. */
  profileDir: string
  profileFile: string
  /** One daemon scope owns one canonical workspace skill root. Session cwd may vary, but profile
   * resource control never silently scans the daemon process cwd. */
  workspaceRoot?: string
  /** Optional local configuration authority; activation updates only future worker defaults. */
  configuration?: ConfigurationService
  reloadProfile?: () => Promise<ResolvedProfile>
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
      publish?: (artifact: import('@agnes/plugin-runtime/host').RuntimeTargetArtifact) => Promise<void>,
    ): void
  }
}

// No existing constant in the codebase carries these today (checked: no `harnessVersion`/
// `surfaceApiVersion` producer outside the deploy-policy consumers themselves, and the package
// `agnesVersion: '0.0.0'` used elsewhere for PackageManager construction would NOT satisfy the
// example deploy manifest's `harnessRange: "^0.1"` -- `^0.1` excludes `0.0.0`). These match the
// values every existing Surface fixture (Task 2/3/6's own tests, the removed demo-surface example)
// already assumes; promoting them to a real release-version source is out of this task's scope.
const DAEMON_HARNESS_VERSION = '0.1.0'
const DAEMON_SURFACE_API_VERSION = '1.0.0'

type Conn = { ep: LocalEndpoint; conn: ConnectionState }

/** Index a parked ticket with its worker workspace before publishing the same row to subscribers. */
export function deliverWorkerEvent(
  registry: Pick<WorkerRegistry, 'get' | 'deliver'>,
  tickets: TicketPort | undefined,
  clock: () => number,
  sessionKey: string,
  event: EventEnvelope,
  workspaces?: Pick<SessionWorkspacePort, 'observe'>,
): void | Promise<void> {
  const publish = () => {
    workspaces?.observe(sessionKey, event, registry.get(sessionKey)?.generation)
    if (tickets) {
      tickets.gc(clock())
      indexApprovalTicket(tickets, sessionKey, event, registry.get(sessionKey)?.session.cwd)
    }
  }
  const indexBeforePublish = () => {
    publish()
  }
  return registry.deliver(sessionKey, event, indexBeforePublish)
}

/**
 * Wires the daemon's one hook for "a resource-control mutation durably committed"
 * (`ResourceControlStore.setSuccessfulSnapshotHandler`, called only after a successful effect's
 * latest worker snapshot and terminal operation commit - resource-control-store/src/control-store.ts)
 * to the resource-live-reload plan's lightweight in-place notice, with a narrow heavyweight fallback:
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
 *    notice delivered successfully is left alone - Task 7's investigation (task-7-report.md) found
 *    that unconditionally retiring it too (the pre-existing `registry.retireForResourceSnapshot()`,
 *    2026-09-14, predates this plan) provides no coverage the lightweight path lacks and only pays an
 *    unnecessary process kill/respawn + MCP reconnect cost. `retireForResourceSnapshot()` itself is
 *    unchanged and still available as a general "retire every live session" capability; this handler
 *    simply no longer calls it.
 *
 * This is where resource-control-runtime's manager-level `apply`/`activate` callbacks were originally
 * meant to send this notice (per the plan's own spec and Task 5's brief) - they cannot: `apply` runs
 * inside whichever worker process is bootstrapping (packages/resource-control-worker/src/
 * runtime-bootstrap.ts), including the resource-lifecycle worker itself, with no in-memory reference
 * to this daemon's WorkerPool. This function is the real "a resource actually changed" chokepoint that
 * *does* have one - see task-5-report.md for the full investigation.
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
 * worker unix sockets, per-connection RPC wiring, idle-worker reclaim. Mirrors daemon 稿 §14's
 * startup sequence (main lock → workers listener → client listener → per-connection wiring → idle
 * timer → ready), grounded against the real Task 13-17/29/30 files rather than this plan file's own
 * (stale) sample code - see this task's report for the itemized deviations.
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
  prepareDaemonSocketPaths(o.config)
  if (o.config.ws && o.config.localWeb) throw new Error('choose local Web or remote WSS')
  const clock = o.clock ?? (() => Date.now())

  // Single-owner lock first: everything below allocates real resources (sockets, a worker pool), and
  // a second `agnesd` against the same dataDir must fail before any of that exists, not after.
  const lock = await acquireOwnerLock(o.config.dataDir, {
    socketPath: o.config.socketPath,
    processIdentity: o.processIdentity ?? defaultProcessIdentity,
  })
  let stopJwksCache: (() => Promise<void>) | undefined
  let skillWatcher: SkillWatcher | undefined
  let sharedKeeper: SharedWorkerKeeper | undefined
  let workerPool: WorkerPool | undefined
  // Hoisted (rather than block-scoped inside `if (o.packageRuntime)`) so the real graceful-shutdown
  // ladder below (`closeSockets`) can reach it -- `startupCleanup` alone does NOT cover that path (see
  // its own comment at `startupCleanup.length = 0`: it is wiped the moment startup succeeds and only
  // ever fires on a startup abort, never on a later `close()`).
  let surfaceController: SurfaceController | undefined
  const startupCleanup: Array<() => void | Promise<void>> = []
  const cleanupStartup = async (): Promise<void> => {
    for (const cleanup of startupCleanup.reverse()) {
      try {
        await cleanup()
      } catch {
        // Preserve the startup error; every remaining cleanup still gets its turn.
      }
    }
    await workerPool?.waitForExitRecovery().catch(() => undefined)
    await lock.release().catch(() => undefined)
  }
  try {
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
    await writePackageSkillInventory(o.profile, o.profileDir, packageSkillSnapshotPath)
    const activationBarrier = o.activationBarrier ?? createExtensionActivationBarrier()
    const commandQueue = new CommandQueue()
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
                maxArtifactBytes: o.profile.computerUse?.capture.maxBytesPerImage ?? 4 * 1024 * 1024,
                maxResponseBytes: o.profile.computerUse?.capture.maxBytesPerImage ?? 4 * 1024 * 1024,
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
    const workspaceCatalog = new WorkspaceCatalog(
      jobTables ? new WorkspaceIndex(jobTables.table('workspace_registry')) : new MemoryWorkspaceStore(),
      workspaces,
      resolveWorkspaceDirectory,
      clock,
      jobTables
        ? new WorkspaceBindingIndex(jobTables.table('workspace_bindings'))
        : new MemoryWorkspaceBindings(),
    )
    workspaceCatalogRef = workspaceCatalog
    // The CLI/launcher supplied startup root is one of D44's two authority sources. Register it
    // once before resource-control resolves its default workspace; ambient cwd never grants this.
    if (o.workspaceRoot) await workspaceCatalog.add(o.workspaceRoot)
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
    let revertFailedDesired: (() => Promise<void>) | undefined
    const runtimeDelivery = runtimeStore
      ? new CompositeRuntimeDelivery(runtimeStore, { onFailureRecorded: () => revertFailedDesired?.() })
      : undefined
    const runtimeTargetProbe = runtimeStore
      ? createRuntimeTargetProbeLauncher({
          spawnWorker: spawnRuntimeTargetProbeWorker({
            executable: o.workerExecPath ?? process.execPath,
            args: [
              ...(o.workerExecArgv ?? []),
              o.workerEntry ?? fileURLToPath(new URL('../worker/main.js', import.meta.url)),
            ],
          }),
        })
      : undefined
    const skillInstallRequests = createSkillInstallRequests({
      directory: resourceControlDirectory,
      profile: o.profile.name,
      service: resourceControl.service,
      ...(resourceControl.unixAuthority ? { authority: resourceControl.unixAuthority } : {}),
      current: (key) => inflightConn.get(key),
      endpoint: (conn) => [...conns].find((entry) => entry.conn === conn)?.ep,
      owner: (key) => sessionOwnership.resolve(key),
      workspace: (key) => workspaces.get(key),
    })
    let effectivePackageAdmin = o.packageAdmin
    const pluginManageRequests = createPluginManageRequests({
      directory: resourceControlDirectory,
      profile: o.profile.name,
      service: () => effectivePackageAdmin?.service,
      current: (key) => inflightConn.get(key),
      endpoint: (conn) => [...conns].find((entry) => entry.conn === conn)?.ep,
      owner: (key) => sessionOwnership.resolve(key),
    })
    const mcpManageRequests = createMcpManageRequests({
      directory: resourceControlDirectory,
      profile: o.profile.name,
      service: resourceControl.service,
      ...(localResourceStore ? { store: localResourceStore } : {}),
      ...(resourceControl.unixAuthority ? { authority: resourceControl.unixAuthority } : {}),
      current: (key) => inflightConn.get(key),
      endpoint: (conn) => [...conns].find((entry) => entry.conn === conn)?.ep,
      owner: (key) => sessionOwnership.resolve(key),
    })
    const pool = new WorkerPool({
      config: o.config,
      profile: o.profile,
      profileFile: o.profileFile,
      resourceBootstrap: {
        ...(localResourceStore ? { snapshotPath: localResourceStore.snapshotPath(o.profile.name) } : {}),
        skillLkgDirectory: resourceSkillLkgDirectory,
        packageSkillSnapshotPath,
        mcpPolicy: deploymentMcpPolicy(process.env),
      },
      clock,
      ...(o.workerExecPath ? { execPath: o.workerExecPath } : {}),
      ...(o.workerExecArgv ? { execArgv: o.workerExecArgv } : {}),
      ...(o.workerEntry ? { workerEntry: o.workerEntry } : {}),

      onEvent: (sessionKey, e) => deliverWorkerEvent(registry, tickets, clock, sessionKey, e, workspaces),
      onPreview: (sessionKey, p) => registry.deliverPreview(sessionKey, p),
      onResourceStatus: (input) => observeResourceMcpStatus?.(input),
      onLog: (input) => o.audit?.({ kind: 'worker.log', ...input }),
      onSessionFailure: (sessionKey, error) => registry.interrupt(sessionKey, error),
      ...(runtimeDelivery ? { runtimeDelivery } : {}),
      onRequest: async (sessionKey, f) => {
        if (f.method === 'plugin-manage' || f.method === 'plugin-manage-abort')
          return pluginManageRequests(sessionKey, f.requestId, f.method, f.params)
        if (f.method === 'mcp-manage' || f.method === 'mcp-manage-abort')
          return mcpManageRequests(sessionKey, f.requestId, f.method, f.params)
        if (f.method === 'skill-install' || f.method === 'skill-install-abort')
          return skillInstallRequests(sessionKey, f.requestId, f.method, f.params)
        if (f.method === 'permission')
          return prompter.ask(f.params as ApprovalRequest, { signal: new AbortController().signal })
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
      notices.emit('tree_changed', {
        detail: {
          profile: o.profile.name,
          targetDigest: artifact.digest,
          identity: artifact.identity,
          hash: artifact.digest,
        },
      })
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
          writePackageSkillInventory(o.profile, o.profileDir, packageSkillSnapshotPath),
      })
      observeResourceMcpStatus = resourceAdapters.observeMcpStatus
      wireResourceSnapshotNotifications({ localResourceStore, registry, pool, log: console })
    }
    workerPool = pool
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
      const surfaceInventory = await o.packageRuntime.manager.inventory(packageProfileDirectory)
      const pinCoordinator = runtimeStore
        ? createRuntimePinCoordinator({
            store: runtimeStore,
            manager: o.packageRuntime.manager,
            profileDirectory: packageProfileDirectory,
          })
        : undefined
      await pinCoordinator?.recover()
      if (runtimeStore && pinCoordinator && runtimeTargetProbe)
        await activateDefaultHelpers({
          profileDir: o.profileDir,
          inventory: surfaceInventory,
          previous: runtimeStore.desired(),
          publish: (target) => pinCoordinator.publish(target, runtimeTargetProbe),
        })
      surfaceController = createSurfaceController({
        artifacts: createSurfaceArtifactResolver(surfaceInventory),
        secrets: createSurfaceSecretResolver((ref) => surfaceSecretBackend.resolve(ref)),
      })
      // Covers a startup ABORT only (thrown before this function returns a handle) -- see
      // `startupCleanup.length = 0` below, and cleanupStartup()'s own doc. The real graceful-stop
      // path is wired separately into `closeSockets` in the shutdown ladder further down.
      startupCleanup.push(() => surfaceController?.stop())
      await coordinateSurfacesOnBoot({
        profileDir: o.profileDir,
        inventory: surfaceInventory,
        controller: surfaceController,
        harnessVersion: DAEMON_HARNESS_VERSION,
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
            ...(pinCoordinator ? { publish: pinCoordinator.publish } : {}),
            ...(pinCoordinator ? { collectPins: pinCoordinator.collect } : {}),
            ...(pinCoordinator ? { revokePackage: pinCoordinator.revokePackage } : {}),
            ...(pinCoordinator ? { releaseRetiring: pinCoordinator.releaseRetiring } : {}),
            workerGeneration: () => pool.businessWorker()?.generation,
            desiredFor: async ({ packageId, operation }) => {
              latestInventory = await packageRuntime.manager.inventory(packageProfileDirectory)
              return rebuildDesiredFromInventory({
                previous: runtimeStore.desired(),
                inventory: latestInventory,
                packageId,
                operation,
              })
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
      if (compositePins) o.packageRuntime.bindRuntimePins?.(compositePins)
      if (runtimeStore)
        o.packageRuntime.bindPluginTree?.(
          runtimeStore,
          () => pool.businessWorker()?.generation,
          runtimeTargetProbe
            ? async (artifact) => {
                await revertFailedDesired?.()
                if (pinCoordinator) await pinCoordinator.publish(artifact, runtimeTargetProbe)
                else
                  await publishProbedRuntimeTarget({
                    store: runtimeStore,
                    artifact,
                    probe: runtimeTargetProbe,
                  })
              }
            : undefined,
        )
      void revertFailedDesired?.()
      effectivePackageAdmin ??= {
        service: createPackageAdminService({
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
            snapshotDirectory: (profile) => join(o.config.dataDir, 'daemon', 'client-modules', profile),
            runtimeArtifacts: () => runtimeArtifactsFromStore(runtimeStore),
          }),
        }),
      }
    }
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
    const hostFacade = supervisorHostFacade(o.profile, activationBarrier, pool)
    const host = hostFacade.host
    const callService = workerServiceCaller(pool, () => host.profile)
    const inspectService = workerServiceInspector(pool, () => host.profile)
    const dispatchClientService = async (
      input: ClientModuleServiceCallParams & Readonly<{ packageId: string; extension: string }>,
    ): Promise<ExtensionCallResult> => {
      const params: ExtensionCallParams = {
        sessionId: input.sessionId,
        extension: input.extension,
        service: input.service,
        input: input.input,
      }
      // Synthesized only after a fresh ready-row/manifest match; it never crosses the browser
      // boundary and has one query service grant rather than generic daemon authority.
      const credential = Object.freeze({
        kind: 'surface-service' as const,
        // `client-web` is a dedicated server-side principal for the authenticated loopback BFF.
        // It is deliberately not derived from profile/row text: the worker service-authority
        // envelope allows only a bounded source grammar and the row itself is already held in the
        // exact grant below.
        source: 'client-web',
        subjectCredential: Object.freeze({ kind: 'local' }),
        grants: Object.freeze([{ extension: input.extension, name: input.service, range: '*' }]),
      })
      const inspection = await inspectService(params, credential)
      if (inspection.kind !== 'query') throw rpcError('CAPABILITY_DENIED')
      return await callService(params, credential)
    }
    clientServiceCall = dispatchClientService
    o.packageRuntime?.bindClientService?.(dispatchClientService)
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
        const inspection = await inspectService(params, credential)
        if (inspection.kind !== 'effect') throw rpcError('CAPABILITY_DENIED')
        const serviceId = `service:client-web:${input.extension}/${input.service}`
        return await executeJournaledEffect({
          journal,
          commandQueue,
          callService,
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
    const preferences = new SessionPreferencesStore(jobTables?.table('session_preferences'))
    const rawLister =
      o.ports?.lister ??
      (o.tables
        ? new StorageLister(o.tables.table('events'), o.tables.table('writer_claims'), workspaces)
        : supervisorLister(supervisorRegistry, workspaces))

    const lister = withSessionPreferences(rawLister, preferences)

    const jobsRepo = jobTables ? new JobsRepo(jobTables.table('jobs'), clock) : undefined
    const scheduler = jobsRepo
      ? new Scheduler({
          repo: jobsRepo,
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
    const keeper = keepSharedWorker({ acquire: () => pool.acquireSharedWorker(), log: console })
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
      o.profile.seams?.principals === '@agnes/base'
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
      const feeds = new Map<string, Feed>()
      const attached = new Map<string, AttachedFeed>()
      const artifactReadConfigured = artifactRead !== undefined
      const cx: AgnesContext = {
        host,
        registry: supervisorRegistry,
        prompter,
        clock,
        agnesVersion: '0.0.0',
        quiescenceWaitMs: 2_000,
        configuration: o.configuration !== undefined,
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
        lister,
        ...(o.ports?.directory ? { directory: o.ports.directory } : {}),
        resolveActor,
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
          if (!principalId)
            throw rpcError('CAPABILITY_DENIED', {
              method: 'session.fork',
              reason: 'session owner unavailable',
            })
          const ownerPrincipal = principalId
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
      registerConfiguration(ep, o.configuration, profileApplication?.apply, profileApplication?.present)
      registerSessionPreferences(ep, lister, preferences)
      registerWorkspaces(ep, workspaceCatalog)
      registerAcp(ep, cx, feeds, attached)
      registerAgnes(ep, cx, feeds, attached)
      registerDiagnostics(ep, {
        requireSessionOwner: requireSessionOwner(cx),
        registry: cx.registry,
        dataDir: o.config.dataDir,
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
      registerResourceControl(
        ep,
        resourceControl.service,
        transport === 'unix'
          ? (resourceControl.unixAuthority ?? localResourceAuthority())
          : (resourceControl.webAuthority ?? denyResourceAuthority),
      )
      registerExtensions(ep, {
        activationBarrier,
        journal,
        commandQueue,
        callService,
        inspectService,
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
          const results = await Promise.allSettled([
            ...[...conns].map(({ ep }) => Promise.resolve().then(() => ep.close())),
            Promise.resolve().then(() => server.close()),
            ...(wsServer ? [Promise.resolve().then(() => wsServer.close())] : []),
            Promise.resolve().then(() => workersServer.close()),
            // A Surface is a separate OS child process fed by the mount-proxy HTTP forwarder that
            // whichever process owns the browser-facing `createWebServer` listener builds from the
            // Task-15 RPC path (`packages/cli/launch/surface-mounts.ts`'s `fetchSurfaceMountProxy`,
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
          await pool.waitForExitRecovery()
          await lock.release()
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

/** Host uses `run(sql, params)` while daemon's older narrow port uses `exec(sql, params)`. */
function adaptHostTables(store: HostTableStore): Pick<Tables, 'table'> {
  return {
    table(name: string): TableHandle {
      const table = store.table(name)
      return {
        exec(sql, params = []) {
          if (params.length) table.run(sql, params)
          else table.exec(sql)
        },
        get: <T>(sql: string, params = []) => table.get<T>(sql, params),
        all: <T>(sql: string, params = []) => table.all<T>(sql, params),
        transaction: <T>(fn: () => T) => table.transaction(fn),
      }
    },
  }
}

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
  prepareDaemonSocketPaths(o.config)
  const storage = (deps.createStorage ?? createSqliteStorage)({
    file: join(o.config.dataDir, 'sessions.db'),
    tablesDir: join(o.config.dataDir, 'tables'),
    ...(o.clock ? { clock: o.clock } : {}),
  })
  let supervisor: SupervisorHandle
  try {
    supervisor = await (deps.start ?? startSupervisor)({
      ...o,
      jobTables: adaptHostTables(storage.tables('@agnes/daemon')),
      artifactAuthorityTable: adaptHostTables(storage.tables('@agnes/daemon/artifact-read-authority')).table(
        'artifact_read_authority',
      ),
      reclaim: storage.crashReclaim,
    })
  } catch (error) {
    try {
      await storage.close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'supervisor startup and storage cleanup failed')
    }
    throw error
  }

  let closePromise: Promise<void> | undefined
  const close = async (): Promise<void> => {
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

/** Where a `kind: 'file'` secrets adapter reads/writes its store. A profile that pins an explicit
 * path always wins; otherwise the store lives under `<dataDir>/secrets`. Shared by `runAgnesd` and
 * `startSupervisor` so both daemon-launch paths agree on the same directory without a second,
 * possibly-diverging copy of this fallback rule. */
function secretsDirectory(profile: ResolvedProfile, config: DaemonConfig): string {
  return profile.adapters.secrets.path ?? join(config.dataDir, 'secrets')
}

export async function runAgnesd(args: RunAgnesdArgs = {}, deps: RunAgnesdDeps = {}): Promise<void> {
  const scope = await (deps.resolveScope ?? resolveDaemonScope)({
    env: process.env,
    ...(args.home !== undefined ? { home: args.home } : {}),
    ...(args.profile !== undefined ? { profile: args.profile } : {}),
    ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
    ...(args.dataDir !== undefined ? { dataDir: args.dataDir } : {}),
  })
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
  const platform = createPlatform().snapshot()
  const reloadProfile = async (): Promise<ResolvedProfile> => {
    return (await loadProfile({ configuration })).profile
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
      windowsEnsurePrivateDirectorySync(directory)
  } else await mkdir(checkedProfileDir, { recursive: true, mode: 0o700 })
  const profileDir = await packageProfileDirectory(scope.profile)
  let runtimeReferenceReader: PackageReferenceFactReader | undefined
  const packageManager = createPackageManager({
    dataDir: scope.dataDir,
    agnesVersion: '0.0.0',
    cwd: scope.workspace,
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
  let packageWorkerGeneration: (() => number | undefined) | undefined
  let packagePluginTreePublisher: ((artifact: RuntimeTargetArtifact) => Promise<void>) | undefined
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
  const deferredRuntimePins: RuntimePinsAdapter = {
    async inspect(profileName) {
      return (
        packageRuntimePins?.inspect(profileName) ?? {
          error: {
            code: 'E_PACKAGE_STATE',
            safeMessage: 'Package state does not allow this action.',
            blockers: [],
          },
        }
      )
    },
    async release(profileName, pinIds) {
      return (
        packageRuntimePins?.release(profileName, pinIds) ?? {
          error: {
            code: 'E_PACKAGE_STATE',
            safeMessage: 'Package state does not allow this action.',
            blockers: [],
          },
        }
      )
    },
  }
  const packageOperations = new FilePackageOperationStore(join(scope.daemonDir, 'package-operations'))
  const localExamplesCatalog = await discoverLocalExamples(scope.workspace)
  // An explicitly injected resource service owns its own durable recovery; the default store
  // is recovered only after its service-worker adapters are installed in startSupervisor.
  const resourceService = deps.resources?.service
  if (resourceService) await resourceService.recover()
  const defaultPackageAdmin = {
    service: createPackageAdminService({
      manager: packageManager,
      profileDirectory: packageProfileDirectory,
      operations: packageOperations,
      ...(localExamplesCatalog ? { catalog: localExamplesCatalog } : {}),
      activation: deferredActivation,
      runtimePins: deferredRuntimePins,
      pluginTree: () => packagePluginTree,
      pluginTreePublisher: async (artifact) => {
        const publish = packagePluginTreePublisher
        if (!publish) throw new Error('E_PACKAGE_STATE: runtime target publisher is unavailable')
        await publish(artifact)
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
        snapshotDirectory: (profileName) => join(scope.daemonDir, 'client-modules', profileName),
        runtimeArtifacts: () => runtimeArtifactsFromStore(packagePluginTree),
      }),
    }),
  }

  const requestAudit = createFileAudit(join(scope.dataDir, 'audit', 'daemon.jsonl'))
  const flushAudit = async () => {
    await requestAudit.close?.()
  }
  const sup = await (deps.startProduction ?? startProductionSupervisor)({
    audit: (record) => {
      if (!record || typeof record !== 'object' || !('kind' in record)) return
      if (record.kind === 'daemon.request_failed' || record.kind === 'plugin.tree.reverted')
        requestAudit.write({
          kind: record.kind,
          ...('detail' in record ? { detail: record.detail as Record<string, unknown> } : {}),
        })
    },
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
    await (deps.removeDiscovery ?? removeDaemonDiscovery)(scope, sup.owner.generation).catch(() => undefined)
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
  const windows = process.platform === 'win32' // guards-allow-platform: Windows graceful stop is delivered through the private generation-bound request.
  if (windows)
    stopWatching = watchWindowsStopRequest(scope.dataDir, sup.owner, () => {
      void close().then(
        () => process.exit(0),
        () => process.exit(1),
      )
    })
  console.error(`agnesd listening on ${sup.socketPath}`)
  if (sup.ws) console.error(`agnesd WebSocket listening on ${sup.ws.url}; bearer token available to launcher`)
}
