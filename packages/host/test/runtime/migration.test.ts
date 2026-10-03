import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Outcome } from '@agnes/extension-api/runtime'
import type { MigrationPlan } from '@agnes/protocol/runtime'
import { validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  constructReferenceMigrationPlan,
  createReferenceMigrationProvider,
} from '../../../../examples/runtime-reference/src/providers/migration.js'
import { verifyReferenceMigrationReceipt } from '../../../../examples/runtime-reference/src/providers/migration-evidence.js'
import {
  MIGRATION_FIXTURE_NOW,
  migrationCompletedFixture,
  migrationContractContext,
  migrationFixture,
  migrationFixtureDigest,
  migrationFixtureRef,
} from '../../../extension-api/testkit/runtime/contracts/migration-fixture.js'
import {
  constructMigrationPlan,
  type MigrationPlanningPorts,
  migrationPlanFingerprint,
} from '../../src/runtime/migration/controller.js'
import { migrationEligibility } from '../../src/runtime/migration/eligibility.js'
import { migrationPinRetention } from '../../src/runtime/migration/pin-retention.js'
import type { MigrationReceiptEvidencePort } from '../../src/runtime/migration/receipt-verification.js'
import { verifyMigrationReceipt } from '../../src/runtime/migration/receipt-verification.js'
import { createMigrationProvider } from '../../src/runtime/providers/migration.js'

const context = migrationContractContext
const factories = [createMigrationProvider, createReferenceMigrationProvider]
function value<T>(result: Outcome<T>): T {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.detailCode)
  return result.value
}
function refusal(result: Outcome<unknown>, detailCode: string) {
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.detailCode).toBe(detailCode)
}
function planning(
  fixture: ReturnType<typeof migrationFixture>,
  prior: MigrationPlan | null = null,
): MigrationPlanningPorts {
  return {
    authorize: async () => ({ ok: true, value: undefined }),
    snapshot: async () => ({ ok: true, value: structuredClone(fixture.snapshot) }),
    existingPlan: async () => ({ ok: true, value: prior }),
  }
}
function planFor(fixture = migrationFixture()) {
  return value(constructMigrationPlan(fixture.request, fixture.snapshot, MIGRATION_FIXTURE_NOW))
}
function evidence(fixture: ReturnType<typeof migrationCompletedFixture>): MigrationReceiptEvidencePort {
  return {
    authorize: async () => ({ ok: true, value: undefined }),
    probe: async () => ({ ok: true, value: structuredClone(fixture.commit) }),
    currentHeads: async () => ({
      ok: true,
      value: { heads: fixture.commit.committedHeads, directory: fixture.commit.directoryHeads },
    }),
    readData: async (ref) =>
      ref.kind === 'inline'
        ? { ok: true, value: ref.value }
        : {
            ok: false,
            error: {
              code: 'incompatible',
              detailCode: 'blob_unavailable',
              message: 'No fixture blob',
              diagnosticId: 'fixture',
              retryAdvice: { kind: 'never' },
            },
          },
    validationIssuers: async () => ({ ok: true, value: [fixture.issuer] }),
  }
}
function signCandidate(f: ReturnType<typeof migrationCompletedFixture>) {
  f.commit.candidateRef = migrationFixtureRef(f.candidate, 'agh.migration/candidate@1')
  f.validation.candidateDigest = migrationFixtureDigest(f.candidate)
  f.commit.validationRef = migrationFixtureRef(f.validation, 'agh.migration/validation@1')
}

describe('detached migration plans', () => {
  it('cross-checks all target and mode combinations with immutable public schemas', async () => {
    for (const kind of ['run-state', 'state-authority', 'directory'] as const)
      for (const mode of ['inspect-only', 'auto-compatible', 'explicit'] as const) {
        const fixture = migrationFixture(kind, mode)
        const left = value(constructMigrationPlan(fixture.request, fixture.snapshot, MIGRATION_FIXTURE_NOW))
        const right = value(
          constructReferenceMigrationPlan(fixture.request, fixture.snapshot, MIGRATION_FIXTURE_NOW),
        )
        expect(left).toEqual(right)
        expect(validateRuntime('MigrationPlan', left).ok).toBe(true)
        expect(migrationPlanFingerprint(left)).toBe(left.planFingerprint)
        expect(Object.isFrozen(left.request.target)).toBe(true)
        expect(left.requiredPins).toEqual(
          expect.arrayContaining(fixture.snapshot.facts.pending.map((p) => p.pinId)),
        )
      }
  })
  it('binds requests, source heads and locks, target capabilities, policy, invariants and pin requirements', () => {
    const base = migrationFixture(),
      fingerprint = planFor(base).planFingerprint
    const changes: ((f: ReturnType<typeof migrationFixture>) => void)[] = [
      (f) => {
        f.request.reason = 'different'
      },
      (f) => {
        f.request.mode = 'inspect-only'
      },
      (f) => {
        if (f.snapshot.sourceHeads.kind === 'run-state') f.snapshot.sourceHeads.runRevision++
      },
      (f) => {
        f.snapshot.sourceLocks = [migrationFixtureRef('another-source')]
      },
      (f) => {
        f.snapshot.migratorLock = migrationFixtureRef('another-migrator')
      },
      (f) => {
        f.snapshot.validatorLocks = [migrationFixtureRef('another-validator')]
      },
      (f) => {
        f.snapshot.targetCapabilities.push('another-capability')
      },
      (f) => {
        f.snapshot.policy = migrationFixtureRef('new-policy')
      },
      (f) => {
        f.snapshot.invariants.additionalChecks.push({
          checkId: 'extra',
          schema: migrationFixtureRef(1).schema,
          expected: migrationFixtureRef(1),
        })
      },
      (f) => {
        f.snapshot.requiredPins.push('extra-pin')
      },
      (f) => {
        f.snapshot.resourceBudgetRef = 'other-resource-budget'
      },
    ]
    for (const change of changes) {
      const changed = structuredClone(base)
      change(changed)
      const result = planFor(changed)
      expect(result.planFingerprint).not.toBe(fingerprint)
      expect(
        value(constructReferenceMigrationPlan(changed.request, changed.snapshot, MIGRATION_FIXTURE_NOW)),
      ).toEqual(result)
    }
  })
  it('requires new plans for stale heads and conflicts on changed inputs, including after a cold plan reload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'migration-plan-'))
    try {
      const fixture = migrationFixture(),
        initial = planFor(fixture)
      writeFileSync(join(root, 'plan.json'), JSON.stringify(initial))
      for (const create of factories) {
        const port = planning(fixture)
        const provider = create(port, () => MIGRATION_FIXTURE_NOW)
        expect(value(await provider.inspect(fixture.request, context()))).toEqual(initial)
        refusal(
          await provider.inspect({ ...fixture.request, reason: 'changed' }, context()),
          'upgrade_fingerprint_conflict',
        )
        if (fixture.snapshot.sourceHeads.kind === 'run-state') fixture.snapshot.sourceHeads.runRevision++
        refusal(await provider.inspect(fixture.request, context()), 'plan_stale')
        const prior = JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')) as MigrationPlan
        const reopened = create(planning(fixture, prior), () => MIGRATION_FIXTURE_NOW)
        refusal(await reopened.inspect(fixture.request, context()), 'plan_stale')
        const fresh = structuredClone(fixture)
        fresh.request.upgradeId = 'new-upgrade'
        fresh.snapshot.planId = 'new-plan'
        expect(
          value(await create(planning(fresh), () => MIGRATION_FIXTURE_NOW).inspect(fresh.request, context()))
            .planId,
        ).toBe('new-plan')
        await provider.dispose()
        await reopened.dispose()
        fixture.snapshot = migrationFixture().snapshot
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('fails closed for missing authorization, wrong heads, invalid shape, expiry and self-validation', async () => {
    const invalids: [string, (f: ReturnType<typeof migrationFixture>) => void][] = [
      [
        'reserved_check',
        (f) => {
          f.snapshot.invariants.additionalChecks.push({
            checkId: 'migration.policy',
            schema: f.snapshot.policy.schema,
            expected: f.snapshot.policy,
          })
        },
      ],
      [
        'check_schema_mismatch',
        (f) => {
          f.snapshot.invariants.additionalChecks.push({
            checkId: 'external',
            schema: { ...f.snapshot.policy.schema, digest: '0'.repeat(64) },
            expected: f.snapshot.policy,
          })
        },
      ],
      [
        'head_kind_mismatch',
        (f) => {
          Object.assign(f.snapshot, {
            sourceHeads: {
              kind: 'release',
              routeId: 'route',
              routeRevision: 1,
              releaseSetId: 'release',
            },
          })
        },
      ],
      [
        'source_heads_stale',
        (f) => {
          if (f.snapshot.sourceHeads.kind === 'run-state') f.snapshot.sourceHeads.bindingId = 'foreign'
        },
      ],
      [
        'plan_stale',
        (f) => {
          f.snapshot.expiresAt = MIGRATION_FIXTURE_NOW
        },
      ],
      [
        'validator_not_independent',
        (f) => {
          f.snapshot.validatorLocks = [f.snapshot.migratorLock]
        },
      ],
      [
        'content_identity_mismatch',
        (f) => {
          if (f.snapshot.policy.kind === 'inline') f.snapshot.policy.digest = '0'.repeat(64)
        },
      ],
      [
        'locks_missing',
        (f) => {
          f.snapshot.sourceLocks = []
        },
      ],
    ]
    for (const [code, change] of invalids)
      for (const create of factories) {
        const fixture = migrationFixture()
        change(fixture)
        refusal(
          await create(planning(fixture), () => MIGRATION_FIXTURE_NOW).inspect(fixture.request, context()),
          code,
        )
      }
    for (const create of factories) {
      refusal(await create().inspect(migrationFixture().request, context()), 'planning_ports_unavailable')
      const f = migrationFixture(),
        ports = planning(f)
      ports.authorize = async () => ({
        ok: false,
        error: {
          code: 'denied',
          detailCode: 'current_maintenance_denied',
          message: 'Denied',
          diagnosticId: 'fixture',
          retryAdvice: { kind: 'never' },
        },
      })
      refusal(
        await create(ports, () => MIGRATION_FIXTURE_NOW).inspect(f.request, context()),
        'current_maintenance_denied',
      )
      refusal(
        await create(planning(f), () => MIGRATION_FIXTURE_NOW).inspect(
          { ...f.request, actor: 'forged' },
          context(),
        ),
        'schema_invalid',
      )
    }
  })
  it('handles in-flight cancellation and disposal without minting a plan', async () => {
    for (const create of factories)
      for (const stop of ['cancel', 'dispose']) {
        const fixture = migrationFixture(),
          abort = new AbortController(),
          ports = planning(fixture)
        let release: () => void = () => {}
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        ports.snapshot = async () => {
          await gate
          return { ok: true, value: fixture.snapshot }
        }
        const provider = create(ports, () => MIGRATION_FIXTURE_NOW)
        const pending = provider.inspect(fixture.request, { ...context(), signal: abort.signal })
        await Promise.resolve()
        if (stop === 'cancel') abort.abort()
        else await provider.dispose()
        release()
        refusal(await pending, stop === 'cancel' ? 'migration_cancelled' : 'migration_disposed')
      }
  })
  it('keeps all undelivered transaction methods explicitly unsupported', async () => {
    for (const create of factories) {
      const subject = create()
      for (const method of ['prepare', 'validate', 'cutover', 'probe', 'abort'] as const) {
        const result = await subject[method](
          {
            upgradeId: 'upgrade',
            planId: 'plan',
            planFingerprint: '0'.repeat(64),
            candidateRef: migrationFixtureRef(1),
            validationRef: migrationFixtureRef(2),
            expectedCheckpointRevision: 0,
            reason: 'test',
          },
          context(),
        )
        refusal(result, `migration_${method}_unsupported`)
        if (!result.ok) expect(result.error.code).toBe('incompatible')
      }
    }
  })
})

describe('migration eligibility and retained identities', () => {
  it('distinguishes codec conversion from physical transfer and requires all ownership proofs', () => {
    for (const kind of ['run-state', 'state-authority', 'directory'] as const) {
      const f = migrationFixture(kind)
      f.snapshot.facts.unknown = true
      f.snapshot.facts.inflight = true
      const expected = kind === 'run-state' ? 'wait-safe-point' : 'eligible'
      expect(migrationEligibility(f.request, f.snapshot.facts).eligibility).toBe(expected)
      expect(planFor(f).eligibility).toBe(expected)
      for (const key of [
        'callbackProof',
        'debtProof',
        'intakeProof',
        'cohortComplete',
        'jointQualification',
        'fenceCapable',
      ] as const) {
        const bad = structuredClone(f)
        bad.snapshot.facts[key] = false
        if (kind !== 'run-state') expect(planFor(bad).eligibility).toBe('blocked')
      }
      f.snapshot.facts.drained = false
      expect(planFor(f).reasonCodes).toContain('drain_incomplete')
    }
  })
  it('preserves pending answer/action/signal/job IDs, bindings and pins, and never grants terminal execution', () => {
    for (const item of ['answer', 'action', 'signal', 'job'] as const)
      for (const key of [
        'identityPreserved',
        'bindingPreserved',
        'pinPreserved',
        'semanticsPreserved',
      ] as const) {
        const f = migrationFixture()
        const pending = f.snapshot.facts.pending.find((p) => p.kind === item)
        if (pending) pending[key] = false
        expect(planFor(f).reasonCodes).toContain('pending_identity_unpreserved')
      }
    const terminal = migrationFixture()
    terminal.snapshot.facts.terminal = true
    expect(planFor(terminal).reasonCodes).toContain('terminal_execution_forbidden')
    terminal.snapshot.facts.readerOnly = true
    expect(planFor(terminal).eligibility).toBe('eligible')
    terminal.snapshot.facts.exactMigrator = false
    expect(planFor(terminal).eligibility).toBe('retain-source')
    terminal.snapshot.facts.sourceRecoverable = false
    expect(planFor(terminal).eligibility).toBe('blocked')
  })
})

describe('selected authority migration receipt evidence', () => {
  it('reads an independent persisted commit and current heads and requires replanning even after expiry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'migration-proof-'))
    try {
      for (const kind of ['run-state', 'state-authority', 'directory'] as const) {
        const plan = planFor(migrationFixture(kind)),
          f = migrationCompletedFixture(plan)
        writeFileSync(join(root, 'authority.json'), JSON.stringify(f))
        for (const verify of [verifyMigrationReceipt, verifyReferenceMigrationReceipt]) {
          const port = evidence(f)
          port.probe = async () => ({
            ok: true,
            value: (JSON.parse(readFileSync(join(root, 'authority.json'), 'utf8')) as typeof f).commit,
          })
          const result = value(
            await verify(plan, f.receipt, { [kind]: port }, context(), '2026-10-05T00:00:00Z'),
          )
          expect(result).toEqual({
            next: 'regenerate-release-plan',
            approval: 'reverify',
            commitRef: 'actual-commit',
          })
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('rejects completed receipts without selected authority evidence, missing probes, changed current heads and denied provenance', async () => {
    const plan = planFor(),
      f = migrationCompletedFixture(plan)
    for (const verify of [verifyMigrationReceipt, verifyReferenceMigrationReceipt]) {
      refusal(await verify(plan, f.receipt, {}, context()), 'migration_evidence_unavailable')
      const port = evidence(f)
      port.probe = async () => ({ ok: true, value: null })
      refusal(
        await verify(plan, f.receipt, { 'run-state': port }, context()),
        'prerequisite_migration_incomplete',
      )
      const stale = evidence(f)
      stale.currentHeads = async () => ({
        ok: true,
        value: {
          heads: f.commit.committedHeads,
          directory: { ...f.commit.directoryHeads, locatorRevision: 99 },
        },
      })
      refusal(await verify(plan, f.receipt, { 'run-state': stale }, context()), 'migration_heads_stale')
      const self = evidence(f)
      self.validationIssuers = async () => ({ ok: true, value: [] })
      refusal(await verify(plan, f.receipt, { 'run-state': self }, context()), 'validator_not_independent')
    }
  })
  it('cross-checks commit identity, fixed schemas, candidate contents and independent validation refusals', async () => {
    const mutations: [string, (f: ReturnType<typeof migrationCompletedFixture>) => void][] = [
      [
        'migration_commit_mismatch',
        (f) => {
          f.commit.commitRef = 'http-response-id'
        },
      ],
      [
        'migration_commit_mismatch',
        (f) => {
          f.commit.upgradeId = 'other'
        },
      ],
      [
        'migration_commit_mismatch',
        (f) => {
          f.commit.planFingerprint = '0'.repeat(64)
        },
      ],
      [
        'migration_commit_mismatch',
        (f) => {
          f.commit.checkpointRevision++
        },
      ],
      [
        'migration_evidence_type_invalid',
        (f) => {
          f.commit.candidateRef.schema.typeId = 'plugin/candidate@1'
        },
      ],
      [
        'content_identity_mismatch',
        (f) => {
          if (f.commit.candidateRef.kind === 'inline') f.commit.candidateRef.digest = '0'.repeat(64)
        },
      ],
      [
        'schema_invalid',
        (f) => {
          f.commit.candidateRef = migrationFixtureRef(
            { ...f.candidate, passed: true },
            'agh.migration/candidate@1',
          )
        },
      ],
      [
        'migration_validation_mismatch',
        (f) => {
          f.candidate.requiredPins = []
          signCandidate(f)
        },
      ],
      [
        'migration_validation_mismatch',
        (f) => {
          f.candidate.targetDigest = '0'.repeat(64)
          signCandidate(f)
        },
      ],
      [
        'migration_validation_rejected',
        (f) => {
          f.validation.accepted = false
          signCandidate(f)
        },
      ],
      [
        'migration_validation_rejected',
        (f) => {
          const check = f.validation.checks[0]
          if (!check) throw new Error('Missing fixture check')
          check.passed = false
          signCandidate(f)
        },
      ],
      [
        'migration_validation_rejected',
        (f) => {
          const check = f.validation.checks[0]
          if (!check) throw new Error('Missing fixture check')
          f.validation.checks.push(check)
          signCandidate(f)
        },
      ],
      [
        'migration_checks_missing',
        (f) => {
          f.validation.checks = []
          signCandidate(f)
        },
      ],
      [
        'validator_not_independent',
        (f) => {
          const check = f.validation.checks[0]
          if (!check) throw new Error('Missing fixture check')
          check.evidence = f.candidate.content
          signCandidate(f)
        },
      ],
      [
        'validator_not_independent',
        (f) => {
          f.validation.validatorBindings = [{ ...f.issuer, bindingId: 'untrusted' }]
          signCandidate(f)
        },
      ],
    ]
    for (const [code, mutate] of mutations)
      for (const verify of [verifyMigrationReceipt, verifyReferenceMigrationReceipt]) {
        const plan = planFor(),
          f = migrationCompletedFixture(plan)
        mutate(f)
        refusal(
          await verify(plan, f.receipt, { 'run-state': evidence(f) }, context(), MIGRATION_FIXTURE_NOW),
          code,
        )
      }
  })
})

it('retains recovery pins for live owners, incomplete operations, unknown refs and current controls', () => {
  const input = {
    referencesKnown: true,
    oldOwners: [{ ownerId: 'original-action', pinId: 'old-pin', settled: true }],
    operationState: 'completed' as const,
    now: MIGRATION_FIXTURE_NOW,
    minimumRecoveryUntil: '2026-10-02T00:00:00Z',
    archiveVerified: true,
    currentDeletionAndRevocationApplied: true,
    targetPinDurable: true,
    ownerTransferConfirmed: true,
  }
  expect(migrationPinRetention(input).mayCollect).toBe(true)
  for (const key of [
    'referencesKnown',
    'archiveVerified',
    'currentDeletionAndRevocationApplied',
    'targetPinDurable',
    'ownerTransferConfirmed',
  ] as const)
    expect(migrationPinRetention({ ...input, [key]: false }).mayCollect).toBe(false)
  expect(migrationPinRetention({ ...input, minimumRecoveryUntil: '2026-10-04T00:00:00Z' }).mayCollect).toBe(
    false,
  )
  expect(migrationPinRetention({ ...input, operationState: 'frozen' }).mayCollect).toBe(false)
  expect(
    migrationPinRetention({
      ...input,
      oldOwners: [{ ownerId: 'original-action', pinId: 'old-pin', settled: false }],
    }).retainedPinIds,
  ).toEqual(['old-pin'])
})
