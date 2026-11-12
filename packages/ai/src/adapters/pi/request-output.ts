import type { ModelRecord } from '@agnes/protocol'
import { knownModel } from '../../known-models.js'

const DEEPSEEK_API = /^https:\/\/api\.deepseek\.com(?:\/(?:v1|beta))?\/?$/

/**
 * The output cap a streamed request carries when its caller set none.
 *
 * DeepSeek omits max_tokens at an 8K non-thinking default, regardless of catalog capacity
 * (https://api-docs.deepseek.com/api/create-chat-completion/, verified 2026-10-12), so its own API
 * gets a bounded default. A documented model (known-models) behind any other OpenAI-compatible
 * endpoint gets its documented limit, as DeepSeek Harness sends its catalogue default on every
 * request: a gateway sent no cap applies its own, and one cut DeepSeek V4.1 flash at 65,536 tokens
 * mid-reasoning (2026-11-12). Never above the catalog capacity, which also prices child/compaction
 * holds. Any other model is sent without a cap.
 */
export function defaultOutputCap(api: string, baseUrl: string, record: ModelRecord): number | undefined {
  if (DEEPSEEK_API.test(baseUrl)) return Math.min(32768, record.maxTokens)
  const known = api === 'openai-completions' ? knownModel(record.id) : undefined
  return known ? Math.min(known.maxTokens, record.maxTokens) : undefined
}

/**
 * The record's compat flags as the wire library reads them. A documented model takes its cap as
 * `max_tokens`, the field DeepSeek documents: pi chooses it only for DeepSeek's own host, and a
 * gateway in front of the model may ignore `max_completion_tokens` (one did, 2026-11-12). A field
 * the record names wins.
 */
export function wireCompat(api: string, record: ModelRecord): ModelRecord['compat'] {
  if (api !== 'openai-completions' || !knownModel(record.id)) return record.compat
  if (record.compat === undefined) return { maxTokensField: 'max_tokens' }
  if (typeof record.compat !== 'object' || record.compat === null || Array.isArray(record.compat))
    return record.compat
  return { maxTokensField: 'max_tokens', ...record.compat }
}
