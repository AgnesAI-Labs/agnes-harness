import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { ONBOARDING_PROVIDER_OPTIONS, ONBOARDING_PROVIDERS } from '../src/onboarding/provider-registry.js'

const EXPECTED_PROVIDERS = [
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
] as const

describe('API-key onboarding provider registry', () => {
  it('exports the twelve reviewed Pi provider IDs in a stable product order', () => {
    expect(ONBOARDING_PROVIDERS).toEqual(EXPECTED_PROVIDERS)
  })

  it('maps each Pi identity one-to-one onto the AI registry credential identity', () => {
    expect(new Set(ONBOARDING_PROVIDERS.map(({ id }) => id))).toHaveLength(12)
    expect(new Set(ONBOARDING_PROVIDERS.map(({ aiRegistryId }) => aiRegistryId))).toHaveLength(12)
    expect(new Set(ONBOARDING_PROVIDERS.map(({ credentialRef }) => credentialRef))).toHaveLength(12)
    for (const provider of ONBOARDING_PROVIDERS) {
      expect(provider.credentialRef).toBe(`secret://${provider.aiRegistryId}/default`)
      expect(Object.keys(provider).sort()).toEqual(['aiRegistryId', 'credentialRef', 'id', 'label'])
    }
  })

  it('exports a deeply frozen OnboardingOption projection', () => {
    expect(ONBOARDING_PROVIDER_OPTIONS).toEqual(EXPECTED_PROVIDERS.map(({ id, label }) => ({ id, label })))
    expect(Object.isFrozen(ONBOARDING_PROVIDERS)).toBe(true)
    expect(Object.isFrozen(ONBOARDING_PROVIDER_OPTIONS)).toBe(true)
    expect(ONBOARDING_PROVIDERS.every(Object.isFrozen)).toBe(true)
    expect(ONBOARDING_PROVIDER_OPTIONS.every(Object.isFrozen)).toBe(true)

    expect(() => {
      ;(ONBOARDING_PROVIDERS[0] as { label: string }).label = 'mutated'
    }).toThrow(TypeError)
    expect(() => {
      ;(ONBOARDING_PROVIDER_OPTIONS as unknown as object[]).push({})
    }).toThrow(TypeError)
  })

  it('contains no endpoint, request, environment or secret-value seam', async () => {
    const source = await readFile(new URL('../src/onboarding/provider-registry.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/baseUrl|https?:\/\/|fetch\s*\(|process\.env|apiKey|token\s*:/)
  })
})
