import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type { AdmissionProbe, DataRef, RunAdmission } from '@agnes/protocol/runtime'
import {
  type AssemblyMaintenancePorts,
  authorizeMaintenance,
  journalCommit,
  journalData,
  journalMutation,
  journalRead,
  journalRef,
  maintenanceOutcome,
  readReleaseSnapshot,
} from './maintenance-journal.js'
import { digest, equal, fields, readWire, requireRelease } from './primitives.js'
import { releaseRequiredDigests } from './publication.js'
import { releaseSetDigest } from './release-set.js'

export type TicketDraft = {
  readonly runKey: string
  readonly admission: Omit<RunAdmission, 'fingerprint' | 'packagePinReceipt'>
  readonly stateAuthorityRef: import('@agnes/protocol/runtime').StateAuthorityRef
  readonly grantRef: string
}

/** Pure advice, not a State proof verifier or a pin-release operation. */
export function admissionTicketDecision(
  status: 'issued' | 'bound' | 'cancelled',
  probe: AdmissionProbe | null,
) {
  if (status === 'cancelled') return { next: 'none', keepPin: true }
  if (status === 'bound') return { next: 'retain-run-pin', keepPin: true }
  if (probe?.state === 'created') return { next: 'confirm-with-state-proof', keepPin: true }
  if (probe?.state === 'cancelled') return { next: 'verify-cancellation-proof', keepPin: true }
  return { next: 'probe-required', keepPin: true }
}

/** Maintenance-only durable issuance. Full Runtime create/confirm/cancel/probe is unavailable. */
export function createAdmissionTickets(ports: AssemblyMaintenancePorts) {
  return {
    incomplete: Object.freeze(['createRun', 'confirm', 'cancel', 'probe', 'release-pin']),
    async issue(
      incoming: TicketDraft,
      context: CallContext,
    ): Promise<Outcome<{ ticketRef: DataRef; packagePinReceipt: DataRef; admission: RunAdmission }>> {
      return maintenanceOutcome(async () => {
        const draft = structuredClone(incoming)
        await authorizeMaintenance(ports, context, null)
        fields(draft, ['runKey', 'admission', 'stateAuthorityRef', 'grantRef'], '/ticket')
        fields(
          draft.admission,
          [
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
          ],
          '/ticket/admission',
        )
        readWire('Id', draft.runKey)
        readWire('StateAuthorityRef', draft.stateAuthorityRef)
        requireRelease(draft.grantRef === context.authorizationRef, 'maintenance_denied', '/ticket/grantRef')
        const records = await journalRead(ports, null, context)
        const get = (id: string) => records.find((row) => row.recordId === id) ?? null
        const ticketId = readWire('Id', draft.admission.ticketId),
          recordId = `ticket:${ticketId}`
        const prior = get(recordId),
          requestFingerprint = digest(draft)
        if (prior) {
          const ticket = journalData(prior, 'admission-ticket')
          requireRelease(
            ticket.requestFingerprint === requestFingerprint && equal(ticket.scope, context.scope),
            'admission_ticket_conflict',
            '/ticket/replay',
          )
          const admission = readWire('RunAdmission', ticket.admission)
          const pin = get(`pin:admission:${ticketId}`)
          requireRelease(
            pin &&
              journalData(pin, 'package-pin-receipt').status === 'active' &&
              equal(
                journalRef(journalData(pin, 'package-pin-receipt'), 'package-pin-receipt'),
                admission.packagePinReceipt,
              ),
            'package_pin_missing',
            '/ticket/pin',
          )
          return {
            ticketRef: journalRef(ticket, 'admission-ticket'),
            packagePinReceipt: admission.packagePinReceipt,
            admission,
          }
        }
        const keyId = `run-key:${digest({ scope: context.scope, runKey: draft.runKey })}`
        requireRelease(!get(keyId), 'admission_ticket_conflict', '/ticket/runKey')
        const head = get(ports.headRecordId)
        requireRelease(
          head && head.writerEpoch === ports.writerEpoch,
          'maintenance_head_unavailable',
          '/ticket/head',
        )
        const headData = journalData(head, 'current-head')
        requireRelease(
          equal(headData.stateAuthorityRef, draft.stateAuthorityRef) &&
            draft.stateAuthorityRef.tenantId === ports.authority.tenantId,
          'locator_route_stale',
          '/ticket/authority',
        )
        const directory = fields(
          headData.directory,
          ['locatorId', 'locatorRevision', 'directoryEpoch', 'routeId', 'routeRevision', 'releaseSetId'],
          '/ticket/directory',
        )
        const route = get(`release-route:${readWire('Id', directory.routeId)}`)
        requireRelease(route, 'release_route_unavailable', '/ticket/route')
        const active = journalData(route, 'release-route')
        requireRelease(
          active.activeReleaseSetId === draft.admission.releaseSetId &&
            active.authorityEpoch === draft.stateAuthorityRef.authorityEpoch,
          'plan_stale',
          '/ticket/releaseSetId',
        )
        const releaseRecord = get(`release:${draft.admission.releaseSetId}`)
        requireRelease(releaseRecord, 'release_route_unavailable', '/ticket/release')
        const release = readReleaseSnapshot(releaseRecord)
        requireRelease(
          releaseSetDigest(release) === release.releaseSetId,
          'release_digest_mismatch',
          '/ticket/release',
        )
        const now = readWire('Timestamp', ports.now())
        requireRelease(
          Date.parse(draft.admission.admittedAt) <= Date.parse(now) &&
            Date.parse(draft.admission.deadline) > Date.parse(now),
          'admission_expired',
          '/ticket/deadline',
        )
        const pinId = `admission:${ticketId}`,
          transactionId = `ticket:${ticketId}`
        const pin = {
          pinId,
          releaseSetId: release.releaseSetId,
          requiredDigests: releaseRequiredDigests(release),
          maintenanceCommitId: transactionId,
          issuer: ports.authority,
          scope: context.scope,
          ownerKind: 'admission',
          ownerId: ticketId,
          status: 'active',
        }
        const packagePinReceipt = journalRef(pin, 'package-pin-receipt')
        const body = { ...draft.admission, packagePinReceipt }
        const admission = readWire('RunAdmission', { ...body, fingerprint: digest(body) })
        const ticket = {
          ticketId,
          routeId: active.routeId,
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
          scope: context.scope,
          requestFingerprint,
        }
        const mutations = [
          journalMutation(ports, head.recordId, 'current-head', headData, head, now),
          journalMutation(ports, recordId, 'admission-ticket', ticket, null, now),
          journalMutation(ports, `pin:${pinId}`, 'package-pin-receipt', pin, null, now),
          journalMutation(
            ports,
            keyId,
            'admission-run-key',
            { runKey: draft.runKey, ticketId, scope: context.scope, requestFingerprint },
            null,
            now,
          ),
        ]
        await authorizeMaintenance(ports, context, null)
        await journalCommit(ports, transactionId, mutations, [], context)
        return { ticketRef: journalRef(ticket, 'admission-ticket'), packagePinReceipt, admission }
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
