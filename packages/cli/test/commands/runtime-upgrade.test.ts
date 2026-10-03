import { describe, expect, it } from 'vitest'
import { assemblyFixture } from '../../../extension-api/testkit/runtime/contracts/assembly-fixture.js'
import {
  MIGRATION_FIXTURE_NOW,
  migrationCompletedFixture,
  migrationContractContext,
  migrationFixture,
} from '../../../extension-api/testkit/runtime/contracts/migration-fixture.js'
import { constructMigrationPlan } from '../../../host/src/runtime/migration/controller.js'
import {
  type RuntimeUpgradeFacade,
  type RuntimeUpgradePlan,
  type RuntimeUpgradeStageJson,
  runtimeUpgradeCommand,
} from '../../src/commands/runtime-upgrade.js'

function migrationPlan() {
  const f = migrationFixture(),
    outcome = constructMigrationPlan(f.request, f.snapshot, MIGRATION_FIXTURE_NOW)
  if (!outcome.ok) throw new Error(outcome.error.detailCode)
  return outcome.value
}
function facade(fixed: RuntimeUpgradePlan, reverseOf: string | null = null): RuntimeUpgradeFacade {
  const stage: RuntimeUpgradeStageJson = {
    command: 'apply',
    upgradeId: fixed.plan.upgradeId,
    planId: fixed.plan.planId,
    phase: 'prepare',
    state: 'accepted',
    diagnosticIds: [],
    nextSteps: [],
  }
  return {
    planFromProfile: async () => ({
      selected: fixed,
      prerequisites: [],
      diagnostics: [],
      sourceFormat: 'v1',
      configurationMappings: [],
      missingRecoveryAssets: [],
    }),
    readPlan: async () => ({ ...fixed, reverseOf }),
    apply: async () => stage,
    migrate: async () => migrationCompletedFixture(migrationPlan()).receipt,
    status: async () => ({ ...stage, command: 'status', phase: 'status' }),
    rollback: async () => ({ ...stage, command: 'rollback', phase: 'rollback' }),
  }
}
describe('detached runtime upgrade command facade', () => {
  it('resolves profiles and locators through the maintenance owner and orders prerequisite migration before replanning', async () => {
    const fixed = { kind: 'release' as const, plan: assemblyFixture().plan },
      ports = facade(fixed)
    ports.planFromProfile = async (request) => {
      expect(request.profile).toBe('default')
      expect(request.locatorRef).toBe('authenticated-locator')
      expect(Object.keys(request)).not.toContain('bindingId')
      return {
        selected: fixed,
        prerequisites: [migrationPlan()],
        diagnostics: [],
        sourceFormat: 'legacy',
        configurationMappings: [{ source: 'max_steps', target: '/limits/maxSteps' }],
        missingRecoveryAssets: [],
      }
    }
    const result = await runtimeUpgradeCommand(
      { command: 'plan', profile: 'default', locatorRef: 'authenticated-locator' },
      ports,
      migrationContractContext(),
    )
    expect(result.exitCode).toBe(0)
    expect(result.json.nextSteps).toEqual([
      'agh runtime upgrade migrate --plan migration-plan',
      'agh runtime upgrade plan --profile "default"',
    ])
    expect(result.plan?.configurationMappings).toHaveLength(1)
  })
  it('refuses missing assets, mode mismatch, inspect-only execution and absent maintenance ports', async () => {
    const fixed = { kind: 'migration' as const, plan: migrationPlan() },
      ports = facade(fixed)
    expect(
      (
        await runtimeUpgradeCommand(
          { command: 'apply', planId: fixed.plan.planId },
          ports,
          migrationContractContext(),
        )
      ).json.diagnosticIds,
    ).toEqual(['upgrade_kind_mismatch'])
    const release = { kind: 'release' as const, plan: assemblyFixture().plan }
    expect(
      (
        await runtimeUpgradeCommand(
          { command: 'migrate', planId: release.plan.planId },
          facade(release),
          migrationContractContext(),
        )
      ).exitCode,
    ).toBe(1)
    const inspect = {
      ...fixed,
      plan: { ...fixed.plan, request: { ...fixed.plan.request, mode: 'inspect-only' as const } },
    }
    for (const command of ['migrate', 'rollback'] as const) {
      expect(
        (
          await runtimeUpgradeCommand(
            { command, planId: fixed.plan.planId },
            facade(inspect, 'old-upgrade'),
            migrationContractContext(),
          )
        ).json.diagnosticIds,
      ).toEqual(['inspect_only_plan'])
      expect(
        (
          await runtimeUpgradeCommand(
            { command, planId: fixed.plan.planId },
            facade({ ...fixed, plan: { ...fixed.plan, eligibility: 'blocked' } }, 'old-upgrade'),
            migrationContractContext(),
          )
        ).json.diagnosticIds,
      ).toEqual(['migration_ineligible'])
    }
    expect(
      (
        await runtimeUpgradeCommand(
          { command: 'status', upgradeId: 'upgrade' },
          undefined,
          migrationContractContext(),
        )
      ).exitCode,
    ).toBe(1)
    ports.planFromProfile = async () => ({
      selected: fixed,
      prerequisites: [],
      diagnostics: [],
      sourceFormat: 'legacy',
      configurationMappings: [],
      missingRecoveryAssets: ['old-codec'],
    })
    const blocked = await runtimeUpgradeCommand(
      { command: 'plan', profile: 'default', locatorRef: 'locator' },
      ports,
      migrationContractContext(),
    )
    expect(blocked.exitCode).toBe(1)
    expect(blocked.json.diagnosticIds).toContain('old-codec')
  })
  it('keeps accepted distinct from completed and requires a new reverse operation for rollback', async () => {
    const fixed = { kind: 'release' as const, plan: assemblyFixture().plan },
      ports = facade(fixed)
    const accepted = await runtimeUpgradeCommand(
      { command: 'apply', planId: fixed.plan.planId },
      ports,
      migrationContractContext(),
    )
    expect(accepted.json.state).toBe('accepted')
    expect(accepted.exitCode).toBe(0)
    expect(
      (
        await runtimeUpgradeCommand(
          { command: 'rollback', planId: fixed.plan.planId },
          ports,
          migrationContractContext(),
        )
      ).json.diagnosticIds,
    ).toEqual(['reverse_plan_required'])
    const reverse = {
      kind: 'release' as const,
      plan: {
        ...fixed.plan,
        upgradeId: 'reverse-upgrade',
        operation: 'rollback' as const,
        rollbackOf: fixed.plan.upgradeId,
      },
    }
    expect(
      (
        await runtimeUpgradeCommand(
          { command: 'rollback', planId: reverse.plan.planId },
          facade(reverse, fixed.plan.upgradeId),
          migrationContractContext(),
        )
      ).json.state,
    ).toBe('accepted')
    const migrated = await runtimeUpgradeCommand(
      { command: 'migrate', planId: 'migration-plan' },
      facade({ kind: 'migration', plan: migrationPlan() }),
      migrationContractContext(),
    )
    expect(migrated.json.state).toBe('completed')
    expect(migrated.json.nextSteps[0]).toContain('reverify approval')
  })
})
