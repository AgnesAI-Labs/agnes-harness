import type { Page } from './runtime-public.js'
// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const RuntimePublic14 = Type.Module({
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
  "BindingRef": Type.Object({ "bindingId": Type.Ref('Id'), "contract": Type.String(), "logicalName": Type.String(), "providerId": Type.Ref('Id') }, { additionalProperties: false }),
  "Provenance": Type.Object({ "sourceRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "producer": Type.Ref('BindingRef'), "trustLabels": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }),
  "StateAuthorityRef": Type.Object({ "authorityId": Type.Ref('Id'), "tenantId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ScopeRef": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "kind": Type.Literal('installation') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "kind": Type.Literal('runtime') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('run') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('action'), "actionId": Type.Ref('Id') }, { additionalProperties: false })]),
  "DomainReference": Type.Object({ "authorityId": Type.Ref('Id'), "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53'), "schema": Type.Ref('SchemaRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "Money": Type.Object({ "currency": Type.String(), "scale": Type.Literal(6), "units": Type.String() }, { additionalProperties: false }),
  "DomainEvent": Type.Object({ "eventId": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "schema": Type.Ref('SchemaRef'), "source": Type.Ref('BindingRef'), "scope": Type.Ref('ScopeRef'), "occurredAt": Type.Ref('Timestamp'), "payload": Type.Ref('DataRef'), "idempotencyKey": Type.String(), "causation": Type.Object({ "runId": Type.Optional(Type.Ref('Id')), "actionId": Type.Optional(Type.Ref('Id')), "attemptId": Type.Optional(Type.Ref('Id')), "commandId": Type.Optional(Type.Ref('Id')) }, { additionalProperties: false }), "principalRef": Type.Ref('Id'), "correlationId": Type.Union([Type.Ref('Id'), Type.Null()]), "provenance": Type.Ref('Provenance') }, { additionalProperties: false }),
  "UsageFact": Type.Object({ "usageId": Type.Ref('Id'), "originKey": Type.String(), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "source": Type.Ref('BindingRef'), "dimensions": Type.Ref('DataRef'), "externalRequest": Type.Ref('ExternalRequestRef'), "observedAt": Type.Ref('Timestamp'), "certainty": Type.Union([Type.Literal('measured'), Type.Literal('estimated'), Type.Literal('unknown')]) }, { additionalProperties: false }),
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
  "ExactQuantity": Type.Object({ "unit": Type.String(), "value": Type.String() }, { additionalProperties: false }),
  "UsageFactRef": Type.Object({ "authorityId": Type.Ref('Id'), "usageId": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "LeaseRef": Type.Object({ "authorityId": Type.Ref('Id'), "leaseId": Type.Ref('Id'), "epoch": Type.Ref('UInt53'), "expiresAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "ResourceChangePlan": Type.Object({ "planId": Type.Ref('Id'), "kind": Type.Union([Type.Literal('mcp'), Type.Literal('skill')]), "operation": Type.Union([Type.Literal('install'), Type.Literal('update'), Type.Literal('remove')]), "targetScope": Type.Ref('ScopeRef'), "resourceId": Type.Ref('Id'), "sourceRef": Type.Union([Type.Ref('ResourceRef'), Type.Null()]), "expectedRevision": Type.Union([Type.Ref('Revision'), Type.Null()]), "config": Type.Union([Type.Ref('ConfigValue'), Type.Null()]), "permissionDifference": Type.Array(Type.Ref('CapabilityRequirement'), { maxItems: 10000 }), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "PackageLocator": Type.Union([Type.Object({ "kind": Type.Literal('local'), "sourceId": Type.Ref('Id'), "pathRef": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('npm'), "sourceId": Type.Ref('Id'), "name": Type.String(), "version": Type.String(), "integrity": Type.String(), "digest": Type.Ref('Digest') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('git'), "sourceId": Type.Ref('Id'), "repository": Type.String(), "commit": Type.String(), "subdirectory": Type.String(), "digest": Type.Ref('Digest') }, { additionalProperties: false })]),
  "ResolvedProviderBinding": Type.Object({ "binding": Type.Ref('BindingRef'), "descriptor": Type.Ref('ProviderDescriptor'), "isolation": Type.Ref('IsolationMode'), "config": Type.Ref('DataRef'), "configDigest": Type.Ref('Digest'), "dependencies": Type.Array(Type.Ref('BindingRef'), { maxItems: 10000 }), "codecRefs": Type.Array(Type.Ref('StateCodecRef'), { maxItems: 10000 }), "schemaRefs": Type.Array(Type.Ref('SchemaRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "VersionedRef": Type.Object({ "id": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "digest": Type.Ref('Digest'), "data": Type.Ref('DataRef') }, { additionalProperties: false }),
  "ContentRef": Type.Ref('DataRef'),
  "ReleaseSet": Type.Object({ "releaseSetId": Type.String(), "formatVersion": Type.Number(), "hostAbi": Type.String(), "packages": Type.Array(Type.Object({ "packageId": Type.String(), "version": Type.String(), "digest": Type.String(), "sourceRef": Type.String(), "integrityRef": Type.String(), "entries": Type.Record(Type.String(), Type.Object({ "digest": Type.String(), "platform": Type.String() }, { additionalProperties: false }), { maxProperties: 10000 }) }, { additionalProperties: false }), { maxItems: 10000 }), "bindings": Type.Array(Type.Ref('ResolvedProviderBinding'), { maxItems: 10000 }), "profileRef": Type.Ref('VersionedRef'), "presetRef": Type.Ref('VersionedRef'), "configSnapshotRef": Type.Ref('ContentRef'), "schemasRef": Type.Ref('ContentRef'), "clientBundlesRef": Type.Ref('ContentRef'), "recoveryManifestRef": Type.Ref('ContentRef'), "resourceClaimsRef": Type.Ref('ContentRef') }, { additionalProperties: false }),
  "ReleasePlan": Type.Object({ "planId": Type.Ref('Id'), "upgradeId": Type.Ref('Id'), "planFingerprint": Type.Ref('Digest'), "operation": Type.Union([Type.Literal('install'), Type.Literal('upgrade'), Type.Literal('disable'), Type.Literal('repair'), Type.Literal('rollback')]), "routeId": Type.Ref('Id'), "expectedRouteRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]), "sourceReleaseSetId": Type.Union([Type.Ref('Id'), Type.Null()]), "targetReleaseSet": Type.Ref('ReleaseSet'), "affectedContributions": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "configDigest": Type.Ref('Digest'), "permissionDifference": Type.Object({ "beforeProfileDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "afterProfileDigest": Type.Ref('Digest'), "added": Type.Array(Type.Ref('CapabilityRequirement'), { maxItems: 10000 }), "removed": Type.Array(Type.Ref('CapabilityRequirement'), { maxItems: 10000 }), "policyChanges": Type.Array(Type.Object({ "path": Type.String(), "before": Type.Union([Type.Ref('DataRef'), Type.Null()]), "after": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }), "requiredPins": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "readinessChecks": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "prerequisiteMigrationPlans": Type.Array(Type.Object({ "planId": Type.Ref('Id'), "planFingerprint": Type.Ref('Digest') }, { additionalProperties: false }), { maxItems: 10000 }), "authorizedBy": Type.Ref('Id'), "expiresAt": Type.Ref('Timestamp'), "rollbackOf": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "ChangeProposal": Type.Object({ "proposalId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "requester": Type.Ref('Id'), "scope": Type.Ref('ScopeRef'), "status": Type.Union([Type.Literal('planning'), Type.Literal('awaiting-approval'), Type.Literal('approved'), Type.Literal('applying'), Type.Literal('applied'), Type.Literal('denied'), Type.Literal('cancelled'), Type.Literal('unknown')]), "plan": Type.Union([Type.Object({ "kind": Type.Literal('release'), "value": Type.Ref('ReleasePlan') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('resource'), "value": Type.Ref('ResourceChangePlan') }, { additionalProperties: false }), Type.Null()]), "planDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "interactionRef": Type.Union([Type.Ref('InteractionRef'), Type.Null()]), "resultRef": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]), "error": Type.Union([Type.Ref('RuntimeError'), Type.Null()]) }, { additionalProperties: false }),
  "ProviderBindingSnapshot": Type.Object({ "binding": Type.Ref('BindingRef'), "descriptor": Type.Ref('ProviderDescriptor'), "isolation": Type.Ref('IsolationMode'), "config": Type.Ref('DataRef'), "configDigest": Type.Ref('Digest'), "dependencies": Type.Array(Type.Ref('BindingRef'), { maxItems: 10000 }), "codecRefs": Type.Array(Type.Ref('StateCodecRef'), { maxItems: 10000 }), "schemaRefs": Type.Array(Type.Ref('SchemaRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "AttemptRef": Type.Object({ "run": Type.Ref('RunRef'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id') }, { additionalProperties: false }),
  "Cursor": Type.String(),
  "ArtifactTitle": Object.assign(Type.String({ minLength: 1, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), {"x-max-utf8-bytes":1024}),
  "ArtifactMediaType": Object.assign(Type.String({ pattern: "^[a-z0-9][a-z0-9!#$&^_.+\\-]*/[a-z0-9][a-z0-9!#$&^_.+\\-]*$" }), {"x-max-utf8-bytes":255}),
  "DomainQuery": Type.Object({ "domainType": Type.String(), "query": Type.Ref('DataRef'), "scope": Type.Ref('ScopeRef'), "cursor": Type.Union([Type.String(), Type.Null()]), "limit": Type.Integer({ minimum: 1, maximum: 500 }) }, { additionalProperties: false }),
  "JobTarget": Type.Union([Type.Object({ "kind": Type.Literal('pin'), "releaseSetId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "presetRef": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('follow'), "routeId": Type.Ref('Id'), "presetRef": Type.Ref('Id') }, { additionalProperties: false })]),
  "JobSchedule": Type.Union([Type.Object({ "kind": Type.Literal('once'), "at": Type.Ref('Timestamp') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('rrule'), "rrule": Type.String(), "timezone": Type.String(), "startsAt": Type.Ref('Timestamp'), "ambiguousLocalTime": Type.Union([Type.Literal('earlier'), Type.Literal('later')]), "nonexistentLocalTime": Type.Union([Type.Literal('skip'), Type.Literal('next-valid')]) }, { additionalProperties: false })]),
  "JobPolicy": Type.Object({ "missed": Type.Union([Type.Literal('skip'), Type.Literal('latest'), Type.Literal('catch-up')]), "maxCatchUp": Type.Ref('UInt53'), "concurrency": Type.Union([Type.Literal('forbid'), Type.Literal('queue'), Type.Literal('parallel')]), "maxConcurrent": Type.Ref('UInt53'), "maxAttempts": Type.Ref('UInt53'), "retryDelayMs": Type.Ref('UInt53'), "retryMaxDelayMs": Type.Ref('UInt53') }, { additionalProperties: false }),
  "JobDefinition": Type.Object({ "definitionId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "status": Type.Union([Type.Literal('active'), Type.Literal('paused'), Type.Literal('cancelled')]), "schedule": Type.Ref('JobSchedule'), "policy": Type.Ref('JobPolicy'), "target": Type.Ref('JobTarget'), "inputRef": Type.Ref('DataRef'), "budgetAccount": Type.Ref('DomainObjectRef'), "ownerPrincipalRef": Type.Ref('Id'), "nextDueAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "protected": Type.Boolean() }, { additionalProperties: false }),
  "JobOccurrence": Type.Object({ "occurrenceId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "definitionId": Type.Ref('Id'), "definitionRevision": Type.Ref('Revision'), "scheduledAt": Type.Ref('Timestamp'), "attempt": Type.Ref('UInt53'), "state": Type.Union([Type.Literal('pending'), Type.Literal('claimed'), Type.Literal('running'), Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled')]), "bindingId": Type.Union([Type.Ref('Id'), Type.Null()]), "releaseSetId": Type.Union([Type.Ref('Id'), Type.Null()]), "ticketId": Type.Union([Type.Ref('Id'), Type.Null()]), "runId": Type.Union([Type.Ref('Id'), Type.Null()]), "claim": Type.Union([Type.Ref('LeaseRef'), Type.Null()]), "nextAttemptAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "outcomeRef": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]) }, { additionalProperties: false }),
  "BudgetReservation": Type.Object({ "ref": Type.Ref('DomainObjectRef'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "accountRef": Type.Ref('DomainObjectRef'), "parentReservationRef": Type.Union([Type.Ref('DomainObjectRef'), Type.Null()]), "scopeIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "unitsByKind": Type.Array(Type.Ref('ExactQuantity'), { maxItems: 10000 }), "held": Type.Union([Type.Ref('Money'), Type.Null()]), "priceVersion": Type.Union([Type.Ref('Id'), Type.Null()]), "status": Type.Union([Type.Literal('held'), Type.Literal('settling'), Type.Literal('settled'), Type.Literal('released'), Type.Literal('unknown')]), "revision": Type.Ref('Revision'), "expiresAt": Type.Ref('Timestamp'), "settledAmount": Type.Union([Type.Ref('Money'), Type.Null()]), "usageRefs": Type.Array(Type.Ref('UsageFactRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "UsageMeasurement": Type.Object({ "kind": Type.Union([Type.Literal('reported'), Type.Literal('estimated'), Type.Literal('corrected'), Type.Literal('unknown')]), "quantities": Type.Array(Type.Ref('ExactQuantity'), { maxItems: 10000 }), "actualModel": Type.Union([Type.String(), Type.Null()]), "source": Type.Union([Type.Literal('provider-receipt'), Type.Literal('adapter-counter'), Type.Literal('reported-target'), Type.Literal('estimator')]), "sourceReceipt": Type.Union([Type.Ref('DataRef'), Type.Null()]), "billing": Type.Optional(Type.Object({ "usdMicros": Type.Ref('UInt53'), "source": Type.Union([Type.Literal('gateway'), Type.Literal('estimated')]), "subscription": Type.Boolean() }, { additionalProperties: false })), "credits": Type.Optional(Type.Number({ minimum: 0 })), "creditSource": Type.Optional(Type.Union([Type.Literal('gateway'), Type.Literal('estimated')])), "replacesFactIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "UploadRef": Type.Object({ "authorityId": Type.Ref('Id'), "uploadId": Type.Ref('Id'), "reservationId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "status": Type.Literal('sealed') }, { additionalProperties: false }),
  "ArtifactSource": Type.Union([Type.Object({ "kind": Type.Literal('upload'), "upload": Type.Ref('UploadRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "DomainEventRecord": Type.Object({ "event": Type.Ref('DomainEvent'), "authorityId": Type.Ref('Id'), "sequence": Type.Ref('UInt53'), "aggregate": Type.Ref('DomainObjectRef'), "fingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "TraceSpan": Type.Object({ "traceId": Type.Ref('Id'), "spanId": Type.Ref('Id'), "parentSpanId": Type.Union([Type.Ref('Id'), Type.Null()]), "name": Type.String(), "startedAt": Type.Ref('Timestamp'), "endedAt": Type.Ref('Timestamp'), "attributes": Type.Ref('DataRef'), "outcome": Type.Union([Type.Literal('ok'), Type.Literal('error'), Type.Literal('cancelled'), Type.Literal('unknown')]) }, { additionalProperties: false }),
  "PackageRequirement": Type.Object({ "packageId": Type.Ref('Id'), "versionRange": Type.String(), "sourceIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PackageLockEntry": Type.Object({ "packageId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest'), "locator": Type.Ref('PackageLocator'), "manifestRef": Type.Ref('DataRef'), "dependencies": Type.Array(Type.Object({ "packageId": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PackageLock": Type.Object({ "entries": Type.Array(Type.Ref('PackageLockEntry'), { maxItems: 10000 }), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "AssemblyGraph": Type.Object({ "graphId": Type.Ref('Id'), "configRef": Type.Ref('DataRef'), "lock": Type.Ref('PackageLock'), "bindings": Type.Array(Type.Ref('ProviderBindingSnapshot'), { maxItems: 10000 }), "dependencies": Type.Array(Type.Object({ "consumerId": Type.Ref('Id'), "dependencyId": Type.Ref('Id'), "optional": Type.Boolean() }, { additionalProperties: false }), { maxItems: 10000 }), "requiredContributions": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ChannelDestination": Type.Object({ "channelId": Type.Ref('Id'), "accountId": Type.Ref('Id'), "conversationId": Type.Ref('Id'), "threadId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "AuthenticatedCallback": Type.Object({ "callbackId": Type.Ref('Id'), "channelId": Type.Ref('Id'), "remoteEventId": Type.Ref('Id'), "actorPrincipalRef": Type.Ref('Id'), "destination": Type.Ref('ChannelDestination'), "receivedAt": Type.Ref('Timestamp'), "credentialRevision": Type.Ref('Revision'), "verifiedEnvelopeDigest": Type.Ref('Digest'), "command": Type.Union([Type.Object({ "kind": Type.Literal('interaction'), "interactionId": Type.Ref('Id'), "expectedVersion": Type.Ref('Revision'), "responseId": Type.Ref('Id'), "answer": Type.Ref('DataRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('domain'), "command": Type.Ref('DataRef') }, { additionalProperties: false })]) }, { additionalProperties: false }),
  "PageJobOccurrence": Type.Object({ "items": Type.Array(Type.Ref('JobOccurrence'), { maxItems: 10000 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "JobsInspectResult": Type.Object({ "definition": Type.Ref('JobDefinition'), "occurrences": Type.Ref('PageJobOccurrence') }, { additionalProperties: false }),
  "ArtifactsReserveRequest": Type.Union([Type.Object({ "publicationId": Type.Ref('Id'), "kind": Type.Ref('TypeId'), "schema": Type.Ref('SchemaRef'), "title": Type.Union([Type.Ref('ArtifactTitle'), Type.Null()]), "mediaType": Type.Union([Type.Ref('ArtifactMediaType'), Type.Null()]), "ownerActionRef": Type.Ref('ActionRef'), "artifactId": Type.Null(), "expectedLatestVersion": Type.Null() }, { additionalProperties: false }), Type.Object({ "publicationId": Type.Ref('Id'), "kind": Type.Ref('TypeId'), "schema": Type.Ref('SchemaRef'), "title": Type.Union([Type.Ref('ArtifactTitle'), Type.Null()]), "mediaType": Type.Union([Type.Ref('ArtifactMediaType'), Type.Null()]), "ownerActionRef": Type.Ref('ActionRef'), "artifactId": Type.Ref('Id'), "expectedLatestVersion": Type.Ref('ArtifactVersion') }, { additionalProperties: false })]),
  "ArtifactsPublishRequest": Type.Object({ "publicationId": Type.Ref('Id'), "source": Type.Ref('ArtifactSource'), "expectedRevision": Type.Ref('Revision'), "title": Type.Ref('ArtifactTitle'), "mediaType": Type.Ref('ArtifactMediaType') }, { additionalProperties: false }),
  "ArtifactsRevokeRequest": Type.Object({ "artifactRef": Type.Ref('ArtifactRef'), "reason": Type.String() }, { additionalProperties: false }),
  "ArtifactsQueryRequest": Type.Object({ "artifactRef": Type.Ref('ArtifactRef') }, { additionalProperties: false }),
  "BlobStageRequest": Type.Object({ "uploadId": Type.Ref('Id'), "size": Type.Ref('UInt53'), "mediaType": Type.String(), "expectedDigest": Type.Union([Type.Ref('Digest'), Type.Null()]) }, { additionalProperties: false }),
  "BlobPromoteRequest": Type.Object({ "upload": Type.Ref('UploadRef'), "expectedDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "BlobPinRequest": Type.Object({ "stagedBlob": Type.Ref('StagedBlobRef'), "ownerRef": Type.Ref('PublicRef'), "retentionUntil": Type.Union([Type.Ref('Timestamp'), Type.Null()]) }, { additionalProperties: false }),
  "BlobUnpinRequest": Type.Object({ "pinId": Type.Ref('Id'), "expectedRevision": Type.Ref('Revision') }, { additionalProperties: false }),
  "BlobUnpinResult": Type.Object({ "released": Type.Boolean() }, { additionalProperties: false }),
  "BlobGcRequest": Type.Object({ "scopeRef": Type.Ref('ScopeRef'), "dryRun": Type.Boolean(), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "BlobGcResult": Type.Object({ "eligibleRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "deletedRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]) }, { additionalProperties: false }),
  "BlobInspectReference": Type.Union([Type.Ref('PublicBlobReference'), Type.Ref('PublicUploadReference'), Type.Ref('PublicStagedBlobReference')]),
  "BlobInspectRequest": Type.Object({ "ref": Type.Ref('BlobInspectReference') }, { additionalProperties: false }),
  "BlobInspectResult": Type.Union([Type.Object({ "status": Type.Literal('uploading'), "bytes": Type.Ref('UInt53'), "digest": Type.Null(), "ownerRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "status": Type.Literal('sealed'), "bytes": Type.Ref('UInt53'), "digest": Type.Ref('Digest'), "ownerRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "status": Type.Literal('aborted'), "bytes": Type.Ref('UInt53'), "digest": Type.Null(), "ownerRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "status": Type.Literal('staged'), "bytes": Type.Ref('UInt53'), "digest": Type.Ref('Digest'), "ownerRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "status": Type.Literal('pinned'), "bytes": Type.Ref('UInt53'), "digest": Type.Ref('Digest'), "ownerRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "status": Type.Literal('deleted'), "bytes": Type.Ref('UInt53'), "digest": Type.Union([Type.Ref('Digest'), Type.Null()]), "ownerRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }) }, { additionalProperties: false })]),
  "BudgetReserveRequest": Type.Object({ "actionRef": Type.Ref('ActionRef'), "attemptId": Type.Ref('Id'), "accountRef": Type.Ref('DomainObjectRef'), "unitsByKind": Type.Array(Type.Ref('ExactQuantity'), { maxItems: 10000 }), "maxCost": Type.Union([Type.Ref('Money'), Type.Null()]), "priceVersion": Type.Union([Type.Ref('Id'), Type.Null()]), "parentReservationRef": Type.Union([Type.Ref('DomainObjectRef'), Type.Null()]) }, { additionalProperties: false }),
  "BudgetReserveResult": Type.Object({ "reservation": Type.Ref('BudgetReservation'), "remaining": Type.Union([Type.Ref('Money'), Type.Null()]) }, { additionalProperties: false }),
  "BudgetSettleRequest": Type.Object({ "reservationRef": Type.Ref('DomainObjectRef'), "usageRefs": Type.Array(Type.Ref('UsageFactRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "BudgetSettleResult": Type.Object({ "reservation": Type.Ref('BudgetReservation'), "balance": Type.Union([Type.Ref('Money'), Type.Null()]) }, { additionalProperties: false }),
  "BudgetReconcileRequest": Type.Object({ "reservationRef": Type.Ref('DomainObjectRef'), "evidenceRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "BudgetReconcileResult": Type.Object({ "reservation": Type.Ref('BudgetReservation'), "balance": Type.Union([Type.Ref('Money'), Type.Null()]) }, { additionalProperties: false }),
  "BudgetReserveQuotaRequest": Type.Object({ "actionRef": Type.Ref('ActionRef'), "attemptId": Type.Ref('Id'), "dimensions": Type.Array(Type.Object({ "name": Type.Union([Type.Literal('parallel-action'), Type.Literal('live-agent')]), "amount": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "BudgetReleaseQuotaRequest": Type.Object({ "reservationRef": Type.Ref('DomainObjectRef'), "completionEvidence": Type.Ref('DataRef') }, { additionalProperties: false }),
  "UsageRecordRequest": Type.Object({ "attemptRef": Type.Ref('AttemptRef'), "externalReceiptRef": Type.Union([Type.Ref('DataRef'), Type.Null()]), "measurement": Type.Ref('UsageMeasurement') }, { additionalProperties: false }),
  "UsageRecordResult": Type.Object({ "factRefs": Type.Array(Type.Ref('UsageFactRef'), { maxItems: 10000 }), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "UsageQueryRequest": Type.Object({ "scopeRef": Type.Ref('ScopeRef'), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "PageUsageFact": Type.Object({ "items": Type.Array(Type.Ref('UsageFact'), { maxItems: 10000 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "UsageQueryResult": Type.Ref('PageUsageFact'),
  "PricingQuoteRequest": Type.Object({ "usageUnits": Type.Array(Type.Ref('ExactQuantity'), { maxItems: 10000 }), "model": Type.String(), "region": Type.Union([Type.String(), Type.Null()]), "priceVersion": Type.Ref('Id'), "currency": Type.String() }, { additionalProperties: false }),
  "BillingPostRequest": Type.Object({ "usageRefs": Type.Array(Type.Ref('UsageFactRef'), { maxItems: 10000 }), "quoteRef": Type.Ref('DataRef'), "accountRef": Type.Ref('DomainObjectRef'), "chargeKey": Type.Ref('Id') }, { additionalProperties: false }),
  "BillingRefundRequest": Type.Object({ "chargeRef": Type.Ref('DomainObjectRef'), "amount": Type.Ref('Money'), "reason": Type.String(), "refundKey": Type.Ref('Id') }, { additionalProperties: false }),
  "BillingReconcileRequest": Type.Object({ "chargeRef": Type.Ref('DomainObjectRef'), "evidenceRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "AuditAppendResult": Type.Object({ "auditRef": Type.Ref('ReceiptPointer') }, { additionalProperties: false }),
  "AuditExportRequest": Type.Object({ "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53'), "targetRef": Type.Ref('Id') }, { additionalProperties: false }),
  "AuditExportResult": Type.Object({ "checkpoint": Type.Ref('Cursor'), "archiveReceipt": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "TraceRecordRequest": Type.Object({ "batchId": Type.Ref('Id'), "spans": Type.Array(Type.Ref('TraceSpan'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "TraceRecordResult": Type.Object({ "accepted": Type.Ref('UInt53'), "dropped": Type.Ref('UInt53') }, { additionalProperties: false }),
  "EventsSubscribeRequest": Type.Object({ "scopeRef": Type.Ref('ScopeRef'), "types": Type.Array(Type.Ref('TypeId'), { maxItems: 10000 }), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "PageDomainEventRecord": Type.Object({ "items": Type.Array(Type.Ref('DomainEventRecord'), { maxItems: 10000 }), "snapshot": Type.Ref('Id'), "nextCursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "EventsSubscribeResult": Type.Object({ "page": Type.Ref('PageDomainEventRecord'), "resyncRequired": Type.Literal(false) }, { additionalProperties: false }),
  "EventsPublishRequest": Type.Object({ "domainSchema": Type.Ref('SchemaRef'), "payload": Type.Ref('DataRef'), "causationRef": Type.Ref('PublicRef'), "typeId": Type.Ref('TypeId'), "idempotencyKey": Object.assign(Type.String({ minLength: 1 }), {"x-max-utf8-bytes":8192}), "aggregate": Type.Ref('DomainObjectRef') }, { additionalProperties: false }),
  "EventsPublishResult": Type.Object({ "eventRef": Type.Ref('PublicRef') }, { additionalProperties: false }),
  "ProjectionChangesRequest": Type.Object({ "query": Type.Ref('DomainQuery'), "afterCursor": Type.String(), "limit": Type.Integer({ minimum: 1, maximum: 500 }) }, { additionalProperties: false }),
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
})

export const Id = RuntimePublic14.Import('Id')
export type Id = Static<typeof Id>
export const UInt53 = RuntimePublic14.Import('UInt53')
export type UInt53 = Static<typeof UInt53>
export const Timestamp = RuntimePublic14.Import('Timestamp')
export type Timestamp = Static<typeof Timestamp>
export const TypeId = RuntimePublic14.Import('TypeId')
export type TypeId = Static<typeof TypeId>
export const Digest = RuntimePublic14.Import('Digest')
export type Digest = Static<typeof Digest>
export const SchemaRef = RuntimePublic14.Import('SchemaRef')
export type SchemaRef = Static<typeof SchemaRef>
export const BlobRef = RuntimePublic14.Import('BlobRef')
export type BlobRef = Static<typeof BlobRef>
export const DataRef = RuntimePublic14.Import('DataRef')
export type DataRef = Static<typeof DataRef>
export const ActionRef = RuntimePublic14.Import('ActionRef')
export type ActionRef = Static<typeof ActionRef>
export const RuntimeErrorCode = RuntimePublic14.Import('RuntimeErrorCode')
export type RuntimeErrorCode = Static<typeof RuntimeErrorCode>
export const OwnerRef = RuntimePublic14.Import('OwnerRef')
export type OwnerRef = Static<typeof OwnerRef>
export const RetryAdvice = RuntimePublic14.Import('RetryAdvice')
export type RetryAdvice = Static<typeof RetryAdvice>
export const RuntimeError = RuntimePublic14.Import('RuntimeError')
export type RuntimeError = Static<typeof RuntimeError>
export const ExternalRequestRef = RuntimePublic14.Import('ExternalRequestRef')
export type ExternalRequestRef = Static<typeof ExternalRequestRef>
export const BindingRef = RuntimePublic14.Import('BindingRef')
export type BindingRef = Static<typeof BindingRef>
export const Provenance = RuntimePublic14.Import('Provenance')
export type Provenance = Static<typeof Provenance>
export const StateAuthorityRef = RuntimePublic14.Import('StateAuthorityRef')
export type StateAuthorityRef = Static<typeof StateAuthorityRef>
export const ScopeRef = RuntimePublic14.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const DomainReference = RuntimePublic14.Import('DomainReference')
export type DomainReference = Static<typeof DomainReference>
export const Money = RuntimePublic14.Import('Money')
export type Money = Static<typeof Money>
export const DomainEvent = RuntimePublic14.Import('DomainEvent')
export type DomainEvent = Static<typeof DomainEvent>
export const UsageFact = RuntimePublic14.Import('UsageFact')
export type UsageFact = Static<typeof UsageFact>
export const Scope = RuntimePublic14.Import('Scope')
export type Scope = Static<typeof Scope>
export const IsolationMode = RuntimePublic14.Import('IsolationMode')
export type IsolationMode = Static<typeof IsolationMode>
export const CapabilityRequirement = RuntimePublic14.Import('CapabilityRequirement')
export type CapabilityRequirement = Static<typeof CapabilityRequirement>
export const OperationDescriptor = RuntimePublic14.Import('OperationDescriptor')
export type OperationDescriptor = Static<typeof OperationDescriptor>
export const CommunityOwnerPackageId = RuntimePublic14.Import('CommunityOwnerPackageId')
export type CommunityOwnerPackageId = Static<typeof CommunityOwnerPackageId>
export const CommunityContractRef = RuntimePublic14.Import('CommunityContractRef')
export type CommunityContractRef = Static<typeof CommunityContractRef>
export const ServiceRequirement = RuntimePublic14.Import('ServiceRequirement')
export type ServiceRequirement = Static<typeof ServiceRequirement>
export const StateCodecRef = RuntimePublic14.Import('StateCodecRef')
export type StateCodecRef = Static<typeof StateCodecRef>
export const ProviderDescriptor = RuntimePublic14.Import('ProviderDescriptor')
export type ProviderDescriptor = Static<typeof ProviderDescriptor>
export const ConfigValue = RuntimePublic14.Import('ConfigValue')
export type ConfigValue = Static<typeof ConfigValue>
export const ResourceRef = RuntimePublic14.Import('ResourceRef')
export type ResourceRef = Static<typeof ResourceRef>
export const ArtifactVersion = RuntimePublic14.Import('ArtifactVersion')
export type ArtifactVersion = Static<typeof ArtifactVersion>
export const ArtifactRef = RuntimePublic14.Import('ArtifactRef')
export type ArtifactRef = Static<typeof ArtifactRef>
export const Revision = RuntimePublic14.Import('Revision')
export type Revision = Static<typeof Revision>
export const DomainObjectRef = RuntimePublic14.Import('DomainObjectRef')
export type DomainObjectRef = Static<typeof DomainObjectRef>
export const SessionRef = RuntimePublic14.Import('SessionRef')
export type SessionRef = Static<typeof SessionRef>
export const RunRef = RuntimePublic14.Import('RunRef')
export type RunRef = Static<typeof RunRef>
export const InteractionRef = RuntimePublic14.Import('InteractionRef')
export type InteractionRef = Static<typeof InteractionRef>
export const PublicBlobReference = RuntimePublic14.Import('PublicBlobReference')
export type PublicBlobReference = Static<typeof PublicBlobReference>
export const UploadSession = RuntimePublic14.Import('UploadSession')
export type UploadSession = Static<typeof UploadSession>
export const PublicUploadReference = RuntimePublic14.Import('PublicUploadReference')
export type PublicUploadReference = Static<typeof PublicUploadReference>
export const StagedBlobRef = RuntimePublic14.Import('StagedBlobRef')
export type StagedBlobRef = Static<typeof StagedBlobRef>
export const PublicStagedBlobReference = RuntimePublic14.Import('PublicStagedBlobReference')
export type PublicStagedBlobReference = Static<typeof PublicStagedBlobReference>
export const PublicRef = RuntimePublic14.Import('PublicRef')
export type PublicRef = Static<typeof PublicRef>
export const ReceiptPointer = RuntimePublic14.Import('ReceiptPointer')
export type ReceiptPointer = Static<typeof ReceiptPointer>
export const ExactQuantity = RuntimePublic14.Import('ExactQuantity')
export type ExactQuantity = Static<typeof ExactQuantity>
export const UsageFactRef = RuntimePublic14.Import('UsageFactRef')
export type UsageFactRef = Static<typeof UsageFactRef>
export const LeaseRef = RuntimePublic14.Import('LeaseRef')
export type LeaseRef = Static<typeof LeaseRef>
export const ResourceChangePlan = RuntimePublic14.Import('ResourceChangePlan')
export type ResourceChangePlan = Static<typeof ResourceChangePlan>
export const PackageLocator = RuntimePublic14.Import('PackageLocator')
export type PackageLocator = Static<typeof PackageLocator>
export const ResolvedProviderBinding = RuntimePublic14.Import('ResolvedProviderBinding')
export type ResolvedProviderBinding = Static<typeof ResolvedProviderBinding>
export const VersionedRef = RuntimePublic14.Import('VersionedRef')
export type VersionedRef = Static<typeof VersionedRef>
export const ContentRef = RuntimePublic14.Import('ContentRef')
export type ContentRef = Static<typeof ContentRef>
export const ReleaseSet = RuntimePublic14.Import('ReleaseSet')
export type ReleaseSet = Static<typeof ReleaseSet>
export const ReleasePlan = RuntimePublic14.Import('ReleasePlan')
export type ReleasePlan = Static<typeof ReleasePlan>
export const ChangeProposal = RuntimePublic14.Import('ChangeProposal')
export type ChangeProposal = Static<typeof ChangeProposal>
export const ProviderBindingSnapshot = RuntimePublic14.Import('ProviderBindingSnapshot')
export type ProviderBindingSnapshot = Static<typeof ProviderBindingSnapshot>
export const AttemptRef = RuntimePublic14.Import('AttemptRef')
export type AttemptRef = Static<typeof AttemptRef>
export const Cursor = RuntimePublic14.Import('Cursor')
export type Cursor = Static<typeof Cursor>
export const ArtifactTitle = RuntimePublic14.Import('ArtifactTitle')
export type ArtifactTitle = Static<typeof ArtifactTitle>
export const ArtifactMediaType = RuntimePublic14.Import('ArtifactMediaType')
export type ArtifactMediaType = Static<typeof ArtifactMediaType>
export const DomainQuery = RuntimePublic14.Import('DomainQuery')
export type DomainQuery = Static<typeof DomainQuery>
export const JobTarget = RuntimePublic14.Import('JobTarget')
export type JobTarget = Static<typeof JobTarget>
export const JobSchedule = RuntimePublic14.Import('JobSchedule')
export type JobSchedule = Static<typeof JobSchedule>
export const JobPolicy = RuntimePublic14.Import('JobPolicy')
export type JobPolicy = Static<typeof JobPolicy>
export const JobDefinition = RuntimePublic14.Import('JobDefinition')
export type JobDefinition = Static<typeof JobDefinition>
export const JobOccurrence = RuntimePublic14.Import('JobOccurrence')
export type JobOccurrence = Static<typeof JobOccurrence>
export const BudgetReservation = RuntimePublic14.Import('BudgetReservation')
export type BudgetReservation = Static<typeof BudgetReservation>
export const UsageMeasurement = RuntimePublic14.Import('UsageMeasurement')
export type UsageMeasurement = Static<typeof UsageMeasurement>
export const UploadRef = RuntimePublic14.Import('UploadRef')
export type UploadRef = Static<typeof UploadRef>
export const ArtifactSource = RuntimePublic14.Import('ArtifactSource')
export type ArtifactSource = Static<typeof ArtifactSource>
export const DomainEventRecord = RuntimePublic14.Import('DomainEventRecord')
export type DomainEventRecord = Static<typeof DomainEventRecord>
export const TraceSpan = RuntimePublic14.Import('TraceSpan')
export type TraceSpan = Static<typeof TraceSpan>
export const PackageRequirement = RuntimePublic14.Import('PackageRequirement')
export type PackageRequirement = Static<typeof PackageRequirement>
export const PackageLockEntry = RuntimePublic14.Import('PackageLockEntry')
export type PackageLockEntry = Static<typeof PackageLockEntry>
export const PackageLock = RuntimePublic14.Import('PackageLock')
export type PackageLock = Static<typeof PackageLock>
export const AssemblyGraph = RuntimePublic14.Import('AssemblyGraph')
export type AssemblyGraph = Static<typeof AssemblyGraph>
export const ChannelDestination = RuntimePublic14.Import('ChannelDestination')
export type ChannelDestination = Static<typeof ChannelDestination>
export const AuthenticatedCallback = RuntimePublic14.Import('AuthenticatedCallback')
export type AuthenticatedCallback = Static<typeof AuthenticatedCallback>
export const PageJobOccurrence = RuntimePublic14.Import('PageJobOccurrence')
export type PageJobOccurrence = Page<JobOccurrence>
export const JobsInspectResult = RuntimePublic14.Import('JobsInspectResult')
export type JobsInspectResult = Omit<Static<typeof JobsInspectResult>, "occurrences"> & { "occurrences": PageJobOccurrence }
export const ArtifactsReserveRequest = RuntimePublic14.Import('ArtifactsReserveRequest')
export type ArtifactsReserveRequest = Static<typeof ArtifactsReserveRequest>
export const ArtifactsPublishRequest = RuntimePublic14.Import('ArtifactsPublishRequest')
export type ArtifactsPublishRequest = Static<typeof ArtifactsPublishRequest>
export const ArtifactsRevokeRequest = RuntimePublic14.Import('ArtifactsRevokeRequest')
export type ArtifactsRevokeRequest = Static<typeof ArtifactsRevokeRequest>
export const ArtifactsQueryRequest = RuntimePublic14.Import('ArtifactsQueryRequest')
export type ArtifactsQueryRequest = Static<typeof ArtifactsQueryRequest>
export const BlobStageRequest = RuntimePublic14.Import('BlobStageRequest')
export type BlobStageRequest = Static<typeof BlobStageRequest>
export const BlobPromoteRequest = RuntimePublic14.Import('BlobPromoteRequest')
export type BlobPromoteRequest = Static<typeof BlobPromoteRequest>
export const BlobPinRequest = RuntimePublic14.Import('BlobPinRequest')
export type BlobPinRequest = Static<typeof BlobPinRequest>
export const BlobUnpinRequest = RuntimePublic14.Import('BlobUnpinRequest')
export type BlobUnpinRequest = Static<typeof BlobUnpinRequest>
export const BlobUnpinResult = RuntimePublic14.Import('BlobUnpinResult')
export type BlobUnpinResult = Static<typeof BlobUnpinResult>
export const BlobGcRequest = RuntimePublic14.Import('BlobGcRequest')
export type BlobGcRequest = Static<typeof BlobGcRequest>
export const BlobGcResult = RuntimePublic14.Import('BlobGcResult')
export type BlobGcResult = Static<typeof BlobGcResult>
export const BlobInspectReference = RuntimePublic14.Import('BlobInspectReference')
export type BlobInspectReference = Static<typeof BlobInspectReference>
export const BlobInspectRequest = RuntimePublic14.Import('BlobInspectRequest')
export type BlobInspectRequest = Static<typeof BlobInspectRequest>
export const BlobInspectResult = RuntimePublic14.Import('BlobInspectResult')
export type BlobInspectResult = Static<typeof BlobInspectResult>
export const BudgetReserveRequest = RuntimePublic14.Import('BudgetReserveRequest')
export type BudgetReserveRequest = Static<typeof BudgetReserveRequest>
export const BudgetReserveResult = RuntimePublic14.Import('BudgetReserveResult')
export type BudgetReserveResult = Static<typeof BudgetReserveResult>
export const BudgetSettleRequest = RuntimePublic14.Import('BudgetSettleRequest')
export type BudgetSettleRequest = Static<typeof BudgetSettleRequest>
export const BudgetSettleResult = RuntimePublic14.Import('BudgetSettleResult')
export type BudgetSettleResult = Static<typeof BudgetSettleResult>
export const BudgetReconcileRequest = RuntimePublic14.Import('BudgetReconcileRequest')
export type BudgetReconcileRequest = Static<typeof BudgetReconcileRequest>
export const BudgetReconcileResult = RuntimePublic14.Import('BudgetReconcileResult')
export type BudgetReconcileResult = Static<typeof BudgetReconcileResult>
export const BudgetReserveQuotaRequest = RuntimePublic14.Import('BudgetReserveQuotaRequest')
export type BudgetReserveQuotaRequest = Static<typeof BudgetReserveQuotaRequest>
export const BudgetReleaseQuotaRequest = RuntimePublic14.Import('BudgetReleaseQuotaRequest')
export type BudgetReleaseQuotaRequest = Static<typeof BudgetReleaseQuotaRequest>
export const UsageRecordRequest = RuntimePublic14.Import('UsageRecordRequest')
export type UsageRecordRequest = Static<typeof UsageRecordRequest>
export const UsageRecordResult = RuntimePublic14.Import('UsageRecordResult')
export type UsageRecordResult = Static<typeof UsageRecordResult>
export const UsageQueryRequest = RuntimePublic14.Import('UsageQueryRequest')
export type UsageQueryRequest = Static<typeof UsageQueryRequest>
export const PageUsageFact = RuntimePublic14.Import('PageUsageFact')
export type PageUsageFact = Page<UsageFact>
export const UsageQueryResult = RuntimePublic14.Import('UsageQueryResult')
export type UsageQueryResult = PageUsageFact
export const PricingQuoteRequest = RuntimePublic14.Import('PricingQuoteRequest')
export type PricingQuoteRequest = Static<typeof PricingQuoteRequest>
export const BillingPostRequest = RuntimePublic14.Import('BillingPostRequest')
export type BillingPostRequest = Static<typeof BillingPostRequest>
export const BillingRefundRequest = RuntimePublic14.Import('BillingRefundRequest')
export type BillingRefundRequest = Static<typeof BillingRefundRequest>
export const BillingReconcileRequest = RuntimePublic14.Import('BillingReconcileRequest')
export type BillingReconcileRequest = Static<typeof BillingReconcileRequest>
export const AuditAppendResult = RuntimePublic14.Import('AuditAppendResult')
export type AuditAppendResult = Static<typeof AuditAppendResult>
export const AuditExportRequest = RuntimePublic14.Import('AuditExportRequest')
export type AuditExportRequest = Static<typeof AuditExportRequest>
export const AuditExportResult = RuntimePublic14.Import('AuditExportResult')
export type AuditExportResult = Static<typeof AuditExportResult>
export const TraceRecordRequest = RuntimePublic14.Import('TraceRecordRequest')
export type TraceRecordRequest = Static<typeof TraceRecordRequest>
export const TraceRecordResult = RuntimePublic14.Import('TraceRecordResult')
export type TraceRecordResult = Static<typeof TraceRecordResult>
export const EventsSubscribeRequest = RuntimePublic14.Import('EventsSubscribeRequest')
export type EventsSubscribeRequest = Static<typeof EventsSubscribeRequest>
export const PageDomainEventRecord = RuntimePublic14.Import('PageDomainEventRecord')
export type PageDomainEventRecord = Page<DomainEventRecord>
export const EventsSubscribeResult = RuntimePublic14.Import('EventsSubscribeResult')
export type EventsSubscribeResult = Omit<Static<typeof EventsSubscribeResult>, "page"> & { "page": PageDomainEventRecord }
export const EventsPublishRequest = RuntimePublic14.Import('EventsPublishRequest')
export type EventsPublishRequest = Static<typeof EventsPublishRequest>
export const EventsPublishResult = RuntimePublic14.Import('EventsPublishResult')
export type EventsPublishResult = Static<typeof EventsPublishResult>
export const ProjectionChangesRequest = RuntimePublic14.Import('ProjectionChangesRequest')
export type ProjectionChangesRequest = Static<typeof ProjectionChangesRequest>
export const ChannelReconcileRequest = RuntimePublic14.Import('ChannelReconcileRequest')
export type ChannelReconcileRequest = Static<typeof ChannelReconcileRequest>
export const ChannelCallbackRequest = RuntimePublic14.Import('ChannelCallbackRequest')
export type ChannelCallbackRequest = Static<typeof ChannelCallbackRequest>
export const ChannelCallbackResult = RuntimePublic14.Import('ChannelCallbackResult')
export type ChannelCallbackResult = Static<typeof ChannelCallbackResult>
export const PackageSourceDiscoverRequest = RuntimePublic14.Import('PackageSourceDiscoverRequest')
export type PackageSourceDiscoverRequest = Static<typeof PackageSourceDiscoverRequest>
export const PagePackageLockEntry = RuntimePublic14.Import('PagePackageLockEntry')
export type PagePackageLockEntry = Page<PackageLockEntry>
export const PackageSourceDiscoverResult = RuntimePublic14.Import('PackageSourceDiscoverResult')
export type PackageSourceDiscoverResult = PagePackageLockEntry
export const PackageSourceResolveMetadataRequest = RuntimePublic14.Import('PackageSourceResolveMetadataRequest')
export type PackageSourceResolveMetadataRequest = Static<typeof PackageSourceResolveMetadataRequest>
export const PackageSourceResolveMetadataResult = RuntimePublic14.Import('PackageSourceResolveMetadataResult')
export type PackageSourceResolveMetadataResult = Static<typeof PackageSourceResolveMetadataResult>
export const PackageSourceFetchRequest = RuntimePublic14.Import('PackageSourceFetchRequest')
export type PackageSourceFetchRequest = Static<typeof PackageSourceFetchRequest>
export const PackageSourceFetchResult = RuntimePublic14.Import('PackageSourceFetchResult')
export type PackageSourceFetchResult = Static<typeof PackageSourceFetchResult>
export const PackageSourceRefreshCatalogRequest = RuntimePublic14.Import('PackageSourceRefreshCatalogRequest')
export type PackageSourceRefreshCatalogRequest = Static<typeof PackageSourceRefreshCatalogRequest>
export const PackageSourceRefreshCatalogResult = RuntimePublic14.Import('PackageSourceRefreshCatalogResult')
export type PackageSourceRefreshCatalogResult = Static<typeof PackageSourceRefreshCatalogResult>
export const PackageResolverResolveRequest = RuntimePublic14.Import('PackageResolverResolveRequest')
export type PackageResolverResolveRequest = Static<typeof PackageResolverResolveRequest>
export const PackageResolverResolveResult = RuntimePublic14.Import('PackageResolverResolveResult')
export type PackageResolverResolveResult = Static<typeof PackageResolverResolveResult>
export const PackageInstallerPrepareRequest = RuntimePublic14.Import('PackageInstallerPrepareRequest')
export type PackageInstallerPrepareRequest = Static<typeof PackageInstallerPrepareRequest>
export const PackageInstallerPrepareResult = RuntimePublic14.Import('PackageInstallerPrepareResult')
export type PackageInstallerPrepareResult = Static<typeof PackageInstallerPrepareResult>
export const PackageInstallerActivateRequest = RuntimePublic14.Import('PackageInstallerActivateRequest')
export type PackageInstallerActivateRequest = Static<typeof PackageInstallerActivateRequest>
export const PackageInstallerActivateResult = RuntimePublic14.Import('PackageInstallerActivateResult')
export type PackageInstallerActivateResult = Static<typeof PackageInstallerActivateResult>
export const PackageInstallerDisableRequest = RuntimePublic14.Import('PackageInstallerDisableRequest')
export type PackageInstallerDisableRequest = Static<typeof PackageInstallerDisableRequest>
export const PackageInstallerDisableResult = RuntimePublic14.Import('PackageInstallerDisableResult')
export type PackageInstallerDisableResult = Static<typeof PackageInstallerDisableResult>
export const PackageInstallerRepairRequest = RuntimePublic14.Import('PackageInstallerRepairRequest')
export type PackageInstallerRepairRequest = Static<typeof PackageInstallerRepairRequest>
export const PackageInstallerCancelProposalRequest = RuntimePublic14.Import('PackageInstallerCancelProposalRequest')
export type PackageInstallerCancelProposalRequest = Static<typeof PackageInstallerCancelProposalRequest>
export const PackageInstallerProposalStatusRequest = RuntimePublic14.Import('PackageInstallerProposalStatusRequest')
export type PackageInstallerProposalStatusRequest = Static<typeof PackageInstallerProposalStatusRequest>
export const PackageInstallerApplyResourceChangeRequest = RuntimePublic14.Import('PackageInstallerApplyResourceChangeRequest')
export type PackageInstallerApplyResourceChangeRequest = Static<typeof PackageInstallerApplyResourceChangeRequest>
export const PackageInstallerApplyResourceChangeResult = RuntimePublic14.Import('PackageInstallerApplyResourceChangeResult')
export type PackageInstallerApplyResourceChangeResult = Static<typeof PackageInstallerApplyResourceChangeResult>
export const ConfigReadRequest = RuntimePublic14.Import('ConfigReadRequest')
export type ConfigReadRequest = Static<typeof ConfigReadRequest>
export const ConfigReadResult = RuntimePublic14.Import('ConfigReadResult')
export type ConfigReadResult = Static<typeof ConfigReadResult>
export const AssemblyPlanRequest = RuntimePublic14.Import('AssemblyPlanRequest')
export type AssemblyPlanRequest = Static<typeof AssemblyPlanRequest>
export const AssemblyPrepareRequest = RuntimePublic14.Import('AssemblyPrepareRequest')
export type AssemblyPrepareRequest = Static<typeof AssemblyPrepareRequest>
