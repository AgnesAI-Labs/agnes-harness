import { readDaemonDiscovery } from '@agnes/daemon'
import { normalizeRpcError, rpcError } from '@agnes/protocol'
import { type Client, unixTransport } from '@agnes/sdk'
import { localPipeFactories } from '../src/boot/pipe-factory.js'
import type { ClientLink, LocalBackend } from './backend.js'

export class DaemonUnavailableError extends Error {
  override name = 'DaemonUnavailableError'
  constructor() {
    super('the local daemon is unavailable')
  }
}

/** The one public body for a request the backend could not take: the `unavailable` class, never `internal`. */
export const daemonUnavailableBody = () => ({
  error: normalizeRpcError(rpcError('SEMANTIC_REJECTED', { code: 'E_HOST_CLOSED' })),
})

export type DaemonLinkTiming = Readonly<{
  /** How long one request may wait for the daemon to come back. */
  windowMs: number
  /** Bound on a single re-attach attempt. */
  attemptMs: number
  baseMs: number
  maxMs: number
  /** After a failed window further requests fail fast for this long instead of waiting again. */
  cooldownMs: number
}>

const TIMING: DaemonLinkTiming = {
  windowMs: 10_000,
  attemptMs: 3_000,
  baseMs: 250,
  maxMs: 2_000,
  cooldownMs: 1_000,
}
const REFRESH_MIN_MS = 500

export type DaemonLink = ClientLink &
  Readonly<{
    /** The latest verified daemon; only `web` and `discovery` change across generations. */
    backend(): LocalBackend
    /** True when every client is usable now; false means `ensure()` has work to do. */
    settled(): boolean
    /** Wait (bounded) for the daemon to be reachable again. False means it is unavailable. */
    ensure(): Promise<boolean>
    /** Pick up a replaced daemon, so the page is handed the current Web address. Never throws. */
    refresh(): Promise<void>
    /** Cancels any reconnect in flight. Leaves no timers behind. */
    close(): Promise<void>
  }>

type Dynamic = Record<string, unknown>
type Slot = { client: Client; replace(): void }

/**
 * The launcher's daemon connection that survives a daemon restart. The SDK treats a daemon's
 * `shutting_down` notice as final, so a long-lived launcher would otherwise keep that dead client
 * for ever. Here every private client is replaced once the daemon is back and has been re-verified:
 * same scope, same socket and the same exact Web origin. Anything else is refused and the
 * previous trust is never widened. No call is replayed: a request in flight when the connection
 * dropped fails with its unknown outcome, exactly as before.
 */
export function createDaemonLink(
  initial: LocalBackend,
  attach: (signal: AbortSignal, timeoutMs: number) => Promise<LocalBackend>,
  timing: Partial<DaemonLinkTiming> = {},
): DaemonLink {
  const t = { ...TIMING, ...timing }
  const control = new AbortController()
  const slots: Slot[] = []
  let current = initial
  let episode: Promise<boolean> | undefined
  let coolUntil = 0
  let lastRefresh = 0
  let closed = false

  const sameDaemon = (next: LocalBackend): boolean =>
    next.scope.scopeID === initial.scope.scopeID &&
    next.socketPath === initial.socketPath &&
    next.discovery.profile === initial.discovery.profile &&
    next.discovery.dataDir === initial.discovery.dataDir &&
    next.web?.origin === initial.web?.origin

  const adopt = async (next: LocalBackend): Promise<void> => {
    if (!sameDaemon(next)) {
      await next.closeClient().catch(() => undefined)
      throw new Error('daemon identity does not match this launcher')
    }
    current = next
    for (const slot of slots) slot.replace()
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (control.signal.aborted) return resolve()
      const done = () => {
        clearTimeout(timer)
        control.signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(0, ms))
      control.signal.addEventListener('abort', done, { once: true })
    })

  const run = async (): Promise<boolean> => {
    const deadline = Date.now() + t.windowMs
    let delay = t.baseMs
    while (!control.signal.aborted && Date.now() < deadline) {
      if (slots.some((slot) => slot.client.isClosed)) {
        try {
          await adopt(await attach(control.signal, Math.max(1, Math.min(t.attemptMs, deadline - Date.now()))))
          continue
        } catch {
          // Down, mismatched or not yet ready: all the same to a waiting request. Back off, bounded.
        }
        await sleep(Math.min(delay, deadline - Date.now()))
        delay = Math.min(t.maxMs, delay * 2)
      } else if (slots.some((slot) => slot.client.connectionState === 'reconnecting')) {
        await sleep(Math.min(100, deadline - Date.now()))
      } else return true
    }
    coolUntil = Date.now() + t.cooldownMs
    return false
  }

  const settled = (): boolean =>
    !slots.some((slot) => slot.client.isClosed || slot.client.connectionState === 'reconnecting')

  const link: DaemonLink = {
    backend: () => current,
    settled,
    ensure() {
      if (closed) return Promise.resolve(false)
      if (episode) return episode
      if (settled()) return Promise.resolve(true)
      if (Date.now() < coolUntil) return Promise.resolve(false)
      episode = run().finally(() => {
        episode = undefined
      })
      return episode
    },
    async refresh() {
      if (closed || episode || Date.now() - lastRefresh < REFRESH_MIN_MS) return
      lastRefresh = Date.now()
      try {
        const found = await readDaemonDiscovery(current.scope)
        if (!found || found.owner.generation === current.discovery.owner.generation) return
        await adopt(await attach(control.signal, t.attemptMs))
      } catch {
        // A mismatched or unreadable daemon keeps the previous trusted address; nothing is widened.
      }
    },
    client(open, onReplace) {
      let client = open()
      const listeners = new Set<{
        event: Parameters<Client['on']>[0]
        handler: (payload: unknown) => void
        off: () => void
      }>()
      const slot: Slot = {
        get client() {
          return client
        },
        replace() {
          if (!client.isClosed) return
          const old = client
          client = open()
          void old.close().catch(() => undefined)
          for (const entry of listeners) entry.off = client.on(entry.event, entry.handler)
          onReplace?.(client)
        },
      }
      slots.push(slot)
      const on: Client['on'] = (event, handler) => {
        const entry = { event, handler, off: client.on(event, handler) }
        listeners.add(entry)
        return () => {
          listeners.delete(entry)
          entry.off()
        }
      }
      const view = (path: readonly string[]): object =>
        new Proxy(Object.create(null) as object, {
          get(_target, prop) {
            if (typeof prop === 'symbol') return undefined
            if (path.length === 0 && prop === 'on') return on
            const at = (): Dynamic =>
              path.reduce((owner, key) => owner[key] as Dynamic, client as unknown as Dynamic)
            const value = at()[prop]
            if (typeof value === 'function') {
              // `close` is lifecycle, not a request: it must never wait for or trigger a reconnect.
              if (path.length === 0 && prop === 'close') return () => client.close()
              return (...args: unknown[]) => {
                const call = () => Reflect.apply(at()[prop] as (...rest: unknown[]) => unknown, at(), args)
                return settled()
                  ? call()
                  : link.ensure().then((ok) => {
                      if (!ok) throw new DaemonUnavailableError()
                      return call()
                    })
              }
            }
            return value !== null && typeof value === 'object' ? view([...path, prop]) : value
          },
        })
      return view([]) as Client
    },
    transportFactories() {
      const path = initial.socketPath
      const pipes = localPipeFactories(path, initial.scope)
      if (pipes.unix) return pipes
      return {
        unix: () => async (handlers) => {
          // Every attempt, including the SDK's own reconnects, must reach the daemon we trust.
          const found = await readDaemonDiscovery(initial.scope)
          if (
            !found ||
            found.socketPath !== path ||
            found.profile !== initial.discovery.profile ||
            found.web?.origin !== initial.web?.origin
          )
            throw new Error('local socket does not match a verified daemon')
          return unixTransport({ path })(handlers)
        },
      }
    },
    async close() {
      closed = true
      control.abort()
      await episode?.catch(() => undefined)
    },
  }
  return link
}
