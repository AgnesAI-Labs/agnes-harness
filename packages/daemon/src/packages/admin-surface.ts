import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  PACKAGE_ADMIN_METHODS,
  PACKAGE_ADMIN_PERMISSIONS,
  type PackageAdminContext,
  type PackageAdminMethodName,
  type PackageAdminPermission,
  validatePackageAdminCall,
  validatePackageAdminData,
} from '@agnes/protocol'

const PREFIX = '/admin/plugins/api/'
// Exported so tests can assert this stays in lockstep with the Web BFF client's own hand-maintained
// route map (packages/web/src/admin/plugins/api.ts METHOD_BY_PATH) — see
// admin-surface.test.ts's "route allowlist" coverage.
export const ACTIONS = {
  'catalog/list': '_agnes/v1/packages.catalog.list',
  'catalog/get': '_agnes/v1/packages.catalog.get',
  list: '_agnes/v1/packages.list',
  inspect: '_agnes/v1/packages.inspect',
  install: '_agnes/v1/packages.install',
  trust: '_agnes/v1/packages.trust',
  untrust: '_agnes/v1/packages.untrust',
  enable: '_agnes/v1/packages.enable',
  disable: '_agnes/v1/packages.disable',
  update: '_agnes/v1/packages.update',
  rollback: '_agnes/v1/packages.rollback',
  remove: '_agnes/v1/packages.remove',
  'operation/get': '_agnes/v1/packages.operation.get',
  'operation/cancel': '_agnes/v1/packages.operation.cancel',
  'pins/inspect': '_agnes/v1/packages.pins.inspect',
  'pins/release': '_agnes/v1/packages.pins.release',
  'trust-workspace': '_agnes/v1/packages.trustWorkspace',
  'tree/get': '_agnes/v1/plugins.tree.get',
  'tree/list': '_agnes/v1/plugins.tree.list',
  'tree/apply': '_agnes/v1/plugins.tree.apply',
  'tree/rollback': '_agnes/v1/plugins.tree.rollback',
} as const satisfies Record<string, PackageAdminMethodName>
export type AdminSurfaceAction = keyof typeof ACTIONS

export type AdminSurfaceLink = Readonly<{
  packageId: string
  surfaceId: string
  mount: string
}>

export type AdminSurfaceOptions = {
  origin: string
  /** @deprecated Ignored legacy input; local admin access is exact-origin/Host bound. */
  token?: string
  profile: string
  clientId: string
  permissions?: readonly PackageAdminPermission[]
  features?: readonly string[]
  /** Stable opaque scope minted by the trusted launcher. Never accepts request data. */
  authScope?: string
  /** The trusted launcher binds this to the private Node SDK, never to request-selected RPC. */
  invoke(action: AdminSurfaceAction, params: unknown): Promise<unknown>
  /** Live, routable Surface links. The launcher strips loopback endpoint details before returning. */
  surfaceLinks?: () => Promise<readonly AdminSurfaceLink[]>
  clock?: () => number
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const packageIdPattern =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)$/
const surfaceIdPattern = /^[a-z][a-z0-9-]{0,63}$/
const mountPattern = /^\/(?!_agnes(?:\/|$))[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/
const validSurfaceLink = (value: unknown): value is AdminSurfaceLink =>
  record(value) &&
  Object.keys(value).length === 3 &&
  typeof value.packageId === 'string' &&
  packageIdPattern.test(value.packageId) &&
  value.packageId.length <= 256 &&
  typeof value.surfaceId === 'string' &&
  surfaceIdPattern.test(value.surfaceId) &&
  typeof value.mount === 'string' &&
  mountPattern.test(value.mount) &&
  value.mount.length <= 256

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
    throw new Error('request')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 1_048_576) throw new Error('request')
    chunks.push(bytes)
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch {
    throw new Error('request')
  }
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}
const error = (response: ServerResponse, status: number, code: string, message: string): void =>
  reply(response, status, { error: { code, message } })

/** No arbitrary method forwarding; ordinary chat credentials never grant raw PackageAdmin access. */
export function createAdminSurface(options: AdminSurfaceOptions) {
  const origin = new URL(options.origin)
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    origin.origin !== options.origin ||
    !/^[a-z][a-z0-9.-]{0,63}$/.test(options.profile) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(options.clientId)
  )
    throw new TypeError('invalid local admin scope')
  const configuredPermissions = [...(options.permissions ?? PACKAGE_ADMIN_PERMISSIONS)]
  const authScope =
    options.authScope ??
    `auth.${createHash('sha256')
      .update(`${options.profile}\u0000${options.clientId}`)
      .digest('hex')
      .slice(0, 32)}`
  const configuredContext: PackageAdminContext = {
    profile: options.profile,
    clientId: options.clientId,
    permissions: configuredPermissions,
    readOnly: false,
    authScope,
    features: [...(options.features ?? [])],
  }
  if (!validatePackageAdminData('PackageAdminContext', configuredContext).ok)
    throw new TypeError('invalid local admin context')
  let readOnly = true
  return {
    close: () => undefined,
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
        error(response, 403, 'E_ADMIN_ORIGIN', '管理请求来源无效')
        return true
      }
      const action = url.pathname.slice(PREFIX.length)
      if (action === 'context' && request.method === 'GET') {
        try {
          const list = await options.invoke('list', { profile: options.profile })
          readOnly = !validatePackageAdminCall(ACTIONS.list, 'result', list).ok
        } catch {
          readOnly = true
        }
        const context: PackageAdminContext = {
          ...configuredContext,
          permissions: readOnly
            ? configuredPermissions.includes('packages.read')
              ? ['packages.read']
              : []
            : configuredPermissions,
          readOnly,
        }
        if (!validatePackageAdminData('PackageAdminContext', context).ok) {
          error(response, 502, 'E_ADMIN_RESPONSE', '后台返回的数据无法确认')
          return true
        }
        reply(response, 200, context)
        return true
      }
      if (action === 'surfaces' && request.method === 'GET') {
        try {
          const surfaces = [...((await options.surfaceLinks?.()) ?? [])]
          if (surfaces.length > 256 || surfaces.some((value) => !validSurfaceLink(value))) {
            error(response, 502, 'E_ADMIN_RESPONSE', '后台返回的数据无法确认')
            return true
          }
          reply(response, 200, { surfaces })
        } catch {
          error(response, 502, 'E_ADMIN_BACKEND', '操作未确认，请查询状态或重新连接后台')
        }
        return true
      }
      if (request.method !== 'POST' || !Object.hasOwn(ACTIONS, action)) {
        error(response, 404, 'E_ADMIN_ROUTE', '管理操作不存在')
        return true
      }
      const name = action as AdminSurfaceAction
      const method = ACTIONS[name]
      try {
        const body = await readBody(request)
        if (!record(body) || !validatePackageAdminCall(method, 'params', body).ok) {
          error(response, 400, 'E_ADMIN_REQUEST', '管理参数无效')
          return true
        }
        if (body.profile !== options.profile || ('clientId' in body && body.clientId !== options.clientId)) {
          error(response, 403, 'E_ADMIN_SCOPE', '管理请求不属于当前配置')
          return true
        }
        if (readOnly && PACKAGE_ADMIN_METHODS[method].administration.execution !== 'read') {
          error(response, 409, 'E_ADMIN_READ_ONLY', '当前为只读恢复模式')
          return true
        }
        const result = await options.invoke(name, body)
        if (!validatePackageAdminCall(method, 'result', result).ok) {
          error(response, 502, 'E_ADMIN_RESPONSE', '后台返回的数据无法确认')
          return true
        }
        reply(response, 200, result)
      } catch {
        // Only validated DTOs may contain backend detail. Exceptions can contain local paths or secrets.
        error(response, 502, 'E_ADMIN_BACKEND', '操作未确认，请查询状态或重新连接后台')
      }
      return true
    },
  }
}
