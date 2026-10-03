import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  MigrationAbortRequest,
  MigrationCutoverRequest,
  MigrationPrepareRequest,
  MigrationPrepareResult,
  MigrationProbeRequest,
  MigrationReceipt,
  MigrationValidateRequest,
  MigrationValidateResult,
} from '@agnes/protocol/runtime'
import { createMigrationPlanningController, type MigrationPlanningPorts } from '../migration/controller.js'
import { failure } from '../migration/primitives.js'

/** Detached planning provider. No fixture authority or execution capability is installed by default. */
export function createMigrationProvider(ports?: MigrationPlanningPorts, now?: () => string) {
  const controller = createMigrationPlanningController(ports, now)
  const unsupported = (method: string, context: CallContext) =>
    context.signal.aborted
      ? failure('migration_cancelled', 'cancelled')
      : failure(`migration_${method}_unsupported`, 'incompatible')
  return {
    providerId: 'agh.default/migration',
    contract: 'agh.migration',
    implemented: Object.freeze(['inspect']),
    incomplete: Object.freeze(['prepare', 'validate', 'cutover', 'probe', 'abort', 'cold-recovery']),
    inspect: controller.inspect,
    async prepare(
      _request: MigrationPrepareRequest,
      context: CallContext,
    ): Promise<Outcome<MigrationPrepareResult>> {
      return unsupported('prepare', context)
    },
    async validate(
      _request: MigrationValidateRequest,
      context: CallContext,
    ): Promise<Outcome<MigrationValidateResult>> {
      return unsupported('validate', context)
    },
    async cutover(
      _request: MigrationCutoverRequest,
      context: CallContext,
    ): Promise<Outcome<MigrationReceipt>> {
      return unsupported('cutover', context)
    },
    async probe(_request: MigrationProbeRequest, context: CallContext): Promise<Outcome<MigrationReceipt>> {
      return unsupported('probe', context)
    },
    async abort(_request: MigrationAbortRequest, context: CallContext): Promise<Outcome<MigrationReceipt>> {
      return unsupported('abort', context)
    },
    async dispose() {
      controller.dispose()
    },
  }
}
