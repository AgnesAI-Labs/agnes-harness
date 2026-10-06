import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type DataRef, type RunAdmission, type RunBinding, validateRuntime } from '@agnes/protocol/runtime'
import { afterEach, expect, it } from 'vitest'
import { createIdentityAuthority } from '../src/runtime/identity/authority.js'
import { createIdentityNonceOwner } from '../src/runtime/identity/nonce.js'
import { verifyIdentityJwt } from '../src/runtime/identity/verify.js'
import { createRuntimeStateStore } from '../src/runtime/providers/state.js'
import { createRuntimeAdmissionSource, type RuntimeAdmissionFacts } from '../src/runtime/state/admission.js'
import { canonicalJson } from '../src/runtime/state/canonical-json.js'
import { digestOf } from '../src/runtime/state/records.js'
import { RuntimeStateDatabase } from '../src/runtime/state/transactions.js'

const at = '2026-04-01T00:00:00.000Z'
const until = '2026-04-01T00:10:00.000Z'
const authority = { authorityId: 'state', tenantId: 'tenant', authorityEpoch: 1 }
const scope = { installationId: 'installation', kind: 'installation' as const }
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})
function inline(value: Record<string, string>): DataRef {
  const text = canonicalJson(value)
  return {
    kind: 'inline',
    schema: {
      typeId: 'fixture.admission/json@1',
      revision: 1,
      digest: digestOf({ $id: 'fixture.admission/json@1', type: 'object' }),
    },
    value,
    digest: digestOf(value),
    bytes: Buffer.byteLength(text),
  }
}
async function issueIdentity(db: DatabaseSync, clockHook: () => void) {
  const identity = createIdentityAuthority(
    db,
    {
      async create(binding) {
        const ref = inline({ principal: binding.principalRef })
        db.prepare('INSERT INTO admission_claims VALUES (?,?)').run(
          binding.authorizationRef,
          canonicalJson({ ref, binding }),
        )
        return ref
      },
      validate(ref, binding) {
        return (
          db
            .prepare('SELECT value_json FROM admission_claims WHERE authorization_ref=?')
            .get(binding.authorizationRef)?.value_json === canonicalJson({ ref, binding })
        )
      },
    },
    () => {
      clockHook()
      return Date.parse(at)
    },
    (_actor, target) =>
      target.bindingId === 'controller' && canonicalJson(target.scope) === canonicalJson(scope),
    () => true,
  )
  const signing = randomBytes(32)
  const h = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const p = Buffer.from(
    JSON.stringify({ iss: 'issuer', sub: 'controller', exp: Date.parse(until) / 1000 }),
  ).toString('base64url')
  const key = signing.toString('hex')
  const signature = createHmac('sha256', key).update(`${h}.${p}`).digest('base64url')
  const credential = verifyIdentityJwt(`${h}.${p}.${signature}`, {
    now: () => Date.parse(at),
    generation: 'generation',
    nonces: createIdentityNonceOwner(db),
    jwt: { issuer: 'issuer', secret: key },
  })
  if (!credential.ok) throw Error('actual JWT refused')
  const actor = await identity.accept({
    verified: credential.value,
    principalRef: 'controller',
    tenantRef: 'tenant',
    bindingId: 'controller',
    scope,
    signal: new AbortController().signal,
    source: { kind: 'deployment', generation: 'generation', keyId: 'fixture' },
  })
  if (!actor) throw Error('actual identity refused')
  const context = identity.issue(actor.authorizationRef, {
    bindingId: 'controller',
    scope,
    invocationId: 'admit',
    traceRef: 'trace',
    deadline: until,
    signal: new AbortController().signal,
  })
  if (!context) throw Error('genuine context refused')
  return { identity, actor, context }
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-admission-'))
  const file = join(dir, 'state.sqlite')
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let hook = () => {}
  let clockHook = () => {}
  const state = new RuntimeStateDatabase({
    file,
    authority,
    now: () => Date.parse(at),
    beforeCommit: () => hook(),
  })
  cleanups.push(() => state.close())
  const db = Object.values(Object.getOwnPropertyDescriptors(state))
    .map((d) => d.value)
    .find((v) => v instanceof DatabaseSync)
  if (!(db instanceof DatabaseSync)) throw Error('genuine native State connection missing')
  db.exec(
    'CREATE TABLE runtime_admission_source_issued (source_id TEXT PRIMARY KEY, ticket_id TEXT UNIQUE NOT NULL, source_json TEXT NOT NULL, source_digest TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,decision_json TEXT,decision_digest TEXT)',
  )
  db.exec('CREATE TABLE admission_claims (authorization_ref TEXT PRIMARY KEY, value_json TEXT NOT NULL)')
  const { identity, actor, context } = await issueIdentity(db, () => clockHook())
  cleanups.push(() => identity.close())
  const admission: RunAdmission = {
    ticketId: 'ticket',
    fingerprint: digestOf({ ticket: 'ticket', input: 'hello' }),
    releaseSetId: 'release',
    bindingId: 'run-binding',
    packagePinReceipt: inline({ pin: 'retained-package' }),
    runId: 'run',
    sessionId: 'session',
    lane: 'main',
    workspaceId: 'workspace',
    input: inline({ text: 'hello' }),
    admittedAt: at,
    deadline: until,
    conversation: null,
  }
  const runBinding: RunBinding = {
    bindingId: 'run-binding',
    releaseSetId: 'release',
    profileDigest: digestOf({ profile: 1 }),
    presetDigest: digestOf({ preset: 1 }),
    createdAt: at,
    minimumRecovery: 'R1',
    stateAuthorityAtCreation: authority,
    filesystemPolicy: {
      policyId: 'policy',
      digest: digestOf({ policy: 1 }),
      scope,
      compilerVersion: 'fixture',
      roots: [],
      rules: [],
    },
    telemetryConsent: {
      sessionId: 'session',
      level: 'DISABLED',
      sourceDigest: digestOf({ consent: 0 }),
      profileId: 'profile',
      recordedAt: at,
      explicitFull: false,
      evidence: 'trusted-config',
    },
    providers: [],
    jointDispatchDomains: [],
  }
  if (!validateRuntime('RunBinding', runBinding).ok) throw Error('real RunBinding codec refused')
  const facts: RuntimeAdmissionFacts = {
    sourceId: 'source',
    authority,
    admission,
    runBinding,
    pin: {
      ticketId: 'ticket',
      releaseSetId: 'release',
      bindingId: 'run-binding',
      requiredDigests: [admission.input.schema.digest],
      commitRef: inline({ commit: 'maintenance-issuance' }),
      receipt: admission.packagePinReceipt,
    },
    qualifiedUntil: until,
    scope,
    callerBindingId: 'controller',
    producerCodeDigest: digestOf({ code: 'restricted-native-ticket-issuer-v1' }),
  }
  if (!identity.current(context)) throw Error('issuer no longer authorized')
  db.prepare(
    'INSERT INTO runtime_admission_source_issued(source_id,ticket_id,source_json,source_digest) VALUES(?,?,?,?)',
  ).run(facts.sourceId, admission.ticketId, JSON.stringify(facts), digestOf(facts))
  const source = createRuntimeAdmissionSource({ database: db, identity, authority })
  state.installAdmissionSource(source)
  const opened = state
  // Both owners use the original source connection; only the State writer owns business rows.
  return {
    state: opened,
    source,
    db,
    file,
    admission,
    context,
    identity,
    actor,
    setHook: (h: () => void) => {
      hook = h
    },
    setClock: (h: () => void) => {
      clockHook = h
    },
    legacy: state,
    async reopen() {
      identity.close()
      state.close()
      const restored = new RuntimeStateDatabase({ file, authority })
      cleanups.push(() => restored.close())
      const native = Object.values(Object.getOwnPropertyDescriptors(restored))
        .map((d) => d.value)
        .find((v) => v instanceof DatabaseSync)
      if (!(native instanceof DatabaseSync)) throw Error('fresh native connection missing')
      const auth = await issueIdentity(native, () => {})
      cleanups.push(() => auth.identity.close())
      const freshSource = createRuntimeAdmissionSource({
        database: native,
        identity: auth.identity,
        authority,
      })
      restored.installAdmissionSource(freshSource)
      return { state: restored, db: native, context: auth.context }
    },
  }
}
it('cancels before create, preserves one authority tombstone and replays without creating a session', async () => {
  const f = await fixture()
  await expect(f.state.probeAdmission('ticket', f.context)).rejects.toMatchObject({
    failure: { code: 'denied', detailCode: 'admission_absence_unproven' },
  })
  const result = await f.state.cancelAdmission('ticket', f.admission.fingerprint, f.context)
  expect(result.state).toBe('cancelled')
  expect(await f.state.cancelAdmission('ticket', f.admission.fingerprint, f.context)).toEqual(result)
  await expect(f.state.createRun({ admission: f.admission, scope }, f.context)).rejects.toThrow(/cancelled/)
  expect(f.db.prepare('SELECT count(*) n FROM runtime_admission_tombstones').get()?.n).toBe(1)
  expect(f.db.prepare('SELECT count(*) n FROM sessions').get()?.n).toBe(0)
  await expect(f.state.cancelAdmission('ticket', '0'.repeat(64), f.context)).rejects.toThrow(/fingerprint/)
})
it('rejects forged pin and rolls back cancellation when the real source is revoked before COMMIT', async () => {
  const f = await fixture()
  await expect(
    f.state.createRun(
      { admission: { ...f.admission, packagePinReceipt: inline({ pin: 'forged' }) }, scope },
      f.context,
    ),
  ).rejects.toThrow(/original ticket/)
  let reached = 0
  f.setHook(() => {
    reached++
    expect(f.identity.revoke(f.actor.authorizationRef)).toBe(true)
    expect(
      f.db
        .prepare('SELECT revoked FROM runtime_identity_instances WHERE authorization_ref=?')
        .get(f.actor.authorizationRef)?.revoked,
    ).toBe(1)
  })
  await expect(f.state.cancelAdmission('ticket', f.admission.fingerprint, f.context)).rejects.toThrow()
  expect(reached).toBe(1)
  expect(
    f.db
      .prepare('SELECT revoked FROM runtime_identity_instances WHERE authorization_ref=?')
      .get(f.actor.authorizationRef)?.revoked,
  ).toBe(0)
  expect(f.db.prepare('SELECT count(*) n FROM runtime_admission_tombstones').get()?.n).toBe(0)
})
it('keeps original unselected direct database genesis and attested replay available', async () => {
  const f = await fixture()
  const dir = mkdtempSync(join(tmpdir(), 'admission-legacy-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const legacy = new RuntimeStateDatabase({ file: join(dir, 'state.sqlite'), authority })
  cleanups.push(() => legacy.close())
  const first = await legacy.createRun({ admission: f.admission, scope })
  expect(first.state).toBe('created')
  expect(await legacy.createRun({ admission: f.admission, scope })).toEqual(first)
  const legacyDb = Object.values(Object.getOwnPropertyDescriptors(legacy))
    .map((d) => d.value)
    .find((v) => v instanceof DatabaseSync)
  if (!(legacyDb instanceof DatabaseSync)) throw Error('native legacy connection missing')
  expect(legacyDb.prepare("SELECT count(*) n FROM events WHERE type='runtime/state-commit'").get()?.n).toBe(1)
})
it('denies production create without selected maintenance source', async () => {
  const f = await fixture()
  const provider = createRuntimeStateStore({ file: f.file, authority })
  // Registered after the fixture's directory removal, so it closes first (Windows cannot remove an open file).
  cleanups.push(() => provider.close())
  const result = await provider.createRun(f.admission, f.context)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe('denied')
})

it('rejects deleted tombstone instead of claiming absent and rejects changed authority proof bytes', async () => {
  const f = await fixture()
  await f.state.cancelAdmission('ticket', f.admission.fingerprint, f.context)
  f.db.prepare('DELETE FROM runtime_admission_tombstones WHERE ticket_id=?').run('ticket')
  await expect(f.state.probeAdmission('ticket', f.context)).rejects.toThrow(/original decision/)
})
it('rejects same-shaped contexts and duplicate or foreign-connection installation', async () => {
  const f = await fixture()
  await expect(f.state.cancelAdmission('ticket', f.admission.fingerprint, { ...f.context })).rejects.toThrow(
    /issued identity/,
  )
  expect(() => f.state.installAdmissionSource(f.source)).toThrow(/once/)
  const other = new RuntimeStateDatabase({ file: f.file, authority })
  cleanups.push(() => other.close())
  expect(() => other.installAdmissionSource(f.source)).toThrow(/original State connection/)
})

it('reads the original cancellation through a new State, source and genuine current issuer', async () => {
  const f = await fixture()
  const result = await f.state.cancelAdmission('ticket', f.admission.fingerprint, f.context)
  const fresh = await f.reopen()
  expect(await fresh.state.probeAdmission('ticket', fresh.context)).toEqual(result)
  expect(await fresh.state.cancelAdmission('ticket', f.admission.fingerprint, fresh.context)).toEqual(result)
  expect(fresh.db.prepare('SELECT count(*) n FROM runtime_admission_tombstones').get()?.n).toBe(1)
  fresh.db.prepare('DELETE FROM runtime_admission_source_issued WHERE ticket_id=?').run('ticket')
  await expect(fresh.state.probeAdmission('ticket', fresh.context)).rejects.toThrow(/issuance is unavailable/)
})

it('does not infer complete absence after all local decision and proof rows are removed', async () => {
  const f = await fixture()
  await f.state.cancelAdmission('ticket', f.admission.fingerprint, f.context)
  f.db.exec(
    'DELETE FROM runtime_admission_tombstones; DELETE FROM runtime_admission_source_proofs; DELETE FROM runtime_admissions',
  )
  await expect(f.state.probeAdmission('ticket', f.context)).rejects.toMatchObject({
    failure: { code: 'incompatible', detailCode: 'integrity' },
  })
})

it('creates first with full RunBinding in the original commit and cold-probes after all owners close', async () => {
  const f = await fixture()
  const created = await f.state.createRun({ admission: f.admission, scope }, f.context)
  expect(created.state).toBe('created')
  if (created.state !== 'created') throw Error('no original created receipt')
  const binding = f.db.prepare('SELECT * FROM runtime_records WHERE record_id=?').get('run-binding:run')
  expect(binding?.last_commit_id).toBe(created.commit.commitId)
  expect(binding?.record_revision).toBe(1)
  const counts = () =>
    ['events', 'runtime_admissions', 'runtime_record_heads', 'runtime_admission_source_proofs'].map(
      (t) => f.db.prepare(`SELECT count(*) n FROM ${t}`).get()?.n,
    )
  const before = counts()
  expect(await f.state.createRun({ admission: f.admission, scope }, f.context)).toEqual(created)
  expect(await f.state.cancelAdmission('ticket', f.admission.fingerprint, f.context)).toEqual(created)
  expect(counts()).toEqual(before)
  const fresh = await f.reopen()
  expect(await fresh.state.probeAdmission('ticket', fresh.context)).toEqual(created)
  fresh.db.prepare('DELETE FROM runtime_admissions WHERE ticket_id=?').run('ticket')
  await expect(fresh.state.probeAdmission('ticket', fresh.context)).rejects.toThrow(/original decision/)
})
it('serializes simultaneous creation and cancellation to one original authority decision', async () => {
  const f = await fixture()
  const [created, cancelled] = await Promise.all([
    f.state.createRun({ admission: f.admission, scope }, f.context),
    f.state.cancelAdmission('ticket', f.admission.fingerprint, f.context),
  ])
  expect(created.state).toBe('created')
  expect(cancelled).toEqual(created)
  expect(f.db.prepare('SELECT count(*) n FROM runtime_admissions').get()?.n).toBe(1)
  expect(f.db.prepare('SELECT count(*) n FROM runtime_admission_tombstones').get()?.n).toBe(0)
})
it('rejects real source deletion by the final issuer clock and restores every State afterimage', async () => {
  const f = await fixture()
  let armed = false,
    clocks = 0,
    removed = 0
  f.setHook(() => {
    armed = true
  })
  f.setClock(() => {
    if (armed && ++clocks === 2) {
      removed = Number(
        f.db.prepare('DELETE FROM runtime_admission_source_issued WHERE ticket_id=?').run('ticket').changes,
      )
      expect(removed).toBe(1)
      expect(f.db.prepare('SELECT count(*) n FROM runtime_admission_source_issued').get()?.n).toBe(0)
    }
  })
  await expect(f.state.createRun({ admission: f.admission, scope }, f.context)).rejects.toThrow(
    /issuance changed/,
  )
  expect(removed).toBe(1)
  expect(clocks).toBe(2)
  expect(f.db.prepare('SELECT count(*) n FROM runtime_admission_source_issued').get()?.n).toBe(1)
  for (const table of [
    'events',
    'runtime_admissions',
    'runtime_admission_source_proofs',
    'runtime_record_heads',
  ])
    expect(f.db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0)
})

it('refuses an original issuer without its consumption slot and does not recreate it', async () => {
  const f = await fixture()
  f.db.exec('ALTER TABLE runtime_admission_source_issued DROP COLUMN decision_json')
  const before = f.db
    .prepare('SELECT source_id,source_json,source_digest FROM runtime_admission_source_issued')
    .all()
  expect(() => createRuntimeAdmissionSource({ database: f.db, identity: f.identity, authority })).toThrow(
    /decision_json/,
  )
  expect(
    f.db.prepare('SELECT source_id,source_json,source_digest FROM runtime_admission_source_issued').all(),
  ).toEqual(before)
  expect(
    f.db
      .prepare(
        "SELECT count(*) n FROM pragma_table_info('runtime_admission_source_issued') WHERE name='decision_json'",
      )
      .get()?.n,
  ).toBe(0)
  expect(f.db.prepare('SELECT count(*) n FROM events').get()?.n).toBe(0)
})
