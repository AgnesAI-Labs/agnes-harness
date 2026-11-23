import { discoverCloudOrigin, forgetRemoteAccess } from '../remote-authorization.js'
import { readRemoteFrontendInfo } from '../remote-frontend.js'

/** Re-discover an existing offline instance, with bounded attempts and no business replay. */
export function watchCloudOrigin(
  origin: string,
  discover: (signal: AbortSignal) => Promise<string>,
  changed: (origin: string) => void,
  failed: (reason: string) => void,
  verify?: (origin: string, signal: AbortSignal) => Promise<boolean>,
): () => void {
  const request = new AbortController()
  let delay = 1000,
    attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = async () => {
    if (request.signal.aborted) return
    attempts++
    const attempt = new AbortController()
    const abort = () => attempt.abort()
    request.signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, 25_000)
    let failure = 'CLOUD_AUTH_UNAVAILABLE'
    try {
      const next = await discover(attempt.signal)
      if (request.signal.aborted) return
      attempt.signal.throwIfAborted()
      if (next !== origin || (verify && (await verify(next, attempt.signal)))) {
        if (request.signal.aborted) return
        attempt.signal.throwIfAborted()
        changed(next)
        return
      }
    } catch (error) {
      if (request.signal.aborted) return
      if (
        error instanceof Error &&
        /^CLOUD_(?:CREDENTIAL_NOT_FOUND|INVALID_AUTHORIZATION)$/u.test(error.message)
      ) {
        failed(error.message)
        return
      }
      // Disabled lifecycle Keys and permanently rejected Keys share this response. Retry only
      // discovery within this bounded budget; no authorization or business request is inferred.
      if (error instanceof Error && error.message === 'CLOUD_CREDENTIAL_REJECTED') failure = error.message
    } finally {
      clearTimeout(timeout)
      request.signal.removeEventListener('abort', abort)
    }
    if (attempts >= 8) {
      failed(failure)
      return
    }
    timer = setTimeout(() => void poll(), delay)
    delay = Math.min(delay * 2, 30_000)
  }
  timer = setTimeout(() => void poll(), delay)
  return () => {
    request.abort()
    clearTimeout(timer)
  }
}

export function watchCloudBackendRecovery(options: {
  cloud: string
  credentialRef: string
  managed: boolean
  canWatch: () => boolean
  onRecovered: (origin: string) => void
  onFailed: (reason: string) => void
}): () => void {
  return watchCloudOrigin(
    options.cloud,
    (signal) =>
      options.managed
        ? discoverCloudOrigin(options.credentialRef, signal, undefined, options.canWatch)
        : Promise.resolve(options.cloud),
    (origin) => {
      if (options.canWatch()) options.onRecovered(origin)
    },
    options.onFailed,
    async (origin, signal) => {
      if (!options.canWatch()) return false
      if (!options.managed) forgetRemoteAccess(origin)
      await readRemoteFrontendInfo(origin, signal)
      return options.canWatch()
    },
  )
}
