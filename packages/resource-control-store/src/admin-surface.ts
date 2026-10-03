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
        SKILL_SOURCE_MANAGED: 'This skill is provided by a plugin. Remove it from plugin management.',
        SKILL_DELETE_PREFLIGHT_FAILED:
          'The delete preflight failed, so the skill was not changed. Check the path, version, and local delete support. Windows network-share paths are not supported yet.',
        SKILL_STALE: 'The skill source has not refreshed successfully. Refresh it and try again.',
        SKILL_REMOVED: 'This skill is being permanently deleted and cannot be enabled again.',
        RESOURCE_BUSY: 'This skill is already handling another operation. Wait for it to finish.',
        SKILL_DELETE_NOT_CANCELLABLE: 'A permanent delete cannot be cancelled after it starts.',
        REVISION_CONFLICT: 'Another operation updated this resource. Refresh and check the latest version.',
        MCP_NOT_FOUND: 'The MCP definition does not exist or has been removed.',
        RESOURCE_OPERATION_UNAVAILABLE: 'The operation does not exist, or this account cannot view it.',
        RESOURCE_OPERATION_OWNER_REQUIRED: 'You can only cancel resource operations that you started.',
        CAPABILITY_DENIED: 'This local backend has not granted that admin permission.',
        SEMANTIC_REJECTED: 'The resource operation does not match the current state.',
        RESOURCE_RECONCILE_FAILED:
          'The backend could not apply the resource state safely. Check the latest status.',
      } as Record<string, string>
    )[code] ?? 'The backend rejected the resource operation. Refresh and check its status.'
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
        error(response, 403, 'E_RESOURCE_ADMIN_ORIGIN', 'The resource admin request origin is not valid.')
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
        error(response, 404, 'E_RESOURCE_ADMIN_ROUTE', 'The resource admin operation does not exist.')
        return true
      }
      const name = action as ResourceAdminSurfaceAction
      const method = ACTIONS[name]
      try {
        const body = await readBody(request)
        if (!record(body) || !validateResourceControlCall(method, 'params', body).ok) {
          error(response, 400, 'E_RESOURCE_ADMIN_REQUEST', 'The resource admin parameters are not valid.')
          return true
        }
        if (body.profile !== options.profile || ('clientId' in body && body.clientId !== options.clientId)) {
          error(
            response,
            403,
            'E_RESOURCE_ADMIN_SCOPE',
            'The resource admin request does not belong to this profile.',
          )
          return true
        }
        if (readOnly && RESOURCE_CONTROL_METHODS[method].administration.execution !== 'read') {
          error(
            response,
            409,
            'E_RESOURCE_ADMIN_READ_ONLY',
            'The resource admin surface is in read-only recovery mode.',
          )
          return true
        }
        const result = await options.invoke(name, body)
        if (!validateResourceControlCall(method, 'result', result).ok) {
          error(response, 502, 'E_RESOURCE_ADMIN_RESPONSE', 'The backend response could not be confirmed.')
          return true
        }
        reply(response, 200, result)
      } catch (cause) {
        if (cause instanceof ResourceAdminRequestError) {
          if (cause.reason === 'body-too-large')
            error(
              response,
              413,
              'E_RESOURCE_ADMIN_BODY_TOO_LARGE',
              'The resource admin request body is too large.',
            )
          else
            error(response, 400, 'E_RESOURCE_ADMIN_REQUEST', 'The resource admin request is not valid JSON.')
        } else if (unavailable(cause))
          error(
            response,
            501,
            'E_RESOURCE_UNSUPPORTED',
            'This backend version does not support that resource admin capability.',
          )
        else {
          const code = safeBackendCode(cause)
          if (code) error(response, 409, code, safeBackendMessage(code))
          else
            error(
              response,
              502,
              'E_RESOURCE_ADMIN_BACKEND',
              'The operation was not confirmed. Check its status or reconnect to the backend.',
            )
        }
      }
      return true
    },
  }
}
