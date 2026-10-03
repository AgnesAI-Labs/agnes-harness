import { createHmac, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, RunAdmission, StateAuthorityRef } from '@agnes/extension-api/runtime'
import { type DataRef, type RunBinding, validateRuntime } from '@agnes/protocol/runtime'
import { createIdentityAuthority } from '../../src/runtime/identity/authority.js'
import { createIdentityNonceOwner } from '../../src/runtime/identity/nonce.js'
import { verifyIdentityJwt } from '../../src/runtime/identity/verify.js'
import {
  createRuntimeAdmissionSource,
  type RuntimeAdmissionFacts,
} from '../../src/runtime/state/admission.js'
import { canonicalJson } from '../../src/runtime/state/canonical-json.js'
import { digestOf } from '../../src/runtime/state/records.js'
import { refuse } from '../../src/runtime/state/refusal.js'
import type { RuntimeStateDatabase } from '../../src/runtime/state/transactions.js'

function inline(value: Record<string, string>): DataRef {
  return {
    kind: 'inline',
    schema: {
      typeId: 'fixture.admission/claims@1',
      revision: 1,
      digest: digestOf({ $id: 'fixture.admission/claims@1', type: 'object' }),
    },
    value,
    digest: digestOf(value),
    bytes: Buffer.byteLength(canonicalJson(value)),
  }
}
/** Restricted native issuer for old acceptance inputs. It signs credentials and retains every issuance. */
export function createAdmissionAcceptanceIssuer(
  state: RuntimeStateDatabase,
  authority: StateAuthorityRef,
  now: () => number,
  actorIdentity: Pick<CallContext, 'principalRef' | 'bindingId' | 'scope'> = {
    principalRef: 'principal-1',
    bindingId: 'binding-1',
    scope: { installationId: 'install-1', kind: 'installation' },
  },
) {
  const selectedDatabase = Object.values(Object.getOwnPropertyDescriptors(state))
    .map((d) => d.value)
    .find((v) => v instanceof DatabaseSync)
  if (!(selectedDatabase instanceof DatabaseSync)) throw Error('original State native connection unavailable')
  const db = selectedDatabase
  db.exec(
    'CREATE TABLE IF NOT EXISTS runtime_admission_source_issued (source_id TEXT PRIMARY KEY,ticket_id TEXT UNIQUE NOT NULL,source_json TEXT NOT NULL,source_digest TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,decision_json TEXT,decision_digest TEXT)',
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS admission_acceptance_claims (authorization_ref TEXT PRIMARY KEY,value_json TEXT NOT NULL)',
  )
  const identity = createIdentityAuthority(
    db,
    {
      async create(binding) {
        const ref = inline({ principal: binding.principalRef })
        db.prepare('INSERT INTO admission_acceptance_claims VALUES (?,?)').run(
          binding.authorizationRef,
          canonicalJson({ ref, binding }),
        )
        return ref
      },
      validate(ref, binding) {
        return (
          db
            .prepare('SELECT value_json FROM admission_acceptance_claims WHERE authorization_ref=?')
            .get(binding.authorizationRef)?.value_json === canonicalJson({ ref, binding })
        )
      },
    },
    now,
    (actor, target) =>
      actor.bindingId === target.bindingId && canonicalJson(actor.scope) === canonicalJson(target.scope),
    () => true,
  )
  const source = createRuntimeAdmissionSource({ database: db, identity, authority })
  state.installAdmissionSource(source)
  const signing = randomBytes(32).toString('hex')
  const nonces = createIdentityNonceOwner(db)
  const ready = (async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'acceptance-issuer',
        sub: actorIdentity.principalRef,
        exp: (now() + 180 * 24 * 60 * 60 * 1000) / 1000,
      }),
    ).toString('base64url')
    const signature = createHmac('sha256', signing).update(`${header}.${payload}`).digest('base64url')
    const verified = verifyIdentityJwt(`${header}.${payload}.${signature}`, {
      now,
      generation: 'acceptance',
      nonces,
      jwt: { issuer: 'acceptance-issuer', secret: signing },
    })
    if (!verified.ok) throw Error('actual acceptance JWT refused')
    const actor = await identity.accept({
      verified: verified.value,
      principalRef: actorIdentity.principalRef,
      tenantRef: authority.tenantId,
      bindingId: actorIdentity.bindingId,
      scope: actorIdentity.scope,
      signal: new AbortController().signal,
      source: { kind: 'deployment', generation: 'acceptance', keyId: 'fixture' },
    })
    if (!actor) throw Error('actual acceptance identity refused')
    return actor
  })()
  async function issue(admission: RunAdmission, input: CallContext): Promise<CallContext> {
    const actor = await ready
    // Fixture issuance belongs outside the Runtime writer transaction, including a queued refusal.
    const queued = Object.getOwnPropertyDescriptor(state, 'writeChain')?.value
    if (queued instanceof Promise) await queued
    const context = identity.issue(actor.authorizationRef, {
      bindingId: input.bindingId,
      scope: input.scope,
      invocationId: input.invocationId,
      traceRef: input.traceRef,
      deadline: input.deadline,
      signal: input.signal,
    })
    if (!context) throw Error('actual acceptance context refused')
    const existing = db
      .prepare('SELECT ticket_id FROM runtime_admission_source_issued WHERE ticket_id=?')
      .get(admission.ticketId)
    if (!existing) {
      if (
        db
          .prepare('SELECT ticket_id FROM runtime_admission_source_proofs WHERE ticket_id=?')
          .get(admission.ticketId)
      )
        refuse('incompatible', 'admission_source', 'original native issuance missing; replay cannot reissue')
      const runBinding: RunBinding = {
        bindingId: admission.bindingId,
        releaseSetId: admission.releaseSetId,
        profileDigest: digestOf({ profile: admission.bindingId }),
        presetDigest: digestOf({ preset: admission.bindingId }),
        createdAt: admission.admittedAt,
        minimumRecovery: 'R1',
        stateAuthorityAtCreation: authority,
        filesystemPolicy: {
          policyId: 'acceptance-policy',
          digest: digestOf({ policy: 'acceptance' }),
          scope: input.scope,
          compilerVersion: 'fixture',
          roots: [],
          rules: [],
        },
        telemetryConsent: {
          sessionId: admission.sessionId,
          level: 'DISABLED',
          sourceDigest: digestOf({ consent: 0 }),
          profileId: 'profile',
          recordedAt: admission.admittedAt,
          explicitFull: false,
          evidence: 'trusted-config',
        },
        providers: [],
        jointDispatchDomains: [],
      }
      if (!validateRuntime('RunBinding', runBinding).ok)
        throw Error('official locked RunBinding codec refused')
      const facts: RuntimeAdmissionFacts = {
        sourceId: `source:${admission.ticketId}`,
        authority,
        admission,
        runBinding,
        pin: {
          ticketId: admission.ticketId,
          releaseSetId: admission.releaseSetId,
          bindingId: admission.bindingId,
          requiredDigests: [admission.input.schema.digest],
          commitRef: inline({ commit: `issuance:${admission.ticketId}` }),
          receipt: admission.packagePinReceipt,
        },
        qualifiedUntil: input.deadline,
        scope: input.scope,
        callerBindingId: input.bindingId,
        producerCodeDigest: digestOf({ code: 'restricted-admission-native-issuer-v1' }),
      }
      if (!identity.current(context)) throw Error('issuer qualification changed')
      db.prepare(
        'INSERT INTO runtime_admission_source_issued(source_id,ticket_id,source_json,source_digest) VALUES(?,?,?,?)',
      ).run(facts.sourceId, admission.ticketId, JSON.stringify(facts), digestOf(facts))
    }
    return context
  }
  return { issue, ready, source, identity, db, close: () => identity.close() }
}
