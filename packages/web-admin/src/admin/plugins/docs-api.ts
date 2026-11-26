import {
  type PackageDocsGetParams,
  type PackageDocsGetResult,
  validatePackageAdminCall,
} from '@agnes/protocol'
import { AdminApiError, invalidSelection, json, safeError } from './api-response.js'
import { ADMIN_FEATURES, type AdminContext, hasFeature } from './types.js'

export function docsConnectionEpochFor(active: AdminContext, capture: AdminContext): string | undefined {
  if (
    !active.docsConnectionEpoch ||
    active.docsConnectionEpoch !== capture.docsConnectionEpoch ||
    active.profile !== capture.profile ||
    active.authScope !== capture.authScope ||
    !active.permissions.includes('packages.read') ||
    !hasFeature(active, ADMIN_FEATURES.docs)
  )
    return undefined
  return active.docsConnectionEpoch
}

/** A 404 means this connection no longer offers Docs, rather than an installed document miss. */
export async function readPackageDocs({
  url,
  fetcher,
  context,
  input,
  signal,
}: {
  url: string
  fetcher: typeof fetch
  context: AdminContext
  input: Omit<PackageDocsGetParams, 'profile'>
  signal: AbortSignal | undefined
}): Promise<PackageDocsGetResult | undefined> {
  const capturedContext = { ...context }
  const docsConnectionEpoch = docsConnectionEpochFor(context, capturedContext)
  if (!docsConnectionEpoch) return undefined
  const method = '_agnes/v1/packages.docs.get'
  const params = { ...input, profile: capturedContext.profile }
  if (!validatePackageAdminCall(method, 'params', params).ok)
    throw new AdminApiError({
      code: 'ADMIN_REQUEST_INVALID',
      message: 'The admin request arguments are invalid.',
    })
  const response = await fetcher(url, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, docsConnectionEpoch }),
    ...(signal ? { signal } : {}),
  })
  if (response.status === 404) return undefined
  const body = await json(response)
  if (docsConnectionEpochFor(context, capturedContext) !== docsConnectionEpoch) return undefined
  if (!response.ok) throw new AdminApiError(safeError(body))
  if (!body || typeof body !== 'object' || !('docsConnectionEpoch' in body)) throw invalidSelection()
  const { docsConnectionEpoch: responseEpoch, ...value } = body
  if (responseEpoch !== docsConnectionEpoch || !validatePackageAdminCall(method, 'result', value).ok)
    throw invalidSelection()
  const result = value as PackageDocsGetResult
  if (
    result.found &&
    ((input.locale === 'en' && result.locale !== 'en') ||
      result.markdown.includes('\0') ||
      !/\S/u.test(result.markdown) ||
      new TextEncoder().encode(result.markdown).byteLength > 65_536)
  )
    throw invalidSelection()
  return result
}
