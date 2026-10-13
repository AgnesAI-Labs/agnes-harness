import type { HostSession } from '@agnes/host'
import { rpcError } from '@agnes/protocol'

/** Raw bytes per `exportRaw` piece; base64 of this fits one worker frame and one client frame. */
export const EXPORT_RAW_CHUNK_BYTES = 8 * 1024 * 1024
const cache = new WeakMap<object, { seq: number; bytes: Buffer }>()

type ExportSession = Pick<HostSession, 'scan'>

/** One stored row as its JSONL line, served in 8 MiB pieces; the last row read is kept for the next piece. */
export async function exportRawChunk(
  session: ExportSession,
  seq: number,
  offset: number,
): Promise<{ seq: number; base64: string; nextOffset: number | null }> {
  if (!Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(offset) || offset < 0)
    throw rpcError('INVALID_PARAMS', { reason: 'invalid-position' })
  let hit = cache.get(session)
  if (!hit || hit.seq !== seq) {
    const [row] = await session.scan({ fromSeq: seq, toSeq: seq, limit: 1 })
    if (!row) throw rpcError('INVALID_PARAMS', { reason: 'row-not-found', seq })
    hit = { seq, bytes: Buffer.from(`${JSON.stringify(row)}\n`, 'utf8') }
    cache.set(session, hit)
  }
  if (offset > hit.bytes.length) throw rpcError('INVALID_PARAMS', { reason: 'offset-out-of-range', seq })
  const end = Math.min(hit.bytes.length, offset + EXPORT_RAW_CHUNK_BYTES)
  const base64 = hit.bytes.subarray(offset, end).toString('base64')
  if (end === hit.bytes.length) cache.delete(session)
  return { seq, base64, nextOffset: end === hit.bytes.length ? null : end }
}
