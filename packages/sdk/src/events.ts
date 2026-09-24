export type Disposer = () => void

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
    for (const h of [...(this.handlers.get(event) ?? [])]) h(payload)
  }
}
