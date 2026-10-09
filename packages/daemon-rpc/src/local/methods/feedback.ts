import type { PackageAdminAuthorityResolver } from '@agnes/daemon-admin/packages/index'
import { requireLocalAdminAuthority } from '@agnes/daemon-admin/packages/index'
import { connActor, type CallContext, type LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { FeedbackPorts, FeedbackServiceFactory } from '@agnes/extension-api'
import { createFeedbackService } from '@agnes/host'
import { type Actor, rpcError } from '@agnes/protocol'
import type { AdminFeedbackParams } from '@agnes/protocol/gen/app-server'

/** Local management transport. A service replacement receives only authenticated local ports. */
export function registerFeedback(
  endpoint: LocalEndpoint,
  deps: {
    authority: PackageAdminAuthorityResolver
    ports(context: CallContext): FeedbackPorts
    owner(sessionId: string, context: CallContext): void
    actor(sessionId: string | undefined, context: CallContext): Promise<Actor>
    serialize<T>(
      sessionId: string,
      signal: AbortSignal,
      work: (signal: AbortSignal) => Promise<T>,
    ): Promise<T>
    factory?: FeedbackServiceFactory
  },
) {
  endpoint.register('_agnes/v1/admin.feedback', async (input, context) => {
    const params = input as AdminFeedbackParams
    requireLocalAdminAuthority(context, deps.authority, params.action !== 'list')
    if (params.sessionId) deps.owner(params.sessionId, context)
    if (params.action !== 'list' && !params.sessionId) throw rpcError('INVALID_PARAMS')
    const service = (deps.factory ?? createFeedbackService)(deps.ports(context))
    // Read-only projection needs no live worker or session actor resolution, including cold history.
    const actor: Actor =
      params.action === 'list' ? connActor(context.conn) : await deps.actor(params.sessionId, context)
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(40_000)])
    const work = (active: AbortSignal) => service.execute(params, actor, active)
    return params.action === 'list' ? work(signal) : deps.serialize(params.sessionId!, signal, work)
  })
}
