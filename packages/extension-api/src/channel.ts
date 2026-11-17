import type { ChannelManifest, JsonValue } from '@agnes/protocol'
import { validateChannelManifest } from '@agnes/protocol'
import type { ChannelAdapter } from './channel-contract.js'
import { defineKind, type ProviderIdentity } from './provider-kind.js'

/** Platform implementation; the backend owns credentials, routing and runners. */
export interface ChannelProvider extends ProviderIdentity {
  readonly manifest: ChannelManifest
  /** Non-sensitive adapter options rendered by the shared channel settings page. */
  readonly configSchema?: import('./services.js').ServiceDef['inputSchema']
  create(input: { config: JsonValue }): Promise<ChannelAdapter> | ChannelAdapter
}
export const channelKind = defineKind<ChannelProvider>({
  kind: 'channel',
  scope: 'generation',
  validate(provider) {
    const result = validateChannelManifest(provider.manifest)
    if (!result.ok || provider.manifest.id !== provider.id || typeof provider.create !== 'function')
      throw new TypeError('Invalid channel provider')
    const m = provider.manifest
    if (
      !m.connection.modes.includes(m.connection.default) ||
      m.credentials.required.some((key) => m.credentials.optional.includes(key)) ||
      (m.events.supported.includes('cardAction') && !m.capabilities.card)
    )
      throw new TypeError('Invalid channel manifest relationships')
  },
  capabilities: (provider) =>
    Object.entries(provider.manifest.capabilities)
      .filter(([, value]) => value === true)
      .map(([key]) => key),
})
export interface ChannelInstance {
  id: string
  workspace: string
  /** `default` selects the general assistant; otherwise an explicit package#bundle reference.
   * Binding an existing session always preserves that session's agent. */
  agent: string
  credentialRefs: Record<string, string>
  allowFrom: string[]
  requireMention: boolean
  config?: JsonValue
}
export interface ChannelConfiguration {
  instances: ChannelInstance[]
}
export interface ChannelRuntime {
  status(): JsonValue
  session?(session: { id: string; workspace: string }): Promise<JsonValue>
  binding?(
    action: 'bind' | 'unbind',
    input: { instanceId: string; targetId?: string; expectedVersion: number },
    session: { id: string; workspace: string },
  ): Promise<JsonValue>
}

/** Current-session binding uses the normal session effect journal and backend session identity. */
export function channelServiceCapabilities(): import('./services.js').ServiceCapability[] {
  const empty = { type: 'object', properties: {}, additionalProperties: false } as const
  return ['session', 'bind', 'unbind'].map((method) => ({
    name: `channel.${method}`,
    scope: 'session' as const,
    inputSchema:
      method === 'session'
        ? empty
        : {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              instanceId: { type: 'string', maxLength: 48 },
              targetId: { type: 'string', pattern: '^[a-f0-9]{32}$' },
              expectedVersion: { type: 'integer', minimum: 0 },
            },
            required:
              method === 'bind'
                ? ['instanceId', 'targetId', 'expectedVersion']
                : ['instanceId', 'expectedVersion'],
          },
    outputSchema: {},
    timeoutMs: 30000,
    maxResultBytes: 524288,
    ...(method === 'session'
      ? { kind: 'query' as const }
      : {
          kind: 'effect' as const,
          effectPolicy: {
            isDestructive: true,
            isOpenWorld: true,
            replay: 'idempotent' as const,
            requiresApproval: 'never' as const,
            approvalScopes: [],
          },
        }),
  }))
}

/** Secret values are never accepted in the credential mapping. */
export const CHANNEL_CONFIG_SCHEMA: import('./services.js').ServiceDef['inputSchema'] = {
  type: 'object',
  additionalProperties: false,
  required: ['instances'],
  properties: {
    instances: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'workspace', 'agent', 'credentialRefs', 'allowFrom', 'requireMention'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}$' },
          workspace: { type: 'string', minLength: 1, maxLength: 4096 },
          agent: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[a-zA-Z0-9@_./#-]+$' },
          credentialRefs: {
            type: 'object',
            maxProperties: 32,
            additionalProperties: {
              type: 'string',
              pattern: '^secret://[a-z0-9-]+/[a-z0-9._-]+$',
              maxLength: 256,
            },
          },
          allowFrom: {
            type: 'array',
            maxItems: 1024,
            items: { type: 'string', minLength: 1, maxLength: 256 },
          },
          requireMention: { type: 'boolean' },
          config: { type: 'object', additionalProperties: true },
        },
      },
    },
  },
}
