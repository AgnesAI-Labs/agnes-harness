import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  DataRef,
  MigrationInvariants,
  MigrationPlan,
  MigrationRequest,
  UpgradeExpectedHeads,
} from '@agnes/protocol/runtime'
import { type MigrationEligibilityFacts, migrationEligibility } from './eligibility.js'
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

export interface MigrationPlanningSnapshot {
  readonly planId: string
  readonly sourceHeads: UpgradeExpectedHeads
  readonly sourceLocks: readonly DataRef[]
  readonly migratorLock: DataRef
  readonly validatorLocks: readonly DataRef[]
  readonly targetCapabilities: readonly string[]
  readonly policy: DataRef
  readonly invariants: MigrationInvariants
  readonly requiredPins: readonly string[]
  readonly resourceBudgetRef: string
  readonly expiresAt: string
  readonly facts: MigrationEligibilityFacts
}
export interface MigrationPlanningPorts {
  authorize(request: MigrationRequest, context: CallContext): Promise<Outcome<void>>
  snapshot(request: MigrationRequest, context: CallContext): Promise<Outcome<MigrationPlanningSnapshot>>
  existingPlan(upgradeId: string, context: CallContext): Promise<Outcome<MigrationPlan | null>>
}
export function migrationPlanFingerprint(plan: MigrationPlan): string {
  const { planFingerprint: _identity, ...content } = decode('MigrationPlan', plan)
  return hash(content)
}
export function assertTargetHeads(request: MigrationRequest, heads: UpgradeExpectedHeads): void {
  const target = request.target
  requireMigration(target.kind === heads.kind, 'head_kind_mismatch', 'invalid_input')
  if (target.kind === 'run-state' && heads.kind === 'run-state')
    requireMigration(
      target.runId === heads.runId && target.sourceBindingId === heads.bindingId,
      'source_heads_stale',
    )
  if (target.kind === 'state-authority' && heads.kind === 'state-authority') {
    requireMigration(same(target.source, heads.authority), 'source_heads_stale')
    const digest = target.cohortRef.kind === 'inline' ? target.cohortRef.digest : target.cohortRef.blob.digest
    requireMigration(digest === heads.cohortDigest && heads.checkpoints.length > 0, 'cohort_head_mismatch')
  }
  if (target.kind === 'directory' && heads.kind === 'directory')
    requireMigration(target.sourceLocatorRevision === heads.locatorRevision, 'source_heads_stale')
}
export function constructMigrationPlan(
  raw: unknown,
  input: MigrationPlanningSnapshot,
  now: string,
): Outcome<MigrationPlan> {
  return attempt(() => {
    const request = decode('MigrationRequest', raw)
    const snapshot = immutable(structuredClone(input))
    const heads = decode('UpgradeExpectedHeads', snapshot.sourceHeads)
    assertTargetHeads(request, heads)
    requireMigration(
      Date.parse(decode('Timestamp', snapshot.expiresAt)) > Date.parse(decode('Timestamp', now)),
      'plan_stale',
    )
    requireMigration(
      snapshot.sourceLocks.length > 0 && snapshot.validatorLocks.length > 0,
      'locks_missing',
      'incompatible',
    )
    const refs = [...snapshot.sourceLocks, snapshot.migratorLock, ...snapshot.validatorLocks, snapshot.policy]
    if (request.target.kind !== 'run-state') refs.push(request.target.targetProviderLock)
    if (request.target.kind === 'state-authority') refs.push(request.target.cohortRef)
    refs.forEach(verifyData)
    requireMigration(
      !snapshot.validatorLocks.some((lock) => same(lock, snapshot.migratorLock)),
      'validator_not_independent',
      'denied',
    )
    const invariants = decode('MigrationInvariants', snapshot.invariants)
    requireMigration(
      !invariants.additionalChecks.some(
        (check) => check.checkId === 'migration.policy' || check.checkId.startsWith('migration.source-lock.'),
      ),
      'reserved_check',
      'invalid_input',
    )
    requireMigration(
      new Set(invariants.additionalChecks.map((check) => check.checkId)).size ===
        invariants.additionalChecks.length,
      'duplicate_check',
      'invalid_input',
    )
    for (const check of invariants.additionalChecks) {
      verifyData(check.expected)
      requireMigration(same(check.schema, check.expected.schema), 'check_schema_mismatch', 'invalid_input')
    }
    const result = migrationEligibility(request, snapshot.facts)
    const body = {
      planId: snapshot.planId,
      upgradeId: request.upgradeId,
      request,
      sourceHeads: heads,
      migratorLock: snapshot.migratorLock,
      validatorLocks: snapshot.validatorLocks,
      requiredPins: [
        ...new Set([...snapshot.requiredPins, ...snapshot.facts.pending.map((item) => item.pinId)]),
      ].sort(),
      requiredCapabilities: [...new Set(snapshot.targetCapabilities)].sort(),
      invariants: {
        ...invariants,
        additionalChecks: [
          ...invariants.additionalChecks,
          ...snapshot.sourceLocks.map((expected, index) => ({
            checkId: `migration.source-lock.${index}`,
            schema: expected.schema,
            expected,
          })),
          { checkId: 'migration.policy', schema: snapshot.policy.schema, expected: snapshot.policy },
        ],
      },
      resourceBudgetRef: snapshot.resourceBudgetRef,
      expiresAt: snapshot.expiresAt,
      ...result,
    }
    return immutable(decode('MigrationPlan', { ...body, planFingerprint: hash(body) }))
  })
}

/** Read-only planning. Durable registration belongs to the maintenance owner, not this cache. */
export function createMigrationPlanningController(
  ports?: MigrationPlanningPorts,
  now = () => new Date().toISOString(),
) {
  const seen = new Map<string, MigrationPlan>()
  let disposed = false
  return {
    async inspect(raw: unknown, context: CallContext): Promise<Outcome<MigrationPlan>> {
      if (disposed) return failure('migration_disposed', 'denied')
      if (context.signal.aborted) return failure('migration_cancelled', 'cancelled')
      if (!ports) return failure('planning_ports_unavailable', 'incompatible')
      const parsed = attempt(() => decode('MigrationRequest', raw))
      if (!parsed.ok) return parsed
      try {
        const authorized = await ports.authorize(parsed.value, context)
        if (!authorized.ok) return authorized
        const snapshot = await ports.snapshot(parsed.value, context)
        if (!snapshot.ok) return snapshot
        const plan = constructMigrationPlan(parsed.value, snapshot.value, now())
        if (!plan.ok) return plan
        const prior = await ports.existingPlan(parsed.value.upgradeId, context)
        if (!prior.ok) return prior
        if (context.signal.aborted) return failure('migration_cancelled', 'cancelled')
        if (disposed) return failure('migration_disposed', 'denied')
        for (const old of [prior.value, seen.get(parsed.value.upgradeId)]) {
          if (!old) continue
          const validated = attempt(() => {
            requireMigration(
              old.planFingerprint === migrationPlanFingerprint(old),
              'plan_fingerprint_mismatch',
            )
            requireMigration(
              same(old.sourceHeads, plan.value.sourceHeads) && Date.parse(old.expiresAt) > Date.parse(now()),
              'plan_stale',
            )
            requireMigration(
              old.planFingerprint === plan.value.planFingerprint,
              'upgrade_fingerprint_conflict',
            )
          })
          if (!validated.ok) return validated
        }
        seen.set(parsed.value.upgradeId, plan.value)
        return plan
      } catch {
        return failure('planning_evidence_unavailable', 'retryable')
      }
    },
    dispose() {
      disposed = true
      seen.clear()
    },
  }
}
