import {
  type SessionReadToolDetailResult,
  type ToolCall,
  type ToolResult,
  validateAgainst,
} from '@agnes/protocol'
import { ToolCall as ToolCallSchema, ToolResult as ToolResultSchema } from '@agnes/protocol/gen/session-v1'
import { ProtocolViolation } from './errors.js'
import type { ToolDetail } from './session.js'

/** Shared bounded decoder; each caller validates its own session or comparison coordinates. */
export async function readToolDetailPages(
  callSeq: number,
  resultSeq: number | undefined,
  readPage: (offset: number) => Promise<Omit<SessionReadToolDetailResult, 'sessionId'>>,
  opts: { signal?: AbortSignal } = {},
): Promise<ToolDetail> {
  let complete: Uint8Array | undefined
  let offset = 0
  let totalBytes: number | undefined
  for (;;) {
    opts.signal?.throwIfAborted()
    const page = await readPage(offset)
    opts.signal?.throwIfAborted()
    if (
      page.callSeq !== callSeq ||
      page.resultSeq !== resultSeq ||
      page.offset !== offset ||
      (totalBytes !== undefined && page.totalBytes !== totalBytes)
    )
      throw new ProtocolViolation('invalid tool detail response: coordinates mismatch')
    if (!Number.isSafeInteger(page.totalBytes) || page.totalBytes > 64 * 1024 * 1024)
      throw new ProtocolViolation('invalid tool detail response: total byte limit')
    totalBytes = page.totalBytes
    complete ??= new Uint8Array(totalBytes)
    let binary: string
    try {
      binary = atob(page.data)
    } catch {
      throw new ProtocolViolation('invalid tool detail response: base64')
    }
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    if (
      bytes.byteLength > 256 * 1024 ||
      offset + bytes.byteLength > totalBytes ||
      page.nextOffset !== (offset + bytes.byteLength < totalBytes ? offset + bytes.byteLength : null) ||
      (page.nextOffset !== null && bytes.byteLength === 0)
    )
      throw new ProtocolViolation('invalid tool detail response: page bounds')
    complete.set(bytes, offset)
    if (page.nextOffset === null) break
    offset = page.nextOffset
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(complete))
  } catch {
    throw new ProtocolViolation('invalid tool detail response: JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new ProtocolViolation('invalid tool detail response: shape')
  const detail = parsed as Record<string, unknown>
  const keys = Object.keys(detail).sort().join(',')
  if (keys !== (resultSeq === undefined ? 'call' : 'call,result'))
    throw new ProtocolViolation('invalid tool detail response: fields')
  if (
    !validateAgainst(ToolCallSchema, detail.call).ok ||
    (resultSeq !== undefined && !validateAgainst(ToolResultSchema, detail.result).ok)
  )
    throw new ProtocolViolation('invalid tool detail response: event data')
  const call = detail.call as ToolCall
  const result = detail.result as ToolResult | undefined
  if (result && result.toolUseId !== call.toolUseId)
    throw new ProtocolViolation('invalid tool detail response: tool identity')
  return { call, ...(result ? { result } : {}) }
}
