import type { PackageAdminAuthorityResolver } from '@agnes/daemon-admin/packages/index'
import { requireLocalAdminAuthority } from '@agnes/daemon-admin/packages/index'
import { type CallContext, connActor, type LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { FeedbackInstance, FeedbackRequest } from '@agnes/host'
import { type Actor, rpcError } from '@agnes/protocol'
import type { AdminFeedbackParams } from '@agnes/protocol/gen/app-server'

/** Local management transport. The daemon resolves the profile's feedback provider for each request. */
export function registerFeedback(
  endpoint: LocalEndpoint,
  deps: {
    authority: PackageAdminAuthorityResolver
    open(
      context: CallContext,
      input: FeedbackRequest,
      actor: Actor,
      signal: AbortSignal,
    ): Promise<FeedbackInstance>
    owner(sessionId: string, context: CallContext): void
    actor(sessionId: string | undefined, context: CallContext): Promise<Actor>
    serialize<T>(
      sessionId: string,
      signal: AbortSignal,
      work: (signal: AbortSignal) => Promise<T>,
    ): Promise<T>
  },
) {
  endpoint.register('_agnes/v1/admin.feedback', async (input, context) => {
    const params = input as AdminFeedbackParams
    requireLocalAdminAuthority(context, deps.authority, params.action !== 'list')
    if (params.sessionId) deps.owner(params.sessionId, context)
    if (params.action !== 'list' && !params.sessionId) throw rpcError('INVALID_PARAMS')
    const actor: Actor =
      params.action === 'list' ? connActor(context.conn) : await deps.actor(params.sessionId, context)
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(40_000)])
    const work = async (active: AbortSignal) => {
      const service = await deps.open(context, params, actor, active)
      try {
        return await service.execute(params, structuredClone(actor), active)
      } finally {
        // dispose() throws before returning a promise when the binding is already closed.
        try {
          await service.dispose?.()
        } catch {
          // Closing the binding must not replace the operation result or its error.
        }
      }
    }
    // Read-only projection needs no live worker or session actor resolution, including cold history.
    return params.action === 'list' ? work(signal) : deps.serialize(params.sessionId!, signal, work)
  })
}
