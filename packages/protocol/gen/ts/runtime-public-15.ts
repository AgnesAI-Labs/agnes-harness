// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const Externalsession_v1_JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type Externalsession_v1_JsonValue = Static<typeof Externalsession_v1_JsonValue>

export const RuntimePublic15 = Type.Module({
  "Id": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
  "UInt53": Type.Integer({ minimum: 0, maximum: 9007199254740991 }),
  "Timestamp": Type.String({ pattern: "Z$", format: "date-time" }),
  "TypeId": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?:[a-z][a-z0-9.-]*|@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*)/[a-zA-Z0-9._/-]+@[1-9][0-9]*$" }),
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
  "ArtifactVersion": Type.Integer({ minimum: 1, maximum: 9007199254740991 }),
  "ArtifactRef": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion') }, { additionalProperties: false }),
  "Revision": Type.Ref('UInt53'),
  "DomainObjectRef": Type.Object({ "authorityId": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "id": Type.Ref('Id'), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "SessionRef": Type.Object({ "sessionId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef') }, { additionalProperties: false }),
  "RunRef": Type.Object({ "runId": Type.Ref('Id'), "session": Type.Ref('SessionRef') }, { additionalProperties: false }),
  "InteractionRef": Type.Object({ "interactionId": Type.Ref('Id') }, { additionalProperties: false }),
  "PublicBlobReference": Type.Object({ "kind": Type.Literal('blob'), "value": Type.Ref('BlobRef') }, { additionalProperties: false }),
  "UploadSession": Type.Object({ "authorityId": Type.Ref('Id'), "uploadId": Type.Ref('Id'), "reservationId": Type.Ref('Id'), "expectedBytes": Type.Ref('UInt53'), "receivedBytes": Type.Ref('UInt53'), "expectedDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "mediaType": Type.String(), "status": Type.Union([Type.Literal('uploading'), Type.Literal('sealed'), Type.Literal('aborted')]), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "PublicUploadReference": Type.Object({ "kind": Type.Literal('upload'), "value": Type.Ref('UploadSession') }, { additionalProperties: false }),
  "StagedBlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "reservationId": Type.Ref('Id') }, { additionalProperties: false }),
  "PublicStagedBlobReference": Type.Object({ "kind": Type.Literal('staged-blob'), "value": Type.Ref('StagedBlobRef') }, { additionalProperties: false }),
  "PublicRef": Type.Union([Type.Object({ "kind": Type.Literal('session'), "value": Type.Ref('SessionRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('run'), "value": Type.Ref('RunRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('action'), "run": Type.Ref('RunRef'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('resource'), "value": Type.Ref('ResourceRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('artifact'), "value": Type.Ref('ArtifactRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('interaction'), "value": Type.Ref('InteractionRef') }, { additionalProperties: false }), Type.Ref('PublicBlobReference'), Type.Ref('PublicUploadReference'), Type.Ref('PublicStagedBlobReference'), Type.Object({ "kind": Type.Literal('domain'), "value": Type.Ref('DomainObjectRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('event'), "authorityId": Type.Ref('Id'), "eventId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('state'), "value": Type.Ref('DomainReference') }, { additionalProperties: false })]),
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
  "CommitMutationManifest": Type.Object({ "commitId": Type.Ref('Id'), "recordId": Type.Ref('Id'), "previousRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]), "next": Type.Union([Type.Null(), Type.Object({ "recordRevision": Type.Ref('UInt53'), "schema": Type.Ref('SchemaRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false })]) }, { additionalProperties: false }),
  "CommitSideEntry": Type.Union([Type.Object({ "commitId": Type.Ref('Id'), "kind": Type.Literal('action-created'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "commitId": Type.Ref('Id'), "kind": Type.Literal('signal-consumed'), "signalId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "commitId": Type.Ref('Id'), "kind": Type.Literal('outbox-created'), "eventId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "commitId": Type.Ref('Id'), "kind": Type.Literal('receipt-created'), "receiptId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "commitId": Type.Ref('Id'), "kind": Type.Literal('usage-origin'), "sourceAuthorityId": Type.Ref('Id'), "originKey": Type.String() }, { additionalProperties: false })]),
  "RuntimeCommitData": Type.Object({ "commitId": Type.Ref('Id'), "transactionFingerprint": Type.Ref('Digest'), "runId": Type.Union([Type.Ref('Id'), Type.Null()]), "actionId": Type.Union([Type.Ref('Id'), Type.Null()]), "authorityEpoch": Type.Ref('UInt53'), "writerEpoch": Type.Ref('UInt53'), "previousCommitId": Type.Union([Type.Ref('Id'), Type.Null()]), "mutationsDigest": Type.Ref('Digest'), "mutationCount": Type.Ref('UInt53'), "sideListsDigest": Type.Ref('Digest'), "counts": Type.Object({ "createdActions": Type.Ref('UInt53'), "consumedSignals": Type.Ref('UInt53'), "outboxEvents": Type.Ref('UInt53'), "receipts": Type.Ref('UInt53'), "usageOrigins": Type.Ref('UInt53') }, { additionalProperties: false }) }, { additionalProperties: false }),
  "AuthorityCheckpoint": Type.Object({ "authorityId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53'), "checkpointId": Type.Ref('Id'), "snapshotDigest": Type.Ref('Digest'), "recordCount": Type.Ref('UInt53'), "bridgeWatermarks": Type.Array(Type.Object({ "bridgeId": Type.Ref('Id'), "producedThrough": Type.Ref('UInt53'), "acceptedThrough": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "MigrationReceipt": Type.Object({ "upgradeId": Type.Ref('Id'), "state": Type.Union([Type.Literal('planned'), Type.Literal('preparing'), Type.Literal('verified'), Type.Literal('cutting-over'), Type.Literal('committed'), Type.Literal('draining'), Type.Literal('completed'), Type.Literal('aborted'), Type.Literal('blocked')]), "checkpointRevision": Type.Ref('UInt53'), "cutoverId": Type.Union([Type.Ref('Id'), Type.Null()]), "commitRef": Type.Union([Type.Ref('Id'), Type.Null()]), "diagnosticIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "AuthorityFence": Type.Object({ "upgradeId": Type.Ref('Id'), "source": Type.Ref('StateAuthorityRef'), "fenceId": Type.Ref('Id'), "fenceEpoch": Type.Ref('UInt53'), "checkpoint": Type.Ref('AuthorityCheckpoint'), "writerCredentialsRevoked": Type.Boolean() }, { additionalProperties: false }),
  "AuthorityRoute": Type.Object({ "logicalAuthorityId": Type.Ref('Id'), "tenantId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53'), "providerBinding": Type.Ref('BindingRef'), "locationRef": Type.Ref('Id'), "cohortDigest": Type.Ref('Digest'), "cutoverId": Type.Ref('Id'), "checkpoint": Type.Ref('AuthorityCheckpoint'), "previous": Type.Union([Type.Null(), Type.Object({ "authorityEpoch": Type.Ref('UInt53'), "locationRef": Type.Ref('Id'), "cutoverId": Type.Ref('Id') }, { additionalProperties: false })]) }, { additionalProperties: false }),
  "JointDispatchMigrationMapping": Type.Object({ "domainId": Type.Ref('Id'), "from": Type.Ref('DispatchAtomicDomain'), "to": Type.Ref('DispatchAtomicDomain'), "cohortDigest": Type.Ref('Digest'), "validationRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "AuthorityPublication": Type.Object({ "upgradeId": Type.Ref('Id'), "cutoverId": Type.Ref('Id'), "changes": Type.Array(Type.Object({ "expectedRevision": Type.Ref('UInt53'), "previous": Type.Ref('AuthorityRoute'), "next": Type.Ref('AuthorityRoute') }, { additionalProperties: false }), { minItems: 1, maxItems: 10000 }), "sourceFences": Type.Array(Type.Ref('AuthorityFence'), { maxItems: 10000 }), "validationRef": Type.Ref('DataRef'), "jointDispatchMappings": Type.Array(Type.Ref('JointDispatchMigrationMapping'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ProtocolRange": Type.Object({ "major": Type.Number(), "minMinor": Type.Number(), "maxMinor": Type.Number() }, { additionalProperties: false }),
  "ViewSchemaRange": Type.Object({ "typeId": Type.String(), "minRevision": Type.Number(), "maxRevision": Type.Number() }, { additionalProperties: false }),
  "NegotiatedClientCapabilities": Type.Object({ "clientInstanceId": Type.String(), "target": Type.Union([Type.Literal('web'), Type.Literal('tui'), Type.Literal('im'), Type.Literal('sdk')]), "protocols": Type.Array(Type.Ref('ProtocolRange'), { maxItems: 10000 }), "viewSchemaRanges": Type.Array(Type.Ref('ViewSchemaRange'), { maxItems: 10000 }), "renderKeys": Type.Array(Type.String(), { maxItems: 10000 }), "features": Type.Array(Type.String(), { maxItems: 10000 }), "capabilitiesRevision": Type.Number(), "interaction": Type.Object({ "text": Type.Boolean(), "singleChoice": Type.Boolean(), "multiChoice": Type.Boolean(), "confirm": Type.Boolean(), "complexFormLink": Type.Boolean() }, { additionalProperties: false }), "files": Type.Object({ "link": Type.Boolean(), "upload": Type.Boolean(), "maxUploadBytes": Type.Number(), "allowedMimes": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }), "display": Type.Object({ "plainText": Type.Boolean(), "markdown": Type.Boolean(), "maxTextBytes": Type.Number(), "inlinePreviewMimes": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }), "negotiatedSession": Type.String(), "effectivePolicyRevision": Type.Number() }, { additionalProperties: false }),
  "PackageLockEntry": Type.Object({ "packageId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest'), "locator": Type.Ref('PackageLocator'), "manifestRef": Type.Ref('DataRef'), "dependencies": Type.Array(Type.Object({ "packageId": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PackageLock": Type.Object({ "entries": Type.Array(Type.Ref('PackageLockEntry'), { maxItems: 10000 }), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "Readiness": Type.Object({ "state": Type.Union([Type.Literal('ready'), Type.Literal('blocked')]), "required": Type.Array(Type.Object({ "contributionId": Type.Ref('Id'), "ready": Type.Boolean(), "diagnosticIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "AssemblyGraph": Type.Object({ "graphId": Type.Ref('Id'), "configRef": Type.Ref('DataRef'), "lock": Type.Ref('PackageLock'), "bindings": Type.Array(Type.Ref('ProviderBindingSnapshot'), { maxItems: 10000 }), "dependencies": Type.Array(Type.Object({ "consumerId": Type.Ref('Id'), "dependencyId": Type.Ref('Id'), "optional": Type.Boolean() }, { additionalProperties: false }), { maxItems: 10000 }), "requiredContributions": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
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
  "Externalsession_v1_Actor": Type.Object({ "id": Type.String({ minLength: 1, maxLength: 256 }), "org": Type.String({ maxLength: 256 }), "role": Type.String({ maxLength: 64 }), "deptPath": Type.Array(Type.String({ maxLength: 256 })), "attrs": Type.Record(Type.String(), Type.String({ maxLength: 1024 })) }, { additionalProperties: false }),
  "Externalsession_v1_SurfaceOp": Type.Union([Type.Literal('append'), Type.Object({ "op": Type.Literal('replace'), "start": Type.Integer({ minimum: 1 }), "end": Type.Integer({ minimum: 1 }) }, { additionalProperties: false })]),
  "Externalsession_v1_EventEnvelope": Type.Object({ "seq": Type.Integer({ minimum: 1 }), "ts": Type.String({ format: "date-time" }), "id": Type.String({ pattern: "^[0-9A-HJKMNP-TV-Z]{26}$" }), "type": Type.Union([Type.Union([Type.Literal('session/start'), Type.Literal('turn/start'), Type.Literal('turn/end'), Type.Literal('step/start'), Type.Literal('step/end'), Type.Literal('user/message'), Type.Literal('assistant/message'), Type.Literal('tool/result'), Type.Literal('assistant/output'), Type.Literal('tool/call'), Type.Literal('request/header'), Type.Literal('request/sent'), Type.Literal('plan.items'), Type.Literal('budget.state'), Type.Literal('artifact/job'), Type.Literal('inbox'), Type.Literal('harness/entry'), Type.Literal('effect/intent'), Type.Literal('effect/settled'), Type.Literal('verifier/signal'), Type.Literal('repair/decision'), Type.Literal('format/deviation'), Type.Literal('cost/ledger'), Type.Literal('approval/asked'), Type.Literal('approval/decided'), Type.Literal('approval/guardian-decided'), Type.Literal('feedback/rating'), Type.Literal('feedback/implicit'), Type.Literal('participant'), Type.Literal('harness/refine'), Type.Literal('subagent/cost'), Type.Literal('runtime/format'), Type.Literal('runtime/state-commit')]), Type.String({ maxLength: 128, pattern: "^x\\/(?:(?:core|agnes)\\/[a-z0-9-]+|host\\/session-title|[a-z0-9-]+\\/[a-z0-9-]+\\/[a-z0-9-]+)$" })]), "data": Externalsession_v1_JsonValue, "actor": Type.Ref('Externalsession_v1_Actor'), "origin": Type.String({ maxLength: 256, pattern: "^(principal|model|system|memory|tool:[^\\s]+|external:[^\\s]+|skill:[^\\s]+|subagent:[^\\s]+|ext:[^\\s]+|import:[^\\s]+)$" }), "trust": Type.Union([Type.Literal('trusted'), Type.Literal('untrusted')]), "lane": Type.Optional(Type.String({ minLength: 1, maxLength: 64 })), "v": Type.Optional(Type.Integer({ minimum: 1 })), "register": Type.Optional(Type.String({ maxLength: 128 })), "ignorable": Type.Optional(Type.Literal(true)), "surfaceOp": Type.Optional(Type.Ref('Externalsession_v1_SurfaceOp')), "sourceEventSeqs": Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))) }, { additionalProperties: false }),
  "LedgerIntegrityRow": Type.Object({ "sessionKey": Type.String(), "event": Type.Ref('Externalsession_v1_EventEnvelope'), "integrity": Type.Union([Type.Ref('LedgerIntegrityMetadata'), Type.Null()]) }, { additionalProperties: false }),
  "IntegrityVerifyRequest": Type.Union([Type.Object({ "kind": Type.Literal('ledger-page'), "algorithm": Type.Literal('agnes-ledger-jcs-sha256-v1'), "initial": Type.Ref('LedgerIntegrityCheckpoint'), "rows": Type.Array(Type.Ref('LedgerIntegrityRow'), { minItems: 0, maxItems: 500 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('commit-manifest'), "commit": Type.Ref('RuntimeCommitData'), "mutations": Type.Array(Type.Ref('CommitMutationManifest'), { minItems: 0, maxItems: 10000 }), "sideEntries": Type.Array(Type.Ref('CommitSideEntry'), { minItems: 0, maxItems: 10000 }) }, { additionalProperties: false })]),
  "IntegrityVerifyResult": Type.Union([Type.Object({ "kind": Type.Literal('ledger-page'), "checkpoint": Type.Ref('LedgerIntegrityCheckpoint') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('commit-manifest'), "commitId": Type.Ref('Id'), "mutationsDigest": Type.Ref('Digest'), "sideListsDigest": Type.Ref('Digest') }, { additionalProperties: false })]),
  "ClientInteractionFormLinkInput": Type.Object({ "interactionId": Type.Ref('Id'), "expectedVersion": Type.Ref('UInt53') }, { additionalProperties: false }),
  "InteractionFormLinkRequest": Type.Object({ "requestId": Type.Ref('Id'), "input": Type.Ref('ClientInteractionFormLinkInput') }, { additionalProperties: false }),
  "ConfigSourceIdentity": Type.Object({ "sourceRef": Type.Ref('Id'), "revision": Type.Ref('Revision'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
})

export const Id = RuntimePublic15.Import('Id')
export type Id = Static<typeof Id>
export const UInt53 = RuntimePublic15.Import('UInt53')
export type UInt53 = Static<typeof UInt53>
export const Timestamp = RuntimePublic15.Import('Timestamp')
export type Timestamp = Static<typeof Timestamp>
export const TypeId = RuntimePublic15.Import('TypeId')
export type TypeId = Static<typeof TypeId>
export const Digest = RuntimePublic15.Import('Digest')
export type Digest = Static<typeof Digest>
export const SchemaRef = RuntimePublic15.Import('SchemaRef')
export type SchemaRef = Static<typeof SchemaRef>
export const BlobRef = RuntimePublic15.Import('BlobRef')
export type BlobRef = Static<typeof BlobRef>
export const DataRef = RuntimePublic15.Import('DataRef')
export type DataRef = Static<typeof DataRef>
export const ActionRef = RuntimePublic15.Import('ActionRef')
export type ActionRef = Static<typeof ActionRef>
export const RuntimeErrorCode = RuntimePublic15.Import('RuntimeErrorCode')
export type RuntimeErrorCode = Static<typeof RuntimeErrorCode>
export const OwnerRef = RuntimePublic15.Import('OwnerRef')
export type OwnerRef = Static<typeof OwnerRef>
export const RetryAdvice = RuntimePublic15.Import('RetryAdvice')
export type RetryAdvice = Static<typeof RetryAdvice>
export const RuntimeError = RuntimePublic15.Import('RuntimeError')
export type RuntimeError = Static<typeof RuntimeError>
export const ExternalRequestRef = RuntimePublic15.Import('ExternalRequestRef')
export type ExternalRequestRef = Static<typeof ExternalRequestRef>
export const RetentionRef = RuntimePublic15.Import('RetentionRef')
export type RetentionRef = Static<typeof RetentionRef>
export const BindingRef = RuntimePublic15.Import('BindingRef')
export type BindingRef = Static<typeof BindingRef>
export const Provenance = RuntimePublic15.Import('Provenance')
export type Provenance = Static<typeof Provenance>
export const ActionResultView = RuntimePublic15.Import('ActionResultView')
export type ActionResultView = Static<typeof ActionResultView>
export const StateAuthorityRef = RuntimePublic15.Import('StateAuthorityRef')
export type StateAuthorityRef = Static<typeof StateAuthorityRef>
export const ScopeRef = RuntimePublic15.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const DomainReference = RuntimePublic15.Import('DomainReference')
export type DomainReference = Static<typeof DomainReference>
export const DispatchAtomicDomain = RuntimePublic15.Import('DispatchAtomicDomain')
export type DispatchAtomicDomain = Static<typeof DispatchAtomicDomain>
export const Scope = RuntimePublic15.Import('Scope')
export type Scope = Static<typeof Scope>
export const IsolationMode = RuntimePublic15.Import('IsolationMode')
export type IsolationMode = Static<typeof IsolationMode>
export const CapabilityRequirement = RuntimePublic15.Import('CapabilityRequirement')
export type CapabilityRequirement = Static<typeof CapabilityRequirement>
export const OperationDescriptor = RuntimePublic15.Import('OperationDescriptor')
export type OperationDescriptor = Static<typeof OperationDescriptor>
export const CommunityOwnerPackageId = RuntimePublic15.Import('CommunityOwnerPackageId')
export type CommunityOwnerPackageId = Static<typeof CommunityOwnerPackageId>
export const CommunityContractRef = RuntimePublic15.Import('CommunityContractRef')
export type CommunityContractRef = Static<typeof CommunityContractRef>
export const ServiceRequirement = RuntimePublic15.Import('ServiceRequirement')
export type ServiceRequirement = Static<typeof ServiceRequirement>
export const StateCodecRef = RuntimePublic15.Import('StateCodecRef')
export type StateCodecRef = Static<typeof StateCodecRef>
export const ProviderDescriptor = RuntimePublic15.Import('ProviderDescriptor')
export type ProviderDescriptor = Static<typeof ProviderDescriptor>
export const ConfigValue = RuntimePublic15.Import('ConfigValue')
export type ConfigValue = Static<typeof ConfigValue>
export const ResourceRef = RuntimePublic15.Import('ResourceRef')
export type ResourceRef = Static<typeof ResourceRef>
export const ArtifactVersion = RuntimePublic15.Import('ArtifactVersion')
export type ArtifactVersion = Static<typeof ArtifactVersion>
export const ArtifactRef = RuntimePublic15.Import('ArtifactRef')
export type ArtifactRef = Static<typeof ArtifactRef>
export const Revision = RuntimePublic15.Import('Revision')
export type Revision = Static<typeof Revision>
export const DomainObjectRef = RuntimePublic15.Import('DomainObjectRef')
export type DomainObjectRef = Static<typeof DomainObjectRef>
export const SessionRef = RuntimePublic15.Import('SessionRef')
export type SessionRef = Static<typeof SessionRef>
export const RunRef = RuntimePublic15.Import('RunRef')
export type RunRef = Static<typeof RunRef>
export const InteractionRef = RuntimePublic15.Import('InteractionRef')
export type InteractionRef = Static<typeof InteractionRef>
export const PublicBlobReference = RuntimePublic15.Import('PublicBlobReference')
export type PublicBlobReference = Static<typeof PublicBlobReference>
export const UploadSession = RuntimePublic15.Import('UploadSession')
export type UploadSession = Static<typeof UploadSession>
export const PublicUploadReference = RuntimePublic15.Import('PublicUploadReference')
export type PublicUploadReference = Static<typeof PublicUploadReference>
export const StagedBlobRef = RuntimePublic15.Import('StagedBlobRef')
export type StagedBlobRef = Static<typeof StagedBlobRef>
export const PublicStagedBlobReference = RuntimePublic15.Import('PublicStagedBlobReference')
export type PublicStagedBlobReference = Static<typeof PublicStagedBlobReference>
export const PublicRef = RuntimePublic15.Import('PublicRef')
export type PublicRef = Static<typeof PublicRef>
export const ReceiptPointer = RuntimePublic15.Import('ReceiptPointer')
export type ReceiptPointer = Static<typeof ReceiptPointer>
export const ServiceCommandRecord = RuntimePublic15.Import('ServiceCommandRecord')
export type ServiceCommandRecord = Static<typeof ServiceCommandRecord>
export const ResourceChangePlan = RuntimePublic15.Import('ResourceChangePlan')
export type ResourceChangePlan = Static<typeof ResourceChangePlan>
export const PackageLocator = RuntimePublic15.Import('PackageLocator')
export type PackageLocator = Static<typeof PackageLocator>
export const ResolvedProviderBinding = RuntimePublic15.Import('ResolvedProviderBinding')
export type ResolvedProviderBinding = Static<typeof ResolvedProviderBinding>
export const VersionedRef = RuntimePublic15.Import('VersionedRef')
export type VersionedRef = Static<typeof VersionedRef>
export const ContentRef = RuntimePublic15.Import('ContentRef')
export type ContentRef = Static<typeof ContentRef>
export const ReleaseSet = RuntimePublic15.Import('ReleaseSet')
export type ReleaseSet = Static<typeof ReleaseSet>
export const ReleasePlan = RuntimePublic15.Import('ReleasePlan')
export type ReleasePlan = Static<typeof ReleasePlan>
export const ChangeProposal = RuntimePublic15.Import('ChangeProposal')
export type ChangeProposal = Static<typeof ChangeProposal>
export const ProviderBindingSnapshot = RuntimePublic15.Import('ProviderBindingSnapshot')
export type ProviderBindingSnapshot = Static<typeof ProviderBindingSnapshot>
export const CommitMutationManifest = RuntimePublic15.Import('CommitMutationManifest')
export type CommitMutationManifest = Static<typeof CommitMutationManifest>
export const CommitSideEntry = RuntimePublic15.Import('CommitSideEntry')
export type CommitSideEntry = Static<typeof CommitSideEntry>
export const RuntimeCommitData = RuntimePublic15.Import('RuntimeCommitData')
export type RuntimeCommitData = Static<typeof RuntimeCommitData>
export const AuthorityCheckpoint = RuntimePublic15.Import('AuthorityCheckpoint')
export type AuthorityCheckpoint = Static<typeof AuthorityCheckpoint>
export const MigrationReceipt = RuntimePublic15.Import('MigrationReceipt')
export type MigrationReceipt = Static<typeof MigrationReceipt>
export const AuthorityFence = RuntimePublic15.Import('AuthorityFence')
export type AuthorityFence = Static<typeof AuthorityFence>
export const AuthorityRoute = RuntimePublic15.Import('AuthorityRoute')
export type AuthorityRoute = Static<typeof AuthorityRoute>
export const JointDispatchMigrationMapping = RuntimePublic15.Import('JointDispatchMigrationMapping')
export type JointDispatchMigrationMapping = Static<typeof JointDispatchMigrationMapping>
export const AuthorityPublication = RuntimePublic15.Import('AuthorityPublication')
export type AuthorityPublication = Static<typeof AuthorityPublication>
export const ProtocolRange = RuntimePublic15.Import('ProtocolRange')
export type ProtocolRange = Static<typeof ProtocolRange>
export const ViewSchemaRange = RuntimePublic15.Import('ViewSchemaRange')
export type ViewSchemaRange = Static<typeof ViewSchemaRange>
export const NegotiatedClientCapabilities = RuntimePublic15.Import('NegotiatedClientCapabilities')
export type NegotiatedClientCapabilities = Static<typeof NegotiatedClientCapabilities>
export const PackageLockEntry = RuntimePublic15.Import('PackageLockEntry')
export type PackageLockEntry = Static<typeof PackageLockEntry>
export const PackageLock = RuntimePublic15.Import('PackageLock')
export type PackageLock = Static<typeof PackageLock>
export const Readiness = RuntimePublic15.Import('Readiness')
export type Readiness = Static<typeof Readiness>
export const AssemblyGraph = RuntimePublic15.Import('AssemblyGraph')
export type AssemblyGraph = Static<typeof AssemblyGraph>
export const PackageInstallerApplyResourceChangeResult = RuntimePublic15.Import('PackageInstallerApplyResourceChangeResult')
export type PackageInstallerApplyResourceChangeResult = Static<typeof PackageInstallerApplyResourceChangeResult>
export const ConfigReadRequest = RuntimePublic15.Import('ConfigReadRequest')
export type ConfigReadRequest = Static<typeof ConfigReadRequest>
export const ConfigReadResult = RuntimePublic15.Import('ConfigReadResult')
export type ConfigReadResult = Static<typeof ConfigReadResult>
export const AssemblyPlanRequest = RuntimePublic15.Import('AssemblyPlanRequest')
export type AssemblyPlanRequest = Static<typeof AssemblyPlanRequest>
export const AssemblyPrepareRequest = RuntimePublic15.Import('AssemblyPrepareRequest')
export type AssemblyPrepareRequest = Static<typeof AssemblyPrepareRequest>
export const AssemblyPrepareResult = RuntimePublic15.Import('AssemblyPrepareResult')
export type AssemblyPrepareResult = Static<typeof AssemblyPrepareResult>
export const AssemblyPublishRequest = RuntimePublic15.Import('AssemblyPublishRequest')
export type AssemblyPublishRequest = Static<typeof AssemblyPublishRequest>
export const AssemblyPublishResult = RuntimePublic15.Import('AssemblyPublishResult')
export type AssemblyPublishResult = Static<typeof AssemblyPublishResult>
export const AssemblyDrainRequest = RuntimePublic15.Import('AssemblyDrainRequest')
export type AssemblyDrainRequest = Static<typeof AssemblyDrainRequest>
export const AssemblyDrainResult = RuntimePublic15.Import('AssemblyDrainResult')
export type AssemblyDrainResult = Static<typeof AssemblyDrainResult>
export const MigrationPrepareRequest = RuntimePublic15.Import('MigrationPrepareRequest')
export type MigrationPrepareRequest = Static<typeof MigrationPrepareRequest>
export const MigrationPrepareResult = RuntimePublic15.Import('MigrationPrepareResult')
export type MigrationPrepareResult = Static<typeof MigrationPrepareResult>
export const MigrationValidateRequest = RuntimePublic15.Import('MigrationValidateRequest')
export type MigrationValidateRequest = Static<typeof MigrationValidateRequest>
export const MigrationValidateResult = RuntimePublic15.Import('MigrationValidateResult')
export type MigrationValidateResult = Static<typeof MigrationValidateResult>
export const MigrationCutoverRequest = RuntimePublic15.Import('MigrationCutoverRequest')
export type MigrationCutoverRequest = Static<typeof MigrationCutoverRequest>
export const MigrationProbeRequest = RuntimePublic15.Import('MigrationProbeRequest')
export type MigrationProbeRequest = Static<typeof MigrationProbeRequest>
export const MigrationAbortRequest = RuntimePublic15.Import('MigrationAbortRequest')
export type MigrationAbortRequest = Static<typeof MigrationAbortRequest>
export const IntegrityVerifyPackageRequest = RuntimePublic15.Import('IntegrityVerifyPackageRequest')
export type IntegrityVerifyPackageRequest = Static<typeof IntegrityVerifyPackageRequest>
export const IntegrityVerifyPackageResult = RuntimePublic15.Import('IntegrityVerifyPackageResult')
export type IntegrityVerifyPackageResult = Static<typeof IntegrityVerifyPackageResult>
export const StateCancelAdmissionRequest = RuntimePublic15.Import('StateCancelAdmissionRequest')
export type StateCancelAdmissionRequest = Static<typeof StateCancelAdmissionRequest>
export const JobsCreateDefinitionRequest = RuntimePublic15.Import('JobsCreateDefinitionRequest')
export type JobsCreateDefinitionRequest = Static<typeof JobsCreateDefinitionRequest>
export const JobsUpdateDefinitionRequest = RuntimePublic15.Import('JobsUpdateDefinitionRequest')
export type JobsUpdateDefinitionRequest = Static<typeof JobsUpdateDefinitionRequest>
export const JobsCancelDefinitionRequest = RuntimePublic15.Import('JobsCancelDefinitionRequest')
export type JobsCancelDefinitionRequest = Static<typeof JobsCancelDefinitionRequest>
export const SupervisorServiceCommandStatusResult = RuntimePublic15.Import('SupervisorServiceCommandStatusResult')
export type SupervisorServiceCommandStatusResult = Static<typeof SupervisorServiceCommandStatusResult>
export const SupervisorActionReceiptRequest = RuntimePublic15.Import('SupervisorActionReceiptRequest')
export type SupervisorActionReceiptRequest = Static<typeof SupervisorActionReceiptRequest>
export const SupervisorActionReceiptResult = RuntimePublic15.Import('SupervisorActionReceiptResult')
export type SupervisorActionReceiptResult = Static<typeof SupervisorActionReceiptResult>
export const IMRendererEncodeResult = RuntimePublic15.Import('IMRendererEncodeResult')
export type IMRendererEncodeResult = Static<typeof IMRendererEncodeResult>
export const IMRendererEncodeChannel = RuntimePublic15.Import('IMRendererEncodeChannel')
export type IMRendererEncodeChannel = Static<typeof IMRendererEncodeChannel>
export const TextRendererFormatContext = RuntimePublic15.Import('TextRendererFormatContext')
export type TextRendererFormatContext = Static<typeof TextRendererFormatContext>
export const ControlledHttpHeaders = RuntimePublic15.Import('ControlledHttpHeaders')
export type ControlledHttpHeaders = Static<typeof ControlledHttpHeaders>
export const AuthorityDirectoryCompareAndSwapRequest = RuntimePublic15.Import('AuthorityDirectoryCompareAndSwapRequest')
export type AuthorityDirectoryCompareAndSwapRequest = Static<typeof AuthorityDirectoryCompareAndSwapRequest>
export const AuthorityDirectoryCompareAndSwapResult = RuntimePublic15.Import('AuthorityDirectoryCompareAndSwapResult')
export type AuthorityDirectoryCompareAndSwapResult = Static<typeof AuthorityDirectoryCompareAndSwapResult>
export const IntegrityCanonicalizeRequest = RuntimePublic15.Import('IntegrityCanonicalizeRequest')
export type IntegrityCanonicalizeRequest = Static<typeof IntegrityCanonicalizeRequest>
export const IntegrityCanonicalizeResult = RuntimePublic15.Import('IntegrityCanonicalizeResult')
export type IntegrityCanonicalizeResult = Static<typeof IntegrityCanonicalizeResult>
export const LedgerIntegrityCheckpoint = RuntimePublic15.Import('LedgerIntegrityCheckpoint')
export type LedgerIntegrityCheckpoint = Static<typeof LedgerIntegrityCheckpoint>
export const LedgerIntegrityMetadata = RuntimePublic15.Import('LedgerIntegrityMetadata')
export type LedgerIntegrityMetadata = Static<typeof LedgerIntegrityMetadata>
export const Externalsession_v1_Actor = RuntimePublic15.Import('Externalsession_v1_Actor')
export type Externalsession_v1_Actor = Static<typeof Externalsession_v1_Actor>
export const Externalsession_v1_SurfaceOp = RuntimePublic15.Import('Externalsession_v1_SurfaceOp')
export type Externalsession_v1_SurfaceOp = Static<typeof Externalsession_v1_SurfaceOp>
export const Externalsession_v1_EventEnvelope = RuntimePublic15.Import('Externalsession_v1_EventEnvelope')
export type Externalsession_v1_EventEnvelope = Static<typeof Externalsession_v1_EventEnvelope>
export const LedgerIntegrityRow = RuntimePublic15.Import('LedgerIntegrityRow')
export type LedgerIntegrityRow = Static<typeof LedgerIntegrityRow>
export const IntegrityVerifyRequest = RuntimePublic15.Import('IntegrityVerifyRequest')
export type IntegrityVerifyRequest = Static<typeof IntegrityVerifyRequest>
export const IntegrityVerifyResult = RuntimePublic15.Import('IntegrityVerifyResult')
export type IntegrityVerifyResult = Static<typeof IntegrityVerifyResult>
export const ClientInteractionFormLinkInput = RuntimePublic15.Import('ClientInteractionFormLinkInput')
export type ClientInteractionFormLinkInput = Static<typeof ClientInteractionFormLinkInput>
export const InteractionFormLinkRequest = RuntimePublic15.Import('InteractionFormLinkRequest')
export type InteractionFormLinkRequest = Static<typeof InteractionFormLinkRequest>
export const ConfigSourceIdentity = RuntimePublic15.Import('ConfigSourceIdentity')
export type ConfigSourceIdentity = Static<typeof ConfigSourceIdentity>
