/** Public reload hints use finite requests so tabs cannot exhaust HTTP/1.1's connection pool.
 * Every hint is revalidated against the authenticated daemon roster by the reconciler. */
import type { ClientReconciler } from './reconcile.js'

type Changes = { epoch: string; cursor: number; reset: boolean; events: { id: string; rev: string }[] }

function changes(value: unknown): Changes {
  if (value === null || typeof value !== 'object') throw new Error('Invalid reload hints')
  const v = value as Changes
  if (
    typeof v.epoch !== 'string' ||
    !Number.isSafeInteger(v.cursor) ||
    v.cursor < 0 ||
    typeof v.reset !== 'boolean' ||
    !Array.isArray(v.events) ||
    v.events.length > 256 ||
    v.events.some((event) => !event || typeof event.id !== 'string' || typeof event.rev !== 'string')
  )
    throw new Error('Invalid reload hints')
  return v
}

/** One request/reload queue per page. Close cancels I/O and prevents any new work. */
export function startPluginHotReload(options: {
  reconciler: ClientReconciler
  fetch?: typeof globalThis.fetch
  url?: string
  intervalMs?: number
  onReset?: () => void
  onError?: (error: unknown) => void
}): () => void {
  const fetchHints = options.fetch ?? globalThis.fetch.bind(globalThis)
  const lifetime = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let epoch: string | undefined
  let cursor = 0
  const poll = async () => {
    try {
      const query = epoch === undefined ? '' : `?epoch=${encodeURIComponent(epoch)}&cursor=${cursor}`
      const response = await fetchHints((options.url ?? '/plugins/changes') + query, {
        cache: 'no-store',
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]),
      })
      if (!response.ok) throw new Error(`Reload hints: HTTP ${response.status}`)
      const next = changes(await response.json())
      if (lifetime.signal.aborted) return
      if (next.reset) {
        // A restart or an overflow can lose same-revision rebuild hints. A fresh document
        // reacquires all assets; roster invalidation alone can reuse stale ESM namespaces.
        ;(options.onReset ?? (() => window.location.reload()))()
        return
      }
      for (const event of next.events) {
        if (lifetime.signal.aborted) return
        try {
          await options.reconciler.reload(event.id, event.rev)
        } catch (error) {
          options.onError?.(error) ?? console.warn('[client-modules] 热替换失败', error)
        }
      }
      epoch = next.epoch
      cursor = next.cursor
    } catch (error) {
      if (!lifetime.signal.aborted) options.onError?.(error)
    } finally {
      if (!lifetime.signal.aborted) timer = setTimeout(() => void poll(), options.intervalMs ?? 1000)
    }
  }
  void poll()
  return () => {
    lifetime.abort()
    clearTimeout(timer)
  }
}
