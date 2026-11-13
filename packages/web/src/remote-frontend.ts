import {
  CLOUD_AUTHORIZATION_PATH,
  REMOTE_FRONTEND_AUTH,
  REMOTE_FRONTEND_INFO,
  REMOTE_FRONTEND_KEY_VERSION,
  REMOTE_FRONTEND_SESSION_PREFIX,
  REMOTE_FRONTEND_WS,
  remoteFrontendOrigin,
} from '@agnes/protocol'
import { backendFrame } from './backends/frame-context.js'
import { authorizeRemoteFrontend, forgetRemoteAccess, remoteAccessPath } from './remote-authorization.js'

export function selectedRemoteOrigin(search?: string): string | undefined {
  const frame = search === undefined ? backendFrame() : undefined
  const value = frame
    ? frame.getAttribute('data-backend-origin')
    : new URLSearchParams(search ?? globalThis.location?.search ?? '').get('remote')
  if (value === '') return undefined
  return value === null ? undefined : remoteFrontendOrigin(value)
}

export function frontendBackendIdentity(): string {
  return selectedRemoteOrigin()
    ? (document.querySelector<HTMLMetaElement>('meta#agnes-config')?.dataset.backend ??
        selectedRemoteOrigin() ??
        location.origin)
    : location.origin
}

export function backendResourceUrl(
  value: string,
  remote = selectedRemoteOrigin(),
  local = globalThis.location?.origin ?? 'http://localhost',
): string {
  if (!remote) return value
  const target = new URL(value, local)
  const localWs = local.replace(/^http/u, 'ws')
  const remoteWs = remote.replace(/^http/u, 'ws')
  if (![local, localWs, remote, remoteWs].includes(target.origin)) return value
  if (target.pathname === CLOUD_AUTHORIZATION_PATH && [local, localWs].includes(target.origin)) return value
  if (target.pathname.startsWith(REMOTE_FRONTEND_SESSION_PREFIX) || target.pathname === REMOTE_FRONTEND_AUTH)
    return value
  if (
    !/^\/(?:api(?:\/|$)|admin(?:\/|$)|_agnes(?:\/|$)|__agnes(?:\/|$)|plugins\/|skins\/|healthz$)/u.test(
      target.pathname,
    )
  )
    return value
  const base = /^wss?:$/u.test(target.protocol) ? remote.replace(/^http/u, 'ws') : remote
  return `${base}${remoteAccessPath(remote)}${target.pathname}${target.search}${target.hash}`
}

/** Request bodies/signals remain intact; an A-origin request never carries A's cookies to B. */
export function remoteFrontendFetch(original: typeof fetch, remote: string, local: string): typeof fetch {
  return async (input, init) => {
    const address = input instanceof Request ? input.url : String(input)
    const target = backendResourceUrl(address, remote, local)
    if (target === address) return original(input, init)
    const request = input instanceof Request ? new Request(target, input) : new Request(target)
    return original(new Request(request, { ...init, credentials: 'omit', redirect: 'error' }))
  }
}

/** Bootstrap is completed before importing any session controllers or registering plugin clients. */
export async function readRemoteFrontendInfo(remote: string, signal: AbortSignal, fetcher = fetch) {
  const path = await authorizeRemoteFrontend(remote, signal, fetcher)
  let response = await fetcher(`${remote}${path}${REMOTE_FRONTEND_INFO}`, {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal,
  })
  if (response.status === 401) {
    forgetRemoteAccess(remote)
    const renewed = await authorizeRemoteFrontend(remote, signal, fetcher)
    response = await fetcher(`${remote}${renewed}${REMOTE_FRONTEND_INFO}`, {
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal,
    })
  }
  if (!response.ok) throw new Error('Cloud connection denied / 云端连接未获授权')
  const info = (await response.json()) as {
    version?: unknown
    access?: unknown
    wsPath?: unknown
    instanceId?: unknown
  }
  if (
    !response.ok ||
    info.version !== REMOTE_FRONTEND_KEY_VERSION ||
    info.access !== 'key-owner' ||
    info.wsPath !== REMOTE_FRONTEND_WS ||
    typeof info.instanceId !== 'string' ||
    !info.instanceId ||
    info.instanceId.length > 256
  )
    throw new Error('The remote service is unavailable or incompatible. / 远程服务不可用或版本不兼容。')
  return { instanceId: info.instanceId }
}

export async function prepareRemoteFrontend(): Promise<void> {
  const remote = selectedRemoteOrigin()
  if (!remote) return
  const original = window.fetch.bind(window)
  const info = await readRemoteFrontendInfo(remote, AbortSignal.timeout(8000), original)
  const meta = document.querySelector<HTMLMetaElement>('meta#agnes-config')
  if (!meta) throw new Error('missing frontend configuration')
  meta.dataset.ws = `${remote.replace(/^http/u, 'ws')}${remoteAccessPath(remote)}${REMOTE_FRONTEND_WS}`
  meta.dataset.backend = JSON.stringify([remote, info.instanceId])
  window.fetch = remoteFrontendFetch(original, remote, location.origin)
  const NativeSocket = window.WebSocket
  window.WebSocket = class extends NativeSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(backendResourceUrl(String(url), remote), protocols)
    }
  }
}
