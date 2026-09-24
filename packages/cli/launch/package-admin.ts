import type { IncomingMessage, ServerResponse } from 'node:http'
import { type AdminSurfaceAction, createAdminSurface } from '@agnes/daemon/packages'
import type {
  ClientModuleEffectCallParams,
  ClientModuleServiceCallParams,
  PackageCatalogGetParams,
  PackageCatalogListParams,
  PackageDisableParams,
  PackageEnableParams,
  PackageInspectParams,
  PackageInstallParams,
  PackageListParams,
  PackageOperationCancelParams,
  PackageOperationGetParams,
  PackagePinsInspectParams,
  PackagePinsReleaseParams,
  PackageRemoveParams,
  PackageRollbackParams,
  PackageTrustParams,
  PackageTrustWorkspaceParams,
  PackageUntrustParams,
  PackageUpdateParams,
  PluginTreeApplyParams,
  PluginTreeRollbackParams,
} from '@agnes/protocol'
import { validatePackageAdminCall } from '@agnes/protocol'
import type {
  ClientModuleEffectCallResult,
  ClientModuleServiceCallResult,
} from '@agnes/protocol/gen/package-admin'
import { createClient, memoryJournal } from '@agnes/sdk'
import type { PluginRebuiltEvent } from '@agnes/web/server'
import { localPipeFactories } from '../src/boot/pipe-factory.js'
import type { LocalBackend } from './backend.js'

const CLIENT_SERVICE_PATH = '/api/client-modules/service'
const CLIENT_EFFECT_PATH = '/api/client-modules/effect'
const IDENTITY_KEYS = new Set([
  'actor',
  'auth',
  'authorization',
  'commandid',
  'credential',
  'identity',
  'principal',
  'secret',
  'sessionid',
  'token',
])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cleanValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanValue)
  if (!record(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !IDENTITY_KEYS.has(key.toLowerCase()))
      .map(([key, child]) => [key, cleanValue(child)]),
  )
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') return undefined
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 1_048_576) return undefined
    chunks.push(bytes)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return record(value) ? value : undefined
  } catch {
    return undefined
  }
}

function serviceReply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  response.end(JSON.stringify(value))
}

/** The local launcher's private Unix connection is the admin authority; it is never sent to Web. */
export function localPackageAdmin(backend: LocalBackend, origin: string) {
  if (!backend.web) throw new Error('local Web credential is unavailable')
  const clientId = `admin-web-${backend.scope.scopeID}`
  const client = createClient({
    transport: { kind: 'unix', path: backend.socketPath },
    transportFactories: localPipeFactories(backend.socketPath, backend.scope),
    auth: { kind: 'local' },
    journal: memoryJournal(clientId),
  })
  let ready: Promise<unknown> | undefined
  const initialize = () =>
    (ready ??= client.initialize().catch((error: unknown) => {
      ready = undefined
      throw error
    }))
  // createAdminSurface validates each schema before dispatching this fixed typed mapping.
  const invoke = async (action: AdminSurfaceAction, params: unknown): Promise<unknown> => {
    await initialize()
    switch (action) {
      case 'catalog/list':
        return client.packages.catalog.list(params as PackageCatalogListParams)
      case 'catalog/get':
        return client.packages.catalog.get(params as PackageCatalogGetParams)
      case 'list':
        return client.packages.list(params as PackageListParams)
      case 'inspect':
        return client.packages.inspect(params as PackageInspectParams)
      case 'install':
        return client.packages.install(params as PackageInstallParams)
      case 'trust':
        return client.packages.trust(params as PackageTrustParams)
      case 'untrust':
        return client.packages.untrust(params as PackageUntrustParams)
      case 'enable':
        return client.packages.enable(params as PackageEnableParams)
      case 'disable':
        return client.packages.disable(params as PackageDisableParams)
      case 'update':
        return client.packages.update(params as PackageUpdateParams)
      case 'rollback':
        return client.packages.rollback(params as PackageRollbackParams)
      case 'remove':
        return client.packages.remove(params as PackageRemoveParams)
      case 'operation/get':
        return client.packages.operation.get(params as PackageOperationGetParams)
      case 'operation/cancel':
        return client.packages.operation.cancel(params as PackageOperationCancelParams)
      case 'pins/inspect':
        return client.packages.pins.inspect(params as PackagePinsInspectParams)
      case 'pins/release':
        return client.packages.pins.release(params as PackagePinsReleaseParams)
      case 'trust-workspace':
        return client.packages.trustWorkspace(params as PackageTrustWorkspaceParams)
      case 'tree/get':
        return client.packages.tree.get(params as PackageListParams)
      case 'tree/list':
        return client.packages.tree.list(params as PackageListParams)
      case 'tree/apply':
        return client.packages.tree.apply(params as PluginTreeApplyParams)
      case 'tree/rollback':
        return client.packages.tree.rollback(params as PluginTreeRollbackParams)
    }
  }
  const surface = createAdminSurface({
    origin,
    profile: backend.scope.profile,
    clientId,
    features: [
      'packages.composite-activation.v1',
      'packages.runtime-identity.v1',
      'packages.rollback-target.v1',
      'packages.operation-control.v1',
    ],
    invoke,
    surfaceLinks: async () => {
      await initialize()
      const result = await client.surfaces.mounts()
      return result.mounts.map(({ package: packageId, surfaceId, mount }) => ({
        packageId,
        surfaceId,
        mount,
      }))
    },
  })
  return {
    handle: surface.handle,
    /**
     * Bytes for one `/skins/...` path, for the Web launcher's same-origin asset route.
     *
     * It rides the launcher's existing private package-admin connection rather than opening a second
     * one. The daemon owns path authority and answers only for its enabled+trusted roster; a miss and
     * a refusal are the same `null` here, which the HTTP layer turns into a 404 (design §22).
     */
    async readSkin(pathname: string): Promise<Uint8Array | null> {
      try {
        await initialize()
        const result = await client.skins.read(backend.scope.profile, pathname)
        return result.found ? new Uint8Array(Buffer.from(result.base64, 'base64')) : null
      } catch {
        // An unreachable or refusing daemon is an unavailable asset, not a launcher failure.
        return null
      }
    },
    /**
     * Bytes for one `/plugins/...` path, for the Web launcher's same-origin asset route (design WC3).
     *
     * Same shape as `readSkin`: it rides the same private package-admin connection, the daemon owns
     * path authority and answers only for its enabled+trusted roster snapshots, and a miss, a
     * refusal and an unreachable daemon are the one same `null`, which the HTTP layer turns into a
     * 404.
     */
    async readClientModule(pathname: string): Promise<Uint8Array | null> {
      try {
        await initialize()
        const result = await client.clientModules.read(backend.scope.profile, pathname)
        return result.found ? new Uint8Array(Buffer.from(result.base64, 'base64')) : null
      } catch {
        // An unreachable or refusing daemon is an unavailable asset, not a launcher failure.
        return null
      }
    },
    /**
     * Bridge daemon roster invalidations to the Web server's same-origin SSE endpoint.  Calling
     * `list` first is intentional: the daemon enrolls only connections that proved they can read
     * this profile's roster, so an arbitrary local Unix client cannot subscribe by transport alone.
     */
    async subscribeClientModuleEvents(listener: (event: PluginRebuiltEvent) => void): Promise<() => void> {
      await initialize()
      await client.clientModules.list(backend.scope.profile)
      return client.on('notice', (payload) => {
        const notice = payload as { kind?: unknown; detail?: unknown }
        if (notice.kind !== 'packages_changed' || typeof notice.detail !== 'object' || notice.detail === null)
          return
        const detail = notice.detail as { profile?: unknown; packageId?: unknown; revision?: unknown }
        if (
          detail.profile !== backend.scope.profile ||
          typeof detail.packageId !== 'string' ||
          typeof detail.revision !== 'string'
        )
          return
        listener({ packageId: detail.packageId, revision: detail.revision })
      })
    },
    /**
     * Fixed private relay for a browser module's own declared query service. The caller is the
     * launcher's same-origin BFF, never page JavaScript speaking daemon RPC directly.
     */
    async callClientService(input: ClientModuleServiceCallParams): Promise<ClientModuleServiceCallResult> {
      await initialize()
      return await client.clientModules.callService(input)
    },
    async callClientEffect(input: ClientModuleEffectCallParams): Promise<ClientModuleEffectCallResult> {
      await initialize()
      return await client.clientModules.callEffect(input)
    },
    async handleClientService(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? '/', origin)
      if (url.pathname !== CLIENT_SERVICE_PATH) return false
      if (
        request.method !== 'POST' ||
        url.search ||
        request.headers.host !== new URL(origin).host ||
        request.headers.origin !== origin
      ) {
        request.resume()
        serviceReply(response, 403, { error: 'forbidden' })
        return true
      }
      const body = await jsonBody(request)
      const params = body
        ? {
            profile: backend.scope.profile,
            rowId: body.rowId,
            sessionId: body.sessionId,
            service: body.service,
            input: cleanValue(body.input ?? {}),
          }
        : undefined
      if (!params || !validatePackageAdminCall('_agnes/v1/clientModules.callService', 'params', params).ok) {
        serviceReply(response, 400, { error: 'invalid request' })
        return true
      }
      try {
        const result = await client.clientModules.callService(params as ClientModuleServiceCallParams)
        serviceReply(response, 200, result)
      } catch {
        // No host/worker exception crosses this boundary. A stale/untrusted row and a transient
        // backend failure deliberately look alike to the page.
        serviceReply(response, 503, { error: 'service unavailable' })
      }
      return true
    },
    async handleClientEffect(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? '/', origin)
      if (url.pathname !== CLIENT_EFFECT_PATH) return false
      if (
        request.method !== 'POST' ||
        url.search ||
        request.headers.host !== new URL(origin).host ||
        request.headers.origin !== origin
      ) {
        request.resume()
        serviceReply(response, 403, { error: 'forbidden' })
        return true
      }
      const body = await jsonBody(request)
      const params = body
        ? {
            profile: backend.scope.profile,
            rowId: body.rowId,
            sessionId: body.sessionId,
            service: body.service,
            commandId: body.commandId,
            input: cleanValue(body.input ?? {}),
          }
        : undefined
      if (!params || !validatePackageAdminCall('_agnes/v1/clientModules.callEffect', 'params', params).ok) {
        serviceReply(response, 400, { error: 'invalid request' })
        return true
      }
      try {
        const result = await client.clientModules.callEffect(params as ClientModuleEffectCallParams)
        serviceReply(response, 200, result)
      } catch {
        serviceReply(response, 503, { error: 'effect unavailable or outcome unknown' })
      }
      return true
    },
    async close(): Promise<void> {
      surface.close()
      await client.close()
    },
  }
}
