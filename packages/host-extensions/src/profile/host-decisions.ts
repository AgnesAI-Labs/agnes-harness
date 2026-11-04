import type { DecisionCommands } from '@agnes/core'
import type { DecisionSnapshot, Logger } from '@agnes/extension-api'
import { bestEffort } from '../best-effort.js'
import type { ProfileJournal, ProfileOperation } from './journal.js'

/**
 * A Host part that keeps its own operations and decisions in the profile decision journal, beside the
 * plugin services'. Its operations are not tied to a plugin registration or activation: the owner says
 * whether one still stands, and is told how each of its decisions ended.
 */
export type HostDecisionOwner = {
  /** Whether the operation may still be decided. False withdraws its decision, as a lost activation does. */
  alive(operation: ProfileOperation): boolean
  /**
   * The decision of `operation` has ended: answered by a person, withdrawn, or expired. Called again for
   * an operation still waiting on an ended decision, so the owner settles it once and ignores the rest.
   */
  answered(operation: ProfileOperation, decision: DecisionSnapshot): Promise<void>
}

/**
 * The activation id every Host-owned operation row carries. Plugin operations carry a random activation
 * id, so an extension registered under a Host owner's name is never taken for that owner.
 */
export const HOST_DECISION_ACTIVATION = 'host'

/**
 * The operation a decision was asked for, and its Host owner, when a Host part owns it. A row whose run
 * was cut off by a restart no longer names its decision (the journal marks it `unknown`); a Host-owned
 * one is then found by the operation id the decision names.
 */
export function hostOperation(
  journal: ProfileJournal,
  owners: ReadonlyMap<string, HostDecisionOwner> | undefined,
  decisionId: string,
  operationId?: string,
): { operation: ProfileOperation; owner: HostDecisionOwner } | undefined {
  if (!owners?.size) return undefined
  const rows = [...journal.operations.values()]
  const operation =
    rows.find((row) => row.receipt.decision?.id === decisionId) ??
    (operationId === undefined
      ? undefined
      : rows.find(
          (row) =>
            row.activationId === HOST_DECISION_ACTIVATION &&
            row.receipt.operationId === operationId &&
            cutOff(row),
        ))
  const owner = operation?.activationId === HOST_DECISION_ACTIVATION ? owners.get(operation.owner) : undefined
  return operation && owner ? { operation, owner } : undefined
}

/** A row whose run was cut off: still running here, or marked unknown by a restart. */
export const cutOff = (operation: ProfileOperation): boolean =>
  operation.receipt.state === 'running' ||
  (operation.receipt.state === 'unknown' && operation.receipt.code === 'OUTCOME_UNKNOWN')

const stands = (owner: HostDecisionOwner, operation: ProfileOperation): boolean => {
  try {
    return owner.alive(structuredClone(operation))
  } catch {
    return false
  }
}

/** Whether a person may answer a Host-owned decision now. */
export function hostDecisionAnswerable(found: { operation: ProfileOperation; owner: HostDecisionOwner }) {
  return stands(found.owner, found.operation)
}

/** Hands an ended decision to its owner; a failure there never fails the listing or the answer. */
export async function hostDecisionEnded(
  found: { operation: ProfileOperation; owner: HostDecisionOwner },
  decision: DecisionSnapshot,
  log: Logger,
): Promise<void> {
  await found.owner
    .answered(structuredClone(found.operation), structuredClone(decision))
    .catch(bestEffort(log, 'profile-host-decision'))
}

/**
 * One Host-owned decision as the listing sees it: true while it is pending and its owner stands by it.
 * A pending decision its owner gave up is withdrawn; an ended decision whose operation still waits, or
 * was left running by a process that stopped, is handed to the owner to settle.
 */
export async function hostDecisionPending(
  found: { operation: ProfileOperation; owner: HostDecisionOwner },
  value: DecisionSnapshot,
  decisions: DecisionCommands,
  log: Logger,
): Promise<boolean> {
  const waiting = found.operation.receipt.state === 'approval-required'
  if (value.consumption || value.invalidation || value.result) {
    // A row still running on an ended decision was cut off before its owner finished it: hand it again.
    if (waiting || cutOff(found.operation)) await hostDecisionEnded(found, value, log)
    return false
  }
  if (waiting && stands(found.owner, found.operation)) return true
  const withdrawn = await decisions.withdraw(
    value.handle,
    {
      owner: value.request.owner,
      operationId: value.request.operationId,
      sourcePackage: value.request.sourcePackage,
      packageVersion: value.request.packageVersion,
      alive() {},
    },
    'withdrawn',
  )
  if (waiting) await hostDecisionEnded(found, withdrawn, log)
  return false
}
