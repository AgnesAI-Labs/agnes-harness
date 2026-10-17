import { ExtensionError } from '@agnes/extension-api'

type Registration = { publish(): () => void; release?: () => void }

/** Candidate roots keep their services private until the Host publishes that tree. */
export function createRowServicePublication() {
  const scopes = new WeakMap<object, Map<string, Registration>>()
  let current: Map<string, Registration> | undefined
  let enabled = false
  const publish = (entry: Registration) => {
    entry.release = entry.publish()
  }
  const release = (entry: Registration) => {
    entry.release?.()
    delete entry.release
  }
  return {
    install(root: object) {
      const entries = new Map<string, Registration>()
      scopes.set(root, entries)
      current ??= entries
      return (key: string, create: () => () => void) => {
        if (entries.has(key))
          throw new ExtensionError('E_REGISTRY_DUPLICATE', 'service already registered by row')
        const entry: Registration = { publish: create }
        entries.set(key, entry)
        try {
          if (enabled && entries === current) publish(entry)
        } catch (error) {
          entries.delete(key)
          throw error
        }
        return () => {
          if (entries.get(key) !== entry) return
          release(entry)
          entries.delete(key)
        }
      }
    },
    select(root: object) {
      const entries = scopes.get(root)
      if (!entries) throw new Error('row service root is not installed')
      if (entries === current) return
      for (const entry of current?.values() ?? []) release(entry)
      current = entries
      if (enabled) for (const entry of current.values()) publish(entry)
    },
    activate() {
      enabled = true
      for (const entry of current?.values() ?? []) publish(entry)
    },
  }
}
