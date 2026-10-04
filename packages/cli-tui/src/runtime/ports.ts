/** One call's result on the SDK runtime client transport; a port wired to it returns the result unchanged. */
export type { CallResult as RuntimeCallResult } from '@agnes/sdk/runtime'

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
