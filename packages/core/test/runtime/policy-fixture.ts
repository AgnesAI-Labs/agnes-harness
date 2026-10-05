import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type AuthorSchema,
  type CallContext,
  defineGeneratedAuthorSchema,
  type EmptyAuthorConfig,
  type FactoryContext,
  type Outcome,
  type ProviderFactory,
  type ScopedDependencies,
  type ServiceProvider,
} from '@agnes/extension-api/runtime'
import {
  type ApprovalGrantRecord,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  MAX_AUTHOR_INLINE_BYTES,
  type OwnerRef,
  type PermissionClientRevokeGrantRequest,
  type PolicyEvaluateRequest,
  type ProviderDescriptor,
  RuntimeAuthorCodecPolicy,
  RuntimeMethodSchemaRefs,
  type ServiceOperation,
  type ServiceQuery,
} from '@agnes/protocol/runtime'
import type { PolicyAuthority, VerifiedPolicyEvaluation } from '../../src/runtime/policy/authority.js'
import type { PreparedPolicyEvidence } from '../../src/runtime/policy/decision-composition.js'
import { encodePolicyValue, policyFailure } from '../../src/runtime/policy/wire.js'

export const digest = 'a'.repeat(64)
export const now = '2026-10-01T00:00:00Z'
export const until = '2026-10-01T01:00:00Z'
export const configCodec = defineGeneratedAuthorSchema<EmptyAuthorConfig>({
  ownerPackageId: 'agnes-policy-test',
  name: 'PolicyConfig',
  typeId: 'agnes-policy-test/policy-config@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/PolicyConfig',
    $defs: { PolicyConfig: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  },
})
export const scope = {
  kind: 'action',
  installationId: 'install',
  runtimeId: 'runtime',
  workspaceId: 'workspace',
  sessionId: 'session',
  runId: 'run',
  actionId: 'action',
} as const
export function policyInput(): PolicyEvaluateRequest {
  return {
    principalRef: 'principal',
    resourceRef: { kind: 'resource', value: { resourceId: 'tool', version: 'v1', digest } },
    actionType: 'agh.tools/execute@1',
    inputDigest: digest,
    scope,
    policyRevision: 1,
    verifiedFacts: {
      factsId: 'facts',
      actionId: 'action',
      inputDigest: digest,
      evaluatedAt: now,
      toolPolicy: {
        isReadOnly: true,
        isDestructive: false,
        replay: 'safe',
        requiresApproval: 'never',
        approvalScopes: ['write'],
        policyVersion: 'v1',
        classifierDigest: digest,
        inputDigest: digest,
        definitionDigest: digest,
        fingerprint: digest,
      },
      actor: { principalRef: 'principal', revision: 1, executionDomain: 'domain', packageDigest: digest },
      taint: {
        runId: 'run',
        current: { recordRevision: 1, sourceSeq: 0, clearedThroughSeq: 0 },
        captured: { recordRevision: 1, sourceSeq: 0, clearedThroughSeq: 0 },
        tainted: false,
        sourceRefs: [],
      },
      configuration: { revision: 1, profileDigest: digest, mode: 'manual', yolo: false },
      authorization: { decision: 'allow', policyRevision: 1, sourceRefs: [] },
      grants: [],
      guardian: { state: 'not-needed', actionId: null, resultRef: null, decision: null },
      hookResults: null,
      approvalRequestRef: null,
    },
  }
}
export function policyEvidence(): PreparedPolicyEvidence {
  return {
    toolName: 'tool',
    trustedManagementTool: false,
    hookDenied: false,
    priorDecisions: {},
    rules: {},
    argvNormalized: true,
    approval: null,
    guardianVerified: false,
    guardianScopes: [],
  }
}
export type PolicyFactoryMaker = (
  descriptor: ProviderDescriptor,
  authority: PolicyAuthority,
  codec: AuthorSchema<EmptyAuthorConfig>,
) => ProviderFactory<ServiceProvider>
export interface DurablePolicyFixture {
  readonly factory: ProviderFactory<ServiceProvider>
  readonly config: DataRef
  readonly dependencies: ScopedDependencies
  readonly factoryContext: FactoryContext
  readonly context: CallContext
  readonly evaluate: ServiceOperation
  readonly list: ServiceQuery
  readonly revoke: ServiceOperation
  read(reference: DataRef): Promise<unknown>
  deny(): Promise<void>
  recover(): Promise<DurablePolicyFixture>
  finish(): Promise<void>
  recovery(owner: OwnerRef, request: PermissionClientRevokeGrantRequest): Outcome<ApprovalGrantRecord>
  dropRecovery(owner: OwnerRef): void
  readonly authority: PolicyAuthority
  replaceInput(input: PolicyEvaluateRequest, evidence?: PreparedPolicyEvidence): void
  seedGrants(count: number): void
  bumpGuard(): void
  failRevoke: boolean
  readonly decisions: () => number
}
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value })
function must<T>(result: Outcome<T>): T {
  if (!result.ok) throw new Error(result.error.detailCode)
  return result.value
}

/** Test owner with actual SQLite transactions and reopen; production does not import this fixture. */
export function createPolicyFixture(
  make: PolicyFactoryMaker,
  providerId = 'default',
  options?: Readonly<{ directory: string; retainOnFinish: true }>,
): DurablePolicyFixture {
  const directory = options?.directory ?? mkdtempSync(join(tmpdir(), 'agnes-policy-'))
  const path = join(directory, 'owner.db')
  let input = policyInput()
  let evidence = policyEvidence()
  let db: DatabaseSync
  let version = 1
  let denied = false
  let closed = true
  let failRevoke = false
  const grant: ApprovalGrantRecord = {
    grantId: 'grant',
    profileHash: `sha256-${digest}`,
    actorId: 'actor',
    actorOrg: 'org',
    toolId: 'tool',
    scope: 'write',
    policyVersion: 'v1',
    createdAt: now,
  }
  function open() {
    db = new DatabaseSync(path)
    db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body TEXT); CREATE TABLE IF NOT EXISTS facts(id INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY, body TEXT NOT NULL)',
    )
    db.prepare('INSERT OR IGNORE INTO grants VALUES (?,?)').run(grant.grantId, JSON.stringify(grant))
    db.prepare('INSERT OR IGNORE INTO facts VALUES(1,?)').run(JSON.stringify(input))
    closed = false
  }
  open()
  const context: CallContext = {
    principalRef: 'principal',
    scope,
    bindingId: 'binding',
    invocationId: 'invocation',
    deadline: until,
    traceRef: 'trace',
    authorizationRef: 'issued-auth',
    signal: new AbortController().signal,
  }
  const factoryContext: FactoryContext = {
    instanceId: 'instance',
    bindingId: 'binding',
    scope,
    signal: new AbortController().signal,
  }
  const authentic = (ctx: CallContext) =>
    !closed &&
    ctx.principalRef === context.principalRef &&
    ctx.authorizationRef === context.authorizationRef &&
    ctx.bindingId === context.bindingId &&
    canonicalJsonDigest(ctx.scope) === canonicalJsonDigest(context.scope)
  const readGuard = (): object => ({ version })
  const current = (guard: object, ctx: CallContext): Outcome<void> =>
    authentic(ctx) && (guard as { version: number }).version === version && !denied
      ? ok(undefined)
      : policyFailure('denied', 'current_facts_changed')
  const requestIdentity = (
    access: { actorId: string; actorOrg: string; profileHash: string },
    request: PermissionClientRevokeGrantRequest,
    ctx: CallContext,
  ) =>
    canonicalJsonDigest({
      principal: ctx.principalRef,
      actorId: access.actorId,
      actorOrg: access.actorOrg,
      profileHash: access.profileHash,
      scope: ctx.scope,
      binding: ctx.bindingId,
      method: 'revokeGrant',
      requestId: request.requestId,
    })
  const authority: PolicyAuthority = {
    now: () => now,
    async open() {
      return closed ? policyFailure('retryable', 'owner_closed') : ok(undefined)
    },
    async readConfig(ref) {
      return ref.kind === 'inline' ? ok(ref.value) : policyFailure('denied', 'blob_unavailable')
    },
    async read(ref, ctx) {
      if (!authentic(ctx)) return policyFailure('denied', 'auth_or_data_unavailable')
      if (ref.kind === 'inline') return ok(ref.value)
      if (ref.blob.authorityId !== 'policy-owner' || ref.blob.pinId !== `pin-${ref.blob.digest}`)
        return policyFailure('denied', 'foreign_blob')
      const row = db.prepare('SELECT body FROM blobs WHERE id=?').get(ref.blob.blobId) as
        | { body: string }
        | undefined
      return row ? ok(JSON.parse(row.body) as unknown) : policyFailure('denied', 'blob_unavailable')
    },
    async verifyEvaluation(request, ctx) {
      const saved = JSON.parse(
        (db.prepare('SELECT body FROM facts WHERE id=1').get() as { body: string }).body,
      ) as PolicyEvaluateRequest
      if (!authentic(ctx) || canonicalJsonDigest(saved) !== canonicalJsonDigest(request))
        return policyFailure('denied', 'unproven_facts')
      if (denied) return policyFailure('denied', 'current_permission_denied')
      const factsRef = must(
        encodePolicyValue(
          'PolicyEvaluateRequest',
          RuntimeMethodSchemaRefs['agh.policy'].evaluate.input,
          saved,
        ),
      )
      const result: VerifiedPolicyEvaluation = {
        input: saved,
        evidence,
        factsRef,
        conditions: factsRef,
        validUntil: until,
        readGuard: readGuard(),
        policies: [],
      }
      return ok(result)
    },
    async checkCurrent(guard, ctx) {
      return current(guard, ctx)
    },
    async authorizeGrants(_method, req, ctx) {
      return authentic(ctx) &&
        !denied &&
        req.sessionId === scope.sessionId &&
        req.toolId === grant.toolId &&
        req.scope === grant.scope &&
        req.policyVersion === grant.policyVersion
        ? ok({
            actorId: grant.actorId,
            actorOrg: grant.actorOrg,
            profileHash: grant.profileHash,
            snapshotId: `grants-${version}`,
            readGuard: readGuard(),
          })
        : policyFailure('denied', 'management_denied')
    },
    async listGrants(access, _request, ctx) {
      const checked = current(access.readGuard, ctx)
      if (!checked.ok) return checked
      const rows = db.prepare('SELECT body FROM grants').all() as { body: string }[]
      return ok({ grants: rows.map((row) => JSON.parse(row.body) as ApprovalGrantRecord) })
    },
    async revokeOwner(access, request, ctx) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const checked = current(access.readGuard, ctx)
        if (!checked.ok || ctx.signal.aborted) {
          db.exec('ROLLBACK')
          return checked.ok ? policyFailure('cancelled', 'cancelled') : checked
        }
        const id = requestIdentity(access, request, ctx)
        const fingerprint = canonicalJsonDigest(request)
        const row = db.prepare('SELECT fingerprint FROM decisions WHERE id=?').get(id)
        if (row && row.fingerprint !== fingerprint) {
          db.exec('ROLLBACK')
          return policyFailure('conflict', 'request_id_conflict')
        }
        db.prepare('INSERT OR IGNORE INTO decisions VALUES(?,?,NULL)').run(id, fingerprint)
        db.exec('COMMIT')
        return ok({ kind: 'reconciliation' as const, id })
      } catch {
        db.exec('ROLLBACK')
        return policyFailure('retryable', 'storage_failure')
      }
    },
    async revokeGrant(access, request, ctx) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const checked = current(access.readGuard, ctx)
        if (!checked.ok || ctx.signal.aborted) {
          db.exec('ROLLBACK')
          return checked.ok ? policyFailure('cancelled', 'cancelled') : checked
        }
        const identity = requestIdentity(access, request, ctx)
        const fingerprint = canonicalJsonDigest(request)
        const old = db.prepare('SELECT fingerprint,body FROM decisions WHERE id=?').get(identity) as
          | { fingerprint: string; body: string | null }
          | undefined
        if (!old || old.fingerprint !== fingerprint) {
          db.exec('ROLLBACK')
          return policyFailure('conflict', 'request_owner_missing_or_conflicting')
        }
        if (old.body !== null) {
          db.exec('ROLLBACK')
          return old.fingerprint === fingerprint
            ? ok(JSON.parse(old.body) as ApprovalGrantRecord)
            : policyFailure('conflict', 'request_id_conflict')
        }
        const row = db.prepare('SELECT body FROM grants WHERE id=?').get(request.grantId) as
          | { body: string }
          | undefined
        if (!row) {
          db.exec('ROLLBACK')
          return policyFailure('denied', 'unknown_grant')
        }
        const saved = JSON.parse(row.body) as ApprovalGrantRecord
        const result = { ...saved, revokedAt: saved.revokedAt ?? now }
        db.prepare('UPDATE grants SET body=? WHERE id=?').run(JSON.stringify(result), request.grantId)
        if (failRevoke) throw new Error('injected commit failure')
        db.prepare('UPDATE decisions SET body=? WHERE id=? AND fingerprint=?').run(
          JSON.stringify(result),
          identity,
          fingerprint,
        )
        db.exec('COMMIT')
        version++
        return ok(result)
      } catch {
        db.exec('ROLLBACK')
        return policyFailure('retryable', 'storage_failure')
      }
    },
    async publish(schema, value, ctx) {
      if (!authentic(ctx) || denied || ctx.signal.aborted)
        return policyFailure('denied', 'publisher_permission')
      const limits = RuntimeAuthorCodecPolicy.payload
      const encoded = boundedCanonicalJson(value, {
        maxBytes: limits.maxCanonicalJsonBytes,
        maxDepth: limits.maxDepth,
        maxMembers: limits.maxMembers,
      })
      if (!encoded.ok) return policyFailure('quota', 'publisher_budget')
      const hash = canonicalJsonDigest(encoded.value.json)
      if (encoded.value.bytes <= MAX_AUTHOR_INLINE_BYTES)
        return ok({
          kind: 'inline',
          schema,
          value: encoded.value.json,
          bytes: encoded.value.bytes,
          digest: hash,
        })
      db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?)').run(hash, encoded.value.canonical)
      return ok({
        kind: 'blob',
        schema,
        blob: {
          authorityId: 'policy-owner',
          blobId: hash,
          digest: hash,
          bytes: encoded.value.bytes,
          mediaType: 'application/json',
          pinId: `pin-${hash}`,
        },
      })
    },
    async close() {
      if (!closed) {
        closed = true
        db.close()
      }
    },
  }
  const schemas = RuntimeMethodSchemaRefs['agh.policy']
  const descriptor: ProviderDescriptor = {
    providerId,
    contract: 'agh.policy',
    major: 1,
    logicalName: 'policy',
    packageVersion: '1.0.0',
    packageDigest: digest,
    features: [],
    scope: 'session',
    configSchema: configCodec.ref,
    requires: [],
    capabilities: [],
    recovery: 'R1',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: [
      {
        method: 'evaluate',
        kind: 'compute',
        inputSchema: schemas.evaluate.input,
        outputSchema: schemas.evaluate.output,
        requiredCapabilities: [],
        retrySafety: 'read-only',
      },
      {
        method: 'listGrants',
        kind: 'query',
        inputSchema: schemas.listGrants.input,
        outputSchema: schemas.listGrants.output,
        requiredCapabilities: [],
        retrySafety: 'read-only',
      },
      {
        method: 'revokeGrant',
        kind: 'control',
        inputSchema: schemas.revokeGrant.input,
        outputSchema: schemas.revokeGrant.output,
        requiredCapabilities: [],
        retrySafety: 'idempotent',
      },
    ],
  }
  const target = {
    bindingId: 'binding',
    contract: 'agh.policy',
    logicalName: 'policy',
    providerId,
  }
  const listInput = { sessionId: 'session', toolId: 'tool', scope: 'write', policyVersion: 'v1' }
  const fixture: DurablePolicyFixture = {
    factory: make(descriptor, authority, configCodec),
    config: must(configCodec.encode({})),
    dependencies: {
      get: () => policyFailure('denied', 'undeclared_dependency'),
      openScope: async () => policyFailure('denied', 'undeclared_scope'),
      close: async () => {},
    },
    factoryContext,
    context,
    get evaluate() {
      return {
        target,
        method: 'evaluate',
        input: must(encodePolicyValue('PolicyEvaluateRequest', schemas.evaluate.input, input)),
      }
    },
    list: {
      target,
      method: 'listGrants',
      input: must(encodePolicyValue('ApprovalGrantBindingInput', schemas.listGrants.input, listInput)),
    },
    revoke: {
      target,
      method: 'revokeGrant',
      input: must(
        encodePolicyValue('PermissionClientRevokeGrantRequest', schemas.revokeGrant.input, {
          ...listInput,
          grantId: 'grant',
          requestId: 'revoke',
        }),
      ),
    },
    authority,
    async read(reference) {
      return must(await authority.read(reference, context))
    },
    async deny() {
      denied = true
      version++
    },
    async recover() {
      if (!closed) await authority.close()
      open()
      return fixture
    },
    async finish() {
      await authority.close()
      if (!options?.retainOnFinish) rmSync(directory, { recursive: true, force: true })
    },
    replaceInput(value, prepared = evidence) {
      input = value
      evidence = prepared
      db.prepare('UPDATE facts SET body=? WHERE id=1').run(JSON.stringify(input))
      version++
    },
    seedGrants(count) {
      for (let index = 0; index < count; index++) {
        const next = { ...grant, grantId: `grant-${index}` }
        db.prepare('INSERT INTO grants VALUES(?,?)').run(next.grantId, JSON.stringify(next))
      }
      version++
    },
    bumpGuard() {
      version++
    },
    get failRevoke() {
      return failRevoke
    },
    set failRevoke(value) {
      failRevoke = value
    },
    recovery(owner, request) {
      if (!authentic(context) || denied || context.signal.aborted || owner.kind !== 'reconciliation')
        return policyFailure('denied', 'recovery_authorization_denied')
      const id = requestIdentity(grant, request, context)
      const row = db.prepare('SELECT fingerprint,body FROM decisions WHERE id=?').get(owner.id)
      if (
        owner.id !== id ||
        !row ||
        row.fingerprint !== canonicalJsonDigest(request) ||
        typeof row.body !== 'string'
      )
        return policyFailure('denied', 'recovery_owner_unproven')
      return ok(JSON.parse(row.body) as ApprovalGrantRecord)
    },
    dropRecovery(owner) {
      db.prepare('DELETE FROM decisions WHERE id=?').run(owner.id)
    },
    decisions() {
      return Number(
        (db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE body IS NOT NULL').get() as { n: number }).n,
      )
    },
  }
  return fixture
}
