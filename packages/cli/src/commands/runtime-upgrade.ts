import type { MigrationPlan, MigrationReceipt, ReleasePlan } from '@agnes/protocol/runtime'

export interface RuntimeUpgradePlanRequest {
  readonly command: 'plan'
  readonly profile: string
  readonly locatorRef: string
  readonly selection?: 'release' | 'run-state' | 'state-authority' | 'directory'
  readonly rollbackOf?: string
}
export interface RuntimeUpgradeApplyRequest {
  readonly command: 'apply'
  readonly planId: string
}
export interface RuntimeUpgradeMigrateRequest {
  readonly command: 'migrate'
  readonly planId: string
}
export interface RuntimeUpgradeStatusRequest {
  readonly command: 'status'
  readonly upgradeId: string
}
export interface RuntimeUpgradeRollbackRequest {
  readonly command: 'rollback'
  readonly planId: string
}
export type RuntimeUpgradeRequest =
  | RuntimeUpgradePlanRequest
  | RuntimeUpgradeApplyRequest
  | RuntimeUpgradeMigrateRequest
  | RuntimeUpgradeStatusRequest
  | RuntimeUpgradeRollbackRequest
export type RuntimeUpgradePlan =
  | { readonly kind: 'release'; readonly plan: ReleasePlan }
  | { readonly kind: 'migration'; readonly plan: MigrationPlan }
export interface RuntimeUpgradeStageJson {
  readonly command: RuntimeUpgradeRequest['command']
  readonly upgradeId: string | null
  readonly planId: string | null
  readonly phase: 'plan' | 'prepare' | 'verify' | 'publish' | 'migrate' | 'status' | 'rollback'
  readonly state: 'accepted' | 'planned' | 'blocked' | 'committed' | 'completed' | 'aborted' | 'failed'
  readonly diagnosticIds: readonly string[]
  readonly nextSteps: readonly string[]
}
export interface RuntimeUpgradePlanResult {
  readonly selected: RuntimeUpgradePlan
  readonly prerequisites: readonly MigrationPlan[]
  readonly diagnostics: readonly string[]
  readonly sourceFormat: string
  readonly configurationMappings: readonly { readonly source: string; readonly target: string }[]
  readonly missingRecoveryAssets: readonly string[]
}
/** Supplied by the independent maintenance entry owner. This module installs no transport or authority. */
export interface RuntimeUpgradeFacade {
  planFromProfile(request: RuntimeUpgradePlanRequest, signal: AbortSignal): Promise<RuntimeUpgradePlanResult>
  readPlan(
    planId: string,
    signal: AbortSignal,
  ): Promise<RuntimeUpgradePlan & { readonly reverseOf: string | null }>
  apply(
    request: { readonly planId: string; readonly planFingerprint: string },
    signal: AbortSignal,
  ): Promise<RuntimeUpgradeStageJson>
  migrate(
    request: { readonly planId: string; readonly planFingerprint: string },
    signal: AbortSignal,
  ): Promise<MigrationReceipt>
  status(request: RuntimeUpgradeStatusRequest, signal: AbortSignal): Promise<RuntimeUpgradeStageJson>
  rollback(
    request: {
      readonly planId: string
      readonly planFingerprint: string
      readonly kind: RuntimeUpgradePlan['kind']
    },
    signal: AbortSignal,
  ): Promise<RuntimeUpgradeStageJson>
}
/** The authenticated adapter translates a backend refusal without exposing private diagnostics. */
export class RuntimeUpgradeFacadeError extends Error {
  constructor(readonly detailCode: string) {
    super(detailCode)
  }
}
export interface RuntimeUpgradeCommandResult {
  readonly exitCode: number
  readonly json: RuntimeUpgradeStageJson
  readonly plan?: RuntimeUpgradePlanResult
  readonly receipt?: MigrationReceipt
}

function blocked(request: RuntimeUpgradeRequest, reason: string): RuntimeUpgradeCommandResult {
  return {
    exitCode: 1,
    json: {
      command: request.command,
      upgradeId: request.command === 'status' ? request.upgradeId : null,
      planId: 'planId' in request ? request.planId : null,
      phase: request.command === 'apply' ? 'prepare' : request.command,
      state: 'blocked',
      diagnosticIds: [reason],
      nextSteps: [],
    },
  }
}
function staged(json: RuntimeUpgradeStageJson): RuntimeUpgradeCommandResult {
  return { exitCode: ['blocked', 'failed', 'aborted'].includes(json.state) ? 1 : 0, json }
}
/** Callable command module only; registration, authentication and durable operations belong to its entry owner. */
export async function runtimeUpgradeCommand(
  request: RuntimeUpgradeRequest,
  facade: RuntimeUpgradeFacade | undefined,
  context: { readonly signal: AbortSignal },
): Promise<RuntimeUpgradeCommandResult> {
  if (context.signal.aborted) return blocked(request, 'migration_cancelled')
  if (!facade) return blocked(request, 'maintenance_facade_unavailable')
  try {
    if (request.command === 'plan') {
      const value = await facade.planFromProfile(request, context.signal),
        plan = value.selected.plan
      const isBlocked =
        value.diagnostics.length > 0 ||
        value.missingRecoveryAssets.length > 0 ||
        (value.selected.kind === 'migration' && value.selected.plan.eligibility !== 'eligible')
      const commands = value.prerequisites.map(
        (prerequisite) => `agh runtime upgrade migrate --plan ${prerequisite.planId}`,
      )
      if (value.prerequisites.length)
        commands.push(`agh runtime upgrade plan --profile ${JSON.stringify(request.profile)}`)
      else
        commands.push(
          `agh runtime upgrade ${value.selected.kind === 'release' ? 'apply' : 'migrate'} --plan ${plan.planId}`,
        )
      return {
        ...staged({
          command: 'plan',
          upgradeId: plan.upgradeId,
          planId: plan.planId,
          phase: 'plan',
          state: isBlocked ? 'blocked' : 'planned',
          diagnosticIds: [...value.diagnostics, ...value.missingRecoveryAssets],
          nextSteps:
            isBlocked ||
            (value.selected.kind === 'migration' && value.selected.plan.request.mode === 'inspect-only')
              ? []
              : commands,
        }),
        plan: value,
      }
    }
    if (request.command === 'status') {
      return staged(await facade.status(request, context.signal))
    }
    const fixed = await facade.readPlan(request.planId, context.signal)
    if (context.signal.aborted) return blocked(request, 'migration_cancelled')
    if (fixed.plan.planId !== request.planId) return blocked(request, 'upgrade_plan_mismatch')
    if (
      (request.command === 'apply' && fixed.kind !== 'release') ||
      (request.command === 'migrate' && fixed.kind !== 'migration')
    )
      return blocked(request, 'upgrade_kind_mismatch')
    if (fixed.kind === 'migration') {
      if (fixed.plan.request.mode === 'inspect-only') return blocked(request, 'inspect_only_plan')
      if (fixed.plan.eligibility !== 'eligible') return blocked(request, 'migration_ineligible')
    }
    if (request.command === 'rollback') {
      const reverse =
        fixed.reverseOf !== null &&
        fixed.reverseOf !== fixed.plan.upgradeId &&
        (fixed.kind === 'migration' ||
          (fixed.plan.operation === 'rollback' && fixed.plan.rollbackOf === fixed.reverseOf))
      if (!reverse) return blocked(request, 'reverse_plan_required')
    }
    const handle = { planId: fixed.plan.planId, planFingerprint: fixed.plan.planFingerprint }
    if (request.command === 'migrate') {
      if (fixed.kind !== 'migration') return blocked(request, 'upgrade_kind_mismatch')
      const receipt = await facade.migrate(handle, context.signal)
      if (receipt.upgradeId !== fixed.plan.upgradeId) return blocked(request, 'migration_receipt_mismatch')
      const state: RuntimeUpgradeStageJson['state'] = [
        'completed',
        'committed',
        'aborted',
        'blocked',
      ].includes(receipt.state)
        ? (receipt.state as 'completed' | 'committed' | 'aborted' | 'blocked')
        : 'accepted'
      return {
        ...staged({
          command: 'migrate',
          upgradeId: receipt.upgradeId,
          planId: fixed.plan.planId,
          phase: 'migrate',
          state,
          diagnosticIds: receipt.diagnosticIds,
          nextSteps:
            state === 'completed'
              ? ['Regenerate the release plan and reverify approval.']
              : [`agh runtime upgrade status --upgrade ${receipt.upgradeId}`],
        }),
        receipt,
      }
    }
    const executed =
      request.command === 'apply'
        ? await facade.apply(handle, context.signal)
        : await facade.rollback({ ...handle, kind: fixed.kind }, context.signal)
    return staged(executed)
  } catch (error) {
    return blocked(
      request,
      error instanceof RuntimeUpgradeFacadeError ? error.detailCode : 'maintenance_facade_unavailable',
    )
  }
}
