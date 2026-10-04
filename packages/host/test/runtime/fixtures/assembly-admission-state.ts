import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome, StateStoreControl } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type {
  AdmissionProbe,
  RunAdmission,
  RunBinding,
  SessionControlRequest,
  SessionControlResult,
  SessionControlState,
  SessionParameterRevision,
} from '@agnes/protocol/runtime'
import { maintenancePayload } from './assembly-maintenance.js'
import { fixtureHash, fixtureWire } from './assembly-maintenance-wire.js'

type AdmissionMethods = Pick<
  StateStoreControl,
  | 'createRun'
  | 'cancelAdmission'
  | 'probeAdmission'
  | 'readSessionControl'
  | 'submitSessionControl'
  | 'sessionControlStatus'
>
type StoredAdmission = { fingerprint: string; scope: unknown; principalRef: string; proof: AdmissionProbe }
type StoredCommand = { fingerprint: string; request: SessionControlRequest; result: SessionControlResult }
type StoredRun = { admission: RunAdmission; binding: RunBinding; parameters: SessionParameterRevision }

/** NOT R01: restricted synthetic State authority. SQLite FULL/WAL, real transactions, no memory state. */
export function restrictedAdmissionState(
  file: string,
  options: {
    maintenanceRecord(id: string): { payload: unknown } | null
    binding(id: string): RunBinding | undefined
    initialSession: SessionControlState
    now(): string
    checkpoint?(point: string): Promise<void>
  },
) {
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS facts (kind TEXT, id TEXT, body TEXT NOT NULL, PRIMARY KEY(kind,id));`)
  const read = <T>(kind: string, id: string): T | null => {
    const row = db.prepare('SELECT body FROM facts WHERE kind=? AND id=?').get(kind, id)
    return row ? (JSON.parse(String(row.body)) as T) : null
  }
  const put = (kind: string, id: string, body: unknown) => {
    db.prepare('INSERT OR REPLACE INTO facts VALUES (?,?,?)').run(kind, id, JSON.stringify(body))
  }
  if (!read('session', options.initialSession.sessionId))
    put('session', options.initialSession.sessionId, options.initialSession)
  function refuse(detail: string): never {
    throw new Error(detail)
  }
  const permitted = (call: CallContext) => {
    if (call.signal.aborted) refuse('state_cancelled')
    if (
      call.principalRef !== 'fixture-principal' ||
      call.authorizationRef !== 'fixture-authorization' ||
      call.scope.kind !== 'runtime' ||
      call.scope.installationId !== 'fixture-installation'
    )
      refuse('state_denied')
    if (Date.parse(call.deadline) <= Date.parse(options.now())) refuse('state_deadline')
  }
  const failure = (error: unknown): Outcome<never> => ({
    ok: false,
    error: {
      code: 'conflict',
      detailCode: error instanceof Error ? error.message : 'fixture_state_fault',
      message: 'Restricted persistent State fixture refused',
      diagnosticId: 'fixture-state',
      retryAdvice: { kind: 'never' },
    },
  })
  let queued: Promise<unknown> = Promise.resolve()
  function transact<T>(point: string, call: CallContext, operation: () => T): Promise<Outcome<T>> {
    const pending = queued.then(async (): Promise<Outcome<T>> => {
      let committed = false
      try {
        permitted(call)
        db.exec('BEGIN IMMEDIATE')
        const result = operation()
        await options.checkpoint?.(`${point}:before`)
        permitted(call)
        db.exec('COMMIT')
        committed = true
        await options.checkpoint?.(`${point}:after`)
        return { ok: true, value: result }
      } catch (error) {
        if (!committed) {
          try {
            db.exec('ROLLBACK')
          } catch {}
        }
        return failure(error)
      }
    })
    queued = pending.then(() => undefined)
    return pending
  }
  async function query<T>(call: CallContext, operation: () => T): Promise<Outcome<T>> {
    try {
      permitted(call)
      return { ok: true, value: operation() }
    } catch (error) {
      return failure(error)
    }
  }
  const session = (id: string) => read<SessionControlState>('session', id) ?? refuse('session_missing')
  const commandId = (sessionId: string, requestId: string) => fixtureHash({ sessionId, requestId })
  function prior(id: string, call: CallContext, fingerprint?: string) {
    const row = read<StoredAdmission>('admission', id)
    if (
      row &&
      ((fingerprint !== undefined && row.fingerprint !== fingerprint) ||
        fixtureHash(row.scope) !== fixtureHash(call.scope) ||
        row.principalRef !== call.principalRef)
    )
      refuse('admission_ticket_conflict')
    return row
  }
  const store: AdmissionMethods = {
    createRun(raw, call) {
      return transact('create', call, () => {
        const admission = fixtureWire('RunAdmission', raw),
          { fingerprint, ...body } = admission
        if (fixtureHash(body) !== fingerprint) refuse('admission_ticket_conflict')
        const existing = prior(admission.ticketId, call, fingerprint)
        if (existing) return existing.proof
        if (admission.lane !== 'foreground') refuse('restricted_fixture_unsupported')
        const ticket = maintenancePayload(
          options.maintenanceRecord(`ticket:${admission.ticketId}`) ?? undefined,
        )
        const pin = maintenancePayload(
          options.maintenanceRecord(`pin:admission:${admission.ticketId}`) ?? undefined,
        )
        const snapshot = maintenancePayload(
          options.maintenanceRecord(`release:${admission.releaseSetId}`) ?? undefined,
        )
        const release = fixtureWire('ReleaseSet', JSON.parse(String(snapshot.canonicalJson)))
        const requiredDigests = [
          ...new Set(
            release.packages.flatMap((pkg) => [
              pkg.digest,
              ...Object.values(pkg.entries).map((entry) => entry.digest),
            ]),
          ),
        ].sort()
        if (
          fixtureHash(requiredDigests) !== fixtureHash(pin.requiredDigests) ||
          fixtureHash(release) !== snapshot.contentDigest ||
          release.releaseSetId !== admission.releaseSetId ||
          fixtureHash(pin.issuer) !==
            fixtureHash({
              authorityId: 'fixture-maintenance',
              tenantId: 'fixture-tenant',
              authorityEpoch: 1,
            }) ||
          pin.maintenanceCommitId !== `ticket:${admission.ticketId}`
        )
          refuse('admission_pin_binding_invalid')
        const binding = options.binding(admission.bindingId)
        if (
          fixtureHash(ticket.admission) !== fixtureHash(admission) ||
          ticket.status !== 'issued' ||
          pin.status !== 'active' ||
          pin.ownerId !== admission.ticketId ||
          pin.ownerKind !== 'admission' ||
          pin.releaseSetId !== admission.releaseSetId ||
          fixtureHash(pin.scope) !== fixtureHash(call.scope) ||
          admission.packagePinReceipt.kind !== 'inline' ||
          fixtureHash(pin) !== admission.packagePinReceipt.digest ||
          admission.packagePinReceipt.bytes !== Buffer.byteLength(jcs(pin)) ||
          !binding ||
          binding.releaseSetId !== admission.releaseSetId ||
          binding.bindingId !== admission.bindingId ||
          binding.stateAuthorityAtCreation.authorityEpoch !== 1 ||
          binding.stateAuthorityAtCreation.authorityId !== 'fixture-state' ||
          fixtureHash(ticket.stateAuthorityRef) !== fixtureHash(binding.stateAuthorityAtCreation)
        )
          refuse('admission_pin_binding_invalid')
        if (Date.parse(admission.deadline) <= Date.parse(options.now())) refuse('admission_expired')
        if (read('run', admission.runId)) refuse('run_conflict')
        const current = session(admission.sessionId)
        let parameters = current.parameters
        const pending = read<string>('pending', admission.sessionId)
        if (pending && admission.lane === 'foreground') {
          const command = read<StoredCommand>('command', pending) ?? refuse('command_missing')
          const selection = command.request.command
          if (
            selection.kind !== 'set-preset' ||
            selection.apply !== 'next-run' ||
            selection.presetDigest !== binding.presetDigest
          )
            refuse('pending_binding_mismatch')
          const revision = current.revision + 1
          parameters = fixtureWire('SessionParameterRevision', {
            ...current.parameters,
            revision,
            previousRevision: current.parameters.revision,
            sourceRequestId: command.request.requestId,
            presetId: selection.presetId,
            presetDigest: selection.presetDigest,
            committedAt: options.now(),
            effective: { kind: 'next-run', revision, runId: admission.runId, afterRequestId: null },
          })
          put('command', pending, {
            ...command,
            result: {
              ...command.result,
              status: 'applied',
              revision,
              effective: parameters.effective,
              runId: admission.runId,
            },
          })
          db.prepare('DELETE FROM facts WHERE kind=? AND id=?').run('pending', admission.sessionId)
        }
        const proof = fixtureWire('AdmissionProbe', {
          state: 'created',
          runId: admission.runId,
          commit: {
            commitId: `create:${admission.ticketId}`,
            transactionFingerprint: fingerprint,
            sessionId: admission.sessionId,
            firstSeq: 1,
            lastSeq: 1,
            headDigest: fixtureHash({ admission, binding, parameters }),
            runRevision: 1,
            actionIds: [],
          },
        })
        put('run', admission.runId, { admission, binding: fixtureWire('RunBinding', binding), parameters })
        if (admission.lane === 'foreground')
          put('session', admission.sessionId, {
            ...current,
            parameters,
            revision: parameters.revision,
            activeRunId: admission.runId,
          })
        put('admission', admission.ticketId, {
          fingerprint,
          scope: call.scope,
          principalRef: call.principalRef,
          proof,
        })
        return proof
      })
    },
    cancelAdmission(ticketId, fingerprint, call) {
      return transact('cancel', call, () => {
        fixtureWire('Id', ticketId)
        fixtureWire('Digest', fingerprint)
        const existing = prior(ticketId, call, fingerprint)
        if (existing) return existing.proof
        const ticket = maintenancePayload(options.maintenanceRecord(`ticket:${ticketId}`) ?? undefined)
        if (ticket.fingerprint !== fingerprint || fixtureHash(ticket.scope) !== fixtureHash(call.scope))
          refuse('admission_ticket_conflict')
        const proof = fixtureWire('AdmissionProbe', { state: 'cancelled', tombstoneId: `cancel:${ticketId}` })
        put('admission', ticketId, { fingerprint, scope: call.scope, principalRef: call.principalRef, proof })
        return proof
      })
    },
    probeAdmission: (id, call) =>
      query(call, () => prior(fixtureWire('Id', id), call)?.proof ?? { state: 'absent' }),
    readSessionControl: (request, call) =>
      query(call, () =>
        fixtureWire(
          'SessionControlState',
          session(fixtureWire('StateStoreControlReadSessionControlRequest', request).sessionId),
        ),
      ),
    submitSessionControl(raw, call) {
      return transact('control', call, () => {
        const request = fixtureWire('SessionControlRequest', raw)
        const id = commandId(request.sessionId, request.requestId)
        const fingerprint = fixtureHash({ request, principal: call.principalRef, scope: call.scope })
        const existing = read<StoredCommand>('command', id)
        if (existing) {
          if (existing.fingerprint !== fingerprint) refuse('session_control_conflict')
          return existing.result
        }
        const current = session(request.sessionId)
        if (request.expectedRevision !== current.revision) refuse('session_revision_conflict')
        if (request.command.kind !== 'set-preset' || request.command.apply !== 'next-run')
          refuse('restricted_fixture_unsupported')
        if (read('pending', request.sessionId)) refuse('session_pending_conflict')
        const result = fixtureWire('SessionControlResult', {
          sessionId: request.sessionId,
          requestId: request.requestId,
          status: 'accepted',
          revision: current.revision,
          effective: { kind: 'next-run', revision: current.revision + 1, runId: null, afterRequestId: null },
          runId: null,
          childSessionId: null,
          compact: null,
          error: null,
        })
        put('command', id, { fingerprint, request, result })
        put('pending', request.sessionId, id)
        return result
      })
    },
    sessionControlStatus: (request, call) =>
      query(call, () => {
        const parsed = fixtureWire('StateStoreControlSessionControlStatusRequest', request)
        return read<StoredCommand>('command', commandId(parsed.sessionId, parsed.requestId))?.result ?? null
      }),
  }
  let closed = false
  return {
    ports: { qualification: 'restricted-persistent-state-fixture' as const, store },
    inspect() {
      return {
        runs: db
          .prepare("SELECT body FROM facts WHERE kind='run' ORDER BY id")
          .all()
          .map((row) => JSON.parse(String(row.body)) as StoredRun),
        admissions: db
          .prepare("SELECT body FROM facts WHERE kind='admission' ORDER BY id")
          .all()
          .map((row) => JSON.parse(String(row.body)) as StoredAdmission),
        session: session(options.initialSession.sessionId),
      }
    },
    close() {
      if (!closed) {
        closed = true
        db.close()
      }
    },
  }
}
