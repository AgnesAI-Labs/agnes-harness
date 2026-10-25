import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { LOCAL_WEB_TICKET_PROTOCOL_PREFIX } from '@agnes/protocol'

/**
 * Short-lived, single-use admission tickets for the local Web WebSocket.
 *
 * The daemon's per-launch Web secret stays in the 0600 credential file and in the launcher's
 * memory; the browser never sees it. The launcher signs a ticket with it for each connection the
 * page opens (after the page proved its session cookie), and the page offers the ticket as a
 * WebSocket subprotocol. The daemon checks the signature in constant time, the expiry and that the
 * nonce was not used before.
 */
export const WEB_TICKET_PROTOCOL_PREFIX = LOCAL_WEB_TICKET_PROTOCOL_PREFIX
export const WEB_TICKET_TTL_MS = 30_000
const CONTEXT = 'agnes-local-web-ticket\u0000'

function mac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret)
    .update(CONTEXT + body)
    .digest()
}

export function mintWebTicket(secret: string, now = Date.now()): string {
  if (!secret) throw new Error('local Web secret is required')
  const body = `${(now + WEB_TICKET_TTL_MS).toString(36)}.${randomBytes(18).toString('base64url')}`
  return `${body}.${mac(secret, body).toString('base64url')}`
}

export type WebTicketVerifier = (ticket: string | undefined, now?: number) => boolean

/** One verifier per listener: it owns the nonce memory that makes each ticket single use. */
export function webTicketVerifier(secret: string): WebTicketVerifier {
  const used = new Map<string, number>()
  return (ticket, now = Date.now()) => {
    for (const [nonce, expires] of used) if (expires <= now) used.delete(nonce)
    const parts = ticket?.split('.')
    if (parts?.length !== 3) return false
    const [expiry, nonce, signature] = parts as [string, string, string]
    const expires = Number.parseInt(expiry, 36)
    if (!/^[0-9a-z]{1,12}$/.test(expiry) || !Number.isSafeInteger(expires)) return false
    if (expires <= now || expires > now + WEB_TICKET_TTL_MS) return false
    const given = Buffer.from(signature, 'base64url')
    const expected = mac(secret, `${expiry}.${nonce}`)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
    if (used.has(nonce)) return false
    used.set(nonce, expires)
    return true
  }
}
