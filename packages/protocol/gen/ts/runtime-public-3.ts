// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const RuntimePublic3 = Type.Module({
  "Id": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
  "UInt53": Type.Integer({ minimum: 0, maximum: 9007199254740991 }),
  "Timestamp": Type.String({ pattern: "Z$", format: "date-time" }),
  "TypeId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[a-z][a-z0-9.-]*/[a-zA-Z0-9._/-]+@[1-9][0-9]*$" }),
  "Digest": Type.String({ pattern: "^[a-f0-9]{64}$" }),
  "SchemaRef": Type.Object({ "typeId": Type.Ref('TypeId'), "revision": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "BlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "DataRef": Type.Union([Type.Object({ "kind": Type.Literal('inline'), "schema": Type.Ref('SchemaRef'), "value": JsonValue, "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "schema": Type.Ref('SchemaRef'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "RuntimeErrorCode": Type.Union([Type.Literal('invalid_input'), Type.Literal('denied'), Type.Literal('incompatible'), Type.Literal('quota'), Type.Literal('cancelled'), Type.Literal('timeout'), Type.Literal('retryable'), Type.Literal('unknown_effect'), Type.Literal('conflict'), Type.Literal('internal')]),
  "OwnerRef": Type.Object({ "kind": Type.Union([Type.Literal('run'), Type.Literal('action'), Type.Literal('job'), Type.Literal('reconciliation')]), "id": Type.Ref('Id') }, { additionalProperties: false }),
  "RetryAdvice": Type.Union([Type.Object({ "kind": Type.Literal('never') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_read'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_same_action'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('reconcile'), "ownerRef": Type.Ref('OwnerRef') }, { additionalProperties: false })]),
  "RuntimeError": Type.Object({ "code": Type.Ref('RuntimeErrorCode'), "detailCode": Type.String(), "message": Type.String(), "retryAdvice": Type.Ref('RetryAdvice'), "diagnosticId": Type.Ref('Id'), "safeDetail": Type.Optional(JsonValue) }, { additionalProperties: false }),
  "BindingRef": Type.Object({ "bindingId": Type.Ref('Id'), "contract": Type.String(), "logicalName": Type.String(), "providerId": Type.Ref('Id') }, { additionalProperties: false }),
  "StateAuthorityRef": Type.Object({ "authorityId": Type.Ref('Id'), "tenantId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ScopeRef": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "kind": Type.Literal('installation') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "kind": Type.Literal('runtime') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('run') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('action'), "actionId": Type.Ref('Id') }, { additionalProperties: false })]),
  "DomainReference": Type.Object({ "authorityId": Type.Ref('Id'), "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53'), "schema": Type.Ref('SchemaRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "DispatchAtomicDomain": Type.Object({ "domainId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "stateAuthority": Type.Ref('StateAuthorityRef'), "budgetAuthority": Type.Ref('StateAuthorityRef'), "stateBinding": Type.Ref('BindingRef'), "budgetBinding": Type.Ref('BindingRef') }, { additionalProperties: false }),
  "Scope": Type.Union([Type.Literal('installation'), Type.Literal('runtime'), Type.Literal('workspace'), Type.Literal('session'), Type.Literal('run'), Type.Literal('action')]),
  "IsolationMode": Type.Union([Type.Literal('trusted-in-process'), Type.Literal('isolated-process'), Type.Literal('remote')]),
  "RecoveryLevel": Type.Union([Type.Literal('R0'), Type.Literal('R1'), Type.Literal('R2')]),
  "CapabilityRequirement": Type.Object({ "capability": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "resourceTypes": Type.Array(Type.Ref('TypeId'), { minItems: 0, maxItems: 64 }), "operations": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }) }, { additionalProperties: false }),
  "OperationDescriptor": Type.Object({ "method": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "kind": Type.Union([Type.Literal('query'), Type.Literal('action'), Type.Literal('control'), Type.Literal('compute'), Type.Literal('maintenance'), Type.Literal('observe'), Type.Literal('ingress')]), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 64 }), "retrySafety": Type.Union([Type.Literal('read-only'), Type.Literal('idempotent'), Type.Literal('reconcile-first'), Type.Literal('never')]) }, { additionalProperties: false }),
  "CommunityOwnerPackageId": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh(?:[./]|$))[^\\u0000-\\u001f\\u007f]+$" }),
  "CommunityContractRef": Type.Object({ "ownerPackageId": Type.Ref('CommunityOwnerPackageId'), "definitionDigest": Type.Ref('Digest') }, { additionalProperties: false }),
  "ServiceRequirement": Type.Union([Type.Object({ "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)(?=^[^\\u0000-\\u001f\\u007f]+$)^agh\\." }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "features": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Ref('Scope'), "optional": Type.Boolean() }, { additionalProperties: false }), Type.Object({ "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)(?=(?=^[^\\u0000-\\u001f\\u007f]+$)^(?!agh\\.).*$)^(?!agh(?:[./]|$))[^\\u0000-\\u001f\\u007f]+/[a-z][a-z0-9-]*$" }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "features": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Union([Type.Literal('runtime'), Type.Literal('workspace'), Type.Literal('session'), Type.Literal('run'), Type.Literal('action')]), "optional": Type.Boolean(), "contractDefinition": Type.Ref('CommunityContractRef') }, { additionalProperties: false })]),
  "StateCodecRef": Type.Object({ "namespace": Type.Ref('Id'), "codecVersion": Type.Ref('Id'), "schema": Type.Ref('SchemaRef') }, { additionalProperties: false }),
  "ProviderDescriptor": Type.Union([Type.Object({ "providerId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)(?=^[^\\u0000-\\u001f\\u007f]+$)^agh\\." }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "packageVersion": Type.String({ maxLength: 128, pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$" }), "packageDigest": Type.String({ pattern: "^[a-f0-9]{64}$" }), "features": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Ref('Scope'), "configSchema": Type.Ref('SchemaRef'), "requires": Type.Array(Type.Ref('ServiceRequirement'), { minItems: 0, maxItems: 128 }), "capabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 128 }), "recovery": Type.Union([Type.Literal('R0'), Type.Literal('R1'), Type.Literal('R2')]), "isolation": Type.Array(Type.Union([Type.Literal('trusted-in-process'), Type.Literal('isolated-process'), Type.Literal('remote')]), { minItems: 1, maxItems: 3 }), "stateCodecs": Type.Array(Type.Ref('StateCodecRef'), { minItems: 0, maxItems: 64 }), "activationMode": Type.Union([Type.Literal('eager'), Type.Literal('lazy')]), "operations": Type.Array(Type.Ref('OperationDescriptor'), { minItems: 0, maxItems: 128 }) }, { additionalProperties: false }), Type.Object({ "providerId": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "contract": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh\\.container$)(?=(?=^[^\\u0000-\\u001f\\u007f]+$)^(?!agh\\.).*$)^(?!agh(?:[./]|$))[^\\u0000-\\u001f\\u007f]+/[a-z][a-z0-9-]*$" }), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "logicalName": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "packageVersion": Type.String({ maxLength: 128, pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$" }), "packageDigest": Type.String({ pattern: "^[a-f0-9]{64}$" }), "features": Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), { minItems: 0, maxItems: 64 }), "scope": Type.Union([Type.Literal('runtime'), Type.Literal('workspace'), Type.Literal('session'), Type.Literal('run'), Type.Literal('action')]), "configSchema": Type.Ref('SchemaRef'), "requires": Type.Array(Type.Ref('ServiceRequirement'), { minItems: 0, maxItems: 128 }), "capabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 128 }), "recovery": Type.Union([Type.Literal('R0'), Type.Literal('R1'), Type.Literal('R2')]), "isolation": Type.Array(Type.Union([Type.Literal('trusted-in-process'), Type.Literal('isolated-process'), Type.Literal('remote')]), { minItems: 1, maxItems: 3 }), "stateCodecs": Type.Array(Type.Ref('StateCodecRef'), { minItems: 0, maxItems: 64 }), "activationMode": Type.Union([Type.Literal('eager'), Type.Literal('lazy')]), "operations": Type.Array(Type.Union([Type.Object({ "method": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "kind": Type.Union([Type.Literal('query'), Type.Literal('compute')]), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 64 }), "retrySafety": Type.Literal('read-only') }, { additionalProperties: false }), Type.Object({ "method": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "kind": Type.Literal('action'), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 64 }), "retrySafety": Type.Union([Type.Literal('read-only'), Type.Literal('idempotent'), Type.Literal('reconcile-first'), Type.Literal('never')]) }, { additionalProperties: false })]), { minItems: 1, maxItems: 128, uniqueItems: true }), "contractDefinition": Type.Ref('CommunityContractRef') }, { additionalProperties: false })]),
  "ConfigValue": Type.Object({ "schema": Type.Ref('SchemaRef'), "value": JsonValue }, { additionalProperties: false }),
  "ExportRef": Type.Object({ "entry": Type.String({ minLength: 1, maxLength: 1024, pattern: "^\\./(?!\\.{1,2}(?:/|$))(?!.*\\/\\.{1,2}(?:/|$))(?!.*//)[^\\\\\\u0000-\\u001f]+$" }), "export": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }) }, { additionalProperties: false }),
  "ResourceRef": Type.Object({ "resourceId": Type.Ref('Id'), "version": Type.String(), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "Revision": Type.Ref('UInt53'),
  "SessionRef": Type.Object({ "sessionId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef') }, { additionalProperties: false }),
  "RunRef": Type.Object({ "runId": Type.Ref('Id'), "session": Type.Ref('SessionRef') }, { additionalProperties: false }),
  "InteractionRef": Type.Object({ "interactionId": Type.Ref('Id') }, { additionalProperties: false }),
  "ReceiptPointer": Type.Object({ "authorityId": Type.Ref('Id'), "receiptId": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "FilePath": Type.String(),
  "SecretHandle": Type.Object({ "handleId": Type.Ref('Id'), "secretId": Type.Ref('Id'), "version": Type.String(), "audience": Type.String(), "expiresAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "FsPolicySnapshot": Type.Object({ "policyId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "scope": Type.Ref('ScopeRef'), "compilerVersion": Type.String(), "roots": Type.Array(Type.Object({ "kind": Type.Union([Type.Literal('workspace'), Type.Literal('home'), Type.Literal('data')]), "mount": Type.Object({ "workspaceId": Type.Ref('Id'), "mountId": Type.Ref('Id') }, { additionalProperties: false }) }, { additionalProperties: false }), { maxItems: 10000 }), "rules": Type.Array(Type.Object({ "root": Type.Union([Type.Literal('workspace'), Type.Literal('home'), Type.Literal('data')]), "path": Type.Ref('FilePath'), "effect": Type.Union([Type.Literal('hard-deny'), Type.Literal('deny'), Type.Literal('allow')]), "access": Type.Array(Type.Union([Type.Literal('read'), Type.Literal('write'), Type.Literal('stat'), Type.Literal('list')]), { maxItems: 10000 }) }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "LeaseRef": Type.Object({ "authorityId": Type.Ref('Id'), "leaseId": Type.Ref('Id'), "epoch": Type.Ref('UInt53'), "expiresAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "MountRef": Type.Object({ "workspaceId": Type.Ref('Id'), "mountId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "lease": Type.Ref('LeaseRef') }, { additionalProperties: false }),
  "FsEnforcementProof": Type.Object({ "policyDigest": Type.Ref('Digest'), "provider": Type.Ref('BindingRef'), "authorityEpoch": Type.Ref('UInt53'), "checkedAt": Type.Ref('Timestamp'), "scope": Type.Ref('ScopeRef'), "workspaceRoot": Type.Object({ "mount": Type.Ref('MountRef'), "policyDecision": Type.Literal('allow'), "exists": Type.Boolean() }, { additionalProperties: false }), "probes": Type.Array(Type.Object({ "root": Type.Union([Type.Literal('workspace'), Type.Literal('home'), Type.Literal('data')]), "path": Type.Ref('FilePath'), "decision": Type.Literal('denied'), "evidenceCode": Type.Literal('E_FS_DENIED') }, { additionalProperties: false }), { minItems: 5, maxItems: 10000, uniqueItems: true }), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "AuthenticatedIdentity": Type.Union([Type.Object({ "principalRef": Type.Ref('Id'), "tenantRef": Type.Ref('Id'), "claims": Type.Ref('DataRef'), "authRevision": Type.Ref('Revision'), "expiresAt": Type.Ref('Timestamp'), "authKind": Type.Literal('local'), "credentialKind": Type.Literal('local'), "ownerClass": Type.Literal('local-owner') }, { additionalProperties: false }), Type.Object({ "principalRef": Type.Ref('Id'), "tenantRef": Type.Ref('Id'), "claims": Type.Ref('DataRef'), "authRevision": Type.Ref('Revision'), "expiresAt": Type.Ref('Timestamp'), "authKind": Type.Union([Type.Literal('local'), Type.Literal('jwt'), Type.Literal('source-auth'), Type.Literal('portal-identity'), Type.Literal('surface')]), "credentialKind": Type.Union([Type.Literal('local'), Type.Literal('jwt'), Type.Literal('sso'), Type.Literal('channel')]), "ownerClass": Type.Union([Type.Literal('remote'), Type.Literal('service')]) }, { additionalProperties: false })]),
  "CredentialRefreshRequest": Type.Object({ "requestId": Type.Ref('Id'), "secretId": Type.Ref('Id'), "expectedVersion": Type.String(), "audience": Type.String(), "accountRef": Type.Ref('Id'), "serverRef": Type.Ref('Id'), "purpose": Type.Union([Type.Literal('model-subscription'), Type.Literal('mcp-oauth')]) }, { additionalProperties: false }),
  "CredentialExchangeRequest": Type.Object({ "requestId": Type.Ref('Id'), "flowId": Type.Ref('Id'), "escrowId": Type.Ref('Id'), "expectedVersion": Type.Union([Type.String(), Type.Null()]), "audience": Type.String(), "accountRef": Type.Ref('Id'), "serverRef": Type.Ref('Id') }, { additionalProperties: false }),
  "CredentialRefreshResult": Type.Union([Type.Object({ "requestId": Type.Ref('Id'), "state": Type.Literal('ready'), "handle": Type.Object({ "handleId": Type.Ref('Id'), "secretId": Type.Ref('Id'), "version": Type.String(), "audience": Type.String(), "expiresAt": Type.Ref('Timestamp') }, { additionalProperties: false }), "revision": Type.Ref('Revision'), "diagnosticId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "requestId": Type.Ref('Id'), "state": Type.Union([Type.Literal('unknown'), Type.Literal('needs-reconnect')]), "handle": Type.Null(), "revision": Type.Ref('Revision'), "diagnosticId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false })]),
  "CredentialCallbackRequest": Type.Object({ "flowId": Type.Ref('Id'), "state": Type.String(), "authorizationCode": Type.String(), "redirectUri": Type.String() }, { additionalProperties: false }),
  "TelemetryConsent": Type.Union([Type.Object({ "sessionId": Type.Ref('Id'), "level": Type.Literal('FULL'), "sourceDigest": Type.Ref('Digest'), "profileId": Type.Ref('Id'), "recordedAt": Type.Ref('Timestamp'), "explicitFull": Type.Literal(true), "evidence": Type.Union([Type.Literal('explicit-command'), Type.Literal('trusted-config'), Type.Literal('legacy-import')]) }, { additionalProperties: false }), Type.Object({ "sessionId": Type.Ref('Id'), "level": Type.Union([Type.Literal('DISABLED'), Type.Literal('LOCAL'), Type.Literal('ANON')]), "sourceDigest": Type.Ref('Digest'), "profileId": Type.Ref('Id'), "recordedAt": Type.Ref('Timestamp'), "explicitFull": Type.Boolean(), "evidence": Type.Union([Type.Literal('explicit-command'), Type.Literal('trusted-config'), Type.Literal('legacy-import')]) }, { additionalProperties: false })]),
  "TelemetryExportRequest": Type.Object({ "batchId": Type.Ref('Id'), "kind": Type.Union([Type.Literal('trace'), Type.Literal('trajectory')]), "body": Type.Ref('DataRef'), "consent": Type.Ref('TelemetryConsent'), "targetRef": Type.Ref('Id'), "policyRef": Type.Ref('DomainReference') }, { additionalProperties: false }),
  "TelemetryExportResult": Type.Object({ "batchId": Type.Ref('Id'), "state": Type.Union([Type.Literal('sent'), Type.Literal('denied'), Type.Literal('unknown')]), "receiptRef": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]), "contentDigest": Type.Ref('Digest'), "diagnosticId": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "ResourceChangePlan": Type.Object({ "planId": Type.Ref('Id'), "kind": Type.Union([Type.Literal('mcp'), Type.Literal('skill')]), "operation": Type.Union([Type.Literal('install'), Type.Literal('update'), Type.Literal('remove')]), "targetScope": Type.Ref('ScopeRef'), "resourceId": Type.Ref('Id'), "sourceRef": Type.Union([Type.Ref('ResourceRef'), Type.Null()]), "expectedRevision": Type.Union([Type.Ref('Revision'), Type.Null()]), "config": Type.Union([Type.Ref('ConfigValue'), Type.Null()]), "permissionDifference": Type.Array(Type.Ref('CapabilityRequirement'), { maxItems: 10000 }), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "PackageLocator": Type.Union([Type.Object({ "kind": Type.Literal('local'), "sourceId": Type.Ref('Id'), "pathRef": Type.Ref('Id'), "digest": Type.Ref('Digest') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('npm'), "sourceId": Type.Ref('Id'), "name": Type.String(), "version": Type.String(), "integrity": Type.String(), "digest": Type.Ref('Digest') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('git'), "sourceId": Type.Ref('Id'), "repository": Type.String(), "commit": Type.String(), "subdirectory": Type.String(), "digest": Type.Ref('Digest') }, { additionalProperties: false })]),
  "ChangeProposalRequest": Type.Object({ "requestId": Type.Ref('Id'), "reason": Type.String(), "targetScope": Type.Ref('ScopeRef'), "change": Type.Union([Type.Object({ "kind": Type.Literal('package'), "locator": Type.Ref('PackageLocator'), "operation": Type.Union([Type.Literal('install'), Type.Literal('upgrade'), Type.Literal('disable')]) }, { additionalProperties: false }), Type.Object({ "kind": Type.Union([Type.Literal('mcp'), Type.Literal('skill')]), "resourceId": Type.Ref('Id'), "sourceRef": Type.Union([Type.Ref('ResourceRef'), Type.Null()]), "operation": Type.Union([Type.Literal('install'), Type.Literal('update'), Type.Literal('remove')]), "config": Type.Union([Type.Ref('ConfigValue'), Type.Null()]) }, { additionalProperties: false })]) }, { additionalProperties: false }),
  "ResolvedProviderBinding": Type.Object({ "binding": Type.Ref('BindingRef'), "descriptor": Type.Ref('ProviderDescriptor'), "isolation": Type.Ref('IsolationMode'), "config": Type.Ref('DataRef'), "configDigest": Type.Ref('Digest'), "dependencies": Type.Array(Type.Ref('BindingRef'), { maxItems: 10000 }), "codecRefs": Type.Array(Type.Ref('StateCodecRef'), { maxItems: 10000 }), "schemaRefs": Type.Array(Type.Ref('SchemaRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "VersionedRef": Type.Object({ "id": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "digest": Type.Ref('Digest'), "data": Type.Ref('DataRef') }, { additionalProperties: false }),
  "ContentRef": Type.Ref('DataRef'),
  "ReleaseSet": Type.Object({ "releaseSetId": Type.String(), "formatVersion": Type.Number(), "hostAbi": Type.String(), "packages": Type.Array(Type.Object({ "packageId": Type.String(), "version": Type.String(), "digest": Type.String(), "sourceRef": Type.String(), "integrityRef": Type.String(), "entries": Type.Record(Type.String(), Type.Object({ "digest": Type.String(), "platform": Type.String() }, { additionalProperties: false }), { maxProperties: 10000 }) }, { additionalProperties: false }), { maxItems: 10000 }), "bindings": Type.Array(Type.Ref('ResolvedProviderBinding'), { maxItems: 10000 }), "profileRef": Type.Ref('VersionedRef'), "presetRef": Type.Ref('VersionedRef'), "configSnapshotRef": Type.Ref('ContentRef'), "schemasRef": Type.Ref('ContentRef'), "clientBundlesRef": Type.Ref('ContentRef'), "recoveryManifestRef": Type.Ref('ContentRef'), "resourceClaimsRef": Type.Ref('ContentRef') }, { additionalProperties: false }),
  "ReleasePlan": Type.Object({ "planId": Type.Ref('Id'), "upgradeId": Type.Ref('Id'), "planFingerprint": Type.Ref('Digest'), "operation": Type.Union([Type.Literal('install'), Type.Literal('upgrade'), Type.Literal('disable'), Type.Literal('repair'), Type.Literal('rollback')]), "routeId": Type.Ref('Id'), "expectedRouteRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]), "sourceReleaseSetId": Type.Union([Type.Ref('Id'), Type.Null()]), "targetReleaseSet": Type.Ref('ReleaseSet'), "affectedContributions": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "configDigest": Type.Ref('Digest'), "permissionDifference": Type.Object({ "beforeProfileDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "afterProfileDigest": Type.Ref('Digest'), "added": Type.Array(Type.Ref('CapabilityRequirement'), { maxItems: 10000 }), "removed": Type.Array(Type.Ref('CapabilityRequirement'), { maxItems: 10000 }), "policyChanges": Type.Array(Type.Object({ "path": Type.String(), "before": Type.Union([Type.Ref('DataRef'), Type.Null()]), "after": Type.Union([Type.Ref('DataRef'), Type.Null()]) }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }), "requiredPins": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "readinessChecks": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "prerequisiteMigrationPlans": Type.Array(Type.Object({ "planId": Type.Ref('Id'), "planFingerprint": Type.Ref('Digest') }, { additionalProperties: false }), { maxItems: 10000 }), "authorizedBy": Type.Ref('Id'), "expiresAt": Type.Ref('Timestamp'), "rollbackOf": Type.Union([Type.Ref('Id'), Type.Null()]) }, { additionalProperties: false }),
  "ChangeProposal": Type.Object({ "proposalId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "revision": Type.Ref('Revision'), "requester": Type.Ref('Id'), "scope": Type.Ref('ScopeRef'), "status": Type.Union([Type.Literal('planning'), Type.Literal('awaiting-approval'), Type.Literal('approved'), Type.Literal('applying'), Type.Literal('applied'), Type.Literal('denied'), Type.Literal('cancelled'), Type.Literal('unknown')]), "plan": Type.Union([Type.Object({ "kind": Type.Literal('release'), "value": Type.Ref('ReleasePlan') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('resource'), "value": Type.Ref('ResourceChangePlan') }, { additionalProperties: false }), Type.Null()]), "planDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "interactionRef": Type.Union([Type.Ref('InteractionRef'), Type.Null()]), "resultRef": Type.Union([Type.Ref('ReceiptPointer'), Type.Null()]), "error": Type.Union([Type.Ref('RuntimeError'), Type.Null()]) }, { additionalProperties: false }),
  "ProviderBindingSnapshot": Type.Object({ "binding": Type.Ref('BindingRef'), "descriptor": Type.Ref('ProviderDescriptor'), "isolation": Type.Ref('IsolationMode'), "config": Type.Ref('DataRef'), "configDigest": Type.Ref('Digest'), "dependencies": Type.Array(Type.Ref('BindingRef'), { maxItems: 10000 }), "codecRefs": Type.Array(Type.Ref('StateCodecRef'), { maxItems: 10000 }), "schemaRefs": Type.Array(Type.Ref('SchemaRef'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "RunBinding": Type.Object({ "bindingId": Type.Ref('Id'), "releaseSetId": Type.Ref('Id'), "profileDigest": Type.Ref('Digest'), "presetDigest": Type.Ref('Digest'), "createdAt": Type.Ref('Timestamp'), "minimumRecovery": Type.Ref('RecoveryLevel'), "stateAuthorityAtCreation": Type.Ref('StateAuthorityRef'), "filesystemPolicy": Type.Ref('FsPolicySnapshot'), "telemetryConsent": Type.Ref('TelemetryConsent'), "providers": Type.Array(Type.Ref('ProviderBindingSnapshot'), { maxItems: 10000 }), "jointDispatchDomains": Type.Array(Type.Ref('DispatchAtomicDomain'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ApprovalRespondRequest": Type.Union([Type.Object({ "interactionId": Type.Ref('Id'), "responseId": Type.Ref('Id'), "expectedVersion": Type.Ref('UInt53'), "decision": Type.Literal('approve'), "actionDigest": Type.Ref('Digest'), "grantScope": Type.Optional(Type.Union([Type.Literal('once'), Type.Literal('session'), Type.Literal('permanent')])) }, { additionalProperties: false }), Type.Object({ "interactionId": Type.Ref('Id'), "responseId": Type.Ref('Id'), "expectedVersion": Type.Ref('UInt53'), "decision": Type.Literal('deny'), "actionDigest": Type.Ref('Digest') }, { additionalProperties: false })]),
  "AttemptRef": Type.Object({ "run": Type.Ref('RunRef'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id') }, { additionalProperties: false }),
  "CredentialRefreshNeeded": Type.Object({ "kind": Type.Literal('credential-refresh-required'), "failedAttempt": Type.Ref('AttemptRef'), "request": Type.Ref('CredentialRefreshRequest') }, { additionalProperties: false }),
  "McpConnectRequest": Type.Object({ "serverRef": Type.Ref('ResourceRef'), "transport": Type.Union([Type.Literal('stdio'), Type.Literal('streamable-http')]), "credentialRef": Type.Union([Type.Ref('SecretHandle'), Type.Null()]) }, { additionalProperties: false }),
  "McpConnectionPreparation": Type.Object({ "request": Type.Ref('McpConnectRequest'), "credentialRefresh": Type.Union([Type.Ref('CredentialRefreshRequest'), Type.Null()]) }, { additionalProperties: false }),
  "LoopQualityInput": Type.Object({ "toolCalls": Type.Array(Type.Object({ "name": Type.String(), "args": JsonValue, "schemaOk": Type.Boolean(), "isReadOnly": Type.Boolean() }, { additionalProperties: false }), { maxItems: 10000 }), "deviations": Type.Ref('UInt53'), "recentToolKeys": Type.Array(Type.String(), { maxItems: 10000 }), "surfaceTailHashes": Type.Array(Type.Ref('Digest'), { maxItems: 10000 }), "newToolResults": Type.Ref('UInt53'), "lastFinishReason": Type.Union([Type.Literal('stop'), Type.Literal('length'), Type.Literal('tool_use'), Type.Literal('error'), Type.Null()]) }, { additionalProperties: false }),
  "LoopQualityVerdict": Type.Object({ "verdict": Type.Union([Type.Literal('pass'), Type.Literal('fail'), Type.Literal('needs_revision')]), "reasons": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }),
  "CommunityContractName": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!agh(?:[./]|$))[^\\u0000-\\u001f\\u007f]+/[a-z][a-z0-9-]*$" }),
  "CommunityOperationDescriptor": Type.Union([Type.Object({ "method": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "kind": Type.Union([Type.Literal('query'), Type.Literal('compute')]), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 64 }), "retrySafety": Type.Literal('read-only') }, { additionalProperties: false }), Type.Object({ "method": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), "kind": Type.Literal('action'), "inputSchema": Type.Ref('SchemaRef'), "outputSchema": Type.Ref('SchemaRef'), "requiredCapabilities": Type.Array(Type.Ref('CapabilityRequirement'), { minItems: 0, maxItems: 64 }), "retrySafety": Type.Union([Type.Literal('read-only'), Type.Literal('idempotent'), Type.Literal('reconcile-first'), Type.Literal('never')]) }, { additionalProperties: false })]),
  "CommunityContractDefinition": Type.Object({ "contract": Type.Ref('CommunityContractName'), "major": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "ownerPackageId": Type.Ref('CommunityOwnerPackageId'), "scope": Type.Union([Type.Literal('runtime'), Type.Literal('workspace'), Type.Literal('session'), Type.Literal('run'), Type.Literal('action')]), "features": Type.Array(Type.Ref('Id'), { minItems: 0, maxItems: 64, uniqueItems: true }), "operations": Type.Array(Type.Ref('CommunityOperationDescriptor'), { minItems: 1, maxItems: 128, uniqueItems: true }) }, { additionalProperties: false }),
  "ContributionExport": Type.Ref('ExportRef'),
  "InterceptorEvent": Type.Union([Type.Literal('resources_discover'), Type.Literal('before_step'), Type.Literal('context'), Type.Literal('before_request'), Type.Literal('tool_call'), Type.Literal('tool_result'), Type.Literal('turn_stopping'), Type.Literal('approval_request'), Type.Literal('before_compact')]),
  "InterceptorPhase": Type.Union([Type.Literal('before'), Type.Literal('after')]),
  "InterceptorFieldPointer": Type.String({ minLength: 2, maxLength: 1024, pattern: "^(?!.*(?:^|/)(?:__proto__|prototype|constructor)(?:/|$))/(?:[^~/\\u0000-\\u001f\\u007f*]|~[01])+(?:/(?:[^~/\\u0000-\\u001f\\u007f*]|~[01])+)*$" }),
  "InterceptorEffectOperation": Type.Object({ "contract": Type.Ref('Id'), "logicalName": Type.Ref('Id'), "method": Type.Ref('Id') }, { additionalProperties: false }),
  "InterceptorInvocation": Type.Object({ "runId": Type.Ref('Id'), "actionId": Type.Union([Type.Ref('Id'), Type.Null()]), "requestId": Type.Ref('Id'), "stageId": Type.Ref('Id'), "receiptId": Type.Union([Type.Ref('Id'), Type.Null()]), "attempt": Type.Union([Type.Object({ "attemptId": Type.Ref('Id'), "number": Type.Ref('UInt53'), "startedAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]), "finishedAt": Type.Union([Type.Ref('Timestamp'), Type.Null()]) }, { additionalProperties: false }), Type.Null()]) }, { additionalProperties: false }),
})

export const Id = RuntimePublic3.Import('Id')
export type Id = Static<typeof Id>
export const UInt53 = RuntimePublic3.Import('UInt53')
export type UInt53 = Static<typeof UInt53>
export const Timestamp = RuntimePublic3.Import('Timestamp')
export type Timestamp = Static<typeof Timestamp>
export const TypeId = RuntimePublic3.Import('TypeId')
export type TypeId = Static<typeof TypeId>
export const Digest = RuntimePublic3.Import('Digest')
export type Digest = Static<typeof Digest>
export const SchemaRef = RuntimePublic3.Import('SchemaRef')
export type SchemaRef = Static<typeof SchemaRef>
export const BlobRef = RuntimePublic3.Import('BlobRef')
export type BlobRef = Static<typeof BlobRef>
export const DataRef = RuntimePublic3.Import('DataRef')
export type DataRef = Static<typeof DataRef>
export const RuntimeErrorCode = RuntimePublic3.Import('RuntimeErrorCode')
export type RuntimeErrorCode = Static<typeof RuntimeErrorCode>
export const OwnerRef = RuntimePublic3.Import('OwnerRef')
export type OwnerRef = Static<typeof OwnerRef>
export const RetryAdvice = RuntimePublic3.Import('RetryAdvice')
export type RetryAdvice = Static<typeof RetryAdvice>
export const RuntimeError = RuntimePublic3.Import('RuntimeError')
export type RuntimeError = Static<typeof RuntimeError>
export const BindingRef = RuntimePublic3.Import('BindingRef')
export type BindingRef = Static<typeof BindingRef>
export const StateAuthorityRef = RuntimePublic3.Import('StateAuthorityRef')
export type StateAuthorityRef = Static<typeof StateAuthorityRef>
export const ScopeRef = RuntimePublic3.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const DomainReference = RuntimePublic3.Import('DomainReference')
export type DomainReference = Static<typeof DomainReference>
export const DispatchAtomicDomain = RuntimePublic3.Import('DispatchAtomicDomain')
export type DispatchAtomicDomain = Static<typeof DispatchAtomicDomain>
export const Scope = RuntimePublic3.Import('Scope')
export type Scope = Static<typeof Scope>
export const IsolationMode = RuntimePublic3.Import('IsolationMode')
export type IsolationMode = Static<typeof IsolationMode>
export const RecoveryLevel = RuntimePublic3.Import('RecoveryLevel')
export type RecoveryLevel = Static<typeof RecoveryLevel>
export const CapabilityRequirement = RuntimePublic3.Import('CapabilityRequirement')
export type CapabilityRequirement = Static<typeof CapabilityRequirement>
export const OperationDescriptor = RuntimePublic3.Import('OperationDescriptor')
export type OperationDescriptor = Static<typeof OperationDescriptor>
export const CommunityOwnerPackageId = RuntimePublic3.Import('CommunityOwnerPackageId')
export type CommunityOwnerPackageId = Static<typeof CommunityOwnerPackageId>
export const CommunityContractRef = RuntimePublic3.Import('CommunityContractRef')
export type CommunityContractRef = Static<typeof CommunityContractRef>
export const ServiceRequirement = RuntimePublic3.Import('ServiceRequirement')
export type ServiceRequirement = Static<typeof ServiceRequirement>
export const StateCodecRef = RuntimePublic3.Import('StateCodecRef')
export type StateCodecRef = Static<typeof StateCodecRef>
export const ProviderDescriptor = RuntimePublic3.Import('ProviderDescriptor')
export type ProviderDescriptor = Static<typeof ProviderDescriptor>
export const ConfigValue = RuntimePublic3.Import('ConfigValue')
export type ConfigValue = Static<typeof ConfigValue>
export const ExportRef = RuntimePublic3.Import('ExportRef')
export type ExportRef = Static<typeof ExportRef>
export const ResourceRef = RuntimePublic3.Import('ResourceRef')
export type ResourceRef = Static<typeof ResourceRef>
export const Revision = RuntimePublic3.Import('Revision')
export type Revision = Static<typeof Revision>
export const SessionRef = RuntimePublic3.Import('SessionRef')
export type SessionRef = Static<typeof SessionRef>
export const RunRef = RuntimePublic3.Import('RunRef')
export type RunRef = Static<typeof RunRef>
export const InteractionRef = RuntimePublic3.Import('InteractionRef')
export type InteractionRef = Static<typeof InteractionRef>
export const ReceiptPointer = RuntimePublic3.Import('ReceiptPointer')
export type ReceiptPointer = Static<typeof ReceiptPointer>
export const FilePath = RuntimePublic3.Import('FilePath')
export type FilePath = Static<typeof FilePath>
export const SecretHandle = RuntimePublic3.Import('SecretHandle')
export type SecretHandle = Static<typeof SecretHandle>
export const FsPolicySnapshot = RuntimePublic3.Import('FsPolicySnapshot')
export type FsPolicySnapshot = Static<typeof FsPolicySnapshot>
export const LeaseRef = RuntimePublic3.Import('LeaseRef')
export type LeaseRef = Static<typeof LeaseRef>
export const MountRef = RuntimePublic3.Import('MountRef')
export type MountRef = Static<typeof MountRef>
export const FsEnforcementProof = RuntimePublic3.Import('FsEnforcementProof')
export type FsEnforcementProof = Static<typeof FsEnforcementProof>
export const AuthenticatedIdentity = RuntimePublic3.Import('AuthenticatedIdentity')
export type AuthenticatedIdentity = Static<typeof AuthenticatedIdentity>
export const CredentialRefreshRequest = RuntimePublic3.Import('CredentialRefreshRequest')
export type CredentialRefreshRequest = Static<typeof CredentialRefreshRequest>
export const CredentialExchangeRequest = RuntimePublic3.Import('CredentialExchangeRequest')
export type CredentialExchangeRequest = Static<typeof CredentialExchangeRequest>
export const CredentialRefreshResult = RuntimePublic3.Import('CredentialRefreshResult')
export type CredentialRefreshResult = Static<typeof CredentialRefreshResult>
export const CredentialCallbackRequest = RuntimePublic3.Import('CredentialCallbackRequest')
export type CredentialCallbackRequest = Static<typeof CredentialCallbackRequest>
export const TelemetryConsent = RuntimePublic3.Import('TelemetryConsent')
export type TelemetryConsent = Static<typeof TelemetryConsent>
export const TelemetryExportRequest = RuntimePublic3.Import('TelemetryExportRequest')
export type TelemetryExportRequest = Static<typeof TelemetryExportRequest>
export const TelemetryExportResult = RuntimePublic3.Import('TelemetryExportResult')
export type TelemetryExportResult = Static<typeof TelemetryExportResult>
export const ResourceChangePlan = RuntimePublic3.Import('ResourceChangePlan')
export type ResourceChangePlan = Static<typeof ResourceChangePlan>
export const PackageLocator = RuntimePublic3.Import('PackageLocator')
export type PackageLocator = Static<typeof PackageLocator>
export const ChangeProposalRequest = RuntimePublic3.Import('ChangeProposalRequest')
export type ChangeProposalRequest = Static<typeof ChangeProposalRequest>
export const ResolvedProviderBinding = RuntimePublic3.Import('ResolvedProviderBinding')
export type ResolvedProviderBinding = Static<typeof ResolvedProviderBinding>
export const VersionedRef = RuntimePublic3.Import('VersionedRef')
export type VersionedRef = Static<typeof VersionedRef>
export const ContentRef = RuntimePublic3.Import('ContentRef')
export type ContentRef = Static<typeof ContentRef>
export const ReleaseSet = RuntimePublic3.Import('ReleaseSet')
export type ReleaseSet = Static<typeof ReleaseSet>
export const ReleasePlan = RuntimePublic3.Import('ReleasePlan')
export type ReleasePlan = Static<typeof ReleasePlan>
export const ChangeProposal = RuntimePublic3.Import('ChangeProposal')
export type ChangeProposal = Static<typeof ChangeProposal>
export const ProviderBindingSnapshot = RuntimePublic3.Import('ProviderBindingSnapshot')
export type ProviderBindingSnapshot = Static<typeof ProviderBindingSnapshot>
export const RunBinding = RuntimePublic3.Import('RunBinding')
export type RunBinding = Static<typeof RunBinding>
export const ApprovalRespondRequest = RuntimePublic3.Import('ApprovalRespondRequest')
export type ApprovalRespondRequest = Static<typeof ApprovalRespondRequest>
export const AttemptRef = RuntimePublic3.Import('AttemptRef')
export type AttemptRef = Static<typeof AttemptRef>
export const CredentialRefreshNeeded = RuntimePublic3.Import('CredentialRefreshNeeded')
export type CredentialRefreshNeeded = Static<typeof CredentialRefreshNeeded>
export const McpConnectRequest = RuntimePublic3.Import('McpConnectRequest')
export type McpConnectRequest = Static<typeof McpConnectRequest>
export const McpConnectionPreparation = RuntimePublic3.Import('McpConnectionPreparation')
export type McpConnectionPreparation = Static<typeof McpConnectionPreparation>
export const LoopQualityInput = RuntimePublic3.Import('LoopQualityInput')
export type LoopQualityInput = Static<typeof LoopQualityInput>
export const LoopQualityVerdict = RuntimePublic3.Import('LoopQualityVerdict')
export type LoopQualityVerdict = Static<typeof LoopQualityVerdict>
export const CommunityContractName = RuntimePublic3.Import('CommunityContractName')
export type CommunityContractName = Static<typeof CommunityContractName>
export const CommunityOperationDescriptor = RuntimePublic3.Import('CommunityOperationDescriptor')
export type CommunityOperationDescriptor = Static<typeof CommunityOperationDescriptor>
export const CommunityContractDefinition = RuntimePublic3.Import('CommunityContractDefinition')
export type CommunityContractDefinition = Static<typeof CommunityContractDefinition>
export const ContributionExport = RuntimePublic3.Import('ContributionExport')
export type ContributionExport = Static<typeof ContributionExport>
export const InterceptorEvent = RuntimePublic3.Import('InterceptorEvent')
export type InterceptorEvent = Static<typeof InterceptorEvent>
export const InterceptorPhase = RuntimePublic3.Import('InterceptorPhase')
export type InterceptorPhase = Static<typeof InterceptorPhase>
export const InterceptorFieldPointer = RuntimePublic3.Import('InterceptorFieldPointer')
export type InterceptorFieldPointer = Static<typeof InterceptorFieldPointer>
export const InterceptorEffectOperation = RuntimePublic3.Import('InterceptorEffectOperation')
export type InterceptorEffectOperation = Static<typeof InterceptorEffectOperation>
export const InterceptorInvocation = RuntimePublic3.Import('InterceptorInvocation')
export type InterceptorInvocation = Static<typeof InterceptorInvocation>
