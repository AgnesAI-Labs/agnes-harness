import { useEffect, useState } from 'react'
import { type AdminCredentialMetadata, CREDENTIALS_CHANGED, CredentialsApi } from './credentials-api.js'

/** Metadata only; existing legacy references remain owned by each caller's original catalog. */
export function useCredentialOptions(refresh?: unknown) {
  const [items, setItems] = useState<AdminCredentialMetadata[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller invalidates choices when its editor opens or selection changes.
  useEffect(() => {
    const abort = new AbortController()
    let version = 0
    const load = async () => {
      const request = ++version
      try {
        const next = await new CredentialsApi().list(abort.signal)
        if (!abort.signal.aborted && request === version) setItems(next)
      } catch {
        /* The caller preserves its existing choices when the generic catalog is unavailable. */
      }
    }
    void load()
    window.addEventListener(CREDENTIALS_CHANGED, load, { signal: abort.signal })
    return () => abort.abort()
  }, [refresh])
  return items.map((item) => ({
    value: item.id,
    label:
      items.filter((other) => other.label === item.label).length > 1
        ? `${item.label} · ${item.id.slice(-8)}`
        : item.label,
  }))
}
