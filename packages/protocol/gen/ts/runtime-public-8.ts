// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This, { minItems: 0, maxItems: 10000 }), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const RuntimePublic8 = Type.Module({
  "Id": Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
  "UInt53": Type.Integer({ minimum: 0, maximum: 9007199254740991 }),
  "Timestamp": Type.String({ pattern: "Z$", format: "date-time" }),
  "TypeId": Type.String({ minLength: 1, maxLength: 256, pattern: "^(?:[a-z][a-z0-9.-]*|@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*)/[a-zA-Z0-9._/-]+@[1-9][0-9]*$" }),
  "Digest": Type.String({ pattern: "^[a-f0-9]{64}$" }),
  "SchemaRef": Type.Object({ "typeId": Type.Ref('TypeId'), "revision": Type.Ref('UInt53'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "BlobRef": Type.Object({ "authorityId": Type.Ref('Id'), "blobId": Type.Ref('Id'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53'), "mediaType": Type.String(), "pinId": Type.Ref('Id') }, { additionalProperties: false }),
  "DataRef": Type.Union([Type.Object({ "kind": Type.Literal('inline'), "schema": Type.Ref('SchemaRef'), "value": JsonValue, "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "schema": Type.Ref('SchemaRef'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "RuntimeErrorCode": Type.Union([Type.Literal('invalid_input'), Type.Literal('denied'), Type.Literal('incompatible'), Type.Literal('quota'), Type.Literal('cancelled'), Type.Literal('timeout'), Type.Literal('retryable'), Type.Literal('unknown_effect'), Type.Literal('conflict'), Type.Literal('internal')]),
  "OwnerRef": Type.Object({ "kind": Type.Union([Type.Literal('run'), Type.Literal('action'), Type.Literal('job'), Type.Literal('reconciliation')]), "id": Type.Ref('Id') }, { additionalProperties: false }),
  "RetryAdvice": Type.Union([Type.Object({ "kind": Type.Literal('never') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_read'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('retry_same_action'), "notBefore": Type.Optional(Type.Ref('Timestamp')) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('reconcile'), "ownerRef": Type.Ref('OwnerRef') }, { additionalProperties: false })]),
  "RuntimeError": Type.Object({ "code": Type.Ref('RuntimeErrorCode'), "detailCode": Type.String(), "message": Type.String(), "retryAdvice": Type.Ref('RetryAdvice'), "diagnosticId": Type.Ref('Id'), "safeDetail": Type.Optional(JsonValue) }, { additionalProperties: false }),
  "BindingRef": Type.Object({ "bindingId": Type.Ref('Id'), "contract": Type.String(), "logicalName": Type.String(), "providerId": Type.Ref('Id') }, { additionalProperties: false }),
  "StateCommitReceipt": Type.Object({ "commitId": Type.Ref('Id'), "transactionFingerprint": Type.Ref('Digest'), "sessionId": Type.Ref('Id'), "firstSeq": Type.Ref('UInt53'), "lastSeq": Type.Ref('UInt53'), "headDigest": Type.Ref('Digest'), "runRevision": Type.Ref('UInt53'), "actionIds": Type.Array(Type.Object({ "key": Type.String(), "actionId": Type.Ref('Id') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "StateAuthorityRef": Type.Object({ "authorityId": Type.Ref('Id'), "tenantId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ScopeRef": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "kind": Type.Literal('installation') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "kind": Type.Literal('runtime') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('run') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "runId": Type.Ref('Id'), "kind": Type.Literal('action'), "actionId": Type.Ref('Id') }, { additionalProperties: false })]),
  "DomainReference": Type.Object({ "authorityId": Type.Ref('Id'), "recordId": Type.Ref('Id'), "recordRevision": Type.Ref('UInt53'), "schema": Type.Ref('SchemaRef'), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "CallContextWire": Type.Object({ "principalRef": Type.Ref('Id'), "scope": Type.Ref('ScopeRef'), "bindingId": Type.Ref('Id'), "invocationId": Type.Ref('Id'), "deadline": Type.Ref('Timestamp'), "traceRef": Type.Ref('Id'), "authorizationRef": Type.Ref('Id') }, { additionalProperties: false }),
  "DispatchAtomicDomain": Type.Object({ "domainId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "stateAuthority": Type.Ref('StateAuthorityRef'), "budgetAuthority": Type.Ref('StateAuthorityRef'), "stateBinding": Type.Ref('BindingRef'), "budgetBinding": Type.Ref('BindingRef') }, { additionalProperties: false }),
  "SnapshotRef": Type.Object({ "snapshotId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef'), "sessionId": Type.Ref('Id'), "throughSeq": Type.Ref('UInt53'), "headDigest": Type.Union([Type.Ref('Digest'), Type.Null()]), "expiresAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
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
  "Cursor": Type.String(),
  "PreparedActionAdmissionProbe": Type.Union([Type.Object({ "state": Type.Literal('absent') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('committed'), "actionId": Type.Ref('Id'), "acceptanceId": Type.Ref('Id'), "commitId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('cancelled'), "acceptanceId": Type.Ref('Id'), "tombstoneId": Type.Ref('Id'), "commitId": Type.Ref('Id') }, { additionalProperties: false })]),
  "MigrationToken": Type.Object({ "upgradeId": Type.Ref('Id'), "runId": Type.Ref('Id'), "fromBindingId": Type.Ref('Id'), "frozenRevision": Type.Ref('UInt53'), "frozenWriterEpoch": Type.Ref('UInt53'), "authorityEpoch": Type.Ref('UInt53'), "fingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "MigrationProbe": Type.Union([Type.Object({ "state": Type.Literal('absent') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('frozen'), "token": Type.Ref('MigrationToken') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('committed'), "token": Type.Ref('MigrationToken'), "commit": Type.Ref('StateCommitReceipt'), "toBindingId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('aborted'), "token": Type.Ref('MigrationToken'), "commit": Type.Ref('StateCommitReceipt'), "reason": Type.String() }, { additionalProperties: false })]),
  "StateScanRequest": Type.Object({ "snapshot": Type.Ref('SnapshotRef'), "collection": Type.Union([Type.Literal('events'), Type.Literal('integrity'), Type.Literal('records'), Type.Literal('actions'), Type.Literal('signals'), Type.Literal('outbox'), Type.Literal('record-versions'), Type.Literal('mutation-manifests'), Type.Literal('commit-side-entries')]), "filter": Type.Object({ "runId": Type.Optional(Type.Ref('Id')), "parentActionId": Type.Optional(Type.Union([Type.Ref('Id'), Type.Null()])), "targetActionId": Type.Optional(Type.Union([Type.Ref('Id'), Type.Null()])), "typeIds": Type.Optional(Type.Array(Type.Ref('TypeId'), { maxItems: 10000 })), "commitId": Type.Optional(Type.Ref('Id')), "states": Type.Optional(Type.Array(Type.String(), { maxItems: 10000 })), "fromSeq": Type.Optional(Type.Ref('UInt53')), "toSeq": Type.Optional(Type.Ref('UInt53')) }, { additionalProperties: false }), "order": Type.Union([Type.Literal('asc'), Type.Literal('desc')]), "cursor": Type.Union([Type.Ref('Cursor'), Type.Null()]), "limit": Type.Ref('UInt53') }, { additionalProperties: false }),
  "ChildCreateRequest": Type.Object({ "creationId": Type.Ref('Id'), "fingerprint": Type.Ref('Digest'), "parentSnapshot": Type.Ref('SnapshotRef'), "boundarySeq": Type.Ref('UInt53'), "childSessionId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "ownerBinding": Type.Ref('BindingRef') }, { additionalProperties: false }),
  "StreamRegistration": Type.Object({ "requestId": Type.Ref('Id'), "streamId": Type.Ref('Id'), "actionId": Type.Ref('Id'), "attemptId": Type.Ref('Id'), "durability": Type.Union([Type.Literal('ephemeral'), Type.Literal('durable')]), "retentionUntil": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "RuntimeFormatData": Type.Object({ "formatVersion": Type.Literal(2), "runtimeSchemaMajor": Type.Literal(1), "minReader": Type.Union([Type.Literal(1), Type.Literal(2)]), "previousFormat": Type.Union([Type.Literal(1), Type.Literal(2)]), "legacyThroughSeq": Type.Ref('UInt53'), "sourceHeadDigest": Type.Union([Type.Ref('Digest'), Type.Null()]) }, { additionalProperties: false }),
  "RuntimeCommitData": Type.Object({ "commitId": Type.Ref('Id'), "transactionFingerprint": Type.Ref('Digest'), "runId": Type.Union([Type.Ref('Id'), Type.Null()]), "actionId": Type.Union([Type.Ref('Id'), Type.Null()]), "authorityEpoch": Type.Ref('UInt53'), "writerEpoch": Type.Ref('UInt53'), "previousCommitId": Type.Union([Type.Ref('Id'), Type.Null()]), "mutationsDigest": Type.Ref('Digest'), "mutationCount": Type.Ref('UInt53'), "sideListsDigest": Type.Ref('Digest'), "counts": Type.Object({ "createdActions": Type.Ref('UInt53'), "consumedSignals": Type.Ref('UInt53'), "outboxEvents": Type.Ref('UInt53'), "receipts": Type.Ref('UInt53'), "usageOrigins": Type.Ref('UInt53') }, { additionalProperties: false }) }, { additionalProperties: false }),
  "InboxRecord": Type.Object({ "sourceAuthorityId": Type.Ref('Id'), "eventId": Type.Ref('Id'), "consumerId": Type.Ref('Id'), "fingerprint": Type.Ref('Digest'), "receivedAt": Type.Ref('Timestamp'), "appliedCommitId": Type.Ref('Id'), "acknowledgement": Type.Ref('DataRef'), "inboxSeq": Type.Integer({ minimum: 1, maximum: 9007199254740991 }) }, { additionalProperties: false }),
  "MaintenanceEnvelopeJsonValue": Type.Object({ "recordId": Type.Ref('Id'), "revision": Type.Ref('UInt53'), "writerEpoch": Type.Ref('UInt53'), "createdAt": Type.Ref('Timestamp'), "updatedAt": Type.Ref('Timestamp'), "schema": Type.Ref('SchemaRef'), "payload": JsonValue, "fingerprint": Type.Ref('Digest') }, { additionalProperties: false }),
  "MaintenanceMutation": Type.Object({ "recordId": Type.Ref('Id'), "expectedRevision": Type.Union([Type.Ref('UInt53'), Type.Null()]), "next": Type.Ref('MaintenanceEnvelopeJsonValue') }, { additionalProperties: false }),
  "MigrationTarget": Type.Union([Type.Object({ "kind": Type.Literal('run-state'), "runId": Type.Ref('Id'), "sourceBindingId": Type.Ref('Id'), "targetBindingId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('state-authority'), "source": Type.Ref('StateAuthorityRef'), "targetProviderLock": Type.Ref('DataRef'), "targetLocationRef": Type.Ref('Id'), "cohortRef": Type.Ref('DataRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('directory'), "sourceLocatorRevision": Type.Ref('UInt53'), "targetProviderLock": Type.Ref('DataRef'), "targetLocationRef": Type.Ref('Id'), "externalJournalRef": Type.Ref('Id') }, { additionalProperties: false })]),
  "MigrationRequest": Type.Object({ "upgradeId": Type.Ref('Id'), "target": Type.Ref('MigrationTarget'), "policyRef": Type.Ref('Id'), "reason": Type.String(), "mode": Type.Union([Type.Literal('inspect-only'), Type.Literal('auto-compatible'), Type.Literal('explicit')]) }, { additionalProperties: false }),
  "AuthorityCheckpoint": Type.Object({ "authorityId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53'), "checkpointId": Type.Ref('Id'), "snapshotDigest": Type.Ref('Digest'), "recordCount": Type.Ref('UInt53'), "bridgeWatermarks": Type.Array(Type.Object({ "bridgeId": Type.Ref('Id'), "producedThrough": Type.Ref('UInt53'), "acceptedThrough": Type.Ref('UInt53') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "UpgradeExpectedHeads": Type.Union([Type.Object({ "kind": Type.Literal('release'), "routeId": Type.Ref('Id'), "routeRevision": Type.Ref('UInt53'), "releaseSetId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('run-state'), "runId": Type.Ref('Id'), "runRevision": Type.Ref('UInt53'), "writerEpoch": Type.Ref('UInt53'), "bindingId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('state-authority'), "authority": Type.Ref('StateAuthorityRef'), "routeRevision": Type.Ref('UInt53'), "cohortDigest": Type.Ref('Digest'), "checkpoints": Type.Array(Type.Ref('AuthorityCheckpoint'), { maxItems: 10000 }) }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('directory'), "locatorId": Type.Ref('Id'), "locatorRevision": Type.Ref('UInt53'), "directoryEpoch": Type.Ref('UInt53') }, { additionalProperties: false })]),
  "MigrationInvariants": Type.Object({ "publicFacts": Type.Literal('identical'), "effectIdentity": Type.Literal('identical'), "accounting": Type.Literal('identical'), "pendingOwnership": Type.Literal('preserved-or-explicit-alias'), "unconsumedSignals": Type.Literal('preserved'), "deletionAndRevocation": Type.Literal('current'), "lineage": Type.Literal('identical'), "additionalChecks": Type.Array(Type.Object({ "checkId": Type.Ref('Id'), "schema": Type.Ref('SchemaRef'), "expected": Type.Ref('DataRef') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "MigrationPlan": Type.Object({ "planId": Type.Ref('Id'), "upgradeId": Type.Ref('Id'), "request": Type.Ref('MigrationRequest'), "planFingerprint": Type.Ref('Digest'), "sourceHeads": Type.Ref('UpgradeExpectedHeads'), "migratorLock": Type.Ref('DataRef'), "validatorLocks": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "requiredPins": Type.Array(Type.Ref('Id'), { maxItems: 10000 }), "requiredCapabilities": Type.Array(Type.String(), { maxItems: 10000 }), "invariants": Type.Ref('MigrationInvariants'), "resourceBudgetRef": Type.Ref('Id'), "expiresAt": Type.Ref('Timestamp'), "eligibility": Type.Union([Type.Literal('eligible'), Type.Literal('retain-source'), Type.Literal('wait-safe-point'), Type.Literal('blocked')]), "reasonCodes": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }),
  "MigrationReceipt": Type.Object({ "upgradeId": Type.Ref('Id'), "state": Type.Union([Type.Literal('planned'), Type.Literal('preparing'), Type.Literal('verified'), Type.Literal('cutting-over'), Type.Literal('committed'), Type.Literal('draining'), Type.Literal('completed'), Type.Literal('aborted'), Type.Literal('blocked')]), "checkpointRevision": Type.Ref('UInt53'), "cutoverId": Type.Union([Type.Ref('Id'), Type.Null()]), "commitRef": Type.Union([Type.Ref('Id'), Type.Null()]), "diagnosticIds": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "UpgradeCheckpoint": Type.Object({ "key": Type.String(), "inputDigest": Type.Ref('Digest'), "evidence": Type.Array(Type.Ref('DataRef'), { maxItems: 10000 }), "completedAt": Type.Ref('Timestamp') }, { additionalProperties: false }),
  "MigrationCandidate": Type.Object({ "upgradeId": Type.Ref('Id'), "planFingerprint": Type.Ref('Digest'), "sourceHeads": Type.Ref('UpgradeExpectedHeads'), "sourceSnapshotDigest": Type.Ref('Digest'), "targetDigest": Type.Ref('Digest'), "conversion": Type.Union([Type.Null(), Type.Object({ "migratorBinding": Type.Ref('BindingRef'), "inputCodec": Type.Ref('SchemaRef'), "outputCodec": Type.Ref('SchemaRef') }, { additionalProperties: false })]), "content": Type.Ref('DataRef'), "requiredPins": Type.Array(Type.Ref('Id'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "MigrationValidation": Type.Object({ "upgradeId": Type.Ref('Id'), "planFingerprint": Type.Ref('Digest'), "candidateDigest": Type.Ref('Digest'), "sourceSnapshotDigest": Type.Ref('Digest'), "checkedAt": Type.Ref('Timestamp'), "checks": Type.Array(Type.Object({ "checkId": Type.Ref('Id'), "passed": Type.Boolean(), "evidence": Type.Ref('DataRef') }, { additionalProperties: false }), { maxItems: 10000 }), "validatorBindings": Type.Array(Type.Ref('BindingRef'), { maxItems: 10000 }), "accepted": Type.Boolean() }, { additionalProperties: false }),
  "AuthorityFence": Type.Object({ "upgradeId": Type.Ref('Id'), "source": Type.Ref('StateAuthorityRef'), "fenceId": Type.Ref('Id'), "fenceEpoch": Type.Ref('UInt53'), "checkpoint": Type.Ref('AuthorityCheckpoint'), "writerCredentialsRevoked": Type.Boolean() }, { additionalProperties: false }),
  "AuthorityExport": Type.Object({ "upgradeId": Type.Ref('Id'), "fenceId": Type.Ref('Id'), "checkpoint": Type.Ref('AuthorityCheckpoint'), "collectionCount": Type.Ref('UInt53'), "partCount": Type.Ref('UInt53'), "manifestRoot": Type.Ref('DataRef'), "requiredAssetsRoot": Type.Ref('DataRef'), "deletionWatermark": Type.Ref('UInt53') }, { additionalProperties: false }),
  "AuthorityExportPart": Type.Object({ "collectionId": Type.Ref('Id'), "schema": Type.Ref('SchemaRef'), "partIndex": Type.Ref('UInt53'), "firstRecordKey": Type.Ref('Id'), "lastRecordKey": Type.Ref('Id'), "records": Type.Ref('UInt53'), "contentDigest": Type.Ref('Digest'), "chunk": Type.Ref('BlobRef') }, { additionalProperties: false }),
  "AuthorityTransferProbe": Type.Union([Type.Object({ "state": Type.Literal('absent') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('fenced'), "fence": Type.Ref('AuthorityFence') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('imported'), "fence": Type.Ref('AuthorityFence'), "exportDigest": Type.Ref('Digest'), "targetCheckpoint": Type.Ref('AuthorityCheckpoint') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('activated'), "cutoverId": Type.Ref('Id'), "authority": Type.Ref('StateAuthorityRef'), "checkpoint": Type.Ref('AuthorityCheckpoint') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('aborted'), "source": Type.Ref('StateAuthorityRef'), "restoredEpoch": Type.Ref('UInt53') }, { additionalProperties: false })]),
  "AuthorityRoute": Type.Object({ "logicalAuthorityId": Type.Ref('Id'), "tenantId": Type.Ref('Id'), "authorityEpoch": Type.Ref('UInt53'), "providerBinding": Type.Ref('BindingRef'), "locationRef": Type.Ref('Id'), "cohortDigest": Type.Ref('Digest'), "cutoverId": Type.Ref('Id'), "checkpoint": Type.Ref('AuthorityCheckpoint'), "previous": Type.Union([Type.Null(), Type.Object({ "authorityEpoch": Type.Ref('UInt53'), "locationRef": Type.Ref('Id'), "cutoverId": Type.Ref('Id') }, { additionalProperties: false })]) }, { additionalProperties: false }),
  "JointDispatchMigrationMapping": Type.Object({ "domainId": Type.Ref('Id'), "from": Type.Ref('DispatchAtomicDomain'), "to": Type.Ref('DispatchAtomicDomain'), "cohortDigest": Type.Ref('Digest'), "validationRef": Type.Ref('DataRef') }, { additionalProperties: false }),
  "AuthorityDirectoryReadRequest": Type.Union([Type.Object({ "kind": Type.Literal('authority'), "logicalAuthorityId": Type.Ref('Id') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('joint-dispatch'), "domainId": Type.Ref('Id'), "from": Type.Ref('DispatchAtomicDomain') }, { additionalProperties: false })]),
  "AuthorityDirectoryReadResult": Type.Union([Type.Object({ "kind": Type.Literal('authority'), "route": Type.Ref('AuthorityRoute'), "revision": Type.Ref('UInt53'), "epoch": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('joint-dispatch'), "resolution": Type.Union([Type.Object({ "state": Type.Literal('unmapped') }, { additionalProperties: false }), Type.Object({ "state": Type.Literal('mapped'), "qualification": Type.Ref('DispatchAtomicDomain'), "revision": Type.Ref('UInt53'), "validationRef": Type.Ref('DataRef') }, { additionalProperties: false })]) }, { additionalProperties: false })]),
  "AuthorityPublication": Type.Object({ "upgradeId": Type.Ref('Id'), "cutoverId": Type.Ref('Id'), "changes": Type.Array(Type.Object({ "expectedRevision": Type.Ref('UInt53'), "previous": Type.Ref('AuthorityRoute'), "next": Type.Ref('AuthorityRoute') }, { additionalProperties: false }), { minItems: 1, maxItems: 10000 }), "sourceFences": Type.Array(Type.Ref('AuthorityFence'), { maxItems: 10000 }), "validationRef": Type.Ref('DataRef'), "jointDispatchMappings": Type.Array(Type.Ref('JointDispatchMigrationMapping'), { maxItems: 10000 }) }, { additionalProperties: false }),
  "AuthorizedViewScope": Type.Union([Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "kind": Type.Literal('workspace') }, { additionalProperties: false }), Type.Object({ "installationId": Type.Ref('Id'), "runtimeId": Type.Ref('Id'), "workspaceId": Type.Ref('Id'), "sessionId": Type.Ref('Id'), "kind": Type.Literal('session') }, { additionalProperties: false })]),
  "ArtifactTitle": Object.assign(Type.String({ minLength: 1, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }), {"x-max-utf8-bytes":1024}),
  "ArtifactMediaType": Object.assign(Type.String({ pattern: "^[a-z0-9][a-z0-9!#$&^_.+\\-]*/[a-z0-9][a-z0-9!#$&^_.+\\-]*$" }), {"x-max-utf8-bytes":255}),
  "ArtifactReservedView": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "title": Type.Union([Type.Ref('ArtifactTitle'), Type.Null()]), "mime": Type.Union([Type.Ref('ArtifactMediaType'), Type.Null()]), "size": Type.Null(), "status": Type.Literal('reserved') }, { additionalProperties: false }),
  "ArtifactPendingPublishView": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "title": Type.Ref('ArtifactTitle'), "mime": Type.Ref('ArtifactMediaType'), "size": Type.Ref('UInt53'), "status": Type.Literal('pending-publish') }, { additionalProperties: false }),
  "ArtifactReadyView": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "title": Type.Ref('ArtifactTitle'), "mime": Type.Ref('ArtifactMediaType'), "size": Type.Ref('UInt53'), "status": Type.Literal('ready') }, { additionalProperties: false }),
  "ArtifactFailedView": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "title": Type.Union([Type.Ref('ArtifactTitle'), Type.Null()]), "mime": Type.Union([Type.Ref('ArtifactMediaType'), Type.Null()]), "size": Type.Union([Type.Ref('UInt53'), Type.Null()]), "status": Type.Literal('failed') }, { additionalProperties: false }),
  "ArtifactRevokedView": Type.Object({ "artifactId": Type.Ref('Id'), "version": Type.Ref('ArtifactVersion'), "title": Type.Union([Type.Ref('ArtifactTitle'), Type.Null()]), "mime": Type.Union([Type.Ref('ArtifactMediaType'), Type.Null()]), "size": Type.Union([Type.Ref('UInt53'), Type.Null()]), "status": Type.Literal('revoked') }, { additionalProperties: false }),
  "ArtifactViewRef": Type.Union([Type.Ref('ArtifactReservedView'), Type.Ref('ArtifactPendingPublishView'), Type.Ref('ArtifactReadyView'), Type.Ref('ArtifactFailedView'), Type.Ref('ArtifactRevokedView')]),
  "ViewActionBase": Type.Object({ "actionKey": Type.String(), "label": Type.String(), "requiredFeatures": Type.Array(Type.String(), { maxItems: 10000 }), "availability": Type.Union([Type.Literal('enabled'), Type.Literal('disabled')]), "disabledReason": Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
  "ViewAction": Type.Union([Type.Object({ "actionKey": Type.String(), "label": Type.String(), "requiredFeatures": Type.Array(Type.String(), { maxItems: 10000 }), "availability": Type.Union([Type.Literal('enabled'), Type.Literal('disabled')]), "disabledReason": Type.Union([Type.String(), Type.Null()]), "kind": Type.Literal('command'), "command": Type.String(), "inputSchema": Type.Ref('SchemaRef') }, { additionalProperties: false }), Type.Object({ "actionKey": Type.String(), "label": Type.String(), "requiredFeatures": Type.Array(Type.String(), { maxItems: 10000 }), "availability": Type.Union([Type.Literal('enabled'), Type.Literal('disabled')]), "disabledReason": Type.Union([Type.String(), Type.Null()]), "kind": Type.Literal('interaction'), "interactionId": Type.String(), "version": Type.Number() }, { additionalProperties: false }), Type.Object({ "actionKey": Type.String(), "label": Type.String(), "requiredFeatures": Type.Array(Type.String(), { maxItems: 10000 }), "availability": Type.Union([Type.Literal('enabled'), Type.Literal('disabled')]), "disabledReason": Type.Union([Type.String(), Type.Null()]), "kind": Type.Literal('download'), "artifactId": Type.String(), "version": Type.Number() }, { additionalProperties: false }), Type.Object({ "actionKey": Type.String(), "label": Type.String(), "requiredFeatures": Type.Array(Type.String(), { maxItems: 10000 }), "availability": Type.Union([Type.Literal('enabled'), Type.Literal('disabled')]), "disabledReason": Type.Union([Type.String(), Type.Null()]), "kind": Type.Literal('open-form'), "interactionId": Type.String(), "version": Type.Number() }, { additionalProperties: false })]),
  "DomainView": Type.Object({ "kind": Type.Literal('domain'), "viewId": Type.String(), "revision": Type.Number(), "domainType": Type.String(), "viewSchema": Type.Ref('SchemaRef'), "renderKey": Type.String(), "scope": Type.Ref('AuthorizedViewScope'), "source": Type.Object({ "eventIds": Type.Array(Type.String(), { maxItems: 10000 }), "projectionRevision": Type.Number() }, { additionalProperties: false }), "phase": Type.Union([Type.Literal('provisional'), Type.Literal('finalized'), Type.Literal('interrupted')]), "stream": Type.Optional(Type.Object({ "streamId": Type.String(), "generation": Type.Number(), "revision": Type.Number() }, { additionalProperties: false })), "fallbackText": Object.assign(Type.String({ maxLength: 4096 }), {"x-max-utf8-bytes":4096}), "data": JsonValue, "resources": Type.Array(Type.Ref('ArtifactViewRef'), { maxItems: 32 }), "actions": Type.Array(Type.Ref('ViewAction'), { maxItems: 32 }) }, { additionalProperties: false }),
  "DomainEventIntent": Type.Object({ "typeId": Type.String(), "schema": Type.Ref('SchemaRef'), "payload": Type.Ref('DataRef'), "idempotencyKey": Type.String() }, { additionalProperties: false }),
  "DomainQuery": Type.Object({ "domainType": Type.String(), "query": Type.Ref('DataRef'), "scope": Type.Ref('ScopeRef'), "cursor": Type.Union([Type.String(), Type.Null()]), "limit": Type.Integer({ minimum: 1, maximum: 500 }) }, { additionalProperties: false }),
  "ProjectionSnapshot": Type.Object({ "items": Type.Array(Type.Ref('DomainView'), { maxItems: 10000 }), "cursor": Type.String(), "projectionRevision": Type.Ref('UInt53'), "nextPageCursor": Type.Union([Type.String(), Type.Null()]), "complete": Type.Boolean() }, { additionalProperties: false }),
  "DomainViewChange": Type.Union([Type.Object({ "kind": Type.Literal('upsert'), "view": Type.Ref('DomainView') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('remove'), "viewId": Type.String(), "revision": Type.Ref('UInt53'), "reason": Type.String() }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('reset'), "snapshot": Type.Ref('ProjectionSnapshot') }, { additionalProperties: false })]),
  "ProjectionChange": Type.Ref('DomainViewChange'),
  "ProjectionChanges": Type.Object({ "changes": Type.Array(Type.Ref('DomainViewChange'), { maxItems: 10000 }), "cursor": Type.String(), "hasMore": Type.Boolean() }, { additionalProperties: false }),
  "DomainDispatch": Type.Union([Type.Object({ "key": Type.String(), "kind": Type.Literal('start-run'), "presetId": Type.String(), "presetDigest": Type.Ref('Digest'), "input": Type.Ref('DataRef') }, { additionalProperties: false }), Type.Object({ "key": Type.String(), "kind": Type.Literal('signal'), "runId": Type.String(), "typeId": Type.String(), "schema": Type.Ref('SchemaRef'), "payload": Type.Ref('DataRef') }, { additionalProperties: false })]),
  "DomainActionRef": Type.Object({ "viewId": Type.String(), "actionKey": Type.String(), "viewRevision": Type.Number() }, { additionalProperties: false }),
  "DomainCommandFrame": Type.Object({ "commandId": Type.String(), "requestId": Type.String(), "name": Type.String(), "input": Type.Ref('DataRef'), "state": Type.Union([Type.Ref('DataRef'), Type.Null()]), "stateRevision": Type.Number(), "expectedRevision": Type.Number(), "sourceView": Type.Ref('DomainActionRef'), "observedAt": Type.Ref('Timestamp'), "context": Type.Ref('CallContextWire'), "commandSchema": Type.Ref('SchemaRef') }, { additionalProperties: false }),
  "DomainCommandPlan": Type.Object({ "expectedRevision": Type.Number(), "state": Type.Ref('DataRef'), "events": Type.Array(Type.Ref('DomainEventIntent'), { maxItems: 10000 }), "dispatches": Type.Array(Type.Ref('DomainDispatch'), { maxItems: 10000 }), "result": Type.Ref('DataRef') }, { additionalProperties: false }),
  "CommandRuntimeAcceptanceSchemaRef": Type.Object({ "typeId": Type.Literal('agh.domain/command-runtime-acceptance-result@1'), "revision": Type.Literal(1), "digest": Type.Ref('Digest') }, { additionalProperties: false }),
  "CommandRuntimeAcceptanceResult": Type.Object({ "value": Type.Union([Type.Ref('DataRef'), Type.Null()]), "deliveries": Type.Array(Type.Object({ "deliveryId": Type.Ref('Id'), "runtimeRef": Type.Ref('PublicRef') }, { additionalProperties: false }), { maxItems: 10000 }) }, { additionalProperties: false }),
  "CommandRuntimeAcceptanceDataRef": Type.Union([Type.Object({ "kind": Type.Literal('inline'), "schema": Type.Ref('CommandRuntimeAcceptanceSchemaRef'), "value": Type.Ref('CommandRuntimeAcceptanceResult'), "digest": Type.Ref('Digest'), "bytes": Type.Ref('UInt53') }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('blob'), "schema": Type.Ref('CommandRuntimeAcceptanceSchemaRef'), "blob": Type.Ref('BlobRef') }, { additionalProperties: false })]),
  "CommandHandle": Type.Union([Type.Object({ "commandId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "revision": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "completion": Type.Union([Type.Literal('domain-commit'), Type.Literal('runtime-accepted')]), "status": Type.Literal('accepted'), "result": Type.Null(), "error": Type.Null() }, { additionalProperties: false }), Type.Object({ "commandId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "revision": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "completion": Type.Union([Type.Literal('domain-commit'), Type.Literal('runtime-accepted')]), "status": Type.Literal('running'), "result": Type.Null(), "error": Type.Null() }, { additionalProperties: false }), Type.Object({ "commandId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "revision": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "completion": Type.Literal('domain-commit'), "status": Type.Literal('succeeded'), "result": Type.Union([Type.Ref('DataRef'), Type.Null()]), "error": Type.Null() }, { additionalProperties: false }), Type.Object({ "commandId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "revision": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "completion": Type.Literal('runtime-accepted'), "status": Type.Literal('succeeded'), "result": Type.Ref('CommandRuntimeAcceptanceDataRef'), "error": Type.Null() }, { additionalProperties: false }), Type.Object({ "commandId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "revision": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "completion": Type.Union([Type.Literal('domain-commit'), Type.Literal('runtime-accepted')]), "status": Type.Literal('failed'), "result": Type.Union([Type.Ref('DataRef'), Type.Null()]), "error": Type.Ref('RuntimeError') }, { additionalProperties: false }), Type.Object({ "commandId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "revision": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "completion": Type.Union([Type.Literal('domain-commit'), Type.Literal('runtime-accepted')]), "status": Type.Literal('cancelled'), "result": Type.Union([Type.Ref('DataRef'), Type.Null()]), "error": Type.Union([Type.Ref('RuntimeError'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "commandId": Type.Ref('Id'), "requestId": Type.Ref('Id'), "revision": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "completion": Type.Union([Type.Literal('domain-commit'), Type.Literal('runtime-accepted')]), "status": Type.Literal('unknown_effect'), "result": Type.Union([Type.Ref('DataRef'), Type.Null()]), "error": Type.Union([Type.Ref('RuntimeError'), Type.Null()]) }, { additionalProperties: false }), Type.Object({ "requestId": Type.Ref('Id'), "status": Type.Literal('not-accepted'), "commandId": Type.Null(), "revision": Type.Null(), "completion": Type.Null(), "result": Type.Null(), "error": Type.Null() }, { additionalProperties: false })]),
  "TextPart": Type.Union([Type.Object({ "kind": Type.Literal('text'), "text": Type.String() }, { additionalProperties: false }), Type.Object({ "kind": Type.Literal('action'), "actionKey": Type.String(), "label": Type.String() }, { additionalProperties: false })]),
  "FormattedView": Type.Object({ "viewId": Type.String(), "revision": Type.Number(), "parts": Type.Array(Type.Ref('TextPart'), { maxItems: 10000 }), "complete": Type.Boolean(), "unsupportedRequiredFeatures": Type.Array(Type.String(), { maxItems: 10000 }) }, { additionalProperties: false }),
  "ShellViewState": Type.Object({ "schema": Type.Ref('SchemaRef'), "data": JsonValue }, { additionalProperties: false }),
  "DomainTimelineEntry": Type.Object({ "kind": Type.Literal('domain'), "id": Type.String(), "view": Type.Ref('DomainView'), "turnId": Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
})

export const Id = RuntimePublic8.Import('Id')
export type Id = Static<typeof Id>
export const UInt53 = RuntimePublic8.Import('UInt53')
export type UInt53 = Static<typeof UInt53>
export const Timestamp = RuntimePublic8.Import('Timestamp')
export type Timestamp = Static<typeof Timestamp>
export const TypeId = RuntimePublic8.Import('TypeId')
export type TypeId = Static<typeof TypeId>
export const Digest = RuntimePublic8.Import('Digest')
export type Digest = Static<typeof Digest>
export const SchemaRef = RuntimePublic8.Import('SchemaRef')
export type SchemaRef = Static<typeof SchemaRef>
export const BlobRef = RuntimePublic8.Import('BlobRef')
export type BlobRef = Static<typeof BlobRef>
export const DataRef = RuntimePublic8.Import('DataRef')
export type DataRef = Static<typeof DataRef>
export const RuntimeErrorCode = RuntimePublic8.Import('RuntimeErrorCode')
export type RuntimeErrorCode = Static<typeof RuntimeErrorCode>
export const OwnerRef = RuntimePublic8.Import('OwnerRef')
export type OwnerRef = Static<typeof OwnerRef>
export const RetryAdvice = RuntimePublic8.Import('RetryAdvice')
export type RetryAdvice = Static<typeof RetryAdvice>
export const RuntimeError = RuntimePublic8.Import('RuntimeError')
export type RuntimeError = Static<typeof RuntimeError>
export const BindingRef = RuntimePublic8.Import('BindingRef')
export type BindingRef = Static<typeof BindingRef>
export const StateCommitReceipt = RuntimePublic8.Import('StateCommitReceipt')
export type StateCommitReceipt = Static<typeof StateCommitReceipt>
export const StateAuthorityRef = RuntimePublic8.Import('StateAuthorityRef')
export type StateAuthorityRef = Static<typeof StateAuthorityRef>
export const ScopeRef = RuntimePublic8.Import('ScopeRef')
export type ScopeRef = Static<typeof ScopeRef>
export const DomainReference = RuntimePublic8.Import('DomainReference')
export type DomainReference = Static<typeof DomainReference>
export const CallContextWire = RuntimePublic8.Import('CallContextWire')
export type CallContextWire = Static<typeof CallContextWire>
export const DispatchAtomicDomain = RuntimePublic8.Import('DispatchAtomicDomain')
export type DispatchAtomicDomain = Static<typeof DispatchAtomicDomain>
export const SnapshotRef = RuntimePublic8.Import('SnapshotRef')
export type SnapshotRef = Static<typeof SnapshotRef>
export const ResourceRef = RuntimePublic8.Import('ResourceRef')
export type ResourceRef = Static<typeof ResourceRef>
export const ArtifactVersion = RuntimePublic8.Import('ArtifactVersion')
export type ArtifactVersion = Static<typeof ArtifactVersion>
export const ArtifactRef = RuntimePublic8.Import('ArtifactRef')
export type ArtifactRef = Static<typeof ArtifactRef>
export const Revision = RuntimePublic8.Import('Revision')
export type Revision = Static<typeof Revision>
export const DomainObjectRef = RuntimePublic8.Import('DomainObjectRef')
export type DomainObjectRef = Static<typeof DomainObjectRef>
export const SessionRef = RuntimePublic8.Import('SessionRef')
export type SessionRef = Static<typeof SessionRef>
export const RunRef = RuntimePublic8.Import('RunRef')
export type RunRef = Static<typeof RunRef>
export const InteractionRef = RuntimePublic8.Import('InteractionRef')
export type InteractionRef = Static<typeof InteractionRef>
export const PublicBlobReference = RuntimePublic8.Import('PublicBlobReference')
export type PublicBlobReference = Static<typeof PublicBlobReference>
export const UploadSession = RuntimePublic8.Import('UploadSession')
export type UploadSession = Static<typeof UploadSession>
export const PublicUploadReference = RuntimePublic8.Import('PublicUploadReference')
export type PublicUploadReference = Static<typeof PublicUploadReference>
export const StagedBlobRef = RuntimePublic8.Import('StagedBlobRef')
export type StagedBlobRef = Static<typeof StagedBlobRef>
export const PublicStagedBlobReference = RuntimePublic8.Import('PublicStagedBlobReference')
export type PublicStagedBlobReference = Static<typeof PublicStagedBlobReference>
export const PublicRef = RuntimePublic8.Import('PublicRef')
export type PublicRef = Static<typeof PublicRef>
export const Cursor = RuntimePublic8.Import('Cursor')
export type Cursor = Static<typeof Cursor>
export const PreparedActionAdmissionProbe = RuntimePublic8.Import('PreparedActionAdmissionProbe')
export type PreparedActionAdmissionProbe = Static<typeof PreparedActionAdmissionProbe>
export const MigrationToken = RuntimePublic8.Import('MigrationToken')
export type MigrationToken = Static<typeof MigrationToken>
export const MigrationProbe = RuntimePublic8.Import('MigrationProbe')
export type MigrationProbe = Static<typeof MigrationProbe>
export const StateScanRequest = RuntimePublic8.Import('StateScanRequest')
export type StateScanRequest = Static<typeof StateScanRequest>
export const ChildCreateRequest = RuntimePublic8.Import('ChildCreateRequest')
export type ChildCreateRequest = Static<typeof ChildCreateRequest>
export const StreamRegistration = RuntimePublic8.Import('StreamRegistration')
export type StreamRegistration = Static<typeof StreamRegistration>
export const RuntimeFormatData = RuntimePublic8.Import('RuntimeFormatData')
export type RuntimeFormatData = Static<typeof RuntimeFormatData>
export const RuntimeCommitData = RuntimePublic8.Import('RuntimeCommitData')
export type RuntimeCommitData = Static<typeof RuntimeCommitData>
export const InboxRecord = RuntimePublic8.Import('InboxRecord')
export type InboxRecord = Static<typeof InboxRecord>
export const MaintenanceEnvelopeJsonValue = RuntimePublic8.Import('MaintenanceEnvelopeJsonValue')
export type MaintenanceEnvelopeJsonValue = Static<typeof MaintenanceEnvelopeJsonValue>
export const MaintenanceMutation = RuntimePublic8.Import('MaintenanceMutation')
export type MaintenanceMutation = Static<typeof MaintenanceMutation>
export const MigrationTarget = RuntimePublic8.Import('MigrationTarget')
export type MigrationTarget = Static<typeof MigrationTarget>
export const MigrationRequest = RuntimePublic8.Import('MigrationRequest')
export type MigrationRequest = Static<typeof MigrationRequest>
export const AuthorityCheckpoint = RuntimePublic8.Import('AuthorityCheckpoint')
export type AuthorityCheckpoint = Static<typeof AuthorityCheckpoint>
export const UpgradeExpectedHeads = RuntimePublic8.Import('UpgradeExpectedHeads')
export type UpgradeExpectedHeads = Static<typeof UpgradeExpectedHeads>
export const MigrationInvariants = RuntimePublic8.Import('MigrationInvariants')
export type MigrationInvariants = Static<typeof MigrationInvariants>
export const MigrationPlan = RuntimePublic8.Import('MigrationPlan')
export type MigrationPlan = Static<typeof MigrationPlan>
export const MigrationReceipt = RuntimePublic8.Import('MigrationReceipt')
export type MigrationReceipt = Static<typeof MigrationReceipt>
export const UpgradeCheckpoint = RuntimePublic8.Import('UpgradeCheckpoint')
export type UpgradeCheckpoint = Static<typeof UpgradeCheckpoint>
export const MigrationCandidate = RuntimePublic8.Import('MigrationCandidate')
export type MigrationCandidate = Static<typeof MigrationCandidate>
export const MigrationValidation = RuntimePublic8.Import('MigrationValidation')
export type MigrationValidation = Static<typeof MigrationValidation>
export const AuthorityFence = RuntimePublic8.Import('AuthorityFence')
export type AuthorityFence = Static<typeof AuthorityFence>
export const AuthorityExport = RuntimePublic8.Import('AuthorityExport')
export type AuthorityExport = Static<typeof AuthorityExport>
export const AuthorityExportPart = RuntimePublic8.Import('AuthorityExportPart')
export type AuthorityExportPart = Static<typeof AuthorityExportPart>
export const AuthorityTransferProbe = RuntimePublic8.Import('AuthorityTransferProbe')
export type AuthorityTransferProbe = Static<typeof AuthorityTransferProbe>
export const AuthorityRoute = RuntimePublic8.Import('AuthorityRoute')
export type AuthorityRoute = Static<typeof AuthorityRoute>
export const JointDispatchMigrationMapping = RuntimePublic8.Import('JointDispatchMigrationMapping')
export type JointDispatchMigrationMapping = Static<typeof JointDispatchMigrationMapping>
export const AuthorityDirectoryReadRequest = RuntimePublic8.Import('AuthorityDirectoryReadRequest')
export type AuthorityDirectoryReadRequest = Static<typeof AuthorityDirectoryReadRequest>
export const AuthorityDirectoryReadResult = RuntimePublic8.Import('AuthorityDirectoryReadResult')
export type AuthorityDirectoryReadResult = Static<typeof AuthorityDirectoryReadResult>
export const AuthorityPublication = RuntimePublic8.Import('AuthorityPublication')
export type AuthorityPublication = Static<typeof AuthorityPublication>
export const AuthorizedViewScope = RuntimePublic8.Import('AuthorizedViewScope')
export type AuthorizedViewScope = Static<typeof AuthorizedViewScope>
export const ArtifactTitle = RuntimePublic8.Import('ArtifactTitle')
export type ArtifactTitle = Static<typeof ArtifactTitle>
export const ArtifactMediaType = RuntimePublic8.Import('ArtifactMediaType')
export type ArtifactMediaType = Static<typeof ArtifactMediaType>
export const ArtifactReservedView = RuntimePublic8.Import('ArtifactReservedView')
export type ArtifactReservedView = Static<typeof ArtifactReservedView>
export const ArtifactPendingPublishView = RuntimePublic8.Import('ArtifactPendingPublishView')
export type ArtifactPendingPublishView = Static<typeof ArtifactPendingPublishView>
export const ArtifactReadyView = RuntimePublic8.Import('ArtifactReadyView')
export type ArtifactReadyView = Static<typeof ArtifactReadyView>
export const ArtifactFailedView = RuntimePublic8.Import('ArtifactFailedView')
export type ArtifactFailedView = Static<typeof ArtifactFailedView>
export const ArtifactRevokedView = RuntimePublic8.Import('ArtifactRevokedView')
export type ArtifactRevokedView = Static<typeof ArtifactRevokedView>
export const ArtifactViewRef = RuntimePublic8.Import('ArtifactViewRef')
export type ArtifactViewRef = Static<typeof ArtifactViewRef>
export const ViewActionBase = RuntimePublic8.Import('ViewActionBase')
export type ViewActionBase = Static<typeof ViewActionBase>
export const ViewAction = RuntimePublic8.Import('ViewAction')
export type ViewAction = Static<typeof ViewAction>
export const DomainView = RuntimePublic8.Import('DomainView')
export type DomainView = Static<typeof DomainView>
export const DomainEventIntent = RuntimePublic8.Import('DomainEventIntent')
export type DomainEventIntent = Static<typeof DomainEventIntent>
export const DomainQuery = RuntimePublic8.Import('DomainQuery')
export type DomainQuery = Static<typeof DomainQuery>
export const ProjectionSnapshot = RuntimePublic8.Import('ProjectionSnapshot')
export type ProjectionSnapshot = Static<typeof ProjectionSnapshot>
export const DomainViewChange = RuntimePublic8.Import('DomainViewChange')
export type DomainViewChange = Static<typeof DomainViewChange>
export const ProjectionChange = RuntimePublic8.Import('ProjectionChange')
export type ProjectionChange = Static<typeof ProjectionChange>
export const ProjectionChanges = RuntimePublic8.Import('ProjectionChanges')
export type ProjectionChanges = Static<typeof ProjectionChanges>
export const DomainDispatch = RuntimePublic8.Import('DomainDispatch')
export type DomainDispatch = Static<typeof DomainDispatch>
export const DomainActionRef = RuntimePublic8.Import('DomainActionRef')
export type DomainActionRef = Static<typeof DomainActionRef>
export const DomainCommandFrame = RuntimePublic8.Import('DomainCommandFrame')
export type DomainCommandFrame = Static<typeof DomainCommandFrame>
export const DomainCommandPlan = RuntimePublic8.Import('DomainCommandPlan')
export type DomainCommandPlan = Static<typeof DomainCommandPlan>
export const CommandRuntimeAcceptanceSchemaRef = RuntimePublic8.Import('CommandRuntimeAcceptanceSchemaRef')
export type CommandRuntimeAcceptanceSchemaRef = Static<typeof CommandRuntimeAcceptanceSchemaRef>
export const CommandRuntimeAcceptanceResult = RuntimePublic8.Import('CommandRuntimeAcceptanceResult')
export type CommandRuntimeAcceptanceResult = Static<typeof CommandRuntimeAcceptanceResult>
export const CommandRuntimeAcceptanceDataRef = RuntimePublic8.Import('CommandRuntimeAcceptanceDataRef')
export type CommandRuntimeAcceptanceDataRef = Static<typeof CommandRuntimeAcceptanceDataRef>
export const CommandHandle = RuntimePublic8.Import('CommandHandle')
export type CommandHandle = Static<typeof CommandHandle>
export const TextPart = RuntimePublic8.Import('TextPart')
export type TextPart = Static<typeof TextPart>
export const FormattedView = RuntimePublic8.Import('FormattedView')
export type FormattedView = Static<typeof FormattedView>
export const ShellViewState = RuntimePublic8.Import('ShellViewState')
export type ShellViewState = Static<typeof ShellViewState>
export const DomainTimelineEntry = RuntimePublic8.Import('DomainTimelineEntry')
export type DomainTimelineEntry = Static<typeof DomainTimelineEntry>
