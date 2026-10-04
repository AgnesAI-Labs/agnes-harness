import type { CallContext, Outcome, StateStoreControl } from '@agnes/extension-api/runtime'
import type { AdmissionProbe, SessionControlRequest } from '@agnes/protocol/runtime'
import { createAdmissionTickets, type TicketDraft } from './admission-ticket.js'
import {
  type AssemblyMaintenancePorts,
  authorizeMaintenance,
  journalCommit,
  journalData,
  journalMutation,
  journalRead,
  journalRef,
  MaintenanceFailure,
  maintenanceOutcome,
} from './maintenance-journal.js'
import { equal, readWire, requireRelease } from './primitives.js'

/** Test-only composition; real State sources must pass their original same-connection installation. */
export interface AdmissionStatePorts {
  readonly qualification: 'restricted-persistent-state-fixture' | 'same-database-state-admission'
  readonly store: Pick<
    StateStoreControl,
    | 'createRun'
    | 'cancelAdmission'
    | 'probeAdmission'
    | 'readSessionControl'
    | 'submitSessionControl'
    | 'sessionControlStatus'
  >
}

export function createAdmissionCoordinator(
  maintenance?: AssemblyMaintenancePorts,
  state?: AdmissionStatePorts,
) {
  let disposed = false
  const lifetime = new AbortController()
  let tail: Promise<unknown> = Promise.resolve()
  const unsupported = (): Outcome<never> => ({
    ok: false,
    error: {
      code: 'incompatible',
      detailCode: 'unsupported',
      message: 'Qualified State admission and session control are unavailable',
      diagnosticId: 'assembly-admission',
      retryAdvice: { kind: 'never' },
    },
  })
  const qualified = () =>
    state?.qualification === 'restricted-persistent-state-fixture' ||
    state?.qualification === 'same-database-state-admission'
  function work<T>(context: CallContext, body: (call: CallContext) => Promise<T>): Promise<Outcome<T>> {
    if (!maintenance || !qualified()) return Promise.resolve(unsupported())
    // C14 tracks the original issued object. Copying it would discard the selected authority.
    const call =
      state?.qualification === 'same-database-state-admission'
        ? context
        : { ...context, signal: AbortSignal.any([context.signal, lifetime.signal]) }
    const pending = tail.then(() =>
      maintenanceOutcome(async () => {
        requireRelease(!disposed, 'admission_disposed', '/admission')
        await authorizeMaintenance(maintenance, call, null)
        requireRelease(!disposed, 'admission_disposed', '/admission')
        return body(call)
      }),
    )
    tail = pending.then(() => undefined)
    return pending
  }
  async function value<T>(reply: Promise<Outcome<T>>): Promise<T> {
    const result = await reply
    if (!result.ok) throw new MaintenanceFailure(result.error)
    return result.value
  }
  async function admissionReply(
    ticketId: string,
    call: CallContext,
    pending: Promise<Outcome<AdmissionProbe>>,
  ): Promise<Outcome<AdmissionProbe>> {
    const reply = await pending
    if (
      state?.qualification === 'same-database-state-admission' &&
      !reply.ok &&
      ((reply.error.code === 'denied' && reply.error.detailCode === 'admission_source') ||
        (reply.error.code === 'conflict' && reply.error.detailCode === 'admission_cancelled'))
    ) {
      requireRelease(!disposed, 'admission_disposed', '/admission')
      // Another writer may have consumed the captured slot. A fresh State read must prove its result.
      return state.store.probeAdmission(ticketId, call)
    }
    return reply
  }
  async function ticket(ticketId: string, call: CallContext) {
    requireRelease(maintenance, 'unsupported', '/admission')
    const id = readWire('Id', ticketId)
    const rows = await journalRead(maintenance, [`ticket:${id}`, `pin:admission:${id}`], call)
    const record = rows.find((row) => row.recordId === `ticket:${id}`)
    const pinRecord = rows.find((row) => row.recordId === `pin:admission:${id}`)
    requireRelease(record && pinRecord, 'admission_ticket_missing', '/admission')
    const data = journalData(record, 'admission-ticket')
    const admission = readWire('RunAdmission', data.admission)
    const pin = journalData(pinRecord, 'package-pin-receipt')
    requireRelease(
      equal(journalRef({ ...pin, status: 'active' }, 'package-pin-receipt'), admission.packagePinReceipt) &&
        pin.status === (data.status === 'cancelled' ? 'released' : 'active'),
      'package_pin_missing',
      '/admission/pin',
    )
    requireRelease(
      admission.ticketId === id && equal(data.scope, call.scope) && data.grantRef === call.authorizationRef,
      'admission_ticket_conflict',
      '/admission/scope',
    )
    return { record, pinRecord, data, admission, pin }
  }
  async function settle(ticketId: string, observed: AdmissionProbe, call: CallContext) {
    requireRelease(maintenance && state, 'unsupported', '/admission')
    requireRelease(!disposed, 'admission_disposed', '/admission')
    const saved = await ticket(ticketId, call)
    const proof = readWire('AdmissionProbe', observed)
    // A caller-supplied reply is never sufficient to release a maintenance pin.
    const current = readWire('AdmissionProbe', await value(state.store.probeAdmission(ticketId, call)))
    requireRelease(equal(current, proof), 'admission_proof_mismatch', '/admission/proof')
    if (proof.state === 'absent') {
      requireRelease(saved.data.status === 'issued', 'admission_proof_mismatch', '/admission/absent')
      return proof
    }
    if (proof.state === 'created')
      requireRelease(
        proof.runId === saved.admission.runId && proof.commit.sessionId === saved.admission.sessionId,
        'admission_proof_mismatch',
        '/admission/created',
      )
    const status = proof.state === 'created' ? 'bound' : 'cancelled'
    if (saved.data.status !== 'issued') {
      requireRelease(
        saved.data.status === status && equal(saved.data.stateProof, proof),
        'admission_proof_mismatch',
        '/admission/terminal',
      )
      return proof
    }
    requireRelease(saved.pin.status === 'active', 'package_pin_missing', '/admission/pin')
    const now = readWire('Timestamp', maintenance.now())
    const mutations = [
      journalMutation(
        maintenance,
        saved.record.recordId,
        'admission-ticket',
        { ...saved.data, status, stateProof: proof },
        saved.record,
        now,
      ),
    ]
    // Bound tickets retain the exact issued receipt and all its digests for the run's lifetime.
    // Only State's unique cancellation tombstone permits releasing that receipt.
    if (proof.state === 'cancelled')
      mutations.push(
        journalMutation(
          maintenance,
          saved.pinRecord.recordId,
          'package-pin-receipt',
          { ...saved.pin, status: 'released' },
          saved.pinRecord,
          now,
        ),
      )
    requireRelease(!disposed, 'admission_disposed', '/admission')
    try {
      await journalCommit(maintenance, `admission:${ticketId}:${status}`, mutations, [], call)
    } catch (error) {
      const committed = await ticket(ticketId, call)
      if (
        committed.data.status !== status ||
        !equal(committed.data.stateProof, proof) ||
        (status === 'cancelled' && committed.pin.status !== 'released')
      )
        throw error
    }
    return proof
  }
  return {
    providerId: 'agh.default/assembly',
    qualification: maintenance && qualified() ? (state?.qualification ?? 'unsupported') : 'unsupported',
    incomplete: ['production-state-qualification', 'production-wiring'],
    coordinate(incoming: TicketDraft, context: CallContext): Promise<Outcome<AdmissionProbe>> {
      const draft = structuredClone(incoming)
      return work(context, async (call) => {
        requireRelease(maintenance && state, 'unsupported', '/admission')
        const issued = await value(createAdmissionTickets(maintenance).issue(draft, call))
        requireRelease(!disposed, 'admission_disposed', '/admission')
        const reply = await admissionReply(
          issued.admission.ticketId,
          call,
          state.store.probeAdmission(issued.admission.ticketId, call),
        )
        // Unproven absence cannot release a pin. Only createRun may arbitrate the original issuer slot.
        const prior =
          !reply.ok &&
          state.qualification === 'same-database-state-admission' &&
          reply.error.code === 'denied' &&
          reply.error.detailCode === 'admission_absence_unproven'
            ? null
            : readWire('AdmissionProbe', await value(Promise.resolve(reply)))
        let proof = prior
        if (!proof || proof.state === 'absent') {
          requireRelease(!disposed, 'admission_disposed', '/admission')
          proof = readWire(
            'AdmissionProbe',
            await value(
              admissionReply(issued.admission.ticketId, call, state.store.createRun(issued.admission, call)),
            ),
          )
        }
        return settle(issued.admission.ticketId, proof, call)
      })
    },
    confirm(ticketId: string, context: CallContext): Promise<Outcome<AdmissionProbe>> {
      return work(context, async (call) => {
        requireRelease(state, 'unsupported', '/admission')
        await ticket(ticketId, call)
        return settle(
          ticketId,
          readWire('AdmissionProbe', await value(state.store.probeAdmission(ticketId, call))),
          call,
        )
      })
    },
    cancel(ticketId: string, fingerprint: string, context: CallContext): Promise<Outcome<AdmissionProbe>> {
      return work(context, async (call) => {
        requireRelease(state, 'unsupported', '/admission')
        const saved = await ticket(ticketId, call)
        requireRelease(
          saved.admission.fingerprint === readWire('Digest', fingerprint),
          'admission_ticket_conflict',
          '/admission/fingerprint',
        )
        return settle(
          ticketId,
          readWire(
            'AdmissionProbe',
            await value(
              admissionReply(ticketId, call, state.store.cancelAdmission(ticketId, fingerprint, call)),
            ),
          ),
          call,
        )
      })
    },
    probe(ticketId: string, context: CallContext): Promise<Outcome<AdmissionProbe>> {
      return this.confirm(ticketId, context)
    },
    readSessionControl(sessionId: string, context: CallContext) {
      return work(context, async (call) => {
        requireRelease(state, 'unsupported', '/session')
        const result = readWire(
          'SessionControlState',
          await value(
            state.store.readSessionControl(
              readWire('StateStoreControlReadSessionControlRequest', { sessionId }),
              call,
            ),
          ),
        )
        requireRelease(result.sessionId === sessionId, 'session_control_mismatch', '/session')
        return result
      })
    },
    submitSessionControl(incoming: SessionControlRequest, context: CallContext) {
      const request = structuredClone(incoming)
      return work(context, async (call) => {
        requireRelease(state, 'unsupported', '/session')
        const fixed = readWire('SessionControlRequest', request)
        const result = readWire(
          'SessionControlResult',
          await value(state.store.submitSessionControl(fixed, call)),
        )
        requireRelease(
          result.sessionId === fixed.sessionId && result.requestId === fixed.requestId,
          'session_control_mismatch',
          '/session',
        )
        return result
      })
    },
    sessionControlStatus(sessionId: string, requestId: string, context: CallContext) {
      return work(context, async (call) => {
        requireRelease(state, 'unsupported', '/session')
        const request = readWire('StateStoreControlSessionControlStatusRequest', { sessionId, requestId })
        const result = readWire(
          'StateStoreControlSessionControlStatusResult',
          await value(state.store.sessionControlStatus(request, call)),
        )
        requireRelease(
          result === null || (result.sessionId === sessionId && result.requestId === requestId),
          'session_control_mismatch',
          '/session',
        )
        return result
      })
    },
    async dispose() {
      disposed = true
      lifetime.abort()
      await tail
    },
  }
}
