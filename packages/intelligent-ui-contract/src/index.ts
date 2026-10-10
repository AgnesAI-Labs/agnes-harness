/** Kind token shared by Host and the official plugin. No ledger, HMAC, or queue implementation. */
import {
  type AgentInputPort,
  defineServiceKind,
  type OwnerLedgerPort,
  type ServiceInstance,
  type ServicePorts,
  type ServiceProvider,
  type ToolDef,
} from '@agnes/extension-api'
import type {
  DeferredInvocationReceipt,
  DeferredToolInvocation,
  DeferredToolInvocationQueue,
} from '@agnes/plugin-runtime/deferred-contract'
import type {
  Actor,
  JsonValue,
  UiActionParams,
  UiActionReceipt,
  UiCloseParams,
  UiReadParams,
  UiReadResult,
  UiRefreshParams,
  UiRenderParams,
  UiSourceStatus,
  UiSurface,
  UiSurfaceRecord,
  UiUpdateParams,
} from '@agnes/protocol'
import type { UiComponentDeclaration } from '@agnes/protocol/gen/extension-manifest'

export const UI_OWNER = 'agnes/intelligent-ui'
export const UI_PREFIX = `x/${UI_OWNER}/`
export const UI_PROVIDER_ID = 'agnes/intelligent-ui'
export const UI_PROVIDER_VERSION = '0.1.0'
export const UI_EVENTS = [
  'surface.opened',
  'surface.updated',
  'surface.closed',
  'action.received',
  'action.rejected',
  'action.pending-approval',
  'action.executing',
  'action.succeeded',
  'action.failed',
  'action.retried',
  'action.delivered',
] as readonly string[]

/**
 * Resolution audits on the Intelligent UI ledger. They stay off `UI_EVENTS`,
 * so fold, projection, and the manifest input list ignore them.
 */
export const UI_SOURCE_EVENTS = ['source.resolved', 'source.refused', 'source.refreshed'] as const
export type UiSourceEventName = (typeof UI_SOURCE_EVENTS)[number]

/** Read-only catalog the surface checker uses. Privileged lookup stays on the host. */
export interface IntelligentUiCatalog {
  components?(): readonly UiComponentDeclaration[]
  tools(): readonly Pick<ToolDef, 'name' | 'parameters'>[]
}

/**
 * Host-assembled business dependencies. They are not generic service ports:
 * the deferred queue, pinned component declarations, and tool schemas stay here.
 */
export interface IntelligentUiCapabilities extends IntelligentUiCatalog {
  taskId(): string
  supportsDeferredInvocations: boolean
  queue: DeferredToolInvocationQueue
  invocationId(toolUseId: string): Promise<string | undefined>
  /** Actor admitted with this bind. A missing or different actor fails closed. */
  authenticatedActor?: Actor
  /**
   * Host resolver. A literal surface never calls it.
   * A binding fails closed when this is absent.
   */
  resolveSources?(input: UiSourceResolveInput): Promise<UiSourceResolveResult>
  /** Drops one surface from the host resolution cache. */
  dropSources?(surfaceId: string): void
}

export interface IntelligentUiServicePorts extends ServicePorts {
  readonly ledger: OwnerLedgerPort
  readonly input: AgentInputPort
  readonly capabilities: IntelligentUiCapabilities
}

export interface IntelligentUiInstance extends ServiceInstance {
  submittedInput(toolUseId: string, args: JsonValue, signal: AbortSignal): Promise<JsonValue>
  render(input: UiRenderParams, signal: AbortSignal): Promise<UiSurfaceRecord>
  update(input: UiUpdateParams, signal: AbortSignal): Promise<UiSurfaceRecord>
  close(input: UiCloseParams, signal: AbortSignal): Promise<UiSurfaceRecord>
  action(input: UiActionParams, actor: Actor, signal: AbortSignal): Promise<UiActionReceipt>
  read(input: UiReadParams, signal: AbortSignal): Promise<UiReadResult>
  /** Re-queries bindings for one open surface. Does not write a surface revision. */
  refresh(input: UiRefreshParams, signal: AbortSignal): Promise<UiSurfaceRecord>
  validate(invocation: DeferredToolInvocation, signal: AbortSignal): Promise<void>
  changed(receipt: DeferredInvocationReceipt, signal: AbortSignal): Promise<void>
}

/**
 * One provider per session, pinned to that session's generation.
 * Ledger, input, and projections are the whole grant.
 */
export const intelligentUiKind = defineServiceKind<IntelligentUiInstance, IntelligentUiServicePorts>({
  kind: 'intelligent-ui',
  cardinality: 'single',
  instanceScope: 'session',
  scope: 'generation',
  ports: ['ledger', 'input', 'projections'],
})

/** Closed set returned to callers. Raw source errors stay off this list. */
export const UI_SOURCE_FAILURES = Object.freeze([
  'UI_SOURCE_DENIED',
  'UI_SOURCE_UNKNOWN',
  'UI_SOURCE_INVALID',
  'UI_SOURCE_TIMEOUT',
  'UI_SOURCE_TOO_LARGE',
  'UI_SOURCE_SHAPE',
  'UI_SOURCE_UNAVAILABLE',
] as const)
export type UiSourceFailure = (typeof UI_SOURCE_FAILURES)[number]

/** Fields the ledger may store. No params, rows, or source error text. */
export interface UiSourceAudit {
  readonly name: UiSourceEventName
  readonly data: {
    readonly sourceId: string
    readonly paramsHash: string
    readonly resultHash?: string
    readonly bytes?: number
    readonly rows?: number
    readonly durationMs: number
    readonly generationId: string
    readonly actorId: string
    readonly code?: UiSourceFailure
  }
}

export interface UiSourceResolveInput {
  readonly purpose: 'read' | 'write' | 'refresh' | 'action'
  readonly surface: UiSurface
  readonly openSurfaceIds: readonly string[]
  readonly action?: UiActionParams
  readonly signal: AbortSignal
}

export type UiSourceResolveResult =
  | {
      readonly ok: true
      readonly surface: UiSurface
      readonly sources: Record<string, UiSourceStatus>
      readonly audits: readonly UiSourceAudit[]
    }
  | {
      readonly ok: false
      readonly code: UiSourceFailure | 'UI_STALE'
      readonly dataKey?: string
      readonly audits: readonly UiSourceAudit[]
    }

/** Surface `$source` id. One registration uses one id. */
export const UI_DATA_SOURCE_ID_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+$/
export const UI_DATA_SOURCE_ID_MAX_LENGTH = 128
/**
 * Manifest `uiData` item. Trust covers the atom `uiData:<permission>`.
 * Resolution accepts that exact atom and no other grant.
 */
export const UI_DATA_PERMISSION_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/
export const UI_DATA_PERMISSION_MAX_LENGTH = 128

export const UI_DATA_SOURCE_RESULTS = Object.freeze([
  'rows',
  'object',
  'text',
  'steps',
  'progress',
  'image',
] as const)
export type UiDataSourceResult = (typeof UI_DATA_SOURCE_RESULTS)[number]

/** Descriptor capabilities attached on bind. Not a service port, and not taken from query params. */
export interface UiDataSourceCapabilities {
  readonly actor: Actor
  readonly session: {
    readonly key: string
    readonly lane: string
    readonly workspaceRoot: string
  }
  readonly generationId: string
}

export interface UiDataSourcePorts extends ServicePorts {
  readonly capabilities: UiDataSourceCapabilities
}

export interface UiDataSourceInstance extends ServiceInstance {
  query(params: JsonValue, signal: AbortSignal): Promise<JsonValue>
}

/** Closed object schema. Registration requires `additionalProperties: false`. */
export interface UiDataSourceParamsSchema {
  readonly type: 'object'
  readonly additionalProperties: false
  readonly properties?: Readonly<Record<string, unknown>>
  readonly required?: readonly string[]
}

export interface UiDataSourceProvider extends ServiceProvider<UiDataSourceInstance, UiDataSourcePorts> {
  readonly paramsSchema: UiDataSourceParamsSchema
  readonly result: UiDataSourceResult
  /** Manifest `uiData` permission. The trust decision's capability hash covers `uiData:<permission>`. */
  readonly permission: string
  /** Optional `refresh`. Any other name is rejected. Distinct from descriptor capabilities. */
  readonly capabilities: readonly 'refresh'[]
}

const UI_DATA_SOURCE_RESULT_SET = new Set<string>(UI_DATA_SOURCE_RESULTS)

function closedParamsSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const schema = value as Record<string, unknown>
  return schema.type === 'object' && schema.additionalProperties === false
}

function permissionOk(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 3 &&
    value.length <= UI_DATA_PERMISSION_MAX_LENGTH &&
    UI_DATA_PERMISSION_PATTERN.test(value)
  )
}

function refreshCapabilities(value: unknown): value is readonly 'refresh'[] {
  return (
    Array.isArray(value) && new Set(value).size === value.length && value.every((item) => item === 'refresh')
  )
}

/**
 * Many sources per generation. Each source is its own provider id.
 * The host binds one id inside the verified source package. Ports stay empty.
 */
export const uiDataSourceKind = defineServiceKind<UiDataSourceInstance, UiDataSourcePorts>({
  kind: 'ui-data-source',
  cardinality: 'multi',
  instanceScope: 'request',
  scope: 'generation',
  ports: [],
  validate(provider) {
    const source = provider as UiDataSourceProvider
    if (source.id.length > UI_DATA_SOURCE_ID_MAX_LENGTH || !UI_DATA_SOURCE_ID_PATTERN.test(source.id))
      throw new Error('ui data source id is invalid')
    if (!closedParamsSchema(source.paramsSchema))
      throw new Error('ui data source params schema must set additionalProperties to false')
    if (!UI_DATA_SOURCE_RESULT_SET.has(source.result)) throw new Error('ui data source result is invalid')
    if (!permissionOk(source.permission)) throw new Error('ui data source permission is invalid')
    if (!refreshCapabilities(source.capabilities)) throw new Error('ui data source capabilities are invalid')
  },
})
