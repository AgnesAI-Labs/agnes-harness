import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type { AdmissionProbe, DataRef, RunAdmission, StateAuthorityRef } from '@agnes/protocol/runtime'
import {
  assertJournal,
  journalHash,
  journalSame,
  journalWire,
  type ReferenceMaintenancePorts,
  referenceAuthorized,
  referenceBody,
  referenceCommit,
  referenceDigests,
  referenceObject,
  referenceRead,
  referenceRef,
  referenceRelease,
  referenceResult,
  referenceWrite,
} from './assembly-journal.js'

export function referenceTicketDecision(
  status: 'issued' | 'bound' | 'cancelled',
  probe: AdmissionProbe | null,
) {
  const next =
    status === 'cancelled'
      ? 'none'
      : status === 'bound'
        ? 'retain-run-pin'
        : probe?.state === 'created'
          ? 'confirm-with-state-proof'
          : probe?.state === 'cancelled'
            ? 'verify-cancellation-proof'
            : 'probe-required'
  return { next, keepPin: true }
}
type Draft = {
  runKey: string
  admission: Omit<RunAdmission, 'fingerprint' | 'packagePinReceipt'>
  stateAuthorityRef: StateAuthorityRef
  grantRef: string
}
export function createReferenceAdmissionTickets(ports: ReferenceMaintenancePorts) {
  return {
    incomplete: Object.freeze(['createRun', 'confirm', 'cancel', 'probe', 'release-pin']),
    async issue(
      incoming: Draft,
      call: CallContext,
    ): Promise<Outcome<{ ticketRef: DataRef; packagePinReceipt: DataRef; admission: RunAdmission }>> {
      return referenceResult(async () => {
        const draft = structuredClone(incoming)
        await referenceAuthorized(ports, call, null)
        referenceObject(draft, ['admission', 'runKey', 'grantRef', 'stateAuthorityRef'])
        referenceObject(draft.admission, [
          'ticketId',
          'releaseSetId',
          'bindingId',
          'runId',
          'sessionId',
          'lane',
          'workspaceId',
          'input',
          'admittedAt',
          'deadline',
          'conversation',
        ])
        journalWire('Id', draft.runKey)
        journalWire('StateAuthorityRef', draft.stateAuthorityRef)
        assertJournal(draft.grantRef === call.authorizationRef, 'maintenance_denied')
        const rows = new Map((await referenceRead(ports, call)).map((row) => [row.recordId, row]))
        const id = journalWire('Id', draft.admission.ticketId),
          key = `ticket:${id}`,
          fingerprint = journalHash(draft)
        const prior = rows.get(key)
        if (prior) {
          const ticket = referenceBody(prior, 'admission-ticket')
          assertJournal(
            journalSame(ticket.scope, call.scope) && ticket.requestFingerprint === fingerprint,
            'admission_ticket_conflict',
          )
          const admission = journalWire('RunAdmission', ticket.admission),
            pin = rows.get(`pin:admission:${id}`)
          assertJournal(
            pin &&
              (referenceBody(pin, 'package-pin-receipt').status === 'active' ||
                (ticket.status === 'cancelled' &&
                  referenceBody(pin, 'package-pin-receipt').status === 'released')) &&
              journalSame(
                referenceRef(
                  { ...referenceBody(pin, 'package-pin-receipt'), status: 'active' },
                  'package-pin-receipt',
                ),
                admission.packagePinReceipt,
              ),
            'package_pin_missing',
          )
          return {
            admission,
            packagePinReceipt: admission.packagePinReceipt,
            ticketRef: referenceRef(ticket, 'admission-ticket'),
          }
        }
        const indexKey = `run-key:${journalHash({ scope: call.scope, runKey: draft.runKey })}`
        assertJournal(!rows.has(indexKey), 'admission_ticket_conflict')
        const head = rows.get(ports.headRecordId)
        assertJournal(head && head.writerEpoch === ports.writerEpoch, 'maintenance_head_unavailable')
        const facts = referenceBody(head, 'current-head')
        assertJournal(
          journalSame(facts.stateAuthorityRef, draft.stateAuthorityRef) &&
            draft.stateAuthorityRef.tenantId === ports.authority.tenantId,
          'locator_route_stale',
        )
        const directory = referenceObject(facts.directory, [
          'locatorId',
          'locatorRevision',
          'directoryEpoch',
          'routeId',
          'routeRevision',
          'releaseSetId',
        ])
        const route = rows.get(`release-route:${journalWire('Id', directory.routeId)}`)
        assertJournal(route, 'release_route_unavailable')
        const selected = referenceBody(route, 'release-route')
        assertJournal(
          selected.activeReleaseSetId === draft.admission.releaseSetId &&
            selected.authorityEpoch === draft.stateAuthorityRef.authorityEpoch,
          'plan_stale',
        )
        const lock = rows.get(`release:${draft.admission.releaseSetId}`)
        assertJournal(lock, 'release_route_unavailable')
        const release = referenceRelease(lock)
        const { releaseSetId: omitted, ...releaseBody } = release
        assertJournal(journalHash(releaseBody) === release.releaseSetId, 'release_digest_mismatch')
        const at = journalWire('Timestamp', ports.now())
        assertJournal(
          Date.parse(draft.admission.admittedAt) <= Date.parse(at) &&
            Date.parse(draft.admission.deadline) > Date.parse(at),
          'admission_expired',
        )
        const pinId = `admission:${id}`,
          transaction = `ticket:${id}`
        const receipt = {
          pinId,
          releaseSetId: release.releaseSetId,
          requiredDigests: referenceDigests(release),
          maintenanceCommitId: transaction,
          issuer: ports.authority,
          scope: call.scope,
          ownerKind: 'admission',
          ownerId: id,
          status: 'active',
        }
        const packagePinReceipt = referenceRef(receipt, 'package-pin-receipt'),
          body = { ...draft.admission, packagePinReceipt }
        const admission = journalWire('RunAdmission', { ...body, fingerprint: journalHash(body) })
        const ticket = {
          ticketId: id,
          routeId: selected.routeId,
          routeRevision: route.revision,
          releaseSetId: release.releaseSetId,
          bindingId: admission.bindingId,
          stateAuthorityRef: draft.stateAuthorityRef,
          runKey: draft.runKey,
          admission,
          packagePinReceipt,
          fingerprint: admission.fingerprint,
          status: 'issued',
          grantRef: draft.grantRef,
          scope: call.scope,
          requestFingerprint: fingerprint,
        }
        await referenceAuthorized(ports, call, null)
        try {
          await referenceCommit(
            ports,
            transaction,
            [
              referenceWrite(ports, head.recordId, 'current-head', facts, head, at),
              referenceWrite(ports, key, 'admission-ticket', ticket, null, at),
              referenceWrite(ports, `pin:${pinId}`, 'package-pin-receipt', receipt, null, at),
              referenceWrite(
                ports,
                indexKey,
                'admission-run-key',
                { runKey: draft.runKey, ticketId: id, scope: call.scope, requestFingerprint: fingerprint },
                null,
                at,
              ),
            ],
            [],
            call,
          )
        } catch (fault) {
          const winner = (await referenceRead(ports, call)).find((row) => row.recordId === key)
          if (!winner) throw fault
          const committedTicket = referenceBody(winner, 'admission-ticket')
          assertJournal(
            committedTicket.requestFingerprint === fingerprint &&
              journalSame(committedTicket.admission, admission),
            'admission_ticket_conflict',
          )
        }
        return { admission, packagePinReceipt, ticketRef: referenceRef(ticket, 'admission-ticket') }
      })
    },
    async coordinate(): Promise<Outcome<never>> {
      return {
        ok: false,
        error: {
          code: 'incompatible',
          detailCode: 'runtime_admission_unimplemented',
          message: 'Runtime admission coordination is unavailable',
          diagnosticId: 'assembly-admission',
          retryAdvice: { kind: 'never' },
        },
      }
    },
  }
}
export function createReferenceMaintenancePackagePins(ports: ReferenceMaintenancePorts) {
  return {
    async retain(
      incoming: { pinId: string; releaseSetId: string; ownerKind: string; ownerId: string },
      call: CallContext,
    ): Promise<Outcome<DataRef>> {
      return referenceResult(async () => {
        const request = structuredClone(incoming)
        await referenceAuthorized(ports, call, null)
        referenceObject(request, ['pinId', 'releaseSetId', 'ownerKind', 'ownerId'])
        for (const value of Object.values(request)) journalWire('Id', value)
        assertJournal(
          new Set(['migration', 'reader', 'admission', 'interaction', 'job', 'action', 'run']).has(
            request.ownerKind,
          ),
          'schema_invalid',
        )
        const entries = new Map((await referenceRead(ports, call)).map((row) => [row.recordId, row]))
        const lock = entries.get(`release:${request.releaseSetId}`),
          header = entries.get(ports.headRecordId)
        assertJournal(lock && header, 'release_route_unavailable')
        const release = referenceRelease(lock)
        const { releaseSetId: omitted, ...body } = release
        assertJournal(
          release.releaseSetId === request.releaseSetId && journalHash(body) === release.releaseSetId,
          'release_digest_mismatch',
        )
        const pin = {
          ...request,
          requiredDigests: referenceDigests(release),
          maintenanceCommitId: `retain:${request.pinId}`,
          issuer: ports.authority,
          scope: call.scope,
          status: 'active',
        }
        const record = entries.get(`pin:${request.pinId}`)
        if (record) {
          assertJournal(
            journalSame(referenceBody(record, 'package-pin-receipt'), pin),
            'package_pin_conflict',
          )
          return referenceRef(pin, 'package-pin-receipt')
        }
        const at = journalWire('Timestamp', ports.now())
        await referenceCommit(
          ports,
          `retain:${request.pinId}`,
          [
            referenceWrite(
              ports,
              header.recordId,
              'current-head',
              referenceBody(header, 'current-head'),
              header,
              at,
            ),
            referenceWrite(ports, `pin:${request.pinId}`, 'package-pin-receipt', pin, null, at),
          ],
          [],
          call,
        )
        return referenceRef(pin, 'package-pin-receipt')
      })
    },
    async active(call: CallContext): Promise<Outcome<DataRef[]>> {
      return referenceResult(async () => {
        await referenceAuthorized(ports, call, null)
        const roots: DataRef[] = []
        for (const entry of await referenceRead(ports, call)) {
          if (!entry.recordId.startsWith('pin:')) continue
          const body = referenceBody(entry, 'package-pin-receipt')
          if (body.status !== 'released') roots.push(referenceRef(body, 'package-pin-receipt'))
        }
        return roots
      })
    },
    async release(): Promise<Outcome<never>> {
      return {
        ok: false,
        error: {
          code: 'incompatible',
          detailCode: 'package_pin_release_unimplemented',
          message: 'Authoritative owner release proofs are unavailable',
          diagnosticId: 'assembly-package-pins',
          retryAdvice: { kind: 'never' },
        },
      }
    },
  }
}
