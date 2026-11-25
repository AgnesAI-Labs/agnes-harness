import type { IncomingMessage, ServerResponse } from 'node:http'
import { CLOUD_AUTHORIZATION_PATH, remoteFrontendOrigin, validateMethod } from '@agnes/protocol'
import type { AdminCloudAuthorization, AdminCloudAuthorize } from '@agnes/protocol/gen/app-server'

type Authorize = (input: AdminCloudAuthorize, signal: AbortSignal) => Promise<AdminCloudAuthorization>

/** Reuse the exchange while any browser request or gateway renewal still needs it. */
export function shareCloudAuthorization(invoke: Authorize) {
  const pending = new Map<
    string,
    { controller: AbortController; result: Promise<AdminCloudAuthorization>; waiters: number }
  >()
  return (input: AdminCloudAuthorize, signal: AbortSignal): Promise<AdminCloudAuthorization> => {
    if (signal.aborted) return Promise.reject(signal.reason)
    const key = `${input.credentialRef}\0${input.origin ?? ''}`
    let exchange = pending.get(key)
    if (!exchange) {
      const controller = new AbortController()
      const result = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted()
          return invoke(input, controller.signal)
        })
        .finally(() => {
          if (pending.get(key)?.controller === controller) pending.delete(key)
        })
      exchange = { controller, result, waiters: 0 }
      pending.set(key, exchange)
    }
    const shared = exchange
    shared.waiters++
    return new Promise((resolve, reject) => {
      const release = () => {
        signal.removeEventListener('abort', abort)
        shared.waiters--
      }
      const abort = () => {
        release()
        reject(signal.reason)
        if (shared.waiters === 0 && pending.get(key) === shared) {
          pending.delete(key)
          shared.controller.abort()
        }
      }
      signal.addEventListener('abort', abort, { once: true })
      void shared.result.then(
        (value) => {
          if (signal.aborted) return
          release()
          resolve(value)
        },
        (error) => {
          if (signal.aborted) return
          release()
          reject(error)
        },
      )
    })
  }
}

/** A-only fixed BFF. The daemon resolves the reference and exchanges the Key; it never returns it. */
export function cloudAuthorizationRelay(
  origin: string,
  invoke: Authorize,
  register?: (origin: string, result: AdminCloudAuthorization, input: AdminCloudAuthorize) => boolean,
) {
  const pending = new Map<AbortController, { ref: string; revoke(reason: string): void }>()
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', origin)
    if (url.pathname !== CLOUD_AUTHORIZATION_PATH) return false
    const reply = (status: number, value: unknown) => {
      if (request.aborted || response.destroyed || response.writableEnded) return
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(value))
    }
    if (
      request.method !== 'POST' ||
      url.search ||
      request.headers.host !== new URL(origin).host ||
      request.headers.origin !== origin ||
      (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')
    ) {
      request.resume()
      reply(403, { error: 'CLOUD_ORIGIN_DENIED' })
      return true
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    const requestClosed = () => {
      if (request.aborted || !request.complete) abort()
    }
    const responseClosed = () => {
      if (!response.writableFinished) abort()
    }
    request.once('aborted', abort)
    request.once('close', requestClosed)
    request.once('error', abort)
    response.once('close', responseClosed)
    response.once('error', abort)
    try {
      if (request.aborted || response.destroyed || response.writableEnded) return true
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw Error('input')
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        const part = Buffer.from(chunk)
        bytes += part.length
        if (bytes > 8192) throw Error('input')
        chunks.push(part)
      }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!validateMethod('_agnes/v1/admin.cloud.authorize', 'params', input).ok) throw Error('input')
      if (controller.signal.aborted) return true
      const bindingInput = input as AdminCloudAuthorize
      pending.set(controller, {
        ref: bindingInput.credentialRef,
        revoke(reason) {
          abort()
          reply(400, { error: reason })
        },
      })
      const result = await invoke(bindingInput, controller.signal)
      if (!validateMethod('_agnes/v1/admin.cloud.authorize', 'result', result).ok) throw Error('response')
      if (controller.signal.aborted || request.aborted || response.destroyed || response.writableEnded)
        return true
      const requestedOrigin = (input as AdminCloudAuthorize).origin
      const target = result.origin ?? requestedOrigin
      if (requestedOrigin === undefined && !result.trafficToken) throw Error('sandbox credential required')
      if (
        !target ||
        remoteFrontendOrigin(target) !== target ||
        (requestedOrigin !== undefined && result.origin !== undefined && result.origin !== requestedOrigin)
      )
        throw Error('invalid cloud target')
      // A transport refresh stays bound to this instance even after Key-only discovery.
      const binding = { ...(input as AdminCloudAuthorize), origin: target }
      const proxied = result.trafficToken ? register?.(target, result, binding) : false
      if (result.trafficToken && !proxied) throw Error('sandbox transport unavailable')
      reply(200, {
        token: result.token,
        expiresAt: result.expiresAt,
        ...(proxied ? { proxied: true } : {}),
        ...(result.origin ? { origin: result.origin } : {}),
      })
    } catch (error) {
      if (controller.signal.aborted) return true
      const reason = (error as { data?: { reason?: unknown } })?.data?.reason
      reply(400, {
        error:
          typeof reason === 'string' &&
          /^(?:CONFIG_CREDENTIAL_(?:NOT_FOUND|REJECTED)|CLOUD_(?:BROKER_REQUIRED|CONNECTION_INVALID|SANDBOX_NOT_READY|RATE_LIMITED))$/u.test(
            reason,
          )
            ? reason
            : 'CLOUD_AUTH_UNAVAILABLE',
      })
    } finally {
      pending.delete(controller)
      request.off('aborted', abort)
      request.off('close', requestClosed)
      request.off('error', abort)
      response.off('close', responseClosed)
      response.off('error', abort)
    }
    return true
  }
  return Object.assign(handle, {
    revokeCredential(credentialRef: string) {
      for (const exchange of pending.values())
        if (exchange.ref === credentialRef) exchange.revoke('CONFIG_CREDENTIAL_NOT_FOUND')
    },
    revokeAll() {
      for (const exchange of pending.values()) exchange.revoke('CLOUD_AUTH_UNAVAILABLE')
    },
  })
}
