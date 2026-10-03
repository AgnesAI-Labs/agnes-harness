import type { MigrationPlan, MigrationRequest } from '@agnes/protocol/runtime'

/** Facts read by the selected owner from one immutable snapshot, never an execution credential. */
export interface MigrationEligibilityFacts {
  readonly integrity: boolean
  readonly authorityKnown: boolean
  readonly targetTrusted: boolean
  readonly permissionCompatible: boolean
  readonly referencesCompatible: boolean
  readonly resourcesRecoverable: boolean
  readonly capacityAvailable: boolean
  readonly sourceRecoverable: boolean
  readonly exactMigrator: boolean
  readonly autoAuthorized: boolean
  readonly explicitAuthorized: boolean
  readonly drained: boolean
  readonly inflight: boolean
  readonly unknown: boolean
  readonly attachedChild: boolean
  readonly callbackProof: boolean
  readonly debtProof: boolean
  readonly intakeProof: boolean
  readonly fenceCapable: boolean
  readonly cohortComplete: boolean
  readonly jointQualification: boolean
  readonly terminal: boolean
  readonly readerOnly: boolean
  readonly pending: readonly {
    readonly kind: 'answer' | 'action' | 'signal' | 'job'
    readonly id: string
    readonly bindingId: string
    readonly pinId: string
    readonly identityPreserved: boolean
    readonly bindingPreserved: boolean
    readonly pinPreserved: boolean
    readonly semanticsPreserved: boolean
  }[]
}

export function migrationEligibility(
  request: MigrationRequest,
  facts: MigrationEligibilityFacts,
): Pick<MigrationPlan, 'eligibility' | 'reasonCodes'> {
  const blocked: string[] = []
  for (const [field, reason] of [
    ['integrity', 'source_integrity'],
    ['authorityKnown', 'authority_unavailable'],
    ['targetTrusted', 'binding_unavailable'],
    ['permissionCompatible', 'permission_incompatible'],
    ['referencesCompatible', 'references_incompatible'],
    ['resourcesRecoverable', 'resources_unrecoverable'],
    ['capacityAvailable', 'capacity_unavailable'],
  ] as const)
    if (facts[field] !== true) blocked.push(reason)
  if (request.mode === 'auto-compatible' && facts.autoAuthorized !== true)
    blocked.push('auto_scope_unapproved')
  if (request.mode === 'explicit' && facts.explicitAuthorized !== true) blocked.push('explicit_unapproved')
  if (
    facts.pending.some(
      (item) =>
        !item.id ||
        !item.bindingId ||
        !item.pinId ||
        item.identityPreserved !== true ||
        item.bindingPreserved !== true ||
        item.pinPreserved !== true ||
        item.semanticsPreserved !== true,
    )
  )
    blocked.push('pending_identity_unpreserved')
  if (facts.terminal && !facts.readerOnly) blocked.push('terminal_execution_forbidden')
  if (request.target.kind !== 'run-state') {
    for (const [field, reason] of [
      ['callbackProof', 'callback_proof_missing'],
      ['debtProof', 'debt_proof_missing'],
      ['intakeProof', 'intake_proof_missing'],
      ['fenceCapable', 'fence_unavailable'],
      ['cohortComplete', 'cohort_incomplete'],
      ['jointQualification', 'joint_dispatch_incompatible'],
    ] as const)
      if (facts[field] !== true) blocked.push(reason)
  }
  if (blocked.length) return { eligibility: 'blocked', reasonCodes: blocked.sort() }
  const waiting: string[] = []
  if (request.target.kind === 'run-state') {
    if (facts.unknown !== false) waiting.push('unknown_effect')
    if (facts.inflight !== false) waiting.push('inflight_action')
    if (facts.attachedChild !== false) waiting.push('attached_child')
  }
  if (facts.drained !== true) waiting.push('drain_incomplete')
  if (waiting.length) return { eligibility: 'wait-safe-point', reasonCodes: waiting.sort() }
  if (request.target.kind === 'run-state' && facts.exactMigrator !== true)
    return {
      eligibility: facts.sourceRecoverable === true ? 'retain-source' : 'blocked',
      reasonCodes: ['migrator_unavailable'],
    }
  return { eligibility: 'eligible', reasonCodes: [] }
}
