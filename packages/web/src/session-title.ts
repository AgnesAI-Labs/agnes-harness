/** Use persisted metadata before a provisional label, consistently across header and navigation. */
export function sessionTitle(saved: string | undefined, prompt?: string): string {
  return saved || (prompt ? Array.from(prompt).slice(0, 56).join('') : '新任务')
}

/** A bounded refresh for a submitted session after its transcript subscription has been detached. */
export function createTitleRefresh(
  refresh: (sessionId: string) => Promise<boolean>,
  options: { intervalMs?: number; attempts?: number } = {},
) {
  const pending = new Map<string, ReturnType<typeof setTimeout> | undefined>()
  const attempted = new Set<string>()
  const stop = (id: string) => {
    const timer = pending.get(id)
    if (timer !== undefined) clearTimeout(timer)
    pending.delete(id)
  }
  return {
    start(id: string) {
      if (pending.has(id) || attempted.has(id)) return
      attempted.add(id)
      pending.set(id, undefined)
      let left = options.attempts ?? 20
      const poll = async () => {
        if (!pending.has(id)) return
        let done = false
        try {
          done = await refresh(id)
        } catch {
          /* reconnect/list remains the recovery path */
        }
        if (!pending.has(id)) return
        if (done || --left <= 0) {
          stop(id)
          return
        }
        pending.set(
          id,
          setTimeout(() => {
            void poll()
          }, options.intervalMs ?? 2000),
        )
      }
      void poll()
    },
    stop,
    close() {
      for (const id of pending.keys()) stop(id)
    },
  }
}
