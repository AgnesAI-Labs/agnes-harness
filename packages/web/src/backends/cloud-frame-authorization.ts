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
): () => void {
  const frameOrigin = cloudFrameOrigin()
  let pending: { controller: AbortController; frame: HTMLIFrameElement; remote: string } | undefined
  let disposed = false
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
      !/^[a-f0-9-]{36}$/u.test(value.requestId)
    )
      return
    if (pending?.frame === frame && pending.remote === remote) return
    pending?.controller.abort()
    const request = new AbortController()
    pending = { controller: request, frame, remote }
    forgetRemoteAccess(remote)
    void (async () => {
      let authorization: { path: string; proxied?: boolean } | { error: string }
      try {
        authorization = {
          path: await authorizeRemoteFrontend(remote, request.signal, window.fetch.bind(window)),
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
  window.addEventListener('message', receive)
  window.addEventListener('storage', appearance)
  return () => {
    disposed = true
    pending?.controller.abort()
    window.removeEventListener('message', receive)
    window.removeEventListener('storage', appearance)
  }
}
