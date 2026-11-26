import { CLOUD_AUTHORIZATION_TIMEOUT_MS } from '@agnes/protocol'
import { authorizeRemoteFrontend, forgetRemoteAccess, remoteUsesGateway } from '../remote-authorization.js'
import { cloudFrameAppearance } from './cloud-frame-appearance.js'
import { cloudFrameOrigin } from './frame-context.js'
import { BACKEND_FRAME_MESSAGE } from './frame-contract.js'

const PARENT_AUTHORIZATION_TIMEOUT_MS = CLOUD_AUTHORIZATION_TIMEOUT_MS + 10_000

/** A alone resolves credentials. The cloud can request only its already configured connection. */
export function installCloudFrameAuthorization(
  current: () => {
    remote: string | undefined
    frame: HTMLIFrameElement | undefined
  },
  onControl?: (abort: () => void) => void,
): () => void {
  const frameOrigin = cloudFrameOrigin()
  let pending:
    | {
        controller: AbortController
        timer: ReturnType<typeof setTimeout>
        frame: HTMLIFrameElement
        remote: string
        requestIds: Set<string>
      }
    | undefined
  let disposed = false
  const abortPending = () => {
    if (!pending) return
    clearTimeout(pending.timer)
    pending.controller.abort()
    pending = undefined
  }
  onControl?.(abortPending)
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
    let requestIds: Set<string>
    if (pending?.frame === frame && pending.remote === remote) {
      if (!fresh) {
        pending.requestIds.add(value.requestId)
        return
      }
      requestIds = new Set([...pending.requestIds, value.requestId])
    } else {
      requestIds = new Set([value.requestId])
    }
    abortPending()
    const request = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      request.abort()
    }, PARENT_AUTHORIZATION_TIMEOUT_MS)
    const entry = { controller: request, timer, frame, remote, requestIds }
    pending = entry
    if (fresh) forgetRemoteAccess(remote)
    void (async () => {
      let authorization: { path: string; proxied?: boolean } | { error: string }
      try {
        authorization = {
          path: await authorizeRemoteFrontend(remote, request.signal, window.fetch.bind(window), fresh),
          proxied: remoteUsesGateway(remote),
        }
      } catch (error) {
        if (!timedOut && (disposed || request.signal.aborted)) return
        authorization = {
          error: timedOut
            ? 'CLOUD_AUTH_UNAVAILABLE'
            : error instanceof Error
              ? error.message.slice(0, 4096)
              : 'CLOUD_AUTH_UNAVAILABLE',
        }
      }
      const next = current()
      if (
        !disposed &&
        (!request.signal.aborted || timedOut) &&
        next.remote === remote &&
        next.frame === frame
      ) {
        const snapshot = cloudFrameAppearance()
        for (const requestId of entry.requestIds)
          frame.contentWindow?.postMessage(
            {
              type: BACKEND_FRAME_MESSAGE,
              kind: 'authorization',
              requestId,
              remote,
              ...authorization,
              appearance: snapshot,
            },
            frameOrigin,
          )
      }
    })().finally(() => {
      clearTimeout(timer)
      if (pending === entry) pending = undefined
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
    abortPending()
    rootObserver?.disconnect()
    window.removeEventListener('message', receive)
    window.removeEventListener('storage', appearance)
    window.removeEventListener('agnes:theme-changed', appearance)
  }
}
