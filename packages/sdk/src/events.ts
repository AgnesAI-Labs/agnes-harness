export type Disposer = () => void

/**
 * Call every listener in a snapshot of the set. One that throws is reported under `label` and never
 * stops the ones after it, so a single faulty subscriber cannot leave the rest on stale state.
 */
export function notifyListeners<Args extends readonly unknown[]>(
  listeners: Iterable<(...args: Args) => void>,
  label: string,
  ...args: Args
): void {
  for (const listener of [...listeners]) {
    try {
      listener(...args)
    } catch (error) {
      console.error(`${label} listener failed:`, error)
    }
  }
}

export class Emitter<E extends string> {
  private readonly handlers = new Map<E, Set<(p: unknown) => void>>()

  on(event: E, h: (p: unknown) => void): Disposer {
    const set = this.handlers.get(event) ?? new Set()
    set.add(h)
    this.handlers.set(event, set)
    return () => {
      set.delete(h)
    }
  }

  // Iterate a snapshot: a handler that unsubscribes itself, or subscribes another
  // handler, must not change who receives the event already being delivered.
  emit(event: E, payload: unknown): void {
    notifyListeners(this.handlers.get(event) ?? [], `sdk event ${event}`, payload)
  }
}
