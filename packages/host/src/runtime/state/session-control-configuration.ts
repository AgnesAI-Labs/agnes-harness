import type { DatabaseSync } from 'node:sqlite'
import {
  type AuthorSchema,
  assertAuthorSchema,
  type CallContext,
  defineGeneratedAuthorSchema,
} from '@agnes/extension-api/runtime'
import {
  type ConfigResolveRequest,
  type ConfigResolveResult,
  type DataRef,
  type GeneratedAuthorSchemaSource,
  type RunBinding,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { resolveConfigRequest } from '../config/resolve-request.js'
import { createSchemaCatalog } from '../config/schema-catalog.js'
import {
  captureIdentityCurrentFence,
  type IdentityAuthority,
  type IdentityClaimsBinding,
  type IdentityClaimsOwner,
  identityAuthorityUsesDatabase,
} from '../identity/authority.js'
import type { VerifiedIdentityCredential } from '../identity/verify.js'
import { canonicalJson } from './canonical-json.js'
import { bodyDigest, digestOf, runBindingRecordId, sameJson, stableId } from './records.js'
import { integrity, refuse } from './refusal.js'
import {
  matchesRuntimeStateDatabaseOptions,
  type RuntimeStateDatabase,
  type RuntimeStateDatabaseOptions,
} from './transactions.js'

export type SessionControlPermissionClaims = {
  sessionId: string
  principalRef: string
  capabilities: Array<'read' | 'status' | 'set-preset:next-run'>
}
export type SessionControlPermissionProof = Readonly<{
  actorRef: string
  permissionSourceDigest: string
  authorizationRef: string
  sessionId: string
  capability: SessionControlPermissionClaims['capabilities'][number]
  principalRef: string
  tenantRef: string
  claims: DataRef
  scope: CallContext['scope']
}>
type SessionControlClaimsIssue = Readonly<{
  ref: DataRef
  binding: IdentityClaimsBinding
  grant: Readonly<{ principal: string; session_id: string; capabilities: string }>
}>
export type SessionControlClaimsOwner = IdentityClaimsOwner &
  Readonly<{
    codec: AuthorSchema<SessionControlPermissionClaims>
    capture(
      authorizationRef: string,
      historical?: boolean,
    ): Readonly<{ ref: DataRef; issue: SessionControlClaimsIssue; sourceDigest: string; staticCheck(): void }>
  }>
const claimsDatabases = new WeakMap<object, DatabaseSync>()
/** Restricted claims installer: permissions come from its native grant rows and a verified credential. */
export function createSessionControlClaimsOwner(
  database: DatabaseSync,
  codec: AuthorSchema<SessionControlPermissionClaims>,
): SessionControlClaimsOwner {
  assertAuthorSchema(codec)
  const issuedStatement = database.prepare(
    'SELECT * FROM runtime_session_control_claims_issued WHERE authorization_ref=?',
  )
  const issuedGet = issuedStatement.get.bind(issuedStatement)
  const grantStatement = database.prepare(
    'SELECT * FROM runtime_session_control_permission_grants WHERE principal=? AND session_id=?',
  )
  const grantGet = grantStatement.get.bind(grantStatement)
  const codecSlots = captureSessionControlSlots([codec])
  function capture(authorizationRef: string, historical = false) {
    codecSlots()
    const row = issuedGet(authorizationRef)
    if (!row || typeof row.value_json !== 'string') integrity('original session permission issuance missing')
    const body = JSON.parse(row.value_json) as {
      ref: import('@agnes/protocol/runtime').DataRef
      binding: import('../identity/authority.js').IdentityClaimsBinding
      grant: { principal: string; session_id: string; capabilities: string }
    }
    if (
      !validateRuntime('DataRef', body.ref).ok ||
      body.ref.kind !== 'inline' ||
      !sameJson(body.ref.schema, codec.ref) ||
      digestOf(body.ref.value) !== body.ref.digest ||
      Buffer.byteLength(canonicalJson(body.ref.value)) !== body.ref.bytes ||
      body.binding.authorizationRef !== authorizationRef ||
      body.binding.principalRef !== body.grant.principal
    )
      integrity('session permission original issuance differs from its native binding')
    const parsed = codec.parse(body.ref.value)
    if (
      !parsed.ok ||
      parsed.value.principalRef !== body.binding.principalRef ||
      parsed.value.sessionId !== body.grant.session_id ||
      !sameJson(parsed.value.capabilities, JSON.parse(body.grant.capabilities))
    )
      integrity('session permission claims differ from their original grant')
    const original = row.value_json
    const grant = grantGet(body.grant.principal, body.grant.session_id)
    if (!historical && (!grant || grant.capabilities !== body.grant.capabilities))
      refuse('denied', 'session_control_permission', 'original permission grant is no longer available')
    function staticCheck() {
      codecSlots()
      if (issuedGet(authorizationRef)?.value_json !== original)
        integrity('original session permission issuance changed')
      if (!historical) {
        const actual = grantGet(body.grant.principal, body.grant.session_id)
        if (
          !actual ||
          actual.principal !== body.grant.principal ||
          actual.session_id !== body.grant.session_id ||
          actual.capabilities !== body.grant.capabilities
        )
          refuse('denied', 'session_control_permission', 'original native permission grant changed')
      }
    }
    return Object.freeze({
      ref: fixedSessionControlData(body.ref),
      issue: fixedSessionControlData(body),
      sourceDigest: digestOf(body),
      staticCheck,
    })
  }
  const owner: SessionControlClaimsOwner = Object.freeze({
    codec,
    capture,
    async create(binding: IdentityClaimsBinding, verified: VerifiedIdentityCredential) {
      codecSlots()
      if (verified.subject !== binding.principalRef || !('sessionId' in binding.scope))
        refuse(
          'denied',
          'session_control_permission',
          'verified credential has no installed session permission',
        )
      if (
        issuedGet(binding.authorizationRef) ||
        database
          .prepare('SELECT authorization_ref FROM runtime_identity_instances WHERE authorization_ref=?')
          .get(binding.authorizationRef)
      )
        integrity('session permission issuance cannot replace an original authentication instance')
      const grant = grantGet(verified.subject, binding.scope.sessionId)
      if (!grant || typeof grant.capabilities !== 'string')
        refuse('denied', 'session_control_permission', 'original native permission grant missing')
      const encoded = codec.encode({
        principalRef: verified.subject,
        sessionId: binding.scope.sessionId,
        capabilities: JSON.parse(grant.capabilities),
      })
      if (!encoded.ok)
        refuse('denied', 'session_control_permission', 'original permission codec refused native grant')
      database
        .prepare('INSERT INTO runtime_session_control_claims_issued VALUES(?,?)')
        .run(binding.authorizationRef, JSON.stringify({ ref: encoded.value, binding, grant }))
      return encoded.value
    },
    validate(ref: DataRef, binding: IdentityClaimsBinding) {
      try {
        const original = capture(binding.authorizationRef)
        return sameJson(original.ref, ref)
      } catch {
        return false
      }
    },
  })
  claimsDatabases.set(owner, database)
  return owner
}
export type SessionConfigurationIssue = Readonly<{
  ticketId: string
  sessionId: string
  runId: string
  commitId: string
  binding: RunBinding
  request: ConfigResolveRequest
  resolved: ConfigResolveResult
  qualifiedUntil: string
  producerCodeDigest: string
  permissionAuthorizationRef: string
}>
export type SessionConfigurationCapture = Readonly<{
  issue: SessionConfigurationIssue
  permission: SessionControlPermissionProof
  deadline: string
  dynamicCheck(): void
  staticCheck(): void
  finalCheck(stateStaticCheck?: () => void): void
}>
export type SessionControlConfiguration = Readonly<{
  identity: IdentityAuthority
  resolve(request: unknown): ConfigResolveResult
  issueBase(ticketId: string, request: unknown, context: CallContext): Promise<SessionConfigurationIssue>
  capture(
    sessionId: string,
    capability: SessionControlPermissionClaims['capabilities'][number],
    context: CallContext,
  ): SessionConfigurationCapture
  readHistoricalPermission(proof: SessionControlPermissionProof): Readonly<{ staticCheck(): void }>
  readHistorical(sessionId: string): Readonly<{ issue: SessionConfigurationIssue; staticCheck(): void }>
}>
const databases = new WeakMap<object, DatabaseSync>()
export function isSessionControlConfiguration(value: unknown): value is SessionControlConfiguration {
  return typeof value === 'object' && value !== null && databases.has(value)
}
export function sessionControlConfigurationUsesDatabase(
  source: SessionControlConfiguration,
  database: DatabaseSync,
): boolean {
  return databases.get(source) === database
}
export function fixedSessionControlData<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) fixedSessionControlData(child)
    Object.freeze(value)
  }
  return value
}
/** Capture own slots once; the returned check invokes no methods or getters. */
export function captureSessionControlSlots(objects: readonly object[]): () => void {
  const captured = objects.map((object) => ({
    object,
    prototype: Object.getPrototypeOf(object),
    slots: Object.getOwnPropertyDescriptors(object),
  }))
  return () => {
    for (const { object, prototype, slots } of captured) {
      const actual = Object.getOwnPropertyDescriptors(object)
      if (
        Object.getPrototypeOf(object) !== prototype ||
        Reflect.ownKeys(actual).length !== Reflect.ownKeys(slots).length
      )
        integrity('session control selected source changed')
      for (const key of Reflect.ownKeys(slots)) {
        const before = Reflect.get(slots, key)
        const after = Reflect.get(actual, key)
        if (
          !after ||
          before.value !== after.value ||
          before.get !== after.get ||
          before.set !== after.set ||
          before.writable !== after.writable ||
          before.enumerable !== after.enumerable ||
          before.configurable !== after.configurable
        )
          integrity('session control selected source slot changed')
      }
    }
  }
}

/** A restricted installation must supply real selected schema/code facts and the original State connection. */
export function createSessionControlConfiguration(
  input: Readonly<{
    database: DatabaseSync
    state: RuntimeStateDatabase
    stateOptions: RuntimeStateDatabaseOptions
    identity: IdentityAuthority
    parameterSchema: GeneratedAuthorSchemaSource
    permissionOwner: SessionControlClaimsOwner
    producerCodeDigest: string
    qualifiedUntil: string
  }>,
): SessionControlConfiguration {
  const { database: db, state, identity, permissionOwner } = input
  if (claimsDatabases.get(permissionOwner) !== db)
    refuse('denied', 'session_control_permission', 'original same-connection claims owner is required')
  if (!identityAuthorityUsesDatabase(identity, db))
    refuse(
      'denied',
      'session_control_permission',
      'original C14 issuer must share the exact State connection',
    )
  const permissionCodec = permissionOwner.codec
  const native = Object.getOwnPropertyDescriptor(state, 'db')
  const statePrototype = Object.getPrototypeOf(state)
  const probeDescriptor = Object.getOwnPropertyDescriptor(statePrototype, 'probeAdmission')
  if (
    !probeDescriptor ||
    !('value' in probeDescriptor) ||
    typeof probeDescriptor.value !== 'function' ||
    Object.hasOwn(state, 'probeAdmission')
  )
    refuse('denied', 'session_control_source', 'original State admission reader is unavailable')
  const originalProbe = state.probeAdmission
  const probeAdmission = originalProbe.bind(state)
  if (
    !matchesRuntimeStateDatabaseOptions(state, input.stateOptions) ||
    !native ||
    !('value' in native) ||
    native.value !== db
  )
    refuse(
      'denied',
      'session_control_source',
      'configuration and State must share their original native connection',
    )
  assertAuthorSchema(permissionCodec)
  const parameterCodec = defineGeneratedAuthorSchema<unknown>(input.parameterSchema)
  const catalog = createSchemaCatalog()
  if (catalog.admitSchema(parameterCodec.ref, input.parameterSchema.document))
    refuse('denied', 'session_control_schema', 'original parameter schema is unavailable')
  if (
    !validateRuntime('Digest', input.producerCodeDigest).ok ||
    !validateRuntime('Timestamp', input.qualifiedUntil).ok
  )
    refuse('invalid_input', 'session_control_source', 'configuration installation identity is invalid')
  const installation = digestOf({
    authority: input.stateOptions.authority,
    schema: parameterCodec.ref,
    permission: permissionCodec.ref,
    code: input.producerCodeDigest,
    until: input.qualifiedUntil,
  })
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('runtime_session_configuration_installation','runtime_session_configuration_issued')",
    )
    .all()
  if (tables.length === 0) {
    if (db.prepare('SELECT count(*) n FROM events').get()?.n !== 0)
      integrity('existing State history cannot bootstrap missing configuration installation')
    db.exec('SAVEPOINT session_configuration_install')
    try {
      db.exec(
        'CREATE TABLE runtime_session_configuration_installation (id INTEGER PRIMARY KEY CHECK(id=1), installation_digest TEXT NOT NULL, issued_json TEXT NOT NULL)',
      )
      db.exec(
        'CREATE TABLE runtime_session_configuration_issued (session_id TEXT PRIMARY KEY, issue_json TEXT NOT NULL, issue_digest TEXT NOT NULL)',
      )
      db.prepare('INSERT INTO runtime_session_configuration_installation VALUES(1,?,?)').run(
        installation,
        '{}',
      )
      db.exec('RELEASE session_configuration_install')
    } catch (error) {
      db.exec('ROLLBACK TO session_configuration_install')
      db.exec('RELEASE session_configuration_install')
      throw error
    }
  } else if (tables.length !== 2) integrity('session configuration original installation is incomplete')
  const anchorStatement = db.prepare('SELECT * FROM runtime_session_configuration_installation WHERE id=1')
  const anchorGet = anchorStatement.get.bind(anchorStatement)
  const issueStatement = db.prepare('SELECT * FROM runtime_session_configuration_issued WHERE session_id=?')
  const issueGet = issueStatement.get.bind(issueStatement)
  const bindingStatement = db.prepare('SELECT * FROM runtime_records WHERE record_id=?')
  const bindingGet = bindingStatement.get.bind(bindingStatement)
  const staticSlots = captureSessionControlSlots([
    input,
    identity,
    permissionOwner,
    permissionCodec,
    parameterCodec,
    input.stateOptions,
    input.stateOptions.authority,
    statePrototype,
    originalProbe,
  ])
  function anchor() {
    const row = anchorGet()
    if (!row || row.installation_digest !== installation || typeof row.issued_json !== 'string')
      integrity('session configuration installation anchor missing or changed')
    const entries: unknown = JSON.parse(row.issued_json)
    if (!entries || typeof entries !== 'object' || Array.isArray(entries))
      integrity('session configuration issuance index invalid')
    for (const [sessionId, digest] of Object.entries(entries)) {
      const issued = issueGet(sessionId)
      if (
        typeof digest !== 'string' ||
        !issued ||
        issued.issue_digest !== digest ||
        typeof issued.issue_json !== 'string' ||
        digestOf(JSON.parse(issued.issue_json)) !== digest
      )
        integrity('original session configuration issuance is unavailable')
    }
    if (
      db.prepare('SELECT count(*) n FROM runtime_session_configuration_issued').get()?.n !==
      Object.keys(entries).length
    )
      integrity('session configuration original issuance index is incomplete')
    return { row, issuedJson: row.issued_json, entries: entries as Record<string, string> }
  }
  anchor()
  function resolve(raw: unknown): ConfigResolveResult {
    staticSlots()
    if (
      Object.getPrototypeOf(state) !== statePrototype ||
      Object.hasOwn(state, 'probeAdmission') ||
      Object.getOwnPropertyDescriptor(state, 'db')?.value !== db
    )
      integrity('original State admission reader changed')
    const checked = validateRuntime('ConfigResolveRequest', raw)
    if (!checked.ok)
      refuse(
        'invalid_input',
        'session_configuration',
        'configuration request does not match its original codec',
      )
    if (
      [checked.value.defaults.preset, ...checked.value.presets].some(
        (item) => item.document.configOverrides.length !== 0,
      )
    )
      refuse(
        'denied',
        'session_configuration',
        'preset configuration overrides require the applied resolver source',
      )
    if (
      [checked.value.defaults.profile, ...checked.value.profiles].some(
        (item) =>
          item.document.packages.length ||
          item.document.selections.length ||
          item.document.providerConfigs.length,
      )
    )
      refuse(
        'denied',
        'session_configuration',
        'nonempty provider selections require their installed configuration owners',
      )
    const result = resolveConfigRequest(checked.value, catalog)
    if (!result.ok) refuse('denied', 'session_configuration', result.refusal.message)
    return fixedSessionControlData(result.result)
  }
  function permissionFacts(
    original: ReturnType<SessionControlClaimsOwner['capture']>,
    sessionId: string,
    capability: SessionControlPermissionClaims['capabilities'][number],
  ): SessionControlPermissionProof {
    const binding = original.issue.binding
    const parsed = permissionCodec.parse(original.ref.kind === 'inline' ? original.ref.value : null)
    if (
      !parsed.ok ||
      parsed.value.sessionId !== sessionId ||
      parsed.value.principalRef !== binding.principalRef ||
      binding.tenantRef !== input.stateOptions.authority.tenantId ||
      !validateRuntime('ScopeRef', binding.scope).ok ||
      !('sessionId' in binding.scope) ||
      binding.scope.sessionId !== sessionId ||
      !parsed.value.capabilities.includes(capability)
    )
      integrity('original command permission does not match its issued actor and session')
    return fixedSessionControlData({
      actorRef: stableId(
        'session-control-actor',
        digestOf({
          authority: input.stateOptions.authority,
          sessionId,
          scope: binding.scope,
          tenantRef: binding.tenantRef,
          principalRef: binding.principalRef,
        }),
      ),
      permissionSourceDigest: original.sourceDigest,
      authorizationRef: binding.authorizationRef,
      sessionId,
      capability,
      principalRef: binding.principalRef,
      tenantRef: binding.tenantRef,
      claims: original.ref,
      scope: binding.scope,
    })
  }
  function readHistoricalPermission(proof: SessionControlPermissionProof) {
    staticSlots()
    const original = permissionOwner.capture(proof.authorizationRef, true)
    const expected = permissionFacts(original, proof.sessionId, proof.capability)
    if (!sameJson(expected, proof)) integrity('historical command permission differs from original issuance')
    return Object.freeze({
      staticCheck() {
        staticSlots()
        original.staticCheck()
      },
    })
  }
  function permission(
    sessionId: string,
    capability: SessionControlPermissionClaims['capabilities'][number],
    context: CallContext,
  ) {
    const actor = identity.current(context)
    if (
      !actor ||
      actor.identity.tenantRef !== input.stateOptions.authority.tenantId ||
      !('sessionId' in context.scope) ||
      context.scope.sessionId !== sessionId
    )
      refuse('denied', 'session_control_permission', 'original session identity is not current')
    const ref = actor.identity.claims
    if (
      ref.kind !== 'inline' ||
      !sameJson(ref.schema, permissionCodec.ref) ||
      digestOf(ref.value) !== ref.digest ||
      Buffer.byteLength(canonicalJson(ref.value)) !== ref.bytes
    )
      refuse('denied', 'session_control_permission', 'original permission claims carrier is invalid')
    const parsed = permissionCodec.parse(ref.value)
    if (
      !parsed.ok ||
      parsed.value.sessionId !== sessionId ||
      parsed.value.principalRef !== actor.identity.principalRef ||
      !parsed.value.capabilities.includes(capability)
    )
      refuse(
        'denied',
        'session_control_permission',
        'original issued claims do not permit this session operation',
      )
    const proof = permissionOwner.capture(context.authorizationRef)
    if (
      !sameJson(proof.ref, ref) ||
      proof.issue.binding.principalRef !== actor.identity.principalRef ||
      proof.issue.binding.tenantRef !== actor.identity.tenantRef ||
      !sameJson(proof.issue.binding.scope, context.scope)
    )
      integrity('current identity claims differ from original native permission issuance')
    staticSlots()
    return Object.freeze({ ...proof, permission: permissionFacts(proof, sessionId, capability) })
  }
  function readHistorical(sessionId: string) {
    const a = anchor()
    const row = issueGet(sessionId)
    if (
      !row ||
      typeof row.issue_json !== 'string' ||
      typeof row.issue_digest !== 'string' ||
      a.entries[sessionId] !== row.issue_digest
    )
      integrity('original session configuration issuance is unavailable')
    const issue = JSON.parse(row.issue_json) as SessionConfigurationIssue
    if (
      digestOf(issue) !== row.issue_digest ||
      issue.sessionId !== sessionId ||
      issue.producerCodeDigest !== input.producerCodeDigest ||
      issue.qualifiedUntil !== input.qualifiedUntil ||
      !validateRuntime('RunBinding', issue.binding).ok ||
      !validateRuntime('ConfigResolveRequest', issue.request).ok ||
      !validateRuntime('ConfigResolveResult', issue.resolved).ok ||
      issue.binding.profileDigest !== issue.resolved.profileDigest ||
      issue.binding.presetDigest !== issue.resolved.presetDigest
    )
      integrity('session configuration original binding or resolved source changed')
    const originalBinding = bindingGet(runBindingRecordId(issue.runId))
    if (
      !originalBinding ||
      typeof originalBinding.value_json !== 'string' ||
      !sameJson(JSON.parse(originalBinding.value_json), issue.binding) ||
      originalBinding.last_commit_id !== issue.commitId ||
      bodyDigest(JSON.parse(String(originalBinding.owner_json)), issue.binding) !==
        originalBinding.body_digest
    )
      integrity('session configuration original State binding unavailable')
    const originalOwner = validateRuntime('RecordOwner', JSON.parse(String(originalBinding.owner_json)))
    if (!originalOwner.ok) integrity('original configuration owner is invalid')
    const ownerScope = fixedSessionControlData(originalOwner.value.scope)
    const bindingSlots = Object.entries(originalBinding)
    const permissionProof = permissionOwner.capture(issue.permissionAuthorizationRef, true)
    if (!sameJson(permissionProof.issue.binding.scope, ownerScope))
      integrity('original configuration permission namespace differs from its admitted owner')
    const original = row.issue_json
    const originalDigest = row.issue_digest
    const indexed = a.issuedJson
    function staticCheck() {
      staticSlots()
      permissionProof.staticCheck()
      const currentBinding = bindingGet(runBindingRecordId(issue.runId))
      if (!currentBinding || bindingSlots.some(([key, value]) => currentBinding[key] !== value))
        integrity('session configuration original State binding changed')
      if (
        anchorGet()?.issued_json !== indexed ||
        anchorGet()?.installation_digest !== installation ||
        issueGet(sessionId)?.issue_json !== original ||
        issueGet(sessionId)?.issue_digest !== originalDigest
      )
        integrity('session configuration retained source changed')
    }
    return Object.freeze({ issue: fixedSessionControlData(issue), ownerScope, staticCheck })
  }
  async function issueBase(ticketId: string, raw: unknown, context: CallContext) {
    const checked = validateRuntime('ConfigResolveRequest', structuredClone(raw))
    if (!checked.ok)
      refuse('invalid_input', 'session_configuration', 'original configuration request invalid')
    const resolved = resolve(checked.value)
    const probe = await probeAdmission(ticketId, context)
    if (probe.state !== 'created')
      refuse('denied', 'session_configuration', 'configuration requires an original created admission')
    const original = bindingGet(runBindingRecordId(probe.runId))
    if (!original || typeof original.value_json !== 'string') integrity('original locked RunBinding missing')
    const binding = validateRuntime('RunBinding', JSON.parse(original.value_json))
    const schema = JSON.parse(String(original.schema_json))
    if (
      !binding.ok ||
      binding.value.profileDigest !== resolved.profileDigest ||
      binding.value.presetDigest !== resolved.presetDigest ||
      original.last_commit_id !== probe.commit.commitId ||
      bodyDigest(JSON.parse(String(original.owner_json)), binding.value) !== original.body_digest ||
      schema.typeId !== 'agh.runtime/run-binding@1'
    )
      integrity('configuration candidate is not the actual original locked binding')
    const sessionId = context.scope.kind === 'session' ? context.scope.sessionId : ''
    const permissionProof = permission(sessionId, 'read', context)
    const originalOwner = validateRuntime('RecordOwner', JSON.parse(String(original.owner_json)))
    if (!originalOwner.ok || !sameJson(originalOwner.value.scope, permissionProof.permission.scope))
      refuse(
        'denied',
        'session_control_permission',
        'configuration issuance requires its original admitted namespace',
      )
    const a = anchor()
    if (Object.hasOwn(a.entries, sessionId)) {
      const previous = readHistorical(sessionId)
      if (!sameJson(previous.issue.request, checked.value) || previous.issue.ticketId !== ticketId)
        integrity('configuration source replay differs from original issuance')
      const fence = captureIdentityCurrentFence(identity, context, input.qualifiedUntil)
      if (
        !fence ||
        !fence(() => {
          permissionProof.staticCheck()
          previous.staticCheck()
        })
      )
        refuse('denied', 'session_control_permission', 'configuration replay qualification changed')
      return previous.issue
    }
    if (issueGet(sessionId)) integrity('configuration issuance lacks its original index')
    const issue: SessionConfigurationIssue = fixedSessionControlData({
      ticketId,
      sessionId,
      runId: probe.runId,
      commitId: probe.commit.commitId,
      binding: binding.value,
      request: checked.value,
      resolved,
      qualifiedUntil: input.qualifiedUntil,
      producerCodeDigest: input.producerCodeDigest,
      permissionAuthorizationRef: context.authorizationRef,
    })
    const fence = captureIdentityCurrentFence(identity, context, input.qualifiedUntil)
    if (!fence) refuse('denied', 'session_control_permission', 'original identity fence unavailable')
    const digest = digestOf(issue)
    const json = JSON.stringify(issue)
    db.exec('SAVEPOINT session_configuration_issue')
    try {
      db.prepare('INSERT INTO runtime_session_configuration_issued VALUES(?,?,?)').run(
        sessionId,
        json,
        digest,
      )
      db.prepare(
        'UPDATE runtime_session_configuration_installation SET issued_json=? WHERE id=1 AND issued_json=?',
      ).run(JSON.stringify({ ...a.entries, [sessionId]: digest }), a.issuedJson)
      const proof = readHistorical(sessionId)
      if (
        !fence(() => {
          permissionProof.staticCheck()
          proof.staticCheck()
          if (bindingGet(runBindingRecordId(probe.runId))?.value_json !== original.value_json)
            integrity('original RunBinding changed at configuration issuance')
        })
      )
        refuse('denied', 'session_control_permission', 'configuration issuer qualification changed')
      db.exec('RELEASE session_configuration_issue')
      return proof.issue
    } catch (error) {
      db.exec('ROLLBACK TO session_configuration_issue')
      db.exec('RELEASE session_configuration_issue')
      throw error
    }
  }
  function capture(
    sessionId: string,
    capability: SessionControlPermissionClaims['capabilities'][number],
    context: CallContext,
  ): SessionConfigurationCapture {
    const permissionProof = permission(sessionId, capability, context)
    const historical = readHistorical(sessionId)
    if (!sameJson(permissionProof.permission.scope, historical.ownerScope))
      refuse(
        'denied',
        'session_control_permission',
        'current permission differs from the original configuration namespace',
      )
    const deadline = new Date(
      Math.min(Date.parse(input.qualifiedUntil), Date.parse(context.deadline)),
    ).toISOString()
    const fence = captureIdentityCurrentFence(identity, context, deadline)
    if (!fence) refuse('denied', 'session_control_permission', 'original issued context unavailable')
    function staticCheck() {
      historical.staticCheck()
      permissionProof.staticCheck()
      if (Object.getOwnPropertyDescriptor(state, 'db')?.value !== db)
        integrity('original State connection changed')
    }
    return Object.freeze({
      issue: historical.issue,
      permission: permissionProof.permission,
      deadline,
      dynamicCheck() {
        permission(sessionId, capability, context)
        staticCheck()
      },
      staticCheck,
      finalCheck(stateStaticCheck?: () => void) {
        if (
          !fence(() => {
            staticCheck()
            stateStaticCheck?.()
            staticCheck()
          })
        )
          refuse('denied', 'session_control_permission', 'original session issuer changed')
      },
    })
  }
  const source = Object.freeze({
    identity,
    resolve,
    issueBase,
    capture,
    readHistorical,
    readHistoricalPermission,
  })
  databases.set(source, db)
  return source
}
