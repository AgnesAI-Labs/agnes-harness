// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const RuntimePublic10 = Type.Module({
  "Id": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
  "UInt53": Type.Integer({ minimum: 0, maximum: 9007199254740991 }),
  "Timestamp": Type.String({ pattern: "Z$", format: "date-time" }),
  "TypeId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[a-z][a-z0-9.-]*/[a-zA-Z0-9._/-]+@[1-9][0-9]*$" }),
  "Digest": Type.String({ pattern: "^[a-f0-9]{64}$" }),
  "SchemaRef": Type.Object({ "typeId": Type.Ref('TypeId'), "revision": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "BlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "DataRef": Type.Union([Type.Object({ "kind": Type.Literal('inline'), "schema": Type.Ref('SchemaRef'), "value": JsonValue, "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "schema": Type.Ref('SchemaRef'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "RetentionRef": Type.Object({ "kind": Type.Union([Type.Literal('blob'), Type.Literal('artifact'), Type.Literal('domain-record'), Type.Literal('package'), Type.Literal('schema'), Type.Literal('codec')]), "authorityId": Type.Ref('Id'), "resourceId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest'), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "BindingRef": Type.Object({ "bindingId": Type.Ref('Id'), "contract": Type.String(), "logicalName": Type.String(), "providerId": Type.Ref('Id') }, { additionalProperties: false }),
  "Provenance": Type.Object({ "sourceRefs": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "producer": Type.Ref('BindingRef'), "trustLabels": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }),
  "StateAuthorityRef": Type.Object({ "authorityId": Type.Ref('Id'), "tenantId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ScopeRef": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "kind": Type.Literal('installation') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "kind": Type.Literal('runtime') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('run') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('action'), "actionId": Type.Ref('Id') }, { additionalProperties: false })]),
  "DomainReference": Type.Object({ "authorityId": Type.Ref('Id'), "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53'), "schema": Type.Ref('SchemaRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "RequestIdentity": Type.Object({ "system": Type.String(), "aghRequestId": Type.Ref('Id'), "idempotencyKey": Type.Union([Type.String(), Type.Null()]), "requestDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ConversationAdmission": Type.Object({ "turnId": Type.Ref('Id'), "inputMessageId": Type.Ref('Id'), "inputRef": Type.Ref('DataRef'), "kind": Type.Union([Type.Literal('prompt'), Type.Literal('follow-up')]) }, { additionalProperties: false }),
  "Money": Type.Object({ "currency": Type.String(), "scale": Type.Literal(6), "units": Type.String() }, { additionalProperties: false }),
  "DomainEvent": Type.Object({ "eventId": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "schema": Type.Ref('SchemaRef'), "source": Type.Ref('BindingRef'), "scope": Type.Ref('ScopeRef'), "occurredAt": Type.Ref('Timestamp'), "payload": Type.Ref('DataRef'), "idempotencyKey": Type.String(), "causation": Type.Object({ "runId": Type.Optional(Type.Ref('Id')), "actionId": Type.Optional(Type.Ref('Id')), "attemptId": Type.Optional(Type.Ref('Id')), "commandId": Type.Optional(Type.Ref('Id')) }, { additionalProperties: false }), "principalRef": Type.Ref('Id'), "correlationId": Type.Union([Type.Ref('Id'), Type.Null()]), "provenance": Type.Ref('Provenance') }, { additionalProperties: false }),
  "Scope": Type.Union([Type.Literal('installation'), Type.Literal('runtime'), Type.Literal('workspace'), Type.Literal('session'), Type.Literal('run'), Type.Literal('action')]),
  "IsolationMode": Type.Union([Type.Literal('trusted-in-process'), Type.Literal('isolated-process'), Type.Literal('remote')]),
  "CapabilityRequirement": Type.Object({ "capability": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "resourceTypes": Type.Array(Type.Ref('TypeId'), { minItems: 0, maxItems: 64 }), "operations": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }) }, { additionalProperties: false }),
  "OperationDescriptor": Type.Object({ "method": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "kind": Type.Union([Type.Literal('query'), Type.Literal('action'), Type.Literal('control'), Type.Literal('compute'), Type.Literal('maintenance'), Type.Literal('observe'), Type.Literal('ingress')]), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 64 }), "retrySafety": Type.Union([Type.Literal('read-only'), Type.Literal('idempotent'), Type.Literal('reconcile-first'), Type.Literal('never')]) }, { additionalProperties: false }),
  "CommunityOwnerPackageId": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh(?:[./]|$))[^\\u0000-\\u001f\\u007f]+$" }),
  "CommunityContractRef": Type.Object({ "ownerPackageId": Type.Ref('CommunityOwnerPackageId'), "definitionDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ServiceRequirement": Type.Union([Type.Object({ "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)(?=^[^\\u0000-\\u001f\\u007f]+$)^agh\\." }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "features": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Ref('Scope'), "optional": Type.Boolean() }, { additionalProperties: false }), Type.Object({ "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)(?=(?=^[^\\u0000-\\u001f\\u007f]+$)^(?!agh\\.).*$)^(?!agh(?:[./]|$))[^\\u0000-\\u001f\\u007f]+/[a-z][a-z0-9-]*$" }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "features": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Union([Type.Literal('runtime'), Type.Literal('workspace'), Type.Literal('session'), Type.Literal('run'), Type.Literal('action')]), "optional": Type.Boolean(), "contractDefinition": Type.Ref('CommunityContractRef') }, { additionalProperties: false })]),
  "StateCodecRef": Type.Object({ "namespace": Type.Ref('Id'), "codecVersion": Type.Ref('Id'), "schema": Type.Ref('SchemaRef') }, { additionalProperties: false }),
  "ProviderDescriptor": Type.Union([Type.Object({ "providerId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)(?=^[^\\u0000-\\u001f\\u007f]+$)^agh\\." }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "packageVersion": Type.String({ maxLength: 128, pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$" }), "packageDigest": Type.String({ pattern: "^[a-f0-9]{64}$" }), "features": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Ref('Scope'), "configSchema": Type.Ref('SchemaRef'), "requires": Type.Array(Type.Ref('ServiceRequirement'), { minItems: 0, maxItems: 128 }), "capabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 128 }), "recovery": Type.Union([Type.Literal('R0'), Type.Literal('R1'), Type.Literal('R2')]), "isolation": Type.Array(Type.Union([Type.Literal('trusted-in-process'), Type.Literal('isolated-process'), Type.Literal('remote')]), { minItems: 1, maxItems: 3 }), "stateCodecs": Type.Array(Type.Ref('StateCodecRef'), { minItems: 0, maxItems: 64 }), "activationMode": Type.Union([Type.Literal('eager'), Type.Literal('lazy')]), "operations": Type.Array(Type.Ref('OperationDescriptor'), { minItems: 0, maxItems: 128 }) }, { additionalProperties: false }), Type.Object({ "providerId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)(?=(?=^[^\\u0000-\\u001f\\u007f]+$)^(?!agh\\.).*$)^(?!agh(?:[./]|$))[^\\u0000-\\u001f\\u007f]+/[a-z][a-z0-9-]*$" }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "packageVersion": Type.String({ maxLength: 128, pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$" }), "packageDigest": Type.String({ pattern: "^[a-f0-9]{64}$" }), "features": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Union([Type.Literal('runtime'), Type.Literal('workspace'), Type.Literal('session'), Type.Literal('run'), Type.Literal('action')]), "configSchema": Type.Ref('SchemaRef'), "requires": Type.Array(Type.Ref('ServiceRequirement'), { minItems: 0, maxItems: 128 }), "capabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 128 }), "recovery": Type.Union([Type.Literal('R0'), Type.Literal('R1'), Type.Literal('R2')]), "isolation": Type.Array(Type.Union([Type.Literal('trusted-in-process'), Type.Literal('isolated-process'), Type.Literal('remote')]), { minItems: 1, maxItems: 3 }), "stateCodecs": Type.Array(Type.Ref('StateCodecRef'), { minItems: 0, maxItems: 64 }), "activationMode": Type.Union([Type.Literal('eager'), Type.Literal('lazy')]), "operations": Type.Array(Type.Union([Type.Object({ "method": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "kind": Type.Union([Type.Literal('query'), Type.Literal('compute')]), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 64 }), "retrySafety": Type.Literal('read-only') }, { additionalProperties: false }), Type.Object({ "method": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "kind": Type.Literal('action'), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 64 }), "retrySafety": Type.Union([Type.Literal('read-only'), Type.Literal('idempotent'), Type.Literal('reconcile-first'), Type.Literal('never')]) }, { additionalProperties: false })]), { minItems: 1, maxItems: 128, uniqueItems: true }), "contractDefinition": Type.Ref('CommunityContractRef') }, { additionalProperties: false })]),
  "ExportRef": Type.Object({ "entry": Type.String({ minLength: 1, maxLength: 1024, pattern: "^\\./(?!\\.{1,2}(?:/|$))(?!.*\\/\\.{1,2}(?:/|$))(?!.*//)[^\\\\\\u0000-\\u001f]+$" }), "export": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }) }, { additionalProperties: false }),
  "ResourceRef": Type.Object({ "resourceId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ArtifactVersion": Type.Integer({ minimum: 1, maximum: 9007199254740991 }),
  "ArtifactRef": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion') }, { additionalProperties: false }),
  "Revision": Type.Ref('UInt53'),
  "DomainObjectRef": Type.Object({ "authorityId": Type.Ref('Id'), "typeId": Type.Ref('TypeId'), "id": Type.Ref('Id'), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "ModelFeatures": Type.Object({ "input": Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]), { maxItems: 10000 }), "output": Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]), { maxItems: 10000 }), "tools": Type.Boolean(), "structuredOutput": Type.Boolean(), "streaming": Type.Boolean() }, { additionalProperties: false }),
  "SecretConsumerBinding": Type.Object({ "consumer": Type.Union([Type.Literal('model'), Type.Literal('mcp'), Type.Literal('tls'), Type.Literal('jwt'), Type.Literal('source-auth'), Type.Literal('surface')]), "secretId": Type.Ref('Id'), "accountRef": Type.Union([Type.Ref('Id'), Type.Null()]), "serverRef": Type.Ref('Id'), "audience": Type.String(), "purpose": Type.String() }, { additionalProperties: false }),
  "ModelRouteSnapshot": Type.Object({ "routeId": Type.Ref('Id'), "routeRevision": Type.Ref('Revision'), "adapter": Type.Ref('BindingRef'), "model": Type.String(), "endpointRef": Type.Ref('Id'), "catalogRevision": Type.Ref('Revision'), "features": Type.Ref('ModelFeatures'), "priceVersion": Type.Ref('Id'), "credentialAudience": Type.String(), "credentialBinding": Type.Union([Type.Ref('SecretConsumerBinding'), Type.Null()]) }, { additionalProperties: false }),
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
  "FilePath": Type.String(),
  "SourceRange": Type.Object({ "session": Type.Ref('SessionRef'), "fromSeq": Type.Ref('UInt53'), "toSeq": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ExactQuantity": Type.Object({ "unit": Type.String(), "value": Type.String() }, { additionalProperties: false }),
  "SecretHandle": Type.Object({ "handleId": Type.Ref('Id'), "secretId": Type.Ref('Id'), "version": Type.String(), "audience": Type.String(), "expiresAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "ResourceLimits": Type.Object({ "cpuMs": Type.Ref('UInt53'), "wallMs": Type.Ref('UInt53'), "memoryBytes": Type.Ref('UInt53'), "outputBytes": Type.Ref('UInt53'), "processes": Type.Ref('UInt53'), "openFiles": Type.Ref('UInt53') }, { additionalProperties: false }),
  "UsageFactRef": Type.Object({ "authorityId": Type.Ref('Id'), "usageId": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "LeaseRef": Type.Object({ "authorityId": Type.Ref('Id'), "leaseId": Type.Ref('Id'), "epoch": Type.Ref('UInt53'), "expiresAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "MountRef": Type.Object({ "workspaceId": Type.Ref('Id'), "mountId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "lease": Type.Ref('LeaseRef') }, { additionalProperties: false }),
  "PackageLocator": Type.Union([Type.Object({ "kind": Type.Literal('local'), "sourceId": Type.Ref('Id'), "pathRef": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('npm'), "sourceId": Type.Ref('Id'), "name": Type.String(), "version": Type.String(), "integrity": Type.String(), "digest": Type.Ref('Digest') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('git'), "sourceId": Type.Ref('Id'), "repository": Type.String(), "commit": Type.String(), "subdirectory": Type.String(), "digest": Type.Ref('Digest') }, { additionalProperties: false })]),
  "ProviderBindingSnapshot": Type.Object({ "binding": Type.Ref('BindingRef'), "descriptor": Type.Ref('ProviderDescriptor'), "isolation": Type.Ref('IsolationMode'), "config": Type.Ref('DataRef'), "configDigest": Type.Ref('Digest'), "dependencies": Type.Array(Type.Ref('BindingRef'), { maxItems: 10000 }), "codecRefs": Type.Array(Type.Ref('StateCodecRef'), { maxItems: 10000 }), "schemaRefs": Type.Array(Type.Ref('SchemaRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ContributionExport": Type.Ref('ExportRef'),
  "Cursor": Type.String(),
  "ArtifactTitle": Object.assign(Type.String({ minLength: 1, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), {"x-max-utf8-bytes":1024}),
  "ArtifactMediaType": Object.assign(Type.String({ pattern: "^[a-z0-9][a-z0-9!#$&^_.+\\-]*/[a-z0-9][a-z0-9!#$&^_.+\\-]*$" }), {"x-max-utf8-bytes":255}),
  "TextPart": Type.Union([Type.Object({ "kind": Type.Literal('text'), "text": Type.String() }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('action'), "actionKey": Type.String(), "label": Type.String() }, { additionalProperties: false })]),
  "FormattedView": Type.Object({ "viewId": Type.String(), "revision": Type.Number(), "parts": Type.Array(Type.Ref('TextPart'), { maxItems: 10000 }), "complete": Type.Boolean(), "unsupportedRequiredFeatures": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }),
  "Ref": Type.Ref('PublicRef'),
  "BytesRef": Type.Ref('BlobRef'),
  "PageRequest": Type.Object({ "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ResourceFilter": Type.Object({ "namespace": Type.Optional(Type.String()), "tags": Type.Optional(Type.Array(Type.String(), { maxItems: 10000 })) }, { additionalProperties: false }),
  "RetrievalFilter": Type.Object({ "labels": Type.Optional(Type.Array(Type.String(), { maxItems: 10000 })), "after": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }),
  "VersionPrecondition": Type.Union([Type.Object({ "kind": Type.Literal('absent') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('exact'), "revision": Type.Ref('Revision') }, { additionalProperties: false })]),
  "ContextTarget": Type.Object({ "modelRoute": Type.Ref('Id'), "format": Type.String(), "tokenLimit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "CompactionPlan": Type.Object({ "planId": Type.Ref('Id'), "baseRevision": Type.Ref('Revision'), "inputDigest": Type.Ref('Digest'), "decision": Type.Union([Type.Literal('noop'), Type.Literal('compact')]), "reasonCodes": Type.Array(Type.String(), { maxItems: 10000 }), "algorithm": Type.Ref('BindingRef'), "privatePlan": Type.Ref('DataRef'), "outputCodec": Type.Ref('SchemaRef'), "preservedRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "sourceRanges": Type.Array(Type.Ref('SourceRange'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "CompactionResult": Type.Object({ "compactionId": Type.Ref('Id'), "viewRevision": Type.Ref('Revision'), "summaryRefs": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "expandedHistoryRef": Type.Ref('DomainObjectRef'), "preservedRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PreparedMedia": Type.Object({ "sourceRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "contentRefs": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "transformChain": Type.Array(Type.Object({ "actionId": Type.Ref('Id'), "transformSchema": Type.Ref('SchemaRef'), "inputDigest": Type.Ref('Digest'), "outputDigest": Type.Ref('Digest') }, { additionalProperties: false }), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "trust": Type.Union([Type.Literal('system'), Type.Literal('user'), Type.Literal('external'), Type.Literal('derived')]), "usageRefs": Type.Array(Type.Ref('UsageFactRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ResourceDescriptor": Type.Object({ "id": Type.Ref('Id'), "kind": Type.Union([Type.Literal('tool'), Type.Literal('skill'), Type.Literal('mcp'), Type.Literal('plugin'), Type.Literal('resource')]), "version": Type.String(), "digest": Type.Ref('Digest'), "namespace": Type.String(), "tags": Type.Array(Type.String(), { maxItems: 10000 }), "inputSchema": Type.Union([Type.Ref('SchemaRef'), Type.Null()]), "outputSchema": Type.Union([Type.Ref('SchemaRef'), Type.Null()]), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { maxItems: 10000 }), "sourceRef": Type.Ref('PublicRef'), "trust": Type.Union([Type.Literal('system'), Type.Literal('user'), Type.Literal('external'), Type.Literal('derived')]), "ownerBinding": Type.Ref('BindingRef'), "definition": Type.Ref('DataRef') }, { additionalProperties: false }),
  "FileRange": Type.Object({ "offset": Type.Ref('UInt53'), "length": Type.Ref('UInt53') }, { additionalProperties: false }),
  "FileEntry": Type.Object({ "path": Type.Ref('FilePath'), "kind": Type.Union([Type.Literal('file'), Type.Literal('directory'), Type.Literal('symlink')]), "bytes": Type.Union([Type.Ref('UInt53'), Type.Null()]), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "SandboxRef": Type.Object({ "authorityId": Type.Ref('Id'), "sandboxId": Type.Ref('Id'), "ownerBinding": Type.Ref('BindingRef'), "lease": Type.Ref('LeaseRef') }, { additionalProperties: false }),
  "SandboxState": Type.Union([Type.Literal('creating'), Type.Literal('ready'), Type.Literal('stopping'), Type.Literal('stopped'), Type.Literal('lost')]),
  "ExecutionRef": Type.Object({ "authorityId": Type.Ref('Id'), "executionId": Type.Ref('Id'), "requestIdentity": Type.Ref('RequestIdentity') }, { additionalProperties: false }),
  "ExecRequest": Type.Object({ "sandboxRef": Type.Ref('SandboxRef'), "argv": Type.Array(Type.String(), { maxItems: 10000 }), "cwd": Type.Object({ "mount": Type.Ref('MountRef'), "path": Type.Ref('FilePath') }, { additionalProperties: false }), "env": Type.Array(Type.Object({ "name": Type.String(), "value": Type.Union([Type.Object({ "kind": Type.Literal('literal'), "value": Type.String() }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('secret'), "handle": Type.Ref('SecretHandle') }, { additionalProperties: false })]) }, { additionalProperties: false }), { maxItems: 10000 }), "stdinRef": Type.Union([Type.Ref('BytesRef'), Type.Null()]), "limits": Type.Ref('ResourceLimits') }, { additionalProperties: false }),
  "ExecResult": Type.Object({ "executionRef": Type.Ref('ExecutionRef'), "state": Type.Union([Type.Literal('exited'), Type.Literal('terminated'), Type.Literal('unknown')]), "exitCode": Type.Union([Type.Number(), Type.Null()]), "signal": Type.Union([Type.String(), Type.Null()]), "stdoutRef": Type.Union([Type.Ref('BytesRef'), Type.Null()]), "stderrRef": Type.Union([Type.Ref('BytesRef'), Type.Null()]), "outputTruncated": Type.Boolean(), "effectStatus": Type.Union([Type.Literal('confirmed'), Type.Literal('unknown')]) }, { additionalProperties: false }),
  "NetworkTarget": Type.Object({ "targetId": Type.Ref('Id'), "scheme": Type.Union([Type.Literal('http'), Type.Literal('https')]), "host": Type.String(), "port": Type.Ref('UInt53'), "path": Type.String() }, { additionalProperties: false }),
  "NetworkRequest": Type.Object({ "target": Type.Ref('NetworkTarget'), "method": Type.Union([Type.Literal('GET'), Type.Literal('HEAD'), Type.Literal('POST'), Type.Literal('PUT'), Type.Literal('PATCH'), Type.Literal('DELETE'), Type.Literal('OPTIONS')]), "headers": Type.Ref('DataRef'), "bodyRef": Type.Union([Type.Ref('BytesRef'), Type.Null()]), "redirect": Type.Object({ "mode": Type.Union([Type.Literal('deny'), Type.Literal('revalidate')]), "maxHops": Type.Ref('UInt53') }, { additionalProperties: false }), "maxBytes": Type.Ref('UInt53') }, { additionalProperties: false }),
  "EffectPermit": Type.Object({ "permitId": Type.Ref('Id'), "action": Type.Object({ "run": Type.Ref('RunRef'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "attemptId": Type.Ref('Id'), "binding": Type.Ref('BindingRef'), "intentFingerprint": Type.Ref('Digest'), "principalRef": Type.Ref('Id'), "scope": Type.Ref('ScopeRef'), "policyDecisionRef": Type.Ref('ReceiptPointer'), "policyRevision": Type.Ref('Revision'), "budgetReservation": Type.Union([Type.Ref('DomainObjectRef'), Type.Null()]), "quotaReservation": Type.Ref('DomainObjectRef'), "authorityEpoch": Type.Ref('UInt53'), "writerEpoch": Type.Ref('UInt53'), "validUntil": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "QuotaReservation": Type.Object({ "ref": Type.Ref('DomainObjectRef'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "scopeIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "dimensions": Type.Array(Type.Object({ "name": Type.Union([Type.Literal('parallel-action'), Type.Literal('live-agent')]), "amount": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }), "status": Type.Union([Type.Literal('held'), Type.Literal('released')]), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "NewRunSpec": Type.Object({ "presetRef": Type.Ref('Id'), "inputRef": Type.Ref('DataRef'), "idempotencyKey": Type.Ref('Id'), "conversation": Type.Optional(Type.Ref('ConversationAdmission')) }, { additionalProperties: false }),
  "ScheduleTarget": Type.Union([Type.Object({ "kind": Type.Literal('existing'), "run": Type.Ref('RunRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('new'), "spec": Type.Ref('NewRunSpec') }, { additionalProperties: false })]),
  "SchedulerDelivery": Type.Object({ "deliveryId": Type.Ref('Id'), "target": Type.Ref('ScheduleTarget'), "inputRef": Type.Ref('DataRef'), "priority": Type.Union([Type.Literal('interactive'), Type.Literal('background')]), "notBefore": Type.Ref('Timestamp'), "state": Type.Union([Type.Literal('queued'), Type.Literal('claimed'), Type.Literal('acked'), Type.Literal('cancelled')]), "claim": Type.Union([Type.Null(), Type.Object({ "workerId": Type.Ref('Id'), "epoch": Type.Ref('UInt53'), "expiresAt": Type.Ref('Timestamp'), "bindingId": Type.Ref('Id'), "ticketId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false })]), "revision": Type.Ref('Revision'), "outcomeRef": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]) }, { additionalProperties: false }),
  "JobTarget": Type.Union([Type.Object({ "kind": Type.Literal('pin'), "releaseSetId": Type.Ref('Id'), "bindingId": Type.Ref('Id'), "presetRef": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('follow'), "routeId": Type.Ref('Id'), "presetRef": Type.Ref('Id') }, { additionalProperties: false })]),
  "JobSchedule": Type.Union([Type.Object({ "kind": Type.Literal('once'), "at": Type.Ref('Timestamp') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('rrule'), "rrule": Type.String(), "timezone": Type.String(), "startsAt": Type.Ref('Timestamp'), "ambiguousLocalTime": Type.Union([Type.Literal('earlier'), Type.Literal('later')]), "nonexistentLocalTime": Type.Union([Type.Literal('skip'), Type.Literal('next-valid')]) }, { additionalProperties: false })]),
  "JobPolicy": Type.Object({ "missed": Type.Union([Type.Literal('skip'), Type.Literal('latest'), Type.Literal('catch-up')]), "maxCatchUp": Type.Ref('UInt53'), "concurrency": Type.Union([Type.Literal('forbid'), Type.Literal('queue'), Type.Literal('parallel')]), "maxConcurrent": Type.Ref('UInt53'), "maxAttempts": Type.Ref('UInt53'), "retryDelayMs": Type.Ref('UInt53'), "retryMaxDelayMs": Type.Ref('UInt53') }, { additionalProperties: false }),
  "JobDefinition": Type.Object({ "definitionId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "status": Type.Union([Type.Literal('active'), Type.Literal('paused'), Type.Literal('cancelled')]), "schedule": Type.Ref('JobSchedule'), "policy": Type.Ref('JobPolicy'), "target": Type.Ref('JobTarget'), "inputRef": Type.Ref('DataRef'), "budgetAccount": Type.Ref('DomainObjectRef'), "ownerPrincipalRef": Type.Ref('Id'), "nextDueAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "protected": Type.Boolean() }, { additionalProperties: false }),
  "JobOccurrence": Type.Object({ "occurrenceId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "definitionId": Type.Ref('Id'), "definitionRevision": Type.Ref('Revision'), "scheduledAt": Type.Ref('Timestamp'), "attempt": Type.Ref('UInt53'), "state": Type.Union([Type.Literal('pending'), Type.Literal('claimed'), Type.Literal('running'), Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled')]), "bindingId": Type.Union([Type.Ref('Id'), Type.Null()]), "releaseSetId": Type.Union([Type.Ref('Id'), Type.Null()]), "ticketId": Type.Union([Type.Ref('Id'), Type.Null()]), "runId": Type.Union([Type.Ref('Id'), Type.Null()]), "claim": Type.Union([Type.Ref('LeaseRef'), Type.Null()]), "nextAttemptAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "outcomeRef": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]) }, { additionalProperties: false }),
  "JobEdit": Type.Object({ "schedule": Type.Optional(Type.Ref('JobSchedule')), "policy": Type.Optional(Type.Ref('JobPolicy')), "target": Type.Optional(Type.Ref('JobTarget')), "inputRef": Type.Optional(Type.Ref('DataRef')), "budgetAccount": Type.Optional(Type.Ref('DomainObjectRef')), "status": Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('paused')])) }, { additionalProperties: false }),
  "DetachedAcceptance": Type.Object({ "acceptanceId": Type.Ref('Id'), "jobId": Type.Ref('Id'), "authorityId": Type.Ref('Id'), "fingerprint": Type.Ref('Digest'), "sourceRun": Type.Ref('RunRef'), "sourceParentActionId": Type.Union([Type.Ref('Id'), Type.Null()]), "sourceActionKey": Type.String(), "inputDigest": Type.Ref('Digest'), "providerBinding": Type.Ref('BindingRef'), "budgetScope": Type.Ref('DomainObjectRef'), "cancellationOwner": Type.Ref('DomainObjectRef'), "state": Type.Union([Type.Literal('reserved'), Type.Literal('attached'), Type.Literal('cancelled')]), "revision": Type.Ref('Revision') }, { additionalProperties: false }),
  "MemoryItem": Type.Object({ "ref": Type.Ref('DomainObjectRef'), "contentRef": Type.Ref('DataRef'), "sourceRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }), "provenance": Type.Ref('Provenance'), "trust": Type.Union([Type.Literal('system'), Type.Literal('user'), Type.Literal('external'), Type.Literal('derived')]), "labels": Type.Array(Type.String(), { maxItems: 10000 }), "ownerPrincipalRef": Type.Ref('Id'), "expiresAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "status": Type.Union([Type.Literal('active'), Type.Literal('deleted')]) }, { additionalProperties: false }),
  "DeletionReceipt": Type.Object({ "deletionId": Type.Ref('Id'), "authorityId": Type.Ref('Id'), "watermark": Type.Ref('UInt53'), "invalidatedRefs": Type.Array(Type.Ref('PublicRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "RetrievalHit": Type.Object({ "ref": Type.Ref('PublicRef'), "score": Type.Number(), "source": Type.Ref('Provenance'), "trust": Type.Union([Type.Literal('system'), Type.Literal('user'), Type.Literal('external'), Type.Literal('derived')]) }, { additionalProperties: false }),
  "BudgetReservation": Type.Object({ "ref": Type.Ref('DomainObjectRef'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "accountRef": Type.Ref('DomainObjectRef'), "parentReservationRef": Type.Union([Type.Ref('DomainObjectRef'), Type.Null()]), "scopeIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "unitsByKind": Type.Array(Type.Ref('ExactQuantity'), { maxItems: 10000 }), "held": Type.Union([Type.Ref('Money'), Type.Null()]), "priceVersion": Type.Union([Type.Ref('Id'), Type.Null()]), "status": Type.Union([Type.Literal('held'), Type.Literal('settling'), Type.Literal('settled'), Type.Literal('released'), Type.Literal('unknown')]), "revision": Type.Ref('Revision'), "expiresAt": Type.Ref('Timestamp'), "settledAmount": Type.Union([Type.Ref('Money'), Type.Null()]), "usageRefs": Type.Array(Type.Ref('UsageFactRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "UsageMeasurement": Type.Object({ "kind": Type.Union([Type.Literal('reported'), Type.Literal('estimated'), Type.Literal('corrected'), Type.Literal('unknown')]), "quantities": Type.Array(Type.Ref('ExactQuantity'), { maxItems: 10000 }), "actualModel": Type.Union([Type.String(), Type.Null()]), "source": Type.Union([Type.Literal('provider-receipt'), Type.Literal('adapter-counter'), Type.Literal('reported-target'), Type.Literal('estimator')]), "sourceReceipt": Type.Union([Type.Ref('DataRef'), Type.Null()]), "replacesFactIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "BillingEntry": Type.Object({ "entryId": Type.Ref('Id'), "accountRef": Type.Ref('DomainObjectRef'), "chargeKey": Type.Ref('Id'), "kind": Type.Union([Type.Literal('charge'), Type.Literal('refund')]), "amount": Type.Ref('Money'), "quoteRef": Type.Ref('DataRef'), "usageRefs": Type.Array(Type.Ref('UsageFactRef'), { maxItems: 10000 }), "reversesEntryId": Type.Union([Type.Ref('Id'), Type.Null()]), "status": Type.Union([Type.Literal('pending'), Type.Literal('posted'), Type.Literal('unknown'), Type.Literal('rejected')]), "externalRequestId": Type.Union([Type.Ref('Id'), Type.Null()]), "paymentReceipt": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "UploadRef": Type.Object({ "authorityId": Type.Ref('Id'), "uploadId": Type.Ref('Id'), "reservationId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "status": Type.Literal('sealed') }, { additionalProperties: false }),
  "UploadResult": Type.Object({ "upload": Type.Ref('UploadRef'), "retention": Type.Ref('RetentionRef') }, { additionalProperties: false }),
  "ArtifactSource": Type.Union([Type.Object({ "kind": Type.Literal('upload'), "upload": Type.Ref('UploadRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "ArtifactReservation": Type.Union([Type.Object({ "publicationId": Type.Ref('Id'), "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "revision": Type.Ref('Revision'), "schema": Type.Ref('SchemaRef'), "kind": Type.Ref('TypeId'), "title": Type.Union([Type.Ref('ArtifactTitle'), Type.Null()]), "mediaType": Type.Union([Type.Ref('ArtifactMediaType'), Type.Null()]), "ownerAction": Type.Object({ "run": Type.Ref('RunRef'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "state": Type.Literal('reserved'), "source": Type.Null(), "pinId": Type.Null(), "failureRef": Type.Null(), "blob": Type.Null() }, { additionalProperties: false }), Type.Object({ "publicationId": Type.Ref('Id'), "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "revision": Type.Ref('Revision'), "schema": Type.Ref('SchemaRef'), "kind": Type.Ref('TypeId'), "title": Type.Ref('ArtifactTitle'), "mediaType": Type.Ref('ArtifactMediaType'), "ownerAction": Type.Object({ "run": Type.Ref('RunRef'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "state": Type.Literal('pending-publish'), "source": Type.Ref('ArtifactSource'), "pinId": Type.Union([Type.Ref('Id'), Type.Null()]), "failureRef": Type.Null(), "blob": Type.Union([Type.Ref('BlobRef'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "publicationId": Type.Ref('Id'), "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "revision": Type.Ref('Revision'), "schema": Type.Ref('SchemaRef'), "kind": Type.Ref('TypeId'), "title": Type.Ref('ArtifactTitle'), "mediaType": Type.Ref('ArtifactMediaType'), "ownerAction": Type.Object({ "run": Type.Ref('RunRef'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "state": Type.Literal('ready'), "source": Type.Ref('ArtifactSource'), "pinId": Type.Ref('Id'), "failureRef": Type.Null(), "blob": Type.Ref('BlobRef') }, { additionalProperties: false }), Type.Object({ "publicationId": Type.Ref('Id'), "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "revision": Type.Ref('Revision'), "schema": Type.Ref('SchemaRef'), "kind": Type.Ref('TypeId'), "title": Type.Union([Type.Ref('ArtifactTitle'), Type.Null()]), "mediaType": Type.Union([Type.Ref('ArtifactMediaType'), Type.Null()]), "ownerAction": Type.Object({ "run": Type.Ref('RunRef'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "state": Type.Literal('failed'), "source": Type.Union([Type.Ref('ArtifactSource'), Type.Null()]), "pinId": Type.Union([Type.Ref('Id'), Type.Null()]), "failureRef": Type.Ref('ReceiptPointer'), "blob": Type.Union([Type.Ref('BlobRef'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "publicationId": Type.Ref('Id'), "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "revision": Type.Ref('Revision'), "schema": Type.Ref('SchemaRef'), "kind": Type.Ref('TypeId'), "title": Type.Union([Type.Ref('ArtifactTitle'), Type.Null()]), "mediaType": Type.Union([Type.Ref('ArtifactMediaType'), Type.Null()]), "ownerAction": Type.Object({ "run": Type.Ref('RunRef'), "actionId": Type.Ref('Id') }, { additionalProperties: false }), "state": Type.Literal('revoked'), "source": Type.Union([Type.Ref('ArtifactSource'), Type.Null()]), "pinId": Type.Union([Type.Ref('Id'), Type.Null()]), "failureRef": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]), "blob": Type.Union([Type.Ref('BlobRef'), Type.Null()]) }, { additionalProperties: false })]),
  "DomainEventRecord": Type.Object({ "event": Type.Ref('DomainEvent'), "authorityId": Type.Ref('Id'), "sequence": Type.Ref('UInt53'), "aggregate": Type.Ref('DomainObjectRef'), "fingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "AuditAppend": Type.Object({ "subjectRef": Type.Ref('PublicRef'), "operation": Type.String(), "outcomeRef": Type.Ref('ReceiptPointer'), "causationRef": Type.Ref('PublicRef'), "redactedPayloadRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "TraceSpan": Type.Object({ "traceId": Type.Ref('Id'), "spanId": Type.Ref('Id'), "parentSpanId": Type.Union([Type.Ref('Id'), Type.Null()]), "name": Type.String(), "startedAt": Type.Ref('Timestamp'), "endedAt": Type.Ref('Timestamp'), "attributes": Type.Ref('DataRef'), "outcome": Type.Union([Type.Literal('ok'), Type.Literal('error'), Type.Literal('cancelled'), Type.Literal('unknown')]) }, { additionalProperties: false }),
  "PackageRequirement": Type.Object({ "packageId": Type.Ref('Id'), "versionRange": Type.String(), "sourceIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PackageLockEntry": Type.Object({ "packageId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest'), "locator": Type.Ref('PackageLocator'), "manifestRef": Type.Ref('DataRef'), "dependencies": Type.Array(Type.Object({ "packageId": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "PackageLock": Type.Object({ "entries": Type.Array(Type.Ref('PackageLockEntry'), { maxItems: 10000 }), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "Readiness": Type.Object({ "state": Type.Union([Type.Literal('ready'), Type.Literal('blocked')]), "required": Type.Array(Type.Object({ "contributionId": Type.Ref('Id'), "ready": Type.Boolean(), "diagnosticIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "AssemblyGraph": Type.Object({ "graphId": Type.Ref('Id'), "configRef": Type.Ref('DataRef'), "lock": Type.Ref('PackageLock'), "bindings": Type.Array(Type.Ref('ProviderBindingSnapshot'), { maxItems: 10000 }), "dependencies": Type.Array(Type.Object({ "consumerId": Type.Ref('Id'), "dependencyId": Type.Ref('Id'), "optional": Type.Boolean() }, { additionalProperties: false }), { maxItems: 10000 }), "requiredContributions": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ChannelDestination": Type.Object({ "channelId": Type.Ref('Id'), "accountId": Type.Ref('Id'), "conversationId": Type.Ref('Id'), "threadId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "ChannelArtifactAttachment": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('UInt53'), "disposition": Type.Literal('attachment') }, { additionalProperties: false }),
  "ChannelMessage": Type.Object({ "messageId": Type.Ref('Id'), "destination": Type.Ref('ChannelDestination'), "viewId": Type.Ref('Id'), "viewRevision": Type.Ref('Revision'), "content": Type.Ref('FormattedView'), "interaction": Type.Union([Type.Null(), Type.Object({ "interactionId": Type.Ref('Id'), "version": Type.Ref('Revision') }, { additionalProperties: false })]), "partIndex": Type.Ref('UInt53'), "partCount": Type.Ref('UInt53'), "fullContentDigest": Type.Ref('Digest'), "attachments": Type.Optional(Type.Array(Type.Ref('ChannelArtifactAttachment'), { maxItems: 32, uniqueItems: true })) }, { additionalProperties: false }),
  "ChannelDelivery": Type.Object({ "messageId": Type.Ref('Id'), "destination": Type.Ref('ChannelDestination'), "state": Type.Union([Type.Literal('accepted'), Type.Literal('delivered'), Type.Literal('failed'), Type.Literal('unknown')]), "remoteMessageId": Type.Union([Type.Ref('Id'), Type.Null()]), "receipt": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }),
  "AuthenticatedCallback": Type.Object({ "callbackId": Type.Ref('Id'), "channelId": Type.Ref('Id'), "remoteEventId": Type.Ref('Id'), "actorPrincipalRef": Type.Ref('Id'), "destination": Type.Ref('ChannelDestination'), "receivedAt": Type.Ref('Timestamp'), "credentialRevision": Type.Ref('Revision'), "verifiedEnvelopeDigest": Type.Ref('Digest'), "command": Type.Union([Type.Object({ "kind": Type.Literal('interaction'), "interactionId": Type.Ref('Id'), "expectedVersion": Type.Ref('Revision'), "responseId": Type.Ref('Id'), "answer": Type.Ref('DataRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('domain'), "command": Type.Ref('DataRef') }, { additionalProperties: false })]) }, { additionalProperties: false }),
  "EmptyAuthorConfig": Type.Object({  }, { additionalProperties: false }),
  "ToolContribution": Type.Object({ "kind": Type.Literal('tool'), "id": Type.String(), "implementation": Type.Ref('ContributionExport') }, { additionalProperties: false }),
  "RoutingContribution": Type.Object({ "kind": Type.Literal('routing'), "id": Type.String(), "implementation": Type.Ref('ContributionExport') }, { additionalProperties: false }),
  "ArtifactContribution": Type.Object({ "kind": Type.Literal('artifact-tool'), "id": Type.String(), "implementation": Type.Ref('ContributionExport') }, { additionalProperties: false }),
  "WorkflowContribution": Type.Object({ "kind": Type.Literal('workflow'), "id": Type.String(), "implementation": Type.Ref('ContributionExport') }, { additionalProperties: false }),
  "ObserverContribution": Type.Object({ "kind": Type.Literal('observer'), "id": Type.String(), "implementation": Type.Ref('ContributionExport') }, { additionalProperties: false }),
  "RendererContribution": Type.Object({ "kind": Type.Literal('renderer'), "id": Type.String(), "implementation": Type.Ref('ContributionExport') }, { additionalProperties: false }),
  "InterceptorContribution": Type.Object({ "kind": Type.Literal('interceptor'), "id": Type.String(), "implementation": Type.Ref('ContributionExport') }, { additionalProperties: false }),
  "AuthorContribution": Type.Union([Type.Ref('ToolContribution'), Type.Ref('RoutingContribution'), Type.Ref('ArtifactContribution'), Type.Ref('WorkflowContribution'), Type.Ref('ObserverContribution'), Type.Ref('RendererContribution'), Type.Ref('InterceptorContribution')]),
  "StandardToolOutput": Type.Object({ "content": Type.Array(Type.Object({ "type": Type.Literal('text'), "text": Type.String() }, { additionalProperties: false }), { maxItems: 10000 }), "structured": Type.Optional(JsonValue) }, { additionalProperties: false }),
  "RoutingSelectInput": Type.Object({ "purpose": Type.String(), "requiredFeatures": Type.Ref('ModelFeatures'), "allowedRoutes": Type.Array(Type.Ref('ModelRouteSnapshot'), { maxItems: 10000 }), "catalogRevision": Type.Ref('Revision'), "budgetSnapshot": Type.Ref('DataRef'), "inputMeta": Type.Ref('DataRef') }, { additionalProperties: false }),
  "RoutingSelectResult": Type.Object({ "route": Type.Ref('ModelRouteSnapshot'), "reason": Type.String() }, { additionalProperties: false }),
  "EffectPortsInvokeRequest": Type.Object({ "operation": Type.String(), "input": Type.Ref('DataRef') }, { additionalProperties: false }),
})

export const Id = RuntimePublic10.Import('Id')
export type Id = Static<typeof Id>
export const UInt53 = RuntimePublic10.Import('UInt53')
export type UInt53 = Static<typeof UInt53>
export const Timestamp = RuntimePublic10.Import('Timestamp')
export type Timestamp = Static<typeof Timestamp>
export const TypeId = RuntimePublic10.Import('TypeId')
export type TypeId = Static<typeof TypeId>
export const Digest = RuntimePublic10.Import('Digest')
export type Digest = Static<typeof Digest>
export const SchemaRef = RuntimePublic10.Import('SchemaRef')
export type SchemaRef = Static<typeof SchemaRef>
export const BlobRef = RuntimePublic10.Import('BlobRef')
export type BlobRef = Static<typeof BlobRef>
export const DataRef = RuntimePublic10.Import('DataRef')
export type DataRef = Static<typeof DataRef>
export const RetentionRef = RuntimePublic10.Import('RetentionRef')
export type RetentionRef = Static<typeof RetentionRef>
export const BindingRef = RuntimePublic10.Import('BindingRef')
export type BindingRef = Static<typeof BindingRef>
export const Provenance = RuntimePublic10.Import('Provenance')
export type Provenance = Static<typeof Provenance>
export const StateAuthorityRef = RuntimePublic10.Import('StateAuthorityRef')
export type StateAuthorityRef = Static<typeof StateAuthorityRef>
export const ScopeRef = RuntimePublic10.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const DomainReference = RuntimePublic10.Import('DomainReference')
export type DomainReference = Static<typeof DomainReference>
export const RequestIdentity = RuntimePublic10.Import('RequestIdentity')
export type RequestIdentity = Static<typeof RequestIdentity>
export const ConversationAdmission = RuntimePublic10.Import('ConversationAdmission')
export type ConversationAdmission = Static<typeof ConversationAdmission>
export const Money = RuntimePublic10.Import('Money')
export type Money = Static<typeof Money>
export const DomainEvent = RuntimePublic10.Import('DomainEvent')
export type DomainEvent = Static<typeof DomainEvent>
export const Scope = RuntimePublic10.Import('Scope')
export type Scope = Static<typeof Scope>
export const IsolationMode = RuntimePublic10.Import('IsolationMode')
export type IsolationMode = Static<typeof IsolationMode>
export const CapabilityRequirement = RuntimePublic10.Import('CapabilityRequirement')
export type CapabilityRequirement = Static<typeof CapabilityRequirement>
export const OperationDescriptor = RuntimePublic10.Import('OperationDescriptor')
export type OperationDescriptor = Static<typeof OperationDescriptor>
export const CommunityOwnerPackageId = RuntimePublic10.Import('CommunityOwnerPackageId')
export type CommunityOwnerPackageId = Static<typeof CommunityOwnerPackageId>
export const CommunityContractRef = RuntimePublic10.Import('CommunityContractRef')
export type CommunityContractRef = Static<typeof CommunityContractRef>
export const ServiceRequirement = RuntimePublic10.Import('ServiceRequirement')
export type ServiceRequirement = Static<typeof ServiceRequirement>
export const StateCodecRef = RuntimePublic10.Import('StateCodecRef')
export type StateCodecRef = Static<typeof StateCodecRef>
export const ProviderDescriptor = RuntimePublic10.Import('ProviderDescriptor')
export type ProviderDescriptor = Static<typeof ProviderDescriptor>
export const ExportRef = RuntimePublic10.Import('ExportRef')
export type ExportRef = Static<typeof ExportRef>
export const ResourceRef = RuntimePublic10.Import('ResourceRef')
export type ResourceRef = Static<typeof ResourceRef>
export const ArtifactVersion = RuntimePublic10.Import('ArtifactVersion')
export type ArtifactVersion = Static<typeof ArtifactVersion>
export const ArtifactRef = RuntimePublic10.Import('ArtifactRef')
export type ArtifactRef = Static<typeof ArtifactRef>
export const Revision = RuntimePublic10.Import('Revision')
export type Revision = Static<typeof Revision>
export const DomainObjectRef = RuntimePublic10.Import('DomainObjectRef')
export type DomainObjectRef = Static<typeof DomainObjectRef>
export const ModelFeatures = RuntimePublic10.Import('ModelFeatures')
export type ModelFeatures = Static<typeof ModelFeatures>
export const SecretConsumerBinding = RuntimePublic10.Import('SecretConsumerBinding')
export type SecretConsumerBinding = Static<typeof SecretConsumerBinding>
export const ModelRouteSnapshot = RuntimePublic10.Import('ModelRouteSnapshot')
export type ModelRouteSnapshot = Static<typeof ModelRouteSnapshot>
export const SessionRef = RuntimePublic10.Import('SessionRef')
export type SessionRef = Static<typeof SessionRef>
export const RunRef = RuntimePublic10.Import('RunRef')
export type RunRef = Static<typeof RunRef>
export const InteractionRef = RuntimePublic10.Import('InteractionRef')
export type InteractionRef = Static<typeof InteractionRef>
export const PublicBlobReference = RuntimePublic10.Import('PublicBlobReference')
export type PublicBlobReference = Static<typeof PublicBlobReference>
export const UploadSession = RuntimePublic10.Import('UploadSession')
export type UploadSession = Static<typeof UploadSession>
export const PublicUploadReference = RuntimePublic10.Import('PublicUploadReference')
export type PublicUploadReference = Static<typeof PublicUploadReference>
export const StagedBlobRef = RuntimePublic10.Import('StagedBlobRef')
export type StagedBlobRef = Static<typeof StagedBlobRef>
export const PublicStagedBlobReference = RuntimePublic10.Import('PublicStagedBlobReference')
export type PublicStagedBlobReference = Static<typeof PublicStagedBlobReference>
export const PublicRef = RuntimePublic10.Import('PublicRef')
export type PublicRef = Static<typeof PublicRef>
export const ReceiptPointer = RuntimePublic10.Import('ReceiptPointer')
export type ReceiptPointer = Static<typeof ReceiptPointer>
export const FilePath = RuntimePublic10.Import('FilePath')
export type FilePath = Static<typeof FilePath>
export const SourceRange = RuntimePublic10.Import('SourceRange')
export type SourceRange = Static<typeof SourceRange>
export const ExactQuantity = RuntimePublic10.Import('ExactQuantity')
export type ExactQuantity = Static<typeof ExactQuantity>
export const SecretHandle = RuntimePublic10.Import('SecretHandle')
export type SecretHandle = Static<typeof SecretHandle>
export const ResourceLimits = RuntimePublic10.Import('ResourceLimits')
export type ResourceLimits = Static<typeof ResourceLimits>
export const UsageFactRef = RuntimePublic10.Import('UsageFactRef')
export type UsageFactRef = Static<typeof UsageFactRef>
export const LeaseRef = RuntimePublic10.Import('LeaseRef')
export type LeaseRef = Static<typeof LeaseRef>
export const MountRef = RuntimePublic10.Import('MountRef')
export type MountRef = Static<typeof MountRef>
export const PackageLocator = RuntimePublic10.Import('PackageLocator')
export type PackageLocator = Static<typeof PackageLocator>
export const ProviderBindingSnapshot = RuntimePublic10.Import('ProviderBindingSnapshot')
export type ProviderBindingSnapshot = Static<typeof ProviderBindingSnapshot>
export const ContributionExport = RuntimePublic10.Import('ContributionExport')
export type ContributionExport = Static<typeof ContributionExport>
export const Cursor = RuntimePublic10.Import('Cursor')
export type Cursor = Static<typeof Cursor>
export const ArtifactTitle = RuntimePublic10.Import('ArtifactTitle')
export type ArtifactTitle = Static<typeof ArtifactTitle>
export const ArtifactMediaType = RuntimePublic10.Import('ArtifactMediaType')
export type ArtifactMediaType = Static<typeof ArtifactMediaType>
export const TextPart = RuntimePublic10.Import('TextPart')
export type TextPart = Static<typeof TextPart>
export const FormattedView = RuntimePublic10.Import('FormattedView')
export type FormattedView = Static<typeof FormattedView>
export const Ref = RuntimePublic10.Import('Ref')
export type Ref = Static<typeof Ref>
export const BytesRef = RuntimePublic10.Import('BytesRef')
export type BytesRef = Static<typeof BytesRef>
export const PageRequest = RuntimePublic10.Import('PageRequest')
export type PageRequest = Static<typeof PageRequest>
export const ResourceFilter = RuntimePublic10.Import('ResourceFilter')
export type ResourceFilter = Static<typeof ResourceFilter>
export const RetrievalFilter = RuntimePublic10.Import('RetrievalFilter')
export type RetrievalFilter = Static<typeof RetrievalFilter>
export const VersionPrecondition = RuntimePublic10.Import('VersionPrecondition')
export type VersionPrecondition = Static<typeof VersionPrecondition>
export const ContextTarget = RuntimePublic10.Import('ContextTarget')
export type ContextTarget = Static<typeof ContextTarget>
export const CompactionPlan = RuntimePublic10.Import('CompactionPlan')
export type CompactionPlan = Static<typeof CompactionPlan>
export const CompactionResult = RuntimePublic10.Import('CompactionResult')
export type CompactionResult = Static<typeof CompactionResult>
export const PreparedMedia = RuntimePublic10.Import('PreparedMedia')
export type PreparedMedia = Static<typeof PreparedMedia>
export const ResourceDescriptor = RuntimePublic10.Import('ResourceDescriptor')
export type ResourceDescriptor = Static<typeof ResourceDescriptor>
export const FileRange = RuntimePublic10.Import('FileRange')
export type FileRange = Static<typeof FileRange>
export const FileEntry = RuntimePublic10.Import('FileEntry')
export type FileEntry = Static<typeof FileEntry>
export const SandboxRef = RuntimePublic10.Import('SandboxRef')
export type SandboxRef = Static<typeof SandboxRef>
export const SandboxState = RuntimePublic10.Import('SandboxState')
export type SandboxState = Static<typeof SandboxState>
export const ExecutionRef = RuntimePublic10.Import('ExecutionRef')
export type ExecutionRef = Static<typeof ExecutionRef>
export const ExecRequest = RuntimePublic10.Import('ExecRequest')
export type ExecRequest = Static<typeof ExecRequest>
export const ExecResult = RuntimePublic10.Import('ExecResult')
export type ExecResult = Static<typeof ExecResult>
export const NetworkTarget = RuntimePublic10.Import('NetworkTarget')
export type NetworkTarget = Static<typeof NetworkTarget>
export const NetworkRequest = RuntimePublic10.Import('NetworkRequest')
export type NetworkRequest = Static<typeof NetworkRequest>
export const EffectPermit = RuntimePublic10.Import('EffectPermit')
export type EffectPermit = Static<typeof EffectPermit>
export const QuotaReservation = RuntimePublic10.Import('QuotaReservation')
export type QuotaReservation = Static<typeof QuotaReservation>
export const NewRunSpec = RuntimePublic10.Import('NewRunSpec')
export type NewRunSpec = Static<typeof NewRunSpec>
export const ScheduleTarget = RuntimePublic10.Import('ScheduleTarget')
export type ScheduleTarget = Static<typeof ScheduleTarget>
export const SchedulerDelivery = RuntimePublic10.Import('SchedulerDelivery')
export type SchedulerDelivery = Static<typeof SchedulerDelivery>
export const JobTarget = RuntimePublic10.Import('JobTarget')
export type JobTarget = Static<typeof JobTarget>
export const JobSchedule = RuntimePublic10.Import('JobSchedule')
export type JobSchedule = Static<typeof JobSchedule>
export const JobPolicy = RuntimePublic10.Import('JobPolicy')
export type JobPolicy = Static<typeof JobPolicy>
export const JobDefinition = RuntimePublic10.Import('JobDefinition')
export type JobDefinition = Static<typeof JobDefinition>
export const JobOccurrence = RuntimePublic10.Import('JobOccurrence')
export type JobOccurrence = Static<typeof JobOccurrence>
export const JobEdit = RuntimePublic10.Import('JobEdit')
export type JobEdit = Static<typeof JobEdit>
export const DetachedAcceptance = RuntimePublic10.Import('DetachedAcceptance')
export type DetachedAcceptance = Static<typeof DetachedAcceptance>
export const MemoryItem = RuntimePublic10.Import('MemoryItem')
export type MemoryItem = Static<typeof MemoryItem>
export const DeletionReceipt = RuntimePublic10.Import('DeletionReceipt')
export type DeletionReceipt = Static<typeof DeletionReceipt>
export const RetrievalHit = RuntimePublic10.Import('RetrievalHit')
export type RetrievalHit = Static<typeof RetrievalHit>
export const BudgetReservation = RuntimePublic10.Import('BudgetReservation')
export type BudgetReservation = Static<typeof BudgetReservation>
export const UsageMeasurement = RuntimePublic10.Import('UsageMeasurement')
export type UsageMeasurement = Static<typeof UsageMeasurement>
export const BillingEntry = RuntimePublic10.Import('BillingEntry')
export type BillingEntry = Static<typeof BillingEntry>
export const UploadRef = RuntimePublic10.Import('UploadRef')
export type UploadRef = Static<typeof UploadRef>
export const UploadResult = RuntimePublic10.Import('UploadResult')
export type UploadResult = Static<typeof UploadResult>
export const ArtifactSource = RuntimePublic10.Import('ArtifactSource')
export type ArtifactSource = Static<typeof ArtifactSource>
export const ArtifactReservation = RuntimePublic10.Import('ArtifactReservation')
export type ArtifactReservation = Static<typeof ArtifactReservation>
export const DomainEventRecord = RuntimePublic10.Import('DomainEventRecord')
export type DomainEventRecord = Static<typeof DomainEventRecord>
export const AuditAppend = RuntimePublic10.Import('AuditAppend')
export type AuditAppend = Static<typeof AuditAppend>
export const TraceSpan = RuntimePublic10.Import('TraceSpan')
export type TraceSpan = Static<typeof TraceSpan>
export const PackageRequirement = RuntimePublic10.Import('PackageRequirement')
export type PackageRequirement = Static<typeof PackageRequirement>
export const PackageLockEntry = RuntimePublic10.Import('PackageLockEntry')
export type PackageLockEntry = Static<typeof PackageLockEntry>
export const PackageLock = RuntimePublic10.Import('PackageLock')
export type PackageLock = Static<typeof PackageLock>
export const Readiness = RuntimePublic10.Import('Readiness')
export type Readiness = Static<typeof Readiness>
export const AssemblyGraph = RuntimePublic10.Import('AssemblyGraph')
export type AssemblyGraph = Static<typeof AssemblyGraph>
export const ChannelDestination = RuntimePublic10.Import('ChannelDestination')
export type ChannelDestination = Static<typeof ChannelDestination>
export const ChannelArtifactAttachment = RuntimePublic10.Import('ChannelArtifactAttachment')
export type ChannelArtifactAttachment = Static<typeof ChannelArtifactAttachment>
export const ChannelMessage = RuntimePublic10.Import('ChannelMessage')
export type ChannelMessage = Static<typeof ChannelMessage>
export const ChannelDelivery = RuntimePublic10.Import('ChannelDelivery')
export type ChannelDelivery = Static<typeof ChannelDelivery>
export const AuthenticatedCallback = RuntimePublic10.Import('AuthenticatedCallback')
export type AuthenticatedCallback = Static<typeof AuthenticatedCallback>
export const EmptyAuthorConfig = RuntimePublic10.Import('EmptyAuthorConfig')
export type EmptyAuthorConfig = Static<typeof EmptyAuthorConfig>
export const ToolContribution = RuntimePublic10.Import('ToolContribution')
export type ToolContribution = Static<typeof ToolContribution>
export const RoutingContribution = RuntimePublic10.Import('RoutingContribution')
export type RoutingContribution = Static<typeof RoutingContribution>
export const ArtifactContribution = RuntimePublic10.Import('ArtifactContribution')
export type ArtifactContribution = Static<typeof ArtifactContribution>
export const WorkflowContribution = RuntimePublic10.Import('WorkflowContribution')
export type WorkflowContribution = Static<typeof WorkflowContribution>
export const ObserverContribution = RuntimePublic10.Import('ObserverContribution')
export type ObserverContribution = Static<typeof ObserverContribution>
export const RendererContribution = RuntimePublic10.Import('RendererContribution')
export type RendererContribution = Static<typeof RendererContribution>
export const InterceptorContribution = RuntimePublic10.Import('InterceptorContribution')
export type InterceptorContribution = Static<typeof InterceptorContribution>
export const AuthorContribution = RuntimePublic10.Import('AuthorContribution')
export type AuthorContribution = Static<typeof AuthorContribution>
export const StandardToolOutput = RuntimePublic10.Import('StandardToolOutput')
export type StandardToolOutput = Static<typeof StandardToolOutput>
export const RoutingSelectInput = RuntimePublic10.Import('RoutingSelectInput')
export type RoutingSelectInput = Static<typeof RoutingSelectInput>
export const RoutingSelectResult = RuntimePublic10.Import('RoutingSelectResult')
export type RoutingSelectResult = Static<typeof RoutingSelectResult>
export const EffectPortsInvokeRequest = RuntimePublic10.Import('EffectPortsInvokeRequest')
export type EffectPortsInvokeRequest = Static<typeof EffectPortsInvokeRequest>
