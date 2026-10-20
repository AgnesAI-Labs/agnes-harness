import { ModelSlotsSnapshot, RuntimeAdminSnapshot, validateAgainst } from '@agnes/protocol'

export async function loadRuntimeCatalog(
  fetcher: typeof fetch = fetch,
): Promise<import('@agnes/protocol').RuntimeAdminSnapshot> {
  const [response, bundles] = await Promise.all([
    fetcher('/admin/api/runtime', { credentials: 'same-origin', cache: 'no-store' }),
    fetcher('/admin/api/bundles', { credentials: 'same-origin', cache: 'no-store' }),
  ])
  if (!response.ok) throw new Error('runtime catalog unavailable')
  const value: unknown = await response.json()
  if (!validateAgainst(RuntimeAdminSnapshot, value).ok) throw new Error('invalid runtime catalog')
  // Shared workers retain their boot composition. The admin catalog owns newly installed bundles.
  if (!bundles.ok) throw new Error('bundle catalog unavailable')
  const selection = (await bundles.json()) as { catalog?: unknown } | null
  if (!selection || !Array.isArray(selection.catalog)) throw new Error('invalid bundle catalog')
  const current = { ...(value as import('@agnes/protocol').RuntimeAdminSnapshot), bundles: selection.catalog }
  if (!validateAgainst(RuntimeAdminSnapshot, current).ok) throw new Error('invalid bundle catalog')
  return current as import('@agnes/protocol').RuntimeAdminSnapshot
}

/** Resolve the defaults using the same control-plane read as Models & accounts. */
export async function loadAuxiliaryModelDefaults(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/admin/api/model-slots', { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error('Model slots unavailable')
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || !('revision' in value) || !('slots' in value))
    throw new Error('Invalid model slots')
  const snapshot = {
    revision: value.revision,
    slots: value.slots,
    ...('auto' in value && value.auto !== undefined ? { auto: value.auto } : {}),
  }
  if (!validateAgainst(ModelSlotsSnapshot, snapshot).ok) throw new Error('Invalid model slots')
  const saved = snapshot as ModelSlotsSnapshot
  return {
    fast: saved.slots.fast === undefined ? (saved.auto?.fast ?? null) : saved.slots.fast,
    verifier: saved.slots.verifier ?? null,
  }
}
