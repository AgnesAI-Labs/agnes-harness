import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  RESOURCE_CONTROL_METHODS,
  type ResourceControlMethodName,
  validateResourceControlCall,
} from '@agnes/protocol'
import { RESOURCE_ALL_PERMISSIONS } from './permissions.js'

const PREFIX = '/admin/resources/api/'
const MAX_BODY_BYTES = 1_048_576

class ResourceAdminRequestError extends Error {
  constructor(readonly reason: 'invalid' | 'body-too-large') {
    super(reason)
  }
}

/** Fixed browser routes. The browser never chooses an RPC method name. */
const ACTIONS = {
  'skills/list': '_agnes/v1/resources.list',
  'skills/get': '_agnes/v1/resources.get',
  'skills/refresh': '_agnes/v1/skills.refresh',
  'skills/remove': '_agnes/v1/skills.remove',
  'skills/priority': '_agnes/v1/skills.priority.set',
  'skills/trust': '_agnes/v1/skills.trust.set',
  'skills/desired': '_agnes/v1/resources.desired.set',
  'operations/get': '_agnes/v1/resources.operation.get',
  'operations/cancel': '_agnes/v1/resources.operation.cancel',
  'mcp/list': '_agnes/v1/mcp.servers.list',
  'mcp/get': '_agnes/v1/mcp.servers.get',
  'mcp/status': '_agnes/v1/mcp.servers.status',
  'mcp/tools': '_agnes/v1/mcp.servers.tools.list',
  'mcp/create': '_agnes/v1/mcp.servers.create',
  'mcp/update': '_agnes/v1/mcp.servers.update',
  'mcp/remove': '_agnes/v1/mcp.servers.remove',
  'mcp/trust': '_agnes/v1/mcp.servers.trust.set',
  'mcp/test': '_agnes/v1/mcp.servers.test',
  'mcp/enable': '_agnes/v1/mcp.servers.enable',
  'mcp/disable': '_agnes/v1/mcp.servers.disable',
  'mcp/reconnect': '_agnes/v1/mcp.servers.reconnect',
} as const satisfies Record<string, ResourceControlMethodName>

export type ResourceAdminSurfaceAction = keyof typeof ACTIONS
export type ResourceAdminSurfaceOptions = Readonly<{
  origin: string
  /** @deprecated Ignored legacy input; local admin access is exact-origin/Host bound. */
  token?: string
  profile: string
  clientId: string
  /** Private Node SDK dispatch supplied by the trusted local launcher. */
  invoke(action: ResourceAdminSurfaceAction, params: unknown): Promise<unknown>
  /** @deprecated Retained only for source compatibility with legacy test callers. */
  clock?: () => number
}>

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
    throw new ResourceAdminRequestError('invalid')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.length
    if (bytes > MAX_BODY_BYTES) throw new ResourceAdminRequestError('body-too-large')
    chunks.push(value)
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch {
    throw new ResourceAdminRequestError('invalid')
  }
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}
function error(response: ServerResponse, status: number, code: string, message: string): void {
  reply(response, status, { error: { code, message } })
}
function unavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { kind?: unknown; data?: { code?: unknown } }
  return (
    value.kind === 'unsupported' ||
    value.data?.code === 'METHOD_NOT_FOUND' ||
    value.data?.code === 'RESOURCE_METHOD_UNAVAILABLE'
  )
}
function safeBackendCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { data?: { code?: unknown } }).data?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined
}
function safeBackendMessage(code: string): string {
  return (
    (
      {
        SKILL_SOURCE_MANAGED: '此 Skill 由插件提供，请通过插件管理移除。',
        SKILL_DELETE_PREFLIGHT_FAILED:
          '删除预检未通过，未更改 Skill 状态。请检查路径、版本和本机删除能力；Windows 网络共享路径暂不支持。',
        SKILL_STALE: 'Skill 来源尚未成功刷新，请先刷新后重试。',
        SKILL_REMOVED: '此 Skill 已进入永久删除流程，不能重新启用。',
        RESOURCE_BUSY: '此 Skill 正在处理另一项操作，请等待完成。',
        SKILL_DELETE_NOT_CANCELLABLE: '永久删除开始后不能取消。',
        REVISION_CONFLICT: '资源已被另一项操作更新，请刷新后核对最新版本。',
        MCP_NOT_FOUND: 'MCP 定义不存在或已被移除。',
        RESOURCE_OPERATION_UNAVAILABLE: '操作不存在，或当前账户无权查看该操作。',
        RESOURCE_OPERATION_OWNER_REQUIRED: '只能取消自己发起的资源操作。',
        CAPABILITY_DENIED: '当前本地后台未授予此管理权限。',
        SEMANTIC_REJECTED: '资源操作未通过当前状态校验。',
        RESOURCE_RECONCILE_FAILED: '后台未能安全应用资源状态，请查看最新状态。',
      } as Record<string, string>
    )[code] ?? '后台拒绝了该资源操作，请刷新后核对状态。'
  )
}

function validScope(options: ResourceAdminSurfaceOptions): URL {
  const origin = new URL(options.origin)
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    origin.origin !== options.origin ||
    !/^[a-z][a-z0-9._-]{0,127}$/.test(options.profile) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(options.clientId)
  )
    throw new TypeError('invalid local resource admin scope')
  return origin
}

/**
 * Local-only, fixed Resource Admin BFF. Error DTOs are intentionally generic: raw exception
 * text can carry paths, headers, or credentials even when a resource implementation is correct.
 */
export function createResourceAdminSurface(options: ResourceAdminSurfaceOptions) {
  const origin = validScope(options)
  let readOnly = true
  return {
    close: (): void => undefined,
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? '/', options.origin)
      if (!url.pathname.startsWith(PREFIX)) return false
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('Referrer-Policy', 'no-referrer')
      response.setHeader('X-Frame-Options', 'DENY')
      response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
      const site = request.headers['sec-fetch-site']
      if (
        request.headers.host !== origin.host ||
        (site !== undefined && site !== 'same-origin' && site !== 'none') ||
        (request.headers.origin !== undefined && request.headers.origin !== options.origin) ||
        (request.method === 'POST' && request.headers.origin !== options.origin) ||
        url.origin !== options.origin ||
        url.search
      ) {
        error(response, 403, 'E_RESOURCE_ADMIN_ORIGIN', '资源管理请求来源无效')
        return true
      }
      const action = url.pathname.slice(PREFIX.length)
      if (action === 'context' && request.method === 'GET') {
        try {
          const result = await options.invoke('skills/list', { profile: options.profile, kind: 'skill' })
          readOnly = !validateResourceControlCall(ACTIONS['skills/list'], 'result', result).ok
        } catch {
          readOnly = true
        }
        reply(response, 200, {
          profile: options.profile,
          clientId: options.clientId,
          permissions: readOnly ? ['resources.read'] : [...RESOURCE_ALL_PERMISSIONS],
          readOnly,
        })
        return true
      }
      if (request.method !== 'POST' || !Object.hasOwn(ACTIONS, action)) {
        error(response, 404, 'E_RESOURCE_ADMIN_ROUTE', '资源管理操作不存在')
        return true
      }
      const name = action as ResourceAdminSurfaceAction
      const method = ACTIONS[name]
      try {
        const body = await readBody(request)
        if (!record(body) || !validateResourceControlCall(method, 'params', body).ok) {
          error(response, 400, 'E_RESOURCE_ADMIN_REQUEST', '资源管理参数无效')
          return true
        }
        if (body.profile !== options.profile || ('clientId' in body && body.clientId !== options.clientId)) {
          error(response, 403, 'E_RESOURCE_ADMIN_SCOPE', '资源管理请求不属于当前配置')
          return true
        }
        if (readOnly && RESOURCE_CONTROL_METHODS[method].administration.execution !== 'read') {
          error(response, 409, 'E_RESOURCE_ADMIN_READ_ONLY', '当前为只读恢复模式')
          return true
        }
        const result = await options.invoke(name, body)
        if (!validateResourceControlCall(method, 'result', result).ok) {
          error(response, 502, 'E_RESOURCE_ADMIN_RESPONSE', '后台返回的数据无法确认')
          return true
        }
        reply(response, 200, result)
      } catch (cause) {
        if (cause instanceof ResourceAdminRequestError) {
          if (cause.reason === 'body-too-large')
            error(response, 413, 'E_RESOURCE_ADMIN_BODY_TOO_LARGE', '资源管理请求体超过大小限制')
          else error(response, 400, 'E_RESOURCE_ADMIN_REQUEST', '资源管理请求格式无效')
        } else if (unavailable(cause))
          error(response, 501, 'E_RESOURCE_UNSUPPORTED', '当前后台版本不支持此资源管理能力。')
        else {
          const code = safeBackendCode(cause)
          if (code) error(response, 409, code, safeBackendMessage(code))
          else error(response, 502, 'E_RESOURCE_ADMIN_BACKEND', '操作未确认，请查询状态或重新连接后台')
        }
      }
      return true
    },
  }
}
