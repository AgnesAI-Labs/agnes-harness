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
      'x-ui': {
        labelKey: 'searchMaxResults',
        control: 'text',
        id: 'search-max-results',
        testId: 'search-max-results',
      },
    },
    timeoutMs: {
      type: 'integer',
      minimum: 1000,
      maximum: 60000,
      'x-ui': { labelKey: 'searchTimeout', control: 'text', id: 'search-timeout', testId: 'search-timeout' },
    },
    ratePerMinute: {
      type: 'integer',
      minimum: 1,
      maximum: 600,
      'x-ui': { labelKey: 'searchRate', control: 'text', id: 'search-rate', testId: 'search-rate' },
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

const voiceField = (key: string, id: string, hint = false) => ({
  labelKey: `voice.field.${key}`,
  ...(hint ? { hintKey: `voice.field.${key}Hint` } : {}),
  id,
  testId: id,
})
/** The voice settings as one flat form; the daemon's `VoiceSettings` stays the validation authority. */
export const voiceConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'inputEnabled',
    'language',
    'autoSend',
    'maxSeconds',
    'readingEnabled',
    'voice',
    'speed',
    'autoRead',
    'pauseSeconds',
  ],
  properties: {
    inputEnabled: { type: 'boolean', 'x-ui': voiceField('inputEnabled', 'voice-input-enabled') },
    language: {
      type: 'string',
      maxLength: 16,
      pattern: '^$|^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$',
      'x-ui': { ...voiceField('language', 'voice-language', true), control: 'text' },
    },
    autoSend: { type: 'boolean', 'x-ui': voiceField('autoSend', 'voice-auto-send', true) },
    maxSeconds: {
      type: 'integer',
      minimum: 5,
      maximum: 120,
      'x-ui': { ...voiceField('maxSeconds', 'voice-max-seconds'), control: 'text' },
    },
    readingEnabled: { type: 'boolean', 'x-ui': voiceField('readingEnabled', 'voice-reading-enabled') },
    voice: {
      type: 'string',
      maxLength: 128,
      'x-ui': { ...voiceField('voice', 'voice-voice', true), control: 'text' },
    },
    speed: {
      type: 'number',
      minimum: 0.25,
      maximum: 4,
      'x-ui': { ...voiceField('speed', 'voice-speed', true), control: 'text' },
    },
    autoRead: { type: 'boolean', 'x-ui': voiceField('autoRead', 'voice-auto-read', true) },
    pauseSeconds: {
      type: 'number',
      minimum: 0.5,
      maximum: 5,
      'x-ui': { ...voiceField('pauseSeconds', 'voice-pause'), control: 'text' },
    },
  },
} satisfies ConfigSchema
