import { AsyncLocalStorage } from 'node:async_hooks'
import type { McpConnection } from '@agnes/base'

type Catalog = Awaited<ReturnType<McpConnection['listTools']>>
type Read = { epoch: number; pending: Promise<Catalog> }
type Scope = { closed: boolean; reads: Map<object, Read> }
const scopes = new AsyncLocalStorage<Scope>()

/** One publication, never a retained factory or connection's lifetime. */
export function withMcpCatalogReadScope<A extends unknown[], T>(run: (...args: A) => Promise<T>) {
  return (...args: A): Promise<T> => {
    const scope: Scope = { closed: false, reads: new Map() }
    return scopes.run(scope, async () => {
      try {
        return await run(...args)
      } finally {
        scope.closed = true
        scope.reads.clear()
      }
    })
  }
}

/** Each Host still validates and owns its own copy of the remote, unfiltered catalog. */
export async function readScopedMcpCatalog(
  connection: object,
  epoch: number,
  read: () => Promise<Catalog>,
  validate: (tools: Catalog) => void,
): Promise<Catalog> {
  const scope = scopes.getStore()
  if (!scope || scope.closed) return read()
  let entry = scope.reads.get(connection)
  if (!entry || entry.epoch !== epoch) {
    entry = {
      epoch,
      pending: Promise.resolve()
        .then(read)
        .then((tools) => {
          if (!Array.isArray(tools)) throw new Error('tool catalog is not an array')
          validate(tools)
          return structuredClone(tools)
        }),
    }
    scope.reads.set(connection, entry)
  }
  try {
    const tools = await entry.pending
    return structuredClone(tools)
  } catch (error) {
    if (scope.reads.get(connection) === entry) scope.reads.delete(connection)
    throw error
  }
}
