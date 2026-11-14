import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { ManagedInputResult } from '@agnes/extension-api'
import {
  type ManagedInputDecideParams,
  type ManagedInputDecideResult,
  type ManagedInputGetParams,
  type ManagedInputGetResult,
  rpcError,
} from '@agnes/protocol'
import type { ManagedInputRow } from './managed-session-inputs.js'

/** What the review RPC reads and decides through: the owner input engine's `review` and `decide`. */
export interface ManagedInputReviewEngine {
  review(
    sessionId: string,
    key: string,
  ):
    | { input: ManagedInputRow; binding: { taskId: string; taskGeneration: number; startKey: string } }
    | undefined
  decide(
    sessionId: string,
    key: string,
    decision: 'deliver' | 'retain' | 'discard',
    expectVersion: number,
  ): Promise<ManagedInputResult>
}

/** The worker's `channels.receipts` command for one receipt owner. */
export type ReceiptCommand =
  | { op: 'parked'; owner: string }
  | { op: 'redeliver' | 'discard'; owner: string; receiptId: string }

export interface ManagedInputReviewDeps {
  engine: ManagedInputReviewEngine
  /** The durable session-owner gate (`requireSessionOwner`). */
  requireOwner(method: string, sessionId: string, context: CallContext): void
  /** The channel receipt owner of the managed service that holds this session; undefined for any other session. */
  receiptOwner(sessionId: string): string | undefined
  receipts(command: ReceiptCommand): Promise<unknown>
}

/** The result carries at most this many history entries (newest kept) and parked receipts. */
const LIST_LIMIT = 256

/**
 * Only the owner, at the owner's own Web page, reads or decides an owner input. The page is the
 * connection that came through the local Web listener with the local credential. A bundled app's
 * local SDK client holds the same credential but opens the Unix socket, so it is refused here, as is
 * every remote or Surface identity; plugins have no client connection at all.
 */
function requireOwnerPage(method: string, context: CallContext): void {
  const conn = context.conn
  if (conn.authKind !== 'local' || conn.credentialKind !== 'local' || conn.localListener !== 'web')
    throw rpcError('CAPABILITY_DENIED', { method, reason: 'owner web page required' })
}

function view(review: NonNullable<ReturnType<ManagedInputReviewEngine['review']>>) {
  const input = review.input
  return {
    key: input.key,
    kind: input.kind,
    state: input.state,
    reason: input.reason,
    version: input.version,
    text: input.text,
    source: input.source,
    binding: review.binding,
    ...(input.consumedTurn === null ? {} : { turn: input.consumedTurn }),
    ...(input.consumedSeq === null ? {} : { seq: input.consumedSeq }),
    history: input.history.slice(-LIST_LIMIT).map((entry) => ({
      version: entry.version,
      state: entry.state,
      reason: entry.reason,
      at: new Date(entry.at).toISOString(),
      by: entry.by,
    })),
  }
}

function parked(value: unknown): ManagedInputGetResult['parkedReceipts'] {
  const receipts = (value as { receipts?: unknown } | null)?.receipts
  if (!Array.isArray(receipts)) throw rpcError('INTERNAL_ERROR', { code: 'RECEIPTS_UNAVAILABLE' })
  return receipts.slice(0, LIST_LIMIT).map((receipt: ManagedInputGetResult['parkedReceipts'][number]) => ({
    receiptId: receipt.receiptId,
    service: receipt.service,
    kind: receipt.kind,
    text: receipt.text,
    at: receipt.at,
    attempts: receipt.attempts,
  }))
}

export function registerManagedInputReview(ep: LocalEndpoint, deps: ManagedInputReviewDeps): void {
  ep.register('_agnes/v1/managedInput.get', async (params, context): Promise<ManagedInputGetResult> => {
    const { sessionId, key } = params as ManagedInputGetParams
    requireOwnerPage('managedInput.get', context)
    deps.requireOwner('managedInput.get', sessionId, context)
    const review = deps.engine.review(sessionId, key)
    const owner = deps.receiptOwner(sessionId)
    return {
      input: review ? view(review) : null,
      parkedReceipts: owner ? parked(await deps.receipts({ op: 'parked', owner })) : [],
    }
  })
  ep.register('_agnes/v1/managedInput.decide', async (params, context): Promise<ManagedInputDecideResult> => {
    const { sessionId, target } = params as ManagedInputDecideParams
    requireOwnerPage('managedInput.decide', context)
    deps.requireOwner('managedInput.decide', sessionId, context)
    if (target.kind === 'receipt') {
      const owner = deps.receiptOwner(sessionId)
      if (!owner) throw rpcError('SEMANTIC_REJECTED', { code: 'RECEIPT_NOT_PARKED' })
      const settled = await deps.receipts({ op: target.decision, owner, receiptId: target.receiptId })
      const receipt = (settled as { receipt?: unknown } | null)?.receipt
      if (receipt !== 'pending' && receipt !== 'discarded')
        throw rpcError('INTERNAL_ERROR', { code: 'RECEIPTS_UNAVAILABLE' })
      return { receipt }
    }
    // The decision applies to the version the owner was shown, never to one that changed since.
    const current = deps.engine.review(sessionId, target.key)?.input.version
    if (current === undefined) throw rpcError('SEMANTIC_REJECTED', { code: 'INPUT_NOT_FOUND' })
    if (current !== target.version)
      throw rpcError('SEMANTIC_REJECTED', { code: 'VERSION_CHANGED', version: current })
    const result = await deps.engine.decide(sessionId, target.key, target.decision, target.version)
    if (!('version' in result)) throw rpcError('INTERNAL_ERROR', { code: 'INPUT_STATE_UNAVAILABLE' })
    return { state: result.state, version: result.version }
  })
}
