import type { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import {
  type DataRef,
  type RunAdmission,
  type RunBinding,
  type StateAuthorityRef,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { captureIdentityCurrentFence, type IdentityAuthority } from '../identity/authority.js'
import { digestOf, sameJson } from './records.js'
import { integrity, refuse } from './refusal.js'

/** Native maintenance issuance read by the selected Host adapter. This is not a public ticket DTO. */
export type RuntimeAdmissionFacts = Readonly<{
  sourceId: string
  authority: StateAuthorityRef
  admission: RunAdmission
  runBinding: RunBinding
  pin: Readonly<{
    ticketId: string
    releaseSetId: string
    bindingId: string
    requiredDigests: readonly string[]
    commitRef: DataRef
    receipt: DataRef
  }>
  qualifiedUntil: string
  scope: CallContext['scope']
  callerBindingId: string
  producerCodeDigest: string
}>
export type RuntimeAdmissionRequest =
  | RunAdmission
  | Readonly<{ ticketId: string; fingerprint: string }>
  | Readonly<{ ticketId: string }>
export type RuntimeAdmissionProof = Readonly<{
  sourceId: string
  sourceDigest: string
  facts: RuntimeAdmissionFacts
}>
export type RuntimeAdmissionDecisionAnchor = Readonly<{
  ticketId: string
  fingerprint: string
  sourceDigest: string
  kind: 'created' | 'cancelled'
  targetId: string
  bodyDigest: string
}>
export type RuntimeAdmissionCapture = Readonly<{
  readDecision(): RuntimeAdmissionDecisionAnchor | null
  recordDecision(decision: RuntimeAdmissionDecisionAnchor): void
  proof: RuntimeAdmissionProof
  deadline: string
  dynamicCheck(): void
  staticCheck(): void
  finalCheck(stateStaticCheck?: () => void): void
}>
export type RuntimeAdmissionSource = Readonly<{
  identity: IdentityAuthority
  capture(
    operation: 'create' | 'cancel' | 'probe',
    request: RuntimeAdmissionRequest,
    context: CallContext,
    authority: StateAuthorityRef,
  ): RuntimeAdmissionCapture
  readHistorical(
    proof: RuntimeAdmissionProof,
    authority: StateAuthorityRef,
  ): Readonly<{
    facts: RuntimeAdmissionFacts
    decision: RuntimeAdmissionDecisionAnchor | null
    staticCheck(): void
  }>
}>
const sources = new WeakSet<object>()
const sourceDatabases = new WeakMap<object, DatabaseSync>()
export function admissionSourceUsesDatabase(source: RuntimeAdmissionSource, database: DatabaseSync): boolean {
  return sourceDatabases.get(source) === database
}
export function isRuntimeAdmissionSource(value: unknown): value is RuntimeAdmissionSource {
  return typeof value === 'object' && value !== null && sources.has(value)
}
function fixed<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) fixed(child)
    Object.freeze(value)
  }
  return value
}
function validateFacts(raw: unknown, authority: StateAuthorityRef): RuntimeAdmissionFacts {
  if (!raw || typeof raw !== 'object') integrity('admission source has no original facts')
  const facts = raw as RuntimeAdmissionFacts
  const a = validateRuntime('RunAdmission', facts.admission)
  const b = validateRuntime('RunBinding', facts.runBinding)
  const s = validateRuntime('ScopeRef', facts.scope)
  if (
    !a.ok ||
    !b.ok ||
    !s.ok ||
    !sameJson(facts.authority, authority) ||
    facts.runBinding.bindingId !== a.value.bindingId ||
    facts.runBinding.releaseSetId !== a.value.releaseSetId ||
    !sameJson(facts.runBinding.stateAuthorityAtCreation, authority) ||
    facts.pin?.ticketId !== a.value.ticketId ||
    facts.pin.releaseSetId !== a.value.releaseSetId ||
    facts.pin.bindingId !== a.value.bindingId ||
    !sameJson(facts.pin.receipt, a.value.packagePinReceipt) ||
    !validateRuntime('DataRef', facts.pin.commitRef).ok ||
    !Array.isArray(facts.pin.requiredDigests) ||
    facts.pin.requiredDigests.length === 0 ||
    facts.pin.requiredDigests.some((d) => !/^[0-9a-f]{64}$/.test(d)) ||
    typeof facts.sourceId !== 'string' ||
    facts.sourceId.length === 0 ||
    !/^[0-9a-f]{64}$/.test(facts.producerCodeDigest) ||
    !Number.isFinite(Date.parse(facts.qualifiedUntil)) ||
    Date.parse(a.value.admittedAt) >= Date.parse(a.value.deadline)
  )
    integrity('admission source facts do not match their original authority, ticket, pin and binding')
  return fixed(facts)
}

/** Native issuer adapter. Original issuance and its once-only consumption remain in the source owner. */
export function createRuntimeAdmissionSource(
  input: Readonly<{ database: DatabaseSync; identity: IdentityAuthority; authority: StateAuthorityRef }>,
): RuntimeAdmissionSource {
  const statement = input.database.prepare(
    'SELECT source_id, ticket_id, source_json, source_digest, revoked, decision_json, decision_digest FROM runtime_admission_source_issued WHERE ticket_id = ?',
  )
  const get = statement.get.bind(statement)
  const consume = input.database.prepare(
    'UPDATE runtime_admission_source_issued SET decision_json=?,decision_digest=? WHERE ticket_id=? AND source_digest=? AND decision_json IS NULL AND decision_digest IS NULL',
  )
  const consumeDecision = consume.run.bind(consume)
  const originalIdentity = input.identity
  const currentDescriptor = Object.getOwnPropertyDescriptor(originalIdentity, 'current')
  if (!currentDescriptor || !('value' in currentDescriptor) || typeof currentDescriptor.value !== 'function')
    refuse('denied', 'identity', 'admission identity has no fixed current method')
  const originalCurrent = originalIdentity.current
  const originalAuthority = digestOf(input.authority)
  const authorityObject = input.authority
  const authoritySlots = Object.entries(Object.getOwnPropertyDescriptors(authorityObject))
  function read(ticketId: string, historical = false) {
    const row = get(ticketId)
    if (
      !row ||
      typeof row.source_json !== 'string' ||
      typeof row.source_digest !== 'string' ||
      (!historical && row.revoked !== 0)
    )
      refuse('denied', 'admission_source', 'original admission issuance is unavailable')
    const sourceDigest = row.source_digest
    const facts = validateFacts(JSON.parse(row.source_json), input.authority)
    if (
      facts.admission.ticketId !== ticketId ||
      row.source_id !== facts.sourceId ||
      digestOf(facts) !== row.source_digest
    )
      integrity('admission source digest or ticket differs from original issuance')
    function decisionOf(actual: Record<string, unknown>): RuntimeAdmissionDecisionAnchor | null {
      if (actual.decision_json === null && actual.decision_digest === null) return null
      if (typeof actual.decision_json !== 'string' || typeof actual.decision_digest !== 'string')
        integrity('admission original issuer decision anchor is incomplete')
      const decision = JSON.parse(actual.decision_json) as RuntimeAdmissionDecisionAnchor
      if (
        !decision ||
        typeof decision !== 'object' ||
        Object.keys(decision).sort().join(',') !==
          'bodyDigest,fingerprint,kind,sourceDigest,targetId,ticketId' ||
        decision.ticketId !== ticketId ||
        decision.fingerprint !== facts.admission.fingerprint ||
        decision.sourceDigest !== sourceDigest ||
        (decision.kind !== 'created' && decision.kind !== 'cancelled') ||
        !validateRuntime('Id', decision.targetId).ok ||
        !/^[0-9a-f]{64}$/.test(decision.bodyDigest) ||
        digestOf(decision) !== actual.decision_digest
      )
        integrity('admission original issuer decision anchor differs')
      return fixed(decision)
    }
    let slots = Object.entries(row)
    let decision = decisionOf(row)
    const immutableSlots = slots.filter(([key]) => key !== 'decision_json' && key !== 'decision_digest')
    const readDecision = () => {
      const actual = get(ticketId)
      if (!actual || immutableSlots.some(([key, value]) => actual[key] !== value))
        refuse('denied', 'admission_source', 'original admission issuance changed')
      const next = decisionOf(actual)
      if (decision && !sameJson(decision, next)) integrity('original admission consumption changed')
      decision = next
      slots = Object.entries(actual)
      return decision
    }
    const recordDecision = (next: RuntimeAdmissionDecisionAnchor) => {
      if (!input.database.isTransaction)
        integrity('admission consumption requires original State transaction')
      if (readDecision()) integrity('original admission issuance was already consumed')
      const json = JSON.stringify(next)
      decisionOf({ decision_json: json, decision_digest: digestOf(next) })
      const result = consumeDecision(json, digestOf(next), ticketId, sourceDigest)
      if (Number(result.changes) !== 1) integrity('admission consumption CAS failed')
      const recorded = readDecision()
      if (!sameJson(recorded, next)) integrity('admission consumption afterimage differs')
    }
    const check = () => {
      const actual = get(ticketId)
      if (!actual || slots.some(([key, value]) => actual[key] !== value))
        refuse('denied', 'admission_source', 'original admission issuance changed')
    }
    return {
      facts,
      readDecision,
      recordDecision,
      proof: fixed({ sourceId: facts.sourceId, sourceDigest: row.source_digest, facts }),
      check,
    }
  }
  const source: RuntimeAdmissionSource = Object.freeze({
    identity: originalIdentity,
    capture(operation, request, context, authority) {
      if (!sameJson(authority, input.authority) || digestOf(input.authority) !== originalAuthority)
        refuse('denied', 'authority', 'admission authority changed')
      const retained = read(request.ticketId)
      if ('fingerprint' in request && request.fingerprint !== retained.facts.admission.fingerprint)
        refuse('conflict', 'idempotency_conflict', 'admission fingerprint differs from original ticket')
      if (operation === 'create' && !sameJson(request, retained.facts.admission))
        refuse('conflict', 'admission_source', 'admission differs from the original ticket')
      if (
        !sameJson(context.scope, retained.facts.scope) ||
        context.bindingId !== retained.facts.callerBindingId
      )
        refuse('denied', 'scope', 'admission caller does not hold the issued scope')
      const deadline =
        operation === 'create' &&
        Date.parse(retained.facts.admission.deadline) < Date.parse(retained.facts.qualifiedUntil)
          ? retained.facts.admission.deadline
          : retained.facts.qualifiedUntil
      const fence = captureIdentityCurrentFence(originalIdentity, context, deadline)
      if (!fence) refuse('denied', 'identity', 'admission requires an original issued identity')
      const contextDigest = digestOf({ ...context, signal: null })
      const signal = context.signal
      const dynamicCheck = () => {
        if (
          originalIdentity.current !== originalCurrent ||
          !Reflect.apply(originalCurrent, originalIdentity, [context]) ||
          context.signal !== signal ||
          digestOf({ ...context, signal: null }) !== contextDigest
        )
          refuse('denied', 'identity', 'admission caller authorization changed')
        retained.check()
      }
      const staticCheck = () => {
        retained.check()
        if (
          authoritySlots.some(([key, slot]) => {
            const actual = Object.getOwnPropertyDescriptor(authorityObject, key)
            return !actual || !('value' in actual) || actual.value !== slot.value
          })
        )
          refuse('denied', 'authority', 'admission authority changed')
        if (
          source.identity !== originalIdentity ||
          Object.getOwnPropertyDescriptor(originalIdentity, 'current')?.value !== originalCurrent
        )
          refuse('denied', 'admission_source', 'admission selected owner changed')
      }
      dynamicCheck()
      return Object.freeze({
        proof: retained.proof,
        readDecision: retained.readDecision,
        recordDecision: retained.recordDecision,
        deadline,
        dynamicCheck,
        staticCheck,
        finalCheck(stateStaticCheck) {
          if (
            !fence(() => {
              staticCheck()
              stateStaticCheck?.()
            })
          )
            refuse('denied', 'identity', 'admission final authorization expired or changed')
        },
      })
    },
    readHistorical(proof, authority) {
      if (!sameJson(authority, input.authority)) integrity('historical admission authority differs')
      const retained = read(proof.facts.admission.ticketId, true)
      if (!sameJson(retained.proof, proof)) integrity('historical admission original proof is unavailable')
      return Object.freeze({
        facts: retained.facts,
        decision: retained.readDecision(),
        staticCheck: retained.check,
      })
    },
  })
  sources.add(source)
  sourceDatabases.set(source, input.database)
  return source
}

/** Capture fixed native rows before the commit clock. No JSON, getters or owner callback in the tail. */
export function captureAdmissionStateFence(database: DatabaseSync): () => void {
  const tables = [
    'runtime_admissions',
    'runtime_admission_tombstones',
    'runtime_admission_source_proofs',
    'runtime_record_heads',
    'runtime_version_headers',
    'runtime_version_bodies',
    'runtime_commit_manifests',
    'runtime_commit_sides',
    'runtime_commit_proofs',
    'runtime_session_meta',
    'runtime_leases',
    'events',
    'sessions',
  ]
  const checks: Array<() => void> = []
  for (const table of tables) {
    const tableInfo = database
      .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
      .get('table', table)
    if (!tableInfo) continue
    // WITHOUT ROWID tables use stable primary key order through their native scan.
    let read: () => Record<string, unknown>[]
    try {
      const statement = database.prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      statement.all()
      read = statement.all.bind(statement)
    } catch {
      const fallback = database.prepare(`SELECT * FROM ${table}`)
      read = fallback.all.bind(fallback)
    }
    const rows = read().map((row) =>
      Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? new Uint8Array(v) : v] as const),
    )
    checks.push(() => {
      const actual = read()
      if (actual.length !== rows.length) integrity('admission native state rows changed')
      rows.forEach((slots, i) => {
        const row = actual[i]
        if (!row || Object.keys(row).length !== slots.length) integrity('admission native state row changed')
        for (const [key, value] of slots) {
          const next = row[key]
          if (
            value instanceof Uint8Array
              ? !(next instanceof Uint8Array) ||
                value.length !== next.length ||
                value.some((n, j) => next[j] !== n)
              : next !== value
          )
            integrity('admission native state bytes changed')
        }
      })
    })
  }
  return () => {
    for (const check of checks) check()
  }
}
