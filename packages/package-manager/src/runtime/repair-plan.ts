import type { Outcome } from '@agnes/extension-api/runtime'
import type { RuntimeWireTypes as Wire } from '@agnes/protocol/runtime'
import {
  InstallFault,
  type InstallRecord,
  installerAttempt,
  installerDigest,
  installerWire,
} from './install-journal.js'

/** A read-only observation of the original authority, never a second UpgradeOperation. */
export interface InstallOperationObservation {
  readonly operationId: string
  readonly planDigest: string
  readonly state: 'unpublished' | 'published' | 'unknown'
  readonly heads: Wire['UpgradeExpectedHeads']
  readonly checkpoint: Wire['UpgradeCheckpoint'] | null
  readonly receipt: Wire['ReceiptPointer'] | null
}

export interface InstallRepairPlan {
  readonly proposalId: string
  readonly proposalRevision: number
  readonly operationRef: Wire['DataRef']
  readonly operationId: string
  readonly checkpoint: Wire['UpgradeCheckpoint']
  readonly currentHeads: Wire['UpgradeExpectedHeads']
  readonly action: 'reclaim-unpublished' | 'probe-published' | 'new-reverse-operation'
  readonly originalReceipt: Wire['ReceiptPointer'] | null
  readonly digest: string
}

export function verifyInstallObservation(
  record: InstallRecord,
  observation: InstallOperationObservation,
): void {
  if (
    !record.operation ||
    observation.operationId !== record.operation.operationId ||
    observation.planDigest !== record.proposal.planDigest
  )
    throw new InstallFault('conflict', 'operation_identity_conflict')
  installerWire('UpgradeExpectedHeads', observation.heads)
  if (!['unpublished', 'published', 'unknown'].includes(observation.state))
    throw new InstallFault('invalid_input', 'operation_observation_invalid')
  if (observation.receipt !== null) installerWire('ReceiptPointer', observation.receipt)
  if (observation.checkpoint !== null) installerWire('UpgradeCheckpoint', observation.checkpoint)
  if (observation.state === 'published' && observation.receipt === null)
    throw new InstallFault('conflict', 'publication_receipt_missing')
  if (
    observation.state === 'unpublished' &&
    (observation.receipt !== null || record.proposal.resultRef !== null)
  )
    throw new InstallFault('conflict', 'publication_fact_conflict')
  if (
    record.proposal.resultRef !== null &&
    observation.receipt !== null &&
    installerDigest(record.proposal.resultRef) !== installerDigest(observation.receipt)
  )
    throw new InstallFault('conflict', 'publication_fact_conflict')
}

/** A trusted checkpoint verifier reads evidence from the original operation authority. */
export type InstallCheckpointVerifier = (
  operationRef: Wire['DataRef'],
  checkpoint: Wire['UpgradeCheckpoint'],
) => Outcome<Wire['UpgradeExpectedHeads']>

/** Computes advice only. Even unpublished reclamation still needs a separate authorized effect. */
export function createInstallRepairPlan(
  record: InstallRecord,
  observation: InstallOperationObservation,
  currentHeads: Wire['UpgradeExpectedHeads'],
  verifyCheckpoint: InstallCheckpointVerifier,
): Outcome<InstallRepairPlan> {
  return installerAttempt(() => {
    verifyInstallObservation(record, observation)
    const heads = installerWire('UpgradeExpectedHeads', currentHeads)
    const operation = record.operation
    const checkpoint = observation.checkpoint
    if (!operation || !checkpoint || checkpoint.evidence.length === 0)
      throw new InstallFault('denied', 'checkpoint_unverified')
    if (observation.state === 'unknown') throw new InstallFault('unknown_effect', 'operation_unknown')
    const verified = verifyCheckpoint(operation.reference, checkpoint)
    if (!verified.ok) throw new InstallFault(verified.error.code, verified.error.detailCode)
    installerWire('UpgradeExpectedHeads', verified.value)
    if (installerDigest(verified.value) !== installerDigest(observation.heads))
      throw new InstallFault('conflict', 'checkpoint_heads_conflict')
    if (
      heads.kind !== 'release' ||
      observation.heads.kind !== 'release' ||
      heads.routeId !== observation.heads.routeId
    )
      throw new InstallFault('conflict', 'repair_route_conflict')
    const sameHeads = installerDigest(heads) === installerDigest(observation.heads)
    if (observation.state === 'unpublished' && !sameHeads)
      throw new InstallFault('conflict', 'repair_heads_conflict')
    const payload = {
      proposalId: record.proposal.proposalId,
      proposalRevision: record.proposal.revision,
      operationRef: operation.reference,
      operationId: operation.operationId,
      checkpoint: structuredClone(checkpoint),
      currentHeads: heads,
      action:
        observation.state === 'unpublished'
          ? ('reclaim-unpublished' as const)
          : sameHeads
            ? ('probe-published' as const)
            : ('new-reverse-operation' as const),
      originalReceipt: observation.receipt,
    }
    return { ...payload, digest: installerDigest(payload) }
  })
}

/** Opaque local schema pending a shared maintenance schema; it changes no public protocol. */
export function installRepairPlanRef(plan: InstallRepairPlan): Wire['DataRef'] {
  const value = JSON.parse(JSON.stringify(plan)) as Wire['JsonValue']
  const text = JSON.stringify(value)
  return {
    kind: 'inline',
    value,
    bytes: Buffer.byteLength(text),
    digest: installerDigest(value),
    schema: {
      typeId: 'private.package-installer/repair@1',
      revision: 1,
      digest: installerDigest('private.package-installer/repair@1'),
    },
  }
}
