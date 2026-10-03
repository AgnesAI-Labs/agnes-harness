import { defineGeneratedAuthorSchema } from '@agnes/extension-api/runtime'

/** Explicit configuration for the default Budget implementation. Empty legacy configurations retain their own codec. */
export type DefaultBudgetConfig =
  | Readonly<{ mode: 'observe'; priceVersion: null }>
  | Readonly<{ mode: 'bounded-units'; priceVersion: null }>
  | Readonly<{ mode: 'cost-hard'; priceVersion: string }>

function freezeSource<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSource(child)
    Object.freeze(value)
  }
  return value
}

export const defaultBudgetConfigSource = freezeSource({
  ownerPackageId: 'agnes-core',
  name: 'BudgetConfig',
  typeId: 'agnes-core/budget-config@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/BudgetConfig',
    $defs: {
      BudgetConfig: {
        anyOf: [
          {
            type: 'object',
            properties: { mode: { const: 'observe' }, priceVersion: { type: 'null' } },
            required: ['mode', 'priceVersion'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { mode: { const: 'bounded-units' }, priceVersion: { type: 'null' } },
            required: ['mode', 'priceVersion'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              mode: { const: 'cost-hard' },
              priceVersion: { type: 'string', minLength: 1, maxLength: 256 },
            },
            required: ['mode', 'priceVersion'],
            additionalProperties: false,
          },
        ],
      },
    },
  },
})

export const defaultBudgetConfig = defineGeneratedAuthorSchema<DefaultBudgetConfig>(defaultBudgetConfigSource)
