import { randomUUID } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import {
  type ConfigurationService,
  type ExtensionActivationBarrier,
  type Host,
  resolveWorkspaceDirectory,
} from '@agnes/host'
import { rpcError } from '@agnes/protocol'
import {
  denyPackageAdminAuthority,
  localPackageAdminAuthority,
  localWebSkinReadAuthority,
  type PackageAdminAuthorityResolver,
  type PackageAdminService,
  registerPackageAdmin,
} from '../packages/index.js'
import {
  denyResourceAuthority,
  localResourceAuthority,
  type ResourceAuthorityResolver,
  type ResourceControlService,
  registerResourceControl,
} from '../resources/index.js'
import { MemorySessionWorkspaces, MemoryTickets, type TicketPort } from '../storage/lister.js'
import {
  MemorySessionPrincipalOwnership,
  type SessionPrincipalOwnership,
} from '../storage/session-ownership.js'
import { SessionPreferencesStore, withSessionPreferences } from '../storage/session-preferences.js'
import {
  MemoryWorkspaceStore,
  type WorkspaceCatalog,
  WorkspaceCatalog as WorkspaceCatalogImpl,
} from '../storage/workspaces.js'
import { type AttachedFeed, DEFAULT_LIMITS, type Limits } from './attached.js'
import { CommandQueue } from './command-queue.js'
import { LocalEndpoint } from './endpoint.js'
import { disposeFeeds, type Feed, type LocalContext, registerAcp } from './methods/acp.js'
import {
  type AgnesContext,
  type AuthKind,
  type CredentialKind,
  indexApprovalTicket,
  registerAgnes,
  requireSessionOwner,
} from './methods/agnes.js'
import { type ArtifactReadRpcOptions, registerArtifactRead } from './methods/artifacts.js'
import { registerConfiguration } from './methods/config.js'
import { registerDiagnostics } from './methods/diagnostics.js'
import { registerExtensions } from './methods/extensions.js'
import { registerSessionPreferences } from './methods/session-preferences.js'
import { registerWorkspaces } from './methods/workspaces.js'
import {
  type ClaimStore,
  type CommandJournal,
  type DirectoryPort,
  type JobsPort,
  MemoryClaims,
  MemoryJournal,
  type SessionLister,
} from './ports.js'
import { type Prompter, PrompterRouter } from './prompter.js'
import { RegistryLister, SessionRegistry } from './sessions.js'

type LockedPackageMutationStatusSource = Readonly<{ status(): unknown }>
type ComputerUseStatusSource = Readonly<{
  status(): unknown
  doctor?(params: import('@agnes/protocol').ComputerUseDoctorParams): Promise<unknown>
  permissionsStatus?(): Promise<unknown>
  permissionsGrant?(): Promise<unknown>
  operationStart?(kind: 'install' | 'update' | 'restart'): unknown
  operationStatus?(operationId?: string): unknown
  operationCancel?(operationId: string): unknown
  setSessionYolo(session: Readonly<{ key: string; lane: string }>, enabled: boolean): Promise<void>
}>
const embeddedSessionOwnership = new WeakMap<Host, MemorySessionPrincipalOwnership>()

function lockedPackageMutationStatusSource(host: Host): LockedPackageMutationStatusSource | undefined {
  try {
    if (utilTypes.isProxy(host)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(host, 'lockedPackageMutations')
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined
    const value = descriptor.value
    return value !== null && typeof value === 'object'
      ? (value as LockedPackageMutationStatusSource)
      : undefined
  } catch {
    return undefined
  }
}

function computerUseStatusSource(host: Host): ComputerUseStatusSource | undefined {
  try {
    if (utilTypes.isProxy(host)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(host, 'computerUse')
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined
    const value = descriptor.value
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) return undefined
    const status = Object.getOwnPropertyDescriptor(value, 'status')
    const doctor = Object.getOwnPropertyDescriptor(value, 'doctor')
    const permissionsStatus = Object.getOwnPropertyDescriptor(value, 'permissionsStatus')
    const permissionsGrant = Object.getOwnPropertyDescriptor(value, 'permissionsGrant')
    const operationStart = Object.getOwnPropertyDescriptor(value, 'operationStart')
    const operationStatus = Object.getOwnPropertyDescriptor(value, 'operationStatus')
    const operationCancel = Object.getOwnPropertyDescriptor(value, 'operationCancel')
    const setSessionYolo = Object.getOwnPropertyDescriptor(value, 'setSessionYolo')
    if (
      !status ||
      !Object.hasOwn(status, 'value') ||
      typeof status.value !== 'function' ||
      (doctor !== undefined && (!Object.hasOwn(doctor, 'value') || typeof doctor.value !== 'function')) ||
      (permissionsStatus !== undefined &&
        (!Object.hasOwn(permissionsStatus, 'value') || typeof permissionsStatus.value !== 'function')) ||
      (permissionsGrant !== undefined &&
        (!Object.hasOwn(permissionsGrant, 'value') || typeof permissionsGrant.value !== 'function')) ||
      (operationStart !== undefined &&
        (!Object.hasOwn(operationStart, 'value') || typeof operationStart.value !== 'function')) ||
      (operationStatus !== undefined &&
        (!Object.hasOwn(operationStatus, 'value') || typeof operationStatus.value !== 'function')) ||
      (operationCancel !== undefined &&
        (!Object.hasOwn(operationCancel, 'value') || typeof operationCancel.value !== 'function')) ||
      !setSessionYolo ||
      !Object.hasOwn(setSessionYolo, 'value') ||
      typeof setSessionYolo.value !== 'function'
    )
      return undefined
    return value as ComputerUseStatusSource
  } catch {
    return undefined
  }
}

export type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from '../rpc.js'
export { MemorySessionWorkspaces, SessionWorkspaceIndex } from '../storage/lister.js'
export {
  MemorySessionPrincipalOwnership,
  type SessionPrincipalOwnership,
  SessionPrincipalOwnershipIndex,
} from '../storage/session-ownership.js'
export {
  MemoryWorkspaceStore,
  SessionWorkspaceConflictError,
  WorkspaceBindingIndex,
  WorkspaceCatalog,
  type WorkspaceDirectoryResolver,
  type WorkspaceEntry,
  WorkspaceIndex,
  type WorkspaceStore,
} from '../storage/workspaces.js'
export {
  type ArtifactReadAuthority,
  type ArtifactReadAuthorityPort,
  type ArtifactReadFailure,
  type ArtifactReadRequest,
  type ArtifactReadResult,
  type ArtifactReadStore,
  type ArtifactReadSuccess,
  type AuthenticatedArtifactCaller,
  createAuthenticatedArtifactReadHandler,
} from './artifact-read.js'
export {
  type ArtifactAuthorityBinding,
  type ArtifactAuthorityWriteResult,
  type ArtifactAuthorityWriter,
  createArtifactReadAuthorityPort,
  PersistentArtifactReadAuthorityIndex,
} from './artifact-read-authority.js'
export {
  AttachedFeed,
  type DaemonNoticeKind,
  DEFAULT_LIMITS,
  type Limits,
  noticeParams,
  passesFilter,
} from './attached.js'
export {
  CommandQueue,
  CommandQueueError,
  type CommandQueueErrorCode,
  runQueued,
} from './command-queue.js'
export type {
  AttachPrefs,
  CallContext,
  ConnectionState,
  Handler,
  LedgerActor,
  RpcEndpoint,
} from './endpoint.js'
export { connActor, LocalEndpoint } from './endpoint.js'
export { type MetaState, stampMeta } from './meta.js'
export { Feed, type LocalContext, registerAcp } from './methods/acp.js'
export {
  type AgnesContext,
  type AuthKind,
  type CredentialKind,
  registerAgnes,
} from './methods/agnes.js'
export {
  type ArtifactReadRpcOptions,
  type ArtifactReadScopeAuthority,
  registerArtifactRead,
} from './methods/artifacts.js'
export { type ExtensionMethodsContext, registerExtensions } from './methods/extensions.js'
export { registerWorkspaces, throwWorkspaceRpcError } from './methods/workspaces.js'
export {
  type ClaimStore,
  type CommandJournal,
  type DirectoryPort,
  type JobsPort,
  type JournalResult,
  type JournalState,
  MemoryClaims,
  MemoryJournal,
  type SessionLister,
  type SessionMetaRow,
} from './ports.js'
export { toSessionUpdate } from './project.js'
export type { ApprovalRequest, AskOutcome, Prompter } from './prompter.js'
export { PrompterRouter } from './prompter.js'
export {
  createSessionAdmissionPort,
  reserveOwnedSession,
  SessionAdmissionDenied,
  type SessionAdmissionPort,
} from './session-admission.js'
export type { SessionEntry } from './sessions.js'
export { RegistryLister, SessionRegistry } from './sessions.js'
export { type Disposer, tailSession } from './tail.js'

export type LocalEndpointOptions = {
  configuration?: ConfigurationService
  prompter?: Prompter
  clock?: () => number
  agnesVersion?: string
  pollMs?: number
  quiescenceWaitMs?: number
  limits?: Partial<Limits>
  journal?: CommandJournal
  commandQueue?: CommandQueue
  /** Privileged activation gate; defaults to the Host's own gate. */
  activationBarrier?: ExtensionActivationBarrier
  claims?: ClaimStore
  jobs?: JobsPort
  /** Authentication verifier for an embedded endpoint. The normal local form keeps the unix-only
   * default; authenticated transport adapters can supply their verifier without bypassing authGate. */
  auth?: LocalContext['auth']
  /** Required by participant/approval credential flows until Host exposes its principals seam. */
  resolveActor?: AgnesContext['resolveActor']
  /** Enterprise directory sink. Presence alone is insufficient: handlers also require a
   * server-authenticated SSO or channel credential on this connection. */
  directory?: DirectoryPort
  /** Defaults to a `RegistryLister` over this endpoint's own registry - every session this process
   *  currently holds open, nothing from storage. A daemon process with a persistent session index
   *  supplies its own. */
  lister?: SessionLister
  /** Ticket lookup. Local form defaults to memory; daemon supplies the package-owned SQLite index. */
  tickets?: TicketPort
  /** Defaults to an in-memory registry over this endpoint's session ownership. */
  workspaces?: WorkspaceCatalog
  /** Authenticated session ownership. Embedded tests default to memory; process-scoped launchers
   * supply the daemon package's durable index so a later process can authorize session/load. */
  sessionOwnership?: SessionPrincipalOwnership
  /** Server-set identity for this connection: who it is, how it authenticated, and what it
   *  presented. It is never taken from the client, which is why it is a factory option and not a
   *  field on any request. */
  identity?: ConnectionIdentity
  /** Optional PackageAdmin service. Unix/in-process defaults to authenticated local authority;
   * WebSocket/localWeb requires an explicit server policy. */
  packageAdmin?: { service: PackageAdminService; authority?: PackageAdminAuthorityResolver }
  /** Resource control is opt-in until production supplies durable state plus Host lifecycle adapters. */
  resources?: { service: ResourceControlService; authority?: ResourceAuthorityResolver }
  /** Authenticated, content-addressed artifact reads. Omission leaves the RPC unregistered. */
  artifactRead?: ArtifactReadRpcOptions
  /** Where diagnostics.collect reads `audit/*.jsonl` tails. Omitted: both logs report missing. */
  dataDir?: string
}

/**
 * The three facts are one option rather than three, because they are one fact and every gate in the
 * package reads a different part of it. A principalId that could be set on its own let a caller
 * assert a foreign identity while authKind stayed at its 'local' default - and authKind is what
 * decides whether the protected jobs.enqueue family is advertised at all, so the connection whose
 * whole point was that it is not the local user was told it could enqueue. Stating one now means
 * stating all three.
 */
export type ConnectionIdentity = {
  principalId: string
  authKind: AuthKind
  credentialKind: CredentialKind
}

/** The local endpoint is reached over a socket only this machine's user can open, so its
 *  authentication is 'local' and its credential is the local one. */
export const LOCAL_IDENTITY: ConnectionIdentity = {
  principalId: 'local',
  authKind: 'local',
  credentialKind: 'local',
}

/**
 * A forwarder built before its target exists. host assembles the approval seam with
 * `bridge.prompter`, and the endpoint is bound into it afterwards; before that an ask is answered
 * 'unavailable', which is the one verdict that means nothing was asked.
 */
export function createPrompterBridge(): { prompter: Prompter; bind(target: Prompter): void } {
  let target: Prompter | undefined
  return {
    prompter: { ask: (req, opts) => (target ? target.ask(req, opts) : Promise.resolve('unavailable')) },
    bind(t) {
      target = t
    },
  }
}

export function createLocalEndpoint(
  host: Host,
  opts: LocalEndpointOptions = {},
): LocalEndpoint & { prompter: Prompter } {
  if (opts.activationBarrier && opts.activationBarrier !== host.activationBarrier)
    throw new TypeError('activationBarrier must be the Host activation barrier')
  const clock = opts.clock ?? (() => Date.now())
  const identity = opts.identity ?? LOCAL_IDENTITY
  const artifactReadConfigured = opts.artifactRead !== undefined
  const ep = new LocalEndpoint({ clock, principalId: identity.principalId })
  const tickets = opts.tickets ?? new MemoryTickets()
  const sessionWorkspaces = new MemorySessionWorkspaces()
  const workspaces =
    opts.workspaces ??
    new WorkspaceCatalogImpl(new MemoryWorkspaceStore(), sessionWorkspaces, resolveWorkspaceDirectory, clock)
  const registry = new SessionRegistry(host, {
    clock,
    ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
    observe: (sessionKey, event, cwd) => indexApprovalTicket(tickets, sessionKey, event, cwd),
  })
  const prompter = new PrompterRouter({
    ...(opts.prompter ? { local: opts.prompter } : {}),
    endpointFor: () => ep,
    connections: () => [ep.conn],
    originOf: (key) => (registry.get(key)?.inflight ? ep.conn : undefined),
    clock,
  })
  const feeds = new Map<string, Feed>()
  const attached = new Map<string, AttachedFeed>()
  const commandQueue = opts.commandQueue ?? new CommandQueue()
  let sessionOwnership = opts.sessionOwnership ?? embeddedSessionOwnership.get(host)
  if (!sessionOwnership) {
    const memoryOwnership = new MemorySessionPrincipalOwnership()
    embeddedSessionOwnership.set(host, memoryOwnership)
    sessionOwnership = memoryOwnership
  }
  const ownsCommandQueue = opts.commandQueue === undefined
  const journal = opts.journal ?? new MemoryJournal(clock)
  const lockedPackageMutations = lockedPackageMutationStatusSource(host)
  const computerUse = computerUseStatusSource(host)
  const cx = {
    host,
    registry,
    prompter,
    clock,
    agnesVersion: opts.agnesVersion ?? '0.0.0',
    quiescenceWaitMs: opts.quiescenceWaitMs ?? 2_000,
    // The ordinary endpoint is local/unix and needs no credential. Transport adapters that already
    // construct this endpoint can inject their real verifier; authorization still reads the
    // credential authGate writes onto ConnectionState, never this option directly.
    auth: opts.auth ?? { config: { transport: 'unix' as const }, nonces: { consume: () => true }, clock },
    commandQueue,
    activationBarrier: host.activationBarrier,
    workspaces,
    resolveNewSessionActor: host.resolveActor.bind(host),
    sessionCredentialAuthority: true,
    sessionOwnership,
    hasSessionFact: (sessionId: string) => host.kernel.get(sessionId) !== undefined,
  }
  const preferences = new SessionPreferencesStore()
  const lister = withSessionPreferences(opts.lister ?? new RegistryLister(registry), preferences)
  registerSessionPreferences(ep, lister, preferences)
  registerConfiguration(ep, opts.configuration)
  registerWorkspaces(ep, workspaces)
  registerAcp(ep, cx, feeds, attached)
  registerAgnes(
    ep,
    {
      ...cx,
      configuration: opts.configuration !== undefined,
      profileHashForSession: async (key: string) => registry.require(key).session.d.resolvedProfileHash,
      limits: { ...DEFAULT_LIMITS, ...opts.limits },
      journal,
      claims: opts.claims ?? new MemoryClaims(),
      ...(opts.jobs ? { jobs: opts.jobs } : {}),
      ...(opts.directory ? { directory: opts.directory } : {}),
      // Host owns the fitted principals seam. An explicit resolver remains available to transport
      // tests and enterprise adapters, but the ordinary local CLI must not lose approval support
      // merely because it did not duplicate Host's identity wiring in its boot layer.
      resolveActor: opts.resolveActor ?? host.resolveActor.bind(host),
      tickets,
      lister,
      // From the same value that named the principal, so the gates that read the authentication and
      // the ones that read the identity cannot disagree about who this connection is.
      authKind: identity.authKind,
      credentialKind: identity.credentialKind,
      artifactRead: artifactReadConfigured,
      ...(lockedPackageMutations ? { lockedPackageMutations } : {}),
      ...(computerUse ? { computerUse } : {}),
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
          const parentBinding = await workspaces.restoreBinding(sessionId)
          await workspaces.authorizeAndBind(ownedChildKey, parentBinding.canonicalRoot)
          const entry = await registry.fork({
            parent: sessionId,
            at,
            childKey: ownedChildKey,
            ...(credential === undefined ? {} : { credential }),
          })
          if (!sessionOwnership.activateFork(sessionId, entry.key, ownerPrincipal, at)) denyFork()
          return { result: { sessionId: entry.key } }
        } catch (error) {
          if ((error as { code?: unknown }).code === 'E_LANE_BUSY')
            throw rpcError('SESSION_BUSY', { sessionId, reason: 'fork requires an idle parent' })
          throw error
        }
      },
    },
    feeds,
    attached,
  )
  registerDiagnostics(ep, {
    requireSessionOwner: requireSessionOwner(cx),
    registry,
    ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir }),
  })
  if (artifactReadConfigured) registerArtifactRead(ep, opts.artifactRead as ArtifactReadRpcOptions)
  if (opts.packageAdmin) {
    // The loopback Web connection is authenticated as the local owner but is not an administration
    // channel; it gets the one skin read the workbench actually needs (design §23.3). Every other
    // transport keeps the deny-by-default grant.
    const defaultAuthority =
      cx.auth.config.transport === 'unix'
        ? localPackageAdminAuthority()
        : cx.auth.config.localWeb === true
          ? localWebSkinReadAuthority
          : denyPackageAdminAuthority
    registerPackageAdmin(ep, opts.packageAdmin.service, opts.packageAdmin.authority ?? defaultAuthority)
  }
  if (opts.resources) {
    const defaultAuthority =
      cx.auth.config.transport === 'unix' ? localResourceAuthority() : denyResourceAuthority
    registerResourceControl(ep, opts.resources.service, opts.resources.authority ?? defaultAuthority)
  }
  registerExtensions(ep, {
    activationBarrier: cx.activationBarrier,
    journal,
    commandQueue,
    callService: host.callService.bind(host),
    inspectService: host.inspectService.bind(host),
    resolveServiceSession: async (sessionId) => {
      try {
        registry.require(sessionId)
      } catch {
        throw rpcError('INTERNAL_ERROR', { code: 'E_WORKSPACE_REQUIRED' })
      }
      return sessionId
    },
  })
  const close = ep.close.bind(ep)
  return Object.assign(ep, {
    prompter,
    close: async () => {
      // Abort inbound handlers and server-to-client requests first. A disconnected permission
      // client otherwise leaves its approval request parked while registry.closeAll() waits for the
      // same session invocation to drain.
      ep.stopIntake()
      await close()
      disposeFeeds(feeds)
      if (ownsCommandQueue) await commandQueue.close()
      await registry.closeAll()
    },
  })
}
