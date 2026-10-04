import { createHmac, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type { RunBinding } from '@agnes/protocol/runtime'
import { createAdmissionCoordinator } from '../../../src/runtime/assembly/admission.js'
import { createAdmissionTickets } from '../../../src/runtime/assembly/admission-ticket.js'
import { journalData, journalRef } from '../../../src/runtime/assembly/maintenance-journal.js'
import { createIdentityAuthority } from '../../../src/runtime/identity/authority.js'
import { createIdentityNonceOwner } from '../../../src/runtime/identity/nonce.js'
import { verifyIdentityJwt } from '../../../src/runtime/identity/verify.js'
import { createRuntimeStateStore } from '../../../src/runtime/providers/state.js'
import {
  createRuntimeAdmissionSource,
  type RuntimeAdmissionFacts,
} from '../../../src/runtime/state/admission.js'
import { RuntimeStateDatabase } from '../../../src/runtime/state/transactions.js'
import type { AdmissionFixtureInput } from './assembly-admission-fixture.js'
import { sameConnectionMaintenance } from './assembly-admission-maintenance.js'
import { maintenanceFixtureRecord } from './assembly-maintenance.js'
import { fixtureHash, fixtureRef, fixtureWire } from './assembly-maintenance-wire.js'

/** Test-only maintenance composition. State, C14 and their transaction guards are the real owners. */
export async function openJointAdmission(
  directory: string,
  input: AdmissionFixtureInput,
  checkpoint: (point: string) => void = () => {},
  split: false | 'separate-file' | 'separate-connection' = false,
) {
  const authority = { authorityId: 'fixture-state', tenantId: 'fixture-tenant', authorityEpoch: 1 }
  const scope = {
    kind: 'runtime' as const,
    installationId: 'fixture-installation',
    runtimeId: 'fixture-runtime',
  }
  const now = () => Date.parse(input.fixture.now)
  let operation = ''
  const options = {
    file: join(directory, 'joint.sqlite'),
    authority,
    now,
    beforeCommit: () => checkpoint(`${operation}:before`),
    onCommit: (notice: { method: string }) => {
      if (notice.method === 'createRun') checkpoint('create:after')
      if (notice.method === 'cancelAdmission') checkpoint('cancel:after')
    },
  }
  const state = new RuntimeStateDatabase(options)
  // The restricted installation seam is also used by State's own issuer acceptance tests.
  const native = Object.values(Object.getOwnPropertyDescriptors(state))
    .map((slot) => slot.value)
    .find((value) => value instanceof DatabaseSync)
  if (!(native instanceof DatabaseSync)) throw Error('original native State connection unavailable')
  const db = native
  const issuerDb = split
    ? new DatabaseSync(split === 'separate-file' ? join(directory, 'maintenance.sqlite') : options.file)
    : db
  issuerDb.exec(`CREATE TABLE IF NOT EXISTS runtime_admission_source_issued (
    source_id TEXT PRIMARY KEY,ticket_id TEXT UNIQUE NOT NULL,source_json TEXT NOT NULL,
    source_digest TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,decision_json TEXT,decision_digest TEXT)`)
  db.exec('CREATE TABLE IF NOT EXISTS joint_claims (id TEXT PRIMARY KEY,body TEXT NOT NULL)')
  const identity = createIdentityAuthority(
    db,
    {
      async create(binding) {
        const ref = fixtureRef({ principal: binding.principalRef })
        db.prepare('INSERT INTO joint_claims VALUES (?,?)').run(
          binding.authorizationRef,
          jcs({ ref, binding }),
        )
        return ref
      },
      validate(ref, binding) {
        return (
          db.prepare('SELECT body FROM joint_claims WHERE id=?').get(binding.authorizationRef)?.body ===
          jcs({ ref, binding })
        )
      },
    },
    now,
    (actor, target) => actor.bindingId === target.bindingId && jcs(actor.scope) === jcs(target.scope),
    () => true,
  )
  const source = createRuntimeAdmissionSource({ database: issuerDb, identity, authority })
  try {
    state.installAdmissionSource(source)
  } catch (error) {
    identity.close()
    if (split) issuerDb.close()
    state.close()
    throw error
  }
  const key = randomBytes(32).toString('hex')
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'joint-issuer',
      sub: 'fixture-principal',
      exp: Date.parse('2030-01-01T00:00:00Z') / 1000,
    }),
  ).toString('base64url')
  const signature = createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url')
  const verified = verifyIdentityJwt(`${header}.${payload}.${signature}`, {
    now,
    generation: 'joint',
    nonces: createIdentityNonceOwner(db),
    jwt: { issuer: 'joint-issuer', secret: key },
  })
  if (!verified.ok) throw Error('real JWT refused')
  // Reuse the persisted actor after cold reopen so ticket grantRef remains the original identity.
  const saved = db.prepare('SELECT body FROM joint_claims ORDER BY rowid LIMIT 1').get()
  let authorizationRef: string
  if (saved) {
    authorizationRef = String(JSON.parse(String(saved.body)).binding.authorizationRef)
  } else {
    const actor = await identity.accept({
      verified: verified.value,
      principalRef: 'fixture-principal',
      tenantRef: authority.tenantId,
      bindingId: 'fixture-binding',
      scope,
      signal: new AbortController().signal,
      source: { kind: 'deployment', generation: 'joint', keyId: 'fixture' },
    })
    if (!actor) throw Error('real identity refused')
    authorizationRef = actor.authorizationRef
  }
  const context = (signal = new AbortController().signal): CallContext => {
    const value = identity.issue(authorizationRef, {
      bindingId: 'fixture-binding',
      scope,
      invocationId: 'fixture-invocation',
      deadline: '2030-01-01T00:00:00Z',
      traceRef: 'fixture-trace',
      signal,
    })
    if (!value) throw Error('original C14 context refused')
    return value
  }
  const release = input.fixture.previousRelease
  if (!release) throw Error('locked release missing')
  const binding: RunBinding = fixtureWire('RunBinding', {
    bindingId: 'fixture-old-binding',
    releaseSetId: release.releaseSetId,
    profileDigest: release.profileRef.digest,
    presetDigest: release.presetRef.digest,
    createdAt: input.fixture.now,
    minimumRecovery: 'R0',
    stateAuthorityAtCreation: authority,
    filesystemPolicy: {
      policyId: 'fixture-fs',
      digest: fixtureHash('fixture-fs'),
      scope,
      compilerVersion: 'fixture',
      roots: [],
      rules: [],
    },
    telemetryConsent: {
      sessionId: 'fixture-session',
      level: 'LOCAL',
      sourceDigest: fixtureHash('fixture-consent'),
      profileId: 'fixture-profile',
      recordedAt: input.fixture.now,
      explicitFull: false,
      evidence: 'trusted-config',
    },
    providers: release.bindings,
    jointDispatchDomains: [],
  })
  const maintenance = sameConnectionMaintenance(db, (call) => identity.current(call) !== null, {
    issue(request, call) {
      if (!request.transactionId.startsWith('ticket:')) return
      const row = request.mutations.find((mutation) => mutation.recordId.startsWith('ticket:'))
      const pinRow = request.mutations.find((mutation) => mutation.recordId.startsWith('pin:admission:'))
      if (!row || !pinRow || !db.isTransaction) throw Error('original issuance transaction missing')
      const ticket = journalData(row.next, 'admission-ticket')
      const admission = fixtureWire('RunAdmission', ticket.admission)
      const pin = journalData(pinRow.next, 'package-pin-receipt')
      if (admission.bindingId !== binding.bindingId || admission.releaseSetId !== binding.releaseSetId)
        throw Error('locked binding differs')
      if (!Array.isArray(pin.requiredDigests)) throw Error('original pin digests missing')
      const facts: RuntimeAdmissionFacts = {
        sourceId: `source:${admission.ticketId}`,
        authority,
        admission,
        runBinding: binding,
        pin: {
          ticketId: admission.ticketId,
          releaseSetId: admission.releaseSetId,
          bindingId: admission.bindingId,
          requiredDigests: pin.requiredDigests.map((digest) => fixtureWire('Digest', digest)),
          commitRef: journalRef(
            { transactionId: request.transactionId, authority: request.authority },
            'issuance-commit',
          ),
          receipt: admission.packagePinReceipt,
        },
        qualifiedUntil: call.deadline,
        scope: call.scope,
        callerBindingId: call.bindingId,
        producerCodeDigest: fixtureHash('joint-maintenance-native-issuer'),
      }
      db.prepare(
        'INSERT INTO runtime_admission_source_issued(source_id,ticket_id,source_json,source_digest) VALUES (?,?,?,?)',
      ).run(facts.sourceId, admission.ticketId, JSON.stringify(facts), fixtureHash(facts))
    },
    async beforeCommit(request) {
      checkpoint(request.transactionId.startsWith('ticket:') ? 'issue:before' : 'confirm:before')
    },
    async afterCommit(request) {
      checkpoint(request.transactionId.startsWith('ticket:') ? 'issue:after' : 'confirm:after')
    },
  })
  const headRecordId = 'fixture-current-head'
  if (!maintenance.get(headRecordId)) {
    maintenance.seed(
      maintenanceFixtureRecord(headRecordId, 'current-head', {
        directory: input.fixture.directory,
        stateAuthorityRef: authority,
      }),
    )
    maintenance.seed(
      maintenanceFixtureRecord(`release:${release.releaseSetId}`, 'release-snapshot', {
        canonicalJson: jcs(release),
        contentDigest: fixtureHash(release),
      }),
    )
    maintenance.seed(
      maintenanceFixtureRecord(`release-route:${input.plan.routeId}`, 'release-route', {
        routeId: input.plan.routeId,
        activeReleaseSetId: release.releaseSetId,
        authorityEpoch: 1,
        cutoverId: 'fixture-original',
      }),
    )
  }
  const ports = {
    qualification: 'persistent-fixture' as const,
    store: maintenance.store,
    authority: maintenance.authority,
    target: maintenance.target,
    writerEpoch: 1,
    headRecordId,
    credential: {
      principalRef: 'fixture-principal',
      directoryId: 'fixture-directory',
      credentialDigest: fixtureHash('fixture'),
    },
    now: () => input.fixture.now,
    async authorize(call: CallContext) {
      return identity.current(call) !== null
    },
  }
  const store = createRuntimeStateStore(options, state)
  const observedStore = {
    ...store,
    createRun: (...args: Parameters<typeof store.createRun>) => {
      operation = 'create'
      return store.createRun(...args)
    },
    cancelAdmission: (...args: Parameters<typeof store.cancelAdmission>) => {
      operation = 'cancel'
      return store.cancelAdmission(...args)
    },
  }
  const coordinator = createAdmissionCoordinator(ports, {
    qualification: 'same-database-state-admission',
    store: observedStore,
  })
  const tickets = createAdmissionTickets(ports)
  const draft = () => ({
    runKey: 'fixture-key-old',
    stateAuthorityRef: authority,
    grantRef: authorizationRef,
    admission: {
      ticketId: 'fixture-ticket-old',
      releaseSetId: release.releaseSetId,
      bindingId: binding.bindingId,
      runId: 'fixture-run-old',
      sessionId: 'fixture-session',
      lane: 'foreground',
      workspaceId: 'fixture-workspace',
      input: fixtureRef({ prompt: 'synthetic' }),
      admittedAt: input.fixture.now,
      deadline: '2027-01-01T00:00:00Z',
      conversation: null,
    },
  })
  return {
    db,
    state,
    source,
    store,
    coordinator,
    tickets,
    draft,
    context,
    binding,
    maintenance,
    inspect() {
      return {
        created: db.prepare('SELECT ticket_id,run_id,probe_json FROM runtime_admissions').all(),
        cancelled: db.prepare('SELECT ticket_id,tombstone_id FROM runtime_admission_tombstones').all(),
        proofs: db.prepare('SELECT ticket_id,commit_id FROM runtime_admission_source_proofs').all(),
        issuer: db
          .prepare(
            'SELECT ticket_id,source_digest,decision_json,decision_digest FROM runtime_admission_source_issued',
          )
          .all(),
        records: maintenance
          .inspect()
          .records.filter((row) => /^(ticket:|pin:admission:)/.test(row.recordId)),
        bindings: db
          .prepare(
            "SELECT value_json FROM runtime_version_bodies WHERE json_extract(value_json,'$.bindingId') = ? AND json_extract(value_json,'$.providers') IS NOT NULL",
          )
          .all(binding.bindingId),
      }
    },
    async close() {
      await coordinator.dispose()
      maintenance.close()
      identity.close()
      state.close()
    },
  }
}
