import {
  createResourceAdminSurface,
  type DaemonScope,
  type ResourceAdminSurfaceAction,
  readDaemonDiscovery,
} from '@agnes/daemon'
import type {
  McpServerCreateParams,
  McpServerDisableParams,
  McpServerEnableParams,
  McpServerGetParams,
  McpServerListParams,
  McpServerReconnectParams,
  McpServerRemoveParams,
  McpServerTestParams,
  McpServerUpdateParams,
  McpToolsListParams,
  McpTrustSetParams,
  ResourceDesiredSetParams,
  ResourceGetParams,
  ResourceListParams,
  ResourceOperationCancelParams,
  ResourceOperationGetParams,
  SkillPrioritySetParams,
  SkillRefreshParams,
  SkillRemoveParams,
  SkillTrustSetParams,
} from '@agnes/protocol'
import { createClient, memoryJournal, unixTransport } from '@agnes/sdk'
export type LocalResourceBackend = Readonly<{
  socketPath: string
  scope: DaemonScope
}>

/**
 * The browser only receives the narrow HTTP BFF below. This local Unix SDK client is the sole
 * resource-administration authority and must never be serialized to a renderer page.
 */
export function localResourceAdmin(backend: LocalResourceBackend, origin: string) {
  const clientId = `resource-admin-web-${backend.scope.scopeID}`
  const path = backend.socketPath
  const scope = { ...backend.scope }
  const client = createClient({
    transport: { kind: 'unix', path: backend.socketPath },
    ...(path.startsWith('\\\\.\\pipe\\')
      ? {
          transportFactories: {
            unix: () =>
              unixTransport({
                path,
                resolveServerIdentity: async () => {
                  const discovery = await readDaemonDiscovery(scope)
                  if (!discovery || discovery.socketPath !== path)
                    throw new Error('local pipe does not match a verified daemon')
                  return { pid: discovery.owner.pid, processStartId: discovery.owner.processStartId }
                },
              }),
          },
        }
      : {}),
    auth: { kind: 'local' },
    journal: memoryJournal(clientId),
  })
  let ready: Promise<unknown> | undefined
  const initialize = () =>
    (ready ??= client.initialize().catch((error: unknown) => {
      ready = undefined
      throw error
    }))
  const invoke = async (action: ResourceAdminSurfaceAction, params: unknown): Promise<unknown> => {
    await initialize()
    switch (action) {
      case 'skills/list':
        return client.resources.list(params as ResourceListParams)
      case 'skills/get':
        return client.resources.get(params as ResourceGetParams)
      case 'skills/refresh':
        return client.skills.refresh(params as SkillRefreshParams)
      case 'skills/remove':
        return client.skills.remove(params as SkillRemoveParams)
      case 'skills/priority':
        return client.skills.prioritySet(params as SkillPrioritySetParams)
      case 'skills/trust':
        return client.skills.trustSet(params as SkillTrustSetParams)
      case 'skills/desired':
        return client.resources.desiredSet(params as ResourceDesiredSetParams)
      case 'operations/get':
        return client.resources.operation.get(params as ResourceOperationGetParams)
      case 'operations/cancel':
        return client.resources.operation.cancel(params as ResourceOperationCancelParams)
      case 'mcp/list':
        return client.mcp.servers.list(params as McpServerListParams)
      case 'mcp/get':
        return client.mcp.servers.get(params as McpServerGetParams)
      case 'mcp/status':
        return client.mcp.servers.status(params as McpServerGetParams)
      case 'mcp/tools':
        return client.mcp.servers.tools.list(params as McpToolsListParams)
      case 'mcp/create':
        return client.mcp.servers.create(params as McpServerCreateParams)
      case 'mcp/update':
        return client.mcp.servers.update(params as McpServerUpdateParams)
      case 'mcp/remove':
        return client.mcp.servers.remove(params as McpServerRemoveParams)
      case 'mcp/trust':
        return client.mcp.servers.trustSet(params as McpTrustSetParams)
      case 'mcp/test':
        return client.mcp.servers.test(params as McpServerTestParams)
      case 'mcp/enable':
        return client.mcp.servers.enable(params as McpServerEnableParams)
      case 'mcp/disable':
        return client.mcp.servers.disable(params as McpServerDisableParams)
      case 'mcp/reconnect':
        return client.mcp.servers.reconnect(params as McpServerReconnectParams)
    }
  }
  const surface = createResourceAdminSurface({
    origin,
    profile: backend.scope.profile,
    clientId,
    invoke,
  })
  return {
    handle: surface.handle,
    async close(): Promise<void> {
      surface.close()
      await client.close()
    },
  }
}
