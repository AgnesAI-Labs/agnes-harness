import type {
  Actor,
  EventEnvelope,
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
import type { Disposer, SessionRef } from './common.js'
import type {
  DeferredInvocationReceipt,
  DeferredToolInvocation,
  DeferredToolInvocationQueue,
} from './deferred-invocations.js'
import type { ToolDef } from './tool.js'

/** Owner-bound ledger and existing SC1/deferred ports; these confer no tool execution authority. */
export interface IntelligentUiPorts {
  readonly session: SessionRef
  readonly owner: string
  readonly lastSeq: number
  readonly taskId: string
  readonly supportsDeferredInvocations: boolean
  readonly queue: DeferredToolInvocationQueue
  scan(): Promise<readonly EventEnvelope[]>
  append(name: string, data: JsonValue, sourceSeq?: number): Promise<number>
  tools(): readonly Pick<ToolDef, 'name' | 'parameters'>[]
  deliver(key: string, text: string, actor: Actor, signal: AbortSignal): Promise<number>
  now(): number
}
export interface IntelligentUiService {
  render(input: UiRenderParams, signal: AbortSignal): Promise<UiSurfaceRecord>
  update(input: UiUpdateParams, signal: AbortSignal): Promise<UiSurfaceRecord>
  close(input: UiCloseParams, signal: AbortSignal): Promise<UiSurfaceRecord>
  action(input: UiActionParams, actor: Actor, signal: AbortSignal): Promise<UiActionReceipt>
  read(input: UiReadParams, signal: AbortSignal): Promise<UiReadResult>
  validate(invocation: DeferredToolInvocation, signal: AbortSignal): Promise<void>
  changed(receipt: DeferredInvocationReceipt, signal: AbortSignal): Promise<void>
}
export type IntelligentUiFactory = (ports: IntelligentUiPorts) => IntelligentUiService
/** Registration requires the owner's existing events/projection grants. Session selectors are Host-bound. */
export interface IntelligentUiExtensionPort {
  register(factory: IntelligentUiFactory): Disposer
  session(ref: SessionRef): IntelligentUiService
}
