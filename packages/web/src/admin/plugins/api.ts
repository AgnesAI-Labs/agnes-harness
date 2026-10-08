import type {
  AdminLoop,
  AdminModelAdapter,
  PackageActivationRequest,
  PackageCatalogDescriptor,
  PackageCatalogPage,
  PackageListResult,
  PackageOperation,
  PackageOperationReceipt,
  PackagePinsInspectResult,
  PackagePinsReleaseResult,
  PackageSource,
  PluginGenerationStatus,
  PluginPublicationStatusResult,
  PluginTreeApplyResult,
  PluginTreeRollbackResult,
  PluginTreeView,
  SessionDefaultsSnapshot,
  SessionGenerationMigrationResult,
} from '@agnes/protocol'
import {
  ChildEnginesSaveParams,
  ChildEnginesState,
  CompositionCapabilitySnapshot,
  isAdminLoop,
  isAdminModelAdapter,
  isSessionDefaultsSnapshot,
  type PackageAdminMethodName,
  RuntimeAdminSnapshot,
  validateAgainst,
  validatePackageAdminCall,
  validatePackageAdminData,
} from '@agnes/protocol'
import type { AdminContext, AdminError, AdminSurfaceLinksResult } from './types.js'

export const ADMIN_API_ROOT = '/admin/plugins/api'

type FetchLike = typeof fetch
const METHOD_BY_PATH = {
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
type AdminPath = keyof typeof METHOD_BY_PATH

type ErrorResponse = {
  error?: { code?: unknown; message?: unknown; blockers?: unknown }
}

export class AdminApiError extends Error {
  readonly details: AdminError

  constructor(details: AdminError) {
    super(details.message)
    this.name = 'AdminApiError'
    this.details = details
  }
}

function safeError(
  value: unknown,
  fallback = 'The admin backend is temporarily unavailable. Try again later.',
): AdminError {
  if (!value || typeof value !== 'object') return { code: 'ADMIN_UNAVAILABLE', message: fallback }
  const error = value as ErrorResponse
  const code = typeof error.error?.code === 'string' ? error.error.code : 'ADMIN_UNAVAILABLE'
  const message = typeof error.error?.message === 'string' ? error.error.message : fallback
  return { code, message }
}

function commandId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return `web-${crypto.randomUUID()}`
  return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function intentFingerprint(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${value.length.toString(16)}-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
    .toString(16)
    .padStart(8, '0')}`
}

/**
 * Browser-only facade over the fixed admin BFF routes. It never exposes a daemon method name,
 * source credential, or transport credential to the page.
 */
export class PluginAdminApi {
  readonly #fetch: FetchLike
  readonly #context: AdminContext

  constructor(context: AdminContext, fetcher: FetchLike = fetch) {
    this.#context = context
    this.#fetch = fetcher
  }

  static async context(fetcher: FetchLike = fetch): Promise<AdminContext> {
    const response = await fetcher(`${ADMIN_API_ROOT}/context`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    const body = await json(response)
    if (!response.ok)
      throw new AdminApiError(
        safeError(body, response.status === 403 ? 'You do not have plugin admin permission.' : undefined),
      )
    if (!isContext(body))
      throw new AdminApiError({
        code: 'ADMIN_CONTEXT_INVALID',
        message: 'The admin context is invalid; reopen the page.',
      })
    return body
  }

  async publicationStatus(): Promise<PluginPublicationStatusResult> {
    return this.#post('publication-status', { profile: this.#context.profile })
  }

  async migrateSession(sessionId: string): Promise<SessionGenerationMigrationResult> {
    return this.#effect<{ sessionId: string }, SessionGenerationMigrationResult>('sessions/migrate', {
      sessionId,
    })
  }

  async generations(): Promise<PluginGenerationStatus> {
    return this.#post('generations', { profile: this.#context.profile })
  }

  async list(): Promise<PackageListResult> {
    return this.#post('list', { profile: this.#context.profile })
  }

  async loops(): Promise<
    SessionDefaultsSnapshot & { loops: readonly AdminLoop[]; presets?: readonly string[] }
  > {
    const body = await this.#selection('loops')
    if (
      !isSessionDefaultsSnapshot(pickDefaults(body)) ||
      !body ||
      typeof body !== 'object' ||
      !('loops' in body) ||
      !Array.isArray(body.loops) ||
      body.loops.length > 4096 ||
      !body.loops.every(isAdminLoop) ||
      ('presets' in body &&
        (!Array.isArray(body.presets) ||
          body.presets.length > 4096 ||
          !body.presets.every((preset) => isSessionDefaultsSnapshot({ revision: 0, defaults: { preset } }))))
    )
      throw invalidSelection()
    return body as SessionDefaultsSnapshot & { loops: readonly AdminLoop[]; presets?: readonly string[] }
  }

  async modelAdapters(): Promise<{ modelAdapters: readonly AdminModelAdapter[] }> {
    const body = await this.#selection('model-adapters')
    if (
      !body ||
      typeof body !== 'object' ||
      !('modelAdapters' in body) ||
      !Array.isArray(body.modelAdapters) ||
      body.modelAdapters.length > 4096 ||
      !body.modelAdapters.every(isAdminModelAdapter)
    )
      throw invalidSelection()
    return body as { modelAdapters: readonly AdminModelAdapter[] }
  }

  async saveDefaults(input: SessionDefaultsSnapshot): Promise<SessionDefaultsSnapshot> {
    if (!isSessionDefaultsSnapshot(input)) throw invalidSelection()
    const body = await this.#selection('defaults', input)
    if (!isSessionDefaultsSnapshot(body)) throw invalidSelection()
    return body
  }

  async bundles(): Promise<BundleSnapshot> {
    const body = await this.#selection('bundles')
    if (!isBundleSnapshot(body)) throw invalidSelection()
    return body
  }

  async saveBundles(input: { revision: number; bundles: string[] }): Promise<void> {
    const body = await this.#selection('bundles', input)
    if (!body || typeof body !== 'object' || !('effect' in body) || body.effect !== 'restart-required')
      throw invalidSelection()
  }

  async composition(preset?: string): Promise<import('@agnes/protocol').CompositionCapabilitySnapshot> {
    const body = await this.#selection('composition', preset ? { preset } : undefined)
    if (!validateAgainst(CompositionCapabilitySnapshot, body).ok) throw invalidSelection()
    return body as import('@agnes/protocol').CompositionCapabilitySnapshot
  }

  async runtime(): Promise<import('@agnes/protocol').RuntimeAdminSnapshot> {
    const body = await this.#selection('runtime')
    if (!validateAgainst(RuntimeAdminSnapshot, body).ok) throw invalidSelection()
    return body as import('@agnes/protocol').RuntimeAdminSnapshot
  }

  async childEngines(): Promise<ChildEnginesState> {
    const body = await this.#selection('child-engines')
    if (!validateAgainst(ChildEnginesState, body).ok) throw invalidSelection()
    return body as ChildEnginesState
  }

  async saveChildEngines(input: ChildEnginesSaveParams): Promise<ChildEnginesState> {
    if (!validateAgainst(ChildEnginesSaveParams, input).ok) throw invalidSelection()
    const body = await this.#selection('child-engines', input)
    if (!validateAgainst(ChildEnginesState, body).ok) throw invalidSelection()
    return body as ChildEnginesState
  }

  async reloadLocal(): Promise<void> {
    const fetcher = this.#fetch
    const response = await fetcher('/admin/api/reload-local', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!response.ok) throw new AdminApiError(safeError(await json(response)))
  }

  async #selection(
    path: string,
    input?:
      | SessionDefaultsSnapshot
      | ChildEnginesSaveParams
      | { revision: number; bundles: string[] }
      | { preset: string },
  ): Promise<unknown> {
    const fetcher = this.#fetch
    const response = await fetcher(`/admin/api/${path}`, {
      method: input ? (path === 'composition' ? 'POST' : 'PUT') : 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(input ? { 'Content-Type': 'application/json' } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}),
    })
    const body = await json(response)
    if (!response.ok) throw new AdminApiError(safeError(body))
    return body
  }

  async treeGet(): Promise<PluginTreeView> {
    return this.#post('tree/get', { profile: this.#context.profile })
  }

  async treeList(): Promise<PluginTreeView> {
    return this.#post('tree/list', { profile: this.#context.profile })
  }

  async treeApply(artifact: PluginTreeView['desired']): Promise<PluginTreeApplyResult> {
    return this.#effect('tree/apply', { artifact })
  }

  async treeRollback(): Promise<PluginTreeRollbackResult> {
    return this.#effect('tree/rollback', {})
  }

  async surfaceLinks(): Promise<AdminSurfaceLinksResult> {
    const fetcher = this.#fetch
    const response = await fetcher(`${ADMIN_API_ROOT}/surfaces`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    const result = await json(response)
    if (!response.ok) throw new AdminApiError(safeError(result))
    if (!isSurfaceLinksResult(result))
      throw new AdminApiError({
        code: 'ADMIN_RESPONSE_INVALID',
        message: 'The backend returned data that cannot be verified.',
      })
    return result
  }

  async catalog(query?: string, cursor?: string): Promise<PackageCatalogPage> {
    return this.#post('catalog/list', {
      profile: this.#context.profile,
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
      limit: 50,
    })
  }

  async catalogGet(id: string, version?: string): Promise<PackageCatalogDescriptor> {
    return this.#post('catalog/get', {
      profile: this.#context.profile,
      id,
      ...(version ? { version } : {}),
    })
  }

  async inspect(source: PackageSource): Promise<PackageOperationReceipt> {
    return this.#effect('inspect', { source })
  }

  async install(source: PackageSource, expectedIntegrity: string): Promise<PackageOperationReceipt> {
    return this.#effect('install', { source, expectedIntegrity })
  }

  async trust(
    id: string,
    expectedIntegrity: string,
    capabilityHash: string,
  ): Promise<PackageOperationReceipt> {
    return this.#effect('trust', { id, expectedIntegrity, capabilityHash })
  }

  async untrust(
    id: string,
    expectedIntegrity: string,
    capabilityHash: string,
  ): Promise<PackageOperationReceipt> {
    return this.#effect('untrust', { id, expectedIntegrity, capabilityHash })
  }

  async enable(id: string): Promise<PackageOperationReceipt> {
    return this.#effect('enable', { id })
  }

  async enableChecked(
    id: string,
    expectedInstalledIntegrity: string,
    expectedActiveIntegrity: string | null,
  ): Promise<PackageOperationReceipt> {
    return this.#effect('enable', {
      id,
      expectedInstalledIntegrity,
      expectedActiveIntegrity,
    })
  }

  async disable(id: string): Promise<PackageOperationReceipt> {
    return this.#effect('disable', { id })
  }

  async update(
    id: string,
    source: PackageSource,
    expectedIntegrity: string,
    activation?: PackageActivationRequest,
  ): Promise<PackageOperationReceipt> {
    return this.#effect('update', {
      id,
      source,
      expectedIntegrity,
      ...(activation ? { activation } : {}),
    })
  }

  async rollback(
    id: string,
    expectedTargetIntegrity?: string,
    activation?: PackageActivationRequest,
  ): Promise<PackageOperationReceipt> {
    return this.#effect('rollback', {
      id,
      ...(expectedTargetIntegrity ? { expectedTargetIntegrity } : {}),
      ...(activation ? { activation } : {}),
    })
  }

  async remove(id: string): Promise<PackageOperationReceipt> {
    return this.#effect('remove', { id })
  }

  async operation(operationId: string): Promise<PackageOperation> {
    return this.#post('operation/get', {
      profile: this.#context.profile,
      operationId,
    })
  }

  async cancel(operationId: string): Promise<PackageOperationReceipt> {
    return this.#effect('operation/cancel', { operationId })
  }

  async pinsInspect(): Promise<PackagePinsInspectResult> {
    return this.#post('pins/inspect', { profile: this.#context.profile })
  }

  async pinsRelease(pinIds: string[]): Promise<PackagePinsReleaseResult> {
    return this.#effect<{ pinIds: string[] }, PackagePinsReleaseResult>('pins/release', { pinIds })
  }

  async #effect<T extends Record<string, unknown>, R = PackageOperationReceipt>(
    path: AdminPath,
    params: T,
  ): Promise<R> {
    const payload = {
      profile: this.#context.profile,
      clientId: this.#context.clientId,
      ...params,
    }
    const storageKey = this.#intentStorageKey(path, payload)
    const storage = typeof sessionStorage === 'undefined' ? undefined : sessionStorage
    const stableCommandId = storageKey ? storage?.getItem(storageKey) || commandId() : commandId()
    if (storageKey) storage?.setItem(storageKey, stableCommandId)
    // A transport failure exits before the removal below, retaining this identity for an
    // idempotent explicit retry. A successful response clears it.
    const result = await this.#post<R>(path, {
      ...payload,
      commandId: stableCommandId,
    })
    if (storageKey) storage?.removeItem(storageKey)
    return result
  }

  #intentStorageKey(path: AdminPath, payload: object): string | undefined {
    if (!this.#context.authScope) return undefined
    return `agnes-plugin-intent:${this.#context.authScope}:${this.#context.profile}:${path}:${intentFingerprint(JSON.stringify(payload))}`
  }

  async #post<T>(path: AdminPath, body: object): Promise<T> {
    const method = METHOD_BY_PATH[path]
    if (!validatePackageAdminCall(method, 'params', body).ok)
      throw new AdminApiError({
        code: 'ADMIN_REQUEST_INVALID',
        message: 'The admin request arguments are invalid.',
      })
    // Calling a stored native fetch as `this.#fetch(...)` rebinds its receiver to this facade.
    // Keep it unbound so browser fetch retains its required global receiver.
    const fetcher = this.#fetch
    const response = await fetcher(`${ADMIN_API_ROOT}/${path}`, {
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
      throw new AdminApiError(
        safeError(
          result,
          response.status === 403 ? 'You do not have permission to perform this action.' : undefined,
        ),
      )
    if (!validatePackageAdminCall(method, 'result', result).ok)
      throw new AdminApiError({
        code: 'ADMIN_RESPONSE_INVALID',
        message: 'The backend returned data that cannot be verified.',
      })
    return result as T
  }
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function isContext(value: unknown): value is AdminContext {
  return validatePackageAdminData('PackageAdminContext', value).ok
}

function isSurfaceLinksResult(value: unknown): value is AdminSurfaceLinksResult {
  if (!value || typeof value !== 'object' || !('surfaces' in value)) return false
  const surfaces = (value as { surfaces?: unknown }).surfaces
  if (!Array.isArray(surfaces) || surfaces.length > 256) return false
  return surfaces.every(
    (surface) =>
      !!surface &&
      typeof surface === 'object' &&
      Object.keys(surface).length === 3 &&
      typeof surface.packageId === 'string' &&
      typeof surface.surfaceId === 'string' &&
      typeof surface.mount === 'string' &&
      /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)$/.test(
        surface.packageId,
      ) &&
      surface.packageId.length <= 256 &&
      /^[a-z][a-z0-9-]{0,63}$/.test(surface.surfaceId) &&
      /^\/(?!_agnes(?:\/|$))[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(surface.mount) &&
      surface.mount.length <= 256,
  )
}

function pickDefaults(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined
  const { revision, defaults } = value as SessionDefaultsSnapshot
  return { revision, defaults }
}
function invalidSelection(): AdminApiError {
  return new AdminApiError({
    code: 'ADMIN_RESPONSE_INVALID',
    message: 'The backend returned data that cannot be verified.',
  })
}

export type BundleSnapshot = {
  revision: number
  bundles: string[]
  effect: 'restart-required'
  catalog: { id: string; sourcePackage: string; label?: string; displayName?: string; version?: string }[]
}
function isBundleSnapshot(value: unknown): value is BundleSnapshot {
  if (!value || typeof value !== 'object') return false
  const data = value as BundleSnapshot
  return (
    Number.isSafeInteger(data.revision) &&
    data.revision >= 0 &&
    data.effect === 'restart-required' &&
    Array.isArray(data.bundles) &&
    data.bundles.length <= 64 &&
    data.bundles.every((id) => typeof id === 'string' && id.length <= 512) &&
    Array.isArray(data.catalog) &&
    data.catalog.length <= 4096 &&
    data.catalog.every(
      (entry) =>
        !!entry &&
        typeof entry.id === 'string' &&
        entry.id.length <= 512 &&
        typeof entry.sourcePackage === 'string' &&
        entry.sourcePackage.length <= 256,
    )
  )
}
