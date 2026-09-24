import { HOOK_EVENTS as PROTOCOL_HOOK_EVENTS } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/gen/hooks'
import type { AiErrorCode } from '@agnes/protocol/gen/model'
import type { Actor, JsonValue } from '@agnes/protocol/gen/session-v1'
import type { LeaseView, Logger, PlatformFacts, Seq, SessionRef } from './common.js'
import type { ProjectionReader } from './projections.js'
import type { ResourceEntry } from './resources.js'
import type { PlanItem, ToolMeta, ToolResult } from './tool.js'
import type { HookInvocationSnapshot } from './workspace-hooks.js'

export const HOOK_EVENTS = Object.freeze([...PROTOCOL_HOOK_EVENTS] as const)
export type HookEvent = (typeof HOOK_EVENTS)[number]

export type HookSpec = {
  mode: 'emit' | 'parallel' | 'serial' | 'waterfall'
  category: 'observe' | 'transform' | 'directive'
  failPolicy: 'open' | 'closed'
  timeoutMs: number
  replayOnResume: boolean
}

export type PromptSection = { id: string; order: number; content: string; source?: string }
export type SurfaceNode = {
  seq: Seq
  type: 'user/message' | 'assistant/message' | 'tool/result' | 'summary'
  pinned?: boolean
  tokensEstimate?: number
}
export type ReadonlyRequestView = {
  readonly model: string
  readonly slot: string
  readonly messageCount: number
  readonly toolNames: readonly string[]
  readonly samplingParams: Readonly<Record<string, JsonValue>>
  readonly maxTokens?: number
}
export type ApprovalRequest = {
  tool: string
  argv: JsonValue
  risk: 'destructive' | 'always' | 'budget'
  actor: Actor
  context?: string
  summary?: string
}
export type CompactionPlan = Omit<Wire.CompactionPlan, 'summarizeRange' | 'turnPrefixRange'> & {
  summarizeRange: [Seq, Seq]
  turnPrefixRange?: [Seq, Seq]
}
export type Verdict = { passed: boolean; tier: 0 | 1 | 2; reasons: string[] }
export type PlanItems = PlanItem[]

export interface HookPayloadMap {
  session_start: Readonly<Wire.SessionStartPayload>
  resources_discover: Readonly<Omit<Wire.ResourcesDiscoverPayload, 'registered'>> & {
    readonly registered: ReadonlyArray<ResourceEntry>
  }
  before_step: {
    readonly turn: number
    readonly step: number
    readonly budget: { readonly remaining: number; readonly cap: number | null }
    readonly depth: number
  }
  context: {
    readonly sections: ReadonlyArray<PromptSection>
    readonly surfaceDigest: { readonly nodes: number; readonly tokensEstimate: number }
    getSurface(): ReadonlyArray<SurfaceNode>
  }
  before_request: Readonly<Omit<Wire.BeforeRequestPayload, 'request'>> & {
    readonly request: ReadonlyRequestView
  }
  before_provider_headers: { readonly route: string; readonly headers: Readonly<Record<string, string>> }
  request_error: Readonly<Omit<Wire.RequestErrorPayload, 'code'>> & { readonly code: AiErrorCode }
  tool_call: Readonly<Omit<Wire.ToolCallPayload, 'meta'>> & { readonly meta: ToolMeta }
  tool_result: Readonly<Omit<Wire.ToolResultPayload, 'result' | 'enforcement'>> & {
    readonly result: ToolResult
    readonly enforcement: {
      readonly level: 'full' | 'partial' | 'none'
      readonly scope: ReadonlyArray<'file' | 'network' | 'process'>
    }
  }
  turn_stopping: {
    readonly turn: number
    readonly step: number
    readonly proposedReason: 'completed' | 'max_steps' | 'budget'
    readonly plan?: PlanItems
    readonly verifier?: Verdict
  }
  approval_request: { readonly request: ApprovalRequest }
  before_compact: Readonly<Wire.BeforeCompactPayload> & { getSurface(): ReadonlyArray<SurfaceNode> }
  compact: Readonly<Omit<Wire.CompactPayload, 'range'>> & { readonly range: readonly [Seq, Seq] }
  subagent_start: Readonly<Wire.SubagentStartPayload>
  subagent_end: {
    readonly childKey: string
    readonly outcome: 'completed' | 'failed' | 'cancelled'
    readonly credits: number
  }
  format_deviation: { readonly rule: string; readonly model: string; readonly sampleHash: string }
  shutdown: { readonly reason: 'close' | 'revoke' | 'reload' }
}

export interface HookReturnMap {
  // biome-ignore lint/suspicious/noConfusingVoidType: synchronous and async observe handlers return void
  session_start: void
  resources_discover: { resources?: ResourceEntry[]; additionalContext?: string }
  before_step: { block?: boolean; reason?: string }
  context: { sections?: PromptSection[]; additionalContext?: string }
  before_request: {
    patch?: {
      samplingParams?: Record<string, JsonValue>
      maxTokens?: number
      metadata?: Record<string, JsonValue>
    }
  }
  before_provider_headers: { headers?: Record<string, string> }
  // biome-ignore lint/suspicious/noConfusingVoidType: observe handler return type
  request_error: void
  tool_call: { allow: true } | { allow: false; reason: string }
  tool_result: { result?: ToolResult }
  turn_stopping: { action: 'stop' } | { action: 'continue'; note: string }
  approval_request: { request?: Partial<Pick<ApprovalRequest, 'risk' | 'context' | 'summary'>> }
  before_compact: CompactionPlan | null
  // biome-ignore lint/suspicious/noConfusingVoidType: observe handler return type
  compact: void
  // biome-ignore lint/suspicious/noConfusingVoidType: observe handler return type
  subagent_start: void
  // biome-ignore lint/suspicious/noConfusingVoidType: observe handler return type
  subagent_end: void
  // biome-ignore lint/suspicious/noConfusingVoidType: observe handler return type
  format_deviation: void
  // biome-ignore lint/suspicious/noConfusingVoidType: observe handler return type
  shutdown: void
}

export interface HookContext {
  readonly projections: ProjectionReader
  readonly session: SessionRef
  readonly replayed: boolean // replayOnResume 重发时 true；handler 必须幂等
  readonly signal: AbortSignal
  readonly lease: LeaseView
  readonly log: Logger
  readonly platform: PlatformFacts // facts only: hooks run on every kernel event, no probe here
  /** Host-selected immutable workspace configuration for this one hook invocation. */
  readonly workspaceHooks?: HookInvocationSnapshot
}

export type HookHandler<E extends HookEvent> = (
  payload: HookPayloadMap[E],
  ctx: HookContext,
) => HookReturnMap[E] | Promise<HookReturnMap[E]>
