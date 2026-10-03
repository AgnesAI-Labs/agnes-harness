/** Pure retention decision. Unknown references keep the recovery artifacts pinned. */
export interface MigrationPinRetentionInput {
  readonly referencesKnown: boolean
  readonly oldOwners: readonly {
    readonly ownerId: string
    readonly pinId: string
    readonly settled: boolean
  }[]
  readonly operationState: 'planned' | 'frozen' | 'committed' | 'completed' | 'aborted'
  readonly now: string
  readonly minimumRecoveryUntil: string
  readonly archiveVerified: boolean
  readonly currentDeletionAndRevocationApplied: boolean
  readonly targetPinDurable: boolean
  readonly ownerTransferConfirmed: boolean
}
export function migrationPinRetention(input: MigrationPinRetentionInput) {
  const reasons: string[] = []
  if (!input.referencesKnown) reasons.push('references_unknown')
  if (input.oldOwners.some((owner) => !owner.settled)) reasons.push('old_owner_live')
  if (!['completed', 'aborted'].includes(input.operationState)) reasons.push('operation_unfinished')
  if (
    !Number.isFinite(Date.parse(input.now)) ||
    !Number.isFinite(Date.parse(input.minimumRecoveryUntil)) ||
    Date.parse(input.now) < Date.parse(input.minimumRecoveryUntil)
  )
    reasons.push('recovery_window')
  if (!input.archiveVerified) reasons.push('archive_unverified')
  if (!input.currentDeletionAndRevocationApplied) reasons.push('current_controls_missing')
  if (input.operationState === 'completed' && (!input.targetPinDurable || !input.ownerTransferConfirmed))
    reasons.push('target_ownership_unconfirmed')
  return Object.freeze({
    mayCollect: reasons.length === 0,
    reasonCodes: Object.freeze(reasons.sort()),
    retainedPinIds: Object.freeze(
      [
        ...new Set(
          input.oldOwners.filter((owner) => reasons.length > 0 || !owner.settled).map((owner) => owner.pinId),
        ),
      ].sort(),
    ),
  })
}
