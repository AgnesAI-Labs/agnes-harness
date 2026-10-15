import type { ServiceDef } from '@agnes/extension-api'

export const MHS_HUB_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
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
