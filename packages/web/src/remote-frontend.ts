import {
  REMOTE_FRONTEND_INFO,
  REMOTE_FRONTEND_VERSION,
  REMOTE_FRONTEND_WS,
  remoteFrontendOrigin,
} from '@agnes/protocol'

export function selectedRemoteOrigin(search = globalThis.location?.search ?? ''): string | undefined {
  const value = new URLSearchParams(search).get('remote')
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
  if (target.origin !== local && target.origin !== localWs) return value
  if (
    !/^\/(?:api(?:\/|$)|admin(?:\/|$)|_agnes(?:\/|$)|__agnes(?:\/|$)|plugins\/|skins\/|healthz$)/u.test(
      target.pathname,
    )
  )
    return value
  const base = /^wss?:$/u.test(target.protocol) ? remote.replace(/^http/u, 'ws') : remote
  return `${base}${target.pathname}${target.search}${target.hash}`
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
  const response = await fetcher(`${remote}${REMOTE_FRONTEND_INFO}`, {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal,
  })
  const info = (await response.json()) as {
    version?: unknown
    access?: unknown
    wsPath?: unknown
    instanceId?: unknown
  }
  if (
    !response.ok ||
    info.version !== REMOTE_FRONTEND_VERSION ||
    info.access !== 'public-owner' ||
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
  meta.dataset.ws = `${remote.replace(/^http/u, 'ws')}${REMOTE_FRONTEND_WS}`
  meta.dataset.backend = JSON.stringify([remote, info.instanceId])
  window.fetch = remoteFrontendFetch(original, remote, location.origin)
  const NativeSocket = window.WebSocket
  window.WebSocket = class extends NativeSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(backendResourceUrl(String(url), remote), protocols)
    }
  }
}
