import { authorizeRemoteFrontend, forgetRemoteAccess, remoteUsesGateway } from '../remote-authorization.js'
import { cloudFrameAppearance } from './cloud-frame-appearance.js'
import { cloudFrameOrigin } from './frame-context.js'
import { BACKEND_FRAME_MESSAGE } from './frame-contract.js'

/** A alone resolves credentials. The cloud can request only its already configured connection. */
export function installCloudFrameAuthorization(
  current: () => {
    remote: string | undefined
    frame: HTMLIFrameElement | undefined
  },
  onControl?: (abort: () => void) => void,
): () => void {
  const frameOrigin = cloudFrameOrigin()
  let pending: { controller: AbortController; frame: HTMLIFrameElement; remote: string } | undefined
  let disposed = false
  onControl?.(() => {
    pending?.controller.abort()
    pending = undefined
  })
  const appearance = () =>
    current().frame?.contentWindow?.postMessage(
      {
        type: BACKEND_FRAME_MESSAGE,
        kind: 'appearance',
        appearance: cloudFrameAppearance(),
      },
      frameOrigin,
    )
  const receive = (event: MessageEvent) => {
    const { remote, frame } = current()
    if (
      !remote ||
      !frame?.contentWindow ||
      event.source !== frame.contentWindow ||
      event.origin !== frameOrigin
    )
      return
    const value = event.data
    if (
      value?.type !== BACKEND_FRAME_MESSAGE ||
      value.kind !== 'authorization-request' ||
      typeof value.requestId !== 'string' ||
      !/^[a-f0-9-]{36}$/u.test(value.requestId) ||
      (value.fresh !== undefined && typeof value.fresh !== 'boolean')
    )
      return
    const fresh = value.fresh === true
    if (pending?.frame === frame && pending.remote === remote) return
    pending?.controller.abort()
    const request = new AbortController()
    pending = { controller: request, frame, remote }
    if (fresh) forgetRemoteAccess(remote)
    void (async () => {
      let authorization: { path: string; proxied?: boolean } | { error: string }
      try {
        authorization = {
          path: await authorizeRemoteFrontend(remote, request.signal, window.fetch.bind(window), fresh),
          proxied: remoteUsesGateway(remote),
        }
      } catch (error) {
        authorization = {
          error: error instanceof Error ? error.message.slice(0, 4096) : 'CLOUD_AUTH_UNAVAILABLE',
        }
      }
      const next = current()
      if (!disposed && !request.signal.aborted && next.remote === remote && next.frame === frame)
        frame.contentWindow?.postMessage(
          {
            type: BACKEND_FRAME_MESSAGE,
            kind: 'authorization',
            requestId: value.requestId,
            remote,
            ...authorization,
            appearance: cloudFrameAppearance(),
          },
          frameOrigin,
        )
    })().finally(() => {
      if (pending?.controller === request) pending = undefined
    })
  }
  const rootObserver =
    typeof MutationObserver === 'function' && document.documentElement
      ? new MutationObserver(appearance)
      : undefined
  rootObserver?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['lang', 'data-theme', 'style'],
  })
  window.addEventListener('message', receive)
  window.addEventListener('storage', appearance)
  window.addEventListener('agnes:theme-changed', appearance)
  return () => {
    disposed = true
    pending?.controller.abort()
    rootObserver?.disconnect()
    window.removeEventListener('message', receive)
    window.removeEventListener('storage', appearance)
    window.removeEventListener('agnes:theme-changed', appearance)
  }
}
