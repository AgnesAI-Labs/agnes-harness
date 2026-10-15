import type { ServiceDef } from '@agnes/extension-api'

// Credentials and query parameters are rejected before the Host persists a proposal/configuration.
export const MHS_EXTERNAL_ADDRESS_PATTERN =
  '^wss?://(?:\\[[0-9a-fA-F:]+\\]|(?:[0-9]{1,3}\\.){3}[0-9]{1,3})(?::[0-9]{1,5})?/mhs-peer/v1$'

export const MHS_HUB_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    externalHub: {
      type: 'object',
      properties: {
        address: { type: 'string', maxLength: 512, pattern: MHS_EXTERNAL_ADDRESS_PATTERN },
        allowlist: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: { type: 'string', maxLength: 512, pattern: MHS_EXTERNAL_ADDRESS_PATTERN },
        },
      },
      required: ['address', 'allowlist'],
      additionalProperties: false,
    },
    listenerPorts: {
      type: 'object',
      properties: { device: { anyOf: [{ const: 'auto' }, { type: 'integer', minimum: 1, maximum: 65535 }] } },
      required: ['device'],
      additionalProperties: false,
    },
  },
  required: ['listenerPorts'],
  additionalProperties: false,
} satisfies ServiceDef['inputSchema']
export const MHS_HUB_CHECK_SCHEMA = {
  type: 'object',
  properties: { device: { type: 'string' } },
  required: ['device'],
  additionalProperties: false,
} satisfies ServiceDef['inputSchema']
