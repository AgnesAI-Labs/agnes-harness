import { refinementFacade, saveToWorkspace } from '@agnes/core'
import {
  rpcError,
  type SessionRefineResult,
  type SessionRefineRollbackResult,
  type SessionRefineSaveResult,
} from '@agnes/protocol'
import type { HostSession } from '../lifecycle/host.js'

const ENTRY_KINDS = new Set(['prompt', 'memory', 'skill', 'subagent'])
type EntryKind = 'prompt' | 'memory' | 'skill' | 'subagent'

/**
 * The user's own request for a refinement review of a session this process holds. It queues a plan
 * from the session's latest task and returns at once; a request the session cannot take is
 * refused with the reason and writes nothing. With `saveTo: 'workspace'` (`/refine --workspace`) the
 * applied result is also saved to the session's workspace, as the user's save. Callers reach this
 * only on the owner's request: the save it leads to may override a revocation. On a planning model with
 * no known price the request is refused `unpriced` unless the owner agreed to the unknown price
 * (`allowUnpriced`); a model priced at zero is a known price.
 */
export async function requestRefinement(
  session: HostSession,
  focus?: string,
  saveTo?: 'workspace',
  allowUnpriced?: boolean,
): Promise<SessionRefineResult> {
  const outcome = await refinementFacade(session).request({
    kind: 'manual',
    seq: session.lastSeq,
    ...(focus === undefined ? {} : { focus }),
    ...(saveTo === undefined ? {} : { saveTo }),
    ...(allowUnpriced === true ? { allowUnpriced: true as const } : {}),
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

/**
 * The owner's save of one refinement entry of a session this process holds into the session's
 * workspace (the per-entry "save to workspace"). No model is called: the entry goes to the host's one
 * save path as the user's save, judged in its fixed order, and the receipt comes back whatever the
 * verdict (a refusal, `refinement-off` included, is a receipt). An entry that is not there, or a host
 * without a save path, is refused with the reason and writes nothing. Callers reach this only on the
 * owner's request: the save may override a revocation.
 */
export async function saveEntryToWorkspace(
  session: HostSession,
  entry: { kind: EntryKind; id: string },
): Promise<SessionRefineSaveResult> {
  const outcome = await saveToWorkspace(session, { initiator: 'user', kind: entry.kind, id: entry.id })
  if ('refused' in outcome) throw rpcError('SEMANTIC_REJECTED', { reason: outcome.refused })
  return { receipt: outcome.receipt }
}

/** A worker's `refine`, `refineRollback` or `refineSave` command, read from its params, on the session it holds. */
export function refinementCommand(
  session: HostSession,
  method: 'refine' | 'refineRollback' | 'refineSave',
  p: Record<string, unknown>,
): Promise<SessionRefineResult | SessionRefineRollbackResult | SessionRefineSaveResult> {
  if (method === 'refine')
    return requestRefinement(
      session,
      typeof p.focus === 'string' ? p.focus : undefined,
      p.saveTo === 'workspace' ? 'workspace' : undefined,
      p.allowUnpriced === true,
    )
  if (method === 'refineSave') {
    if (!ENTRY_KINDS.has(String(p.kind)) || typeof p.id !== 'string')
      return Promise.reject(new TypeError('invalid refineSave command'))
    return saveEntryToWorkspace(session, { kind: p.kind as EntryKind, id: p.id })
  }
  if (!Number.isSafeInteger(p.appliedSeq)) throw new TypeError('invalid refineRollback command')
  return rollbackRefinement(session, p.appliedSeq as number)
}
