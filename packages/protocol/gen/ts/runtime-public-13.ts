import type { Page } from './runtime-public.js'
// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const RuntimePublic13 = Type.Module({
  "Id": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
  "UInt53": Type.Integer({ minimum: 0, maximum: 9007199254740991 }),
  "Timestamp": Type.String({ pattern: "Z$", format: "date-time" }),
  "TypeId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[a-z][a-z0-9.-]*/[a-zA-Z0-9._/-]+@[1-9][0-9]*$" }),
  "Digest": Type.String({ pattern: "^[a-f0-9]{64}$" }),
  "SchemaRef": Type.Object({ "typeId": Type.Ref('TypeId'), "revision": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "BlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "DataRef": Type.Union([Type.Object({ "kind": Type.Literal('inline'), "schema": Type.Ref('SchemaRef'), "value": JsonValue, "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "schema": Type.Ref('SchemaRef'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "ActionRef": Type.Union([Type.Object({ "existingActionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "localKey": Type.String() }, { additionalProperties: false })]),
  "RuntimeErrorCode": Type.Union([Type.Literal('invalid_input'), Type.Literal('denied'), Type.Literal('incompatible'), Type.Literal('quota'), Type.Literal('cancelled'), Type.Literal('timeout'), Type.Literal('retryable'), Type.Literal('unknown_effect'), Type.Literal('conflict'), Type.Literal('internal')]),
  "OwnerRef": Type.Object({ "kind": Type.Union([Type.Literal('run'), Type.Literal('action'), Type.Literal('job'), Type.Literal('reconciliation')]), "id": Type.Ref('Id') }, { additionalProperties: false }),
  "RetryAdvice": Type.Union([Type.Object({ "kind": Type.Literal('never') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_read'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_same_action'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('reconcile'), "ownerRef": Type.Ref('OwnerRef') }, { additionalProperties: false })]),
  "RuntimeError": Type.Object({ "code": Type.Ref('RuntimeErrorCode'), "detailCode": Type.String(), "message": Type.String(), "retryAdvice": Type.Ref('RetryAdvice'), "diagnosticId": Type.Ref('Id'), "safeDetail": Type.Optional(JsonValue) }, { additionalProperties: false }),
  "ExternalRequestRef": Type.Object({ "system": Type.String(), "requestId": Type.Ref('Id'), "idempotencyKey": Type.Optional(Type.String()), "requestDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "RetentionRef": Type.Object({ "kind": Type.Union([Type.Literal('blob'), Type.Literal('artifact'), Type.Literal('domain-record'), Type.Literal('package'), Type.Literal('schema'), Type.Literal('codec')]), "authorityId": Type.Ref('Id'), "resourceId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest'), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "BindingRef": Type.Object({ "bindingId": Type.Ref('Id'), "contract": Type.String(), "logicalName": Type.String(), "providerId": Type.Ref('Id') }, { additionalProperties: false }),
  "Provenance": Type.Object({ "sourceRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "producer": Type.Ref('BindingRef'), "trustLabels": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ActionResultView": Type.Object({ "receiptId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "inputDigest": Type.Ref('Digest'), "outcome": Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('unknown_effect')]), "result": Type.Optional(Type.Ref('DataRef')), "error": Type.Optional(Type.Ref('RuntimeError')), "externalRequests": Type.Array(Type.Ref('ExternalRequestRef'), { maxItems: 10000 }), "usageRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "references": Type.Array(Type.Ref('RetentionRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "completedAt": Type.Ref('Timestamp'), "visibility": Type.Literal('ready'), "viewId": Type.Ref('Id'), "sourceReceiptId": Type.Ref('Id'), "hookResultSetRef": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "StateAuthorityRef": Type.Object({ "authorityId": Type.Ref('Id'), "tenantId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ScopeRef": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "kind": Type.Literal('installation') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "kind": Type.Literal('runtime') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('run') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('action'), "actionId": Type.Ref('Id') }, { additionalProperties: false })]),
  "DomainReference": Type.Object({ "authorityId": Type.Ref('Id'), "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53'), "schema": Type.Ref('SchemaRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "DispatchAtomicDomain": Type.Object({ "domainId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "stateAuthority": Type.Ref('StateAuthorityRef'), "budgetAuthority": Type.Ref('StateAuthorityRef'), "stateBinding": Type.Ref('BindingRef'), "budgetBinding": Type.Ref('BindingRef') }, { additionalProperties: false }),
  "Money": Type.Object({ "currency": Type.String(), "scale": Type.Literal(6), "units": Type.String() }, { additionalProperties: false }),
  "DomainEvent": Type.Object({ "eventId": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "schema": Type.Ref('SchemaRef'), "source": Type.Ref('BindingRef'), "scope": Type.Ref('ScopeRef'), "occurredAt": Type.Ref('Timestamp'), "payload": Type.Ref('DataRef'), "idempotencyKey": Type.String(), "causation": Type.Object({ "runId": Type.Optional(Type.Ref('Id')), "actionId": Type.Optional(Type.Ref('Id')), "attemptId": Type.Optional(Type.Ref('Id')), "commandId": Type.Optional(Type.Ref('Id')) }, { additionalProperties: false }) }, { additionalProperties: false }),
  "Scope": Type.Union([Type.Literal('installation'), Type.Literal('runtime'), Type.Literal('workspace'), Type.Literal('session'), Type.Literal('run'), Type.Literal('action')]),
  "IsolationMode": Type.Union([Type.Literal('trusted-in-process'), Type.Literal('isolated-process'), Type.Literal('remote')]),
  "CapabilityRequirement": Type.Object({ "capability": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "resourceTypes": Type.Array(Type.Ref('TypeId'), { minItems: 0, maxItems: 64 }), "operations": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }) }, { additionalProperties: false }),
  "OperationDescriptor": Type.Object({ "method": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "kind": Type.Union([Type.Literal('query'), Type.Literal('action'), Type.Literal('control'), Type.Literal('compute'), Type.Literal('maintenance'), Type.Literal('observe'), Type.Literal('ingress')]), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 64 }), "retrySafety": Type.Union([Type.Literal('read-only'), Type.Literal('idempotent'), Type.Literal('reconcile-first'), Type.Literal('never')]) }, { additionalProperties: false }),
  "CommunityOwnerPackageId": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh(?:[./]|$))[^\\u0000-\\u001f\\u007f]+$" }),
  "CommunityContractRef": Type.Object({ "ownerPackageId": Type.Ref('CommunityOwnerPackageId'), "definitionDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ServiceRequirement": Type.Union([Type.Object({ "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)(?=^[^\\u0000-\\u001f\\u007f]+$)^agh\\." }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "features": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Ref('Scope'), "optional": Type.Boolean() }, { additionalProperties: false }), Type.Object({ "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)(?=(?=^[^\\u0000-\\u001f\\u007f]+$)^(?!agh\\.).*$)^(?!agh(?:[./]|$))[^\\u0000-\\u001f\\u007f]+/[a-z][a-z0-9-]*$" }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "features": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Union([Type.Literal('runtime'), Type.Literal('workspace'), Type.Literal('session'), Type.Literal('run'), Type.Literal('action')]), "optional": Type.Boolean(), "contractDefinition": Type.Ref('CommunityContractRef') }, { additionalProperties: false })]),
  "StateCodecRef": Type.Object({ "namespace": Type.Ref('Id'), "codecVersion": Type.Ref('Id'), "schema": Type.Ref('SchemaRef') }, { additionalProperties: false }),
  "ProviderDescriptor": Type.Union([Type.Object({ "providerId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)(?=^[^\\u0000-\\u001f\\u007f]+$)^agh\\." }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "packageVersion": Type.String({ maxLength: 128, pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$" }), "packageDigest": Type.String({ pattern: "^[a-f0-9]{64}$" }), "features": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Ref('Scope'), "configSchema": Type.Ref('SchemaRef'), "requires": Type.Array(Type.Ref('ServiceRequirement'), { minItems: 0, maxItems: 128 }), "capabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 128 }), "recovery": Type.Union([Type.Literal('R0'), Type.Literal('R1'), Type.Literal('R2')]), "isolation": Type.Array(Type.Union([Type.Literal('trusted-in-process'), Type.Literal('isolated-process'), Type.Literal('remote')]), { minItems: 1, maxItems: 3 }), "stateCodecs": Type.Array(Type.Ref('StateCodecRef'), { minItems: 0, maxItems: 64 }), "activationMode": Type.Union([Type.Literal('eager'), Type.Literal('lazy')]), "operations": Type.Array(Type.Ref('OperationDescriptor'), { minItems: 0, maxItems: 128 }) }, { additionalProperties: false }), Type.Object({ "providerId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)(?=(?=^[^\\u0000-\\u001f\\u007f]+$)^(?!agh\\.).*$)^(?!agh(?:[./]|$))[^\\u0000-\\u001f\\u007f]+/[a-z][a-z0-9-]*$" }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "packageVersion": Type.String({ maxLength: 128, pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$" }), "packageDigest": Type.String({ pattern: "^[a-f0-9]{64}$" }), "features": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Union([Type.Literal('runtime'), Type.Literal('workspace'), Type.Literal('session'), Type.Literal('run'), Type.Literal('action')]), "configSchema": Type.Ref('SchemaRef'), "requires": Type.Array(Type.Ref('ServiceRequirement'), { minItems: 0, maxItems: 128 }), "capabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 128 }), "recovery": Type.Union([Type.Literal('R0'), Type.Literal('R1'), Type.Literal('R2')]), "isolation": Type.Array(Type.Union([Type.Literal('trusted-in-process'), Type.Literal('isolated-process'), Type.Literal('remote')]), { minItems: 1, maxItems: 3 }), "stateCodecs": Type.Array(Type.Ref('StateCodecRef'), { minItems: 0, maxItems: 64 }), "activationMode": Type.Union([Type.Literal('eager'), Type.Literal('lazy')]), "operations": Type.Array(Type.Union([Type.Object({ "method": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "kind": Type.Union([Type.Literal('query'), Type.Literal('compute')]), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 64 }), "retrySafety": Type.Literal('read-only') }, { additionalProperties: false }), Type.Object({ "method": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "kind": Type.Literal('action'), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 64 }), "retrySafety": Type.Union([Type.Literal('read-only'), Type.Literal('idempotent'), Type.Literal('reconcile-first'), Type.Literal('never')]) }, { additionalProperties: false })]), { minItems: 1, maxItems: 128, uniqueItems: true }), "contractDefinition": Type.Ref('CommunityContractRef') }, { additionalProperties: false })]),
  "ConfigValue": Type.Object({ "schema": Type.Ref('SchemaRef'), "value": JsonValue }, { additionalProperties: false }),
  "ResourceRef": Type.Object({ "resourceId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ArtifactRef": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('UInt53') }, { additionalProperties: false }),
  "Revision": Type.Ref('UInt53'),
  "DomainObjectRef": Type.Object({ "authorityId": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "id": Type.Ref('Id'), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "SessionRef": Type.Object({ "sessionId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef') }, { additionalProperties: false }),
  "RunRef": Type.Object({ "runId": Type.Ref('Id'), "session": Type.Ref('SessionRef') }, { additionalProperties: false }),
  "InteractionRef": Type.Object({ "interactionId": Type.Ref('Id') }, { additionalProperties: false }),
  "UploadSession": Type.Object({ "authorityId": Type.Ref('Id'), "uploadId": Type.Ref('Id'), "reservationId": Type.Ref('Id'), "expectedBytes": Type.Ref('UInt53'), "receivedBytes": Type.Ref('UInt53'), "expectedDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "mediaType": Type.String(), "status": Type.Union([Type.Literal('uploading'), Type.Literal('sealed'), Type.Literal('aborted')]), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "StagedBlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "reservationId": Type.Ref('Id') }, { additionalProperties: false }),
  "PublicRef": Type.Union([Type.Object({ "kind": Type.Literal('session'), "value": Type.Ref('SessionRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('run'), "value": Type.Ref('RunRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('action'), "run": Type.Ref('RunRef'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('resource'), "value": Type.Ref('ResourceRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('artifact'), "value": Type.Ref('ArtifactRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('interaction'), "value": Type.Ref('InteractionRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "value": Type.Ref('BlobRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('upload'), "value": Type.Ref('UploadSession') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('staged-blob'), "value": Type.Ref('StagedBlobRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('domain'), "value": Type.Ref('DomainObjectRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('event'), "authorityId": Type.Ref('Id'), "eventId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('state'), "value": Type.Ref('DomainReference') }, { additionalProperties: false })]),
  "ReceiptPointer": Type.Object({ "authorityId": Type.Ref('Id'), "receiptId": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ServiceCommandRecord": Type.Object({ "commandId": Type.Ref('Id'), "fingerprint": Type.Ref('Digest'), "sessionId": Type.Ref('Id'), "principalRef": Type.Ref('Id'), "sourceRef": Type.Ref('Id'), "extensionId": Type.Ref('Id'), "serviceName": Type.String(), "releaseSetId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "runId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "state": Type.Union([Type.Literal('accepted'), Type.Literal('running'), Type.Literal('settled'), Type.Literal('unknown')]), "resultRef": Type.Union([Type.Ref('DataRef'), Type.Null()]), "error": Type.Union([Type.Ref('RuntimeError'), Type.Null()]), "ownerRef": Type.Ref('OwnerRef') }, { additionalProperties: false }),
  "ResourceChangePlan": Type.Object({ "planId": Type.Ref('Id'), "kind": Type.Union([Type.Literal('mcp'), Type.Literal('skill')]), "operation": Type.Union([Type.Literal('install'), Type.Literal('update'), Type.Literal('remove')]), "targetScope": Type.Ref('ScopeRef'), "resourceId": Type.Ref('Id'), "sourceRef": Type.Union([Type.Ref('ResourceRef'), Type.Null()]), "expectedRevision": Type.Union([Type.Ref('Revision'), Type.Null()]), "config": Type.Union([Type.Ref('ConfigValue'), Type.Null()]), "permissionDifference": Type.Array(Type.Ref('CapabilityRequirement'), { maxItems: 10000 }), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "PackageLocator": Type.Union([Type.Object({ "kind": Type.Literal('local'), "sourceId": Type.Ref('Id'), "pathRef": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('npm'), "sourceId": Type.Ref('Id'), "name": Type.String(), "version": Type.String(), "integrity": Type.String(), "digest": Type.Ref('Digest') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('git'), "sourceId": Type.Ref('Id'), "repository": Type.String(), "commit": Type.String(), "subdirectory": Type.String(), "digest": Type.Ref('Digest') }, { additionalProperties: false })]),
  "ResolvedProviderBinding": Type.Object({ "binding": Type.Ref('BindingRef'), "descriptor": Type.Ref('ProviderDescriptor'), "isolation": Type.Ref('IsolationMode'), "config": Type.Ref('DataRef'), "configDigest": Type.Ref('Digest'), "dependencies": Type.Array(Type.Ref('BindingRef'), { maxItems: 10000 }), "codecRefs": Type.Array(Type.Ref('StateCodecRef'), { maxItems: 10000 }), "schemaRefs": Type.Array(Type.Ref('SchemaRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "VersionedRef": Type.Object({ "id": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "digest": Type.Ref('Digest'), "data": Type.Ref('DataRef') }, { additionalProperties: false }),
  "ContentRef": Type.Ref('DataRef'),
  "ReleaseSet": Type.Object({ "releaseSetId": Type.String(), "formatVersion": Type.Number(), "hostAbi": Type.String(), "packages": Type.Array(Type.Object({ "packageId": Type.String(), "version": Type.String(), "digest": Type.String(), "sourceRef": Type.String(), "integrityRef": Type.String(), "entries": Type.Record(Type.String(), Type.Object({ "digest": Type.String(), "platform": Type.String() }, { additionalProperties: false }), { maxProperties: 10000 }) }, { additionalProperties: false }), { maxItems: 10000 }), "bindings": Type.Array(Type.Ref('ResolvedProviderBinding'), { maxItems: 10000 }), "profileRef": Type.Ref('VersionedRef'), "presetRef": Type.Ref('VersionedRef'), "configSnapshotRef": Type.Ref('ContentRef'), "schemasRef": Type.Ref('ContentRef'), "clientBundlesRef": Type.Ref('ContentRef'), "recoveryManifestRef": Type.Ref('ContentRef'), "resourceClaimsRef": Type.Ref('ContentRef') }, { additionalProperties: false }),
  "ReleasePlan": Type.Object({ "planId": Type.Ref('Id'), "upgradeId": Type.Ref('Id'), "planFingerprint": Type.Ref('Digest'), "operation": Type.Union([Type.Literal('install'), Type.Literal('upgrade'), Type.Literal('disable'), Type.Literal('repair'), Type.Literal('rollback')]), "routeId": Type.Ref('Id'), "expectedRouteRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]), "sourceReleaseSetId": Type.Union([Type.Ref('Id'), Type.Null()]), "targetReleaseSet": Type.Ref('ReleaseSet'), "affectedContributions": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "configDigest": Type.Ref('Digest'), "permissionDifference": Type.Object({ "beforeProfileDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "afterProfileDigest": Type.Ref('Digest'), "added": Type.Array(Type.Ref('CapabilityRequirement'), { maxItems: 10000 }), "removed": Type.Array(Type.Ref('CapabilityRequirement'), { maxItems: 10000 }), "policyChanges": Type.Array(Type.Object({ "path": Type.String(), "before": Type.Union([Type.Ref('DataRef'), Type.Null()]), "after": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }), "requiredPins": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "readinessChecks": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "prerequisiteMigrationPlans": Type.Array(Type.Object({ "planId": Type.Ref('Id'), "planFingerprint": Type.Ref('Digest') }, { additionalProperties: false }), { maxItems: 10000 }), "authorizedBy": Type.Ref('Id'), "expiresAt": Type.Ref('Timestamp'), "rollbackOf": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "ChangeProposal": Type.Object({ "proposalId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "requester": Type.Ref('Id'), "scope": Type.Ref('ScopeRef'), "status": Type.Union([Type.Literal('planning'), Type.Literal('awaiting-approval'), Type.Literal('approved'), Type.Literal('applying'), Type.Literal('applied'), Type.Literal('denied'), Type.Literal('cancelled'), Type.Literal('unknown')]), "plan": Type.Union([Type.Object({ "kind": Type.Literal('release'), "value": Type.Ref('ReleasePlan') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('resource'), "value": Type.Ref('ResourceChangePlan') }, { additionalProperties: false }), Type.Null()]), "planDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "interactionRef": Type.Union([Type.Ref('InteractionRef'), Type.Null()]), "resultRef": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]), "error": Type.Union([Type.Ref('RuntimeError'), Type.Null()]) }, { additionalProperties: false }),
  "ProviderBindingSnapshot": Type.Object({ "binding": Type.Ref('BindingRef'), "descriptor": Type.Ref('ProviderDescriptor'), "isolation": Type.Ref('IsolationMode'), "config": Type.Ref('DataRef'), "configDigest": Type.Ref('Digest'), "dependencies": Type.Array(Type.Ref('BindingRef'), { maxItems: 10000 }), "codecRefs": Type.Array(Type.Ref('StateCodecRef'), { maxItems: 10000 }), "schemaRefs": Type.Array(Type.Ref('SchemaRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "Cursor": Type.String(),
  "AuthorityCheckpoint": Type.Object({ "authorityId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53'), "checkpointId": Type.Ref('Id'), "snapshotDigest": Type.Ref('Digest'), "recordCount": Type.Ref('UInt53'), "bridgeWatermarks": Type.Array(Type.Object({ "bridgeId": Type.Ref('Id'), "producedThrough": Type.Ref('UInt53'), "acceptedThrough": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "MigrationReceipt": Type.Object({ "upgradeId": Type.Ref('Id'), "state": Type.Union([Type.Literal('planned'), Type.Literal('preparing'), Type.Literal('verified'), Type.Literal('cutting-over'), Type.Literal('committed'), Type.Literal('draining'), Type.Literal('completed'), Type.Literal('aborted'), Type.Literal('blocked')]), "checkpointRevision": Type.Ref('UInt53'), "cutoverId": Type.Union([Type.Ref('Id'), Type.Null()]), "commitRef": Type.Union([Type.Ref('Id'), Type.Null()]), "diagnosticIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "AuthorityFence": Type.Object({ "upgradeId": Type.Ref('Id'), "source": Type.Ref('StateAuthorityRef'), "fenceId": Type.Ref('Id'), "fenceEpoch": Type.Ref('UInt53'), "checkpoint": Type.Ref('AuthorityCheckpoint'), "writerCredentialsRevoked": Type.Boolean() }, { additionalProperties: false }),
  "AuthorityRoute": Type.Object({ "logicalAuthorityId": Type.Ref('Id'), "tenantId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53'), "providerBinding": Type.Ref('BindingRef'), "locationRef": Type.Ref('Id'), "cohortDigest": Type.Ref('Digest'), "cutoverId": Type.Ref('Id'), "checkpoint": Type.Ref('AuthorityCheckpoint'), "previous": Type.Union([Type.Null(), Type.Object({ "authorityEpoch": Type.Ref('UInt53'), "locationRef": Type.Ref('Id'), "cutoverId": Type.Ref('Id') }, { additionalProperties: false })]) }, { additionalProperties: false }),
  "JointDispatchMigrationMapping": Type.Object({ "domainId": Type.Ref('Id'), "from": Type.Ref('DispatchAtomicDomain'), "to": Type.Ref('DispatchAtomicDomain'), "cohortDigest": Type.Ref('Digest'), "validationRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "AuthorityPublication": Type.Object({ "upgradeId": Type.Ref('Id'), "cutoverId": Type.Ref('Id'), "changes": Type.Array(Type.Object({ "expectedRevision": Type.Ref('UInt53'), "previous": Type.Ref('AuthorityRoute'), "next": Type.Ref('AuthorityRoute') }, { additionalProperties: false }), { minItems: 1, maxItems: 10000 }), "sourceFences": Type.Array(Type.Ref('AuthorityFence'), { maxItems: 10000 }), "validationRef": Type.Ref('DataRef'), "jointDispatchMappings": Type.Array(Type.Ref('JointDispatchMigrationMapping'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "DomainQuery": Type.Object({ "domainType": Type.String(), "query": Type.Ref('DataRef'), "scope": Type.Ref('ScopeRef'), "cursor": Type.Union([Type.String(), Type.Null()]), "limit": Type.Number() }, { additionalProperties: false }),
  "ProtocolRange": Type.Object({ "major": Type.Number(), "minMinor": Type.Number(), "maxMinor": Type.Number() }, { additionalProperties: false }),
  "ViewSchemaRange": Type.Object({ "typeId": Type.String(), "minRevision": Type.Number(), "maxRevision": Type.Number() }, { additionalProperties: false }),
  "NegotiatedClientCapabilities": Type.Object({ "clientInstanceId": Type.String(), "target": Type.Union([Type.Literal('web'), Type.Literal('tui'), Type.Literal('im'), Type.Literal('sdk')]), "protocols": Type.Array(Type.Ref('ProtocolRange'), { maxItems: 10000 }), "viewSchemaRanges": Type.Array(Type.Ref('ViewSchemaRange'), { maxItems: 10000 }), "renderKeys": Type.Array(Type.String(), { maxItems: 10000 }), "features": Type.Array(Type.String(), { maxItems: 10000 }), "capabilitiesRevision": Type.Number(), "interaction": Type.Object({ "text": Type.Boolean(), "singleChoice": Type.Boolean(), "multiChoice": Type.Boolean(), "confirm": Type.Boolean(), "complexFormLink": Type.Boolean() }, { additionalProperties: false }), "files": Type.Object({ "link": Type.Boolean(), "upload": Type.Boolean(), "maxUploadBytes": Type.Number(), "allowedMimes": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }), "display": Type.Object({ "plainText": Type.Boolean(), "markdown": Type.Boolean(), "maxTextBytes": Type.Number(), "inlinePreviewMimes": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }), "negotiatedSession": Type.String(), "effectivePolicyRevision": Type.Number() }, { additionalProperties: false }),
  "DomainEventRecord": Type.Object({ "event": Type.Ref('DomainEvent'), "authorityId": Type.Ref('Id'), "sequence": Type.Ref('UInt53'), "aggregate": Type.Ref('DomainObjectRef'), "fingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "TraceSpan": Type.Object({ "traceId": Type.Ref('Id'), "spanId": Type.Ref('Id'), "parentSpanId": Type.Union([Type.Ref('Id'), Type.Null()]), "name": Type.String(), "startedAt": Type.Ref('Timestamp'), "endedAt": Type.Ref('Timestamp'), "attributes": Type.Ref('DataRef'), "outcome": Type.Union([Type.Literal('ok'), Type.Literal('error'), Type.Literal('cancelled'), Type.Literal('unknown')]) }, { additionalProperties: false }),
  "PackageRequirement": Type.Object({ "packageId": Type.Ref('Id'), "versionRange": Type.String(), "sourceIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PackageLockEntry": Type.Object({ "packageId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest'), "locator": Type.Ref('PackageLocator'), "manifestRef": Type.Ref('DataRef'), "dependencies": Type.Array(Type.Object({ "packageId": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PackageLock": Type.Object({ "entries": Type.Array(Type.Ref('PackageLockEntry'), { maxItems: 10000 }), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "Readiness": Type.Object({ "state": Type.Union([Type.Literal('ready'), Type.Literal('blocked')]), "required": Type.Array(Type.Object({ "contributionId": Type.Ref('Id'), "ready": Type.Boolean(), "diagnosticIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "AssemblyGraph": Type.Object({ "graphId": Type.Ref('Id'), "configRef": Type.Ref('DataRef'), "lock": Type.Ref('PackageLock'), "bindings": Type.Array(Type.Ref('ProviderBindingSnapshot'), { maxItems: 10000 }), "dependencies": Type.Array(Type.Object({ "consumerId": Type.Ref('Id'), "dependencyId": Type.Ref('Id'), "optional": Type.Boolean() }, { additionalProperties: false }), { maxItems: 10000 }), "requiredContributions": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ChannelDestination": Type.Object({ "channelId": Type.Ref('Id'), "accountId": Type.Ref('Id'), "conversationId": Type.Ref('Id'), "threadId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "AuthenticatedCallback": Type.Object({ "callbackId": Type.Ref('Id'), "channelId": Type.Ref('Id'), "remoteEventId": Type.Ref('Id'), "actorPrincipalRef": Type.Ref('Id'), "destination": Type.Ref('ChannelDestination'), "receivedAt": Type.Ref('Timestamp'), "credentialRevision": Type.Ref('Revision'), "verifiedEnvelopeDigest": Type.Ref('Digest'), "command": Type.Union([Type.Object({ "kind": Type.Literal('interaction'), "interactionId": Type.Ref('Id'), "expectedVersion": Type.Ref('Revision'), "responseId": Type.Ref('Id'), "answer": Type.Ref('DataRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('domain'), "command": Type.Ref('DataRef') }, { additionalProperties: false })]) }, { additionalProperties: false }),
  "BillingRefundRequest": Type.Object({ "chargeRef": Type.Ref('DomainObjectRef'), "amount": Type.Ref('Money'), "reason": Type.String(), "refundKey": Type.Ref('Id') }, { additionalProperties: false }),
  "BillingReconcileRequest": Type.Object({ "chargeRef": Type.Ref('DomainObjectRef'), "evidenceRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "AuditAppendResult": Type.Object({ "auditRef": Type.Ref('ReceiptPointer') }, { additionalProperties: false }),
  "AuditExportRequest": Type.Object({ "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53'), "targetRef": Type.Ref('Id') }, { additionalProperties: false }),
  "AuditExportResult": Type.Object({ "checkpoint": Type.Ref('Cursor'), "archiveReceipt": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "TraceRecordRequest": Type.Object({ "batchId": Type.Ref('Id'), "spans": Type.Array(Type.Ref('TraceSpan'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "TraceRecordResult": Type.Object({ "accepted": Type.Ref('UInt53'), "dropped": Type.Ref('UInt53') }, { additionalProperties: false }),
  "EventsSubscribeRequest": Type.Object({ "scopeRef": Type.Ref('ScopeRef'), "types": Type.Array(Type.Ref('TypeId'), { maxItems: 10000 }), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "PageDomainEventRecord": Type.Object({ "items": Type.Array(Type.Ref('DomainEventRecord'), { maxItems: 10000 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "EventsSubscribeResult": Type.Object({ "page": Type.Ref('PageDomainEventRecord'), "resyncRequired": Type.Boolean() }, { additionalProperties: false }),
  "EventsPublishRequest": Type.Object({ "domainSchema": Type.Ref('SchemaRef'), "payload": Type.Ref('DataRef'), "causationRef": Type.Ref('PublicRef') }, { additionalProperties: false }),
  "EventsPublishResult": Type.Object({ "eventRef": Type.Ref('PublicRef') }, { additionalProperties: false }),
  "ProjectionChangesRequest": Type.Object({ "query": Type.Ref('DomainQuery'), "afterCursor": Type.String(), "limit": Type.Number() }, { additionalProperties: false }),
  "ChannelReconcileRequest": Type.Object({ "messageId": Type.Ref('Id'), "destination": Type.Ref('ChannelDestination'), "evidence": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "ChannelCallbackRequest": Type.Object({ "envelope": Type.Ref('DataRef'), "signatureEvidence": Type.Ref('DataRef') }, { additionalProperties: false }),
  "ChannelCallbackResult": Type.Object({ "callback": Type.Ref('AuthenticatedCallback'), "acceptedCommandRef": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]) }, { additionalProperties: false }),
  "PackageSourceDiscoverRequest": Type.Object({ "query": Type.String(), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "PagePackageLockEntry": Type.Object({ "items": Type.Array(Type.Ref('PackageLockEntry'), { maxItems: 10000 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "PackageSourceDiscoverResult": Type.Ref('PagePackageLockEntry'),
  "PackageSourceResolveMetadataRequest": Type.Object({ "packageId": Type.Ref('Id'), "version": Type.String() }, { additionalProperties: false }),
  "PackageSourceResolveMetadataResult": Type.Object({ "manifestRef": Type.Ref('DataRef'), "digest": Type.Ref('Digest'), "provenance": Type.Ref('Provenance') }, { additionalProperties: false }),
  "PackageSourceFetchRequest": Type.Object({ "locator": Type.Ref('PackageLocator'), "expectedDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "PackageSourceFetchResult": Type.Object({ "stagedPackageRef": Type.Ref('DataRef'), "verifiedDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "PackageSourceRefreshCatalogRequest": Type.Object({ "sourceId": Type.Ref('Id'), "requirements": Type.Array(Type.Ref('PackageRequirement'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PackageSourceRefreshCatalogResult": Type.Object({ "catalogRevision": Type.Ref('Revision'), "candidateRefs": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "diagnosticIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PackageResolverResolveRequest": Type.Object({ "requirements": Type.Array(Type.Ref('PackageRequirement'), { maxItems: 10000 }), "installedLock": Type.Ref('PackageLock'), "allowedSources": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "platform": Type.String(), "apiVersions": Type.Array(Type.Object({ "contract": Type.String(), "major": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PackageResolverResolveResult": Type.Object({ "lockGraph": Type.Ref('PackageLock'), "conflicts": Type.Array(Type.Object({ "packageId": Type.Ref('Id'), "reason": Type.String() }, { additionalProperties: false }), { maxItems: 10000 }), "configDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "PackageInstallerPrepareRequest": Type.Object({ "lockGraph": Type.Ref('PackageLock'), "approvalRef": Type.Ref('Id') }, { additionalProperties: false }),
  "PackageInstallerPrepareResult": Type.Object({ "candidateReleaseRef": Type.Ref('DataRef'), "diagnosticIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PackageInstallerActivateRequest": Type.Object({ "candidateReleaseRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "PackageInstallerActivateResult": Type.Object({ "publishedReleaseRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "PackageInstallerDisableRequest": Type.Object({ "contributionId": Type.Ref('Id'), "reason": Type.String() }, { additionalProperties: false }),
  "PackageInstallerDisableResult": Type.Object({ "disabledId": Type.Ref('Id') }, { additionalProperties: false }),
  "PackageInstallerRepairRequest": Type.Object({ "repairPlanRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "PackageInstallerCancelProposalRequest": Type.Object({ "proposalId": Type.Ref('Id'), "expectedRevision": Type.Ref('Revision'), "reason": Type.String() }, { additionalProperties: false }),
  "PackageInstallerProposalStatusRequest": Type.Object({ "proposalId": Type.Ref('Id') }, { additionalProperties: false }),
  "PackageInstallerApplyResourceChangeRequest": Type.Object({ "proposalId": Type.Ref('Id'), "plan": Type.Ref('ResourceChangePlan'), "expectedProposalRevision": Type.Ref('Revision'), "approvalRef": Type.Ref('Id') }, { additionalProperties: false }),
  "PackageInstallerApplyResourceChangeResult": Type.Object({ "proposal": Type.Ref('ChangeProposal'), "receipt": Type.Ref('ReceiptPointer') }, { additionalProperties: false }),
  "ConfigReadRequest": Type.Object({ "sourceRef": Type.Ref('Id'), "revision": Type.Union([Type.Ref('Revision'), Type.Null()]) }, { additionalProperties: false }),
  "ConfigReadResult": Type.Object({ "documentRef": Type.Ref('DataRef'), "revision": Type.Ref('Revision'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "AssemblyPlanRequest": Type.Object({ "configRef": Type.Ref('DataRef'), "lock": Type.Ref('PackageLock') }, { additionalProperties: false }),
  "AssemblyPrepareRequest": Type.Object({ "graph": Type.Ref('AssemblyGraph') }, { additionalProperties: false }),
  "AssemblyPrepareResult": Type.Object({ "candidateRef": Type.Ref('DataRef'), "readiness": Type.Ref('Readiness') }, { additionalProperties: false }),
  "AssemblyPublishRequest": Type.Object({ "candidateRef": Type.Ref('DataRef'), "expectedPublishedRevision": Type.Ref('Revision') }, { additionalProperties: false }),
  "AssemblyPublishResult": Type.Object({ "releaseRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "AssemblyDrainRequest": Type.Object({ "releaseSetId": Type.Ref('Id'), "deadline": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "AssemblyDrainResult": Type.Object({ "remainingRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "MigrationPrepareRequest": Type.Object({ "planId": Type.Ref('Id'), "planFingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "MigrationPrepareResult": Type.Object({ "candidateRef": Type.Ref('DataRef'), "receipt": Type.Ref('MigrationReceipt') }, { additionalProperties: false }),
  "MigrationValidateRequest": Type.Object({ "upgradeId": Type.Ref('Id'), "candidateRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "MigrationValidateResult": Type.Object({ "validationRef": Type.Ref('DataRef'), "receipt": Type.Ref('MigrationReceipt') }, { additionalProperties: false }),
  "MigrationCutoverRequest": Type.Object({ "upgradeId": Type.Ref('Id'), "candidateRef": Type.Ref('DataRef'), "validationRef": Type.Ref('DataRef'), "expectedCheckpointRevision": Type.Ref('UInt53') }, { additionalProperties: false }),
  "MigrationProbeRequest": Type.Object({ "upgradeId": Type.Ref('Id') }, { additionalProperties: false }),
  "MigrationAbortRequest": Type.Object({ "upgradeId": Type.Ref('Id'), "expectedCheckpointRevision": Type.Ref('UInt53'), "reason": Type.String() }, { additionalProperties: false }),
  "IntegrityVerifyPackageRequest": Type.Object({ "manifestRef": Type.Ref('DataRef'), "packageRef": Type.Ref('DataRef'), "expectedDigest": Type.Ref('Digest'), "signatureRef": Type.Union([Type.Ref('DataRef'), Type.Null()]), "trustPolicyRef": Type.Ref('Id') }, { additionalProperties: false }),
  "IntegrityVerifyPackageResult": Type.Object({ "verifiedDigest": Type.Ref('Digest'), "signerRef": Type.Union([Type.Ref('Id'), Type.Null()]), "sourceEvidenceRef": Type.Ref('DataRef'), "accepted": Type.Boolean() }, { additionalProperties: false }),
  "StateCancelAdmissionRequest": Type.Object({ "ticketId": Type.Ref('Id'), "fingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "JobsCreateDefinitionRequest": Type.Object({ "mutationId": Type.Ref('Id'), "fingerprint": Type.Ref('Digest'), "sourceAction": Type.Ref('ActionRef'), "request": Type.Ref('DataRef') }, { additionalProperties: false }),
  "JobsUpdateDefinitionRequest": Type.Object({ "mutationId": Type.Ref('Id'), "fingerprint": Type.Ref('Digest'), "sourceAction": Type.Ref('ActionRef'), "request": Type.Ref('DataRef') }, { additionalProperties: false }),
  "JobsCancelDefinitionRequest": Type.Object({ "mutationId": Type.Ref('Id'), "fingerprint": Type.Ref('Digest'), "sourceAction": Type.Ref('ActionRef'), "request": Type.Ref('DataRef') }, { additionalProperties: false }),
  "SupervisorServiceCommandStatusResult": Type.Union([Type.Ref('ServiceCommandRecord'), Type.Null()]),
  "SupervisorActionReceiptRequest": Type.Object({ "action": Type.Ref('ActionRef') }, { additionalProperties: false }),
  "SupervisorActionReceiptResult": Type.Object({ "actionId": Type.Union([Type.Ref('Id'), Type.Null()]), "receipt": Type.Union([Type.Ref('ActionResultView'), Type.Null()]), "visibility": Type.Union([Type.Literal('absent'), Type.Literal('pending'), Type.Literal('ready')]) }, { additionalProperties: false }),
  "IMRendererEncodeResult": Type.Object({ "messages": Type.Array(Type.Object({ "text": Type.String(), "actionKeys": Type.Array(Type.String(), { maxItems: 10000 }), "partIndex": Type.Number(), "partCount": Type.Number() }, { additionalProperties: false }), { maxItems: 10000 }), "complete": Type.Boolean(), "requiresWebForm": Type.Boolean() }, { additionalProperties: false }),
  "IMRendererEncodeChannel": Type.Object({ "kind": Type.String(), "maxTextBytes": Type.Number(), "supportsButtons": Type.Boolean() }, { additionalProperties: false }),
  "TextRendererFormatContext": Type.Object({ "locale": Type.String(), "capabilities": Type.Ref('NegotiatedClientCapabilities') }, { additionalProperties: false }),
  "ControlledHttpHeaders": Object.assign(Type.Object({ "accept": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "accept-language": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "cache-control": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "content-encoding": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "content-length": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "content-range": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "content-type": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "date": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "etag": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "if-match": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "if-modified-since": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "if-none-match": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "if-unmodified-since": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "last-modified": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "location": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "range": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "retry-after": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "user-agent": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "vary": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})), "x-request-id": Type.Optional(Object.assign(Type.String({ maxLength: 8192, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }), {"x-max-utf8-bytes":8192})) }, { additionalProperties: false, maxProperties: 32 }), {"x-max-canonical-json-bytes":65536}),
  "AuthorityDirectoryCompareAndSwapRequest": Type.Object({ "transactionId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef'), "expectedWriterEpoch": Type.Ref('UInt53'), "publication": Type.Ref('AuthorityPublication') }, { additionalProperties: false }),
  "AuthorityDirectoryCompareAndSwapResult": Type.Object({ "transactionId": Type.Ref('Id'), "cutoverId": Type.Ref('Id'), "routes": Type.Array(Type.Object({ "logicalAuthorityId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "authorityEpoch": Type.Ref('UInt53') }, { additionalProperties: false }), { minItems: 1, maxItems: 10000 }) }, { additionalProperties: false }),
  "IntegrityCanonicalizeRequest": Type.Object({ "value": JsonValue }, { additionalProperties: false }),
  "IntegrityCanonicalizeResult": Type.Object({ "canonical": Type.String(), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53') }, { additionalProperties: false }),
  "LedgerIntegrityCheckpoint": Type.Object({ "lastSeq": Type.Ref('UInt53'), "legacyThroughSeq": Type.Ref('UInt53'), "headDigest": Type.Union([Type.Ref('Digest'), Type.Null()]) }, { additionalProperties: false }),
  "LedgerIntegrityMetadata": Type.Object({ "mode": Type.Union([Type.Literal('anchor'), Type.Literal('chain')]), "previousDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
})

export const Id = RuntimePublic13.Import('Id')
export type Id = Static<typeof Id>
export const UInt53 = RuntimePublic13.Import('UInt53')
export type UInt53 = Static<typeof UInt53>
export const Timestamp = RuntimePublic13.Import('Timestamp')
export type Timestamp = Static<typeof Timestamp>
export const TypeId = RuntimePublic13.Import('TypeId')
export type TypeId = Static<typeof TypeId>
export const Digest = RuntimePublic13.Import('Digest')
export type Digest = Static<typeof Digest>
export const SchemaRef = RuntimePublic13.Import('SchemaRef')
export type SchemaRef = Static<typeof SchemaRef>
export const BlobRef = RuntimePublic13.Import('BlobRef')
export type BlobRef = Static<typeof BlobRef>
export const DataRef = RuntimePublic13.Import('DataRef')
export type DataRef = Static<typeof DataRef>
export const ActionRef = RuntimePublic13.Import('ActionRef')
export type ActionRef = Static<typeof ActionRef>
export const RuntimeErrorCode = RuntimePublic13.Import('RuntimeErrorCode')
export type RuntimeErrorCode = Static<typeof RuntimeErrorCode>
export const OwnerRef = RuntimePublic13.Import('OwnerRef')
export type OwnerRef = Static<typeof OwnerRef>
export const RetryAdvice = RuntimePublic13.Import('RetryAdvice')
export type RetryAdvice = Static<typeof RetryAdvice>
export const RuntimeError = RuntimePublic13.Import('RuntimeError')
export type RuntimeError = Static<typeof RuntimeError>
export const ExternalRequestRef = RuntimePublic13.Import('ExternalRequestRef')
export type ExternalRequestRef = Static<typeof ExternalRequestRef>
export const RetentionRef = RuntimePublic13.Import('RetentionRef')
export type RetentionRef = Static<typeof RetentionRef>
export const BindingRef = RuntimePublic13.Import('BindingRef')
export type BindingRef = Static<typeof BindingRef>
export const Provenance = RuntimePublic13.Import('Provenance')
export type Provenance = Static<typeof Provenance>
export const ActionResultView = RuntimePublic13.Import('ActionResultView')
export type ActionResultView = Static<typeof ActionResultView>
export const StateAuthorityRef = RuntimePublic13.Import('StateAuthorityRef')
export type StateAuthorityRef = Static<typeof StateAuthorityRef>
export const ScopeRef = RuntimePublic13.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const DomainReference = RuntimePublic13.Import('DomainReference')
export type DomainReference = Static<typeof DomainReference>
export const DispatchAtomicDomain = RuntimePublic13.Import('DispatchAtomicDomain')
export type DispatchAtomicDomain = Static<typeof DispatchAtomicDomain>
export const Money = RuntimePublic13.Import('Money')
export type Money = Static<typeof Money>
export const DomainEvent = RuntimePublic13.Import('DomainEvent')
export type DomainEvent = Static<typeof DomainEvent>
export const Scope = RuntimePublic13.Import('Scope')
export type Scope = Static<typeof Scope>
export const IsolationMode = RuntimePublic13.Import('IsolationMode')
export type IsolationMode = Static<typeof IsolationMode>
export const CapabilityRequirement = RuntimePublic13.Import('CapabilityRequirement')
export type CapabilityRequirement = Static<typeof CapabilityRequirement>
export const OperationDescriptor = RuntimePublic13.Import('OperationDescriptor')
export type OperationDescriptor = Static<typeof OperationDescriptor>
export const CommunityOwnerPackageId = RuntimePublic13.Import('CommunityOwnerPackageId')
export type CommunityOwnerPackageId = Static<typeof CommunityOwnerPackageId>
export const CommunityContractRef = RuntimePublic13.Import('CommunityContractRef')
export type CommunityContractRef = Static<typeof CommunityContractRef>
export const ServiceRequirement = RuntimePublic13.Import('ServiceRequirement')
export type ServiceRequirement = Static<typeof ServiceRequirement>
export const StateCodecRef = RuntimePublic13.Import('StateCodecRef')
export type StateCodecRef = Static<typeof StateCodecRef>
export const ProviderDescriptor = RuntimePublic13.Import('ProviderDescriptor')
export type ProviderDescriptor = Static<typeof ProviderDescriptor>
export const ConfigValue = RuntimePublic13.Import('ConfigValue')
export type ConfigValue = Static<typeof ConfigValue>
export const ResourceRef = RuntimePublic13.Import('ResourceRef')
export type ResourceRef = Static<typeof ResourceRef>
export const ArtifactRef = RuntimePublic13.Import('ArtifactRef')
export type ArtifactRef = Static<typeof ArtifactRef>
export const Revision = RuntimePublic13.Import('Revision')
export type Revision = Static<typeof Revision>
export const DomainObjectRef = RuntimePublic13.Import('DomainObjectRef')
export type DomainObjectRef = Static<typeof DomainObjectRef>
export const SessionRef = RuntimePublic13.Import('SessionRef')
export type SessionRef = Static<typeof SessionRef>
export const RunRef = RuntimePublic13.Import('RunRef')
export type RunRef = Static<typeof RunRef>
export const InteractionRef = RuntimePublic13.Import('InteractionRef')
export type InteractionRef = Static<typeof InteractionRef>
export const UploadSession = RuntimePublic13.Import('UploadSession')
export type UploadSession = Static<typeof UploadSession>
export const StagedBlobRef = RuntimePublic13.Import('StagedBlobRef')
export type StagedBlobRef = Static<typeof StagedBlobRef>
export const PublicRef = RuntimePublic13.Import('PublicRef')
export type PublicRef = Static<typeof PublicRef>
export const ReceiptPointer = RuntimePublic13.Import('ReceiptPointer')
export type ReceiptPointer = Static<typeof ReceiptPointer>
export const ServiceCommandRecord = RuntimePublic13.Import('ServiceCommandRecord')
export type ServiceCommandRecord = Static<typeof ServiceCommandRecord>
export const ResourceChangePlan = RuntimePublic13.Import('ResourceChangePlan')
export type ResourceChangePlan = Static<typeof ResourceChangePlan>
export const PackageLocator = RuntimePublic13.Import('PackageLocator')
export type PackageLocator = Static<typeof PackageLocator>
export const ResolvedProviderBinding = RuntimePublic13.Import('ResolvedProviderBinding')
export type ResolvedProviderBinding = Static<typeof ResolvedProviderBinding>
export const VersionedRef = RuntimePublic13.Import('VersionedRef')
export type VersionedRef = Static<typeof VersionedRef>
export const ContentRef = RuntimePublic13.Import('ContentRef')
export type ContentRef = Static<typeof ContentRef>
export const ReleaseSet = RuntimePublic13.Import('ReleaseSet')
export type ReleaseSet = Static<typeof ReleaseSet>
export const ReleasePlan = RuntimePublic13.Import('ReleasePlan')
export type ReleasePlan = Static<typeof ReleasePlan>
export const ChangeProposal = RuntimePublic13.Import('ChangeProposal')
export type ChangeProposal = Static<typeof ChangeProposal>
export const ProviderBindingSnapshot = RuntimePublic13.Import('ProviderBindingSnapshot')
export type ProviderBindingSnapshot = Static<typeof ProviderBindingSnapshot>
export const Cursor = RuntimePublic13.Import('Cursor')
export type Cursor = Static<typeof Cursor>
export const AuthorityCheckpoint = RuntimePublic13.Import('AuthorityCheckpoint')
export type AuthorityCheckpoint = Static<typeof AuthorityCheckpoint>
export const MigrationReceipt = RuntimePublic13.Import('MigrationReceipt')
export type MigrationReceipt = Static<typeof MigrationReceipt>
export const AuthorityFence = RuntimePublic13.Import('AuthorityFence')
export type AuthorityFence = Static<typeof AuthorityFence>
export const AuthorityRoute = RuntimePublic13.Import('AuthorityRoute')
export type AuthorityRoute = Static<typeof AuthorityRoute>
export const JointDispatchMigrationMapping = RuntimePublic13.Import('JointDispatchMigrationMapping')
export type JointDispatchMigrationMapping = Static<typeof JointDispatchMigrationMapping>
export const AuthorityPublication = RuntimePublic13.Import('AuthorityPublication')
export type AuthorityPublication = Static<typeof AuthorityPublication>
export const DomainQuery = RuntimePublic13.Import('DomainQuery')
export type DomainQuery = Static<typeof DomainQuery>
export const ProtocolRange = RuntimePublic13.Import('ProtocolRange')
export type ProtocolRange = Static<typeof ProtocolRange>
export const ViewSchemaRange = RuntimePublic13.Import('ViewSchemaRange')
export type ViewSchemaRange = Static<typeof ViewSchemaRange>
export const NegotiatedClientCapabilities = RuntimePublic13.Import('NegotiatedClientCapabilities')
export type NegotiatedClientCapabilities = Static<typeof NegotiatedClientCapabilities>
export const DomainEventRecord = RuntimePublic13.Import('DomainEventRecord')
export type DomainEventRecord = Static<typeof DomainEventRecord>
export const TraceSpan = RuntimePublic13.Import('TraceSpan')
export type TraceSpan = Static<typeof TraceSpan>
export const PackageRequirement = RuntimePublic13.Import('PackageRequirement')
export type PackageRequirement = Static<typeof PackageRequirement>
export const PackageLockEntry = RuntimePublic13.Import('PackageLockEntry')
export type PackageLockEntry = Static<typeof PackageLockEntry>
export const PackageLock = RuntimePublic13.Import('PackageLock')
export type PackageLock = Static<typeof PackageLock>
export const Readiness = RuntimePublic13.Import('Readiness')
export type Readiness = Static<typeof Readiness>
export const AssemblyGraph = RuntimePublic13.Import('AssemblyGraph')
export type AssemblyGraph = Static<typeof AssemblyGraph>
export const ChannelDestination = RuntimePublic13.Import('ChannelDestination')
export type ChannelDestination = Static<typeof ChannelDestination>
export const AuthenticatedCallback = RuntimePublic13.Import('AuthenticatedCallback')
export type AuthenticatedCallback = Static<typeof AuthenticatedCallback>
export const BillingRefundRequest = RuntimePublic13.Import('BillingRefundRequest')
export type BillingRefundRequest = Static<typeof BillingRefundRequest>
export const BillingReconcileRequest = RuntimePublic13.Import('BillingReconcileRequest')
export type BillingReconcileRequest = Static<typeof BillingReconcileRequest>
export const AuditAppendResult = RuntimePublic13.Import('AuditAppendResult')
export type AuditAppendResult = Static<typeof AuditAppendResult>
export const AuditExportRequest = RuntimePublic13.Import('AuditExportRequest')
export type AuditExportRequest = Static<typeof AuditExportRequest>
export const AuditExportResult = RuntimePublic13.Import('AuditExportResult')
export type AuditExportResult = Static<typeof AuditExportResult>
export const TraceRecordRequest = RuntimePublic13.Import('TraceRecordRequest')
export type TraceRecordRequest = Static<typeof TraceRecordRequest>
export const TraceRecordResult = RuntimePublic13.Import('TraceRecordResult')
export type TraceRecordResult = Static<typeof TraceRecordResult>
export const EventsSubscribeRequest = RuntimePublic13.Import('EventsSubscribeRequest')
export type EventsSubscribeRequest = Static<typeof EventsSubscribeRequest>
export const PageDomainEventRecord = RuntimePublic13.Import('PageDomainEventRecord')
export type PageDomainEventRecord = Page<DomainEventRecord>
export const EventsSubscribeResult = RuntimePublic13.Import('EventsSubscribeResult')
export type EventsSubscribeResult = Omit<Static<typeof EventsSubscribeResult>, "page"> & { "page": PageDomainEventRecord }
export const EventsPublishRequest = RuntimePublic13.Import('EventsPublishRequest')
export type EventsPublishRequest = Static<typeof EventsPublishRequest>
export const EventsPublishResult = RuntimePublic13.Import('EventsPublishResult')
export type EventsPublishResult = Static<typeof EventsPublishResult>
export const ProjectionChangesRequest = RuntimePublic13.Import('ProjectionChangesRequest')
export type ProjectionChangesRequest = Static<typeof ProjectionChangesRequest>
export const ChannelReconcileRequest = RuntimePublic13.Import('ChannelReconcileRequest')
export type ChannelReconcileRequest = Static<typeof ChannelReconcileRequest>
export const ChannelCallbackRequest = RuntimePublic13.Import('ChannelCallbackRequest')
export type ChannelCallbackRequest = Static<typeof ChannelCallbackRequest>
export const ChannelCallbackResult = RuntimePublic13.Import('ChannelCallbackResult')
export type ChannelCallbackResult = Static<typeof ChannelCallbackResult>
export const PackageSourceDiscoverRequest = RuntimePublic13.Import('PackageSourceDiscoverRequest')
export type PackageSourceDiscoverRequest = Static<typeof PackageSourceDiscoverRequest>
export const PagePackageLockEntry = RuntimePublic13.Import('PagePackageLockEntry')
export type PagePackageLockEntry = Page<PackageLockEntry>
export const PackageSourceDiscoverResult = RuntimePublic13.Import('PackageSourceDiscoverResult')
export type PackageSourceDiscoverResult = PagePackageLockEntry
export const PackageSourceResolveMetadataRequest = RuntimePublic13.Import('PackageSourceResolveMetadataRequest')
export type PackageSourceResolveMetadataRequest = Static<typeof PackageSourceResolveMetadataRequest>
export const PackageSourceResolveMetadataResult = RuntimePublic13.Import('PackageSourceResolveMetadataResult')
export type PackageSourceResolveMetadataResult = Static<typeof PackageSourceResolveMetadataResult>
export const PackageSourceFetchRequest = RuntimePublic13.Import('PackageSourceFetchRequest')
export type PackageSourceFetchRequest = Static<typeof PackageSourceFetchRequest>
export const PackageSourceFetchResult = RuntimePublic13.Import('PackageSourceFetchResult')
export type PackageSourceFetchResult = Static<typeof PackageSourceFetchResult>
export const PackageSourceRefreshCatalogRequest = RuntimePublic13.Import('PackageSourceRefreshCatalogRequest')
export type PackageSourceRefreshCatalogRequest = Static<typeof PackageSourceRefreshCatalogRequest>
export const PackageSourceRefreshCatalogResult = RuntimePublic13.Import('PackageSourceRefreshCatalogResult')
export type PackageSourceRefreshCatalogResult = Static<typeof PackageSourceRefreshCatalogResult>
export const PackageResolverResolveRequest = RuntimePublic13.Import('PackageResolverResolveRequest')
export type PackageResolverResolveRequest = Static<typeof PackageResolverResolveRequest>
export const PackageResolverResolveResult = RuntimePublic13.Import('PackageResolverResolveResult')
export type PackageResolverResolveResult = Static<typeof PackageResolverResolveResult>
export const PackageInstallerPrepareRequest = RuntimePublic13.Import('PackageInstallerPrepareRequest')
export type PackageInstallerPrepareRequest = Static<typeof PackageInstallerPrepareRequest>
export const PackageInstallerPrepareResult = RuntimePublic13.Import('PackageInstallerPrepareResult')
export type PackageInstallerPrepareResult = Static<typeof PackageInstallerPrepareResult>
export const PackageInstallerActivateRequest = RuntimePublic13.Import('PackageInstallerActivateRequest')
export type PackageInstallerActivateRequest = Static<typeof PackageInstallerActivateRequest>
export const PackageInstallerActivateResult = RuntimePublic13.Import('PackageInstallerActivateResult')
export type PackageInstallerActivateResult = Static<typeof PackageInstallerActivateResult>
export const PackageInstallerDisableRequest = RuntimePublic13.Import('PackageInstallerDisableRequest')
export type PackageInstallerDisableRequest = Static<typeof PackageInstallerDisableRequest>
export const PackageInstallerDisableResult = RuntimePublic13.Import('PackageInstallerDisableResult')
export type PackageInstallerDisableResult = Static<typeof PackageInstallerDisableResult>
export const PackageInstallerRepairRequest = RuntimePublic13.Import('PackageInstallerRepairRequest')
export type PackageInstallerRepairRequest = Static<typeof PackageInstallerRepairRequest>
export const PackageInstallerCancelProposalRequest = RuntimePublic13.Import('PackageInstallerCancelProposalRequest')
export type PackageInstallerCancelProposalRequest = Static<typeof PackageInstallerCancelProposalRequest>
export const PackageInstallerProposalStatusRequest = RuntimePublic13.Import('PackageInstallerProposalStatusRequest')
export type PackageInstallerProposalStatusRequest = Static<typeof PackageInstallerProposalStatusRequest>
export const PackageInstallerApplyResourceChangeRequest = RuntimePublic13.Import('PackageInstallerApplyResourceChangeRequest')
export type PackageInstallerApplyResourceChangeRequest = Static<typeof PackageInstallerApplyResourceChangeRequest>
export const PackageInstallerApplyResourceChangeResult = RuntimePublic13.Import('PackageInstallerApplyResourceChangeResult')
export type PackageInstallerApplyResourceChangeResult = Static<typeof PackageInstallerApplyResourceChangeResult>
export const ConfigReadRequest = RuntimePublic13.Import('ConfigReadRequest')
export type ConfigReadRequest = Static<typeof ConfigReadRequest>
export const ConfigReadResult = RuntimePublic13.Import('ConfigReadResult')
export type ConfigReadResult = Static<typeof ConfigReadResult>
export const AssemblyPlanRequest = RuntimePublic13.Import('AssemblyPlanRequest')
export type AssemblyPlanRequest = Static<typeof AssemblyPlanRequest>
export const AssemblyPrepareRequest = RuntimePublic13.Import('AssemblyPrepareRequest')
export type AssemblyPrepareRequest = Static<typeof AssemblyPrepareRequest>
export const AssemblyPrepareResult = RuntimePublic13.Import('AssemblyPrepareResult')
export type AssemblyPrepareResult = Static<typeof AssemblyPrepareResult>
export const AssemblyPublishRequest = RuntimePublic13.Import('AssemblyPublishRequest')
export type AssemblyPublishRequest = Static<typeof AssemblyPublishRequest>
export const AssemblyPublishResult = RuntimePublic13.Import('AssemblyPublishResult')
export type AssemblyPublishResult = Static<typeof AssemblyPublishResult>
export const AssemblyDrainRequest = RuntimePublic13.Import('AssemblyDrainRequest')
export type AssemblyDrainRequest = Static<typeof AssemblyDrainRequest>
export const AssemblyDrainResult = RuntimePublic13.Import('AssemblyDrainResult')
export type AssemblyDrainResult = Static<typeof AssemblyDrainResult>
export const MigrationPrepareRequest = RuntimePublic13.Import('MigrationPrepareRequest')
export type MigrationPrepareRequest = Static<typeof MigrationPrepareRequest>
export const MigrationPrepareResult = RuntimePublic13.Import('MigrationPrepareResult')
export type MigrationPrepareResult = Static<typeof MigrationPrepareResult>
export const MigrationValidateRequest = RuntimePublic13.Import('MigrationValidateRequest')
export type MigrationValidateRequest = Static<typeof MigrationValidateRequest>
export const MigrationValidateResult = RuntimePublic13.Import('MigrationValidateResult')
export type MigrationValidateResult = Static<typeof MigrationValidateResult>
export const MigrationCutoverRequest = RuntimePublic13.Import('MigrationCutoverRequest')
export type MigrationCutoverRequest = Static<typeof MigrationCutoverRequest>
export const MigrationProbeRequest = RuntimePublic13.Import('MigrationProbeRequest')
export type MigrationProbeRequest = Static<typeof MigrationProbeRequest>
export const MigrationAbortRequest = RuntimePublic13.Import('MigrationAbortRequest')
export type MigrationAbortRequest = Static<typeof MigrationAbortRequest>
export const IntegrityVerifyPackageRequest = RuntimePublic13.Import('IntegrityVerifyPackageRequest')
export type IntegrityVerifyPackageRequest = Static<typeof IntegrityVerifyPackageRequest>
export const IntegrityVerifyPackageResult = RuntimePublic13.Import('IntegrityVerifyPackageResult')
export type IntegrityVerifyPackageResult = Static<typeof IntegrityVerifyPackageResult>
export const StateCancelAdmissionRequest = RuntimePublic13.Import('StateCancelAdmissionRequest')
export type StateCancelAdmissionRequest = Static<typeof StateCancelAdmissionRequest>
export const JobsCreateDefinitionRequest = RuntimePublic13.Import('JobsCreateDefinitionRequest')
export type JobsCreateDefinitionRequest = Static<typeof JobsCreateDefinitionRequest>
export const JobsUpdateDefinitionRequest = RuntimePublic13.Import('JobsUpdateDefinitionRequest')
export type JobsUpdateDefinitionRequest = Static<typeof JobsUpdateDefinitionRequest>
export const JobsCancelDefinitionRequest = RuntimePublic13.Import('JobsCancelDefinitionRequest')
export type JobsCancelDefinitionRequest = Static<typeof JobsCancelDefinitionRequest>
export const SupervisorServiceCommandStatusResult = RuntimePublic13.Import('SupervisorServiceCommandStatusResult')
export type SupervisorServiceCommandStatusResult = Static<typeof SupervisorServiceCommandStatusResult>
export const SupervisorActionReceiptRequest = RuntimePublic13.Import('SupervisorActionReceiptRequest')
export type SupervisorActionReceiptRequest = Static<typeof SupervisorActionReceiptRequest>
export const SupervisorActionReceiptResult = RuntimePublic13.Import('SupervisorActionReceiptResult')
export type SupervisorActionReceiptResult = Static<typeof SupervisorActionReceiptResult>
export const IMRendererEncodeResult = RuntimePublic13.Import('IMRendererEncodeResult')
export type IMRendererEncodeResult = Static<typeof IMRendererEncodeResult>
export const IMRendererEncodeChannel = RuntimePublic13.Import('IMRendererEncodeChannel')
export type IMRendererEncodeChannel = Static<typeof IMRendererEncodeChannel>
export const TextRendererFormatContext = RuntimePublic13.Import('TextRendererFormatContext')
export type TextRendererFormatContext = Static<typeof TextRendererFormatContext>
export const ControlledHttpHeaders = RuntimePublic13.Import('ControlledHttpHeaders')
export type ControlledHttpHeaders = Static<typeof ControlledHttpHeaders>
export const AuthorityDirectoryCompareAndSwapRequest = RuntimePublic13.Import('AuthorityDirectoryCompareAndSwapRequest')
export type AuthorityDirectoryCompareAndSwapRequest = Static<typeof AuthorityDirectoryCompareAndSwapRequest>
export const AuthorityDirectoryCompareAndSwapResult = RuntimePublic13.Import('AuthorityDirectoryCompareAndSwapResult')
export type AuthorityDirectoryCompareAndSwapResult = Static<typeof AuthorityDirectoryCompareAndSwapResult>
export const IntegrityCanonicalizeRequest = RuntimePublic13.Import('IntegrityCanonicalizeRequest')
export type IntegrityCanonicalizeRequest = Static<typeof IntegrityCanonicalizeRequest>
export const IntegrityCanonicalizeResult = RuntimePublic13.Import('IntegrityCanonicalizeResult')
export type IntegrityCanonicalizeResult = Static<typeof IntegrityCanonicalizeResult>
export const LedgerIntegrityCheckpoint = RuntimePublic13.Import('LedgerIntegrityCheckpoint')
export type LedgerIntegrityCheckpoint = Static<typeof LedgerIntegrityCheckpoint>
export const LedgerIntegrityMetadata = RuntimePublic13.Import('LedgerIntegrityMetadata')
export type LedgerIntegrityMetadata = Static<typeof LedgerIntegrityMetadata>
