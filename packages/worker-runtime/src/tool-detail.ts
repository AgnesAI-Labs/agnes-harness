import type { EventEnvelope, ToolCall, ToolResult } from '@agnes/protocol'

/** Small enough that base64 and the JSON-RPC envelope stay below the WebSocket's 2 MiB limit. */
export const TOOL_DETAIL_PAGE_BYTES = 256 * 1024

export type ToolDetailRead = {
  callSeq: number
  resultSeq?: number
  offset: number
  maxBytes: number
}

export type ToolDetailPage = {
  callSeq: number
  resultSeq?: number
  offset: number
  totalBytes: number
  data: string
  nextOffset: number | null
}

export type ToolDetailReadResult =
  | { ok: true; page: ToolDetailPage }
  | {
      ok: false
      reason:
        | 'call-not-found'
        | 'result-not-found'
        | 'tool-use-id-mismatch'
        | 'offset-out-of-range'
        | 'detail-too-large'
    }

type LedgerReader = Pick<
  {
    scan(q: { fromSeq: number; toSeq: number; limit: number }): Promise<readonly EventEnvelope[]>
  },
  'scan'
>

const MAX_DETAIL_BYTES = 64 * 1024 * 1024
const CACHE_LIFETIME_MS = 30_000
const CACHE_ENTRIES = 2
const serializedDetails = new Map<LedgerReader, { key: string; bytes: Buffer; expiresAt: number }>()

function cachedBytes(session: LedgerReader, key: string): Buffer | undefined {
  const now = Date.now()
  for (const [reader, value] of serializedDetails)
    if (value.expiresAt <= now) serializedDetails.delete(reader)
  const item = serializedDetails.get(session)
  if (!item || item.key !== key) return undefined
  // Refresh recency while the SDK pages through a large result.
  serializedDetails.delete(session)
  serializedDetails.set(session, { ...item, expiresAt: now + CACHE_LIFETIME_MS })
  return item.bytes
}

function rememberBytes(session: LedgerReader, key: string, bytes: Buffer): void {
  serializedDetails.delete(session)
  serializedDetails.set(session, { key, bytes, expiresAt: Date.now() + CACHE_LIFETIME_MS })
  while (serializedDetails.size > CACHE_ENTRIES) {
    const oldest = serializedDetails.keys().next().value
    if (oldest === undefined) break
    serializedDetails.delete(oldest)
  }
}

/** Read the exact durable rows and serialize inside the worker, so large rows never cross its frame. */
export async function readToolDetailPage(
  session: LedgerReader,
  input: ToolDetailRead,
): Promise<ToolDetailReadResult> {
  const key = `${input.callSeq}:${input.resultSeq ?? ''}`
  let bytes = cachedBytes(session, key)
  if (!bytes) {
    const [call] = await session.scan({ fromSeq: input.callSeq, toSeq: input.callSeq, limit: 1 })
    if (!call || call.seq !== input.callSeq || call.type !== 'tool/call')
      return { ok: false, reason: 'call-not-found' }
    const callData = call.data as ToolCall
    let resultData: ToolResult | undefined
    if (input.resultSeq !== undefined) {
      const [result] = await session.scan({ fromSeq: input.resultSeq, toSeq: input.resultSeq, limit: 1 })
      if (!result || result.seq !== input.resultSeq || result.type !== 'tool/result')
        return { ok: false, reason: 'result-not-found' }
      resultData = result.data as ToolResult
      if (resultData.toolUseId !== callData.toolUseId) return { ok: false, reason: 'tool-use-id-mismatch' }
    }
    bytes = Buffer.from(JSON.stringify({ call: callData, ...(resultData ? { result: resultData } : {}) }))
    if (bytes.byteLength > MAX_DETAIL_BYTES) return { ok: false, reason: 'detail-too-large' }
    rememberBytes(session, key, bytes)
  }
  if (input.offset > bytes.byteLength) return { ok: false, reason: 'offset-out-of-range' }
  const next = Math.min(bytes.byteLength, input.offset + input.maxBytes)
  return {
    ok: true,
    page: {
      callSeq: input.callSeq,
      ...(input.resultSeq === undefined ? {} : { resultSeq: input.resultSeq }),
      offset: input.offset,
      totalBytes: bytes.byteLength,
      data: bytes.subarray(input.offset, next).toString('base64'),
      nextOffset: next < bytes.byteLength ? next : null,
    },
  }
}
