// Node-only: HMAC signing needs `node:crypto`, so this module (unlike jcs.ts) never reaches the
// browser build (see index.browser.ts and Task 22's browser-imports scan).
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { type Auth, META_KEY } from '@agnes/protocol'
import { type AuthOption, type AuthProvider, jwtAuth, localAuth, portalIdentityAuth } from './auth.js'
import { jcs } from './jcs.js'

export type SourceAuthPayload = { kind: 'source-auth'; timestamp: number; signature: string; nonce: string }

function stripAuth(params: Record<string, unknown>): Record<string, unknown> {
  const meta = params._meta as Record<string, unknown> | undefined
  const harness = meta?.[META_KEY] as Record<string, unknown> | undefined
  if (!harness || !('auth' in harness)) return params
  const { auth: _drop, ...rest } = harness
  return { ...params, _meta: { ...meta, [META_KEY]: rest } }
}

export function sourceAuthCanonical(clientId: string, initializeParams: Record<string, unknown>): string {
  return `initialize\n${clientId}\n${createHash('sha256')
    .update(jcs(stripAuth(initializeParams)))
    .digest('hex')}`
}

export function signSourceAuth(
  clientId: string,
  initializeParams: Record<string, unknown>,
  secret: string,
  opts: { now?: () => number; nonce?: () => string } = {},
): SourceAuthPayload {
  const timestamp = Math.floor((opts.now ?? Date.now)() / 1000)
  // nonce generated before the signature, not after: it is part of what gets signed (2026-09-10
  // security ruling — the original formula left nonce unsigned, so a captured (timestamp, canonical,
  // signature) triple verified under any substituted nonce, defeating nonce-based replay rejection).
  const nonce = (opts.nonce ?? (() => randomBytes(16).toString('hex')))()
  const canonical = sourceAuthCanonical(clientId, initializeParams)
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${nonce}:${canonical}`).digest('hex')}`
  return { kind: 'source-auth', timestamp, signature, nonce }
}

export function sourceAuthProvider(
  secret: string | undefined,
  env: { nodeEnv?: string | undefined } = { nodeEnv: process.env.NODE_ENV },
): AuthProvider {
  if (!secret) {
    if (env.nodeEnv !== 'development') throw new Error('source-auth secret required outside development')
    console.warn('[agnes-sdk] source-auth secret missing; sending unsigned local auth (development only)')
    return localAuth()
  }
  return {
    kind: 'source-auth',
    async build({ clientId, initializeParams }): Promise<Auth> {
      return signSourceAuth(clientId, initializeParams, secret)
    },
  }
}

/** Builds the composite Surface credential. Source proof and subject are produced from the same
 * immutable initialize payload, while sourceId remains a deployment identifier rather than a
 * browser-controlled request field. */
export function surfaceAuthProvider(option: Extract<AuthOption, { kind: 'surface' }>): AuthProvider {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(option.sourceId)) throw new TypeError('invalid Surface sourceId')
  if (!option.secret) throw new Error('surface source-auth secret required')
  const subject =
    option.subject.kind === 'jwt' ? jwtAuth(option.subject.token) : portalIdentityAuth(option.subject.token)
  return {
    kind: 'surface',
    async build(ctx): Promise<Auth> {
      const subjectCredential = await subject.build(ctx)
      if (
        !subjectCredential ||
        (subjectCredential.kind !== 'jwt' && subjectCredential.kind !== 'portal-identity')
      )
        throw new Error('surface subject credential unavailable')
      return {
        kind: 'surface',
        sourceId: option.sourceId,
        source: signSourceAuth(ctx.clientId, ctx.initializeParams, option.secret),
        subject: subjectCredential,
      }
    },
  }
}
