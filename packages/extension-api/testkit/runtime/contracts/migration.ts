import type { MigrationPlan } from '@agnes/protocol/runtime'
import type { CallContext, Outcome } from '../../../src/runtime/public-api.js'
import type { BuildIdentity } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'
import {
  MIGRATION_FIXTURE_NOW,
  migrationCompletedFixture,
  migrationFixture,
  migrationFixtureDigest,
} from './migration-fixture.js'

export const MIGRATION_PLAN_COVERAGE = Object.freeze({
  implemented: ['inspect', 'fingerprint', 'eligibility', 'receipt-verification', 'replan-required'],
  unfinished: [
    'prepare',
    'validate',
    'cutover',
    'probe',
    'abort',
    'durable-operation-recovery',
    'physical-transfer',
    'pin-collection',
  ],
  qualification: 'detached-read-only-planning',
})
export interface MigrationPlanSubject {
  readonly providerId: string
  inspect(request: unknown, context: CallContext): Promise<Outcome<MigrationPlan>>
  dispose(): Promise<void>
}
export interface MigrationPlanContractBinding {
  readonly providerId: string
  readonly command: string
  readonly build: BuildIdentity
  readonly providerDigest: string
  readonly create: (fixture: ReturnType<typeof migrationFixture>) => MigrationPlanSubject
  readonly verifyReceipt: (
    plan: MigrationPlan,
    fixture: ReturnType<typeof migrationCompletedFixture> | null,
    context: CallContext,
  ) => Promise<
    Outcome<{
      readonly next: 'regenerate-release-plan'
      readonly approval: 'reverify'
      readonly commitRef: string
    }>
  >
}
/** Local inspect contract only. No execution refusal is counted as successful migration or recovery. */
export function registerMigrationPlanContract(
  harness: ConformanceHarness,
  binding: MigrationPlanContractBinding,
): void {
  for (const scenario of ['select', 'normal', 'deny', 'cancel', 'dispose'] as const)
    harness.registerCase({
      contract: 'agh.migration',
      providerId: binding.providerId,
      scenario,
      qualification: 'required',
      async run() {
        const fixture = migrationFixture(),
          subject = binding.create(fixture),
          context = migrationContext()
        const first = await subject.inspect(fixture.request, context)
        let passed =
          first.ok &&
          subject.providerId === `agh.${binding.providerId}/migration` &&
          first.value.eligibility === 'eligible' &&
          Object.isFrozen(first.value)
        if (scenario === 'normal') {
          const repeat = await subject.inspect(fixture.request, context)
          passed =
            passed &&
            repeat.ok &&
            first.ok &&
            migrationFixtureDigest(repeat.value) === migrationFixtureDigest(first.value)
          for (const kind of ['run-state', 'state-authority', 'directory'] as const)
            for (const mode of ['inspect-only', 'auto-compatible', 'explicit'] as const) {
              const next = migrationFixture(kind, mode),
                selected = binding.create(next)
              const plan = await selected.inspect(next.request, context)
              passed =
                passed && plan.ok && plan.value.sourceHeads.kind === kind && plan.value.request.mode === mode
              if (plan.ok && mode !== 'inspect-only') {
                const proof = await binding.verifyReceipt(
                  plan.value,
                  migrationCompletedFixture(plan.value),
                  context,
                )
                passed =
                  passed &&
                  proof.ok &&
                  proof.value.next === 'regenerate-release-plan' &&
                  proof.value.approval === 'reverify'
              }
              await selected.dispose()
            }
        }
        if (scenario === 'deny') {
          const changed = await subject.inspect({ ...fixture.request, reason: 'Different input' }, context)
          passed = passed && !changed.ok && changed.error.detailCode === 'upgrade_fingerprint_conflict'
          if (first.ok) {
            const missing = await binding.verifyReceipt(first.value, null, context)
            const forged = migrationCompletedFixture(first.value)
            forged.commit.commitRef = 'fabricated-response-id'
            const rejectedReceipt = await binding.verifyReceipt(first.value, forged, context)
            passed =
              passed &&
              !missing.ok &&
              missing.error.detailCode === 'migration_evidence_unavailable' &&
              !rejectedReceipt.ok &&
              rejectedReceipt.error.detailCode === 'migration_commit_mismatch'
          }
          const unsafe = migrationFixture()
          unsafe.snapshot.facts.unknown = true
          const rejected = await binding.create(unsafe).inspect(unsafe.request, context)
          passed =
            passed &&
            rejected.ok &&
            rejected.value.eligibility === 'wait-safe-point' &&
            rejected.value.reasonCodes.includes('unknown_effect')
        }
        if (scenario === 'cancel') {
          const cancelled = new AbortController()
          cancelled.abort()
          const result = await subject.inspect(fixture.request, { ...context, signal: cancelled.signal })
          passed = passed && !result.ok && result.error.code === 'cancelled'
        }
        if (scenario === 'dispose') {
          await subject.dispose()
          const result = await subject.inspect(fixture.request, context)
          passed = passed && !result.ok && result.error.detailCode === 'migration_disposed'
        }
        await subject.dispose()
        return {
          id: `agh.migration/${binding.providerId}/inspect/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: 'migration/read-only-plan',
          features: ['inspect'],
          build: binding.build,
          consumer: 'detached-migration-plan-consumer',
          command: binding.command,
          status: passed ? 'passed' : 'failed',
          configDigest: migrationFixtureDigest(fixture.snapshot),
          releaseSetDigest: migrationFixtureDigest('no-release-operation'),
          attachmentDigest: migrationFixtureDigest({
            coverage: MIGRATION_PLAN_COVERAGE,
            at: MIGRATION_FIXTURE_NOW,
          }),
          fixture: null,
          sharedEvidenceId: null,
          reuse: {
            scope: 'deployment',
            methodKind: 'maintenance',
            lifecycle: 'call',
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
}
function migrationContext(): CallContext {
  return {
    signal: new AbortController().signal,
    principalRef: 'synthetic-maintainer',
    bindingId: 'maintenance-binding',
    invocationId: 'inspect',
    deadline: '2030-01-01T00:00:00Z',
    traceRef: 'trace',
    scope: { kind: 'runtime', installationId: 'installation', runtimeId: 'runtime' },
    authorizationRef: 'synthetic-authorization',
  }
}
