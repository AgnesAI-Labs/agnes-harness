import type { SessionImpl } from '@agnes/core'

function genuineInput(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const item = value as { kind?: string; origin?: string; actor?: { role?: string } }
  return (
    (item.kind === 'prompt' || item.kind === 'steer') &&
    item.origin !== 'system' &&
    typeof item.actor?.role === 'string' &&
    item.actor.role !== 'extension'
  )
}

/** New human input wins over a stopping hook, without cancelling the running session. */
export async function withStoppingInputSignal<T>(
  session: SessionImpl,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const inspect = (data: unknown) => {
    const items = (data as { items?: unknown[] } | undefined)?.items
    if (Array.isArray(items) && items.some(genuineInput)) controller.abort()
  }
  // Subscribe first, then inspect the current register: neither the setup gap nor an already
  // queued prompt can allow a late continuation to outrun the person's request.
  const off = session.onAppended((events) => {
    for (const event of events) if (event.type === 'inbox' && event.lane === session.lane) inspect(event.data)
  })
  try {
    inspect(session.latest('inbox'))
    return await run(AbortSignal.any([session.ac.signal, controller.signal]))
  } finally {
    off()
    controller.abort()
  }
}
