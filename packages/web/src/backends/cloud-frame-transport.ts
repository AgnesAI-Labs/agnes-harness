import { REMOTE_FRONTEND_SESSION_PREFIX, remoteFrontendSessionPath } from '@agnes/protocol'
import { applyCloudFrameAppearance } from './cloud-frame-appearance.js'
import { backendFrame } from './frame-context.js'
import { BACKEND_FRAME_MESSAGE } from './frame-contract.js'

let appearanceBound = false
function bindAppearance() {
  if (appearanceBound) return
  appearanceBound = true
  const receive = (event: MessageEvent) => {
    if (
      event.source === window.parent &&
      event.origin === backendFrame()?.parentOrigin &&
      event.data?.type === BACKEND_FRAME_MESSAGE &&
      event.data.kind === 'appearance'
    )
      applyCloudFrameAppearance(event.data.appearance)
  }
  window.addEventListener('message', receive)
  window.addEventListener('pagehide', () => window.removeEventListener('message', receive), { once: true })
}

/** Cross-origin browser messaging carries only a B-scoped temporary capability. */
export function requestCloudFrameAuthorization(remote: string, signal: AbortSignal): Promise<string> {
  const context = backendFrame()
  if (!context?.remote || context.remote !== remote) return Promise.reject(new Error('CLOUD_ORIGIN_DENIED'))
  bindAppearance()
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const fail = () => {
      cleanup()
      reject(new Error('CLOUD_AUTH_UNAVAILABLE'))
    }
    const receive = (event: MessageEvent) => {
      const data = event.data
      if (
        event.source !== window.parent ||
        event.origin !== context.parentOrigin ||
        data?.type !== BACKEND_FRAME_MESSAGE ||
        data.kind !== 'authorization' ||
        data.requestId !== requestId ||
        data.remote !== remote
      )
        return
      cleanup()
      applyCloudFrameAppearance(data.appearance)
      if (typeof data.error === 'string') {
        reject(new Error(data.error))
        return
      }
      try {
        if (typeof data.path !== 'string' || !data.path.startsWith(REMOTE_FRONTEND_SESSION_PREFIX))
          throw Error('path')
        const token = data.path.slice(REMOTE_FRONTEND_SESSION_PREFIX.length)
        resolve(remoteFrontendSessionPath(token))
      } catch {
        reject(new Error('CLOUD_AUTH_UNAVAILABLE'))
      }
    }
    const timer = setTimeout(fail, 15_000)
    const cleanup = () => {
      clearTimeout(timer)
      window.removeEventListener('message', receive)
      signal.removeEventListener('abort', fail)
    }
    window.addEventListener('message', receive)
    signal.addEventListener('abort', fail, { once: true })
    if (signal.aborted) {
      fail()
      return
    }
    window.parent.postMessage(
      { type: BACKEND_FRAME_MESSAGE, kind: 'authorization-request', requestId },
      context.parentOrigin,
    )
  })
}
