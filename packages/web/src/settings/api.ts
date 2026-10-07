import { RuntimeAdminSnapshot, validateAgainst } from '@agnes/protocol'

export async function loadRuntimeCatalog(
  fetcher: typeof fetch = fetch,
): Promise<import('@agnes/protocol').RuntimeAdminSnapshot> {
  const response = await fetcher('/admin/api/runtime', { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error('runtime catalog unavailable')
  const value: unknown = await response.json()
  if (!validateAgainst(RuntimeAdminSnapshot, value).ok) throw new Error('invalid runtime catalog')
  return value as import('@agnes/protocol').RuntimeAdminSnapshot
}
