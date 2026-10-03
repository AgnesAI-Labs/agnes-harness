import { jcs } from '@agnes/protocol'
import type {
  BindingRef,
  DataRef,
  JsonValue,
  MigrationCandidate,
  MigrationInvariants,
  MigrationPlan,
  MigrationReceipt,
  MigrationRequest,
  MigrationTarget,
  MigrationValidation,
  UpgradeExpectedHeads,
} from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import type { CallContext } from '../../../src/runtime/public-api.js'

export const MIGRATION_FIXTURE_NOW = '2026-10-03T00:00:00Z'
export const migrationFixtureDigest = (value: unknown) =>
  canonicalJsonDigest(JSON.parse(JSON.stringify(value)) as JsonValue)
export function migrationFixtureRef(value: unknown, typeId = 'fixture/migration@1'): DataRef {
  const json = JSON.parse(JSON.stringify(value)) as JsonValue
  return {
    kind: 'inline',
    schema: { typeId, revision: 1, digest: migrationFixtureDigest(typeId) },
    value: json,
    digest: migrationFixtureDigest(json),
    bytes: Buffer.byteLength(jcs(json)),
  }
}
export function migrationContractContext(): CallContext {
  return {
    signal: new AbortController().signal,
    principalRef: 'fixture-principal',
    bindingId: 'fixture-binding',
    invocationId: 'fixture-invocation',
    deadline: '2030-01-01T00:00:00Z',
    traceRef: 'fixture-trace',
    scope: { kind: 'runtime', installationId: 'fixture-installation', runtimeId: 'fixture-runtime' },
    authorizationRef: 'fixture-authorization',
  }
}
export function migrationFixture(
  kind: MigrationTarget['kind'] = 'run-state',
  mode: MigrationRequest['mode'] = 'explicit',
) {
  const authority = { authorityId: 'state', tenantId: 'synthetic-tenant', authorityEpoch: 2 }
  const cohort = migrationFixtureRef(['state', 'budget'])
  const checkpoint = {
    authorityId: 'state',
    authorityEpoch: 2,
    checkpointId: 'checkpoint',
    snapshotDigest: migrationFixtureDigest('snapshot'),
    recordCount: 4,
    bridgeWatermarks: [],
  }
  const target: MigrationTarget =
    kind === 'run-state'
      ? { kind, runId: 'run', sourceBindingId: 'old-binding', targetBindingId: 'new-binding' }
      : kind === 'directory'
        ? {
            kind,
            sourceLocatorRevision: 3,
            targetProviderLock: migrationFixtureRef('target-lock'),
            targetLocationRef: 'target-location',
            externalJournalRef: 'external-journal',
          }
        : {
            kind,
            source: authority,
            targetProviderLock: migrationFixtureRef('target-lock'),
            targetLocationRef: 'target-location',
            cohortRef: cohort,
          }
  const sourceHeads: UpgradeExpectedHeads =
    kind === 'run-state'
      ? { kind, runId: 'run', runRevision: 4, writerEpoch: 2, bindingId: 'old-binding', authority }
      : kind === 'directory'
        ? { kind, locatorId: 'directory', locatorRevision: 3, directoryEpoch: 2 }
        : {
            kind,
            authority,
            routeRevision: 3,
            cohortDigest: cohort.kind === 'inline' ? cohort.digest : cohort.blob.digest,
            checkpoints: [checkpoint],
          }
  const request: MigrationRequest = {
    upgradeId: 'upgrade',
    target,
    policyRef: 'policy',
    reason: 'Upgrade the synthetic installation',
    mode,
  }
  const invariants: MigrationInvariants = {
    publicFacts: 'identical',
    effectIdentity: 'identical',
    accounting: 'identical',
    pendingOwnership: 'preserved-or-explicit-alias',
    unconsumedSignals: 'preserved',
    deletionAndRevocation: 'current',
    lineage: 'identical',
    additionalChecks: [],
  }
  const snapshot = {
    planId: 'migration-plan',
    sourceHeads,
    sourceLocks: [migrationFixtureRef('source-lock')],
    migratorLock: migrationFixtureRef('migrator'),
    validatorLocks: [migrationFixtureRef('validator')],
    targetCapabilities: ['read-state', 'maintenance'],
    policy: migrationFixtureRef('policy-snapshot'),
    invariants,
    requiredPins: ['old-pin', 'new-pin'],
    resourceBudgetRef: 'resource-budget',
    expiresAt: '2026-10-04T00:00:00Z',
    facts: {
      integrity: true,
      authorityKnown: true,
      targetTrusted: true,
      permissionCompatible: true,
      referencesCompatible: true,
      resourcesRecoverable: true,
      capacityAvailable: true,
      sourceRecoverable: true,
      exactMigrator: true,
      autoAuthorized: true,
      explicitAuthorized: true,
      drained: true,
      inflight: false,
      unknown: false,
      attachedChild: false,
      callbackProof: true,
      debtProof: true,
      intakeProof: true,
      fenceCapable: true,
      cohortComplete: true,
      jointQualification: true,
      terminal: false,
      readerOnly: false,
      pending: (['answer', 'action', 'signal', 'job'] as const).map((kind) => ({
        kind,
        id: `original-${kind}`,
        bindingId: 'old-binding',
        pinId: `old-${kind}-pin`,
        identityPreserved: true,
        bindingPreserved: true,
        pinPreserved: true,
        semanticsPreserved: true,
      })),
    },
  }
  return { request, snapshot }
}
export function migrationCompletedFixture(plan: MigrationPlan) {
  const content = migrationFixtureRef({ continuation: 'same-public-facts' })
  const candidate: MigrationCandidate = {
    upgradeId: plan.upgradeId,
    planFingerprint: plan.planFingerprint,
    sourceHeads: plan.sourceHeads,
    sourceSnapshotDigest: migrationFixtureDigest('source-snapshot'),
    targetDigest: content.kind === 'inline' ? content.digest : content.blob.digest,
    conversion: null,
    content,
    requiredPins: plan.requiredPins,
  }
  const issuer: BindingRef = {
    bindingId: 'validator-binding',
    contract: 'agh.migration',
    logicalName: 'validator',
    providerId: 'fixture-independent-validator',
  }
  const checks = [
    ...Object.keys(plan.invariants).filter((key) => key !== 'additionalChecks'),
    ...plan.invariants.additionalChecks.map((c) => c.checkId),
  ]
  const validation: MigrationValidation = {
    upgradeId: plan.upgradeId,
    planFingerprint: plan.planFingerprint,
    candidateDigest: migrationFixtureDigest(candidate),
    sourceSnapshotDigest: candidate.sourceSnapshotDigest,
    checkedAt: MIGRATION_FIXTURE_NOW,
    checks: checks.map((checkId) => ({
      checkId,
      passed: true,
      evidence: migrationFixtureRef({ checkId, proof: 'independently-checked' }),
    })),
    validatorBindings: [issuer],
    accepted: true,
  }
  const candidateRef = migrationFixtureRef(candidate, 'agh.migration/candidate@1'),
    validationRef = migrationFixtureRef(validation, 'agh.migration/validation@1')
  const before = plan.sourceHeads
  const committedHeads: UpgradeExpectedHeads =
    before.kind === 'run-state' && plan.request.target.kind === 'run-state'
      ? {
          ...before,
          runRevision: before.runRevision + 1,
          writerEpoch: before.writerEpoch + 1,
          bindingId: plan.request.target.targetBindingId,
        }
      : before.kind === 'state-authority'
        ? {
            ...before,
            authority: { ...before.authority, authorityEpoch: before.authority.authorityEpoch + 1 },
            routeRevision: before.routeRevision + 1,
          }
        : before.kind === 'directory'
          ? {
              ...before,
              locatorRevision: before.locatorRevision + 1,
              directoryEpoch: before.directoryEpoch + 1,
            }
          : before
  const directoryHeads: Extract<UpgradeExpectedHeads, { kind: 'directory' }> =
    committedHeads.kind === 'directory'
      ? committedHeads
      : { kind: 'directory', locatorId: 'directory', locatorRevision: 4, directoryEpoch: 3 }
  const receipt: MigrationReceipt = {
    upgradeId: plan.upgradeId,
    state: 'completed',
    checkpointRevision: 7,
    cutoverId: 'actual-cutover',
    commitRef: 'actual-commit',
    diagnosticIds: [],
  }
  const commit = {
    upgradeId: plan.upgradeId,
    planFingerprint: plan.planFingerprint,
    commitRef: 'actual-commit',
    cutoverId: 'actual-cutover',
    checkpointRevision: 7,
    target: plan.request.target,
    sourceHeads: plan.sourceHeads,
    committedHeads,
    directoryHeads,
    sourceSnapshotDigest: candidate.sourceSnapshotDigest,
    targetDigest: candidate.targetDigest,
    candidateRef,
    validationRef,
    completed: true,
  }
  return { receipt, commit, candidate, validation, issuer }
}
