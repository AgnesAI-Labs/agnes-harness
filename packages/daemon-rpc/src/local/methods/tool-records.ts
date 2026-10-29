import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { HostSession } from '@agnes/host'
import { rpcError, type SessionDeliverablesParams, type SessionReadToolDetailParams } from '@agnes/protocol'
import {
  DELIVERABLES_DEFAULT_LIMIT,
  type DeliverablesRead,
  type DeliverablesReadResult,
  readDeliverablesPage,
  readToolDetailPage,
  TOOL_DETAIL_PAGE_BYTES,
  type ToolDetailRead,
  type ToolDetailReadResult,
} from '@agnes/worker-runtime'

/** A worker-backed session reads in the worker; an in-process one is read here, beside its ledger. */
type RecordReads = HostSession & {
  readToolDetailPage?: (input: ToolDetailRead) => Promise<ToolDetailReadResult>
  readDeliverablesPage?: (input: DeliverablesRead) => Promise<DeliverablesReadResult>
}

/** Owner-only reads of durable tool records, served from the ledger without a UI projection. */
export function registerToolRecordReads(
  ep: LocalEndpoint,
  cx: { registry: { require(key: string): { session: HostSession } } },
  requireOwner: (method: string, sessionId: string, context: CallContext) => void,
): void {
  ep.register('_agnes/v1/session.readToolDetail', async (params, c) => {
    const p = params as SessionReadToolDetailParams
    requireOwner('session.readToolDetail', p.sessionId, c)
    const offset = p.offset ?? 0
    const maxBytes = p.maxBytes ?? TOOL_DETAIL_PAGE_BYTES
    if (
      !Number.isSafeInteger(p.callSeq) ||
      p.callSeq < 1 ||
      (p.resultSeq !== undefined && (!Number.isSafeInteger(p.resultSeq) || p.resultSeq <= p.callSeq)) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > TOOL_DETAIL_PAGE_BYTES
    )
      throw rpcError('INVALID_PARAMS', { reason: 'invalid tool detail bounds' })
    const entry = cx.registry.require(p.sessionId)
    const input: ToolDetailRead = {
      callSeq: p.callSeq,
      ...(p.resultSeq === undefined ? {} : { resultSeq: p.resultSeq }),
      offset,
      maxBytes,
    }
    const session = entry.session as RecordReads
    const outcome = session.readToolDetailPage
      ? await session.readToolDetailPage(input)
      : await readToolDetailPage(session, input)
    if (!outcome.ok) throw rpcError('INVALID_PARAMS', { reason: outcome.reason })
    return { sessionId: p.sessionId, ...outcome.page }
  })
  ep.register('_agnes/v1/session.deliverables', async (params, c) => {
    const p = params as SessionDeliverablesParams
    requireOwner('session.deliverables', p.sessionId, c)
    // The method schema bounds both values before a handler runs.
    const input = { afterSeq: p.afterSeq ?? 0, limit: p.limit ?? DELIVERABLES_DEFAULT_LIMIT }
    const session = cx.registry.require(p.sessionId).session as RecordReads
    const outcome = session.readDeliverablesPage
      ? await session.readDeliverablesPage(input)
      : await readDeliverablesPage(session, input)
    if (!outcome.ok) throw rpcError('INVALID_PARAMS', { reason: outcome.reason })
    return { sessionId: p.sessionId, ...outcome.page }
  })
}
