import { refinementFacade } from '@agnes/core'
import { rpcError, type SessionRefineResult, type SessionRefineRollbackResult } from '@agnes/protocol'
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

/**
 * The owner's withdrawal of one applied refinement of a session this process holds (`appliedSeq`, the
 * seq of its applied row, as the timeline shows it). It is written as a new refinement that undoes
 * the old one, only if every entry it wrote is still as it left it; it works while refinement is off.
 * A withdrawal the session cannot take is refused with the reason and writes nothing: `changed-since`
 * (with the entries changed later; a person has to decide), `not-found`, `not-applied`,
 * `is-rollback`, `rejected`, `child-session` or `closing`. A repeat returns the first withdrawal.
 */
export async function rollbackRefinement(
  session: HostSession,
  appliedSeq: number,
): Promise<SessionRefineRollbackResult> {
  const outcome = await refinementFacade(session).rollback(appliedSeq)
  if ('refused' in outcome)
    throw rpcError('SEMANTIC_REJECTED', {
      reason: outcome.refused,
      ...(outcome.changed === undefined ? {} : { changed: outcome.changed.map((e) => `${e.kind}/${e.id}`) }),
    })
  return { seq: outcome.seq }
}

/** A worker's `refine` or `refineRollback` command, read from its params, on the session it holds. */
export function refinementCommand(
  session: HostSession,
  method: 'refine' | 'refineRollback',
  p: Record<string, unknown>,
): Promise<SessionRefineResult | SessionRefineRollbackResult> {
  if (method === 'refine')
    return requestRefinement(session, typeof p.focus === 'string' ? p.focus : undefined)
  if (!Number.isSafeInteger(p.appliedSeq)) throw new TypeError('invalid refineRollback command')
  return rollbackRefinement(session, p.appliedSeq as number)
}
