import { probeCustomModel } from '@agnes/ai'
import type { ConfigCustomModel, ConfigCustomVerification, ModelRecord } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import { ConfigCustomModel as CustomSchema } from '@agnes/protocol/gen/agnes-v1'

/** This is a deployment-defined route, not an entry in a vendor's model registry. */
export const CUSTOM_PROVIDER = {
  id: 'custom-openai',
  displayName: '自定义 OpenAI 兼容服务',
  route: 'custom-openai',
  api: 'openai-completions',
  baseUrl: 'https://api.example.invalid/v1',
  credentialRef: 'secret://custom-openai/default',
} as const

export function normalizeCustomModel(value: unknown): ConfigCustomModel | undefined {
  const result = validateAgainst<ConfigCustomModel>(CustomSchema, value)
  if (
    !result.ok ||
    !result.value.input.includes('text') ||
    (result.value.supportsMidConvoSystemMessages && result.value.api !== 'openai-completions') ||
    result.value.modelIds?.some((id) => !/^[^\p{Cc}\p{Z}\s]{1,256}$/u.test(id)) ||
    result.value.maxTokens > result.value.contextWindow
  )
    return undefined
  return structuredClone(result.value)
}

export function customModelRecord(id: string, baseUrl: string, custom: ConfigCustomModel): ModelRecord {
  return {
    id,
    name: id,
    route: CUSTOM_PROVIDER.route,
    api: custom.api,
    baseUrl,
    reasoning: custom.reasoning,
    input: [...custom.input],
    contextWindow: custom.contextWindow,
    maxTokens: custom.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    pricePolicy: {
      currency: 'USD',
      unit: 'per-million-tokens',
      perMillion: { inputUncached: null, output: null, cacheRead: null, cacheWrite: null },
    },
    toolCallFormats: custom.toolCalls ? ['native'] : [],
    thinkingReplay: 'drop',
    contract_id: null,
    compat: {
      maxTokensField: custom.maxTokensField,
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsMidConvoSystemMessages: custom.supportsMidConvoSystemMessages === true,
      supportsReasoningEffort: false,
    },
  }
}

/** Probe the current endpoint and model through the same adapter used by runtime requests. */
export async function testCustomModel(options: {
  baseUrl: string
  model: string
  custom: ConfigCustomModel
  apiKey: string
  request: typeof fetch
}): Promise<ConfigCustomVerification> {
  return probeCustomModel({
    baseUrl: options.baseUrl,
    model: options.model,
    record: customModelRecord(options.model, options.baseUrl, options.custom),
    apiKey: options.apiKey,
    request: options.request,
  })
}

/** A declaration requires both ordinary inference and acceptance of the declared message shape. */
export function customModelVerified(custom: ConfigCustomModel, result: ConfigCustomVerification): boolean {
  const passed = (id: ConfigCustomVerification['checks'][number]['id']) =>
    result.checks.some((check) => check.id === id && check.status === 'passed')
  return passed('inference') && (!custom.supportsMidConvoSystemMessages || passed('mid-conversation-system'))
}
