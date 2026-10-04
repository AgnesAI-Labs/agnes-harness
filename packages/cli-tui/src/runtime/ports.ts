import type { RuntimeError } from '@agnes/protocol/runtime'

/**
 * One call's result on the SDK runtime client transport, restated because the SDK keeps that client off
 * its public entry point; a port wired to the transport returns its result unchanged. `refused` never
 * left the client, and `unknown` was sent but has no verified reply.
 */
export type RuntimeCallResult<T> =
  | { state: 'ok'; value: T }
  | { state: 'failed'; error: RuntimeError }
  | { state: 'refused'; reason: string }
  | { state: 'unknown'; reason: string }

/**
 * A link the server issued, as the user can open it: a route is joined to the deployment base the
 * transport uses, mount prefix included. Anything outside the base's origin is refused.
 */
export function linkUrl(baseUrl: string, link: string): string | undefined {
  try {
    const base = new URL(baseUrl)
    const route = link.startsWith('/') && !link.startsWith('//')
    const url = new URL(route ? base.href.replace(/\/+$/, '') + link : link)
    return url.origin === base.origin ? url.href : undefined
  } catch {
    return undefined
  }
}
