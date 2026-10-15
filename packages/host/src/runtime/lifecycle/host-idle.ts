import { HostError } from '@agnes/host-common/errors'
import type { Host } from './host.js'

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
