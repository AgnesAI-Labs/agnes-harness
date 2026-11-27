import type { ConnectionState } from '@agnes/daemon-foundation/local/endpoint'
import type { ApprovalRequest } from '@agnes/daemon-rpc/local/prompter'
import { agnesHome, RefinementSettingsStore } from '@agnes/host'
import { rpcError } from '@agnes/protocol'
import { artifactMediaReadReply, readChildSessionArtifactMedia } from './artifact-read.js'
import type { AssemblyLifetime } from './assembly-lifetime.js'
import type { AssemblyBase } from './assembly-options.js'
import type { RuntimeState } from './assembly-runtime.js'
import type { WorkerRequestServices } from './assembly-session-services.js'
import type { StoresState } from './assembly-stores.js'
import type { WorkersState } from './assembly-workers.js'
import { createMcpManageRequests } from './mcp-manage-requests.js'
import { permissionRequest } from './permission-requests.js'
import { createPluginManageRequests } from './plugin-manage-requests.js'
import { createRefinementSkillRequests } from './refinement-skill-requests.js'
import { callWorkerScheduling } from './scheduling-service.js'
import { createSkillInstallRequests } from './skill-install-requests.js'
import type { WorkerPool } from './worker-pool.js'

/** Every request kind that installs code or a server into the profile; `skillInstalls: false` refuses all. */
const PACKAGE_INSTALL_REQUESTS: ReadonlySet<string> = new Set([
  'skill-install',
  'refinement-save',
  'plugin-manage',
  'mcp-manage',
])

async function handleArtifactMediaRead(
  state: Pick<
    AssemblyBase & StoresState & WorkersState,
    'o' | 'sessionOwnership' | 'projectedArtifactRead' | 'registry'
  >,
  sessionKey: string,
  params: unknown,
  workerSignal: AbortSignal,
) {
  const { o, sessionOwnership, projectedArtifactRead, registry } = state
  if (!projectedArtifactRead?.workerRead) return undefined
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(params)
  if (
    Reflect.ownKeys(descriptors).length !== 3 ||
    !['lane', 'nodeSeq', 'sha256'].every(
      (key) => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key] ?? {}, 'value'),
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
  const activeOwner = sessionOwnership.resolve(sessionKey)
  if (activeOwner?.active) {
    await registry.ensureArtifactAuthority(sessionKey, nodeSeq as number)
    const result = await projectedArtifactRead.workerRead(
      { sessionId: sessionKey, laneId: lane, ownerId: activeOwner.principalId, sha256 },
      new AbortController().signal,
    )
    return artifactMediaReadReply(result, sha256)
  }
  if (!sessionKey.includes('/') || !o.sessionFactRead) return undefined
  const rootKey = sessionKey.slice(0, sessionKey.indexOf('/'))
  const rootOwner = rootKey ? sessionOwnership.resolve(rootKey) : undefined
  if (!rootOwner?.active) return undefined
  return readChildSessionArtifactMedia({
    dataDir: o.config.dataDir,
    maxArtifactBytes: Math.max(100 * 1024 * 1024, o.profile.computerUse?.capture.maxBytesPerImage ?? 0),
    sessionKey,
    rootKey,
    lane,
    nodeSeq: nodeSeq as number,
    sha256,
    signal: workerSignal,
    sessionFactRead: o.sessionFactRead,
    stillAuthorized: () => {
      const current = sessionOwnership.resolve(rootKey)
      return !!current?.active && current.principalId === rootOwner.principalId && !workerSignal.aborted
    },
  })
}

export function createWorkerRequests(
  state: AssemblyBase & StoresState & WorkersState & RuntimeState & WorkerRequestServices,
  lifetime: AssemblyLifetime,
) {
  const {
    o,
    ownerHome,
    conns,
    workspaces,
    sessionOwnership,
    workspaceCatalog,
    resourceControlDirectory,
    localResourceStore,
    resourceControl,
    notices,
    inflightConn,
    projectedArtifactRead,
    pool,
    registry,
    prompter,
    effectivePackageAdmin,
    schedules,
    profilePorts,
    savedSkills,
  } = state
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
  const refinementSettings = new RefinementSettingsStore(o.config.dataDir, o.profile.name, ownerHome)
  const refinementSkillRequests = createRefinementSkillRequests({
    dataDir: o.config.dataDir,
    profile: o.profile.name,
    agnesHome: agnesHome(process.env),
    service: resourceControl.service,
    installers: savedSkills.installers,
    workspace: (key) => workspaces.get(key),
    owner: (key) => sessionOwnership.resolve(key),
    enabled: () => refinementSettings.current().settings.enabled,
  })
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
  const verifyPermission = async (
    sessionKey: string,
  ): Promise<import('@agnes/protocol').PermissionContext | undefined> => {
    if (!sessionOwnership.resolve(sessionKey)?.active) return undefined
    const link = pool.businessWorker()?.link
    return (await link?.commandForSession(sessionKey, 'permissionContext', {})) as
      | import('@agnes/protocol').PermissionContext
      | undefined
  }
  const permissionRequests = new Map<string, AbortController>()
  lifetime.own({
    stop: () => {
      for (const controller of permissionRequests.values()) controller.abort('stopped')
    },
    dispose: () => undefined,
  })
  const dispatchWorkerRequest: NonNullable<ConstructorParameters<typeof WorkerPool>[0]['onRequest']> = async (
    sessionKey,
    f,
    workerSignal,
    sharedWorker,
  ) => {
    if (f.method === 'auto-title-eligible') {
      if (
        workerSignal.aborted ||
        !f.params ||
        typeof f.params !== 'object' ||
        Array.isArray(f.params) ||
        Object.keys(f.params).length !== 0 ||
        !sessionOwnership.resolve(sessionKey)?.active
      )
        return false
      try {
        // Only the supervisor's presentation owner may authorize changing an automatic title.
        return state.preferences.get(sessionKey).title === undefined
      } catch {
        return false
      }
    }
    if (f.method === 'scheduling')
      return callWorkerScheduling(schedules, workspaceCatalog, sessionKey, f.params, workerSignal)
    if (f.method === 'bound-wake') return profilePorts.ownedWake(f.params)
    if (f.method === 'channel-interaction')
      return profilePorts.channelInteraction({ sharedWorker, sessionKey }, f.params)
    if (f.method === 'managed-session')
      return profilePorts.ownedSession({ sharedWorker, sessionKey }, f.params)
    if (PACKAGE_INSTALL_REQUESTS.has(f.method) && profilePorts.managedSessions.skillInstallsOff?.(sessionKey))
      throw rpcError('CAPABILITY_DENIED', { reason: 'MANAGED_SKILL_INSTALLS_OFF' })
    if (f.method === 'refinement-save') return refinementSkillRequests(sessionKey, f.params)
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
        f.permissionContext
          ? pool.businessWorker()?.link.permissionFence.bind(f.permissionContext)
          : undefined,
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
          f.permissionContext
            ? pool.businessWorker()?.link.permissionFence.bind(f.permissionContext)
            : undefined,
        )
      } finally {
        permissionRequests.delete(permissionKey)
      }
    }
    if (f.method === 'artifact-media-read')
      return handleArtifactMediaRead(state, sessionKey, f.params, workerSignal)
    // 'notice': declared on the wire (frames.ts) for a worker to relay a daemon notice, but nothing
    // in worker/main.ts constructs one yet (no `method: 'notice'` request-frame send site exists in
    // this package today) - this branch exists so a future worker-initiated notice has somewhere to
    // land instead of falling through unhandled; 'resumed' is the kind the plan's own sample used.
    notices.emit('resumed', { sessionId: sessionKey, detail: f.params })
    return undefined
  }
  return dispatchWorkerRequest
}
