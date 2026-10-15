import { AsyncLocalStorage } from 'node:async_hooks'
import type { OwnedStore, PersistenceMetadataNamespace } from '@agnes/extension-api'
import { inspectJsonData, type JsonValue, jcs, rpcError } from '@agnes/protocol'

/** The loader supplies the namespace. Authors cannot select a different owner or execute SQL. */
export function ownedStore(
  namespace: PersistenceMetadataNamespace,
  alive: () => void,
  writable: boolean,
): OwnedStore {
  const scopes = new AsyncLocalStorage<{ active: boolean }>()
  const assertLive = () => {
    alive()
    if (scopes.getStore()?.active === false) throw rpcError('CAPABILITY_DENIED')
  }
  const keyOf = (key: string) => {
    assertLive()
    if (typeof key !== 'string' || !key || key.length > 256 || key.includes('\0'))
      throw rpcError('INVALID_PARAMS')
    return key
  }
  const mutate = () => {
    assertLive()
    if (!writable) throw rpcError('CAPABILITY_DENIED')
  }
  let depth = 0
  const transaction = <T>(work: () => T): T => {
    const run = () => {
      assertLive()
      const scope = { active: true }
      depth++
      try {
        const result = scopes.run(scope, work)
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          void Promise.resolve(result).catch(() => undefined)
          throw rpcError('INVALID_PARAMS')
        }
        assertLive()
        return result
      } finally {
        scope.active = false
        depth--
      }
    }
    return depth ? run() : namespace.transaction(run)
  }
  return Object.freeze({
    get(key) {
      return structuredClone(namespace.get(keyOf(key))) as JsonValue | undefined
    },
    set(key, value) {
      mutate()
      const checked = inspectJsonData(value, 65536)
      if (!checked.ok) throw rpcError('INVALID_PARAMS')
      transaction(() => {
        const name = keyOf(key),
          entries = namespace.entries()
        const size = entries.reduce(
          (total, row) =>
            total + (row.key === name ? 0 : new TextEncoder().encode(jcs(row.value)).byteLength),
          new TextEncoder().encode(jcs(checked.value)).byteLength,
        )
        if ((!entries.some((row) => row.key === name) && entries.length >= 10000) || size > 16777216)
          throw rpcError('OVERLOADED')
        namespace.set(name, checked.value)
      })
    },
    delete(key) {
      mutate()
      namespace.delete(keyOf(key))
    },
    transaction,
  } satisfies OwnedStore)
}
