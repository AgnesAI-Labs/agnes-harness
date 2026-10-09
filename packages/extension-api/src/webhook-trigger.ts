import type { WebhookRule } from '@agnes/protocol/gen/app-server'
import { defineProviderKind, type ProviderIdentity } from './provider-kind.js'

/** Raw input has no authority. Providers verify before interpreting payload fields. */
export interface WebhookTriggerProvider extends ProviderIdentity {
  verify(input: {
    body: Uint8Array
    headers: Readonly<Record<string, string>>
    rule: Readonly<WebhookRule>
    resolveSecret(ref: string): Promise<string>
  }): Promise<{ deliveryId: string; event: string; timestamp: number; payload: unknown } | undefined>
}
export const webhookTriggerKind = defineProviderKind<WebhookTriggerProvider>({
  kind: 'webhook-trigger',
  scope: 'process',
  validate(provider) {
    if (typeof provider.verify !== 'function') throw new TypeError('Invalid webhook trigger provider')
  },
  capabilities: () => ['authenticated-inbound'],
})
