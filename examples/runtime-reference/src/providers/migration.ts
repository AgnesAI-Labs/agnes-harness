import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type {
  DataRef,
  MigrationInvariants,
  MigrationPlan,
  MigrationRequest,
  RuntimeError,
  RuntimeWireTypes,
  UpgradeExpectedHeads,
} from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'

type FactKey =
  | 'integrity'
  | 'authorityKnown'
  | 'targetTrusted'
  | 'permissionCompatible'
  | 'referencesCompatible'
  | 'resourcesRecoverable'
  | 'capacityAvailable'
  | 'sourceRecoverable'
  | 'exactMigrator'
  | 'autoAuthorized'
  | 'explicitAuthorized'
  | 'drained'
  | 'inflight'
  | 'unknown'
  | 'attachedChild'
  | 'callbackProof'
  | 'debtProof'
  | 'intakeProof'
  | 'fenceCapable'
  | 'cohortComplete'
  | 'jointQualification'
  | 'terminal'
  | 'readerOnly'
export type ReferenceMigrationFacts = Readonly<Record<FactKey, boolean>> & {
  readonly pending: readonly {
    readonly id: string
    readonly kind: 'answer' | 'action' | 'signal' | 'job'
    readonly bindingId: string
    readonly pinId: string
    readonly identityPreserved: boolean
    readonly bindingPreserved: boolean
    readonly pinPreserved: boolean
    readonly semanticsPreserved: boolean
  }[]
}
export interface ReferenceMigrationSnapshot {
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
  readonly facts: ReferenceMigrationFacts
}
export interface ReferencePlanningPorts {
  authorize(request: MigrationRequest, context: CallContext): Promise<Outcome<void>>
  existingPlan(upgradeId: string, context: CallContext): Promise<Outcome<MigrationPlan | null>>
  snapshot(request: MigrationRequest, context: CallContext): Promise<Outcome<ReferenceMigrationSnapshot>>
}
export class ReferenceMigrationError extends Error {
  constructor(
    readonly reason: string,
    readonly category: RuntimeError['code'] = 'conflict',
  ) {
    super(reason)
  }
}
export const refuseMigration = (
  detailCode: string,
  code: RuntimeError['code'] = 'conflict',
): Outcome<never> => ({
  ok: false,
  error: {
    code,
    detailCode,
    message: `Reference migration refused: ${detailCode}`,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'reference-migration',
  },
})
export function readMigration<K extends keyof RuntimeWireTypes>(
  name: K,
  input: unknown,
): RuntimeWireTypes[K] {
  const outcome = validateRuntime(name, input)
  if (outcome.ok) return outcome.value
  throw new ReferenceMigrationError('schema_invalid', 'invalid_input')
}
export const referenceHash = (input: unknown) => canonicalJsonDigest(readMigration('JsonValue', input))
export const equivalent = (a: unknown, b: unknown) => referenceHash(a) === referenceHash(b)
export function checkMigration(
  ok: unknown,
  reason: string,
  category: RuntimeError['code'] = 'conflict',
): asserts ok {
  if (!ok) throw new ReferenceMigrationError(reason, category)
}
export function captureMigration<T>(compute: () => T): Outcome<T> {
  try {
    return { ok: true, value: compute() }
  } catch (caught) {
    return caught instanceof ReferenceMigrationError
      ? refuseMigration(caught.reason, caught.category)
      : refuseMigration('schema_invalid', 'invalid_input')
  }
}
function seal<T>(input: T): T {
  if (input && typeof input === 'object' && !Object.isFrozen(input)) {
    for (const child of Object.values(input)) seal(child)
    Object.freeze(input)
  }
  return input
}
export function checkReferenceData(input: DataRef) {
  const data = readMigration('DataRef', input)
  if (data.kind === 'inline')
    checkMigration(
      data.digest === referenceHash(data.value) && data.bytes === Buffer.byteLength(jcs(data.value)),
      'content_identity_mismatch',
    )
}
export function referencePlanFingerprint(input: MigrationPlan) {
  const copy = { ...readMigration('MigrationPlan', input) }
  return referenceHash(Object.fromEntries(Object.entries(copy).filter(([key]) => key !== 'planFingerprint')))
}
export function referenceTargetHeads(request: MigrationRequest, head: UpgradeExpectedHeads) {
  const destination = request.target
  checkMigration(head.kind === destination.kind, 'head_kind_mismatch', 'invalid_input')
  switch (head.kind) {
    case 'run-state':
      checkMigration(
        destination.kind === 'run-state' &&
          head.runId === destination.runId &&
          head.bindingId === destination.sourceBindingId,
        'source_heads_stale',
      )
      break
    case 'directory':
      checkMigration(
        destination.kind === 'directory' && head.locatorRevision === destination.sourceLocatorRevision,
        'source_heads_stale',
      )
      break
    case 'state-authority': {
      checkMigration(
        destination.kind === 'state-authority' && equivalent(head.authority, destination.source),
        'source_heads_stale',
      )
      if (destination.kind !== 'state-authority') break
      const cohort = destination.cohortRef
      checkMigration(
        head.checkpoints.length &&
          head.cohortDigest === (cohort.kind === 'blob' ? cohort.blob.digest : cohort.digest),
        'cohort_head_mismatch',
      )
      break
    }
  }
}

export function referenceEligibility(
  request: MigrationRequest,
  facts: ReferenceMigrationFacts,
): Pick<MigrationPlan, 'eligibility' | 'reasonCodes'> {
  const obligations: [FactKey, string][] = [
    ['integrity', 'source_integrity'],
    ['authorityKnown', 'authority_unavailable'],
    ['targetTrusted', 'binding_unavailable'],
    ['permissionCompatible', 'permission_incompatible'],
    ['referencesCompatible', 'references_incompatible'],
    ['resourcesRecoverable', 'resources_unrecoverable'],
    ['capacityAvailable', 'capacity_unavailable'],
  ]
  if (request.mode === 'explicit') obligations.push(['explicitAuthorized', 'explicit_unapproved'])
  if (request.mode === 'auto-compatible') obligations.push(['autoAuthorized', 'auto_scope_unapproved'])
  if (request.target.kind !== 'run-state')
    obligations.push(
      ['callbackProof', 'callback_proof_missing'],
      ['debtProof', 'debt_proof_missing'],
      ['intakeProof', 'intake_proof_missing'],
      ['fenceCapable', 'fence_unavailable'],
      ['cohortComplete', 'cohort_incomplete'],
      ['jointQualification', 'joint_dispatch_incompatible'],
    )
  const denied = obligations.filter(([key]) => facts[key] !== true).map(([, reason]) => reason)
  const preserves = facts.pending.every(
    (p) =>
      Boolean(p.id && p.bindingId && p.pinId) &&
      [p.identityPreserved, p.bindingPreserved, p.pinPreserved, p.semanticsPreserved].every(
        (value) => value === true,
      ),
  )
  if (!preserves) denied.push('pending_identity_unpreserved')
  if (facts.terminal && !facts.readerOnly) denied.push('terminal_execution_forbidden')
  if (denied.length) return { eligibility: 'blocked', reasonCodes: denied.sort() }
  const unsettled =
    request.target.kind === 'run-state'
      ? (['unknown', 'inflight', 'attachedChild'] as const)
          .filter((key) => facts[key] !== false)
          .map(
            (key) =>
              ({ unknown: 'unknown_effect', inflight: 'inflight_action', attachedChild: 'attached_child' })[
                key
              ],
          )
      : []
  if (facts.drained !== true) unsettled.push('drain_incomplete')
  if (unsettled.length) return { eligibility: 'wait-safe-point', reasonCodes: unsettled.sort() }
  if (request.target.kind === 'run-state' && facts.exactMigrator !== true)
    return {
      eligibility: facts.sourceRecoverable === true ? 'retain-source' : 'blocked',
      reasonCodes: ['migrator_unavailable'],
    }
  return { eligibility: 'eligible', reasonCodes: [] }
}
export function constructReferenceMigrationPlan(
  raw: unknown,
  view: ReferenceMigrationSnapshot,
  clock: string,
): Outcome<MigrationPlan> {
  return captureMigration(() => {
    const command = readMigration('MigrationRequest', raw),
      input = structuredClone(view)
    referenceTargetHeads(command, readMigration('UpgradeExpectedHeads', input.sourceHeads))
    checkMigration(
      Date.parse(readMigration('Timestamp', input.expiresAt)) > Date.parse(readMigration('Timestamp', clock)),
      'plan_stale',
    )
    checkMigration(input.validatorLocks.length && input.sourceLocks.length, 'locks_missing', 'incompatible')
    const material = [input.policy, input.migratorLock, ...input.sourceLocks, ...input.validatorLocks]
    if (command.target.kind !== 'run-state') material.push(command.target.targetProviderLock)
    if (command.target.kind === 'state-authority') material.push(command.target.cohortRef)
    material.forEach(checkReferenceData)
    checkMigration(
      input.validatorLocks.every((v) => !equivalent(v, input.migratorLock)),
      'validator_not_independent',
      'denied',
    )
    const invariants = readMigration('MigrationInvariants', input.invariants)
    const names = invariants.additionalChecks.map((c) => c.checkId)
    checkMigration(
      names.every((name) => name !== 'migration.policy' && !name.startsWith('migration.source-lock.')),
      'reserved_check',
      'invalid_input',
    )
    checkMigration(new Set(names).size === names.length, 'duplicate_check', 'invalid_input')
    for (const assertion of invariants.additionalChecks) {
      checkReferenceData(assertion.expected)
      checkMigration(
        equivalent(assertion.schema, assertion.expected.schema),
        'check_schema_mismatch',
        'invalid_input',
      )
    }
    const proposed = {
      ...referenceEligibility(command, input.facts),
      planId: input.planId,
      upgradeId: command.upgradeId,
      request: command,
      sourceHeads: input.sourceHeads,
      migratorLock: input.migratorLock,
      validatorLocks: input.validatorLocks,
      requiredPins: Array.from(
        new Set(input.requiredPins.concat(input.facts.pending.map((p) => p.pinId))),
      ).sort(),
      requiredCapabilities: Array.from(new Set(input.targetCapabilities)).sort(),
      invariants: {
        ...invariants,
        additionalChecks: [
          ...invariants.additionalChecks,
          ...input.sourceLocks.map((ref, n) => ({
            checkId: `migration.source-lock.${n}`,
            schema: ref.schema,
            expected: ref,
          })),
          { expected: input.policy, schema: input.policy.schema, checkId: 'migration.policy' },
        ],
      },
      resourceBudgetRef: input.resourceBudgetRef,
      expiresAt: input.expiresAt,
    }
    return seal(readMigration('MigrationPlan', { ...proposed, planFingerprint: referenceHash(proposed) }))
  })
}
export function createReferenceMigrationProvider(
  ports?: ReferencePlanningPorts,
  clock = () => new Date().toISOString(),
) {
  const memo = new Map<string, MigrationPlan>()
  let closed = false
  const unsupported = async (method: string, context: CallContext): Promise<Outcome<never>> =>
    context.signal.aborted
      ? refuseMigration('migration_cancelled', 'cancelled')
      : refuseMigration(`migration_${method}_unsupported`, 'incompatible')
  return {
    providerId: 'agh.reference/migration',
    contract: 'agh.migration',
    implemented: Object.freeze(['inspect']),
    incomplete: Object.freeze(['prepare', 'validate', 'cutover', 'probe', 'abort', 'cold-recovery']),
    async inspect(raw: unknown, context: CallContext): Promise<Outcome<MigrationPlan>> {
      if (closed) return refuseMigration('migration_disposed', 'denied')
      if (context.signal.aborted) return refuseMigration('migration_cancelled', 'cancelled')
      if (!ports) return refuseMigration('planning_ports_unavailable', 'incompatible')
      const decoded = captureMigration(() => readMigration('MigrationRequest', raw))
      if (!decoded.ok) return decoded
      const command = decoded.value
      try {
        const permission = await ports.authorize(command, context)
        if (!permission.ok) return permission
        const view = await ports.snapshot(command, context)
        if (!view.ok) return view
        const next = constructReferenceMigrationPlan(command, view.value, clock())
        if (!next.ok) return next
        const durable = await ports.existingPlan(command.upgradeId, context)
        if (!durable.ok) return durable
        if (context.signal.aborted) return refuseMigration('migration_cancelled', 'cancelled')
        if (closed) return refuseMigration('migration_disposed', 'denied')
        const comparison = captureMigration(() => {
          ;[durable.value, memo.get(command.upgradeId)].filter(Boolean).forEach((prior) => {
            if (!prior) return
            checkMigration(
              referencePlanFingerprint(prior) === prior.planFingerprint,
              'plan_fingerprint_mismatch',
            )
            checkMigration(
              equivalent(prior.sourceHeads, next.value.sourceHeads) &&
                Date.parse(prior.expiresAt) > Date.parse(clock()),
              'plan_stale',
            )
            checkMigration(
              prior.planFingerprint === next.value.planFingerprint,
              'upgrade_fingerprint_conflict',
            )
          })
        })
        if (!comparison.ok) return comparison
        memo.set(command.upgradeId, next.value)
        return next
      } catch {
        return refuseMigration('planning_evidence_unavailable', 'retryable')
      }
    },
    prepare: (_r: unknown, c: CallContext) => unsupported('prepare', c),
    validate: (_r: unknown, c: CallContext) => unsupported('validate', c),
    cutover: (_r: unknown, c: CallContext) => unsupported('cutover', c),
    probe: (_r: unknown, c: CallContext) => unsupported('probe', c),
    abort: (_r: unknown, c: CallContext) => unsupported('abort', c),
    async dispose() {
      closed = true
      memo.clear()
    },
  }
}
