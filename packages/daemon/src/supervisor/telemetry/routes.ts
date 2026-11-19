import { looksLikeSecret } from '@agnes/error-sanitization'
import type { ConfigurationService } from '@agnes/host'
import type { ConfigAccount } from '@agnes/protocol'

const PROVIDERS = new Set([
  'deepseek',
  'openai',
  'anthropic',
  'google',
  'qwen',
  'moonshot',
  'kimi-coding',
  'zai',
  'openrouter',
  'minimax',
  'xai',
  'agnes-ai',
  'openai-codex',
  'github-copilot',
  'openai-compatible',
  'local',
  'demo',
  'other',
  'groq',
  'together',
  'cerebras',
  'nvidia',
  'huggingface',
  'moonshotai-cn',
  'zai-coding-cn',
])
const KEYLESS = new Set(['local', 'demo'])
const OAUTH = new Set(['openai-codex', 'github-copilot'])
const MODEL_FAMILY = /^(gpt|claude|gemini|deepseek|qwen|kimi|glm|llama|agnes)-[a-z0-9][a-z0-9._-]{0,95}$/i

export type RouteProvider = {
  provider_id: string
  auth_type: 'api_key' | 'oauth' | 'keyless' | 'unknown'
}

export async function telemetryAccounts(configuration: Pick<ConfigurationService, 'get'> | undefined) {
  return (await configuration?.get())?.accounts ?? []
}

export function telemetryRoute(accounts: readonly ConfigAccount[], route: string): RouteProvider {
  // Configuration can append a six-hex API variant suffix to the same account route.
  const account =
    accounts.find((row) => row.route === route) ??
    accounts.find(
      (row) => route.startsWith(`${row.route}-`) && /^[a-f0-9]{6}$/.test(route.slice(row.route.length + 1)),
    )
  const id = account?.providerId ?? route
  const provider_id = PROVIDERS.has(id) ? id : 'other'
  return {
    provider_id,
    auth_type:
      account?.authType === 'oauth' || OAUTH.has(provider_id)
        ? 'oauth'
        : KEYLESS.has(provider_id)
          ? 'keyless'
          : account?.authType === 'api-key' || provider_id !== 'other'
            ? 'api_key'
            : 'unknown',
  }
}

export function telemetryModel(
  provider: RouteProvider,
  model: string,
  accounts: readonly ConfigAccount[],
): string {
  if (
    provider.provider_id === 'other' ||
    !/^[a-z0-9][a-z0-9._+:/@-]{0,127}$/i.test(model) ||
    model.includes('://') ||
    /^[a-z]:\//i.test(model) ||
    accounts.some(
      (row) =>
        row.accountId === model ||
        row.label === model ||
        (row.route.startsWith('account-') && model.includes(row.route)),
    ) ||
    looksLikeSecret(model) ||
    (provider.provider_id === 'openai-compatible' && !MODEL_FAMILY.test(model))
  )
    return 'custom'
  return model
}
