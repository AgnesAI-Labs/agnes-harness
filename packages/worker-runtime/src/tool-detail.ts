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
type CachedDetail = { key: string; bytes: Buffer; expiresAt: number; timer?: ReturnType<typeof setTimeout> }
const serializedDetails = new Map<LedgerReader, CachedDetail>()

function discardBytes(session: LedgerReader): void {
  const item = serializedDetails.get(session)
  if (!item) return
  if (item.timer) clearTimeout(item.timer)
  serializedDetails.delete(session)
}

function refreshExpiry(session: LedgerReader, item: CachedDetail): void {
  if (item.timer) clearTimeout(item.timer)
  item.expiresAt = Date.now() + CACHE_LIFETIME_MS
  item.timer = setTimeout(() => {
    if (serializedDetails.get(session) === item) serializedDetails.delete(session)
  }, CACHE_LIFETIME_MS)
  item.timer.unref()
}

function cachedBytes(session: LedgerReader, key: string): Buffer | undefined {
  const item = serializedDetails.get(session)
  if (item && item.expiresAt <= Date.now()) {
    discardBytes(session)
    return undefined
  }
  if (!item || item.key !== key) return undefined
  // Refresh recency while the SDK pages through a large result.
  serializedDetails.delete(session)
  refreshExpiry(session, item)
  serializedDetails.set(session, item)
  return item.bytes
}

function rememberBytes(session: LedgerReader, key: string, bytes: Buffer): void {
  discardBytes(session)
  const item: CachedDetail = { key, bytes, expiresAt: 0 }
  refreshExpiry(session, item)
  serializedDetails.set(session, item)
  while (serializedDetails.size > CACHE_ENTRIES) {
    const oldest = serializedDetails.keys().next().value
    if (oldest === undefined) break
    discardBytes(oldest)
  }
}

/** Count encoded JSON bytes in bounded string chunks before allocating the full payload. */
function detailFitsByteLimit(detail: { call: ToolCall; result?: ToolResult }): boolean {
  let remaining = MAX_DETAIL_BYTES
  const take = (size: number): boolean => {
    remaining -= size
    return remaining >= 0
  }
  const stringFits = (value: string): boolean => {
    if (!take(2)) return false // quotes
    for (let start = 0; start < value.length; ) {
      let end = Math.min(start + 16_384, value.length)
      // Keep a surrogate pair together so each chunk has the same JSON encoding as the whole string.
      if (end < value.length && end > start) {
        const last = value.charCodeAt(end - 1)
        const next = value.charCodeAt(end)
        if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
      }
      if (!take(Buffer.byteLength(JSON.stringify(value.slice(start, end)), 'utf8') - 2)) return false
      start = end
    }
    return true
  }
  const visit = (value: unknown): boolean => {
    if (typeof value === 'string') return stringFits(value)
    if (value === null || typeof value === 'number' || typeof value === 'boolean')
      return take(Buffer.byteLength(JSON.stringify(value), 'utf8'))
    if (Array.isArray(value)) {
      if (!take(2)) return false
      for (let index = 0; index < value.length; index++) {
        if (index > 0 && !take(1)) return false
        if (!visit(value[index] === undefined ? null : value[index])) return false
      }
      return true
    }
    if (typeof value === 'object' && value !== null) {
      if (!take(2)) return false
      let first = true
      for (const key of Object.keys(value)) {
        const child = (value as Record<string, unknown>)[key]
        if (child === undefined) continue
        if (!first && !take(1)) return false
        first = false
        if (!stringFits(key) || !take(1) || !visit(child)) return false
      }
      return true
    }
    return false
  }
  return visit(detail)
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
    const detail = { call: callData, ...(resultData ? { result: resultData } : {}) }
    if (!detailFitsByteLimit(detail)) return { ok: false, reason: 'detail-too-large' }
    bytes = Buffer.from(JSON.stringify(detail))
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
