import type { CredentialStore } from '@agnes/host'
import {
  REMOTE_FRONTEND_AUTH,
  remoteFrontendOrigin,
  remoteFrontendSessionPath,
  rpcError,
} from '@agnes/protocol'
import type { AdminCloudAuthorization, AdminCloudAuthorize } from '@agnes/protocol/gen/app-server'
import { deploymentFetch } from '@agnes/system-node/deployment-network'
import { cloudSandboxToken } from './cloud-sandbox-token.js'

const AUTHORIZATION_CLOCK_SKEW_MS = 5 * 60 * 1000

/** Resolve the Key in A's daemon. Only the trusted launcher receives a platform traffic credential. */
export async function authorizeCloudConnection(
  input: AdminCloudAuthorize,
  store: Pick<CredentialStore, 'read'>,
  fetcher: typeof fetch = deploymentFetch,
): Promise<AdminCloudAuthorization> {
  try {
    const origin = remoteFrontendOrigin(input.origin)
    const credential = await store.read(input.credentialRef)
    if (credential?.kind !== 'api-key' || credential.provider !== 'generic' || !credential.label)
      throw rpcError('SEMANTIC_REJECTED', { reason: 'CONFIG_CREDENTIAL_NOT_FOUND' })
    const trafficToken = await cloudSandboxToken(origin, credential.value, fetcher)
    const response = await fetcher(`${origin}${REMOTE_FRONTEND_AUTH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(trafficToken ? { 'e2b-traffic-access-token': trafficToken } : {}),
      },
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
      value.expiresAt > Date.now() + 8 * 60 * 60 * 1000 + AUTHORIZATION_CLOCK_SKEW_MS
    )
      throw new Error('invalid authorization')
    remoteFrontendSessionPath(value.token)
    return { token: value.token, expiresAt: value.expiresAt, ...(trafficToken ? { trafficToken } : {}) }
  } catch (error) {
    const reason = (error as { data?: { reason?: unknown } })?.data?.reason
    throw rpcError('SEMANTIC_REJECTED', {
      reason:
        typeof reason === 'string' &&
        /^(?:CONFIG_CREDENTIAL_(?:NOT_FOUND|REJECTED)|CLOUD_(?:BROKER_REQUIRED|CONNECTION_INVALID|SANDBOX_NOT_READY|RATE_LIMITED))$/u.test(
          reason,
        )
          ? reason
          : 'CONFIG_AUTH_UNAVAILABLE',
    })
  }
}
