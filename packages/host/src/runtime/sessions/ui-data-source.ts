/** Session-scoped UI data-source resolution. The plugin calls this and writes the audit. */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { pluginSnapshotIdentity } from '@agnes/host-providers/runtime-plugin-catalogue'
import {
  UI_DATA_SOURCE_RESULTS,
  type UiDataSourceResult,
  type UiSourceAudit,
  type UiSourceFailure,
  type UiSourceResolveInput,
  type UiSourceResolveResult,
  uiDataSourceKind,
} from '@agnes/intelligent-ui-contract'
import {
  capabilityAtoms,
  capabilityHash,
  lockPath,
  RuntimeGenerationSnapshotStore,
  type RuntimeSnapshot,
  readLock,
} from '@agnes/package-manager'
import { decodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import {
  type Actor,
  componentDataValid,
  type JsonValue,
  jcs,
  type UiSurface,
  uiDataBinding,
} from '@agnes/protocol'
import type { UiComponentDeclaration } from '@agnes/protocol/gen/extension-manifest'
import { X_AGNES_UI_LIMITS } from '@agnes/protocol/gen/intelligent-ui'
import { Ajv2020 } from 'ajv/dist/2020.js'

export interface UiDataSourceRegistration {
  readonly id: string
  readonly sourcePackage: string
  readonly permission: string
  readonly result: UiDataSourceResult
  readonly paramsSchema: unknown
}

/** Current enablement for one pinned package. Every flag must hold. */
export interface UiDataSourceGrant {
  readonly enabled: boolean
  readonly trusted: boolean
  readonly hashMatches: boolean
  readonly inGeneration: boolean
  readonly atoms: readonly string[]
}

export type UiDataSourceLookup =
  | { readonly status: 'unknown' }
  | { readonly status: 'denied' }
  | { readonly status: 'ready'; readonly registration: UiDataSourceRegistration }

export interface UiDataSourceCacheEntry {
  readonly sessionKey: string
  readonly actorId: string
  readonly generationId: string
  readonly surfaceId: string
  readonly revision: number
  readonly sourceId: string
  readonly paramsHash: string
  readonly resultHash: string
  readonly data: JsonValue
  readonly bytes: number
  readonly rows: number
  readonly at: number
}

export interface UiDataSourceQuery {
  query(params: JsonValue, signal: AbortSignal): Promise<JsonValue>
  dispose(): Promise<void>
}

export interface UiDataSourceResolverDeps {
  readonly actor: Actor
  readonly generationId: string
  readonly session: { readonly key: string; readonly lane: string; readonly workspaceRoot: string }
  readonly cache: Map<string, UiDataSourceCacheEntry>
  readonly validators: Map<string, ((data: unknown) => boolean) | 'invalid'>
  readonly find: (id: string) => UiDataSourceLookup
  readonly grant: (packageId: string) => UiDataSourceGrant
  readonly open: (registration: UiDataSourceRegistration, signal: AbortSignal) => Promise<UiDataSourceQuery>
  readonly declarations: () => readonly UiComponentDeclaration[]
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly resultBytes?: number
}

const DENIED_GRANT: UiDataSourceGrant = Object.freeze({
  enabled: false,
  trusted: false,
  hashMatches: false,
  inGeneration: false,
  atoms: Object.freeze([]),
})
const stamps = new WeakMap<Map<string, UiDataSourceCacheEntry>, number>()

function digest(value: unknown): string {
  return createHash('sha256').update(jcs(value)).digest('hex')
}

function throwIfCaller(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error('aborted')
  error.name = 'AbortError'
  throw error
}

function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => isJson(item))
  if (typeof value === 'object') return Object.values(value).every((item) => isJson(item))
  return false
}

function resultMatches(result: UiDataSourceResult, data: JsonValue): boolean {
  if (result === 'rows' || result === 'steps') return Array.isArray(data)
  if (result === 'text') return typeof data === 'string'
  if (result === 'image')
    return typeof data === 'string' || (typeof data === 'object' && data !== null && !Array.isArray(data))
  return typeof data === 'object' && data !== null && !Array.isArray(data)
}

export interface UiDataSourceCatalogView {
  catalog(): readonly { kind: string; id: string; version: string; sourcePackage: string }[]
  resolve(
    kind: { readonly kind: string },
    selection: { provider: string; version: string },
  ): { id: string; version: string; permission?: unknown; result?: unknown; paramsSchema?: unknown }
}

/**
 * One catalog row becomes a registration. Zero rows is unknown.
 * Two rows, a resolve failure, or a registration missing permission or result is denied.
 */
export function lookupUiDataSource(providers: UiDataSourceCatalogView, id: string): UiDataSourceLookup {
  let matches: readonly { kind: string; id: string; version: string; sourcePackage: string }[]
  try {
    matches = providers.catalog().filter((entry) => entry.kind === uiDataSourceKind.kind && entry.id === id)
  } catch {
    return { status: 'unknown' }
  }
  const entry = matches.length === 1 ? matches[0] : undefined
  if (!entry) return matches.length === 0 ? { status: 'unknown' } : { status: 'denied' }
  try {
    const provider = providers.resolve(uiDataSourceKind, { provider: entry.id, version: entry.version })
    const result = (UI_DATA_SOURCE_RESULTS as readonly string[]).includes(String(provider.result))
      ? (provider.result as UiDataSourceResult)
      : undefined
    if (typeof provider.permission !== 'string' || !result) return { status: 'denied' }
    return {
      status: 'ready',
      registration: {
        id: provider.id,
        sourcePackage: entry.sourcePackage,
        permission: provider.permission,
        result,
        paramsSchema: provider.paramsSchema,
      },
    }
  } catch {
    return { status: 'denied' }
  }
}

/** Unknown id is not a grant failure. Everything else that is registered but unusable is denied. */
export function uiDataSourceDecision(
  registration: Pick<UiDataSourceRegistration, 'permission'> | undefined,
  grant: UiDataSourceGrant | undefined,
): 'ok' | 'UI_SOURCE_UNKNOWN' | 'UI_SOURCE_DENIED' {
  if (!registration) return 'UI_SOURCE_UNKNOWN'
  if (
    !grant?.enabled ||
    !grant.trusted ||
    !grant.hashMatches ||
    !grant.inGeneration ||
    !grant.atoms.includes(`uiData:${registration.permission}`)
  )
    return 'UI_SOURCE_DENIED'
  return 'ok'
}

export function dropUiDataSourceCache(
  cache: Map<string, UiDataSourceCacheEntry>,
  sessionKey: string,
  surfaceId: string,
): void {
  for (const [key, entry] of cache)
    if (entry.sessionKey === sessionKey && entry.surfaceId === surfaceId) cache.delete(key)
}

function dropSource(cache: Map<string, UiDataSourceCacheEntry>, sessionKey: string, sourceId: string): void {
  for (const [key, entry] of cache)
    if (entry.sessionKey === sessionKey && entry.sourceId === sourceId) cache.delete(key)
}

function retain(cache: Map<string, UiDataSourceCacheEntry>, sessionKey: string, keepSurfaceId: string): void {
  const surfaces = new Map<string, number>()
  for (const entry of cache.values()) {
    if (entry.sessionKey !== sessionKey) continue
    const at = surfaces.get(entry.surfaceId)
    if (at === undefined || entry.at < at) surfaces.set(entry.surfaceId, entry.at)
  }
  while (surfaces.size > X_AGNES_UI_LIMITS.liveSurfaces) {
    let oldest: string | undefined
    let at = Number.POSITIVE_INFINITY
    for (const [id, stamp] of surfaces) {
      if (id === keepSurfaceId) continue
      if (stamp < at) {
        oldest = id
        at = stamp
      }
    }
    if (!oldest) break
    dropUiDataSourceCache(cache, sessionKey, oldest)
    surfaces.delete(oldest)
  }
}

function paramsAccept(
  schema: unknown,
  params: Record<string, JsonValue>,
  validators: Map<string, ((data: unknown) => boolean) | 'invalid'>,
): boolean {
  let key: string
  try {
    key = jcs(schema)
  } catch {
    return false
  }
  let check = validators.get(key)
  if (!check) {
    try {
      const validate = new Ajv2020({
        strict: false,
        allErrors: false,
        validateFormats: false,
        addUsedSchema: false,
      }).compile(schema as object)
      check = (data: unknown) => validate(data) === true
    } catch {
      check = 'invalid'
    }
    validators.set(key, check)
  }
  if (check === 'invalid') return false
  try {
    return check(params)
  } catch {
    return false
  }
}

function dataKeyOf(component: UiSurface['components'][number] | undefined): string | undefined {
  if (!component || !('dataKey' in component) || typeof component.dataKey !== 'string') return undefined
  return component.dataKey
}

function dependentDataKeys(
  surface: UiSurface,
  action: NonNullable<UiSourceResolveInput['action']>,
): Set<string> {
  const keys = new Set<string>()
  const declared = surface.actions.find((item) => item.id === action.actionId)
  for (const binding of Object.values(declared?.argsTemplate ?? {})) {
    if (!('from' in binding)) continue
    if (binding.from === 'data') keys.add(binding.key)
    if (binding.from === 'selection' || binding.from === 'row')
      keys.add(dataKeyOf(surface.components.find((item) => item.id === binding.key)) ?? '')
  }
  for (const id of Object.keys(action.selection))
    keys.add(dataKeyOf(surface.components.find((item) => item.id === id)) ?? '')
  if (action.row) keys.add(dataKeyOf(surface.components.find((item) => item.id === action.row.tableId)) ?? '')
  keys.delete('')
  return keys
}

interface BoundKey {
  readonly dataKey: string
  readonly sourceId: string
  readonly params: Record<string, JsonValue>
  readonly invalid: boolean
}

function boundKeys(surface: UiSurface): BoundKey[] {
  const keys: BoundKey[] = []
  for (const [dataKey, value] of Object.entries(surface.data)) {
    if (uiDataBinding(value)) {
      keys.push({ dataKey, sourceId: value.$source, params: value.params, invalid: false })
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, '$source'))
      keys.push({ dataKey, sourceId: 'invalid', params: {}, invalid: true })
  }
  return keys
}

interface ResolvedKey {
  readonly dataKey: string
  readonly sourceId: string
  readonly failure?: UiSourceFailure
  readonly data?: JsonValue
  readonly resultHash?: string
  readonly audit: UiSourceAudit
  readonly cached: boolean
}

function sealedSnapshotAtoms(snapshot: RuntimeSnapshot): { hashMatches: boolean; atoms: readonly string[] } {
  if (snapshot.dependencies === undefined) return { hashMatches: false, atoms: [] }
  const recomputed = capabilityHash({
    contributions: [...snapshot.contributions],
    dependencies: { ...snapshot.dependencies },
    ...(snapshot.declaredCapabilities === undefined
      ? {}
      : { declaredCapabilities: snapshot.declaredCapabilities }),
  })
  return recomputed === snapshot.capabilityHash
    ? { hashMatches: true, atoms: capabilityAtoms(snapshot.declaredCapabilities) }
    : { hashMatches: false, atoms: [] }
}

/**
 * Re-reads the pinned generation and the current lock.
 * Atoms come from the declaration sealed by capabilityHash, not from a later package.json.
 * A missing generation, a disabled row, or a hash that no longer matches the pin is denied.
 * Live config rows win over the immutable generation artifact when the session has accepted them.
 * An author host with no agnes-lock.json uses the trusted snapshot taken at load time.
 * Once a lock file exists, the lock entry is authoritative: its recomputed hash must equal both
 * the trust decision and the snapshot.
 */
export function loadUiDataSourceGrant(input: {
  profileDir: string
  profile: string
  agnesVersion: string
  generationId: string
  packageId: string
}): UiDataSourceGrant {
  try {
    const store = new RuntimeGenerationSnapshotStore(input.profileDir)
    const generation = store.read(input.generationId)
    const rows = decodeRuntimeTargetArtifact(store.liveConfig(input.generationId) ?? generation.artifact).tree
      .rows
    const sources = generation.sources.filter((source) => source.snapshot.packageId === input.packageId)
    const source = sources.length === 1 ? sources[0] : undefined
    if (!source) return DENIED_GRANT
    let active = false
    for (const row of rows) {
      if (row.disabled) continue
      try {
        if (pluginSnapshotIdentity(row.plugin)?.packageId === input.packageId) active = true
      } catch {
        // A malformed plugin string does not enable this package.
      }
    }
    if (!existsSync(lockPath(input.profileDir))) {
      const trusted = source.trusted === true
      const sealed = sealedSnapshotAtoms(source.snapshot)
      const hashMatches = trusted && sealed.hashMatches
      return {
        enabled: active,
        trusted,
        hashMatches,
        inGeneration: trusted && active,
        atoms: hashMatches ? sealed.atoms : [],
      }
    }
    const entry = readLock(input.profileDir, {
      profile: input.profile,
      agnesVersion: input.agnesVersion,
    }).packages[input.packageId]
    if (!entry) return DENIED_GRANT
    const recomputed = capabilityHash(entry)
    const decisionHash = entry.trustDecision?.capabilityHash
    const hashMatches =
      decisionHash !== undefined &&
      decisionHash === recomputed &&
      recomputed === source.snapshot.capabilityHash
    return {
      enabled: entry.state.enabled === true,
      trusted: source.trusted === true && entry.state.trusted != null,
      hashMatches,
      inGeneration: source.trusted === true && active,
      atoms: hashMatches ? capabilityAtoms(entry.declaredCapabilities) : [],
    }
  } catch {
    return DENIED_GRANT
  }
}

export async function resolveUiDataSources(
  input: UiSourceResolveInput,
  deps: UiDataSourceResolverDeps,
): Promise<UiSourceResolveResult> {
  throwIfCaller(input.signal)
  if (input.purpose === 'action' && !input.action) return { ok: false, code: 'UI_SOURCE_INVALID', audits: [] }
  const open = new Set(input.openSurfaceIds)
  open.add(input.surface.id)
  for (const [key, entry] of deps.cache) {
    if (entry.sessionKey !== deps.session.key) continue
    if (entry.generationId !== deps.generationId || !open.has(entry.surfaceId)) deps.cache.delete(key)
  }
  const wanted =
    input.purpose === 'action' && input.action ? dependentDataKeys(input.surface, input.action) : undefined
  const keys = boundKeys(input.surface).filter((item) => !wanted || wanted.has(item.dataKey))
  const resolved: ResolvedKey[] = []
  for (const key of keys) {
    resolved.push(await resolveKey(input, deps, key))
    const last = resolved.at(-1)!
    if ((input.purpose === 'write' || input.purpose === 'action') && last.failure) break
  }
  const audits = resolved.flatMap((item) => (item.cached ? [] : [item.audit]))
  if (input.purpose === 'write' || input.purpose === 'action') {
    const failed = resolved.find((item) => item.failure)
    if (failed?.failure) return { ok: false, code: failed.failure, dataKey: failed.dataKey, audits }
    if (input.purpose === 'action') {
      const stale = resolved.find((item) => input.action?.sources?.[item.dataKey] !== item.resultHash)
      if (stale) return { ok: false, code: 'UI_STALE', dataKey: stale.dataKey, audits }
    }
  }
  const surface = structuredClone(input.surface)
  const view: Record<string, { status: 'ready' | 'error'; code?: UiSourceFailure; resultHash?: string }> = {}
  for (const item of resolved) {
    if (item.failure || item.data === undefined || !item.resultHash) {
      view[item.dataKey] = {
        status: 'error',
        code: item.failure ?? 'UI_SOURCE_UNAVAILABLE',
      }
      continue
    }
    surface.data[item.dataKey] = structuredClone(item.data)
    view[item.dataKey] = { status: 'ready', resultHash: item.resultHash }
  }
  return { ok: true, surface, sources: view, audits }
}

async function resolveKey(
  input: UiSourceResolveInput,
  deps: UiDataSourceResolverDeps,
  key: BoundKey,
): Promise<ResolvedKey> {
  const started = deps.now?.() ?? Date.now()
  const finish = (
    failure: UiSourceFailure | undefined,
    extra: { resultHash?: string; bytes?: number; rows?: number; data?: JsonValue; cached?: boolean },
  ): ResolvedKey => {
    const name = failure
      ? 'source.refused'
      : input.purpose === 'refresh'
        ? 'source.refreshed'
        : 'source.resolved'
    return {
      dataKey: key.dataKey,
      sourceId: key.sourceId,
      ...(failure ? { failure } : {}),
      ...(extra.data === undefined ? {} : { data: extra.data }),
      ...(extra.resultHash === undefined ? {} : { resultHash: extra.resultHash }),
      cached: extra.cached === true && !failure && input.purpose === 'read',
      audit: {
        name,
        data: {
          sourceId: key.sourceId,
          paramsHash: key.invalid ? digest(null) : digest(key.params),
          durationMs: Math.max(0, (deps.now?.() ?? Date.now()) - started),
          generationId: deps.generationId,
          actorId: deps.actor.id,
          ...(extra.resultHash === undefined
            ? {}
            : { resultHash: extra.resultHash, bytes: extra.bytes ?? 0, rows: extra.rows ?? 0 }),
          ...(failure ? { code: failure } : {}),
        },
      },
    }
  }
  if (key.invalid) return finish('UI_SOURCE_INVALID', {})
  const found = deps.find(key.sourceId)
  if (found.status === 'unknown') return finish('UI_SOURCE_UNKNOWN', {})
  if (found.status === 'denied') return finish('UI_SOURCE_DENIED', {})
  const registration = found.registration
  const decision = uiDataSourceDecision(registration, deps.grant(registration.sourcePackage))
  if (decision !== 'ok') {
    dropSource(deps.cache, deps.session.key, registration.id)
    return finish(decision, {})
  }
  if (!paramsAccept(registration.paramsSchema, key.params, deps.validators))
    return finish('UI_SOURCE_INVALID', {})
  const paramsHash = digest(key.params)
  const cacheKey = [
    deps.session.key,
    deps.actor.id,
    deps.generationId,
    input.surface.id,
    String(input.surface.revision),
    registration.id,
    paramsHash,
  ].join('\0')
  if (input.purpose === 'read') {
    const hit = deps.cache.get(cacheKey)
    if (hit) {
      const again = uiDataSourceDecision(registration, deps.grant(registration.sourcePackage))
      if (again !== 'ok') {
        dropSource(deps.cache, deps.session.key, registration.id)
        return finish(again, {})
      }
      return finish(undefined, {
        data: structuredClone(hit.data),
        resultHash: hit.resultHash,
        bytes: hit.bytes,
        rows: hit.rows,
        cached: true,
      })
    }
  }
  throwIfCaller(input.signal)
  let opened: UiDataSourceQuery
  try {
    opened = await deps.open(registration, input.signal)
  } catch {
    throwIfCaller(input.signal)
    return finish('UI_SOURCE_UNAVAILABLE', {})
  }
  const queried = await querySource(
    opened,
    key.params,
    input.signal,
    deps.timeoutMs ?? X_AGNES_UI_LIMITS.sourceTimeoutMs,
  )
  if (!queried.ok) return finish(queried.code, {})
  if (!isJson(queried.data)) return finish('UI_SOURCE_UNAVAILABLE', {})
  let encoded: string
  try {
    encoded = jcs(queried.data)
  } catch {
    return finish('UI_SOURCE_UNAVAILABLE', {})
  }
  const bytes = Buffer.byteLength(encoded)
  if (bytes > (deps.resultBytes ?? X_AGNES_UI_LIMITS.sourceResultBytes))
    return finish('UI_SOURCE_TOO_LARGE', {})
  if (!resultMatches(registration.result, queried.data)) return finish('UI_SOURCE_SHAPE', {})
  let declarations: readonly UiComponentDeclaration[]
  try {
    declarations = deps.declarations()
  } catch {
    return finish('UI_SOURCE_UNAVAILABLE', {})
  }
  try {
    for (const component of input.surface.components) {
      if (!('dataKey' in component) || component.dataKey !== key.dataKey) continue
      if (!componentDataValid(component, queried.data, declarations)) return finish('UI_SOURCE_SHAPE', {})
    }
  } catch {
    return finish('UI_SOURCE_SHAPE', {})
  }
  const renewed = uiDataSourceDecision(registration, deps.grant(registration.sourcePackage))
  if (renewed !== 'ok') {
    dropSource(deps.cache, deps.session.key, registration.id)
    return finish(renewed, {})
  }
  const rows = Array.isArray(queried.data) ? queried.data.length : 0
  const resultHash = createHash('sha256').update(encoded).digest('hex')
  const at = (stamps.get(deps.cache) ?? 0) + 1
  stamps.set(deps.cache, at)
  deps.cache.set(cacheKey, {
    sessionKey: deps.session.key,
    actorId: deps.actor.id,
    generationId: deps.generationId,
    surfaceId: input.surface.id,
    revision: input.surface.revision,
    sourceId: registration.id,
    paramsHash,
    resultHash,
    data: structuredClone(queried.data),
    bytes,
    rows,
    at,
  })
  retain(deps.cache, deps.session.key, input.surface.id)
  return finish(undefined, { data: queried.data, resultHash, bytes, rows })
}

async function querySource(
  opened: UiDataSourceQuery,
  params: JsonValue,
  caller: AbortSignal,
  timeoutMs: number,
): Promise<{ ok: true; data: unknown } | { ok: false; code: 'UI_SOURCE_TIMEOUT' | 'UI_SOURCE_UNAVAILABLE' }> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const linked = AbortSignal.any([caller, timeout])
  try {
    const data = await Promise.race([
      opened.query(params, linked),
      new Promise<never>((_resolve, reject) => {
        if (linked.aborted) reject(linked.reason)
        else linked.addEventListener('abort', () => reject(linked.reason), { once: true })
      }),
    ])
    return { ok: true, data }
  } catch {
    throwIfCaller(caller)
    return { ok: false, code: timeout.aborted ? 'UI_SOURCE_TIMEOUT' : 'UI_SOURCE_UNAVAILABLE' }
  } finally {
    await opened.dispose().catch(() => undefined)
  }
}
