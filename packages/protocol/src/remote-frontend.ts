/** Public, plugin-owned publication contract; it is not an RPC authentication credential. */
export const REMOTE_FRONTEND_SERVICE = 'frontend.publish'
export const REMOTE_FRONTEND_VERSION = 'agh-public-frontend/v1'
export const REMOTE_FRONTEND_INFO = '/_agnes/remote-frontend'
export const REMOTE_FRONTEND_WS = '/_agnes/remote-frontend/ws'
export const REMOTE_FRONTEND_AUTH = '/_agnes/remote-frontend/auth'
export const REMOTE_FRONTEND_KEY_VERSION = 'agh-key-frontend/v1'
export const REMOTE_FRONTEND_SESSION_PREFIX = '/_agnes/remote-access/'
/** A-origin BFF: resolves a managed credential in A's daemon, returning only a temporary capability. */
export const CLOUD_AUTHORIZATION_PATH = '/_agnes/cloud-connection/authorize'

export type FrontendPublication = {
  enabled: boolean
  /** Enabling this contract explicitly publishes this profile's local-owner authority. */
  access: 'public-owner' | 'key-owner'
  /** A verifier only. The original third-party Key stays in the cloud plugin. */
  auth?: { keySha256: string }
  host: string
  port: number
  tls?: { certFile: string; keyFile: string }
}

export function frontendPublication(value: unknown): FrontendPublication {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid publication')
  const p = value as Record<string, unknown>
  if (
    typeof p.enabled !== 'boolean' ||
    !['public-owner', 'key-owner'].includes(String(p.access)) ||
    typeof p.host !== 'string' ||
    !p.host ||
    /[\s/\\]/u.test(p.host) ||
    p.host.includes('\0') ||
    !Number.isInteger(p.port) ||
    Number(p.port) < 0 ||
    Number(p.port) > 65535
  )
    throw new Error('invalid publication')
  let tls: FrontendPublication['tls']
  if (p.tls !== undefined) {
    const t = p.tls as Record<string, unknown> | null
    if (!t || typeof t.certFile !== 'string' || !t.certFile || typeof t.keyFile !== 'string' || !t.keyFile)
      throw new Error('invalid publication TLS')
    tls = { certFile: t.certFile, keyFile: t.keyFile }
  }
  let auth: FrontendPublication['auth']
  if (p.access === 'key-owner') {
    const value = p.auth as Record<string, unknown> | undefined
    if (!value || typeof value.keySha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.keySha256))
      throw new Error('invalid publication authentication')
    auth = { keySha256: value.keySha256 }
  } else if (p.auth !== undefined) throw new Error('invalid publication authentication')
  return {
    enabled: p.enabled,
    access: p.access as FrontendPublication['access'],
    host: p.host,
    port: Number(p.port),
    ...(tls ? { tls } : {}),
    ...(auth ? { auth } : {}),
  }
}

/** Temporary bearer capability for browser module resources; never put the third-party Key here. */
export function remoteFrontendSessionPath(token: string): string {
  if (!/^[a-z0-9]+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u.test(token))
    throw new Error('invalid frontend session')
  return `${REMOTE_FRONTEND_SESSION_PREFIX}${token}`
}

/** Only an explicit HTTP(S) origin, never a URL carrying credentials, a path or a fragment. */
export function remoteFrontendOrigin(value: string): string {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !/^[a-z0-9.:[\]-]+$/iu.test(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('enter an HTTP(S) service origin')
  return url.origin
}

/** Preserve the selected backend when opening a session/settings link in a new browser context. */
export function withRemoteFrontend(href: string, base?: string): string {
  if (!base) return href
  const current = new URL(base)
  const target = new URL(href, current)
  const remote = current.searchParams.get('remote')
  if (!remote || target.origin !== current.origin || target.searchParams.has('remote')) return href
  target.searchParams.set('remote', remoteFrontendOrigin(remote))
  return `${target.pathname}${target.search}${target.hash}`
}
