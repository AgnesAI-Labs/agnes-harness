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
  let failed = false
  const admissions = new Set<NonNullable<Parameters<OwnedStore['transaction']>[1]>>()
  const transaction: OwnedStore['transaction'] = (work, admission) => {
    const run = () => {
      assertLive()
      if (!depth) {
        failed = false
        admissions.clear()
      }
      const scope = { active: true }
      depth++
      try {
        admission?.assertActive()
        if (admission) admissions.add(admission)
        const result = scopes.run(scope, work)
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          void Promise.resolve(result).catch(() => undefined)
          throw rpcError('INVALID_PARAMS')
        }
        assertLive()
        admission?.assertActive()
        if (failed) throw rpcError('INVALID_PARAMS')
        // Successful inner calls retain their capabilities until the real root commit.
        if (depth === 1) for (const joined of admissions) joined.assertActive()
        return result
      } catch (error) {
        failed = true
        throw error
      } finally {
        scope.active = false
        depth--
      }
    }
    if (depth) return run()
    try {
      return namespace.transaction(run)
    } finally {
      admissions.clear()
    }
  }
  return Object.freeze({
    scan(input) {
      assertLive()
      if (
        typeof input.prefix !== 'string' ||
        input.prefix.length > 256 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 256 ||
        (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 256))
      )
        throw rpcError('INVALID_PARAMS')
      const entries = namespace
        .entries()
        .filter(
          (row) => row.key.startsWith(input.prefix) && (input.cursor === undefined || row.key > input.cursor),
        )
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      const rows = entries
        .slice(0, input.limit)
        .map((row) => ({ key: row.key, value: structuredClone(row.value) as JsonValue }))
      return { rows, ...(entries.length > rows.length ? { nextCursor: rows.at(-1)!.key } : {}) }
    },
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
