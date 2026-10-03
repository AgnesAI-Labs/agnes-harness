import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type {
  BindingRef,
  DataRef,
  JsonValue,
  MigrationPlan,
  MigrationTarget,
  UpgradeExpectedHeads,
} from '@agnes/protocol/runtime'
import { assertTargetHeads, migrationPlanFingerprint } from './controller.js'
import {
  attempt,
  decode,
  failure,
  hash,
  immutable,
  requireMigration,
  same,
  verifyData,
} from './primitives.js'

export interface MigrationCommitEvidence {
  readonly upgradeId: string
  readonly planFingerprint: string
  readonly commitRef: string
  readonly cutoverId: string
  readonly checkpointRevision: number
  readonly target: MigrationTarget
  readonly sourceHeads: UpgradeExpectedHeads
  readonly committedHeads: UpgradeExpectedHeads
  readonly directoryHeads: Extract<UpgradeExpectedHeads, { kind: 'directory' }>
  readonly sourceSnapshotDigest: string
  readonly targetDigest: string
  readonly candidateRef: DataRef
  readonly validationRef: DataRef
  readonly completed: boolean
}
/** Installed by the trusted maintenance root for each selected authority, never by a candidate. */
export interface MigrationReceiptEvidencePort {
  authorize(plan: MigrationPlan, context: CallContext): Promise<Outcome<void>>
  probe(upgradeId: string, context: CallContext): Promise<Outcome<MigrationCommitEvidence | null>>
  currentHeads(
    target: MigrationTarget,
    context: CallContext,
  ): Promise<
    Outcome<{
      readonly heads: UpgradeExpectedHeads
      readonly directory: Extract<UpgradeExpectedHeads, { kind: 'directory' }>
    }>
  >
  readData(ref: DataRef, context: CallContext): Promise<Outcome<JsonValue>>
  /** Verify immutable evidence provenance against the plan's validator locks, not self-reported issuers. */
  validationIssuers(
    plan: MigrationPlan,
    ref: DataRef,
    context: CallContext,
  ): Promise<Outcome<readonly BindingRef[]>>
}
export type MigrationEvidencePorts = Partial<Record<MigrationTarget['kind'], MigrationReceiptEvidencePort>>

async function resolved(
  ref: DataRef,
  port: MigrationReceiptEvidencePort,
  context: CallContext,
): Promise<Outcome<JsonValue>> {
  const checked = attempt(() => verifyData(ref))
  if (!checked.ok) return checked
  const read = await port.readData(ref, context)
  if (!read.ok) return read
  const verified = attempt(() => {
    const data = decode('JsonValue', read.value)
    const digest = ref.kind === 'inline' ? ref.digest : ref.blob.digest
    const bytes = ref.kind === 'inline' ? ref.bytes : ref.blob.bytes
    requireMigration(
      hash(data) === digest && Buffer.byteLength(jcs(data)) === bytes,
      'content_identity_mismatch',
    )
    if (ref.kind === 'inline') requireMigration(same(data, ref.value), 'content_identity_mismatch')
    return data
  })
  return verified
}

/** A completed operation remains probeable after its planning deadline. Nothing here signs or commits. */
export async function verifyMigrationReceipt(
  rawPlan: unknown,
  rawReceipt: unknown,
  ports: MigrationEvidencePorts,
  context: CallContext,
  now = new Date().toISOString(),
): Promise<
  Outcome<{
    readonly next: 'regenerate-release-plan'
    readonly approval: 'reverify'
    readonly commitRef: string
  }>
> {
  if (context.signal.aborted) return failure('migration_cancelled', 'cancelled')
  const parsed = attempt(() => {
    const plan = immutable(structuredClone(decode('MigrationPlan', rawPlan)))
    const receipt = immutable(structuredClone(decode('MigrationReceipt', rawReceipt)))
    requireMigration(
      plan.upgradeId === plan.request.upgradeId && plan.planFingerprint === migrationPlanFingerprint(plan),
      'plan_fingerprint_mismatch',
    )
    assertTargetHeads(plan.request, plan.sourceHeads)
    requireMigration(plan.request.mode !== 'inspect-only', 'inspect_only_plan')
    requireMigration(plan.eligibility === 'eligible', 'migration_ineligible')
    requireMigration(
      receipt.state === 'completed' &&
        receipt.upgradeId === plan.upgradeId &&
        receipt.commitRef &&
        receipt.cutoverId,
      'prerequisite_migration_incomplete',
    )
    return { plan, receipt }
  })
  if (!parsed.ok) return parsed
  const { plan, receipt } = parsed.value
  const port = ports[plan.request.target.kind]
  if (!port) return failure('migration_evidence_unavailable', 'incompatible')
  try {
    const authorized = await port.authorize(plan, context)
    if (!authorized.ok) return authorized
    const probe = await port.probe(plan.upgradeId, context)
    if (!probe.ok) return probe
    if (!probe.value) return failure('prerequisite_migration_incomplete')
    const commit = immutable(structuredClone(probe.value))
    const validCommit = attempt(() => {
      requireMigration(commit.completed === true, 'prerequisite_migration_incomplete')
      requireMigration(
        commit.commitRef === receipt.commitRef &&
          commit.cutoverId === receipt.cutoverId &&
          commit.checkpointRevision === receipt.checkpointRevision &&
          commit.upgradeId === plan.upgradeId &&
          commit.planFingerprint === plan.planFingerprint &&
          same(commit.target, plan.request.target) &&
          same(commit.sourceHeads, plan.sourceHeads),
        'migration_commit_mismatch',
      )
      decode('UpgradeExpectedHeads', commit.committedHeads)
      requireMigration(commit.directoryHeads.kind === 'directory', 'head_kind_mismatch')
      decode('UpgradeExpectedHeads', commit.directoryHeads)
      const after = commit.committedHeads,
        before = plan.sourceHeads,
        target = plan.request.target
      requireMigration(after.kind === target.kind, 'head_kind_mismatch')
      if (after.kind === 'run-state' && before.kind === 'run-state' && target.kind === 'run-state')
        requireMigration(
          after.runId === before.runId &&
            after.bindingId === target.targetBindingId &&
            after.runRevision > before.runRevision &&
            after.writerEpoch > before.writerEpoch &&
            same(after.authority, before.authority),
          'migration_target_mismatch',
        )
      if (after.kind === 'state-authority' && before.kind === 'state-authority')
        requireMigration(
          after.authority.authorityId === before.authority.authorityId &&
            after.authority.tenantId === before.authority.tenantId &&
            after.authority.authorityEpoch > before.authority.authorityEpoch &&
            after.routeRevision > before.routeRevision &&
            after.cohortDigest === before.cohortDigest &&
            after.checkpoints.length > 0,
          'migration_target_mismatch',
        )
      if (after.kind === 'directory' && before.kind === 'directory')
        requireMigration(
          after.locatorId === before.locatorId &&
            after.locatorRevision > before.locatorRevision &&
            after.directoryEpoch > before.directoryEpoch &&
            same(after, commit.directoryHeads),
          'migration_target_mismatch',
        )
      requireMigration(
        commit.candidateRef.schema.typeId === 'agh.migration/candidate@1' &&
          commit.validationRef.schema.typeId === 'agh.migration/validation@1' &&
          !same(commit.candidateRef, commit.validationRef),
        'migration_evidence_type_invalid',
        'invalid_input',
      )
    })
    if (!validCommit.ok) return validCommit
    const candidateData = await resolved(commit.candidateRef, port, context)
    if (!candidateData.ok) return candidateData
    const validationData = await resolved(commit.validationRef, port, context)
    if (!validationData.ok) return validationData
    const candidate = attempt(() => decode('MigrationCandidate', candidateData.value))
    if (!candidate.ok) return candidate
    const validation = attempt(() => decode('MigrationValidation', validationData.value))
    if (!validation.ok) return validation
    const content = await resolved(candidate.value.content, port, context)
    if (!content.ok) return content
    const issuers = await port.validationIssuers(plan, commit.validationRef, context)
    if (!issuers.ok) return issuers
    const checked = attempt(() => {
      const c = candidate.value,
        v = validation.value
      requireMigration(
        c.upgradeId === plan.upgradeId &&
          v.upgradeId === plan.upgradeId &&
          c.planFingerprint === plan.planFingerprint &&
          v.planFingerprint === plan.planFingerprint &&
          same(c.sourceHeads, plan.sourceHeads) &&
          c.sourceSnapshotDigest === commit.sourceSnapshotDigest &&
          v.sourceSnapshotDigest === c.sourceSnapshotDigest &&
          v.candidateDigest === hash(c) &&
          c.targetDigest === commit.targetDigest &&
          c.targetDigest === hash(content.value) &&
          plan.requiredPins.every((pin) => c.requiredPins.includes(pin)),
        'migration_validation_mismatch',
      )
      requireMigration(
        v.accepted &&
          v.checks.every((check) => check.passed) &&
          new Set(v.checks.map((check) => check.checkId)).size === v.checks.length &&
          Date.parse(v.checkedAt) <= Date.parse(decode('Timestamp', now)),
        'migration_validation_rejected',
      )
      const required = [
        ...Object.keys(plan.invariants).filter((key) => key !== 'additionalChecks'),
        ...plan.invariants.additionalChecks.map((check) => check.checkId),
      ]
      requireMigration(
        required.every((id) => v.checks.some((check) => check.checkId === id && check.passed)),
        'migration_checks_missing',
      )
      requireMigration(
        issuers.value.length > 0 &&
          same(issuers.value, v.validatorBindings) &&
          (!c.conversion ||
            !issuers.value.some((binding) => binding.bindingId === c.conversion?.migratorBinding.bindingId)),
        'validator_not_independent',
        'denied',
      )
      for (const binding of issuers.value) decode('BindingRef', binding)
      v.checks.forEach((check) => {
        verifyData(check.evidence)
        requireMigration(
          !same(check.evidence, commit.candidateRef) && !same(check.evidence, c.content),
          'validator_not_independent',
          'denied',
        )
      })
    })
    if (!checked.ok) return checked
    for (const check of validation.value.checks) {
      const proof = await resolved(check.evidence, port, context)
      if (!proof.ok) return proof
    }
    // Read current heads last, after evidence I/O; do not authorize a stale cached locator.
    const current = await port.currentHeads(plan.request.target, context)
    if (!current.ok) return current
    if (context.signal.aborted) return failure('migration_cancelled', 'cancelled')
    return attempt(() => {
      requireMigration(
        same(current.value.heads, commit.committedHeads) &&
          same(current.value.directory, commit.directoryHeads),
        'migration_heads_stale',
      )
      return Object.freeze({
        next: 'regenerate-release-plan' as const,
        approval: 'reverify' as const,
        commitRef: commit.commitRef,
      })
    })
  } catch {
    return failure('migration_evidence_unavailable', 'retryable')
  }
}
