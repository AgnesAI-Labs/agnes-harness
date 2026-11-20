import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { REMOTE_FRONTEND_SESSION_PREFIX, remoteFrontendSessionPath } from '@agnes/protocol'

const LIFETIME_MS = 8 * 60 * 60 * 1000
const equal = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b)

/** The plugin supplies a verifier, never its original third-party credential. */
export function publicationAuthentication(digest: string) {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('invalid publication authentication')
  const secret = Buffer.from(digest, 'hex')
  const sign = (value: string) =>
    createHmac('sha256', secret).update(`agh-frontend-session/v1:${value}`).digest()
  return {
    async exchange(req: IncomingMessage): Promise<{ token: string; expiresAt: number } | undefined> {
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        const data = Buffer.from(chunk)
        bytes += data.length
        if (bytes > 16_384) return undefined
        chunks.push(data)
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { key?: unknown }
        if (typeof value.key !== 'string' || !value.key.trim() || value.key.length > 4096) return
        if (!equal(createHash('sha256').update(value.key).digest(), secret)) return
        const expiresAt = Date.now() + LIFETIME_MS
        const payload = `${expiresAt.toString(36)}.${randomBytes(16).toString('base64url')}`
        return { token: `${payload}.${sign(payload).toString('base64url')}`, expiresAt }
      } catch {
        return undefined
      }
    },
    resolve(url: string): { url: string; expiresAt: number; prefix: string } | undefined {
      if (!url.startsWith(REMOTE_FRONTEND_SESSION_PREFIX)) return
      const at = url.indexOf('/', REMOTE_FRONTEND_SESSION_PREFIX.length)
      if (at < 0) return
      const token = url.slice(REMOTE_FRONTEND_SESSION_PREFIX.length, at)
      try {
        const prefix = remoteFrontendSessionPath(token)
        const [expiry, nonce, signature] = token.split('.')
        const expiresAt = Number.parseInt(expiry ?? '', 36)
        if (expiresAt <= Date.now() || expiresAt > Date.now() + LIFETIME_MS) return
        if (
          !equal(Buffer.from(sign(`${expiry}.${nonce}`).toString('base64url')), Buffer.from(signature ?? ''))
        )
          return
        return { url: url.slice(at), expiresAt, prefix }
      } catch {
        return undefined
      }
    },
  }
}
