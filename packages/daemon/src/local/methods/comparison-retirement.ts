import { ComparisonJournalError } from '@agnes/host'
import type {
  ComparisonPruneParams,
  ComparisonPruneResult,
  ComparisonRetirementParams,
} from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import { comparisonSnapshot } from '@agnes/runtime-comparison'
import {
  ComparisonRetirementError,
  type ComparisonRetirementService,
} from '../comparison-retirement-service.js'
import type { LocalEndpoint } from '../endpoint.js'

function publicError(error: unknown) {
  const code =
    error instanceof ComparisonRetirementError || error instanceof ComparisonJournalError
      ? error.code
      : 'COMPARISON_RETIREMENT_FAILED'
  return {
    code,
    message:
      code === 'COMPARISON_REVISION_CONFLICT'
        ? '对比状态已改变，请刷新后重试。'
        : code === 'COMPARISON_BUSY'
          ? '对比或子任务仍在运行，请完成或停止后重试。'
          : '操作结果尚未确认，请刷新状态后重试。',
  }
}

/** No principal, session owner or cleanup path is accepted from the wire. */
export function registerComparisonRetirementRPC(
  endpoint: LocalEndpoint,
  service?: ComparisonRetirementService,
) {
  const required = () =>
    service ??
    (() => {
      throw rpcError('CAPABILITY_DENIED', { reason: 'comparison retirement unavailable' })
    })()
  const execute = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation()
    } catch (error) {
      throw rpcError('SEMANTIC_REJECTED', publicError(error))
    }
  }
  endpoint.register('_agnes/v1/comparison.release', async (params, context) => {
    const port = required()
    const input = params as ComparisonRetirementParams
    return execute(async () => {
      const record = await port.release({ ...input, principal: endpoint.conn.principalId }, context.signal)
      if (record.retirement?.state !== 'released')
        throw new ComparisonRetirementError('COMPARISON_RELEASE_INCOMPLETE')
      if (record.creation === 'failed')
        return {
          id: record.id,
          revision: record.revision,
          storageState: 'released' as const,
          kind: 'failed-preparation' as const,
        }
      return comparisonSnapshot(record)
    })
  })
  endpoint.register('_agnes/v1/comparison.remove', async (params, context) => {
    const port = required()
    const input = params as ComparisonRetirementParams
    return execute(async () => {
      const record = await port.remove({ ...input, principal: endpoint.conn.principalId }, context.signal)
      if (record.retirement?.state !== 'removed')
        throw new ComparisonRetirementError('COMPARISON_REMOVE_INCOMPLETE')
      return { id: record.id, revision: record.revision, storageState: 'removed' as const }
    })
  })
  endpoint.register('_agnes/v1/comparison.prune', async (params, context): Promise<ComparisonPruneResult> => {
    const port = required()
    const input = params as ComparisonPruneParams
    return execute(async () => ({
      items: (await port.prune({ ...input, principal: endpoint.conn.principalId }, context.signal)).map(
        (result) => {
          const state = result.record?.retirement?.state
          if (result.record && (state === 'released' || state === 'removed'))
            return { id: result.id, ok: true as const, revision: result.record.revision, storageState: state }
          return {
            id: result.id,
            ok: false as const,
            error: publicError(
              new ComparisonRetirementError(
                result.error && /^[A-Z][A-Z_]{0,127}$/.test(result.error)
                  ? result.error
                  : 'COMPARISON_RETIREMENT_FAILED',
              ),
            ),
          }
        },
      ),
    }))
  })
}
