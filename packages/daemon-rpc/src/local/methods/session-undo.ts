import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { type Actor, rpcError } from '@agnes/protocol'
import { sessionUndo, sessionUndoPreview, type UndoPreview, type UndoResult } from '@agnes/worker-runtime'

/** A worker-backed session undoes in its worker; an in-process one is undone here, beside its ledger. */
type UndoSession = Parameters<typeof sessionUndo>[0] & {
  undoPreview?: (input: { turn?: number }) => Promise<UndoPreview>
  undo?: (input: {
    turn: number
    commandId: string
    admissionId: string
    actor: Actor
  }) => Promise<UndoResult>
}

const undoPreviewOf = (session: unknown, input: { turn?: number }): Promise<UndoPreview> => {
  const target = session as UndoSession
  return target.undoPreview ? target.undoPreview(input) : sessionUndoPreview(target, input)
}

export const undoOf = (
  session: unknown,
  input: { turn: number; commandId: string; admissionId: string; actor: Actor },
): Promise<UndoResult> => {
  const target = session as UndoSession
  return target.undo ? target.undo(input) : sessionUndo(target, input)
}

export { undoResultFromFact } from '@agnes/worker-runtime'

type Submit = (
  clientId: string,
  commandId: string,
  kind: string,
  payload: Record<string, unknown>,
  c: CallContext,
) => Promise<{ status?: string; result?: unknown }>

/** Both methods are owner-only; undo goes through submit, which owns exactly-once for a commandId. */
export function registerSessionUndo(
  ep: LocalEndpoint,
  registry: { require(sessionId: string): { session: unknown } },
  requireOwner: (method: string, sessionId: string, c: CallContext) => void,
  submit: Submit,
): void {
  ep.register('_agnes/v1/session.undo.preview', async (params, c) => {
    const p = params as { sessionId: string; turn?: number }
    requireOwner('session.undo.preview', p.sessionId, c)
    return undoPreviewOf(registry.require(p.sessionId).session, p.turn === undefined ? {} : { turn: p.turn })
  })
  ep.register('_agnes/v1/session.undo', async (params, c) => {
    const { commandId, ...payload } = params as { sessionId: string; turn: number; commandId: string }
    const ack = await submit(c.conn.clientId, commandId, 'undo', payload, c)
    if (ack.status === 'uncertain') throw rpcError('INTERNAL_ERROR', { code: 'UNCERTAIN' })
    return ack.result
  })
}
