import { ChildEnginesSaveParams } from '@agnes/protocol'
import type { ConfigSchema } from '@agnes/web-ui'

/** UI declarations only; existing administration endpoints remain the validation authority. */
export const searchConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'endpoint', 'maxResults', 'timeoutMs', 'ratePerMinute', 'enabled', 'makeDefault'],
  properties: {
    id: {
      type: 'string',
      enum: ['brave', 'tavily', 'exa', 'perplexity', 'searxng'],
      'x-ui': {
        labelKey: 'searchProvider',
        optionKeys: {
          brave: 'brave',
          tavily: 'tavily',
          exa: 'exa',
          perplexity: 'perplexity',
          searxng: 'searxng',
        },
        id: 'search-edit-provider',
        testId: 'search-edit-provider',
      },
    },
    endpoint: {
      type: 'string',
      maxLength: 2048,
      'x-ui': {
        labelKey: 'searchEndpoint',
        hintKey: 'searchEndpointHint',
        id: 'search-endpoint',
        testId: 'search-endpoint',
      },
    },
    maxResults: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      'x-ui': { labelKey: 'searchMaxResults', id: 'search-max-results', testId: 'search-max-results' },
    },
    timeoutMs: {
      type: 'integer',
      minimum: 1000,
      maximum: 60000,
      'x-ui': { labelKey: 'searchTimeout', id: 'search-timeout', testId: 'search-timeout' },
    },
    ratePerMinute: {
      type: 'integer',
      minimum: 1,
      maximum: 600,
      'x-ui': { labelKey: 'searchRate', id: 'search-rate', testId: 'search-rate' },
    },
    enabled: {
      type: 'boolean',
      'x-ui': { labelKey: 'searchEnabled', id: 'search-enabled', testId: 'search-enabled' },
    },
    makeDefault: {
      type: 'boolean',
      'x-ui': { labelKey: 'searchMakeDefault', id: 'search-make-default', testId: 'search-make-default' },
    },
  },
} satisfies ConfigSchema
export function childEngineConfigSchema(id: string): ConfigSchema {
  const document =
    ChildEnginesSaveParams.properties.engines.properties[
      id === 'claude-code' ? 'claudeCode' : id === 'sdk' ? 'sdk' : 'codex'
    ]
  const properties = Object.fromEntries(
    Object.entries(document.properties).map(([name, source]) => {
      const schema = JSON.parse(JSON.stringify(source)) as ConfigSchema
      const fieldName = name === 'allow' ? 'allow' : name
      return [
        name,
        {
          ...schema,
          'x-ui': {
            labelKey: `engine.${fieldName}`,
            id: `child-engine-${id}-${name}`,
            testId: `child-engine-${id}-${name}`,
            ...(name === 'protocol'
              ? { optionKeys: { sdk: 'engine.sdkProtocol', acp: 'engine.acpProtocol' } }
              : {}),
          },
        },
      ]
    }),
  )
  return { type: 'object', additionalProperties: false, required: document.required ?? [], properties }
}
