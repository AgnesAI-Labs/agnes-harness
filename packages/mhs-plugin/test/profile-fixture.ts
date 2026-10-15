import type { PersistenceMetadataNamespace, PersistenceMetadataPort } from '@agnes/extension-api'
export function metadata(): PersistenceMetadataPort {
  const spaces = new Map<string, Map<string, unknown>>()
  return {
    namespace(owner, name): PersistenceMetadataNamespace {
      const key = `${owner}/${name}`,
        rows = spaces.get(key) ?? new Map<string, unknown>()
      spaces.set(key, rows)
      return {
        get: (key) => structuredClone(rows.get(key)),
        set: (key, value) => {
          rows.set(key, structuredClone(value))
        },
        delete: (key) => {
          rows.delete(key)
        },
        entries: () => [...rows].map(([key, value]) => ({ key, value: structuredClone(value) })),
        transaction(work) {
          const before = structuredClone(rows)
          try {
            return work()
          } catch (error) {
            rows.clear()
            for (const [key, value] of before) rows.set(key, value)
            throw error
          }
        },
      }
    },
  }
}
