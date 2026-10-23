import { createHash, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import {
  configurationReadOnly,
  denyPackageAdminAuthority,
  localPackageAdminAuthority,
  localWebSkinReadAuthority,
  registerPackageAdmin,
  requireLocalAdminAuthority,
} from '@agnes/daemon-admin/packages/index'
import {
  denyResourceAuthority,
  localResourceAuthority,
  registerResourceControl,
} from '@agnes/daemon-admin/resources/index'
import type { AttachedFeed } from '@agnes/daemon-foundation/local/attached'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { runQueued } from '@agnes/daemon-rpc/local/command-queue'
import { disposeFeeds, type Feed, registerAcp } from '@agnes/daemon-rpc/local/methods/acp'
import { registerAppServerAdmin } from '@agnes/daemon-rpc/local/methods/admin'
import { type AgnesContext, registerAgnes, requireSessionOwner } from '@agnes/daemon-rpc/local/methods/agnes'
import { type ArtifactReadRpcOptions, registerArtifactRead } from '@agnes/daemon-rpc/local/methods/artifacts'
import { registerConfiguration } from '@agnes/daemon-rpc/local/methods/config'
import { registerDiagnostics } from '@agnes/daemon-rpc/local/methods/diagnostics'
import { registerDoctor } from '@agnes/daemon-rpc/local/methods/doctor'
import { registerExtensions } from '@agnes/daemon-rpc/local/methods/extensions'
import { registerFactChain } from '@agnes/daemon-rpc/local/methods/fact-chain'
import { registerFeedback } from '@agnes/daemon-rpc/local/methods/feedback'
import { registerProfileServices } from '@agnes/daemon-rpc/local/methods/profile-services'
import { registerPromptTrace } from '@agnes/daemon-rpc/local/methods/prompt-trace'
import * as sessionPrefs from '@agnes/daemon-rpc/local/methods/session-preferences'
import { registerSessionSelection } from '@agnes/daemon-rpc/local/methods/session-selection'
import { registerSurfaces } from '@agnes/daemon-rpc/local/methods/surfaces'
import { registerWorkspaces } from '@agnes/daemon-rpc/local/methods/workspaces'
import { RequestTraceStore, readFactChainBinding, type ScanRead } from '@agnes/host'
import { telemetrySnapshot } from '@agnes/observability'
import { rpcError } from '@agnes/protocol'
import type { DispatchState } from './assembly-client-dispatch.js'
import type { ClientsState } from './assembly-client-services.js'
import type { AssemblyLifetime } from './assembly-lifetime.js'
import type { AssemblyBase } from './assembly-options.js'
import type { RuntimeState } from './assembly-runtime.js'
import type { SessionsState } from './assembly-session-services.js'
import type { Conn, StoresState } from './assembly-stores.js'
import type { WorkersState } from './assembly-workers.js'
import { daemonDoctor } from './doctor.js'
import { feedbackPorts } from './feedback-ports.js'
import { registerPluginRuntimeIngress } from './plugin-runtime-ingress.js'
import { activateForkOwnership } from './registry-facade.js'
import { registerSessionMethods } from './session-methods.js'
import { workspaceDeployments } from './workspace-deployments.js'

declare const AGNES_VERSION: string | undefined

type EndpointInput = AssemblyBase &
  StoresState &
  WorkersState &
  DispatchState &
  RuntimeState &
  SessionsState &
  ClientsState

export function createEndpoints(state: EndpointInput, _lifetime: AssemblyLifetime) {
  const { o, clock, pool, conns } = state
  const endpoint = (transport: 'unix' | 'ws'): { ep: LocalEndpoint; onClose: () => void } => {
    const ep = new LocalEndpoint({
      clock,
      principalId: 'local',
      profile: o.profile.name,
      ...(o.audit ? { audit: o.audit } : {}),
    })
    registerPluginRuntimeIngress(ep, pool, transport)
    const context = createEndpointContext(state, transport, ep)
    registerSessionEndpoints(state, transport, ep, context)
    registerEvidenceEndpoints(state, transport, ep, context)
    registerAdminEndpoints(state, transport, ep, context)
    registerExtensionEndpoints(state, transport, ep, context)
    const entry: Conn = { ep, conn: ep.conn }
    conns.add(entry)
    const onClose = () => {
      conns.delete(entry)
      disposeFeeds(context.feeds)
    }
    return { ep, onClose }
  }
  return { endpoint }
}

export type EndpointsState = ReturnType<typeof createEndpoints>

function createEndpointContext(state: EndpointInput, transport: 'unix' | 'ws', ep: LocalEndpoint) {
  const {
    o,
    clock,
    tickets,

    sessionOwnership,
    workspaceCatalog,
    activationBarrier,
    commandQueue,
    inflightConn,
    journal,
    claims,
    nonces,
    effectiveRemoteAuth,
    artifactRead,
    registry,
    prompter,
    supervisorRegistry,
    preferences,
    sidebarSessions,
    lister,
    host,
    services,
    schedules,
    profilePorts,

    selectedJobs,
    resolveActor,
    resolveNewSessionActor,
    effectivePackageAdmin,
  } = state
  const feeds = new Map<string, Feed>()
  const attached = new Map<string, AttachedFeed>()
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
    modelAdapters: state.modelCatalog,
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
    configurationReadOnly: (context) =>
      configurationReadOnly(async () =>
        effectivePackageAdmin?.service.call(
          '_agnes/v1/packages.list',
          { profile: o.profile.name },
          localPackageAdminAuthority(['packages.read'])(context),
        ),
      ),
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
    artifactRead: artifactRead !== undefined,
    ...(o.lockedPackageMutations !== undefined ? { lockedPackageMutations: o.lockedPackageMutations } : {}),
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
          parentBinding.extraRoots,
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

  return { cx, feeds, attached, factRead }
}

type EndpointContext = ReturnType<typeof createEndpointContext>

function registerSessionEndpoints(
  state: EndpointInput,
  transport: 'unix' | 'ws',
  ep: LocalEndpoint,
  context: EndpointContext,
) {
  const {
    o,
    workspaceCatalog,
    pool,
    registry,
    preferences,
    lister,
    effectivePackageAdmin,
    publishChildEngines,
    profileApplication,
    sessionSelection,
    appServerAdmin,
  } = state
  const { cx, feeds, attached } = context
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
  registerSessionMethods(ep, pool, cx, o.sessionViewRead)
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
}

function registerEvidenceEndpoints(
  state: EndpointInput,
  transport: 'unix' | 'ws',
  ep: LocalEndpoint,
  context: EndpointContext,
) {
  const {
    o,
    sessionOwnership,

    pool,
    registry,

    effectivePackageAdmin,

    feedbackOwner,
  } = state
  const { cx, factRead } = context
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
            ? (effectivePackageAdmin?.unixAuthority ?? localPackageAdminAuthority())
            : (effectivePackageAdmin?.webAuthority ?? denyPackageAdminAuthority)
        const authority = resolveAuthority(context)
        if (!authority) throw rpcError('CAPABILITY_DENIED')
        return feedbackOwner.bind({
          actor,
          signal,
          ...(sessionId === undefined ? {} : { sessionId }),
          authority: feedbackPorts({
            context,
            profile: o.profile.name,
            authority,
            packages: effectivePackageAdmin?.service,
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
                const tail = page.at(-1)
                if (!tail) return rows
                fromSeq = tail.seq + 1
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
            (await effectivePackageAdmin?.service.candidateEvidence?.(
              o.profile.name,
              candidateId,
              (transport === 'unix'
                ? (effectivePackageAdmin?.unixAuthority ?? localPackageAdminAuthority())
                : (effectivePackageAdmin?.webAuthority ?? denyPackageAdminAuthority))(context),
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
}

function registerAdminEndpoints(
  state: EndpointInput,
  transport: 'unix' | 'ws',
  ep: LocalEndpoint,
  context: EndpointContext,
) {
  const {
    o,
    composition,
    clock,
    ownerHome,
    workspaces,
    resourceControl,
    activationBarrier,
    artifactRead,
    pool,

    effectivePackageAdmin,
    localPluginWatcher,
    sessionSelection,
    profilePorts,
    boundWakes,
    scheduler,
  } = state
  const { cx } = context
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
  if (artifactRead !== undefined) registerArtifactRead(ep, artifactRead as ArtifactReadRpcOptions)
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
  registerProfileServices(ep, profilePorts.services, boundWakes, activationBarrier, requireSessionOwner(cx))
}

function registerExtensionEndpoints(
  state: EndpointInput,
  transport: 'unix' | 'ws',
  ep: LocalEndpoint,
  _context: EndpointContext,
) {
  const {
    sessionOwnership,
    workspaceCatalog,
    activationBarrier,
    commandQueue,
    journal,
    supervisorRegistry,
    services,
    surfaceController,
  } = state
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
  // Gated the same way `registerPackageAdmin`/`registerResourceControl`
  // above restrict themselves off remote WSS -- this method's only real consumer is the local CLI
  // process bridging the same-machine `agnes serve` process boundary (see
  // `packages/cli/launch/surface-mounts.ts`); a remote WSS client has no legitimate reason to read
  // where a locally-spawned Surface's loopback listener lives.
  if (transport === 'unix') registerSurfaces(ep, { snapshot: () => surfaceController?.snapshot() })
}
