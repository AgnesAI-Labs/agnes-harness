import { createHash } from 'node:crypto'
import {
  type PackageAdminAuthorityResolver,
  requireLocalAdminAuthority,
} from '@agnes/daemon-admin/packages/index'
import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { Registry } from '@agnes/daemon-foundation/registry'
import { AutoReviewSettingsStore, RequestTraceStore, SystemPromptSettingsStore } from '@agnes/host'
import {
  type ModelRequestClearParams,
  type ModelRequestParams,
  rpcError,
  type SystemPromptConfig,
  type SystemPromptGetParams,
  type SystemPromptSaveParams,
  type SystemPromptSnapshot,
} from '@agnes/protocol'
import type { SessionEntry } from '../sessions.js'

export function registerPromptTrace(
  endpoint: LocalEndpoint,
  deps: {
    dataDir: string
    profile: string
    reviewEnabled?: boolean
    authority: PackageAdminAuthorityResolver
    readOnly(context: CallContext): Promise<boolean>
    registry: Pick<Registry<SessionEntry>, 'require'>
    requireSessionOwner(method: string, sessionId: string, context: CallContext): void
    preview(config: SystemPromptConfig): Promise<SystemPromptSnapshot>
  },
) {
  const settings = new SystemPromptSettingsStore(deps.dataDir, deps.profile)
  const traces = new RequestTraceStore(deps.dataDir, deps.profile)
  const reviewer = new AutoReviewSettingsStore(deps.dataDir, deps.profile, deps.reviewEnabled)
  endpoint.register('_agnes/v1/autoReview.get', async (_params, context) => {
    requireLocalAdminAuthority(context, deps.authority, false)
    return reviewer.read()
  })
  endpoint.register('_agnes/v1/autoReview.save', async (params, context) => {
    requireLocalAdminAuthority(context, deps.authority, true)
    if (await deps.readOnly(context)) throw rpcError('SEMANTIC_REJECTED', { reason: 'E_ADMIN_READ_ONLY' })
    return reviewer.save(params as import('@agnes/protocol').AutoReviewConfig)
  })
  endpoint.register('_agnes/v1/systemPrompt.get', async (params, context) => {
    const { sessionId } = params as SystemPromptGetParams
    if (sessionId) {
      deps.requireSessionOwner('systemPrompt.get', sessionId, context)
      const pinned = await deps.registry.require(sessionId).session.systemPromptPreview()
      const calls = (await traces.get(sessionId)).calls ?? []
      const last = calls.findLast((call) => call.kind === 'inference')
      const actual = last ? (await traces.get(sessionId, last.id)).snapshot : null
      return actual
        ? {
            ...pinned,
            sections: actual.sections,
            hash: createHash('sha256').update(actual.system).digest('hex'),
            preview: 'last-request',
          }
        : pinned
    }
    requireLocalAdminAuthority(context, deps.authority, false)
    return deps.preview(await settings.read())
  })
  endpoint.register('_agnes/v1/systemPrompt.save', async (params, context) => {
    requireLocalAdminAuthority(context, deps.authority, true)
    if (await deps.readOnly(context)) throw rpcError('SEMANTIC_REJECTED', { reason: 'E_ADMIN_READ_ONLY' })
    const { config, confirmFullOverride } = params as SystemPromptSaveParams
    if (
      config.fullOverride !== undefined &&
      (config.personaPrefix || config.personaSuffix || config.replyStyle)
    )
      throw rpcError('INVALID_PARAMS', {
        code: 'CONFIG_INVALID_INPUT',
        reason: 'full replacement conflicts with additive persona fields',
      })
    // Validate provider/preview before committing; a refused provider cannot poison new sessions.
    const snapshot = await deps.preview(config)
    try {
      await settings.save(config, confirmFullOverride)
    } catch (failure) {
      throw rpcError('INVALID_PARAMS', {
        code:
          (failure as { code?: string }).code === 'CONFIG_INVALID_INPUT'
            ? 'CONFIG_INVALID_INPUT'
            : 'CONFIG_PERSIST_FAILED',
      })
    }
    return snapshot
  })
  endpoint.register('_agnes/v1/trace.request', async (params, context) => {
    const { sessionId, callId, compare } = params as ModelRequestParams
    deps.requireSessionOwner('trace.request', sessionId, context)
    if (compare) deps.requireSessionOwner('trace.request', compare.sessionId, context)
    const result = await traces.get(sessionId, callId)
    if (compare && result.snapshot)
      result.previous = (await traces.get(compare.sessionId, compare.callId)).snapshot
    return result
  })
  endpoint.register('_agnes/v1/trace.clear', async (params, context) => {
    const { sessionId, callId } = params as ModelRequestClearParams
    deps.requireSessionOwner('trace.clear', sessionId, context)
    return { cleared: await traces.clear(sessionId, callId) }
  })
}
