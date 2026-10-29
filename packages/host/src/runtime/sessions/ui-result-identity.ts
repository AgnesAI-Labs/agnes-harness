import { createHash } from 'node:crypto'
import { scanAll } from '@agnes/core'
import { UI_OWNER } from '@agnes/intelligent-ui-contract'
import { type Actor, jcs, rpcError, type UiActionParams } from '@agnes/protocol'
import type { HostSession } from '../lifecycle/host.js'

// Not an extension event grant. Only the Host can append this trusted admission.
export const UI_ACTION_AUTHENTICATED = 'x/agnes/intelligent-ui/action.authenticated'
function denied(): never {
  throw rpcError('CAPABILITY_DENIED')
}
const digest = (request: unknown) => createHash('sha256').update(jcs(request)).digest('hex')
const boundary = (session: HostSession) => (session.d.log.parent?.boundarySeq ?? 0) + 1

async function admissions(session: HostSession, commandId: string) {
  const rows = await scanAll((query) => session.scan(query), {
    type: UI_ACTION_AUTHENTICATED,
    lane: session.lane,
    fromSeq: boundary(session),
    toSeq: session.lastSeq,
  })
  return rows.filter(
    (row) =>
      row.type === UI_ACTION_AUTHENTICATED &&
      row.lane === session.lane &&
      row.origin === 'system' &&
      row.trust === 'trusted' &&
      (row.data as { commandId?: string }).commandId === commandId,
  )
}

/** Called only by the Host action binding, after provider validation/rate checks, before receipt append. */
export async function authenticateUiAction(
  session: HostSession,
  request: UiActionParams,
  actor: Actor,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const requestHash = digest(request)
  const previous = await admissions(session, request.commandId)
  for (const row of previous) {
    if ((row.data as { requestHash?: string }).requestHash !== requestHash || jcs(row.actor) !== jcs(actor))
      denied()
  }
  signal.throwIfAborted()
  if (previous.length) return
  const { seqs } = await session.append([
    {
      type: UI_ACTION_AUTHENTICATED,
      data: { version: 1, commandId: request.commandId, requestHash },
      actor: structuredClone(actor),
      lane: session.lane,
      origin: 'system',
      trust: 'trusted',
      ignorable: true,
    },
  ])
  if (!seqs[0]) denied()
}

/** A provider's own payload proves correlation, never the identity of the sender. */
export async function actorForUiResult(
  session: HostSession,
  owner: string,
  key: string,
  authenticatedActor: Actor,
  semantic: boolean,
): Promise<Actor> {
  if (!key.startsWith('ui-result:')) denied()
  const commandId = key.slice('ui-result:'.length)
  const rows = await scanAll((query) => session.scan(query), {
    type: `x/${owner}/action.received`,
    lane: session.lane,
    fromSeq: boundary(session),
    toSeq: session.lastSeq,
  })
  const requests = rows
    .filter(
      (row) =>
        row.type === `x/${owner}/action.received` &&
        row.lane === session.lane &&
        row.origin === `ext:${owner}` &&
        row.trust === 'untrusted',
    )
    .map((row) => (row.data as { record?: { request?: UiActionParams } }).record?.request)
    .filter((request): request is UiActionParams => request?.commandId === commandId)
  if (!requests.length) denied()
  if (!semantic) return structuredClone(authenticatedActor)
  if (owner !== UI_OWNER) denied()
  const requestHash = digest(requests[0])
  if (requests.some((request) => digest(request) !== requestHash)) denied()
  let actor: Actor | undefined
  for (const row of await admissions(session, commandId)) {
    const data = row.data as { version?: number; requestHash?: string }
    if (data.version !== 1 || data.requestHash !== requestHash || !row.actor?.id || !row.actor.org) denied()
    if (actor && jcs(actor) !== jcs(row.actor)) denied()
    actor = row.actor
  }
  if (!actor) denied()
  return structuredClone(actor)
}
