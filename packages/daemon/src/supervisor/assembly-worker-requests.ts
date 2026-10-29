import type { ConnectionState } from '@agnes/daemon-foundation/local/endpoint'
import type { ApprovalRequest } from '@agnes/daemon-rpc/local/prompter'
import { rpcError } from '@agnes/protocol'
import { artifactMediaReadReply } from './artifact-read.js'
import type { AssemblyLifetime } from './assembly-lifetime.js'
import type { AssemblyBase } from './assembly-options.js'
import type { RuntimeState } from './assembly-runtime.js'
import type { WorkerRequestServices } from './assembly-session-services.js'
import type { StoresState } from './assembly-stores.js'
import type { WorkersState } from './assembly-workers.js'
import { createMcpManageRequests } from './mcp-manage-requests.js'
import { permissionRequest } from './permission-requests.js'
import { createPluginManageRequests } from './plugin-manage-requests.js'
import { callWorkerScheduling } from './scheduling-service.js'
import { createSkillInstallRequests } from './skill-install-requests.js'
import type { WorkerPool } from './worker-pool.js'

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
  ) => {
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
    if (f.method === 'artifact-media-read') {
      if (!projectedArtifactRead?.workerRead) return undefined
      if (!f.params || typeof f.params !== 'object' || Array.isArray(f.params)) return undefined
      const descriptors = Object.getOwnPropertyDescriptors(f.params)
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
  }
  return dispatchWorkerRequest
}
