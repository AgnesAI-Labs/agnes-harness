/** Node-only resource administration facade. It deliberately forwards the frozen wire shapes
 * verbatim: callers own profile, command identity, revision and cursors. */
import type {
  McpOAuthStatusResult,
  McpOAuthStatusSetParams,
  McpServerCreateParams,
  McpServerDescriptor,
  McpServerDisableParams,
  McpServerEnableParams,
  McpServerGetParams,
  McpServerListParams,
  McpServerListResult,
  McpServerReconnectParams,
  McpServerRemoveParams,
  McpServerTestParams,
  McpServerUpdateParams,
  McpStatus,
  McpToolCatalogPage,
  McpToolsListParams,
  McpTrustSetParams,
  ResourceDescriptor,
  ResourceDesiredSetParams,
  ResourceGetParams,
  ResourceListParams,
  ResourceListResult,
  ResourceOperation,
  ResourceOperationCancelParams,
  ResourceOperationGetParams,
  ResourceOperationReceipt,
  SkillPrioritySetParams,
  SkillRefreshParams,
  SkillRemoveParams,
  SkillTrustSetParams,
} from '@agnes/protocol'
/** Narrow wire port keeps this facade independent of the SDK transport implementation. */
export type ResourceControlRpc = Readonly<{
  call<T>(method: string, params: unknown): Promise<T>
}>

export const isResourceControlMethod = (method: string): boolean =>
  method.startsWith('_agnes/v1/resources.') ||
  method.startsWith('_agnes/v1/skills.') ||
  method.startsWith('_agnes/v1/mcp.servers.')

export type ResourceControlClient = Readonly<{
  resources: Readonly<{
    list(params: ResourceListParams): Promise<ResourceListResult>
    get(params: ResourceGetParams): Promise<ResourceDescriptor>
    desiredSet(params: ResourceDesiredSetParams): Promise<ResourceOperationReceipt>
    operation: Readonly<{
      get(params: ResourceOperationGetParams): Promise<ResourceOperation>
      cancel(params: ResourceOperationCancelParams): Promise<ResourceOperationReceipt>
    }>
  }>
  skills: Readonly<{
    remove(params: SkillRemoveParams): Promise<ResourceOperationReceipt>
    prioritySet(params: SkillPrioritySetParams): Promise<ResourceOperationReceipt>
    refresh(params: SkillRefreshParams): Promise<ResourceOperationReceipt>
    trustSet(params: SkillTrustSetParams): Promise<ResourceOperationReceipt>
  }>
  mcp: Readonly<{
    servers: Readonly<{
      list(params: McpServerListParams): Promise<McpServerListResult>
      get(params: McpServerGetParams): Promise<McpServerDescriptor>
      status(params: McpServerGetParams): Promise<McpStatus>
      tools: Readonly<{ list(params: McpToolsListParams): Promise<McpToolCatalogPage> }>
      create(params: McpServerCreateParams): Promise<ResourceOperationReceipt>
      update(params: McpServerUpdateParams): Promise<ResourceOperationReceipt>
      remove(params: McpServerRemoveParams): Promise<ResourceOperationReceipt>
      trustSet(params: McpTrustSetParams): Promise<ResourceOperationReceipt>
      test(params: McpServerTestParams): Promise<ResourceOperationReceipt>
      enable(params: McpServerEnableParams): Promise<ResourceOperationReceipt>
      disable(params: McpServerDisableParams): Promise<ResourceOperationReceipt>
      reconnect(params: McpServerReconnectParams): Promise<ResourceOperationReceipt>
      oauth: Readonly<{
        status(params: McpServerGetParams): Promise<McpOAuthStatusResult>
        statusSet(params: McpOAuthStatusSetParams): Promise<McpOAuthStatusResult>
      }>
    }>
  }>
}>

export function createResourceControlClient(client: ResourceControlRpc): ResourceControlClient {
  return Object.freeze({
    resources: Object.freeze({
      list: (params: ResourceListParams): Promise<ResourceListResult> =>
        client.call('_agnes/v1/resources.list', params),
      get: (params: ResourceGetParams): Promise<ResourceDescriptor> =>
        client.call('_agnes/v1/resources.get', params),
      desiredSet: (params: ResourceDesiredSetParams): Promise<ResourceOperationReceipt> =>
        client.call('_agnes/v1/resources.desired.set', params),
      operation: Object.freeze({
        get: (params: ResourceOperationGetParams): Promise<ResourceOperation> =>
          client.call('_agnes/v1/resources.operation.get', params),
        cancel: (params: ResourceOperationCancelParams): Promise<ResourceOperationReceipt> =>
          client.call('_agnes/v1/resources.operation.cancel', params),
      }),
    }),
    skills: Object.freeze({
      remove: (params: SkillRemoveParams): Promise<ResourceOperationReceipt> =>
        client.call('_agnes/v1/skills.remove', params),
      prioritySet: (params: SkillPrioritySetParams): Promise<ResourceOperationReceipt> =>
        client.call('_agnes/v1/skills.priority.set', params),
      refresh: (params: SkillRefreshParams): Promise<ResourceOperationReceipt> =>
        client.call('_agnes/v1/skills.refresh', params),
      trustSet: (params: SkillTrustSetParams): Promise<ResourceOperationReceipt> =>
        client.call('_agnes/v1/skills.trust.set', params),
    }),
    mcp: Object.freeze({
      servers: Object.freeze({
        list: (params: McpServerListParams): Promise<McpServerListResult> =>
          client.call('_agnes/v1/mcp.servers.list', params),
        get: (params: McpServerGetParams): Promise<McpServerDescriptor> =>
          client.call('_agnes/v1/mcp.servers.get', params),
        status: (params: McpServerGetParams): Promise<McpStatus> =>
          client.call('_agnes/v1/mcp.servers.status', params),
        tools: Object.freeze({
          list: (params: McpToolsListParams): Promise<McpToolCatalogPage> =>
            client.call('_agnes/v1/mcp.servers.tools.list', params),
        }),
        create: (params: McpServerCreateParams): Promise<ResourceOperationReceipt> =>
          client.call('_agnes/v1/mcp.servers.create', params),
        update: (params: McpServerUpdateParams): Promise<ResourceOperationReceipt> =>
          client.call('_agnes/v1/mcp.servers.update', params),
        remove: (params: McpServerRemoveParams): Promise<ResourceOperationReceipt> =>
          client.call('_agnes/v1/mcp.servers.remove', params),
        trustSet: (params: McpTrustSetParams): Promise<ResourceOperationReceipt> =>
          client.call('_agnes/v1/mcp.servers.trust.set', params),
        test: (params: McpServerTestParams): Promise<ResourceOperationReceipt> =>
          client.call('_agnes/v1/mcp.servers.test', params),
        enable: (params: McpServerEnableParams): Promise<ResourceOperationReceipt> =>
          client.call('_agnes/v1/mcp.servers.enable', params),
        disable: (params: McpServerDisableParams): Promise<ResourceOperationReceipt> =>
          client.call('_agnes/v1/mcp.servers.disable', params),
        reconnect: (params: McpServerReconnectParams): Promise<ResourceOperationReceipt> =>
          client.call('_agnes/v1/mcp.servers.reconnect', params),
        oauth: Object.freeze({
          status: (params: McpServerGetParams): Promise<McpOAuthStatusResult> =>
            client.call('_agnes/v1/mcp.servers.oauth.status', params),
          statusSet: (params: McpOAuthStatusSetParams): Promise<McpOAuthStatusResult> =>
            client.call('_agnes/v1/mcp.servers.oauth.status.set', params),
        }),
      }),
    }),
  })
}
