import { refinementFacade } from '@agnes/core'
import { rpcError, type SessionRefineResult } from '@agnes/protocol'
import type { HostSession } from '../lifecycle/host.js'

/**
 * The user's own request for a refinement review of a session this process holds. It queues a plan
 * from the session's latest task and returns at once; a request the session cannot take is
 * refused with the reason and writes nothing.
 */
export async function requestRefinement(session: HostSession, focus?: string): Promise<SessionRefineResult> {
  const outcome = await refinementFacade(session).request({
    kind: 'manual',
    seq: session.lastSeq,
    ...(focus === undefined ? {} : { focus }),
  })
  if ('refused' in outcome)
    throw rpcError('SEMANTIC_REJECTED', {
      reason: outcome.refused,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    })
  return { runId: outcome.runId }
}
