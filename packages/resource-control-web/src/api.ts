import type {
  McpServerDefinitionInput,
  McpServerDescriptor,
  McpStatus,
  McpToolCatalogPage,
  ResourceOperation,
  ResourceOperationReceipt,
  SkillDescriptor,
  SkillRootStatus,
  TrustState,
} from '@agnes/protocol'
import type { ResourceAdminContext, ResourceAdminError } from './types.js'

export const RESOURCE_ADMIN_API_ROOT = '/admin/resources/api'
type FetchLike = typeof fetch
type ErrorResponse = { error?: { code?: unknown; message?: unknown } }

export class ResourceAdminApiError extends Error {
  readonly details: ResourceAdminError
  constructor(details: ResourceAdminError) {
    super(details.message)
    this.name = 'ResourceAdminApiError'
    this.details = details
  }
}
function safeError(value: unknown, fallback = '资源管理后台暂时不可用，请稍后重试。'): ResourceAdminError {
  if (!value || typeof value !== 'object') return { code: 'RESOURCE_ADMIN_UNAVAILABLE', message: fallback }
  const error = value as ErrorResponse
  return {
    code: typeof error.error?.code === 'string' ? error.error.code : 'RESOURCE_ADMIN_UNAVAILABLE',
    message: typeof error.error?.message === 'string' ? error.error.message : fallback,
  }
}
function commandId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return `web-resource-${crypto.randomUUID()}`
  return `web-resource-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
async function json(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}
function isContext(value: unknown): value is ResourceAdminContext {
  if (!value || typeof value !== 'object') return false
  const context = value as Partial<ResourceAdminContext>
  return (
    typeof context.profile === 'string' &&
    typeof context.clientId === 'string' &&
    Array.isArray(context.permissions) &&
    typeof context.readOnly === 'boolean'
  )
}

/** Browser-only facade for fixed resource-management BFF routes. */
export class ResourceAdminApi {
  readonly #fetch: FetchLike
  readonly #context: ResourceAdminContext
  readonly #workspaceId?: string
  constructor(context: ResourceAdminContext, fetcher: FetchLike = fetch, workspaceId?: string) {
    this.#context = context
    this.#fetch = fetcher
    if (workspaceId) this.#workspaceId = workspaceId
  }
  static async context(fetcher: FetchLike = fetch): Promise<ResourceAdminContext> {
    const response = await fetcher(`${RESOURCE_ADMIN_API_ROOT}/context`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    const body = await json(response)
    if (!response.ok)
      throw new ResourceAdminApiError(
        safeError(body, response.status === 403 ? '没有资源管理权限。' : undefined),
      )
    if (!isContext(body))
      throw new ResourceAdminApiError({
        code: 'RESOURCE_ADMIN_CONTEXT_INVALID',
        message: '资源管理上下文无效，请重新打开页面。',
      })
    return body
  }
  async skills(cursor?: string): Promise<{
    items: SkillDescriptor[]
    nextCursor?: string
    skillRoots?: SkillRootStatus[]
  }> {
    return this.#post('skills/list', {
      profile: this.#context.profile,
      kind: 'skill',
      ...(cursor ? { cursor } : {}),
      ...(this.#workspaceId ? { workspaceId: this.#workspaceId } : {}),
    })
  }
  async skill(resourceId: string): Promise<SkillDescriptor> {
    return this.#post('skills/get', {
      profile: this.#context.profile,
      resourceId,
    })
  }
  async refresh(rootKey?: string): Promise<ResourceOperationReceipt> {
    return this.#effect('skills/refresh', {
      ...(rootKey ? { rootKey } : {}),
      ...(this.#workspaceId ? { workspaceId: this.#workspaceId } : {}),
    })
  }
  async skillRemove(resourceId: string, expectedRevision: string): Promise<ResourceOperationReceipt> {
    return this.#effect('skills/remove', { resourceId, expectedRevision })
  }
  async skillPriority(
    resourceId: string,
    expectedRevision: string,
    expectedPriority: number,
    priority: number | null,
  ): Promise<ResourceOperationReceipt> {
    return this.#effect('skills/priority', {
      resourceId,
      expectedRevision,
      expectedPriority,
      priority,
    })
  }
  async skillTrust(
    resourceId: string,
    expectedRevision: string,
    trust: TrustState,
  ): Promise<ResourceOperationReceipt> {
    return this.#effect('skills/trust', {
      resourceId,
      expectedRevision,
      trust,
    })
  }
  async skillDesired(
    resourceId: string,
    expectedRevision: string,
    state: 'enabled' | 'disabled',
  ): Promise<ResourceOperationReceipt> {
    return this.#effect('skills/desired', {
      resourceId,
      expectedRevision,
      state,
      config: { kind: 'none' },
    })
  }
  async operation(operationId: string): Promise<ResourceOperation> {
    return this.#post('operations/get', {
      profile: this.#context.profile,
      operationId,
    })
  }
  async cancel(operationId: string): Promise<ResourceOperationReceipt> {
    return this.#effect('operations/cancel', { operationId })
  }
  async mcp(cursor?: string): Promise<{ items: McpServerDescriptor[]; nextCursor?: string }> {
    return this.#post('mcp/list', {
      profile: this.#context.profile,
      ...(cursor ? { cursor } : {}),
    })
  }
  async mcpGet(serverId: string): Promise<McpServerDescriptor> {
    return this.#post('mcp/get', { profile: this.#context.profile, serverId })
  }
  async mcpStatus(serverId: string): Promise<McpStatus> {
    return this.#post('mcp/status', {
      profile: this.#context.profile,
      serverId,
    })
  }
  async mcpTools(serverId: string, cursor?: string): Promise<McpToolCatalogPage> {
    return this.#post('mcp/tools', {
      profile: this.#context.profile,
      serverId,
      ...(cursor ? { cursor } : {}),
    })
  }
  async mcpCreate(definition: McpServerDefinitionInput): Promise<ResourceOperationReceipt> {
    return this.#effect('mcp/create', { definition })
  }
  async mcpUpdate(
    serverId: string,
    expectedRevision: string,
    definition: McpServerDefinitionInput,
  ): Promise<ResourceOperationReceipt> {
    return this.#effect('mcp/update', {
      serverId,
      expectedRevision,
      definition,
    })
  }
  async mcpRemove(serverId: string, expectedRevision: string): Promise<ResourceOperationReceipt> {
    return this.#effect('mcp/remove', { serverId, expectedRevision })
  }
  async mcpTrust(
    serverId: string,
    expectedRevision: string,
    trust: TrustState,
  ): Promise<ResourceOperationReceipt> {
    return this.#effect('mcp/trust', { serverId, expectedRevision, trust })
  }
  async mcpTest(serverId: string, expectedRevision: string): Promise<ResourceOperationReceipt> {
    return this.#effect('mcp/test', { serverId, expectedRevision })
  }
  async mcpEnable(serverId: string, expectedRevision: string): Promise<ResourceOperationReceipt> {
    return this.#effect('mcp/enable', { serverId, expectedRevision })
  }
  async mcpDisable(serverId: string, expectedRevision: string): Promise<ResourceOperationReceipt> {
    return this.#effect('mcp/disable', { serverId, expectedRevision })
  }
  async mcpReconnect(serverId: string, expectedRevision: string): Promise<ResourceOperationReceipt> {
    return this.#effect('mcp/reconnect', { serverId, expectedRevision })
  }
  async #effect<T extends Record<string, unknown>>(
    path: string,
    params: T,
  ): Promise<ResourceOperationReceipt> {
    return this.#post(path, {
      profile: this.#context.profile,
      clientId: this.#context.clientId,
      commandId: commandId(),
      ...params,
    })
  }
  async #post<T>(path: string, body: object): Promise<T> {
    const fetcher = this.#fetch
    const response = await fetcher(`${RESOURCE_ADMIN_API_ROOT}/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const result = await json(response)
    if (!response.ok)
      throw new ResourceAdminApiError(
        safeError(result, response.status === 403 ? '没有执行此操作的权限。' : undefined),
      )
    return result as T
  }
}
