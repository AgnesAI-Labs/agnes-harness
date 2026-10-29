import { createHmac, timingSafeEqual } from 'node:crypto'
import type { WebhookTriggerProvider } from '@agnes/extension-api'
import type { WebhookRule } from '@agnes/protocol/gen/app-server'
import { field } from './payload.js'

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
export function signedBytes(headers: Readonly<Record<string, string>>, body: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from(
      `${headers['x-webhook-timestamp']}\n${headers['x-webhook-id']}\n${headers['x-webhook-event']}\n`,
    ),
    body,
  ])
}
export function signature(secret: string, body: Uint8Array): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}
function timestamp(value: unknown): number {
  if (typeof value === 'number') return value * 1000
  return typeof value === 'string' ? Date.parse(value) : Number.NaN
}
function provider(id: 'github' | 'generic'): WebhookTriggerProvider {
  return {
    id,
    version: '1.0.0',
    async verify({ body, headers, rule, resolveSecret }) {
      let secret: string
      try {
        secret = await resolveSecret(rule.secretRef)
      } catch {
        return undefined
      }
      if (!secret) return undefined
      const valid =
        id === 'github'
          ? equal(headers['x-hub-signature-256'] ?? '', signature(secret, body))
          : rule.auth === 'bearer'
            ? equal(headers.authorization ?? '', `Bearer ${secret}`)
            : equal(headers['x-webhook-signature'] ?? '', signature(secret, signedBytes(headers, body)))
      if (!valid) return undefined
      const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
      const deliveryId = headers[id === 'github' ? 'x-github-delivery' : 'x-webhook-id'] ?? ''
      const event = headers[id === 'github' ? 'x-github-event' : 'x-webhook-event'] ?? ''
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(deliveryId) || !/^[A-Za-z0-9._:-]{1,128}$/.test(event))
        throw new TypeError('Invalid delivery metadata')
      return {
        deliveryId,
        event,
        timestamp:
          id === 'generic' && rule.auth === 'hmac'
            ? Number(headers['x-webhook-timestamp']) * 1000
            : timestamp(field(payload, rule.timestampPath)),
        payload,
      }
    },
  }
}
export const githubWebhookProvider = provider('github')
export const genericWebhookProvider = provider('generic')

/** A local test resolves the reference server-side and takes the production verification path. */
export function sampleHeaders(
  rule: WebhookRule,
  body: Uint8Array,
  secret: string,
  now: number,
  id: string,
): Record<string, string> {
  if (rule.provider === 'github')
    return {
      'x-github-delivery': id,
      'x-github-event': rule.event,
      'x-hub-signature-256': signature(secret, body),
    }
  const headers: Record<string, string> = {
    'x-webhook-id': id,
    'x-webhook-event': rule.event,
    'x-webhook-timestamp': String(Math.floor(now / 1000)),
  }
  if (rule.auth === 'bearer') headers.authorization = `Bearer ${secret}`
  else headers['x-webhook-signature'] = signature(secret, signedBytes(headers, body))
  return headers
}
