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
import {
  captureMigration,
  checkMigration,
  checkReferenceData,
  equivalent,
  readMigration,
  referenceHash,
  referencePlanFingerprint,
  referenceTargetHeads,
  refuseMigration,
} from './migration.js'

type DirectoryPosition = Extract<UpgradeExpectedHeads, { kind: 'directory' }>
export interface ReferenceCommitProof {
  readonly upgradeId: string
  readonly planFingerprint: string
  readonly commitRef: string
  readonly cutoverId: string
  readonly checkpointRevision: number
  readonly target: MigrationTarget
  readonly sourceHeads: UpgradeExpectedHeads
  readonly committedHeads: UpgradeExpectedHeads
  readonly directoryHeads: DirectoryPosition
  readonly sourceSnapshotDigest: string
  readonly targetDigest: string
  readonly candidateRef: DataRef
  readonly validationRef: DataRef
  readonly completed: boolean
}
export interface ReferenceEvidenceReader {
  authorize(plan: MigrationPlan, call: CallContext): Promise<Outcome<void>>
  probe(id: string, call: CallContext): Promise<Outcome<ReferenceCommitProof | null>>
  currentHeads(
    target: MigrationTarget,
    call: CallContext,
  ): Promise<Outcome<{ readonly heads: UpgradeExpectedHeads; readonly directory: DirectoryPosition }>>
  readData(ref: DataRef, call: CallContext): Promise<Outcome<JsonValue>>
  validationIssuers(
    plan: MigrationPlan,
    ref: DataRef,
    call: CallContext,
  ): Promise<Outcome<readonly BindingRef[]>>
}
type Readers = Partial<Record<MigrationTarget['kind'], ReferenceEvidenceReader>>

async function loadProof(
  ref: DataRef,
  reader: ReferenceEvidenceReader,
  call: CallContext,
): Promise<Outcome<JsonValue>> {
  const valid = captureMigration(() => checkReferenceData(ref))
  if (!valid.ok) return valid
  const fetched = await reader.readData(ref, call)
  if (!fetched.ok) return fetched
  return captureMigration(() => {
    const content = readMigration('JsonValue', fetched.value)
    checkMigration(
      Buffer.byteLength(jcs(content)) === (ref.kind === 'blob' ? ref.blob.bytes : ref.bytes),
      'content_identity_mismatch',
    )
    checkMigration(
      referenceHash(content) === (ref.kind === 'blob' ? ref.blob.digest : ref.digest),
      'content_identity_mismatch',
    )
    checkMigration(ref.kind !== 'inline' || equivalent(content, ref.value), 'content_identity_mismatch')
    return content
  })
}

export async function verifyReferenceMigrationReceipt(
  planInput: unknown,
  receiptInput: unknown,
  readers: Readers,
  call: CallContext,
  clock = new Date().toISOString(),
): Promise<
  Outcome<{
    readonly next: 'regenerate-release-plan'
    readonly approval: 'reverify'
    readonly commitRef: string
  }>
> {
  if (call.signal.aborted) return refuseMigration('migration_cancelled', 'cancelled')
  const decode = captureMigration(() => {
    const plan = structuredClone(readMigration('MigrationPlan', planInput)),
      receipt = structuredClone(readMigration('MigrationReceipt', receiptInput))
    checkMigration(
      plan.request.upgradeId === plan.upgradeId && referencePlanFingerprint(plan) === plan.planFingerprint,
      'plan_fingerprint_mismatch',
    )
    referenceTargetHeads(plan.request, plan.sourceHeads)
    checkMigration(plan.request.mode !== 'inspect-only', 'inspect_only_plan')
    checkMigration(plan.eligibility === 'eligible', 'migration_ineligible')
    checkMigration(
      receipt.state === 'completed' &&
        receipt.upgradeId === plan.upgradeId &&
        receipt.commitRef &&
        receipt.cutoverId,
      'prerequisite_migration_incomplete',
    )
    return { plan, receipt }
  })
  if (!decode.ok) return decode
  const { plan, receipt } = decode.value,
    reader = readers[plan.request.target.kind]
  if (!reader) return refuseMigration('migration_evidence_unavailable', 'incompatible')
  try {
    const permit = await reader.authorize(plan, call)
    if (!permit.ok) return permit
    const probed = await reader.probe(plan.upgradeId, call)
    if (!probed.ok) return probed
    if (!probed.value) return refuseMigration('prerequisite_migration_incomplete')
    const p = structuredClone(probed.value)
    const commit = captureMigration(() => {
      checkMigration(p.completed === true, 'prerequisite_migration_incomplete')
      const pairs = [
        [p.upgradeId, plan.upgradeId],
        [p.planFingerprint, plan.planFingerprint],
        [p.commitRef, receipt.commitRef],
        [p.cutoverId, receipt.cutoverId],
        [p.checkpointRevision, receipt.checkpointRevision],
        [p.target, plan.request.target],
        [p.sourceHeads, plan.sourceHeads],
      ]
      checkMigration(
        pairs.every(([a, b]) => equivalent(a, b)),
        'migration_commit_mismatch',
      )
      const head = readMigration('UpgradeExpectedHeads', p.committedHeads)
      checkMigration(p.directoryHeads.kind === 'directory', 'head_kind_mismatch')
      readMigration('UpgradeExpectedHeads', p.directoryHeads)
      checkMigration(head.kind === plan.request.target.kind, 'head_kind_mismatch')
      let moved = false
      switch (head.kind) {
        case 'run-state': {
          const old = plan.sourceHeads,
            dest = plan.request.target
          moved =
            old.kind === 'run-state' &&
            dest.kind === 'run-state' &&
            head.runId === old.runId &&
            head.bindingId === dest.targetBindingId &&
            head.runRevision > old.runRevision &&
            head.writerEpoch > old.writerEpoch &&
            equivalent(head.authority, old.authority)
          break
        }
        case 'directory': {
          const old = plan.sourceHeads
          moved =
            old.kind === 'directory' &&
            head.locatorId === old.locatorId &&
            head.locatorRevision > old.locatorRevision &&
            head.directoryEpoch > old.directoryEpoch &&
            equivalent(head, p.directoryHeads)
          break
        }
        case 'state-authority': {
          const old = plan.sourceHeads
          moved =
            old.kind === 'state-authority' &&
            head.authority.authorityId === old.authority.authorityId &&
            head.authority.tenantId === old.authority.tenantId &&
            head.authority.authorityEpoch > old.authority.authorityEpoch &&
            head.routeRevision > old.routeRevision &&
            head.cohortDigest === old.cohortDigest &&
            head.checkpoints.length > 0
          break
        }
      }
      checkMigration(moved, 'migration_target_mismatch')
      checkMigration(
        p.candidateRef.schema.typeId === 'agh.migration/candidate@1' &&
          p.validationRef.schema.typeId === 'agh.migration/validation@1' &&
          !equivalent(p.candidateRef, p.validationRef),
        'migration_evidence_type_invalid',
        'invalid_input',
      )
    })
    if (!commit.ok) return commit
    const loadedCandidate = await loadProof(p.candidateRef, reader, call)
    if (!loadedCandidate.ok) return loadedCandidate
    const loadedValidation = await loadProof(p.validationRef, reader, call)
    if (!loadedValidation.ok) return loadedValidation
    const structs = captureMigration(() => ({
      candidate: readMigration('MigrationCandidate', loadedCandidate.value),
      validation: readMigration('MigrationValidation', loadedValidation.value),
    }))
    if (!structs.ok) return structs
    const { candidate: c, validation: v } = structs.value
    const contents = await loadProof(c.content, reader, call)
    if (!contents.ok) return contents
    const signed = await reader.validationIssuers(plan, p.validationRef, call)
    if (!signed.ok) return signed
    const valid = captureMigration(() => {
      checkMigration(
        c.upgradeId === plan.upgradeId &&
          v.upgradeId === plan.upgradeId &&
          c.planFingerprint === plan.planFingerprint &&
          v.planFingerprint === plan.planFingerprint &&
          equivalent(c.sourceHeads, plan.sourceHeads) &&
          c.sourceSnapshotDigest === p.sourceSnapshotDigest &&
          v.sourceSnapshotDigest === c.sourceSnapshotDigest &&
          v.candidateDigest === referenceHash(c) &&
          c.targetDigest === p.targetDigest &&
          c.targetDigest === referenceHash(contents.value) &&
          plan.requiredPins.every((pin) => c.requiredPins.includes(pin)),
        'migration_validation_mismatch',
      )
      const ids = v.checks.map((test) => test.checkId)
      checkMigration(
        v.accepted &&
          v.checks.every((test) => test.passed) &&
          new Set(ids).size === ids.length &&
          Date.parse(v.checkedAt) <= Date.parse(readMigration('Timestamp', clock)),
        'migration_validation_rejected',
      )
      const standards = Object.entries(plan.invariants)
        .filter(([name]) => name !== 'additionalChecks')
        .map(([name]) => name)
      checkMigration(
        standards
          .concat(plan.invariants.additionalChecks.map((test) => test.checkId))
          .every((id) => ids.includes(id)),
        'migration_checks_missing',
      )
      checkMigration(
        signed.value.length &&
          equivalent(signed.value, v.validatorBindings) &&
          signed.value.every(
            (issuer) => c.conversion === null || issuer.bindingId !== c.conversion.migratorBinding.bindingId,
          ),
        'validator_not_independent',
        'denied',
      )
      for (const author of signed.value) readMigration('BindingRef', author)
      for (const test of v.checks) {
        checkReferenceData(test.evidence)
        checkMigration(
          !equivalent(test.evidence, p.candidateRef) && !equivalent(test.evidence, c.content),
          'validator_not_independent',
          'denied',
        )
      }
    })
    if (!valid.ok) return valid
    for (const assertion of v.checks) {
      const checkedEvidence = await loadProof(assertion.evidence, reader, call)
      if (!checkedEvidence.ok) return checkedEvidence
    }
    const latest = await reader.currentHeads(plan.request.target, call)
    if (!latest.ok) return latest
    if (call.signal.aborted) return refuseMigration('migration_cancelled', 'cancelled')
    return captureMigration(() => {
      checkMigration(
        equivalent(latest.value.heads, p.committedHeads) &&
          equivalent(latest.value.directory, p.directoryHeads),
        'migration_heads_stale',
      )
      return Object.freeze({
        next: 'regenerate-release-plan',
        approval: 'reverify',
        commitRef: p.commitRef,
      } as const)
    })
  } catch {
    return refuseMigration('migration_evidence_unavailable', 'retryable')
  }
}
