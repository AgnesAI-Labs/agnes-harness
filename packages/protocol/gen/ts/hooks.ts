// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const HooksSchema = Type.Module({
  "Actor": Type.Object({ "id": Type.String({ minLength: 1, maxLength: 256 }), "org": Type.String({ maxLength: 256 }), "role": Type.String({ maxLength: 64 }), "deptPath": Type.Array(Type.String({ maxLength: 256 })), "attrs": Type.Record(Type.String(), Type.String({ maxLength: 1024 })) }, { additionalProperties: false }),
  "ContentBlock": Type.Union([Type.Object({ "type": Type.Literal('text'), "text": Type.String({ maxLength: 1048576 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('image'), "data": Type.String(), "mimeType": Type.String({ maxLength: 128 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('resource_link'), "uri": Type.String({ maxLength: 4096 }), "name": Type.Optional(Type.String({ maxLength: 256 })), "mimeType": Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false })]),
  "ToolResult": Type.Object({ "toolUseId": Type.String({ maxLength: 128 }), "content": Type.Array(Type.Ref('ContentBlock')), "structured": Type.Optional(JsonValue), "isError": Type.Boolean(), "code": Type.Optional(Type.String({ maxLength: 64 })), "enforcement": Type.Object({ "level": Type.Union([Type.Literal('full'), Type.Literal('partial'), Type.Literal('none')]), "scope": Type.Array(Type.Union([Type.Literal('file'), Type.Literal('network'), Type.Literal('process')])) }, { additionalProperties: false }), "authz": Type.Object({ "decisionId": Type.String({ maxLength: 128 }) }, { additionalProperties: false }), "partial": Type.Optional(Type.Boolean()), "cancelledBy": Type.Optional(Type.Ref('Actor')), "interrupted": Type.Optional(Type.Boolean()), "transformedBy": Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false }),
  "PlanItems": Type.Union([Type.Null(), Type.Object({ "items": Type.Array(Type.Object({ "id": Type.String({ maxLength: 64 }), "text": Type.String({ maxLength: 2048 }), "status": Type.Union([Type.Literal('todo'), Type.Literal('doing'), Type.Literal('done'), Type.Literal('blocked')]), "check": Type.Optional(Type.String({ maxLength: 2048 })) }, { additionalProperties: false })), "customInstructions": Type.Optional(Type.String({ maxLength: 8192 })) }, { additionalProperties: false })]),
  "Verdict": Type.Object({ "outcome": Type.Union([Type.Literal('pass'), Type.Literal('fail'), Type.Literal('needs_revision'), Type.Literal('unavailable')]), "reasons": Type.Array(Type.String({ maxLength: 1024 })) }, { additionalProperties: false }),
  "ToolMeta": Type.Object({ "isReadOnly": Type.Boolean(), "isDestructive": Type.Boolean(), "isConcurrencySafe": Type.Boolean(), "isOpenWorld": Type.Boolean(), "replay": Type.Union([Type.Literal('safe'), Type.Literal('never'), Type.Literal('idempotent')]), "costHint": Type.Union([Type.Null(), Type.Object({ "credits": Type.Optional(Type.Number({ minimum: 0 })), "wallMs": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false })]), "deferLoading": Type.Union([Type.Boolean(), Type.Null()]), "requiresApproval": Type.Union([Type.Union([Type.Literal('never'), Type.Literal('destructive'), Type.Literal('always')]), Type.Null()]) }, { additionalProperties: false }),
  "ResolvedToolCallPolicy": Type.Object({ "isReadOnly": Type.Boolean(), "isDestructive": Type.Boolean(), "isConcurrencySafe": Type.Optional(Type.Boolean()), "isOpenWorld": Type.Optional(Type.Boolean()), "replay": Type.Union([Type.Literal('safe'), Type.Literal('never'), Type.Literal('idempotent')]), "requiresApproval": Type.Union([Type.Literal('never'), Type.Literal('destructive'), Type.Literal('always')]), "approvalScopes": Type.Array(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_.:-]{0,63}$" }), { maxItems: 16, uniqueItems: true }), "policyVersion": Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_.:-]{0,63}$" }) }, { additionalProperties: false }),
  "ExecutionDomain": Type.Union([Type.Literal('workspace'), Type.Literal('host-computer-use')]),
  "HookEvent": Type.Union([Type.Literal('session_start'), Type.Literal('resources_discover'), Type.Literal('before_step'), Type.Literal('context'), Type.Literal('before_request'), Type.Literal('before_provider_headers'), Type.Literal('request_error'), Type.Literal('tool_call'), Type.Literal('tool_result'), Type.Literal('turn_stopping'), Type.Literal('approval_request'), Type.Literal('before_compact'), Type.Literal('compact'), Type.Literal('subagent_start'), Type.Literal('subagent_end'), Type.Literal('format_deviation'), Type.Literal('shutdown')]),
  "PromptSection": Type.Object({ "id": Type.String({ maxLength: 64 }), "order": Type.Integer({ minimum: 0 }), "text": Type.String({ maxLength: 65536 }) }, { additionalProperties: false }),
  "ResourceEntry": Type.Object({ "id": Type.String({ maxLength: 128 }), "kind": Type.Union([Type.Literal('skill'), Type.Literal('mcp'), Type.Literal('kb'), Type.Literal('datasource'), Type.Literal('model')]), "name": Type.String({ maxLength: 256 }), "description": Type.String({ maxLength: 2048 }), "schema": Type.Optional(JsonValue) }, { additionalProperties: false }),
  "SurfaceDigest": Type.Object({ "nodes": Type.Integer({ minimum: 0 }), "tokensEstimate": Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  "ApprovalRequest": Type.Object({ "tool": Type.String({ maxLength: 64 }), "argvHash": Type.String({ pattern: "^[0-9a-f]{64}$" }), "risk": Type.Union([Type.Literal('destructive'), Type.Literal('always'), Type.Literal('budget'), Type.Literal('unknown')]), "actor": Type.Ref('Actor'), "context": Type.String({ maxLength: 4096 }) }, { additionalProperties: false }),
  "CompactionPlan": Type.Object({ "keepFromSeq": Type.Integer({ minimum: 1 }), "summarizeRange": Type.Array(Type.Integer({ minimum: 1 }), { minItems: 2, maxItems: 2 }), "turnPrefixRange": Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 2, maxItems: 2 })), "previousSummarySeq": Type.Optional(Type.Integer({ minimum: 1 })), "prompts": Type.Object({ "system": Type.String(), "history": Type.String(), "prefix": Type.Optional(Type.String()) }, { additionalProperties: false }), "maxTokens": Type.Integer({ minimum: 1 }), "details": Type.Object({ "readFiles": Type.Array(Type.String()), "modifiedFiles": Type.Array(Type.String()) }, { additionalProperties: false }), "customInstructions": Type.Optional(Type.String({ maxLength: 8192 })) }, { additionalProperties: false }),
  "SessionStartPayload": Type.Object({ "reason": Type.Union([Type.Literal('new'), Type.Literal('resume'), Type.Literal('fork')]), "preset": Type.String(), "cwd": Type.String(), "parent": Type.Optional(Type.String()) }, { additionalProperties: false }),
  "SessionStartReturn": Type.Null(),
  "ResourcesDiscoverPayload": Type.Object({ "actor": Type.Ref('Actor'), "cwd": Type.String(), "registered": Type.Array(Type.Ref('ResourceEntry')) }, { additionalProperties: false }),
  "ResourcesDiscoverReturn": Type.Object({ "resources": Type.Optional(Type.Array(Type.Ref('ResourceEntry'))), "additionalContext": Type.Optional(Type.String({ maxLength: 8192 })) }, { additionalProperties: false }),
  "BeforeStepPayload": Type.Object({ "turn": Type.Integer(), "step": Type.Integer(), "depth": Type.Integer({ minimum: 0 }), "budget": Type.Object({ "remaining": Type.Union([Type.Number(), Type.Null()]), "cap": Type.Union([Type.Number(), Type.Null()]) }, { additionalProperties: false }) }, { additionalProperties: false }),
  "BeforeStepReturn": Type.Object({ "block": Type.Optional(Type.Boolean()), "reason": Type.Optional(Type.String({ maxLength: 1024 })) }, { additionalProperties: false }),
  "ContextPayload": Type.Object({ "sections": Type.Array(Type.Ref('PromptSection')), "surfaceDigest": Type.Ref('SurfaceDigest') }, { additionalProperties: false }),
  "ContextReturn": Type.Object({ "sections": Type.Optional(Type.Array(Type.Ref('PromptSection'))), "additionalContext": Type.Optional(Type.String({ maxLength: 8192 })) }, { additionalProperties: false }),
  "BeforeRequestPayload": Type.Object({ "request": JsonValue, "slot": Type.String(), "model": Type.String(), "attempt": Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
  "BeforeRequestReturn": Type.Object({ "patch": Type.Optional(Type.Object({ "samplingParams": Type.Optional(Type.Record(Type.String(), JsonValue)), "maxTokens": Type.Optional(Type.Integer({ minimum: 1 })), "metadata": Type.Optional(Type.Record(Type.String(), JsonValue)) }, { additionalProperties: false })) }, { additionalProperties: false }),
  "BeforeProviderHeadersPayload": Type.Object({ "route": Type.String(), "headers": Type.Record(Type.String(), Type.String()) }, { additionalProperties: false }),
  "BeforeProviderHeadersReturn": Type.Object({ "headers": Type.Optional(Type.Record(Type.String({ pattern: '^X-Ext-' }), Type.String(), { additionalProperties: false })) }, { additionalProperties: false }),
  "RequestErrorPayload": Type.Object({ "code": Type.String(), "message": Type.String(), "attempt": Type.Integer(), "retryable": Type.Boolean() }, { additionalProperties: false }),
  "RequestErrorReturn": Type.Null(),
  "ToolCallPayload": Type.Intersect([Type.Object({ "toolUseId": Type.String(), "name": Type.String(), "args": JsonValue, "meta": Type.Ref('ToolMeta'), "actor": Type.Ref('Actor'), "taint": Type.Boolean(), "resolvedPolicy": Type.Optional(Type.Ref('ResolvedToolCallPolicy')), "executionDomain": Type.Optional(Type.Ref('ExecutionDomain')), "definitionFingerprint": Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })), "policyHash": Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })) }, { additionalProperties: false }), Type.Union([Type.Not(Type.Union([Type.Object({ "resolvedPolicy": Type.Unknown() }), Type.Object({ "executionDomain": Type.Unknown() }), Type.Object({ "definitionFingerprint": Type.Unknown() }), Type.Object({ "policyHash": Type.Unknown() })])), Type.Object({ "resolvedPolicy": Type.Unknown(), "executionDomain": Type.Unknown(), "definitionFingerprint": Type.Unknown(), "policyHash": Type.Unknown() })])]),
  "ToolCallReturn": Type.Union([Type.Object({ "allow": Type.Literal(true) }, { additionalProperties: false }), Type.Object({ "allow": Type.Literal(false), "reason": Type.String({ maxLength: 1024 }) }, { additionalProperties: false })]),
  "ToolResultPayload": Type.Object({ "toolUseId": Type.String(), "name": Type.String(), "args": JsonValue, "result": Type.Ref('ToolResult'), "enforcement": Type.Object({ "level": Type.Union([Type.Literal('full'), Type.Literal('partial'), Type.Literal('none')]), "scope": Type.Array(Type.Union([Type.Literal('file'), Type.Literal('network'), Type.Literal('process')])) }, { additionalProperties: false }) }, { additionalProperties: false }),
  "ToolResultReturn": Type.Object({ "result": Type.Optional(Type.Ref('ToolResult')) }, { additionalProperties: false }),
  "TurnStoppingPayload": Type.Object({ "turn": Type.Integer(), "step": Type.Integer(), "proposedReason": Type.Union([Type.Literal('completed'), Type.Literal('aborted'), Type.Literal('error'), Type.Literal('parked'), Type.Literal('blocked'), Type.Literal('budget'), Type.Literal('max_steps'), Type.Literal('interrupted')]), "plan": Type.Optional(Type.Ref('PlanItems')), "verifier": Type.Optional(Type.Ref('Verdict')) }, { additionalProperties: false }),
  "TurnStoppingReturn": Type.Union([Type.Object({ "action": Type.Literal('stop') }, { additionalProperties: false }), Type.Object({ "action": Type.Literal('continue'), "note": Type.String({ maxLength: 2048 }) }, { additionalProperties: false })]),
  "ApprovalRequestPayload": Type.Object({ "request": Type.Ref('ApprovalRequest') }, { additionalProperties: false }),
  "ApprovalRequestReturn": Type.Object({ "request": Type.Optional(Type.Object({ "risk": Type.Optional(Type.Union([Type.Literal('destructive'), Type.Literal('always'), Type.Literal('budget'), Type.Literal('unknown')])), "context": Type.Optional(Type.String({ maxLength: 4096 })) }, { additionalProperties: false })) }, { additionalProperties: false }),
  "BeforeCompactPayload": Type.Object({ "contextTokens": Type.Integer({ minimum: 0 }), "contextWindow": Type.Integer({ minimum: 1 }), "reserveTokens": Type.Integer({ minimum: 1 }), "reason": Type.Union([Type.Literal('threshold'), Type.Literal('overflow'), Type.Literal('requested')]), "previousSummarySeq": Type.Optional(Type.Integer({ minimum: 1 })), "customInstructions": Type.Optional(Type.String({ maxLength: 8192 })) }, { additionalProperties: false }),
  "BeforeCompactReturn": Type.Union([Type.Null(), Type.Ref('CompactionPlan')]),
  "CompactPayload": Type.Object({ "replaceSeq": Type.Integer({ minimum: 1 }), "range": Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 }), "tokensBefore": Type.Integer({ minimum: 0 }), "tokensAfter": Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  "CompactReturn": Type.Null(),
  "SubagentStartPayload": Type.Object({ "childKey": Type.String(), "kind": Type.Union([Type.Literal('fork'), Type.Literal('spawn')]), "budget": Type.Union([Type.Number(), Type.Null()]) }, { additionalProperties: false }),
  "SubagentStartReturn": Type.Null(),
  "SubagentEndPayload": Type.Object({ "childKey": Type.String(), "outcome": Type.Union([Type.Literal('completed'), Type.Literal('aborted'), Type.Literal('error'), Type.Literal('parked'), Type.Literal('blocked'), Type.Literal('budget'), Type.Literal('max_steps'), Type.Literal('interrupted')]), "credits": Type.Number({ minimum: 0 }) }, { additionalProperties: false }),
  "SubagentEndReturn": Type.Null(),
  "FormatDeviationPayload": Type.Object({ "rule": Type.String(), "model": Type.String(), "sampleHash": Type.String({ pattern: "^[0-9a-f]{64}$" }) }, { additionalProperties: false }),
  "FormatDeviationReturn": Type.Null(),
  "ShutdownPayload": Type.Object({ "reason": Type.Union([Type.Literal('close'), Type.Literal('revoke'), Type.Literal('reload')]) }, { additionalProperties: false }),
  "ShutdownReturn": Type.Null(),
})

export const Actor = HooksSchema.Import('Actor')
export type Actor = Static<typeof Actor>
export const ContentBlock = HooksSchema.Import('ContentBlock')
export type ContentBlock = Static<typeof ContentBlock>
export const ToolResult = HooksSchema.Import('ToolResult')
export type ToolResult = Static<typeof ToolResult>
export const PlanItems = HooksSchema.Import('PlanItems')
export type PlanItems = Static<typeof PlanItems>
export const Verdict = HooksSchema.Import('Verdict')
export type Verdict = Static<typeof Verdict>
export const ToolMeta = HooksSchema.Import('ToolMeta')
export type ToolMeta = Static<typeof ToolMeta>
export const ResolvedToolCallPolicy = HooksSchema.Import('ResolvedToolCallPolicy')
export type ResolvedToolCallPolicy = Static<typeof ResolvedToolCallPolicy>
export const ExecutionDomain = HooksSchema.Import('ExecutionDomain')
export type ExecutionDomain = Static<typeof ExecutionDomain>
export const HookEvent = HooksSchema.Import('HookEvent')
export type HookEvent = Static<typeof HookEvent>
export const PromptSection = HooksSchema.Import('PromptSection')
export type PromptSection = Static<typeof PromptSection>
export const ResourceEntry = HooksSchema.Import('ResourceEntry')
export type ResourceEntry = Static<typeof ResourceEntry>
export const SurfaceDigest = HooksSchema.Import('SurfaceDigest')
export type SurfaceDigest = Static<typeof SurfaceDigest>
export const ApprovalRequest = HooksSchema.Import('ApprovalRequest')
export type ApprovalRequest = Static<typeof ApprovalRequest>
export const CompactionPlan = HooksSchema.Import('CompactionPlan')
export type CompactionPlan = Static<typeof CompactionPlan>
export const SessionStartPayload = HooksSchema.Import('SessionStartPayload')
export type SessionStartPayload = Static<typeof SessionStartPayload>
export const SessionStartReturn = HooksSchema.Import('SessionStartReturn')
export type SessionStartReturn = Static<typeof SessionStartReturn>
export const ResourcesDiscoverPayload = HooksSchema.Import('ResourcesDiscoverPayload')
export type ResourcesDiscoverPayload = Static<typeof ResourcesDiscoverPayload>
export const ResourcesDiscoverReturn = HooksSchema.Import('ResourcesDiscoverReturn')
export type ResourcesDiscoverReturn = Static<typeof ResourcesDiscoverReturn>
export const BeforeStepPayload = HooksSchema.Import('BeforeStepPayload')
export type BeforeStepPayload = Static<typeof BeforeStepPayload>
export const BeforeStepReturn = HooksSchema.Import('BeforeStepReturn')
export type BeforeStepReturn = Static<typeof BeforeStepReturn>
export const ContextPayload = HooksSchema.Import('ContextPayload')
export type ContextPayload = Static<typeof ContextPayload>
export const ContextReturn = HooksSchema.Import('ContextReturn')
export type ContextReturn = Static<typeof ContextReturn>
export const BeforeRequestPayload = HooksSchema.Import('BeforeRequestPayload')
export type BeforeRequestPayload = Static<typeof BeforeRequestPayload>
export const BeforeRequestReturn = HooksSchema.Import('BeforeRequestReturn')
export type BeforeRequestReturn = Static<typeof BeforeRequestReturn>
export const BeforeProviderHeadersPayload = HooksSchema.Import('BeforeProviderHeadersPayload')
export type BeforeProviderHeadersPayload = Static<typeof BeforeProviderHeadersPayload>
export const BeforeProviderHeadersReturn = HooksSchema.Import('BeforeProviderHeadersReturn')
export type BeforeProviderHeadersReturn = Static<typeof BeforeProviderHeadersReturn>
export const RequestErrorPayload = HooksSchema.Import('RequestErrorPayload')
export type RequestErrorPayload = Static<typeof RequestErrorPayload>
export const RequestErrorReturn = HooksSchema.Import('RequestErrorReturn')
export type RequestErrorReturn = Static<typeof RequestErrorReturn>
export const ToolCallPayload = HooksSchema.Import('ToolCallPayload')
export type ToolCallPayload = Static<typeof ToolCallPayload>
export const ToolCallReturn = HooksSchema.Import('ToolCallReturn')
export type ToolCallReturn = Static<typeof ToolCallReturn>
export const ToolResultPayload = HooksSchema.Import('ToolResultPayload')
export type ToolResultPayload = Static<typeof ToolResultPayload>
export const ToolResultReturn = HooksSchema.Import('ToolResultReturn')
export type ToolResultReturn = Static<typeof ToolResultReturn>
export const TurnStoppingPayload = HooksSchema.Import('TurnStoppingPayload')
export type TurnStoppingPayload = Static<typeof TurnStoppingPayload>
export const TurnStoppingReturn = HooksSchema.Import('TurnStoppingReturn')
export type TurnStoppingReturn = Static<typeof TurnStoppingReturn>
export const ApprovalRequestPayload = HooksSchema.Import('ApprovalRequestPayload')
export type ApprovalRequestPayload = Static<typeof ApprovalRequestPayload>
export const ApprovalRequestReturn = HooksSchema.Import('ApprovalRequestReturn')
export type ApprovalRequestReturn = Static<typeof ApprovalRequestReturn>
export const BeforeCompactPayload = HooksSchema.Import('BeforeCompactPayload')
export type BeforeCompactPayload = Static<typeof BeforeCompactPayload>
export const BeforeCompactReturn = HooksSchema.Import('BeforeCompactReturn')
export type BeforeCompactReturn = Static<typeof BeforeCompactReturn>
export const CompactPayload = HooksSchema.Import('CompactPayload')
export type CompactPayload = Static<typeof CompactPayload>
export const CompactReturn = HooksSchema.Import('CompactReturn')
export type CompactReturn = Static<typeof CompactReturn>
export const SubagentStartPayload = HooksSchema.Import('SubagentStartPayload')
export type SubagentStartPayload = Static<typeof SubagentStartPayload>
export const SubagentStartReturn = HooksSchema.Import('SubagentStartReturn')
export type SubagentStartReturn = Static<typeof SubagentStartReturn>
export const SubagentEndPayload = HooksSchema.Import('SubagentEndPayload')
export type SubagentEndPayload = Static<typeof SubagentEndPayload>
export const SubagentEndReturn = HooksSchema.Import('SubagentEndReturn')
export type SubagentEndReturn = Static<typeof SubagentEndReturn>
export const FormatDeviationPayload = HooksSchema.Import('FormatDeviationPayload')
export type FormatDeviationPayload = Static<typeof FormatDeviationPayload>
export const FormatDeviationReturn = HooksSchema.Import('FormatDeviationReturn')
export type FormatDeviationReturn = Static<typeof FormatDeviationReturn>
export const ShutdownPayload = HooksSchema.Import('ShutdownPayload')
export type ShutdownPayload = Static<typeof ShutdownPayload>
export const ShutdownReturn = HooksSchema.Import('ShutdownReturn')
export type ShutdownReturn = Static<typeof ShutdownReturn>
export const X_AGNES_HOOK_TABLE = {
  "session_start": {
    "mode": "parallel",
    "category": "observe",
    "failPolicy": "open",
    "timeoutMs": 500,
    "replayOnResume": true
  },
  "resources_discover": {
    "mode": "waterfall",
    "category": "transform",
    "failPolicy": "open",
    "timeoutMs": 1000,
    "replayOnResume": true
  },
  "before_step": {
    "mode": "serial",
    "category": "directive",
    "failPolicy": "closed",
    "timeoutMs": 1000,
    "replayOnResume": false
  },
  "context": {
    "mode": "waterfall",
    "category": "transform",
    "failPolicy": "closed",
    "timeoutMs": 1500,
    "replayOnResume": false
  },
  "before_request": {
    "mode": "waterfall",
    "category": "transform",
    "failPolicy": "closed",
    "timeoutMs": 1500,
    "replayOnResume": false
  },
  "before_provider_headers": {
    "mode": "waterfall",
    "category": "transform",
    "failPolicy": "closed",
    "timeoutMs": 500,
    "replayOnResume": false
  },
  "request_error": {
    "mode": "parallel",
    "category": "observe",
    "failPolicy": "open",
    "timeoutMs": 500,
    "replayOnResume": false
  },
  "tool_call": {
    "mode": "serial",
    "category": "directive",
    "failPolicy": "closed",
    "timeoutMs": 2000,
    "replayOnResume": false
  },
  "tool_result": {
    "mode": "waterfall",
    "category": "transform",
    "failPolicy": "open",
    "timeoutMs": 2000,
    "replayOnResume": false
  },
  "turn_stopping": {
    "mode": "serial",
    "category": "directive",
    "failPolicy": "open",
    "timeoutMs": 1000,
    "replayOnResume": false
  },
  "approval_request": {
    "mode": "waterfall",
    "category": "transform",
    "failPolicy": "closed",
    "timeoutMs": 1000,
    "replayOnResume": false
  },
  "before_compact": {
    "mode": "waterfall",
    "category": "transform",
    "failPolicy": "closed",
    "timeoutMs": 3000,
    "replayOnResume": false
  },
  "compact": {
    "mode": "parallel",
    "category": "observe",
    "failPolicy": "open",
    "timeoutMs": 1000,
    "replayOnResume": false
  },
  "subagent_start": {
    "mode": "emit",
    "category": "observe",
    "failPolicy": "open",
    "timeoutMs": 200,
    "replayOnResume": false
  },
  "subagent_end": {
    "mode": "emit",
    "category": "observe",
    "failPolicy": "open",
    "timeoutMs": 200,
    "replayOnResume": false
  },
  "format_deviation": {
    "mode": "parallel",
    "category": "observe",
    "failPolicy": "open",
    "timeoutMs": 500,
    "replayOnResume": false
  },
  "shutdown": {
    "mode": "parallel",
    "category": "observe",
    "failPolicy": "open",
    "timeoutMs": 1000,
    "replayOnResume": false
  }
} as const
export const X_AGNES_HOOK_IO = {
  "session_start": [
    "SessionStartPayload",
    "SessionStartReturn"
  ],
  "resources_discover": [
    "ResourcesDiscoverPayload",
    "ResourcesDiscoverReturn"
  ],
  "before_step": [
    "BeforeStepPayload",
    "BeforeStepReturn"
  ],
  "context": [
    "ContextPayload",
    "ContextReturn"
  ],
  "before_request": [
    "BeforeRequestPayload",
    "BeforeRequestReturn"
  ],
  "before_provider_headers": [
    "BeforeProviderHeadersPayload",
    "BeforeProviderHeadersReturn"
  ],
  "request_error": [
    "RequestErrorPayload",
    "RequestErrorReturn"
  ],
  "tool_call": [
    "ToolCallPayload",
    "ToolCallReturn"
  ],
  "tool_result": [
    "ToolResultPayload",
    "ToolResultReturn"
  ],
  "turn_stopping": [
    "TurnStoppingPayload",
    "TurnStoppingReturn"
  ],
  "approval_request": [
    "ApprovalRequestPayload",
    "ApprovalRequestReturn"
  ],
  "before_compact": [
    "BeforeCompactPayload",
    "BeforeCompactReturn"
  ],
  "compact": [
    "CompactPayload",
    "CompactReturn"
  ],
  "subagent_start": [
    "SubagentStartPayload",
    "SubagentStartReturn"
  ],
  "subagent_end": [
    "SubagentEndPayload",
    "SubagentEndReturn"
  ],
  "format_deviation": [
    "FormatDeviationPayload",
    "FormatDeviationReturn"
  ],
  "shutdown": [
    "ShutdownPayload",
    "ShutdownReturn"
  ]
} as const
