/**
 * Same-origin `/plugins/events` consumer.  It is deliberately separate from the authenticated
 * daemon WebSocket: EventSource carries only public reload hints, while every hint is revalidated
 * through the roster RPC by `ClientReconciler.reload`.
 */
import type { ClientReconciler } from './reconcile.js'

type EventListener = (event: { data: string }) => void

export interface PluginEventSource {
  addEventListener(type: 'graph' | 'rebuilt', listener: EventListener): void
  removeEventListener(type: 'graph' | 'rebuilt', listener: EventListener): void
  close(): void
}

export interface PluginEventSourceConstructor {
  new (url: string): PluginEventSource
}

function rebuilt(value: unknown): { id: string; rev: string } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const event = value as { type?: unknown; id?: unknown; rev?: unknown }
  return event.type === 'rebuilt' && typeof event.id === 'string' && typeof event.rev === 'string'
    ? { id: event.id, rev: event.rev }
    : undefined
}

/**
 * Serialize rebuilds.  A graph frame is only a stream-boundary marker; the daemon roster remains
 * the authoritative graph and is fetched for each rebuilt package.  Rejections are swallowed
 * after logging so one broken module cannot permanently poison this queue or the rest of the page.
 */
export function startPluginHotReload(options: {
  reconciler: ClientReconciler
  EventSource?: PluginEventSourceConstructor
  url?: string
  onError?: (error: unknown) => void
}): () => void {
  const EventSourceImpl = options.EventSource ?? window.EventSource
  if (!EventSourceImpl) return () => undefined
  const source = new EventSourceImpl(options.url ?? '/plugins/events')
  let queue: Promise<void> = Promise.resolve()
  const onRebuilt: EventListener = (message) => {
    let event: { id: string; rev: string } | undefined
    try {
      event = rebuilt(JSON.parse(message.data))
    } catch {
      return
    }
    if (!event) return
    queue = queue
      .then(() => options.reconciler.reload(event.id, event.rev))
      .catch((error) => options.onError?.(error) ?? console.warn('[client-modules] 热替换失败', error))
  }
  // Explicitly register the marker so future graph metadata has one deliberate handling point.
  const onGraph: EventListener = () => undefined
  source.addEventListener('rebuilt', onRebuilt)
  source.addEventListener('graph', onGraph)
  return () => {
    source.removeEventListener('rebuilt', onRebuilt)
    source.removeEventListener('graph', onGraph)
    source.close()
  }
}
