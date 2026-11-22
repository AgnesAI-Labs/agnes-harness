import {
  CLOUD_AUTHORIZATION_PATH,
  REMOTE_FRONTEND_SESSION_PREFIX,
  remoteFrontendOrigin,
  remoteFrontendSessionPath,
} from '@agnes/protocol'
import { requestCloudFrameAuthorization } from './backends/cloud-frame-transport.js'
import {
  CLOUD_CREDENTIAL_STORAGE_PREFIX,
  readCloudCredentialGeneration,
  readCloudCredentialRef,
  subscribeCloudCredentialReplacement,
} from './backends/cloud-key.js'
import { backendFrame, cloudFrameOrigin } from './backends/frame-context.js'

const sessions = new Map<
  string,
  {
    token: string
    expiresAt: number
    proxied?: boolean
    credentialRef?: string
    credentialGeneration?: string
  }
>()
const originEpochs = new Map<string, number>()
let clearEpoch = 0

export function forgetRemoteAccessByCredential(credentialRef: string): void {
  for (const [remote, entry] of sessions.entries()) {
    if (entry.credentialRef === credentialRef) forgetRemoteAccess(remote)
  }
}

subscribeCloudCredentialReplacement((credentialRef) => forgetRemoteAccessByCredential(credentialRef))

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === null || (event.key === 'agnes.cloud.origin.v1' && !event.newValue))
      forgetAllRemoteAccess()
    else if (event.key?.startsWith(CLOUD_CREDENTIAL_STORAGE_PREFIX))
      forgetRemoteAccess(event.key.slice(CLOUD_CREDENTIAL_STORAGE_PREFIX.length))
  })
}

export const remoteUsesGateway = (remote: string): boolean => sessions.get(remote)?.proxied === true
export const remoteTransportOrigin = (remote: string): string =>
  remoteUsesGateway(remote) ? (backendFrame()?.remote ? location.origin : cloudFrameOrigin()) : remote
export const remoteAccessPath = (remote: string): string => {
  const value = sessions.get(remote)
  return value ? remoteFrontendSessionPath(value.token) : ''
}
export function forgetRemoteAccess(remote: string): void {
  originEpochs.set(remote, (originEpochs.get(remote) ?? 0) + 1)
  sessions.delete(remote)
}
export function forgetAllRemoteAccess(): void {
  clearEpoch++
  for (const remote of sessions.keys()) originEpochs.set(remote, (originEpochs.get(remote) ?? 0) + 1)
  sessions.clear()
}

export async function authorizeRemoteFrontend(
  remote: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  fresh = false,
) {
  if (fresh) forgetRemoteAccess(remote)
  const childFrame = Boolean(backendFrame()?.remote)
  const credentialRef = childFrame ? undefined : readCloudCredentialRef(remote)
  if (!childFrame && !credentialRef) throw new Error('CLOUD_CREDENTIAL_REQUIRED')
  const generation = credentialRef ? readCloudCredentialGeneration(credentialRef) : undefined
  const existing = sessions.get(remote)
  if (
    existing &&
    !childFrame &&
    (existing.credentialRef !== credentialRef || existing.credentialGeneration !== generation)
  )
    forgetRemoteAccess(remote)
  else if (existing && existing.expiresAt > Date.now() + 30_000)
    return remoteFrontendSessionPath(existing.token)
  const reset = clearEpoch
  const epoch = originEpochs.get(remote) ?? 0
  if (childFrame) {
    let proxied = false
    const path = await requestCloudFrameAuthorization(
      remote,
      signal,
      (value) => {
        proxied = value
      },
      fresh,
    )
    if (signal.aborted || clearEpoch !== reset || (originEpochs.get(remote) ?? 0) !== epoch)
      throw new DOMException('Authorization invalidated', 'AbortError')
    const token = path.slice(REMOTE_FRONTEND_SESSION_PREFIX.length)
    sessions.set(remote, { token, expiresAt: Number.parseInt(token.split('.')[0] ?? '', 36), proxied })
    return path
  }
  const value = await requestCloudAuthorization(
    { origin: remote, credentialRef: credentialRef ?? '' },
    signal,
    fetcher,
  )
  if (
    signal.aborted ||
    clearEpoch !== reset ||
    (originEpochs.get(remote) ?? 0) !== epoch ||
    readCloudCredentialRef(remote) !== credentialRef ||
    (credentialRef !== undefined && readCloudCredentialGeneration(credentialRef) !== generation)
  )
    throw new DOMException('Authorization invalidated', 'AbortError')
  const path = remoteFrontendSessionPath(value.token)
  sessions.set(remote, {
    token: value.token,
    expiresAt: value.expiresAt,
    proxied: value.proxied === true,
    ...(credentialRef ? { credentialRef, credentialGeneration: generation ?? '0' } : {}),
  })
  return path
}

/** Discover only an existing LLMSG sandbox; raw Keys and platform tokens stay in the local backend. */
export async function discoverCloudOrigin(
  credentialRef: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const reset = clearEpoch
  const generation = readCloudCredentialGeneration(credentialRef)
  const value = await requestCloudAuthorization({ credentialRef }, signal, fetcher)
  if (!value.origin || !value.proxied) throw new Error('CLOUD_INVALID_AUTHORIZATION')
  const origin = remoteFrontendOrigin(value.origin)
  const url = new URL(origin)
  if (
    origin !== value.origin ||
    url.protocol !== 'https:' ||
    url.port ||
    !/^8443-[a-z0-9-]+\.[a-z0-9-]+\.tencentags\.com$/u.test(url.hostname)
  )
    throw new Error('CLOUD_INVALID_AUTHORIZATION')
  if (signal.aborted || clearEpoch !== reset || readCloudCredentialGeneration(credentialRef) !== generation)
    throw new DOMException('Authorization invalidated', 'AbortError')
  sessions.set(origin, {
    token: value.token,
    expiresAt: value.expiresAt,
    proxied: true,
    credentialRef,
    credentialGeneration: generation,
  })
  return origin
}

async function requestCloudAuthorization(
  input: { origin?: string; credentialRef: string },
  signal: AbortSignal,
  fetcher: typeof fetch,
) {
  const response = await fetcher(new URL(CLOUD_AUTHORIZATION_PATH, location.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    signal,
  })
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as { error?: unknown }
    if (failure.error === 'CONFIG_CREDENTIAL_REJECTED') throw new Error('CLOUD_CREDENTIAL_REJECTED')
    if (failure.error === 'CONFIG_CREDENTIAL_NOT_FOUND') throw new Error('CLOUD_CREDENTIAL_NOT_FOUND')
    if (
      typeof failure.error === 'string' &&
      /^CLOUD_(?:BROKER_REQUIRED|CONNECTION_INVALID|SANDBOX_NOT_READY|RATE_LIMITED)$/u.test(failure.error)
    )
      throw new Error(failure.error)
    throw new Error('CLOUD_AUTH_UNAVAILABLE')
  }
  const value = (await response.json()) as {
    token?: unknown
    expiresAt?: unknown
    proxied?: unknown
    origin?: unknown
  }
  signal.throwIfAborted()
  if (
    typeof value.token !== 'string' ||
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= Date.now() ||
    (value.proxied !== undefined && typeof value.proxied !== 'boolean') ||
    (value.origin !== undefined && typeof value.origin !== 'string')
  )
    throw new Error('CLOUD_INVALID_AUTHORIZATION')
  remoteFrontendSessionPath(value.token)
  return {
    token: value.token,
    expiresAt: value.expiresAt,
    proxied: value.proxied === true,
    ...(typeof value.origin === 'string' ? { origin: value.origin } : {}),
  }
}
