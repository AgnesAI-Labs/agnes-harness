/** Kind token shared by Host and the official plugin. No ledger, HMAC, or queue implementation. */
import {
  type AgentInputPort,
  type DeferredInvocationReceipt,
  type DeferredToolInvocation,
  type DeferredToolInvocationQueue,
  defineServiceKind,
  type OwnerLedgerPort,
  type ServiceInstance,
  type ServicePorts,
  type ToolDef,
} from '@agnes/extension-api'
import type {
  Actor,
  JsonValue,
  UiActionParams,
  UiActionReceipt,
  UiCloseParams,
  UiReadParams,
  UiReadResult,
  UiRenderParams,
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
