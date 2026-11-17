import type { LocaleTranslator } from './ui-locale.js'

export type McpAuthorizeDeps = Readonly<{
  fetch: typeof fetch
  location: Pick<Location, 'origin'>
  t: LocaleTranslator
  /** Resolves true only when the user agrees to continue. */
  confirm(text: string): Promise<boolean>
  navigate(url: string): void
}>

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The same origin, or the same port with only the loopback host spelled differently. */
function reachableFromHere(redirectUri: string, pageOrigin: string): boolean {
  try {
    const callback = new URL(redirectUri)
    const page = new URL(pageOrigin)
    if (callback.origin === page.origin) return true
    return (
      callback.protocol === page.protocol &&
      callback.port === page.port &&
      LOOPBACK_HOSTS.has(callback.hostname) &&
      LOOPBACK_HOSTS.has(page.hostname)
    )
  } catch {
    return false
  }
}

async function start(
  startUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ authorizeUrl: string; redirectUri: string } | undefined> {
  try {
    const response = await fetchImpl(startUrl, { headers: { accept: 'application/json' } })
    const body = (await response.json()) as { authorizeUrl?: unknown; redirectUri?: unknown }
    if (response.ok && typeof body.authorizeUrl === 'string' && typeof body.redirectUri === 'string')
      return { authorizeUrl: body.authorizeUrl, redirectUri: body.redirectUri }
  } catch {
    // Falls through: the start page itself shows what went wrong.
  }
  return undefined
}

/**
 * Starts the browser sign-in for one MCP server in the current tab (a popup opened after an await
 * would be blocked). The callback address is checked first: when this page could not reach it, the
 * user is told before leaving. A failed start opens the start address itself, which answers a
 * readable page with the reason.
 */
export async function authorizeMcpServer(serverId: string, deps: McpAuthorizeDeps): Promise<void> {
  const startUrl = `/oauth/${encodeURIComponent(serverId)}/start`
  const started = await start(startUrl, deps.fetch)
  if (!started) return deps.navigate(startUrl)
  if (
    !reachableFromHere(started.redirectUri, deps.location.origin) &&
    !(await deps.confirm(deps.t('mcp.oauth.leave.text', { address: started.redirectUri, id: serverId })))
  )
    return
  deps.navigate(started.authorizeUrl)
}
