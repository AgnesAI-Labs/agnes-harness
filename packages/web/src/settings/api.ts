import { RuntimeAdminSnapshot, validateAgainst } from '@agnes/protocol'

export async function loadRuntimeCatalog(
  fetcher: typeof fetch = fetch,
): Promise<import('@agnes/protocol').RuntimeAdminSnapshot> {
  const response = await fetcher('/admin/api/runtime', { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error('runtime catalog unavailable')
  const value: unknown = await response.json()
  if (!validateAgainst(RuntimeAdminSnapshot, value).ok) throw new Error('invalid runtime catalog')
  // Shared workers retain their boot composition. The admin catalog owns newly installed bundles.
  const bundles = await fetcher('/admin/api/bundles', { credentials: 'same-origin', cache: 'no-store' })
  if (!bundles.ok) throw new Error('bundle catalog unavailable')
  const selection = (await bundles.json()) as { catalog?: unknown } | null
  if (!selection || !Array.isArray(selection.catalog)) throw new Error('invalid bundle catalog')
  const current = { ...(value as import('@agnes/protocol').RuntimeAdminSnapshot), bundles: selection.catalog }
  if (!validateAgainst(RuntimeAdminSnapshot, current).ok) throw new Error('invalid bundle catalog')
  return current as import('@agnes/protocol').RuntimeAdminSnapshot
}
