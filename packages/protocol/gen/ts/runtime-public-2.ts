// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })
if (!FormatRegistry.Has('uri')) FormatRegistry.Set('uri', (v) => { try { new URL(v); return true } catch { return false } })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const RuntimePublic2 = Type.Module({
  "Id": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
  "UInt53": Type.Integer({ minimum: 0, maximum: 9007199254740991 }),
  "Timestamp": Type.String({ pattern: "Z$", format: "date-time" }),
  "TypeId": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?:[a-z][a-z0-9.-]*|@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*)/[a-zA-Z0-9._/-]+@[1-9][0-9]*$" }),
  "Digest": Type.String({ pattern: "^[a-f0-9]{64}$" }),
  "SchemaRef": Type.Object({ "typeId": Type.Ref('TypeId'), "revision": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "BlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "DataRef": Type.Union([Type.Object({ "kind": Type.Literal('inline'), "schema": Type.Ref('SchemaRef'), "value": JsonValue, "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "schema": Type.Ref('SchemaRef'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "ActionRef": Type.Union([Type.Object({ "existingActionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "localKey": Type.String() }, { additionalProperties: false })]),
  "ActionDependency": Type.Object({ "action": Type.Ref('ActionRef'), "onDependencyFailure": Type.Union([Type.Literal('cancel'), Type.Literal('run_with_receipt')]) }, { additionalProperties: false }),
  "RuntimeErrorCode": Type.Union([Type.Literal('invalid_input'), Type.Literal('denied'), Type.Literal('incompatible'), Type.Literal('quota'), Type.Literal('cancelled'), Type.Literal('timeout'), Type.Literal('retryable'), Type.Literal('unknown_effect'), Type.Literal('conflict'), Type.Literal('internal')]),
  "OwnerRef": Type.Object({ "kind": Type.Union([Type.Literal('run'), Type.Literal('action'), Type.Literal('job'), Type.Literal('reconciliation')]), "id": Type.Ref('Id') }, { additionalProperties: false }),
  "RetryAdvice": Type.Union([Type.Object({ "kind": Type.Literal('never') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_read'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_same_action'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('reconcile'), "ownerRef": Type.Ref('OwnerRef') }, { additionalProperties: false })]),
  "RuntimeError": Type.Object({ "code": Type.Ref('RuntimeErrorCode'), "detailCode": Type.String(), "message": Type.String(), "retryAdvice": Type.Ref('RetryAdvice'), "diagnosticId": Type.Ref('Id'), "safeDetail": Type.Optional(JsonValue) }, { additionalProperties: false }),
  "RetentionRef": Type.Object({ "kind": Type.Union([Type.Literal('blob'), Type.Literal('artifact'), Type.Literal('domain-record'), Type.Literal('package'), Type.Literal('schema'), Type.Literal('codec')]), "authorityId": Type.Ref('Id'), "resourceId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest'), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "BindingRef": Type.Object({ "bindingId": Type.Ref('Id'), "contract": Type.String(), "logicalName": Type.String(), "providerId": Type.Ref('Id') }, { additionalProperties: false }),
  "Provenance": Type.Object({ "sourceRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "producer": Type.Ref('BindingRef'), "trustLabels": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }),
  "StateAuthorityRef": Type.Object({ "authorityId": Type.Ref('Id'), "tenantId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
  "RetryPolicy": Type.Object({ "mode": Type.Union([Type.Literal('never'), Type.Literal('before_dispatch'), Type.Literal('idempotent'), Type.Literal('reconcile_first')]), "maxAttempts": Type.Ref('UInt53'), "backoffMs": Type.Array(Type.Ref('UInt53'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PreparedAction": Type.Union([Type.Object({ "key": Type.String(), "target": Type.Ref('BindingRef'), "method": Type.String(), "input": Type.Ref('DataRef'), "dependencies": Type.Array(Type.Ref('ActionDependency'), { maxItems: 10000 }), "retry": Type.Ref('RetryPolicy'), "obligation": Type.Literal('mandatory'), "deadline": Type.Ref('Timestamp'), "resultSchema": Type.Ref('SchemaRef'), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }), "presentation": Type.Optional(Type.Object({ "audience": Type.Literal('conversation'), "turnId": Type.Ref('Id'), "kind": Type.Union([Type.Literal('tool'), Type.Literal('assistant-stream')]) }, { additionalProperties: false })), "intentFingerprint": Type.Ref('Digest') }, { additionalProperties: false }), Type.Object({ "key": Type.String(), "target": Type.Ref('BindingRef'), "method": Type.String(), "input": Type.Ref('DataRef'), "dependencies": Type.Array(Type.Ref('ActionDependency'), { maxItems: 10000 }), "retry": Type.Ref('RetryPolicy'), "obligation": Type.Literal('detached'), "deadline": Type.Ref('Timestamp'), "resultSchema": Type.Ref('SchemaRef'), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }), "detachedOwner": Type.Object({ "jobId": Type.Ref('Id'), "authorityId": Type.Ref('Id'), "acceptanceRef": Type.Ref('DataRef') }, { additionalProperties: false }), "presentation": Type.Optional(Type.Object({ "audience": Type.Literal('conversation'), "turnId": Type.Ref('Id'), "kind": Type.Union([Type.Literal('tool'), Type.Literal('assistant-stream')]) }, { additionalProperties: false })), "intentFingerprint": Type.Ref('Digest') }, { additionalProperties: false })]),
  "HookEventName": Type.Union([Type.Literal('tool_call'), Type.Literal('approval_request'), Type.Literal('tool_result'), Type.Literal('context'), Type.Literal('before_request'), Type.Literal('request_error'), Type.Literal('format_deviation'), Type.Literal('before_compact'), Type.Literal('compact'), Type.Literal('session_start'), Type.Literal('shutdown'), Type.Literal('subagent_start'), Type.Literal('subagent_end'), Type.Literal('resources_discover'), Type.Literal('before_step'), Type.Literal('turn_stopping')]),
  "HookResultSet": Type.Object({ "stageId": Type.Ref('Id'), "event": Type.Ref('HookEventName'), "registrationDigest": Type.Ref('Digest'), "inputDigest": Type.Ref('Digest'), "entries": Type.Array(Type.Object({ "registrationId": Type.Ref('Id'), "ordinal": Type.Ref('UInt53'), "outcome": Type.Union([Type.Literal('applied'), Type.Literal('failed-open'), Type.Literal('denied')]), "output": Type.Union([Type.Ref('DataRef'), Type.Null()]), "diagnosticId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }), { maxItems: 10000 }), "output": Type.Ref('DataRef'), "digest": Type.Ref('Digest'), "sourceActionId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "DomainReference": Type.Object({ "authorityId": Type.Ref('Id'), "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53'), "schema": Type.Ref('SchemaRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "InlineResultHookSource": Type.Object({ "sourceReceiptId": Type.Ref('Id'), "sourceReceiptDigest": Type.Ref('Digest'), "evaluator": Type.Ref('BindingRef'), "authorizationRef": Type.Ref('Id') }, { additionalProperties: false }),
  "RelativePath": Type.String({ minLength: 1, maxLength: 1024, pattern: "^\\./(?!\\.{1,2}(?:/|$))(?!.*\\/\\.{1,2}(?:/|$))(?!.*//)[^\\\\\\u0000-\\u001f]+$" }),
  "Scope": Type.Union([Type.Literal('installation'), Type.Literal('runtime'), Type.Literal('workspace'), Type.Literal('session'), Type.Literal('run'), Type.Literal('action')]),
  "CapabilityRequirement": Type.Object({ "capability": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "resourceTypes": Type.Array(Type.Ref('TypeId'), { minItems: 0, maxItems: 64 }), "operations": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }) }, { additionalProperties: false }),
  "OperationDescriptor": Type.Object({ "method": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "kind": Type.Union([Type.Literal('query'), Type.Literal('action'), Type.Literal('control'), Type.Literal('compute'), Type.Literal('maintenance'), Type.Literal('observe'), Type.Literal('ingress')]), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 64 }), "retrySafety": Type.Union([Type.Literal('read-only'), Type.Literal('idempotent'), Type.Literal('reconcile-first'), Type.Literal('never')]) }, { additionalProperties: false }),
  "CommunityOwnerPackageId": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh(?:[./]|$))[^\\u0000-\\u001f\\u007f]+$" }),
  "CommunityContractRef": Type.Object({ "ownerPackageId": Type.Ref('CommunityOwnerPackageId'), "definitionDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ServiceRequirement": Type.Union([Type.Object({ "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)(?=^[^\\u0000-\\u001f\\u007f]+$)^agh\\." }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "features": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Ref('Scope'), "optional": Type.Boolean() }, { additionalProperties: false }), Type.Object({ "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)(?=(?=^[^\\u0000-\\u001f\\u007f]+$)^(?!agh\\.).*$)^(?!agh(?:[./]|$))[^\\u0000-\\u001f\\u007f]+/[a-z][a-z0-9-]*$" }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "features": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Union([Type.Literal('runtime'), Type.Literal('workspace'), Type.Literal('session'), Type.Literal('run'), Type.Literal('action')]), "optional": Type.Boolean(), "contractDefinition": Type.Ref('CommunityContractRef') }, { additionalProperties: false })]),
  "StateCodecRef": Type.Object({ "namespace": Type.Ref('Id'), "codecVersion": Type.Ref('Id'), "schema": Type.Ref('SchemaRef') }, { additionalProperties: false }),
  "ProviderDescriptor": Type.Union([Type.Object({ "providerId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)(?=^[^\\u0000-\\u001f\\u007f]+$)^agh\\." }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "packageVersion": Type.String({ maxLength: 128, pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$" }), "packageDigest": Type.String({ pattern: "^[a-f0-9]{64}$" }), "features": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Ref('Scope'), "configSchema": Type.Ref('SchemaRef'), "requires": Type.Array(Type.Ref('ServiceRequirement'), { minItems: 0, maxItems: 128 }), "capabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 128 }), "recovery": Type.Union([Type.Literal('R0'), Type.Literal('R1'), Type.Literal('R2')]), "isolation": Type.Array(Type.Union([Type.Literal('trusted-in-process'), Type.Literal('isolated-process'), Type.Literal('remote')]), { minItems: 1, maxItems: 3 }), "stateCodecs": Type.Array(Type.Ref('StateCodecRef'), { minItems: 0, maxItems: 64 }), "activationMode": Type.Union([Type.Literal('eager'), Type.Literal('lazy')]), "operations": Type.Array(Type.Ref('OperationDescriptor'), { minItems: 0, maxItems: 128 }) }, { additionalProperties: false }), Type.Object({ "providerId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)(?=(?=^[^\\u0000-\\u001f\\u007f]+$)^(?!agh\\.).*$)^(?!agh(?:[./]|$))[^\\u0000-\\u001f\\u007f]+/[a-z][a-z0-9-]*$" }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "packageVersion": Type.String({ maxLength: 128, pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$" }), "packageDigest": Type.String({ pattern: "^[a-f0-9]{64}$" }), "features": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Union([Type.Literal('runtime'), Type.Literal('workspace'), Type.Literal('session'), Type.Literal('run'), Type.Literal('action')]), "configSchema": Type.Ref('SchemaRef'), "requires": Type.Array(Type.Ref('ServiceRequirement'), { minItems: 0, maxItems: 128 }), "capabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 128 }), "recovery": Type.Union([Type.Literal('R0'), Type.Literal('R1'), Type.Literal('R2')]), "isolation": Type.Array(Type.Union([Type.Literal('trusted-in-process'), Type.Literal('isolated-process'), Type.Literal('remote')]), { minItems: 1, maxItems: 3 }), "stateCodecs": Type.Array(Type.Ref('StateCodecRef'), { minItems: 0, maxItems: 64 }), "activationMode": Type.Union([Type.Literal('eager'), Type.Literal('lazy')]), "operations": Type.Array(Type.Union([Type.Object({ "method": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "kind": Type.Union([Type.Literal('query'), Type.Literal('compute')]), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 64 }), "retrySafety": Type.Literal('read-only') }, { additionalProperties: false }), Type.Object({ "method": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "kind": Type.Literal('action'), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 64 }), "retrySafety": Type.Union([Type.Literal('read-only'), Type.Literal('idempotent'), Type.Literal('reconcile-first'), Type.Literal('never')]) }, { additionalProperties: false })]), { minItems: 1, maxItems: 128, uniqueItems: true }), "contractDefinition": Type.Ref('CommunityContractRef') }, { additionalProperties: false })]),
  "ProviderRef": Type.Object({ "packageId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "providerId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }) }, { additionalProperties: false }),
  "ServiceSelection": Type.Object({ "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)[^\\u0000-\\u001f\\u007f]+$" }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "provider": Type.Ref('ProviderRef'), "isolation": Type.Union([Type.Literal('trusted-in-process'), Type.Literal('isolated-process'), Type.Literal('remote')]) }, { additionalProperties: false }),
  "ConfigValue": Type.Object({ "schema": Type.Ref('SchemaRef'), "value": JsonValue }, { additionalProperties: false }),
  "ConfigPatch": Type.Object({ "path": Type.String({ minLength: 1, maxLength: 1024, pattern: "^/(?:[^~/]|~[01])+(?:/(?:[^~/]|~[01])+)*$" }), "value": JsonValue }, { additionalProperties: false }),
  "ConfigOverride": Type.Object({ "provider": Type.Ref('ProviderRef'), "patch": Type.Array(Type.Ref('ConfigPatch'), { minItems: 0, maxItems: 128 }) }, { additionalProperties: false }),
  "PackageSource": Type.Union([Type.Object({ "kind": Type.Literal('local'), "path": Type.String({ minLength: 1, maxLength: 4096 }), "packageDigest": Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('npm'), "registry": Type.String({ minLength: 1, maxLength: 2048, format: "uri" }), "name": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "version": Type.String({ maxLength: 128, pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$" }), "integrity": Type.String({ minLength: 1, maxLength: 1024, pattern: "^sha512-[A-Za-z0-9+/]+={0,2}$" }), "packageDigest": Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('git'), "repository": Type.String({ minLength: 1, maxLength: 2048, format: "uri" }), "commit": Type.String({ pattern: "^[a-f0-9]{40}([a-f0-9]{24})?$" }), "subdirectory": Type.Union([Type.Literal('.'), Type.Ref('RelativePath')]), "packageDigest": Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false })]),
  "ExportRef": Type.Object({ "entry": Type.String({ minLength: 1, maxLength: 1024, pattern: "^\\./(?!\\.{1,2}(?:/|$))(?!.*\\/\\.{1,2}(?:/|$))(?!.*//)[^\\\\\\u0000-\\u001f]+$" }), "export": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }) }, { additionalProperties: false }),
  "RendererDescriptor": Type.Object({ "id": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "packageDigest": Type.String({ pattern: "^[a-f0-9]{64}$" }), "renderKey": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "targets": Type.Array(Type.Union([Type.Literal('web'), Type.Literal('tui'), Type.Literal('im'), Type.Literal('sdk')]), { minItems: 1, maxItems: 4 }), "viewSchemaRanges": Type.Array(Type.Object({ "typeId": Type.Ref('TypeId'), "minRevision": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "maxRevision": Type.Integer({ minimum: 1, maximum: 9007199254740991 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 64 }), "requiredFeatures": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "optionalFeatures": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Union([Type.Literal('client'), Type.Literal('client-session'), Type.Literal('view')]), "entry": Type.String({ minLength: 1, maxLength: 1024, pattern: "^\\./(?!\\.{1,2}(?:/|$))(?!.*\\/\\.{1,2}(?:/|$))(?!.*//)[^\\\\\\u0000-\\u001f]+$" }) }, { additionalProperties: false }),
  "Limits": Type.Object({ "MAX_ID_BYTES": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_RPC_JSON_BYTES": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_JSON_DEPTH": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_COLLECTION_ITEMS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_CONTINUATION_BYTES": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_ACTIONS_PER_TRANSITION": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_ACTION_DAG_DEPTH": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_PARALLEL_ACTIONS_PER_RUN": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "PER_TREE": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_CHILD_DEPTH": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_LIVE_AGENTS_PER_TREE": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_TRANSITIONS_PER_RUN": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_NO_PROGRESS_TRANSITIONS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_QUERIES_PER_RUN": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_INVOCATION_STARTS_PER_RUN": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_FAILED_INVOCATIONS_PER_RUN": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_QUERIES_PER_INVOCATION": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "QUERY_TIMEOUT_MS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "HEALTH_TIMEOUT_MS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "CREATE_READY_TIMEOUT_MS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "DRAIN_TIMEOUT_MS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "CLOSE_TIMEOUT_MS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "LOOP_INVOCATION_MS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "ISOLATED_CANCEL_GRACE_MS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "KILL_AFTER_CANCEL_MS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "ISOLATED_CPU_MS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MEMORY_BYTES": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "ACTION_TIMEOUT_MS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "INTERACTION_TTL_MS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "SCAN_DEFAULT_PAGE": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "SCAN_PAGE_MAX": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "STREAM_BUFFER_BYTES": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "STREAM_BUFFER_FRAMES": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_FALLBACK_TEXT_BYTES": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_DOMAIN_VIEW_BYTES": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_VIEW_ACTIONS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_VIEW_RESOURCES": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "CLIENT_MOUNT_TIMEOUT_MS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "CLIENT_DISPOSE_TIMEOUT_MS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "DOWNLOAD_TICKET_TTL_MS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "FORM_TICKET_TTL_MS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_RANGE_BYTES": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_ARTIFACT_BYTES": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "UPLOAD_CHUNK_BYTES": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_HOT_RELEASES": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_RETAINED_RELEASES": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "PACKAGE_CACHE_BYTES": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MIN_RECOVERY_SUPPORT_DAYS": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "WORKFLOW_LIFETIME_MS": Type.Optional(Type.Integer({ minimum: 1, maximum: 31536000000 })), "MAX_BROKER_REQUESTS_PER_ATTEMPT": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_PARALLEL_BROKER_REQUESTS_PER_ATTEMPT": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "MAX_INLINE_DATA_BYTES": Type.Optional(Type.Integer({ minimum: 1, maximum: 1048576 })) }, { additionalProperties: false }),
  "ConversationRecord": Type.Object({ "factId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "turnId": Type.Ref('Id'), "runId": Type.Ref('Id'), "seq": Type.Ref('UInt53'), "kind": Type.Union([Type.Literal('user-message'), Type.Literal('turn-start'), Type.Literal('assistant-message'), Type.Literal('tool-call'), Type.Literal('tool-result'), Type.Literal('plan-update'), Type.Literal('turn-end'), Type.Literal('tool-result-update')]), "content": Type.Union([Type.Ref('DataRef'), Type.Null()]), "sourceActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "sourceResultId": Type.Union([Type.Ref('Id'), Type.Null()]), "contributionKey": Type.Ref('Id'), "updateOf": Type.Union([Type.Ref('Id'), Type.Null()]), "outcome": Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Null()]) }, { additionalProperties: false }),
  "ServiceOperation": Type.Object({ "target": Type.Ref('BindingRef'), "method": Type.String(), "input": Type.Ref('DataRef') }, { additionalProperties: false }),
  "ActionSpec": Type.Object({ "key": Type.String(), "target": Type.Ref('BindingRef'), "method": Type.String(), "input": Type.Ref('DataRef'), "dependencies": Type.Array(Type.Ref('ActionDependency'), { maxItems: 10000 }), "retry": Type.Ref('RetryPolicy'), "obligation": Type.Union([Type.Literal('mandatory'), Type.Literal('detached')]), "deadline": Type.Ref('Timestamp'), "resultSchema": Type.Ref('SchemaRef'), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }), "detachedOwner": Type.Optional(Type.Object({ "jobId": Type.Ref('Id'), "authorityId": Type.Ref('Id'), "acceptanceRef": Type.Ref('DataRef') }, { additionalProperties: false })), "presentation": Type.Optional(Type.Object({ "audience": Type.Literal('conversation'), "turnId": Type.Ref('Id'), "kind": Type.Union([Type.Literal('tool'), Type.Literal('assistant-stream')]) }, { additionalProperties: false })) }, { additionalProperties: false }),
  "InputPreparationRequired": Type.Object({ "kind": Type.Literal('preparation-required'), "request": Type.Ref('ServiceOperation'), "action": Type.Ref('ActionSpec') }, { additionalProperties: false }),
  "HookEvaluationRecordValue": Type.Object({ "result": Type.Ref('HookResultSet'), "ownerRunId": Type.Ref('Id'), "ownerActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "committedBy": Type.Ref('Id'), "inlineResultSource": Type.Union([Type.Ref('InlineResultHookSource'), Type.Null()]) }, { additionalProperties: false }),
  "BridgeSessionValue": Type.Object({ "bridgeId": Type.Ref('Id'), "parentActionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "writerEpoch": Type.Ref('UInt53'), "state": Type.Union([Type.Literal('live'), Type.Literal('closed'), Type.Literal('lost')]), "nextSequence": Type.Ref('UInt53'), "parentExecutorAttemptId": Type.Ref('Id') }, { additionalProperties: false }),
  "LegacyBridgeRequest": Type.Object({ "bridgeId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "parentActionId": Type.Ref('Id'), "sequence": Type.Ref('UInt53'), "expectedProviderRevision": Type.Ref('UInt53'), "action": Type.Ref('PreparedAction') }, { additionalProperties: false }),
  "ToolPolicyDefaults": Type.Object({ "isReadOnly": Type.Boolean(), "isDestructive": Type.Boolean(), "replay": Type.Union([Type.Literal('safe'), Type.Literal('never'), Type.Literal('idempotent')]), "requiresApproval": Type.Union([Type.Literal('never'), Type.Literal('destructive'), Type.Literal('always')]), "approvalScopes": Type.Array(Type.String(), { maxItems: 16 }) }, { additionalProperties: false }),
  "ToolPolicySnapshot": Type.Object({ "isReadOnly": Type.Boolean(), "isDestructive": Type.Boolean(), "replay": Type.Union([Type.Literal('safe'), Type.Literal('never'), Type.Literal('idempotent')]), "requiresApproval": Type.Union([Type.Literal('never'), Type.Literal('destructive'), Type.Literal('always')]), "approvalScopes": Type.Array(Type.String(), { maxItems: 16 }), "policyVersion": Type.String(), "classifierDigest": Type.Ref('Digest'), "inputDigest": Type.Ref('Digest'), "definitionDigest": Type.Ref('Digest'), "fingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "ToolExecutionConstraints": Type.Object({ "concurrency": Type.Union([Type.Literal('parallel'), Type.Literal('batch-barrier')]), "isOpenWorld": Type.Boolean(), "costHint": Type.Union([Type.Ref('DataRef'), Type.Null()]), "deferLoading": Type.Boolean(), "requiredModelInput": Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ResourceRef": Type.Object({ "resourceId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ToolDefinition": Type.Object({ "resource": Type.Ref('ResourceRef'), "executor": Type.Ref('BindingRef'), "name": Type.String(), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { maxItems: 10000 }), "retrySafety": Type.Union([Type.Literal('idempotent'), Type.Literal('reconcile-first'), Type.Literal('never')]), "publicAnnotations": Type.Ref('DataRef'), "policy": Type.Object({ "version": Type.String(), "classifierRef": Type.Union([Type.Ref('DataRef'), Type.Null()]), "defaults": Type.Ref('ToolPolicyDefaults') }, { additionalProperties: false }), "execution": Type.Ref('ToolExecutionConstraints') }, { additionalProperties: false }),
  "ArtifactVersion": Type.Integer({ minimum: 1, maximum: 9007199254740991 }),
  "ArtifactRef": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion') }, { additionalProperties: false }),
  "Revision": Type.Ref('UInt53'),
  "DomainObjectRef": Type.Object({ "authorityId": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "id": Type.Ref('Id'), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "ToolDeferredRef": Type.Object({ "jobRef": Type.Ref('DomainObjectRef'), "pollAfterMs": Type.Ref('UInt53'), "deadline": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "ToolModelResult": Type.Object({ "output": Type.Ref('DataRef'), "artifacts": Type.Array(Type.Ref('ArtifactRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "isError": Type.Optional(Type.Boolean()), "terminate": Type.Optional(Type.Boolean()), "deferred": Type.Optional(Type.Ref('ToolDeferredRef')) }, { additionalProperties: false }),
  "ToolBatchRef": Type.Object({ "batchId": Type.Ref('Id'), "ordinal": Type.Ref('UInt53'), "parentBatchId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "ToolCall": Type.Object({ "definition": Type.Ref('ToolDefinition'), "input": Type.Ref('DataRef'), "expectedDefinitionDigest": Type.Ref('Digest'), "policy": Type.Ref('ToolPolicySnapshot'), "batchRef": Type.Union([Type.Ref('ToolBatchRef'), Type.Null()]), "modelContextRef": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "ToolResult": Type.Object({ "output": Type.Ref('DataRef'), "artifacts": Type.Array(Type.Ref('ArtifactRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "isError": Type.Optional(Type.Boolean()), "terminate": Type.Optional(Type.Boolean()), "deferred": Type.Optional(Type.Ref('ToolDeferredRef')), "details": Type.Optional(Type.Ref('DataRef')) }, { additionalProperties: false }),
  "ModelFeatures": Type.Object({ "input": Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]), { maxItems: 10000 }), "output": Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]), { maxItems: 10000 }), "tools": Type.Boolean(), "structuredOutput": Type.Boolean(), "streaming": Type.Boolean() }, { additionalProperties: false }),
  "SecretConsumerBinding": Type.Object({ "consumer": Type.Union([Type.Literal('model'), Type.Literal('mcp'), Type.Literal('tls'), Type.Literal('jwt'), Type.Literal('source-auth'), Type.Literal('surface'), Type.Literal('exec'), Type.Literal('artifact-ticket')]), "secretId": Type.Ref('Id'), "accountRef": Type.Union([Type.Ref('Id'), Type.Null()]), "serverRef": Type.Ref('Id'), "audience": Type.String(), "purpose": Type.String() }, { additionalProperties: false }),
  "ModelRouteSnapshot": Type.Object({ "routeId": Type.Ref('Id'), "routeRevision": Type.Ref('Revision'), "adapter": Type.Ref('BindingRef'), "model": Type.String(), "endpointRef": Type.Ref('Id'), "catalogRevision": Type.Ref('Revision'), "features": Type.Ref('ModelFeatures'), "priceVersion": Type.Ref('Id'), "credentialAudience": Type.String(), "credentialBinding": Type.Union([Type.Ref('SecretConsumerBinding'), Type.Null()]) }, { additionalProperties: false }),
  "ToolCatalogPolicy": Type.Object({ "disclosure": Type.Union([Type.Literal('standard'), Type.Literal('code'), Type.Literal('hybrid'), Type.Literal('provider-defined')]), "discoveredResourceIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "compactionAgentCallable": Type.Boolean(), "mainModel": Type.Union([Type.Ref('ModelRouteSnapshot'), Type.Null()]), "policyRevision": Type.Ref('Revision') }, { additionalProperties: false }),
  "ToolPlanUpdate": Type.Object({ "items": Type.Array(Type.Object({ "id": Type.Ref('Id'), "text": Type.String(), "status": Type.Union([Type.Literal('todo'), Type.Literal('doing'), Type.Literal('done'), Type.Literal('blocked')]), "check": Type.Optional(Type.String()) }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "TaintSnapshot": Type.Object({ "recordRevision": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "sourceSeq": Type.Ref('UInt53'), "clearedThroughSeq": Type.Ref('UInt53') }, { additionalProperties: false }),
  "SessionRef": Type.Object({ "sessionId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef') }, { additionalProperties: false }),
  "RunRef": Type.Object({ "runId": Type.Ref('Id'), "session": Type.Ref('SessionRef') }, { additionalProperties: false }),
  "InteractionRef": Type.Object({ "interactionId": Type.Ref('Id') }, { additionalProperties: false }),
  "PublicBlobReference": Type.Object({ "kind": Type.Literal('blob'), "value": Type.Ref('BlobRef') }, { additionalProperties: false }),
  "UploadSession": Type.Object({ "authorityId": Type.Ref('Id'), "uploadId": Type.Ref('Id'), "reservationId": Type.Ref('Id'), "expectedBytes": Type.Ref('UInt53'), "receivedBytes": Type.Ref('UInt53'), "expectedDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "mediaType": Type.String(), "status": Type.Union([Type.Literal('uploading'), Type.Literal('sealed'), Type.Literal('aborted')]), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "PublicUploadReference": Type.Object({ "kind": Type.Literal('upload'), "value": Type.Ref('UploadSession') }, { additionalProperties: false }),
  "StagedBlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "reservationId": Type.Ref('Id') }, { additionalProperties: false }),
  "PublicStagedBlobReference": Type.Object({ "kind": Type.Literal('staged-blob'), "value": Type.Ref('StagedBlobRef') }, { additionalProperties: false }),
  "PublicRef": Type.Union([Type.Object({ "kind": Type.Literal('session'), "value": Type.Ref('SessionRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('run'), "value": Type.Ref('RunRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('action'), "run": Type.Ref('RunRef'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('resource'), "value": Type.Ref('ResourceRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('artifact'), "value": Type.Ref('ArtifactRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('interaction'), "value": Type.Ref('InteractionRef') }, { additionalProperties: false }), Type.Ref('PublicBlobReference'), Type.Ref('PublicUploadReference'), Type.Ref('PublicStagedBlobReference'), Type.Object({ "kind": Type.Literal('domain'), "value": Type.Ref('DomainObjectRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('event'), "authorityId": Type.Ref('Id'), "eventId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('state'), "value": Type.Ref('DomainReference') }, { additionalProperties: false })]),
  "ApprovalGrantEvidence": Type.Object({ "grantId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "kind": Type.Union([Type.Literal('once'), Type.Literal('session'), Type.Literal('permanent')]), "actorRef": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "toolName": Type.String(), "scopes": Type.Array(Type.String(), { maxItems: 10000 }), "profileDigest": Type.Ref('Digest'), "policyVersion": Type.String(), "inputDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "validUntil": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "consumed": Type.Boolean() }, { additionalProperties: false }),
  "ReceiptPointer": Type.Object({ "authorityId": Type.Ref('Id'), "receiptId": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "TrustedPolicyFacts": Type.Object({ "factsId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "inputDigest": Type.Ref('Digest'), "evaluatedAt": Type.Ref('Timestamp'), "toolPolicy": Type.Union([Type.Ref('ToolPolicySnapshot'), Type.Null()]), "actor": Type.Object({ "principalRef": Type.Ref('Id'), "revision": Type.Ref('Revision'), "executionDomain": Type.Ref('Id'), "packageDigest": Type.Ref('Digest') }, { additionalProperties: false }), "taint": Type.Object({ "runId": Type.Ref('Id'), "current": Type.Ref('TaintSnapshot'), "captured": Type.Ref('TaintSnapshot'), "tainted": Type.Boolean(), "sourceRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }) }, { additionalProperties: false }), "configuration": Type.Object({ "revision": Type.Ref('Revision'), "profileDigest": Type.Ref('Digest'), "mode": Type.Union([Type.Literal('manual'), Type.Literal('smart'), Type.Literal('off')]), "yolo": Type.Boolean() }, { additionalProperties: false }), "authorization": Type.Object({ "decision": Type.Union([Type.Literal('allow'), Type.Literal('require-approval'), Type.Literal('deny')]), "policyRevision": Type.Ref('Revision'), "sourceRefs": Type.Array(Type.Ref('DomainReference'), { maxItems: 10000 }) }, { additionalProperties: false }), "grants": Type.Array(Type.Ref('ApprovalGrantEvidence'), { maxItems: 10000 }), "guardian": Type.Object({ "state": Type.Union([Type.Literal('not-needed'), Type.Literal('pending'), Type.Literal('decided')]), "actionId": Type.Union([Type.Ref('Id'), Type.Null()]), "resultRef": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]), "decision": Type.Union([Type.Literal('allow'), Type.Literal('ask'), Type.Literal('deny'), Type.Null()]) }, { additionalProperties: false }), "hookResults": Type.Union([Type.Ref('HookResultSet'), Type.Null()]), "approvalRequestRef": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "FilePath": Type.String(),
  "FileCheckpointProof": Type.Object({ "requestId": Type.Ref('Id'), "path": Type.Ref('FilePath'), "beforeVersion": Type.Union([Type.Ref('Revision'), Type.Null()]), "before": Type.Union([Type.Literal('present'), Type.Literal('absent')]), "restoration": Type.Ref('RetentionRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "PromptContributionSnapshot": Type.Object({ "digest": Type.Ref('Digest'), "registrationDigest": Type.Ref('Digest'), "sections": Type.Array(Type.Object({ "id": Type.Ref('Id'), "source": Type.Ref('BindingRef'), "order": Type.Ref('UInt53'), "content": Type.Ref('DataRef') }, { additionalProperties: false }), { maxItems: 10000 }), "runtimeContext": Type.Array(Type.Object({ "source": Type.Ref('BindingRef'), "content": Type.Ref('DataRef') }, { additionalProperties: false }), { maxItems: 10000 }), "candidateTools": Type.Array(Type.Ref('ResourceRef'), { maxItems: 10000 }), "conflictDiagnostics": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "SourceRange": Type.Object({ "session": Type.Ref('SessionRef'), "fromSeq": Type.Ref('UInt53'), "toSeq": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ContextItem": Type.Object({ "id": Type.Ref('Id'), "kind": Type.Union([Type.Literal('message'), Type.Literal('tool-call'), Type.Literal('tool-result'), Type.Literal('skill'), Type.Literal('resource'), Type.Literal('summary'), Type.Literal('memory')]), "body": Type.Ref('DataRef'), "sourceRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "trust": Type.Union([Type.Literal('system'), Type.Literal('user'), Type.Literal('external'), Type.Literal('derived')]), "tokenEstimate": Type.Ref('UInt53'), "protected": Type.Boolean(), "toolPairRef": Type.Union([Type.Ref('Id'), Type.Null()]), "sourceRanges": Type.Array(Type.Ref('SourceRange'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ContextView": Type.Object({ "viewId": Type.Ref('Id'), "format": Type.String(), "schema": Type.Ref('SchemaRef'), "baseRevision": Type.Ref('Revision'), "items": Type.Array(Type.Ref('ContextItem'), { maxItems: 10000 }), "tokenEstimate": Type.Ref('UInt53'), "protectedRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "inputDigest": Type.Ref('Digest'), "digest": Type.Ref('Digest'), "runtimeInstructionRefs": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ToolCatalog": Type.Object({ "revision": Type.Ref('Revision'), "digest": Type.Ref('Digest'), "tools": Type.Array(Type.Ref('ToolDefinition'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ThinkingLevel": Type.Union([Type.Literal('off'), Type.Literal('minimal'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max')]),
  "GenerationOptions": Type.Object({ "maxOutputTokens": Type.Ref('UInt53'), "temperature": Type.Optional(Type.Number()), "seed": Type.Optional(Type.Ref('UInt53')), "thinking": Type.Union([Type.Ref('ThinkingLevel'), Type.Null()]) }, { additionalProperties: false }),
  "MediaPlan": Type.Object({ "key": Type.Ref('Id'), "sourceRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "sourceDigest": Type.Ref('Digest'), "transformSchema": Type.Ref('SchemaRef'), "parameters": Type.Ref('DataRef'), "targetFeatures": Type.Ref('ModelFeatures'), "provider": Type.Ref('BindingRef') }, { additionalProperties: false }),
  "ExactQuantity": Type.Object({ "unit": Type.String(), "value": Type.String() }, { additionalProperties: false }),
  "LegacyRequestOverrides": Type.Object({ "samplingParams": Type.Optional(Type.Intersect([Type.Record(Type.String(), JsonValue, { maxProperties: 10000 }), Type.Object({})])), "maxTokens": Type.Optional(Type.Ref('UInt53')), "metadata": Type.Optional(Type.Intersect([Type.Record(Type.String(), JsonValue, { maxProperties: 10000 }), Type.Object({})])) }, { additionalProperties: false }),
  "SecretHandle": Type.Object({ "handleId": Type.Ref('Id'), "secretId": Type.Ref('Id'), "version": Type.String(), "audience": Type.String(), "expiresAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "PreparedModelRequest": Type.Object({ "preparedId": Type.Ref('Id'), "ownerBinding": Type.Ref('BindingRef'), "target": Type.Ref('ModelRouteSnapshot'), "view": Type.Ref('ContextView'), "inputDigest": Type.Ref('Digest'), "outputSchema": Type.Union([Type.Ref('SchemaRef'), Type.Null()]), "toolCatalog": Type.Union([Type.Ref('ToolCatalog'), Type.Null()]), "generation": Type.Ref('GenerationOptions'), "mediaPlans": Type.Array(Type.Ref('MediaPlan'), { maxItems: 10000 }), "estimatedUnits": Type.Array(Type.Ref('ExactQuantity'), { maxItems: 10000 }), "hookResults": Type.Union([Type.Ref('HookResultSet'), Type.Null()]), "sessionParameterRef": Type.Ref('DomainReference'), "legacyRequestOverrides": Type.Union([Type.Ref('LegacyRequestOverrides'), Type.Null()]), "credentialRef": Type.Union([Type.Ref('SecretHandle'), Type.Null()]) }, { additionalProperties: false }),
  "ContentBlock": Type.Union([Type.Object({ "type": Type.Literal('text'), "text": Type.String({ maxLength: 1048576 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('image'), "data": Type.String(), "mimeType": Type.String({ maxLength: 128 }) }, { additionalProperties: false }), Type.Object({ "type": Type.Literal('resource_link'), "uri": Type.String({ maxLength: 4096 }), "name": Type.Optional(Type.String({ maxLength: 256 })), "mimeType": Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false })]),
  "SlotName": Type.Union([Type.Literal('primary'), Type.Literal('escalation'), Type.Literal('fast'), Type.Literal('compaction'), Type.Literal('verifier'), Type.Literal('image'), Type.Literal('video')]),
  "SessionControlCommand": Type.Union([Type.Object({ "kind": Type.Union([Type.Literal('prompt'), Type.Literal('steer'), Type.Literal('follow-up')]), "content": Type.Array(Type.Ref('ContentBlock'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('compact'), "instructions": Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('fork'), "atNativeSeq": Type.Ref('UInt53'), "childSessionId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('set-preset'), "presetId": Type.Ref('Id'), "presetDigest": Type.Ref('Digest'), "apply": Type.Union([Type.Literal('next-request'), Type.Literal('next-run')]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('set-model'), "slot": Type.Ref('SlotName'), "route": Type.String(), "model": Type.String(), "thinking": Type.Union([Type.Ref('ThinkingLevel'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('set-yolo'), "enabled": Type.Boolean() }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('cancel'), "runId": Type.Ref('Id'), "reason": Type.String() }, { additionalProperties: false })]),
  "SessionControlRequest": Type.Object({ "sessionId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "expectedRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]), "command": Type.Ref('SessionControlCommand') }, { additionalProperties: false }),
  "SessionControlBoundary": Type.Object({ "kind": Type.Union([Type.Literal('immediate'), Type.Literal('next-request'), Type.Literal('next-turn'), Type.Literal('quiet-step'), Type.Literal('quiet-turn'), Type.Literal('next-run')]), "revision": Type.Ref('UInt53'), "runId": Type.Union([Type.Ref('Id'), Type.Null()]), "afterRequestId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "CompactOutcome": Type.Union([Type.Object({ "state": Type.Literal('completed'), "endSeq": Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('failed'), "endSeq": Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('unknown') }, { additionalProperties: false })]),
  "SessionControlResult": Type.Object({ "sessionId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "status": Type.Union([Type.Literal('accepted'), Type.Literal('applied'), Type.Literal('rejected')]), "revision": Type.Ref('UInt53'), "effective": Type.Union([Type.Ref('SessionControlBoundary'), Type.Null()]), "runId": Type.Union([Type.Ref('Id'), Type.Null()]), "childSessionId": Type.Union([Type.Ref('Id'), Type.Null()]), "compact": Type.Union([Type.Ref('CompactOutcome'), Type.Null()]), "error": Type.Union([Type.Ref('RuntimeError'), Type.Null()]) }, { additionalProperties: false }),
  "SessionParameterRevision": Type.Object({ "sessionId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "previousRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]), "sourceRequestId": Type.Ref('Id'), "presetId": Type.Ref('Id'), "presetDigest": Type.Ref('Digest'), "parameters": Type.Ref('ConfigValue'), "effective": Type.Ref('SessionControlBoundary'), "committedAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "SessionControlState": Type.Object({ "sessionId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "parameters": Type.Ref('SessionParameterRevision'), "activeRunId": Type.Union([Type.Ref('Id'), Type.Null()]), "activeTurnId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "ResourceLimits": Type.Object({ "cpuMs": Type.Ref('UInt53'), "wallMs": Type.Ref('UInt53'), "memoryBytes": Type.Ref('UInt53'), "outputBytes": Type.Ref('UInt53'), "processes": Type.Ref('UInt53'), "openFiles": Type.Ref('UInt53') }, { additionalProperties: false }),
  "AgentSpawnRequest": Type.Object({ "presetRef": Type.Ref('Id'), "inputRef": Type.Ref('DataRef'), "parentBudgetRef": Type.Ref('DomainObjectRef'), "limits": Type.Ref('ResourceLimits'), "kind": Type.Union([Type.Literal('fork'), Type.Literal('spawn')]), "start": Type.Boolean(), "forkSource": Type.Union([Type.Object({ "session": Type.Ref('SessionRef'), "atNativeSeq": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Null()]), "workspace": Type.Union([Type.Literal('shared'), Type.Literal('worktree')]) }, { additionalProperties: false }),
  "FileStat": Type.Object({ "kind": Type.Union([Type.Literal('file'), Type.Literal('directory'), Type.Literal('symlink'), Type.Literal('other')]), "bytes": Type.Ref('UInt53'), "mtimeMs": Type.Number(), "version": Type.Ref('Revision') }, { additionalProperties: false }),
  "RunState": Type.Union([Type.Literal('admitted'), Type.Literal('runnable'), Type.Literal('waiting'), Type.Literal('failing'), Type.Literal('cancelling'), Type.Literal('draining'), Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('frozen'), Type.Literal('migrating'), Type.Literal('blocked_incompatible'), Type.Literal('blocked_integrity')]),
  "UsageFactRef": Type.Object({ "authorityId": Type.Ref('Id'), "usageId": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "AgentSnapshot": Type.Object({ "agentRef": Type.Ref('DomainObjectRef'), "runRef": Type.Ref('RunRef'), "lifecycle": Type.Union([Type.Literal('active'), Type.Literal('draining'), Type.Literal('retired'), Type.Literal('blocked')]), "runState": Type.Ref('RunState'), "resultRef": Type.Union([Type.Ref('DataRef'), Type.Null()]), "error": Type.Union([Type.Ref('RuntimeError'), Type.Null()]), "usageRefs": Type.Array(Type.Ref('UsageFactRef'), { maxItems: 10000 }), "children": Type.Array(Type.Ref('DomainObjectRef'), { maxItems: 10000 }), "limits": Type.Ref('ResourceLimits') }, { additionalProperties: false }),
  "ToolConversationHeadValue": Type.Object({ "actionId": Type.Ref('Id'), "callFactId": Type.Ref('Id'), "resultFactId": Type.Ref('Id'), "visibleReceiptId": Type.Ref('Id'), "revision": Type.Ref('UInt53') }, { additionalProperties: false }),
  "PlanRevisionValue": Type.Object({ "sessionId": Type.Ref('Id'), "turnId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "items": Type.Ref('ToolPlanUpdate'), "sourceCommandId": Type.Ref('Id'), "seq": Type.Ref('UInt53') }, { additionalProperties: false }),
})

export const Id = RuntimePublic2.Import('Id')
export type Id = Static<typeof Id>
export const UInt53 = RuntimePublic2.Import('UInt53')
export type UInt53 = Static<typeof UInt53>
export const Timestamp = RuntimePublic2.Import('Timestamp')
export type Timestamp = Static<typeof Timestamp>
export const TypeId = RuntimePublic2.Import('TypeId')
export type TypeId = Static<typeof TypeId>
export const Digest = RuntimePublic2.Import('Digest')
export type Digest = Static<typeof Digest>
export const SchemaRef = RuntimePublic2.Import('SchemaRef')
export type SchemaRef = Static<typeof SchemaRef>
export const BlobRef = RuntimePublic2.Import('BlobRef')
export type BlobRef = Static<typeof BlobRef>
export const DataRef = RuntimePublic2.Import('DataRef')
export type DataRef = Static<typeof DataRef>
export const ActionRef = RuntimePublic2.Import('ActionRef')
export type ActionRef = Static<typeof ActionRef>
export const ActionDependency = RuntimePublic2.Import('ActionDependency')
export type ActionDependency = Static<typeof ActionDependency>
export const RuntimeErrorCode = RuntimePublic2.Import('RuntimeErrorCode')
export type RuntimeErrorCode = Static<typeof RuntimeErrorCode>
export const OwnerRef = RuntimePublic2.Import('OwnerRef')
export type OwnerRef = Static<typeof OwnerRef>
export const RetryAdvice = RuntimePublic2.Import('RetryAdvice')
export type RetryAdvice = Static<typeof RetryAdvice>
export const RuntimeError = RuntimePublic2.Import('RuntimeError')
export type RuntimeError = Static<typeof RuntimeError>
export const RetentionRef = RuntimePublic2.Import('RetentionRef')
export type RetentionRef = Static<typeof RetentionRef>
export const BindingRef = RuntimePublic2.Import('BindingRef')
export type BindingRef = Static<typeof BindingRef>
export const Provenance = RuntimePublic2.Import('Provenance')
export type Provenance = Static<typeof Provenance>
export const StateAuthorityRef = RuntimePublic2.Import('StateAuthorityRef')
export type StateAuthorityRef = Static<typeof StateAuthorityRef>
export const RetryPolicy = RuntimePublic2.Import('RetryPolicy')
export type RetryPolicy = Static<typeof RetryPolicy>
export const PreparedAction = RuntimePublic2.Import('PreparedAction')
export type PreparedAction = Static<typeof PreparedAction>
export const HookEventName = RuntimePublic2.Import('HookEventName')
export type HookEventName = Static<typeof HookEventName>
export const HookResultSet = RuntimePublic2.Import('HookResultSet')
export type HookResultSet = Static<typeof HookResultSet>
export const DomainReference = RuntimePublic2.Import('DomainReference')
export type DomainReference = Static<typeof DomainReference>
export const InlineResultHookSource = RuntimePublic2.Import('InlineResultHookSource')
export type InlineResultHookSource = Static<typeof InlineResultHookSource>
export const RelativePath = RuntimePublic2.Import('RelativePath')
export type RelativePath = Static<typeof RelativePath>
export const Scope = RuntimePublic2.Import('Scope')
export type Scope = Static<typeof Scope>
export const CapabilityRequirement = RuntimePublic2.Import('CapabilityRequirement')
export type CapabilityRequirement = Static<typeof CapabilityRequirement>
export const OperationDescriptor = RuntimePublic2.Import('OperationDescriptor')
export type OperationDescriptor = Static<typeof OperationDescriptor>
export const CommunityOwnerPackageId = RuntimePublic2.Import('CommunityOwnerPackageId')
export type CommunityOwnerPackageId = Static<typeof CommunityOwnerPackageId>
export const CommunityContractRef = RuntimePublic2.Import('CommunityContractRef')
export type CommunityContractRef = Static<typeof CommunityContractRef>
export const ServiceRequirement = RuntimePublic2.Import('ServiceRequirement')
export type ServiceRequirement = Static<typeof ServiceRequirement>
export const StateCodecRef = RuntimePublic2.Import('StateCodecRef')
export type StateCodecRef = Static<typeof StateCodecRef>
export const ProviderDescriptor = RuntimePublic2.Import('ProviderDescriptor')
export type ProviderDescriptor = Static<typeof ProviderDescriptor>
export const ProviderRef = RuntimePublic2.Import('ProviderRef')
export type ProviderRef = Static<typeof ProviderRef>
export const ServiceSelection = RuntimePublic2.Import('ServiceSelection')
export type ServiceSelection = Static<typeof ServiceSelection>
export const ConfigValue = RuntimePublic2.Import('ConfigValue')
export type ConfigValue = Static<typeof ConfigValue>
export const ConfigPatch = RuntimePublic2.Import('ConfigPatch')
export type ConfigPatch = Static<typeof ConfigPatch>
export const ConfigOverride = RuntimePublic2.Import('ConfigOverride')
export type ConfigOverride = Static<typeof ConfigOverride>
export const PackageSource = RuntimePublic2.Import('PackageSource')
export type PackageSource = Static<typeof PackageSource>
export const ExportRef = RuntimePublic2.Import('ExportRef')
export type ExportRef = Static<typeof ExportRef>
export const RendererDescriptor = RuntimePublic2.Import('RendererDescriptor')
export type RendererDescriptor = Static<typeof RendererDescriptor>
export const Limits = RuntimePublic2.Import('Limits')
export type Limits = Static<typeof Limits>
export const ConversationRecord = RuntimePublic2.Import('ConversationRecord')
export type ConversationRecord = Static<typeof ConversationRecord>
export const ServiceOperation = RuntimePublic2.Import('ServiceOperation')
export type ServiceOperation = Static<typeof ServiceOperation>
export const ActionSpec = RuntimePublic2.Import('ActionSpec')
export type ActionSpec = Static<typeof ActionSpec>
export const InputPreparationRequired = RuntimePublic2.Import('InputPreparationRequired')
export type InputPreparationRequired = Static<typeof InputPreparationRequired>
export const HookEvaluationRecordValue = RuntimePublic2.Import('HookEvaluationRecordValue')
export type HookEvaluationRecordValue = Static<typeof HookEvaluationRecordValue>
export const BridgeSessionValue = RuntimePublic2.Import('BridgeSessionValue')
export type BridgeSessionValue = Static<typeof BridgeSessionValue>
export const LegacyBridgeRequest = RuntimePublic2.Import('LegacyBridgeRequest')
export type LegacyBridgeRequest = Static<typeof LegacyBridgeRequest>
export const ToolPolicyDefaults = RuntimePublic2.Import('ToolPolicyDefaults')
export type ToolPolicyDefaults = Static<typeof ToolPolicyDefaults>
export const ToolPolicySnapshot = RuntimePublic2.Import('ToolPolicySnapshot')
export type ToolPolicySnapshot = Static<typeof ToolPolicySnapshot>
export const ToolExecutionConstraints = RuntimePublic2.Import('ToolExecutionConstraints')
export type ToolExecutionConstraints = Static<typeof ToolExecutionConstraints>
export const ResourceRef = RuntimePublic2.Import('ResourceRef')
export type ResourceRef = Static<typeof ResourceRef>
export const ToolDefinition = RuntimePublic2.Import('ToolDefinition')
export type ToolDefinition = Static<typeof ToolDefinition>
export const ArtifactVersion = RuntimePublic2.Import('ArtifactVersion')
export type ArtifactVersion = Static<typeof ArtifactVersion>
export const ArtifactRef = RuntimePublic2.Import('ArtifactRef')
export type ArtifactRef = Static<typeof ArtifactRef>
export const Revision = RuntimePublic2.Import('Revision')
export type Revision = Static<typeof Revision>
export const DomainObjectRef = RuntimePublic2.Import('DomainObjectRef')
export type DomainObjectRef = Static<typeof DomainObjectRef>
export const ToolDeferredRef = RuntimePublic2.Import('ToolDeferredRef')
export type ToolDeferredRef = Static<typeof ToolDeferredRef>
export const ToolModelResult = RuntimePublic2.Import('ToolModelResult')
export type ToolModelResult = Static<typeof ToolModelResult>
export const ToolBatchRef = RuntimePublic2.Import('ToolBatchRef')
export type ToolBatchRef = Static<typeof ToolBatchRef>
export const ToolCall = RuntimePublic2.Import('ToolCall')
export type ToolCall = Static<typeof ToolCall>
export const ToolResult = RuntimePublic2.Import('ToolResult')
export type ToolResult = Static<typeof ToolResult>
export const ModelFeatures = RuntimePublic2.Import('ModelFeatures')
export type ModelFeatures = Static<typeof ModelFeatures>
export const SecretConsumerBinding = RuntimePublic2.Import('SecretConsumerBinding')
export type SecretConsumerBinding = Static<typeof SecretConsumerBinding>
export const ModelRouteSnapshot = RuntimePublic2.Import('ModelRouteSnapshot')
export type ModelRouteSnapshot = Static<typeof ModelRouteSnapshot>
export const ToolCatalogPolicy = RuntimePublic2.Import('ToolCatalogPolicy')
export type ToolCatalogPolicy = Static<typeof ToolCatalogPolicy>
export const ToolPlanUpdate = RuntimePublic2.Import('ToolPlanUpdate')
export type ToolPlanUpdate = Static<typeof ToolPlanUpdate>
export const TaintSnapshot = RuntimePublic2.Import('TaintSnapshot')
export type TaintSnapshot = Static<typeof TaintSnapshot>
export const SessionRef = RuntimePublic2.Import('SessionRef')
export type SessionRef = Static<typeof SessionRef>
export const RunRef = RuntimePublic2.Import('RunRef')
export type RunRef = Static<typeof RunRef>
export const InteractionRef = RuntimePublic2.Import('InteractionRef')
export type InteractionRef = Static<typeof InteractionRef>
export const PublicBlobReference = RuntimePublic2.Import('PublicBlobReference')
export type PublicBlobReference = Static<typeof PublicBlobReference>
export const UploadSession = RuntimePublic2.Import('UploadSession')
export type UploadSession = Static<typeof UploadSession>
export const PublicUploadReference = RuntimePublic2.Import('PublicUploadReference')
export type PublicUploadReference = Static<typeof PublicUploadReference>
export const StagedBlobRef = RuntimePublic2.Import('StagedBlobRef')
export type StagedBlobRef = Static<typeof StagedBlobRef>
export const PublicStagedBlobReference = RuntimePublic2.Import('PublicStagedBlobReference')
export type PublicStagedBlobReference = Static<typeof PublicStagedBlobReference>
export const PublicRef = RuntimePublic2.Import('PublicRef')
export type PublicRef = Static<typeof PublicRef>
export const ApprovalGrantEvidence = RuntimePublic2.Import('ApprovalGrantEvidence')
export type ApprovalGrantEvidence = Static<typeof ApprovalGrantEvidence>
export const ReceiptPointer = RuntimePublic2.Import('ReceiptPointer')
export type ReceiptPointer = Static<typeof ReceiptPointer>
export const TrustedPolicyFacts = RuntimePublic2.Import('TrustedPolicyFacts')
export type TrustedPolicyFacts = Static<typeof TrustedPolicyFacts>
export const FilePath = RuntimePublic2.Import('FilePath')
export type FilePath = Static<typeof FilePath>
export const FileCheckpointProof = RuntimePublic2.Import('FileCheckpointProof')
export type FileCheckpointProof = Static<typeof FileCheckpointProof>
export const PromptContributionSnapshot = RuntimePublic2.Import('PromptContributionSnapshot')
export type PromptContributionSnapshot = Static<typeof PromptContributionSnapshot>
export const SourceRange = RuntimePublic2.Import('SourceRange')
export type SourceRange = Static<typeof SourceRange>
export const ContextItem = RuntimePublic2.Import('ContextItem')
export type ContextItem = Static<typeof ContextItem>
export const ContextView = RuntimePublic2.Import('ContextView')
export type ContextView = Static<typeof ContextView>
export const ToolCatalog = RuntimePublic2.Import('ToolCatalog')
export type ToolCatalog = Static<typeof ToolCatalog>
export const ThinkingLevel = RuntimePublic2.Import('ThinkingLevel')
export type ThinkingLevel = Static<typeof ThinkingLevel>
export const GenerationOptions = RuntimePublic2.Import('GenerationOptions')
export type GenerationOptions = Static<typeof GenerationOptions>
export const MediaPlan = RuntimePublic2.Import('MediaPlan')
export type MediaPlan = Static<typeof MediaPlan>
export const ExactQuantity = RuntimePublic2.Import('ExactQuantity')
export type ExactQuantity = Static<typeof ExactQuantity>
export const LegacyRequestOverrides = RuntimePublic2.Import('LegacyRequestOverrides')
export type LegacyRequestOverrides = Static<typeof LegacyRequestOverrides>
export const SecretHandle = RuntimePublic2.Import('SecretHandle')
export type SecretHandle = Static<typeof SecretHandle>
export const PreparedModelRequest = RuntimePublic2.Import('PreparedModelRequest')
export type PreparedModelRequest = Static<typeof PreparedModelRequest>
export const ContentBlock = RuntimePublic2.Import('ContentBlock')
export type ContentBlock = Static<typeof ContentBlock>
export const SlotName = RuntimePublic2.Import('SlotName')
export type SlotName = Static<typeof SlotName>
export const SessionControlCommand = RuntimePublic2.Import('SessionControlCommand')
export type SessionControlCommand = Static<typeof SessionControlCommand>
export const SessionControlRequest = RuntimePublic2.Import('SessionControlRequest')
export type SessionControlRequest = Static<typeof SessionControlRequest>
export const SessionControlBoundary = RuntimePublic2.Import('SessionControlBoundary')
export type SessionControlBoundary = Static<typeof SessionControlBoundary>
export const CompactOutcome = RuntimePublic2.Import('CompactOutcome')
export type CompactOutcome = Static<typeof CompactOutcome>
export const SessionControlResult = RuntimePublic2.Import('SessionControlResult')
export type SessionControlResult = Static<typeof SessionControlResult>
export const SessionParameterRevision = RuntimePublic2.Import('SessionParameterRevision')
export type SessionParameterRevision = Static<typeof SessionParameterRevision>
export const SessionControlState = RuntimePublic2.Import('SessionControlState')
export type SessionControlState = Static<typeof SessionControlState>
export const ResourceLimits = RuntimePublic2.Import('ResourceLimits')
export type ResourceLimits = Static<typeof ResourceLimits>
export const AgentSpawnRequest = RuntimePublic2.Import('AgentSpawnRequest')
export type AgentSpawnRequest = Static<typeof AgentSpawnRequest>
export const FileStat = RuntimePublic2.Import('FileStat')
export type FileStat = Static<typeof FileStat>
export const RunState = RuntimePublic2.Import('RunState')
export type RunState = Static<typeof RunState>
export const UsageFactRef = RuntimePublic2.Import('UsageFactRef')
export type UsageFactRef = Static<typeof UsageFactRef>
export const AgentSnapshot = RuntimePublic2.Import('AgentSnapshot')
export type AgentSnapshot = Static<typeof AgentSnapshot>
export const ToolConversationHeadValue = RuntimePublic2.Import('ToolConversationHeadValue')
export type ToolConversationHeadValue = Static<typeof ToolConversationHeadValue>
export const PlanRevisionValue = RuntimePublic2.Import('PlanRevisionValue')
export type PlanRevisionValue = Static<typeof PlanRevisionValue>
