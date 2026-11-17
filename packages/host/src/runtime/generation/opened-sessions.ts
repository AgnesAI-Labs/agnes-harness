import type { Kernel } from '@agnes/core'

type OpenedListener = Parameters<Kernel['onSessionOpened']>[0]

/** Fans the sessions opened by any watched host's kernel out to one set of listeners. */
export function createOpenedSessionsRelay(): {
  /** Starts relaying the host's opened sessions; returns the same host. */
  watch<H extends { kernel: Pick<Kernel, 'onSessionOpened'> }>(host: H): H
  onSessionOpened: Kernel['onSessionOpened']
} {
  const listeners = new Set<OpenedListener>()
  return {
    watch: (host) => {
      host.kernel.onSessionOpened((session) => {
        for (const listener of [...listeners]) {
          try {
            listener(session)
          } catch {
            // A listener must not disturb session creation.
          }
        }
      })
      return host
    },
    onSessionOpened: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
