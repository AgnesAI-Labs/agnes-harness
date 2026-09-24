export const AGNES_AUTHORIZATION_ORIGIN = 'https://platform.agnes-ai.com'

export interface BrowserPlatformAdapter {
  open(url: string): void | Promise<void>
}

export class BrowserAuthorizationError extends Error {
  readonly code: 'AUTHORIZATION_URL_UNTRUSTED' | 'BROWSER_OPEN_FAILED'

  constructor(code: BrowserAuthorizationError['code'], message: string) {
    super(message)
    this.name = 'BrowserAuthorizationError'
    this.code = code
  }
}

function invalidAuthorizationUrl(): never {
  // Never include the input: request ids and other authorization parameters are confidential.
  throw new BrowserAuthorizationError(
    'AUTHORIZATION_URL_UNTRUSTED',
    'authorization URL is not from the trusted origin',
  )
}

function parseOrigin(origin: string): URL {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return invalidAuthorizationUrl()
  }
  if (
    parsed.origin === 'null' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return invalidAuthorizationUrl()
  }
  return parsed
}

function validateAuthorizationUrl(input: string | URL, trustedOrigin: string): URL {
  const trusted = parseOrigin(trustedOrigin)
  let url: URL
  try {
    url = new URL(input instanceof URL ? input.href : input)
  } catch {
    return invalidAuthorizationUrl()
  }
  if (
    url.origin !== trusted.origin ||
    url.protocol !== trusted.protocol ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    return invalidAuthorizationUrl()
  }
  return url
}

/**
 * Generic seam for a fake platform. There is deliberately no default origin: a non-Agnes origin
 * only becomes trusted when a test (or another explicit embedding) supplies it at the call site.
 */
export async function openAuthorizationUrl(
  input: string | URL,
  platform: BrowserPlatformAdapter,
  trustedOrigin: string,
): Promise<void> {
  const url = validateAuthorizationUrl(input, trustedOrigin)
  try {
    await platform.open(url.href)
  } catch {
    // Platform errors can echo the URL or command line, so do not retain them as a cause.
    throw new BrowserAuthorizationError('BROWSER_OPEN_FAILED', 'could not open the authorization page')
  }
}

/** Production entry point: its trust policy cannot be widened through options or environment. */
export function openAgnesAuthorizationUrl(
  input: string | URL,
  platform: BrowserPlatformAdapter,
): Promise<void> {
  return openAuthorizationUrl(input, platform, AGNES_AUTHORIZATION_ORIGIN)
}
