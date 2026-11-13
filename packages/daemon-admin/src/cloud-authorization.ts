import type { CredentialStore } from '@agnes/host'
import {
  REMOTE_FRONTEND_AUTH,
  remoteFrontendOrigin,
  remoteFrontendSessionPath,
  rpcError,
} from '@agnes/protocol'
import type { AdminCloudAuthorization, AdminCloudAuthorize } from '@agnes/protocol/gen/app-server'

/** Resolve the managed credential only in A's daemon; never return its value to the browser/BFF. */
export async function authorizeCloudConnection(
  input: AdminCloudAuthorize,
  store: Pick<CredentialStore, 'read'>,
  fetcher: typeof fetch = fetch,
): Promise<AdminCloudAuthorization> {
  try {
    const origin = remoteFrontendOrigin(input.origin)
    const credential = await store.read(input.credentialRef)
    if (credential?.kind !== 'api-key' || credential.provider !== 'generic' || !credential.label)
      throw rpcError('SEMANTIC_REJECTED', { reason: 'CONFIG_CREDENTIAL_NOT_FOUND' })
    const response = await fetcher(`${origin}${REMOTE_FRONTEND_AUTH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: credential.value }),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    })
    if (response.status === 401 || response.status === 403)
      throw rpcError('SEMANTIC_REJECTED', { reason: 'CONFIG_CREDENTIAL_REJECTED' })
    if (!response.ok) throw new Error('unavailable')
    const value = (await response.json()) as { token?: unknown; expiresAt?: unknown }
    if (
      typeof value.token !== 'string' ||
      typeof value.expiresAt !== 'number' ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now() ||
      value.expiresAt > Date.now() + 8 * 60 * 60 * 1000
    )
      throw new Error('invalid authorization')
    remoteFrontendSessionPath(value.token)
    return { token: value.token, expiresAt: value.expiresAt }
  } catch (error) {
    const reason = (error as { data?: { reason?: unknown } })?.data?.reason
    throw rpcError('SEMANTIC_REJECTED', {
      reason:
        reason === 'CONFIG_CREDENTIAL_NOT_FOUND' || reason === 'CONFIG_CREDENTIAL_REJECTED'
          ? reason
          : 'CONFIG_AUTH_UNAVAILABLE',
    })
  }
}
