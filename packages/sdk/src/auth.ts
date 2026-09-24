// Connection-level credentials. The client never decides which credential shapes it
// can produce: the build entry point injects the providers it is willing to ship, so
// a browser bundle simply has no way to reach the node-only signing paths.
import type { Auth } from '@agnes/protocol'

export type AuthOption =
  | { kind: 'local' }
  | { kind: 'jwt'; token: string | (() => Promise<string>) }
  | { kind: 'source-auth'; secret: string }
  | { kind: 'portal-identity'; token: string }
  | {
      kind: 'surface'
      sourceId: string
      secret: string
      subject:
        | { kind: 'jwt'; token: string | (() => Promise<string>) }
        | { kind: 'portal-identity'; token: string }
    }

export interface AuthProvider {
  readonly kind: string
  // Returning undefined means "send no credential at all", which is different from
  // sending an empty one: the `auth` key is left off the handshake entirely.
  build(ctx: {
    clientId: string
    initializeParams: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<Auth | undefined>
}

// The stdio / unix default: the OS boundary is the credential.
export function localAuth(): AuthProvider {
  return {
    kind: 'local',
    async build() {
      return { kind: 'local' }
    },
  }
}

function validToken(token: unknown): token is string {
  return typeof token === 'string' && token.length > 0
}
export function jwtAuth(token: string | (() => Promise<string>)): AuthProvider {
  return {
    kind: 'jwt',
    async build() {
      try {
        const value = typeof token === 'function' ? await token() : token
        if (!validToken(value)) throw new Error()
        return { kind: 'jwt', token: value }
      } catch {
        throw new Error('jwt credential unavailable')
      }
    },
  }
}
export function portalIdentityAuth(token: string): AuthProvider {
  return {
    kind: 'portal-identity',
    async build() {
      if (!validToken(token)) throw new Error('portal credential unavailable')
      return { kind: 'portal-identity', token }
    },
  }
}
