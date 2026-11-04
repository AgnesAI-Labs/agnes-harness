import { randomUUID } from 'node:crypto'
import {
  type McpConnection,
  type McpServerOpener,
  mcpServerConfigFromDefinition,
  validateRemoteCatalog,
} from '@agnes/base'
import { jcs } from '@agnes/protocol'
import { readScopedMcpCatalog } from './mcp-catalog-scope.js'

/** Pools within one worker's opener/policy scope; each row owns an independently releasable lease. */
const pools = new WeakMap<McpServerOpener, Map<string, Entry>>()
type Entry = {
  refs: number
  controller: AbortController
  connection: Promise<McpConnection>
  catalogEpoch: number
  stopCatalogListeners: (() => void)[]
}

function stopCatalogListeners(entry: Entry): void {
  for (const off of entry.stopCatalogListeners.splice(0)) {
    try {
      off()
    } catch {
      /* Continue retiring other listeners and the transport. */
    }
  }
}

export async function leaseMcpConnection(
  opener: McpServerOpener,
  key: string,
  definition: Parameters<McpServerOpener['connect']>[0],
  signal: AbortSignal,
): Promise<McpConnection> {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  const prepared = await opener.prepare?.(definition, signal)
  if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  // Unresolved credential-bearing custom openers cannot prove equivalence: refuse to share.
  const boundary =
    prepared?.key ?? (definition.secretBinding.kind === 'none' ? jcs(definition) : randomUUID())
  key = jcs([key, boundary])
  let pool = pools.get(opener)
  if (!pool) {
    pool = new Map()
    pools.set(opener, pool)
  }
  let entry = pool.get(key)
  if (!entry) {
    const controller = new AbortController()
    entry = {
      refs: 0,
      controller,
      catalogEpoch: 0,
      stopCatalogListeners: [],
      connection: prepared
        ? prepared.connect(controller.signal)
        : opener.connect(definition, controller.signal),
    }
    const created = entry
    pool.set(key, created)
    created.connection = created.connection.then(async (connection) => {
      try {
        const invalidate = () => created.catalogEpoch++
        // Install once, before any lease can subscribe its Host's resync listener.
        for (const subscribe of [connection.onToolsChanged, connection.onResourcesChanged]) {
          const off = subscribe?.call(connection, invalidate)
          if (off) created.stopCatalogListeners.push(off)
        }
        connection.onClose?.(() => {
          invalidate()
          stopCatalogListeners(created)
          if (pool.get(key) === created) pool.delete(key)
        })
        return connection
      } catch (error) {
        stopCatalogListeners(created)
        try {
          await connection.close()
        } catch {
          /* Preserve the initialization failure. */
        }
        throw error
      }
    })
    void created.connection.catch(() => {
      if (pool.get(key) === created) pool.delete(key)
    })
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
        (connection) => {
          stopCatalogListeners(leased)
          leased.catalogEpoch++
          return connection.close()
        },
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
        if (property === 'listTools')
          return (options?: Parameters<McpConnection['listTools']>[0]) => {
            if (released) return Promise.reject(new Error('MCP connection lease is closed'))
            if (
              options &&
              (options.signal !== undefined ||
                options.timeoutMs !== undefined ||
                Reflect.ownKeys(options).length)
            )
              return target.listTools(options)
            return readScopedMcpCatalog(
              leased,
              leased.catalogEpoch,
              () => target.listTools(options),
              // Reject malformed/oversized responses before retaining a shared raw catalog.
              (tools) => {
                validateRemoteCatalog(target, mcpServerConfigFromDefinition(definition), tools)
              },
            )
          }
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
