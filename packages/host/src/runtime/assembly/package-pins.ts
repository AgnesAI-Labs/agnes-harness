import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type { DataRef } from '@agnes/protocol/runtime'
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
import { equal, fields, readWire, requireRelease } from './primitives.js'
import { releaseRequiredDigests } from './publication.js'
import { releaseSetDigest } from './release-set.js'

/** Narrow maintenance retention only. It neither creates Runtime owners nor releases source resources. */
export function createMaintenancePackagePins(ports: AssemblyMaintenancePorts) {
  return {
    async retain(
      incoming: { pinId: string; releaseSetId: string; ownerKind: string; ownerId: string },
      context: CallContext,
    ): Promise<Outcome<DataRef>> {
      return maintenanceOutcome(async () => {
        const request = structuredClone(incoming)
        await authorizeMaintenance(ports, context, null)
        fields(request, ['pinId', 'releaseSetId', 'ownerKind', 'ownerId'], '/pin')
        for (const field of Object.values(request)) readWire('Id', field)
        requireRelease(
          ['run', 'action', 'job', 'interaction', 'admission', 'reader', 'migration'].includes(
            request.ownerKind,
          ),
          'schema_invalid',
          '/pin/ownerKind',
        )
        const records = await journalRead(ports, null, context)
        const get = (id: string) => records.find((row) => row.recordId === id) ?? null
        const releaseRecord = get(`release:${request.releaseSetId}`),
          head = get(ports.headRecordId)
        requireRelease(releaseRecord && head, 'release_route_unavailable', '/pin/release')
        const release = readReleaseSnapshot(releaseRecord)
        requireRelease(
          release.releaseSetId === request.releaseSetId && releaseSetDigest(release) === release.releaseSetId,
          'release_digest_mismatch',
          '/pin/release',
        )
        const pin = {
          ...request,
          requiredDigests: releaseRequiredDigests(release),
          maintenanceCommitId: `retain:${request.pinId}`,
          issuer: ports.authority,
          scope: context.scope,
          status: 'active',
        }
        const prior = get(`pin:${request.pinId}`)
        if (prior) {
          requireRelease(
            equal(journalData(prior, 'package-pin-receipt'), pin),
            'package_pin_conflict',
            '/pin/replay',
          )
          return journalRef(pin, 'package-pin-receipt')
        }
        const now = readWire('Timestamp', ports.now())
        await journalCommit(
          ports,
          `retain:${request.pinId}`,
          [
            journalMutation(
              ports,
              head.recordId,
              'current-head',
              journalData(head, 'current-head'),
              head,
              now,
            ),
            journalMutation(ports, `pin:${request.pinId}`, 'package-pin-receipt', pin, null, now),
          ],
          [],
          context,
        )
        return journalRef(pin, 'package-pin-receipt')
      })
    },
    async active(context: CallContext): Promise<Outcome<DataRef[]>> {
      return maintenanceOutcome(async () => {
        await authorizeMaintenance(ports, context, null)
        const records = await journalRead(ports, null, context)
        return records
          .filter((row) => row.recordId.startsWith('pin:'))
          .map((row) => journalData(row, 'package-pin-receipt'))
          .filter((pin) => pin.status !== 'released')
          .map((pin) => journalRef(pin, 'package-pin-receipt'))
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
