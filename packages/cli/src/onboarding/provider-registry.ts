import type { OnboardingOption } from './state.js'

export type OnboardingProviderId =
  | 'moonshotai'
  | 'kimi-coding'
  | 'zai'
  | 'qwen-token-plan'
  | 'deepseek'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'minimax'
  | 'xai'
  | 'agnes-ai'

export type AiRegistryProviderId =
  | 'moonshot'
  | 'kimi-coding'
  | 'zai'
  | 'qwen'
  | 'deepseek'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'minimax'
  | 'xai'
  | 'agnes-ai'

export type OnboardingProvider = {
  /** Stable source provider identity from the pinned Pi catalogue. */
  readonly id: OnboardingProviderId
  readonly label: string
  /** Route/provider identity consumed by the AI registry factory. */
  readonly aiRegistryId: AiRegistryProviderId
  readonly credentialRef: `secret://${AiRegistryProviderId}/default`
}

const PROVIDERS = [
  {
    id: 'moonshotai',
    label: 'Kimi',
    aiRegistryId: 'moonshot',
    credentialRef: 'secret://moonshot/default',
  },
  {
    id: 'kimi-coding',
    label: 'Kimi Coding Plan',
    aiRegistryId: 'kimi-coding',
    credentialRef: 'secret://kimi-coding/default',
  },
  {
    id: 'zai',
    label: 'GLM (Z.AI)',
    aiRegistryId: 'zai',
    credentialRef: 'secret://zai/default',
  },
  {
    id: 'qwen-token-plan',
    label: 'Qwen',
    aiRegistryId: 'qwen',
    credentialRef: 'secret://qwen/default',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    aiRegistryId: 'deepseek',
    credentialRef: 'secret://deepseek/default',
  },
  {
    id: 'openai',
    label: 'GPT (OpenAI)',
    aiRegistryId: 'openai',
    credentialRef: 'secret://openai/default',
  },
  {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    aiRegistryId: 'anthropic',
    credentialRef: 'secret://anthropic/default',
  },
  {
    id: 'google',
    label: 'Gemini (Google)',
    aiRegistryId: 'google',
    credentialRef: 'secret://google/default',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    aiRegistryId: 'openrouter',
    credentialRef: 'secret://openrouter/default',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    aiRegistryId: 'minimax',
    credentialRef: 'secret://minimax/default',
  },
  {
    id: 'xai',
    label: 'xAI',
    aiRegistryId: 'xai',
    credentialRef: 'secret://xai/default',
  },
  {
    id: 'agnes-ai',
    label: 'Agnes AI',
    aiRegistryId: 'agnes-ai',
    credentialRef: 'secret://agnes-ai/default',
  },
] as const satisfies readonly OnboardingProvider[]

function assertUniqueProviders(providers: readonly OnboardingProvider[]): void {
  const ids = new Set<OnboardingProviderId>()
  const registryIds = new Set<AiRegistryProviderId>()
  const refs = new Set<string>()
  for (const provider of providers) {
    if (ids.has(provider.id) || registryIds.has(provider.aiRegistryId) || refs.has(provider.credentialRef))
      throw new Error('Duplicate onboarding provider identity')
    ids.add(provider.id)
    registryIds.add(provider.aiRegistryId)
    refs.add(provider.credentialRef)
  }
}

assertUniqueProviders(PROVIDERS)

export const ONBOARDING_PROVIDERS: readonly OnboardingProvider[] = Object.freeze(
  PROVIDERS.map((provider) => Object.freeze({ ...provider })),
)

export const ONBOARDING_PROVIDER_OPTIONS: readonly OnboardingOption[] = Object.freeze(
  ONBOARDING_PROVIDERS.map(({ id, label }) => Object.freeze({ id, label })),
)

/** Resolves the UI's stable option id to the id consumed by @agnes/ai. */
export function onboardingProvider(id: string): OnboardingProvider | undefined {
  return ONBOARDING_PROVIDERS.find((provider) => provider.id === id)
}
