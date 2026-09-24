// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const ModelV1 = Type.Module({
  "ContentBlock": Type.Union([Type.Object({ "type": Type.Literal('text'), "text": Type.String({ maxLength: 1048576 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('image'), "data": Type.String(), "mimeType": Type.String({ maxLength: 128 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('resource_link'), "uri": Type.String({ maxLength: 4096 }), "name": Type.Optional(Type.String({ maxLength: 256 })), "mimeType": Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false })]),
  "ToolCall": Type.Intersect([Type.Object({ "toolUseId": Type.String({ maxLength: 128 }), "name": Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" }), "args": JsonValue, "ordinal": Type.Integer({ minimum: 0 }), "depth": Type.Optional(Type.Integer({ minimum: 0 })), "parentEffectId": Type.Optional(Type.String({ maxLength: 128 })), "resolvedPolicy": Type.Optional(Type.Ref('ResolvedToolCallPolicy')), "executionDomain": Type.Optional(Type.Ref('ExecutionDomain')), "definitionFingerprint": Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })), "policyHash": Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })) }, { additionalProperties: false }), Type.Union([Type.Not(Type.Union([Type.Object({ "resolvedPolicy": Type.Unknown() }), Type.Object({ "executionDomain": Type.Unknown() }), Type.Object({ "definitionFingerprint": Type.Unknown() }), Type.Object({ "policyHash": Type.Unknown() })])), Type.Object({ "resolvedPolicy": Type.Unknown(), "executionDomain": Type.Unknown(), "definitionFingerprint": Type.Unknown(), "policyHash": Type.Unknown() })])]),
  "SlotName": Type.Union([Type.Literal('primary'), Type.Literal('escalation'), Type.Literal('fast'), Type.Literal('compaction'), Type.Literal('verifier'), Type.Literal('image'), Type.Literal('video')]),
  "ThinkingLevel": Type.Union([Type.Literal('off'), Type.Literal('minimal'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max')]),
  "AiErrorCode": Type.Union([Type.Literal('AUTH'), Type.Literal('RATE_LIMIT'), Type.Literal('QUOTA'), Type.Literal('OVERFLOW'), Type.Literal('TIMEOUT'), Type.Literal('NO_MODEL'), Type.Literal('NO_ADAPTER'), Type.Literal('FORMAT'), Type.Literal('TRANSPORT'), Type.Literal('CONTRACT_MISMATCH'), Type.Literal('ABORTED')]),
  "DecodeRule": Type.Union([Type.Literal('reasoning_field'), Type.Literal('think_tag'), Type.Literal('qwen3_coder'), Type.Literal('anthropic_invoke'), Type.Literal('hermes_tool_call'), Type.Literal('inline_json'), Type.Literal('lenient_json')]),
  "Sha256": Type.String({ pattern: "^[0-9a-f]{64}$" }),
  "ToolSchema": Type.Object({ "name": Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" }), "description": Type.String({ maxLength: 8192 }), "parameters": JsonValue }, { additionalProperties: false }),
  "RequestMessage": Type.Union([Type.Object({ "role": Type.Literal('user'), "content": Type.Array(Type.Ref('ContentBlock')) }, { additionalProperties: false }), Type.Object({ "role": Type.Literal('assistant'), "content": Type.Array(Type.Union([Type.Object({ "type": Type.Literal('text'), "text": Type.String() }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('thinking'), "text": Type.String() }, { additionalProperties: false })])), "toolCalls": Type.Optional(Type.Array(Type.Ref('ToolCall'))) }, { additionalProperties: false }), Type.Object({ "role": Type.Literal('tool_result'), "toolUseId": Type.String({ maxLength: 128 }), "content": Type.Array(Type.Ref('ContentBlock')), "isError": Type.Boolean() }, { additionalProperties: false })]),
  "RequestBody": Type.Object({ "kind": Type.Union([Type.Literal('inference'), Type.Literal('summary')]), "sessionKey": Type.String({ maxLength: 512 }), "slot": Type.Ref('SlotName'), "route": Type.String({ maxLength: 128 }), "model": Type.String({ maxLength: 256 }), "contractId": Type.Union([Type.String({ maxLength: 128 }), Type.Null()]), "derivedHash": Type.Ref('Sha256'), "system": Type.String({ maxLength: 1048576 }), "messages": Type.Array(Type.Ref('RequestMessage')), "tools": Type.Array(Type.Ref('ToolSchema')), "sampling": Type.Optional(Type.Object({ "temperature": Type.Optional(Type.Number({ minimum: 0, maximum: 2 })), "maxTokens": Type.Optional(Type.Integer({ minimum: 1 })), "thinking": Type.Optional(Type.Ref('ThinkingLevel')) }, { additionalProperties: false })), "timeoutMs": Type.Optional(Type.Object({ "firstToken": Type.Integer({ minimum: 1000 }), "total": Type.Integer({ minimum: 1000 }) }, { additionalProperties: false })) }, { additionalProperties: false }),
  "ModelCost": Type.Object({ "input": Type.Number(), "output": Type.Number(), "cacheRead": Type.Number(), "cacheWrite": Type.Number() }, { additionalProperties: false }),
  "ModelRecord": Type.Object({ "id": Type.String({ maxLength: 256 }), "name": Type.String({ maxLength: 256 }), "api": Type.String({ maxLength: 64 }), "route": Type.String({ maxLength: 128 }), "baseUrl": Type.String({ maxLength: 2048 }), "reasoning": Type.Boolean(), "thinkingLevelMap": Type.Optional(Type.Record(Type.String(), Type.String())), "input": Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image')])), "cost": Type.Ref('ModelCost'), "contextWindow": Type.Integer({ minimum: 1 }), "maxTokens": Type.Integer({ minimum: 1 }), "samplingParams": Type.Optional(JsonValue), "headers": Type.Optional(Type.Record(Type.String(), Type.String())), "compat": Type.Optional(JsonValue), "toolCallFormats": Type.Array(Type.Union([Type.Literal('native'), Type.Ref('DecodeRule')])), "thinkingReplay": Type.Union([Type.Literal('native'), Type.Literal('drop'), Type.Literal('text')]), "contract_id": Type.Union([Type.String({ maxLength: 128 }), Type.Null()]), "slot": Type.Optional(Type.Ref('SlotName')) }, { additionalProperties: false }),
  "ContractStamp": Type.Object({ "prompt_prefix_hash": Type.Union([Type.Ref('Sha256'), Type.Null()]), "tool_schema_hash": Type.Ref('Sha256'), "parser_version": Type.String({ maxLength: 32 }), "contract_id": Type.Union([Type.String({ maxLength: 128 }), Type.Null()]), "model": Type.Object({ "route": Type.String({ maxLength: 128 }), "id": Type.String({ maxLength: 256 }), "responseModel": Type.Optional(Type.String({ maxLength: 256 })) }, { additionalProperties: false }), "derived_hash": Type.Ref('Sha256'), "sent_hash": Type.Ref('Sha256'), "transforms": Type.Array(Type.Object({ "event": Type.String({ maxLength: 64 }), "ext": Type.String({ maxLength: 128 }) }, { additionalProperties: false })) }, { additionalProperties: false }),
  "TokenCounts": Type.Object({ "input": Type.Integer({ minimum: 0 }), "output": Type.Integer({ minimum: 0 }), "cacheRead": Type.Integer({ minimum: 0 }), "cacheWrite": Type.Integer({ minimum: 0 }), "reasoning": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
  "Billing": Type.Object({ "usdMicros": Type.Integer({ minimum: 0 }), "source": Type.Union([Type.Literal('gateway'), Type.Literal('estimated')]), "subscription": Type.Boolean() }, { additionalProperties: false }),
  "Timing": Type.Object({ "ttftMs": Type.Optional(Type.Integer({ minimum: 0 })), "durationMs": Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
  "CountResult": Type.Union([Type.Object({ "tokens": Type.Integer({ minimum: 0 }), "source": Type.Union([Type.Literal('provider'), Type.Literal('local-tokenizer')]), "boundHash": Type.Ref('Sha256'), "modelSnapshot": Type.Optional(Type.String({ maxLength: 256 })) }, { additionalProperties: false }), Type.Object({ "source": Type.Literal('unsupported') }, { additionalProperties: false })]),
  "InferenceEvent": Type.Union([Type.Object({ "type": Type.Literal('sent'), "stamp": Type.Ref('ContractStamp') }, { additionalProperties: false }), Type.Object({ "type": Type.Union([Type.Literal('text_delta'), Type.Literal('thinking_delta'), Type.Literal('toolcall_delta')]), "delta": Type.String() }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('toolcall_end'), "call": Type.Ref('ToolCall'), "via": Type.Union([Type.Literal('native'), Type.Ref('DecodeRule')]) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('deviation'), "rule": Type.Literal('unparsed'), "sampleHash": Type.Ref('Sha256') }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('usage'), "tokens": Type.Ref('TokenCounts'), "credits": Type.Optional(Type.Number({ minimum: 0 })), "creditSource": Type.Union([Type.Literal('gateway'), Type.Literal('estimated')]), "billing": Type.Optional(Type.Ref('Billing')), "timing": Type.Optional(Type.Ref('Timing')) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('done'), "reason": Type.Union([Type.Literal('stop'), Type.Literal('length'), Type.Literal('toolUse')]) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('error'), "reason": Type.Union([Type.Literal('aborted'), Type.Literal('error')]), "code": Type.Ref('AiErrorCode'), "message": Type.String({ maxLength: 4096 }), "retryable": Type.Boolean(), "retryAfterMs": Type.Optional(Type.Integer({ minimum: 0 })), "requestId": Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('media'), "kind": Type.Literal('image'), "data": Type.String(), "mimeType": Type.String({ maxLength: 128 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('media'), "kind": Type.Literal('video_job'), "jobId": Type.String({ maxLength: 128 }), "status": Type.Union([Type.Literal('submitted'), Type.Literal('running'), Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('expired')]), "url": Type.Optional(Type.String({ maxLength: 4096 })) }, { additionalProperties: false })]),
  "RouteDecl": Type.Object({ "route": Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }), "api": Type.String({ maxLength: 64 }), "baseUrl": Type.String({ maxLength: 2048 }), "credentialRef": Type.Optional(Type.String({ pattern: "^secret://[A-Za-z0-9_./-]+$" })), "compat": Type.Optional(JsonValue), "displayName": Type.Optional(Type.String({ maxLength: 128 })), "models": Type.Optional(Type.Array(Type.Ref('ModelRecord'))) }, { additionalProperties: false }),
  "RouteTarget": Type.Object({ "route": Type.String({ maxLength: 128 }), "model": Type.String({ maxLength: 256 }), "fallbacks": Type.Optional(Type.Array(Type.Object({ "route": Type.String({ maxLength: 128 }), "model": Type.String({ maxLength: 256 }) }, { additionalProperties: false }))) }, { additionalProperties: false }),
  "RouteTable": Type.Object({ "primary": Type.Ref('RouteTarget'), "escalation": Type.Optional(Type.Ref('RouteTarget')), "fast": Type.Optional(Type.Ref('RouteTarget')), "compaction": Type.Optional(Type.Ref('RouteTarget')), "verifier": Type.Optional(Type.Ref('RouteTarget')), "image": Type.Optional(Type.Ref('RouteTarget')), "video": Type.Optional(Type.Ref('RouteTarget')) }, { additionalProperties: false }),
  "ProbeReport": Type.Object({ "route": Type.String({ maxLength: 128 }), "ok": Type.Boolean(), "latencyMs": Type.Integer({ minimum: 0 }), "checks": Type.Array(Type.Object({ "name": Type.String({ maxLength: 64 }), "ok": Type.Boolean(), "detail": Type.Optional(Type.String({ maxLength: 1024 })) }, { additionalProperties: false })) }, { additionalProperties: false }),
  "ContractManifest": Type.Object({ "version": Type.String({ maxLength: 32 }), "model_family": Type.String({ maxLength: 128 }), "parser_version": Type.String({ maxLength: 32 }), "released_at": Type.String({ format: "date-time" }), "sha256": Type.Object({ "prefix": Type.Ref('Sha256'), "tools": Type.Ref('Sha256'), "syntax": Type.Ref('Sha256') }, { additionalProperties: false }) }, { additionalProperties: false }),
  "ResolvedToolCallPolicy": Type.Object({ "isReadOnly": Type.Boolean(), "isDestructive": Type.Boolean(), "isConcurrencySafe": Type.Optional(Type.Boolean()), "isOpenWorld": Type.Optional(Type.Boolean()), "replay": Type.Union([Type.Literal('safe'), Type.Literal('never'), Type.Literal('idempotent')]), "requiresApproval": Type.Union([Type.Literal('never'), Type.Literal('destructive'), Type.Literal('always')]), "approvalScopes": Type.Array(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_.:-]{0,63}$" }), { maxItems: 16, uniqueItems: true }), "policyVersion": Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_.:-]{0,63}$" }) }, { additionalProperties: false }),
  "ExecutionDomain": Type.Union([Type.Literal('workspace'), Type.Literal('host-computer-use')]),
})

export const ContentBlock = ModelV1.Import('ContentBlock')
export type ContentBlock = Static<typeof ContentBlock>
export const ToolCall = ModelV1.Import('ToolCall')
export type ToolCall = Static<typeof ToolCall>
export const SlotName = ModelV1.Import('SlotName')
export type SlotName = Static<typeof SlotName>
export const ThinkingLevel = ModelV1.Import('ThinkingLevel')
export type ThinkingLevel = Static<typeof ThinkingLevel>
export const AiErrorCode = ModelV1.Import('AiErrorCode')
export type AiErrorCode = Static<typeof AiErrorCode>
export const DecodeRule = ModelV1.Import('DecodeRule')
export type DecodeRule = Static<typeof DecodeRule>
export const Sha256 = ModelV1.Import('Sha256')
export type Sha256 = Static<typeof Sha256>
export const ToolSchema = ModelV1.Import('ToolSchema')
export type ToolSchema = Static<typeof ToolSchema>
export const RequestMessage = ModelV1.Import('RequestMessage')
export type RequestMessage = Static<typeof RequestMessage>
export const RequestBody = ModelV1.Import('RequestBody')
export type RequestBody = Static<typeof RequestBody>
export const ModelCost = ModelV1.Import('ModelCost')
export type ModelCost = Static<typeof ModelCost>
export const ModelRecord = ModelV1.Import('ModelRecord')
export type ModelRecord = Static<typeof ModelRecord>
export const ContractStamp = ModelV1.Import('ContractStamp')
export type ContractStamp = Static<typeof ContractStamp>
export const TokenCounts = ModelV1.Import('TokenCounts')
export type TokenCounts = Static<typeof TokenCounts>
export const Billing = ModelV1.Import('Billing')
export type Billing = Static<typeof Billing>
export const Timing = ModelV1.Import('Timing')
export type Timing = Static<typeof Timing>
export const CountResult = ModelV1.Import('CountResult')
export type CountResult = Static<typeof CountResult>
export const InferenceEvent = ModelV1.Import('InferenceEvent')
export type InferenceEvent = Static<typeof InferenceEvent>
export const RouteDecl = ModelV1.Import('RouteDecl')
export type RouteDecl = Static<typeof RouteDecl>
export const RouteTarget = ModelV1.Import('RouteTarget')
export type RouteTarget = Static<typeof RouteTarget>
export const RouteTable = ModelV1.Import('RouteTable')
export type RouteTable = Static<typeof RouteTable>
export const ProbeReport = ModelV1.Import('ProbeReport')
export type ProbeReport = Static<typeof ProbeReport>
export const ContractManifest = ModelV1.Import('ContractManifest')
export type ContractManifest = Static<typeof ContractManifest>
export const ResolvedToolCallPolicy = ModelV1.Import('ResolvedToolCallPolicy')
export type ResolvedToolCallPolicy = Static<typeof ResolvedToolCallPolicy>
export const ExecutionDomain = ModelV1.Import('ExecutionDomain')
export type ExecutionDomain = Static<typeof ExecutionDomain>
