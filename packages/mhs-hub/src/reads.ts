import { type Json, MhsError, object, type Source } from '@agnes/mhs-device'

export type Sample = { at: number; data: Json; bytes?: Uint8Array; mime?: string }
export interface ReadOptions {
  /** Hub receive time in milliseconds; only strictly newer samples satisfy a read. */
  since?: number
  history?: boolean
  cursor?: number
  limit?: number
  timeoutMs?: number
  signal?: AbortSignal
}
export type ReadItem = Sample & { source: string; history?: Sample[]; nextCursor?: number }
export async function readSource(
  source: Source,
  get: () => Sample[],
  subscribe: (wake: () => void) => () => void,
  now: () => number,
  options: ReadOptions,
  getHistory: () => Sample[] = get,
): Promise<ReadItem> {
  const fresh = () => {
    const latest = get().at(-1)
    return latest && (options.since === undefined ? now() - latest.at <= 10_000 : latest.at > options.since)
  }
  if (!fresh())
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer)
        off()
        options.signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }
      const abort = () => finish(options.signal?.reason ?? new MhsError('cancelled'))
      const off = subscribe(() => {
        if (fresh()) finish()
      })
      const timer = setTimeout(() => finish(), options.timeoutMs ?? 2000)
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
      else if (fresh()) finish()
    })
  options.signal?.throwIfAborted()
  const latest = get().at(-1)
  if (!latest || !fresh())
    return {
      source: source.id,
      at: latest?.at ?? 0,
      data: { state: options.since === undefined ? 'stale' : 'timeout' },
    }
  const copy = structuredClone(latest)
  if (source.kind === 'image') {
    const data = object(copy.data)
    copy.data = { w: Number(data.w), h: Number(data.h) }
  }
  if (!['image', 'grid'].includes(source.kind)) delete copy.bytes
  const history =
    options.history && source.kind === 'values'
      ? getHistory()
          .filter((s) => s.at > (options.cursor ?? -Infinity))
          .slice(0, options.limit ?? 32)
          .map((s) => ({ at: s.at, data: structuredClone(s.data) }))
      : undefined
  return {
    source: source.id,
    ...copy,
    ...(history
      ? {
          history,
          ...(getHistory().some((s) => s.at > (history.at(-1)?.at ?? Infinity))
            ? { nextCursor: history.at(-1)!.at }
            : {}),
        }
      : {}),
  }
}
export function validateRead(options: ReadOptions) {
  for (const key of ['since', 'cursor'] as const)
    if (options[key] !== undefined && !Number.isFinite(options[key])) throw new MhsError('invalid-read')
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 120)
  )
    throw new MhsError('invalid-limit')
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 10_000)
  )
    throw new MhsError('invalid-timeout')
  options.signal?.throwIfAborted()
}
