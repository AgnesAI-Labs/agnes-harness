import {
  CLOUD_AUTHORIZATION_PATH,
  REMOTE_FRONTEND_SESSION_PREFIX,
  remoteFrontendSessionPath,
} from '@agnes/protocol'
import { requestCloudFrameAuthorization } from './backends/cloud-frame-transport.js'
import { readCloudCredentialRef } from './backends/cloud-key.js'
import { backendFrame } from './backends/frame-context.js'

const sessions = new Map<string, { token: string; expiresAt: number }>()
export const remoteAccessPath = (remote: string): string => {
  const value = sessions.get(remote)
  return value ? remoteFrontendSessionPath(value.token) : ''
}
export function forgetRemoteAccess(remote: string): void {
  sessions.delete(remote)
}

export async function authorizeRemoteFrontend(remote: string, signal: AbortSignal, fetcher: typeof fetch) {
  const existing = sessions.get(remote)
  if (existing && existing.expiresAt > Date.now() + 30_000) return remoteFrontendSessionPath(existing.token)
  if (backendFrame()?.remote) {
    const path = await requestCloudFrameAuthorization(remote, signal)
    const token = path.slice(REMOTE_FRONTEND_SESSION_PREFIX.length)
    sessions.set(remote, { token, expiresAt: Number.parseInt(token.split('.')[0] ?? '', 36) })
    return path
  }
  const credentialRef = readCloudCredentialRef(remote)
  if (!credentialRef) throw new Error('CLOUD_CREDENTIAL_REQUIRED')
  const response = await fetcher(new URL(CLOUD_AUTHORIZATION_PATH, location.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ origin: remote, credentialRef }),
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    signal,
  })
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as { error?: unknown }
    if (failure.error === 'CONFIG_CREDENTIAL_REJECTED') throw new Error('CLOUD_CREDENTIAL_REJECTED')
    if (failure.error === 'CONFIG_CREDENTIAL_NOT_FOUND') throw new Error('CLOUD_CREDENTIAL_NOT_FOUND')
    throw new Error('CLOUD_AUTH_UNAVAILABLE')
  }
  const value = (await response.json()) as { token?: unknown; expiresAt?: unknown }
  if (
    typeof value.token !== 'string' ||
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= Date.now()
  )
    throw new Error('CLOUD_INVALID_AUTHORIZATION')
  const path = remoteFrontendSessionPath(value.token)
  sessions.set(remote, { token: value.token, expiresAt: value.expiresAt })
  return path
}
