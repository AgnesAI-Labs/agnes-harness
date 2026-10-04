import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { type CallContext, defineGeneratedAuthorSchema } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  RuntimeSchemaRefs,
  type ScopeRef,
  type StateAuthorityRef,
  type Timestamp,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { openBootstrapAnchor } from '../maintenance/bootstrap-locator.js'
import {
  captureIdentityCurrentFence,
  createIdentityAuthority,
  type IdentityClaimsBinding,
  type IdentityClaimsOwner,
} from './authority.js'
import { decodeIdentityData } from './data.js'
import { createIdentityIngressAuthority } from './legacy-ingress.js'
import {
  captureLocalDeploymentOwner,
  type LocalDeploymentOwner,
  localDeploymentOwnerUsesDatabase,
} from './local-deployment-owner.js'
import { createIdentityNonceOwner } from './nonce.js'
import { type VerifiedIdentityCredential, verifyIdentityCredential } from './verify.js'

const claimsCodec = defineGeneratedAuthorSchema<{
  principalRef: string
  directoryId: string
  uid: number
}>({
  ownerPackageId: 'agnes-host',
  name: 'LocalOwnerClaims',
  typeId: 'agnes-host/local-owner-claims@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/LocalOwnerClaims',
    $defs: {
      LocalOwnerClaims: {
        type: 'object',
        additionalProperties: false,
        properties: {
          principalRef: { type: 'string', minLength: 1 },
          directoryId: { type: 'string', minLength: 1 },
          uid: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
        },
        required: ['principalRef', 'directoryId', 'uid'],
      },
    },
  },
})

/** Internal installer composition. No credential, transport evidence or principal comes from a caller. */
export function createLocalDeploymentIdentity(
  input: Readonly<{
    database: DatabaseSync
    owner: LocalDeploymentOwner
    deploymentDirectory: string
    authority: StateAuthorityRef
    scope: ScopeRef
    now?: () => number
  }>,
) {
  const db = input.database
  if (!localDeploymentOwnerUsesDatabase(input.owner, db)) throw new Error('Original local owner is required')
  const owner = input.owner
  owner.dynamicCheck()
  const selectedOwner = captureLocalDeploymentOwner({
    database: db,
    deploymentDirectory: input.deploymentDirectory,
  })
  if (jcs(selectedOwner.facts) !== jcs(owner.facts))
    throw new Error('Original deployment selection does not match its owner')
  if (
    !validateRuntime('StateAuthorityRef', input.authority).ok ||
    !validateRuntime('ScopeRef', input.scope).ok
  )
    throw new Error('Original installation authority and scope are required')
  if (input.scope.kind === 'installation') throw new Error('Local ingress needs an original runtime scope')
  const scope = Object.freeze(structuredClone(input.scope))
  const now = input.now ?? Date.now
  const stateAuthority = Object.freeze(structuredClone(input.authority))
  const config = {
    authority: stateAuthority,
    scope,
    owner: { ...owner.facts },
  }
  const configJson = jcs(config)
  const safeConfig = boundedCanonicalJson(config, { maxBytes: 65536, maxDepth: 64, maxMembers: 10000 })
  if (!safeConfig.ok) throw new Error('Original local identity configuration exceeds its proof limit')
  const configDigest = canonicalJsonDigest(safeConfig.value.json)
  const bindingId = `local-identity:${configDigest}`
  const opened = openBootstrapAnchor(input.deploymentDirectory)
  if (!opened.ok) throw new Error('Original bootstrap anchor is required')
  const anchor = opened.value
  const journalId = `local-identity:${configDigest}`
  const journal = anchor.readJournal(journalId)
  if (!journal.ok) throw new Error('Original local identity installation anchor is unreadable')
  const names = [
    'runtime_local_identity_installation',
    'runtime_local_identity_connections',
    'runtime_local_identity_claims',
    'runtime_identity_instances',
    'auth_nonces',
  ]
  const present = names.filter((name) =>
    db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('table', name),
  )
  if (journal.value === null) {
    if (present.length) throw new Error('Partial local identity installation cannot be bootstrapped')
    const wrote = anchor.writeJournal(journalId, { phase: 'installing', config: safeConfig.value.json })
    if (!wrote.ok) throw new Error('Original local identity installation anchor cannot be retained')
    db.exec(`CREATE TABLE runtime_local_identity_installation (
      id TEXT PRIMARY KEY,body_json TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE runtime_local_identity_connections (
      id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,generation TEXT UNIQUE NOT NULL,
      process_id INTEGER NOT NULL,closed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE runtime_local_identity_claims (
      authorization_ref TEXT PRIMARY KEY,body_json TEXT NOT NULL);`)
    db.prepare('INSERT INTO runtime_local_identity_installation(id,body_json) VALUES(?,?)').run(
      configDigest,
      configJson,
    )
  } else if (present.length !== names.length) {
    throw new Error('Original local identity installation is incomplete or changed')
  }
  if (journal.value !== null) {
    const structures = names.map((name) => {
      const row = db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('table', name)
      if (!row || typeof row.sql !== 'string') throw new Error('Original local identity table is missing')
      return { name, sql: row.sql }
    })
    if (jcs(journal.value) !== jcs({ phase: 'installed', config: safeConfig.value.json, structures }))
      throw new Error('Original local identity installation structure changed')
  }
  if (journal.value !== null) {
    const missing = db
      .prepare(`SELECT 1 FROM runtime_identity_instances i
      LEFT JOIN runtime_local_identity_claims c ON c.authorization_ref=i.authorization_ref
      LEFT JOIN runtime_local_identity_connections n ON n.generation=json_extract(i.source_json,'$.generation')
      WHERE i.binding_id=? AND (c.authorization_ref IS NULL OR n.id IS NULL) LIMIT 1`)
      .get(bindingId)
    if (missing) throw new Error('Original local identity issuance evidence is incomplete')
  }
  const installationStatement = db.prepare('SELECT * FROM runtime_local_identity_installation WHERE id=?')
  const installationGet = installationStatement.get.bind(installationStatement)
  function installationCurrent(): void {
    const row = installationGet(configDigest)
    if (row?.body_json !== configJson || row.revoked !== 0)
      throw new Error('Original local identity installation is unavailable')
  }
  installationCurrent()
  const connectionStatement = db.prepare('SELECT * FROM runtime_local_identity_connections WHERE id=?')
  const connectionGet = connectionStatement.get.bind(connectionStatement)
  const claimsStatement = db.prepare('SELECT * FROM runtime_local_identity_claims WHERE authorization_ref=?')
  const claimsGet = claimsStatement.get.bind(claimsStatement)
  const live = new Map<string, string>()
  const readLive = live.get.bind(live)
  let closed = false
  let enrolling = false
  const localClaims = claimsCodec.encode({
    principalRef: owner.facts.principalRef,
    directoryId: owner.facts.directoryId,
    uid: owner.facts.uid,
  })
  if (!localClaims.ok) throw new Error('Original local claims codec refused its owner')
  const originalClaimsRef = localClaims.value
  const originalClaimsJson = jcs(originalClaimsRef)
  const claims: IdentityClaimsOwner = Object.freeze({
    async create(binding: IdentityClaimsBinding, verified: VerifiedIdentityCredential) {
      if (
        verified.authKind !== 'local' ||
        verified.ownerClass !== 'local-owner' ||
        verified.subject !== 'machine-owner' ||
        binding.principalRef !== owner.facts.principalRef ||
        binding.tenantRef !== stateAuthority.tenantId ||
        binding.bindingId !== bindingId ||
        jcs(binding.scope) !== jcs(scope)
      )
        throw new Error('Original local authentication does not match its installation')
      const encoded = claimsCodec.encode({
        principalRef: binding.principalRef,
        directoryId: owner.facts.directoryId,
        uid: owner.facts.uid,
      })
      if (!encoded.ok) throw new Error('Original local claims codec refused its owner')
      db.prepare('INSERT INTO runtime_local_identity_claims VALUES(?,?)').run(
        binding.authorizationRef,
        jcs({ ref: encoded.value, binding }),
      )
      return originalClaimsRef
    },
    validate(ref: DataRef, binding: IdentityClaimsBinding) {
      return (
        jcs(ref) === originalClaimsJson &&
        binding.principalRef === owner.facts.principalRef &&
        binding.tenantRef === stateAuthority.tenantId &&
        binding.bindingId === bindingId &&
        jcs(binding.scope) === jcs(scope) &&
        claimsGet(binding.authorizationRef)?.body_json === jcs({ ref, binding })
      )
    },
  })
  const nonces = createIdentityNonceOwner(db)
  const authority = createIdentityAuthority(
    db,
    claims,
    now,
    (actor, target) =>
      actor.bindingId === bindingId && target.bindingId === bindingId && jcs(target.scope) === jcs(scope),
    (source) => {
      try {
        if (closed || source.kind !== 'deployment' || source.keyId !== null) return false
        owner.dynamicCheck()
        installationCurrent()
        const entry = [...live].find(([, generation]) => generation === source.generation)
        if (!entry) return false
        const row = connectionGet(entry[0])
        return (
          row?.installation_id === configDigest &&
          row.generation === source.generation &&
          row.process_id === process.pid &&
          row.closed === 0
        )
      } catch {
        return false
      }
    },
  )
  const structures = names.map((name) => {
    const row = db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('table', name)
    if (!row || typeof row.sql !== 'string') throw new Error('Original local identity table is missing')
    return { name, sql: row.sql }
  })
  const installedJournal = { phase: 'installed', config: safeConfig.value.json, structures }
  if (journal.value === null) {
    const saved = anchor.writeJournal(journalId, installedJournal)
    if (!saved.ok) throw new Error('Original installation structures cannot be retained')
  } else if (jcs(journal.value) !== jcs(installedJournal)) {
    authority.close()
    throw new Error('Original local identity installation structure changed')
  }
  const ingress = createIdentityIngressAuthority({
    now,
    binding: {
      bindingId,
      contract: 'agh.identity',
      logicalName: 'local-identity',
      providerId: 'agh.default/identity',
    },
    readLegacyConnection(connection) {
      return connections.get(connection) ?? null
    },
    verifyHttpConnection() {
      return false
    },
  })
  const connections = new WeakMap<
    object,
    {
      installationId: string
      runtimeId: string
      tenantRef: string
      bindingId: string
      connectionId: string
      channelBinding: string
      scope: ScopeRef
      transport: 'local'
      localGate: 'local-peer'
    }
  >()
  function capture(context: CallContext) {
    const actor = authority.current(context)
    if (actor?.source.kind !== 'deployment') throw new Error('Original local context is required')
    const sourceGeneration = actor.source.generation
    const entry = [...live].find(([, generation]) => generation === sourceGeneration)
    if (!entry) throw new Error('Original local connection is unavailable')
    const row = connectionGet(entry[0]),
      originalClaims = claimsGet(actor.authorizationRef)?.body_json
    if (!row || typeof originalClaims !== 'string')
      throw new Error('Original local identity evidence is missing')
    const fence = captureIdentityCurrentFence(authority, context)
    if (!fence) throw new Error('Original local identity fence is unavailable')
    const entryId = entry[0]
    const originalRow = row
    const authorizationRef = actor.authorizationRef
    function staticCheck() {
      owner.staticCheck()
      installationCurrent()
      const current = connectionGet(entryId)
      if (
        closed ||
        readLive(entryId) !== originalRow.generation ||
        current?.generation !== sourceGeneration ||
        current.installation_id !== originalRow.installation_id ||
        current.process_id !== originalRow.process_id ||
        current.closed !== 0 ||
        claimsGet(authorizationRef)?.body_json !== originalClaims
      )
        throw new Error('Original local identity evidence changed')
    }
    return Object.freeze({
      deadline: actor.identity.expiresAt,
      dynamicCheck() {
        if (!authority.current(context)) throw new Error('Original local identity is no longer current')
        staticCheck()
      },
      staticCheck,
      finalCheck() {
        if (!fence(staticCheck)) throw new Error('Original local identity final fence refused')
      },
    })
  }
  async function connect(signal: AbortSignal) {
    if (closed || signal.aborted || enrolling || db.isTransaction)
      throw new Error('Local authentication is unavailable')
    owner.dynamicCheck()
    installationCurrent()
    const connection = Object.freeze({})
    const connectionId = randomUUID(),
      generation = randomUUID()
    const facts = {
      installationId: scope.installationId,
      runtimeId: scope.runtimeId,
      tenantRef: stateAuthority.tenantId,
      bindingId,
      connectionId,
      channelBinding: canonicalJsonDigest({ connectionId, generation, installation: configDigest }),
      scope,
      transport: 'local' as const,
      localGate: 'local-peer' as const,
    }
    connections.set(connection, Object.freeze(facts))
    const deadline = new Date(now() + 300000).toISOString()
    const accepted = ingress.legacy(connection, {}, undefined, signal, deadline, randomUUID())
    if (!accepted || !ingress.inspect(accepted.operation, accepted.context))
      throw new Error('Original local ingress is unavailable')
    const association = ingress.inspect(accepted.operation, accepted.context)
    if (!association) throw new Error('Original local ingress association is unavailable')
    const request = association.input
    const credential = decodeIdentityData(
      'LegacyIdentityCredentialEnvelope',
      RuntimeSchemaRefs.LegacyIdentityCredentialEnvelope,
      request.credentialEnvelope,
    )
    const evidence = decodeIdentityData(
      'LegacyIdentityTransportEvidence',
      RuntimeSchemaRefs.LegacyIdentityTransportEvidence,
      request.transportEvidence,
    )
    if (!credential || !evidence || credential.kind !== 'local')
      throw new Error('Original local ingress facts are invalid')
    const verified = verifyIdentityCredential(credential, evidence, { now, generation, nonces })
    if (!verified.ok) throw new Error('Original local credential was refused')
    enrolling = true
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        'INSERT INTO runtime_local_identity_connections(id,installation_id,generation,process_id) VALUES(?,?,?,?)',
      ).run(connectionId, configDigest, generation, process.pid)
      live.set(connectionId, generation)
      const actor = await authority.accept({
        verified: verified.value,
        principalRef: owner.facts.principalRef,
        tenantRef: stateAuthority.tenantId,
        bindingId,
        scope,
        signal,
        source: { kind: 'deployment', generation, keyId: null },
      })
      if (!actor || signal.aborted) throw new Error('Original local authentication could not be issued')
      const issuanceContext = authority.issue(actor.authorizationRef, {
        bindingId,
        scope,
        invocationId: randomUUID(),
        traceRef: randomUUID(),
        deadline,
        signal,
      })
      if (!issuanceContext) throw new Error('Original local issuance context is unavailable')
      const issuanceCapture = capture(issuanceContext)
      issuanceCapture.dynamicCheck()
      issuanceCapture.finalCheck()
      db.exec('COMMIT')
      return Object.freeze({
        actor,
        issue(deadline: Timestamp, traceRef: string): CallContext {
          const context = authority.issue(actor.authorizationRef, {
            bindingId,
            scope,
            invocationId: randomUUID(),
            traceRef,
            deadline,
            signal,
          })
          if (!context) throw new Error('Original local authentication is not current')
          return context
        },
        close() {
          live.delete(connectionId)
          connections.delete(connection)
          authority.revoke(actor.authorizationRef)
          db.prepare('UPDATE runtime_local_identity_connections SET closed=1 WHERE id=?').run(connectionId)
        },
      })
    } catch (error) {
      live.delete(connectionId)
      connections.delete(connection)
      db.exec('ROLLBACK')
      throw error
    } finally {
      enrolling = false
    }
  }
  return Object.freeze({
    connect,
    capture,
    revoke() {
      db.prepare('UPDATE runtime_local_identity_installation SET revoked=1 WHERE id=?').run(configDigest)
    },
    close() {
      closed = true
      live.clear()
      ingress.close()
      authority.close()
    },
  })
}
