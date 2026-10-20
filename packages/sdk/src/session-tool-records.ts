import {
  type SessionDeliverablesParams,
  type SessionDeliverablesResult,
  type SessionReadToolDetailResult,
  type ToolCall,
  type ToolResult,
  validateAgainst,
} from '@agnes/protocol'
import { ToolCall as ToolCallSchema, ToolResult as ToolResultSchema } from '@agnes/protocol/gen/session-v1'
import type { Client } from './client.js'
import { ProtocolViolation } from './errors.js'

export type ToolDetail = { call: ToolCall; result?: ToolResult }
export type DeliverablesOptions = Pick<SessionDeliverablesParams, 'afterSeq' | 'limit'>

/** Reads one durable tool call and its optional result in bounded pages and checks the reassembled record. */
export async function readToolDetail(
  client: Client,
  sessionId: string,
  callSeq: number,
  resultSeq: number | undefined,
  opts: { signal?: AbortSignal },
): Promise<ToolDetail> {
  let complete: Uint8Array | undefined
  let offset = 0
  let totalBytes: number | undefined
  for (;;) {
    opts.signal?.throwIfAborted()
    const page = await client.call<SessionReadToolDetailResult>('_agnes/v1/session.readToolDetail', {
      sessionId,
      callSeq,
      ...(resultSeq === undefined ? {} : { resultSeq }),
      offset,
    })
    opts.signal?.throwIfAborted()
    if (
      page.sessionId !== sessionId ||
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

/**
 * A deliverables page must continue the request: results after `afterSeq` in ascending order and no
 * later than `upto`, at most `limit` of them, and a continuation only at the end of a non-empty page.
 */
export function checkDeliverablesPage(
  params: SessionDeliverablesParams,
  page: SessionDeliverablesResult,
): SessionDeliverablesResult {
  let previous = params.afterSeq ?? 0
  for (const item of page.items) {
    if (item.callSeq >= item.resultSeq || item.resultSeq <= previous || item.resultSeq > page.upto)
      throw new ProtocolViolation('invalid deliverables response: item order')
    previous = item.resultSeq
  }
  if (
    page.sessionId !== params.sessionId ||
    page.upto < (params.afterSeq ?? 0) ||
    (params.limit !== undefined && page.items.length > params.limit) ||
    (page.nextAfterSeq !== undefined &&
      (page.items.length === 0 || page.nextAfterSeq !== previous || page.nextAfterSeq !== page.upto))
  )
    throw new ProtocolViolation('invalid deliverables response: coordinates mismatch')
  return page
}
