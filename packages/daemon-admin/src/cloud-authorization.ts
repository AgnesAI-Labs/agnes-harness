import type { CredentialStore } from '@agnes/host'
import {
  REMOTE_FRONTEND_AUTH,
  remoteFrontendOrigin,
  remoteFrontendSessionPath,
  rpcError,
} from '@agnes/protocol'
import type { AdminCloudAuthorization, AdminCloudAuthorize } from '@agnes/protocol/gen/app-server'
import { deploymentFetch } from '@agnes/system-node/deployment-network'
import {
  cloudAuthorizationRequests,
  discardCloudBody,
  readCloudAuthorizationBody,
} from './cloud-authorization-request.js'
import { cloudSandboxConnection } from './cloud-sandbox-token.js'

const AUTHORIZATION_CLOCK_SKEW_MS = 5 * 60 * 1000

/** Resolve the Key in A's daemon. Only the trusted launcher receives a platform traffic credential. */
export async function authorizeCloudConnection(
  input: AdminCloudAuthorize,
  store: Pick<CredentialStore, 'read'>,
  fetcher: typeof fetch = deploymentFetch,
  signal?: AbortSignal,
): Promise<AdminCloudAuthorization> {
  try {
    signal?.throwIfAborted()
    const requestedOrigin = input.origin === undefined ? undefined : remoteFrontendOrigin(input.origin)
    if (requestedOrigin) {
      const target = new URL(requestedOrigin)
      if (target.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
        throw rpcError('SEMANTIC_REJECTED', { reason: 'CLOUD_CONNECTION_INVALID' })
    }
    const credential = await store.read(input.credentialRef)
    signal?.throwIfAborted()
    if (credential?.kind !== 'api-key' || credential.provider !== 'generic' || !credential.label)
      throw rpcError('SEMANTIC_REJECTED', { reason: 'CONFIG_CREDENTIAL_NOT_FOUND' })
    const requests = cloudAuthorizationRequests(fetcher, signal)
    const sandbox = await cloudSandboxConnection(
      requestedOrigin,
      credential.value,
      requests.connection,
      requests.signal,
    )
    const origin = sandbox?.origin ?? requestedOrigin
    if (!origin) throw Error('missing cloud origin')
    const trafficToken = sandbox?.trafficToken
    const response = await requests.authorize(`${origin}${REMOTE_FRONTEND_AUTH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(trafficToken ? { 'e2b-traffic-access-token': trafficToken } : {}),
      },
      body: JSON.stringify({ key: credential.value }),
      redirect: 'error',
    })
    if (!response.ok) {
      discardCloudBody(response)
      if (response.status === 401 || response.status === 403)
        throw rpcError('SEMANTIC_REJECTED', { reason: 'CONFIG_CREDENTIAL_REJECTED' })
      throw new Error('unavailable')
    }
    const value = (await readCloudAuthorizationBody(response, requests.signal)) as {
      token?: unknown
      expiresAt?: unknown
    } | null
    signal?.throwIfAborted()
    if (
      typeof value?.token !== 'string' ||
      typeof value.expiresAt !== 'number' ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now() ||
      value.expiresAt > Date.now() + 8 * 60 * 60 * 1000 + AUTHORIZATION_CLOCK_SKEW_MS
    )
      throw new Error('invalid authorization')
    remoteFrontendSessionPath(value.token)
    return {
      token: value.token,
      expiresAt: value.expiresAt,
      ...(trafficToken ? { trafficToken } : {}),
      ...(requestedOrigin === undefined ? { origin } : {}),
    }
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
