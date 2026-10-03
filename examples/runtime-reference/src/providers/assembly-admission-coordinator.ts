import type { CallContext, Outcome, StateStoreControl } from '@agnes/extension-api/runtime'
import type { AdmissionProbe, SessionControlRequest } from '@agnes/protocol/runtime'
import { createReferenceAdmissionTickets } from './assembly-admission.js'
import {
  assertJournal,
  JournalFault,
  journalSame,
  journalWire,
  type ReferenceMaintenancePorts,
  referenceAuthorized,
  referenceBody,
  referenceCommit,
  referenceRead,
  referenceRef,
  referenceResult,
  referenceWrite,
} from './assembly-journal.js'

type StateFixture = {
  qualification: 'restricted-persistent-state-fixture'
  store: Pick<
    StateStoreControl,
    | 'createRun'
    | 'cancelAdmission'
    | 'probeAdmission'
    | 'readSessionControl'
    | 'submitSessionControl'
    | 'sessionControlStatus'
  >
}
type ReferenceDraft = Parameters<ReturnType<typeof createReferenceAdmissionTickets>['issue']>[0]

/** Independent maintenance/State coordinator; deliberately unavailable for production stores. */
export function createReferenceAdmissionCoordinator(
  journal?: ReferenceMaintenancePorts,
  runtime?: StateFixture,
) {
  const shutdown = new AbortController()
  let stopped = false
  let queue = Promise.resolve<unknown>(undefined)
  const unwrap = async <T>(pending: Promise<Outcome<T>>) => {
    const reply = await pending
    if (!reply.ok) throw new JournalFault(reply.error.detailCode, reply.error)
    return reply.value
  }
  function execute<T>(
    ctx: CallContext,
    operation: (trusted: CallContext) => Promise<T>,
  ): Promise<Outcome<T>> {
    if (journal === undefined || runtime?.qualification !== 'restricted-persistent-state-fixture')
      return Promise.resolve({
        ok: false,
        error: {
          code: 'incompatible',
          detailCode: 'unsupported',
          message: 'Qualified State admission and session control are unavailable',
          diagnosticId: 'assembly-admission',
          retryAdvice: { kind: 'never' },
        },
      })
    const trusted = { ...ctx, signal: AbortSignal.any([shutdown.signal, ctx.signal]) }
    const task = queue.then(() =>
      referenceResult(async () => {
        assertJournal(!stopped, 'admission_disposed')
        await referenceAuthorized(journal, trusted, null)
        return operation(trusted)
      }),
    )
    queue = task.then(() => undefined)
    return task
  }
  async function load(id: string, ctx: CallContext) {
    assertJournal(journal, 'unsupported')
    journalWire('Id', id)
    const entries = new Map((await referenceRead(journal, ctx)).map((entry) => [entry.recordId, entry]))
    const entry = entries.get(`ticket:${id}`),
      retention = entries.get(`pin:admission:${id}`)
    assertJournal(entry && retention, 'admission_ticket_missing')
    const payload = referenceBody(entry, 'admission-ticket'),
      request = journalWire('RunAdmission', payload.admission)
    assertJournal(
      request.ticketId === id &&
        journalSame(ctx.scope, payload.scope) &&
        ctx.authorizationRef === payload.grantRef,
      'admission_ticket_conflict',
    )
    const pin = referenceBody(retention, 'package-pin-receipt')
    assertJournal(
      journalSame(
        referenceRef({ ...pin, status: 'active' }, 'package-pin-receipt'),
        request.packagePinReceipt,
      ) && pin.status === (payload.status === 'cancelled' ? 'released' : 'active'),
      'package_pin_missing',
    )
    return { entry, retention, payload, request, pin }
  }
  async function finish(id: string, raw: AdmissionProbe, ctx: CallContext): Promise<AdmissionProbe> {
    assertJournal(journal && runtime, 'unsupported')
    const persisted = await load(id, ctx)
    const verified = journalWire('AdmissionProbe', raw)
    const authoritative = journalWire('AdmissionProbe', await unwrap(runtime.store.probeAdmission(id, ctx)))
    assertJournal(journalSame(verified, authoritative), 'admission_proof_mismatch')
    switch (verified.state) {
      case 'absent':
        assertJournal(persisted.payload.status === 'issued', 'admission_proof_mismatch')
        return verified
      case 'created':
        assertJournal(
          verified.runId === persisted.request.runId &&
            verified.commit.sessionId === persisted.request.sessionId,
          'admission_proof_mismatch',
        )
        break
      case 'cancelled':
        break
    }
    const terminal = verified.state === 'cancelled' ? 'cancelled' : 'bound'
    if (persisted.payload.status !== 'issued') {
      assertJournal(
        persisted.payload.status === terminal && journalSame(verified, persisted.payload.stateProof),
        'admission_proof_mismatch',
      )
      return verified
    }
    assertJournal(persisted.pin.status === 'active', 'package_pin_missing')
    const timestamp = journalWire('Timestamp', journal.now())
    const updates = [
      referenceWrite(
        journal,
        persisted.entry.recordId,
        'admission-ticket',
        {
          ...persisted.payload,
          stateProof: verified,
          status: terminal,
        },
        persisted.entry,
        timestamp,
      ),
    ]
    if (verified.state === 'cancelled')
      updates.push(
        referenceWrite(
          journal,
          persisted.retention.recordId,
          'package-pin-receipt',
          { ...persisted.pin, status: 'released' },
          persisted.retention,
          timestamp,
        ),
      )
    try {
      await referenceCommit(journal, `admission:${id}:${terminal}`, updates, [], ctx)
    } catch (fault) {
      const winner = await load(id, ctx)
      if (
        winner.payload.status !== terminal ||
        !journalSame(winner.payload.stateProof, verified) ||
        (terminal === 'cancelled' && winner.pin.status !== 'released')
      )
        throw fault
    }
    return verified
  }
  const recover = (id: string, ctx: CallContext) =>
    execute(ctx, async (trusted) => {
      assertJournal(runtime, 'unsupported')
      await load(id, trusted)
      return finish(
        id,
        journalWire('AdmissionProbe', await unwrap(runtime.store.probeAdmission(id, trusted))),
        trusted,
      )
    })
  return {
    providerId: 'agh.reference/assembly',
    qualification:
      journal && runtime?.qualification === 'restricted-persistent-state-fixture'
        ? 'restricted-persistent-state-fixture'
        : 'unsupported',
    incomplete: ['production-state-qualification', 'production-wiring'],
    coordinate(incoming: ReferenceDraft, ctx: CallContext) {
      const draft = structuredClone(incoming)
      return execute(ctx, async (trusted) => {
        assertJournal(journal && runtime, 'unsupported')
        const issued = await unwrap(createReferenceAdmissionTickets(journal).issue(draft, trusted))
        let answer = journalWire(
          'AdmissionProbe',
          await unwrap(runtime.store.probeAdmission(issued.admission.ticketId, trusted)),
        )
        if (answer.state === 'absent')
          answer = journalWire(
            'AdmissionProbe',
            await unwrap(runtime.store.createRun(issued.admission, trusted)),
          )
        return finish(issued.admission.ticketId, answer, trusted)
      })
    },
    confirm: recover,
    probe: recover,
    cancel(id: string, fingerprint: string, ctx: CallContext) {
      return execute(ctx, async (trusted) => {
        assertJournal(runtime, 'unsupported')
        const record = await load(id, trusted)
        assertJournal(
          journalWire('Digest', fingerprint) === record.request.fingerprint,
          'admission_ticket_conflict',
        )
        const reply = await unwrap(runtime.store.cancelAdmission(id, fingerprint, trusted))
        return finish(id, journalWire('AdmissionProbe', reply), trusted)
      })
    },
    readSessionControl(sessionId: string, ctx: CallContext) {
      return execute(ctx, async (trusted) => {
        assertJournal(runtime, 'unsupported')
        const projection = journalWire(
          'SessionControlState',
          await unwrap(
            runtime.store.readSessionControl(
              journalWire('StateStoreControlReadSessionControlRequest', { sessionId }),
              trusted,
            ),
          ),
        )
        assertJournal(projection.sessionId === sessionId, 'session_control_mismatch')
        return projection
      })
    },
    submitSessionControl(raw: SessionControlRequest, ctx: CallContext) {
      const cloned = structuredClone(raw)
      return execute(ctx, async (trusted) => {
        assertJournal(runtime, 'unsupported')
        const command = journalWire('SessionControlRequest', cloned)
        const reply = journalWire(
          'SessionControlResult',
          await unwrap(runtime.store.submitSessionControl(command, trusted)),
        )
        assertJournal(
          reply.sessionId === command.sessionId && reply.requestId === command.requestId,
          'session_control_mismatch',
        )
        return reply
      })
    },
    sessionControlStatus(sessionId: string, requestId: string, ctx: CallContext) {
      return execute(ctx, async (trusted) => {
        assertJournal(runtime, 'unsupported')
        const identity = journalWire('StateStoreControlSessionControlStatusRequest', { requestId, sessionId })
        const status = journalWire(
          'StateStoreControlSessionControlStatusResult',
          await unwrap(runtime.store.sessionControlStatus(identity, trusted)),
        )
        assertJournal(
          status === null || (status.requestId === requestId && status.sessionId === sessionId),
          'session_control_mismatch',
        )
        return status
      })
    },
    async dispose() {
      stopped = true
      shutdown.abort()
      await queue
    },
  }
}
