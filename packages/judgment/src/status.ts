import { createHash } from 'node:crypto'
import type { PluginContextFacets, ServiceCapability } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import { resolveRulesConfig, resolveStopConfig } from './config.js'
import { object } from './questions.js'
import type { JudgmentRuntime, JudgmentUse } from './runtime.js'

const counter = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const exactObject = (properties: Record<string, JsonValue>) => ({
  type: 'object' as const,
  additionalProperties: false as const,
  required: Object.keys(properties),
  properties,
})
const useSchema = exactObject({
  enabled: { type: 'boolean' },
  available: { type: 'boolean' },
  reason: { enum: ['none', 'disabled', 'native-required', 'model-unavailable', 'authorization-unavailable'] },
  requests: counter,
})
export const STATUS_SERVICE: ServiceCapability = {
  name: 'judgment.status',
  kind: 'query',
  scope: 'profile',
  timeoutMs: 1000,
  maxResultBytes: 4096,
  inputSchema: exactObject({}),
  outputSchema: exactObject({
    version: { const: 1 },
    configurationRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    state: { enum: ['ready', 'unconfigured', 'unavailable'] },
    reason: {
      enum: [
        'none',
        'model-not-configured',
        'model-unavailable',
        'ambiguous-model',
        'authorization-unavailable',
      ],
    },
    hookTimeout: { const: 'unknown' },
    cache: exactObject({ hit: counter, miss: counter, size: { ...counter, maximum: 2000 } }),
    uses: exactObject(
      Object.fromEntries(['stop', 'findRelevant', 'judgeBatch', 'rules'].map((use) => [use, useSchema])),
    ),
  }),
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export function registerJudgmentStatus(
  plugin: PluginContextFacets,
  runtime: JudgmentRuntime,
  config: unknown,
): () => void {
  const configurationRevision = createHash('sha256')
    .update(canonical(config ?? {}))
    .digest('hex')
  return plugin.services.register({
    ...STATUS_SERVICE,
    async handler(input) {
      if (!object(input) || Object.keys(input).length) throw new Error('Expected an empty status query')
      const chain = runtime.current(),
        reason = runtime.statusReason(),
        stats = runtime.stats()
      const usesConfig = object(config) && object(config.uses) ? config.uses : {}
      const enabled = (use: JudgmentUse) => {
        if (use === 'stop') return resolveStopConfig(config).enabled
        if (use === 'rules') return resolveRulesConfig(config).enabled
        const selected = usesConfig[use === 'findRelevant' ? 'find' : 'batch']
        return object(selected) && selected.enabled === true
      }
      return {
        version: 1,
        configurationRevision,
        state: chain ? 'ready' : reason === 'model-not-configured' ? 'unconfigured' : 'unavailable',
        reason,
        hookTimeout: 'unknown',
        cache: stats.cache,
        uses: Object.fromEntries(
          (['stop', 'findRelevant', 'judgeBatch', 'rules'] as const).map((use) => {
            const on = enabled(use)
            const unavailable = !on
              ? 'disabled'
              : reason === 'authorization-unavailable'
                ? 'authorization-unavailable'
                : !chain
                  ? 'model-unavailable'
                  : (use === 'rules' || use === 'findRelevant') && !chain[0]?.native
                    ? 'native-required'
                    : 'none'
            return [
              use,
              {
                enabled: on,
                available: unavailable === 'none',
                reason: unavailable,
                requests: stats.requests[use],
              },
            ]
          }),
        ),
      }
    },
  })
}
