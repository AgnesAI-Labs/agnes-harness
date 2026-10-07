import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  type AdminSessionSelection,
  isAdminLoop,
  isAdminModelAdapter,
  isSessionDefaultsSnapshot,
  PACKAGE_ADMIN_METHODS,
  PACKAGE_ADMIN_PERMISSIONS,
  type PackageAdminContext,
  type PackageAdminMethodName,
  type PackageAdminPermission,
  RuntimeAdminSnapshot,
  validateAgainst,
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
  generations: '_agnes/v1/plugins.generations',
  'publication-status': '_agnes/v1/plugins.publicationStatus',
  'sessions/migrate': '_agnes/v1/sessions.migrate',
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
  /** Real host catalogs plus configuration storage. Missing means selection is unavailable. */
  sessionSelection?: AdminSessionSelection
  /** Owner-checked SDK catalog for a durable session key. */
  sessionTools?: (sessionId: string) => Promise<import('@agnes/protocol').SessionToolsResult>
  runtimeAdmin?: {
    snapshot(): Promise<import('@agnes/protocol').RuntimeAdminSnapshot>
    reloadLocal(): Promise<void>
  }
  /** Official web-search settings. The handler returns JSON and never includes credential values. */
  searchAdmin?: {
    handle(method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }>
  }
  composition?: {
    bundles(): Promise<unknown>
    dump(preset?: string): Promise<unknown>
    saveBundles(input: { revision: number; bundles: string[] }): Promise<unknown>
  }
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
      const selectionRoute = url.pathname.startsWith('/admin/api/')
      if (!url.pathname.startsWith(PREFIX) && !selectionRoute) return false
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
        (['POST', 'PUT'].includes(request.method ?? '') && request.headers.origin !== options.origin) ||
        url.origin !== options.origin ||
        url.search
      ) {
        error(response, 403, 'E_ADMIN_ORIGIN', 'The admin request origin is not valid.')
        return true
      }
      if (selectionRoute) {
        const route = url.pathname.slice('/admin/api/'.length)
        if (route === 'runtime' || route === 'reload-local') {
          const write = route === 'reload-local'
          if (request.method !== (write ? 'POST' : 'GET')) {
            error(response, 404, 'E_ADMIN_ROUTE', 'The admin operation does not exist.')
            return true
          }
          if (!configuredPermissions.includes(write ? 'packages.activate' : 'packages.read')) {
            error(response, 403, 'E_ADMIN_FORBIDDEN', 'You do not have permission to perform this action.')
            return true
          }
          if (write && readOnly) {
            error(response, 409, 'E_ADMIN_READ_ONLY', 'The admin surface is in read-only recovery mode.')
            return true
          }
          if (!options.runtimeAdmin) {
            error(response, 503, 'E_ADMIN_CATALOG_UNAVAILABLE', 'Runtime administration is unavailable.')
            return true
          }
          try {
            if (write) {
              const body = await readBody(request)
              if (!record(body) || Object.keys(body).length !== 0) {
                error(response, 400, 'E_ADMIN_REQUEST', 'The admin parameters are not valid.')
                return true
              }
              await options.runtimeAdmin.reloadLocal()
              reply(response, 200, {})
            } else {
              const snapshot = await options.runtimeAdmin.snapshot()
              if (!validateAgainst(RuntimeAdminSnapshot, snapshot).ok) throw new Error('invalid snapshot')
              reply(response, 200, snapshot)
            }
          } catch {
            error(
              response,
              502,
              'E_ADMIN_RUNTIME',
              'Runtime status could not be confirmed. Reload and inspect plugin states.',
            )
          }
          return true
        }
        if (route.startsWith('tools/') && request.method === 'GET') {
          if (!configuredPermissions.includes('packages.read')) {
            error(response, 403, 'E_ADMIN_FORBIDDEN', 'You do not have permission to perform this action.')
            return true
          }
          let sessionId: string
          try {
            sessionId = decodeURIComponent(route.slice('tools/'.length))
          } catch {
            sessionId = ''
          }
          if (!sessionId || sessionId.length > 1024) {
            error(response, 400, 'E_ADMIN_REQUEST', 'A valid session key is required.')
            return true
          }
          if (!options.sessionTools) {
            error(response, 503, 'E_ADMIN_CATALOG_UNAVAILABLE', 'Session tool catalog is unavailable.')
            return true
          }
          try {
            reply(response, 200, await options.sessionTools(sessionId))
          } catch {
            error(response, 404, 'E_ADMIN_SESSION', 'Session is unavailable to this client.')
          }
          return true
        }
        if (route === 'bundles' || route === 'composition') {
          const write = route === 'bundles' && request.method === 'PUT'
          if (!write && request.method !== 'GET' && !(route === 'composition' && request.method === 'POST')) {
            error(response, 404, 'E_ADMIN_ROUTE', 'The admin operation does not exist.')
            return true
          }
          if (!configuredPermissions.includes(write ? 'packages.activate' : 'packages.read')) {
            error(response, 403, 'E_ADMIN_FORBIDDEN', 'You do not have permission to perform this action.')
            return true
          }
          if (write && readOnly) {
            error(response, 409, 'E_ADMIN_READ_ONLY', 'The admin surface is in read-only recovery mode.')
            return true
          }
          if (!options.composition) {
            error(response, 503, 'E_ADMIN_CATALOG_UNAVAILABLE', 'Composition is unavailable.')
            return true
          }
          try {
            let result: unknown
            if (write) {
              const input = await readBody(request)
              if (
                !record(input) ||
                Object.keys(input).length !== 2 ||
                !Number.isSafeInteger(input.revision) ||
                Number(input.revision) < 0 ||
                !Array.isArray(input.bundles) ||
                input.bundles.length > 64 ||
                !input.bundles.every((id) => typeof id === 'string' && id.length <= 512)
              )
                throw new Error('request')
              result = await options.composition.saveBundles(input as { revision: number; bundles: string[] })
            } else if (route === 'composition') {
              let preset: string | undefined
              if (request.method === 'POST') {
                const input = await readBody(request)
                if (
                  !record(input) ||
                  Object.keys(input).length !== 1 ||
                  typeof input.preset !== 'string' ||
                  !/^[a-z][a-z0-9-]{0,63}$/.test(input.preset)
                )
                  throw new Error('request')
                preset = input.preset
              }
              result = await options.composition.dump(preset)
            } else result = await options.composition.bundles()
            reply(response, 200, result)
          } catch (cause) {
            const code = (cause as { code?: string }).code
            const conflict = code === 'CONFIG_REVISION_CONFLICT'
            error(
              response,
              conflict ? 409 : 400,
              conflict ? code : 'E_ADMIN_COMPOSITION',
              conflict
                ? 'Configuration changed; reload and try again.'
                : 'Composition could not be resolved. Check the selected bundles and preset.',
            )
          }
          return true
        }
        if (route === 'search' || route === 'search/test') {
          const method = request.method ?? 'GET'
          const allowed = route === 'search' ? method === 'GET' || method === 'PUT' : method === 'POST'
          if (!allowed) {
            error(response, 404, 'E_ADMIN_ROUTE', 'The admin operation does not exist.')
            return true
          }
          const write = method !== 'GET'
          if (!configuredPermissions.includes(write ? 'packages.activate' : 'packages.read')) {
            error(response, 403, 'E_ADMIN_FORBIDDEN', 'You do not have permission to perform this action.')
            return true
          }
          if (write && readOnly) {
            error(response, 409, 'E_ADMIN_READ_ONLY', 'The admin surface is in read-only recovery mode.')
            return true
          }
          if (!options.searchAdmin) {
            error(response, 503, 'E_ADMIN_SEARCH_UNAVAILABLE', 'Search settings are unavailable.')
            return true
          }
          let body: unknown
          if (write) {
            try {
              body = await readBody(request)
            } catch {
              error(response, 400, 'E_ADMIN_REQUEST', 'The admin parameters are not valid.')
              return true
            }
          }
          try {
            const result = await options.searchAdmin.handle(method, route, body)
            if (result.status < 200 || result.status > 599) throw new Error('status')
            reply(response, result.status, result.body)
          } catch {
            error(response, 502, 'E_ADMIN_SEARCH', 'Search settings could not be confirmed.')
          }
          return true
        }
        const write = route === 'defaults' && request.method === 'PUT'
        if (
          !write &&
          !(request.method === 'GET' && ['loops', 'model-adapters', 'defaults'].includes(route))
        ) {
          error(response, 404, 'E_ADMIN_ROUTE', 'The admin operation does not exist.')
          return true
        }
        if (!configuredPermissions.includes(write ? 'packages.activate' : 'packages.read')) {
          error(response, 403, 'E_ADMIN_FORBIDDEN', 'You do not have permission to perform this action.')
          return true
        }
        if (write && readOnly) {
          error(response, 409, 'E_ADMIN_READ_ONLY', 'The admin surface is in read-only recovery mode.')
          return true
        }
        const provider = options.sessionSelection
        if (!provider) {
          error(response, 503, 'E_ADMIN_CATALOG_UNAVAILABLE', 'Session selection catalogs are unavailable.')
          return true
        }
        try {
          let result: unknown
          if (write) {
            let body: unknown
            try {
              body = await readBody(request)
            } catch {
              body = undefined
            }
            if (!isSessionDefaultsSnapshot(body)) {
              error(response, 400, 'E_ADMIN_REQUEST', 'The admin parameters are not valid.')
              return true
            }
            result = await provider.saveDefaults(body)
          } else if (route === 'loops') {
            const [loops, defaults] = await Promise.all([provider.loops(), provider.getDefaults()])
            if (loops.length > 4096 || !loops.every(isAdminLoop) || !isSessionDefaultsSnapshot(defaults))
              throw new Error('invalid catalog')
            const presets = await provider.presets?.()
            if (
              presets &&
              (presets.length > 4096 ||
                !presets.every((preset) => isSessionDefaultsSnapshot({ revision: 0, defaults: { preset } })))
            )
              throw new Error('invalid preset catalog')
            reply(response, 200, { loops, ...defaults, ...(presets ? { presets } : {}) })
            return true
          } else if (route === 'model-adapters') {
            const modelAdapters = await provider.modelAdapters()
            if (modelAdapters.length > 4096 || !modelAdapters.every(isAdminModelAdapter))
              throw new Error('invalid catalog')
            reply(response, 200, { modelAdapters })
            return true
          } else result = await provider.getDefaults()
          if (!isSessionDefaultsSnapshot(result)) throw new Error('invalid defaults')
          reply(response, 200, result)
        } catch (cause) {
          const code = record(cause) ? cause.code : undefined
          const conflict = code === 'CONFIG_REVISION_CONFLICT'
          const invalid = code === 'CONFIG_INVALID_INPUT' || code === 'CONFIG_MODEL_UNAVAILABLE'
          error(
            response,
            conflict ? 409 : invalid ? 400 : 502,
            conflict ? 'CONFIG_REVISION_CONFLICT' : invalid ? 'E_ADMIN_SELECTION' : 'E_ADMIN_BACKEND',
            conflict
              ? 'Configuration changed; reload and try again.'
              : invalid
                ? 'The selected loop, adapter or model is unavailable.'
                : 'The backend response could not be confirmed.',
          )
        }
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
          error(response, 502, 'E_ADMIN_RESPONSE', 'The backend response could not be confirmed.')
          return true
        }
        reply(response, 200, context)
        return true
      }
      if (action === 'surfaces' && request.method === 'GET') {
        try {
          const surfaces = [...((await options.surfaceLinks?.()) ?? [])]
          if (surfaces.length > 256 || surfaces.some((value) => !validSurfaceLink(value))) {
            error(response, 502, 'E_ADMIN_RESPONSE', 'The backend response could not be confirmed.')
            return true
          }
          reply(response, 200, { surfaces })
        } catch {
          error(
            response,
            502,
            'E_ADMIN_BACKEND',
            'The operation was not confirmed. Check its status or reconnect to the backend.',
          )
        }
        return true
      }
      const statusGet = action === 'publication-status' && request.method === 'GET'
      if ((!statusGet && request.method !== 'POST') || !Object.hasOwn(ACTIONS, action)) {
        error(response, 404, 'E_ADMIN_ROUTE', 'The admin operation does not exist.')
        return true
      }
      const name = action as AdminSurfaceAction
      const method = ACTIONS[name]
      try {
        const body = statusGet ? { profile: options.profile } : await readBody(request)
        if (!record(body) || !validatePackageAdminCall(method, 'params', body).ok) {
          error(response, 400, 'E_ADMIN_REQUEST', 'The admin parameters are not valid.')
          return true
        }
        if (body.profile !== options.profile || ('clientId' in body && body.clientId !== options.clientId)) {
          error(response, 403, 'E_ADMIN_SCOPE', 'The admin request does not belong to this profile.')
          return true
        }
        if (readOnly && PACKAGE_ADMIN_METHODS[method].administration.execution !== 'read') {
          error(response, 409, 'E_ADMIN_READ_ONLY', 'The admin surface is in read-only recovery mode.')
          return true
        }
        if (!configuredPermissions.includes(PACKAGE_ADMIN_METHODS[method].administration.permission)) {
          error(response, 403, 'E_ADMIN_PERMISSION', 'The admin permission does not allow this operation.')
          return true
        }
        const result = await options.invoke(name, body)
        if (!validatePackageAdminCall(method, 'result', result).ok) {
          error(response, 502, 'E_ADMIN_RESPONSE', 'The backend response could not be confirmed.')
          return true
        }
        reply(response, 200, result)
      } catch (cause) {
        const reason = record(cause) && record(cause.data) ? cause.data.reason : undefined
        if (name === 'sessions/migrate' && reason === 'session owner unavailable') {
          error(response, 403, 'E_ADMIN_PERMISSION', 'The session is unavailable to this administrator.')
          return true
        }
        if (
          name === 'sessions/migrate' &&
          typeof reason === 'string' &&
          [
            'E_GENERATION_SESSION_OPEN',
            'E_GENERATION_PIN_MISSING',
            'E_GENERATION_SNAPSHOT_MISSING',
            'E_GENERATION_INCOMPATIBLE',
            'E_GENERATION_LOOP_INCOMPATIBLE',
            'E_COMPOSITION_BINDING_MISSING',
          ].includes(reason)
        ) {
          error(
            response,
            409,
            reason,
            reason === 'E_GENERATION_SESSION_OPEN'
              ? 'Close the session before migrating its plugins.'
              : 'The pinned generation cannot migrate to the current plugins; check snapshot and loop compatibility.',
          )
          return true
        }
        // Only validated DTOs may contain backend detail. Exceptions can contain local paths or secrets.
        error(
          response,
          502,
          'E_ADMIN_BACKEND',
          'The operation was not confirmed. Check its status or reconnect to the backend.',
        )
      }
      return true
    },
  }
}
