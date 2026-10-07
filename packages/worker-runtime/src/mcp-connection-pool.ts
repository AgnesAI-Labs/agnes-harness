import type { McpConnection, McpServerOpener } from '@agnes/base'

/** Pools within one worker's opener/policy scope; each row owns an independently releasable lease. */
const pools = new WeakMap<McpServerOpener, Map<string, Entry>>()
type Entry = { refs: number; controller: AbortController; connection: Promise<McpConnection> }

export async function leaseMcpConnection(
  opener: McpServerOpener,
  key: string,
  definition: Parameters<McpServerOpener['connect']>[0],
  signal: AbortSignal,
): Promise<McpConnection> {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  let pool = pools.get(opener)
  if (!pool) {
    pool = new Map()
    pools.set(opener, pool)
  }
  let entry = pool.get(key)
  if (!entry) {
    const controller = new AbortController()
    entry = { refs: 0, controller, connection: opener.connect(definition, controller.signal) }
    const created = entry
    pool.set(key, created)
    void created.connection.then(
      (connection) => {
        connection.onClose?.(() => {
          if (pool.get(key) === created) pool.delete(key)
        })
      },
      () => {
        if (pool.get(key) === created) pool.delete(key)
      },
    )
  }
  entry.refs++
  const leased = entry
  let released = false
  const subscriptions = new Set<() => void>()
  const release = async () => {
    if (released) return
    released = true
    for (const off of subscriptions) off()
    subscriptions.clear()
    if (--leased.refs === 0) {
      if (pool.get(key) === leased) pool.delete(key)
      leased.controller.abort()
      await leased.connection.then(
        (connection) => connection.close(),
        () => undefined,
      )
    }
  }
  let abort: (() => void) | undefined
  try {
    const connection = await Promise.race([
      leased.connection,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new DOMException('aborted', 'AbortError'))
        signal.addEventListener('abort', abort, { once: true })
      }),
    ])
    return new Proxy(connection, {
      get(target, property) {
        if (property === 'close') return release
        const value = Reflect.get(target, property, target)
        if (
          ['onClose', 'onToolsChanged', 'onResourcesChanged'].includes(String(property)) &&
          typeof value === 'function'
        )
          return (listener: () => void) => {
            const off = value.call(target, () => {
              if (!released) listener()
            }) as () => void
            subscriptions.add(off)
            return () => {
              subscriptions.delete(off)
              off()
            }
          }
        if (typeof value === 'function')
          return (...args: unknown[]) => {
            if (released) return Promise.reject(new Error('MCP connection lease is closed'))
            return value.apply(target, args)
          }
        return value
      },
    })
  } catch (error) {
    await release()
    throw error
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
  }
}
