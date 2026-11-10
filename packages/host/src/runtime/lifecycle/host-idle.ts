import { HostError } from '@agnes/host-common/errors'
import type { Host, HostOptions } from './host.js'

// Private ownership metadata, deliberately absent from the Host facade's method dispatch surface.
const probes = new WeakMap<Host, () => boolean>()

export function registerHostIdle(host: Host, probe: () => boolean): Host {
  probes.set(host, probe)
  return host
}

/** Unknown containers cannot prove that their sessions and retained invocations have drained. */
export function hostIsIdle(host: Host): boolean {
  return probes.get(host)?.() ?? false
}

/** Both generation and composition containers use the existing deployment idle policy. */
export function generationIdleMs(limits: Readonly<Record<string, unknown>>): number {
  const value = limits['worker.generation_idle_close_ms']
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 60_000
}

/** Serial admission is also an ownership lease, including callers waiting in the queue. */
export function createHostCallQueue(isClosed: () => boolean) {
  let tail: Promise<unknown> = Promise.resolve()
  let pending = 0
  return {
    get pending() {
      return pending
    },
    drain: () => tail,
    enqueue<T>(run: () => Promise<T>): Promise<T> {
      if (isClosed()) return Promise.reject(new HostError('E_HOST_CLOSED', 'host is closed'))
      pending++
      const next = tail.then(() => {
        if (isClosed()) throw new HostError('E_HOST_CLOSED', 'host is closed')
        return run()
      })
      tail = next.catch(() => undefined)
      return next.finally(() => {
        pending--
      })
    },
  }
}

/** Caller serializes admission; durable pins outlive these in-memory containers. */
export async function collectIdleContainers<T extends { host: Host }>(
  containers: Map<string, T>,
  keep: T,
  idleSince: Map<T, number>,
  idleMs: number,
): Promise<void> {
  const now = Date.now()
  const errors: unknown[] = []
  for (const [hash, container] of containers) {
    if (container === keep || !hostIsIdle(container.host)) {
      idleSince.delete(container)
      continue
    }
    const since = idleSince.get(container) ?? now
    idleSince.set(container, since)
    if (now - since < idleMs) continue
    try {
      await container.host.close()
    } catch (error) {
      errors.push(error)
    } finally {
      // close seals admission even on teardown failure. Cold opens must rebuild the binding.
      containers.delete(hash)
      idleSince.delete(container)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'composition collection failed')
}

/**
 * Collection on one timer for the earliest idle deadline, as in the generation Host, with no periodic
 * work. A container's idle period starts when it opens or loses its last live session; one that
 * collection finds busy (its calls still draining) is checked again within a second.
 */
export function createIdleCollection<T extends { host: Host }>(
  input: Readonly<{
    containers: Map<string, T>
    keep: () => T
    idleSince: Map<T, number>
    idleMs: number
    enqueue: (run: () => Promise<void>) => Promise<void>
    closed: () => boolean
    log: HostOptions['log']
    afterCollect: () => void
  }>,
) {
  const { containers, idleSince, idleMs } = input
  let timer: ReturnType<typeof setTimeout> | undefined
  const sessionless = (container: T) =>
    container !== input.keep() &&
    ![...container.host.kernel.sessions.values()].some((session) => !session.closingOrClosed)
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const busy = [...containers.values()].some(
      (container) => !idleSince.has(container) && sessionless(container),
    )
    if (input.closed() || (!idleSince.size && !busy)) return
    const next = Math.min(...idleSince.values()) + idleMs - Date.now()
    timer = setTimeout(
      () => {
        timer = undefined
        void input
          .enqueue(collect)
          .catch((error) => input.log.warn('Composition collection failed', { error: String(error) }))
      },
      Math.min(2_147_483_647, Math.max(1, Math.min(next, busy ? 1000 : Infinity))),
    )
    timer.unref()
  }
  const collect = () =>
    collectIdleContainers(containers, input.keep(), idleSince, idleMs).finally(() => {
      input.afterCollect()
      arm()
    })
  return {
    /** Collects now; the caller serializes admission. */
    collect,
    idleNow(): void {
      for (const container of containers.values())
        if (!idleSince.has(container) && sessionless(container)) idleSince.set(container, Date.now())
      arm()
    },
    stop(): void {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
