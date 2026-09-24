import type { CredentialStore } from '@agnes/host'
import { setupApiKeyProvider } from './api-key-provider.js'
import { ONBOARDING_PROVIDERS } from './provider-registry.js'
import type { OnboardingResult } from './state.js'

export type PromptIO = {
  input: AsyncIterable<string>
  write(text: string): void
}

/** Returns true when any selected provider has a valid stored API key. */
export async function hasConfiguredApiKey(credentials: Pick<CredentialStore, 'read'>): Promise<boolean> {
  for (const provider of ONBOARDING_PROVIDERS) {
    const value = await credentials.read(provider.credentialRef)
    if (value?.kind === 'api-key' && value.value.length > 0) return true
  }
  return false
}

/** A small line-oriented startup flow; it is deliberately independent of the TUI renderer. */
export async function runApiKeyPrompt(input: {
  io: PromptIO
  credentials: CredentialStore
  profile: string
  signal?: AbortSignal
}): Promise<OnboardingResult> {
  const signal = input.signal ?? new AbortController().signal
  const lines = input.io.input[Symbol.asyncIterator]()
  const ask = async (question: string): Promise<string> => {
    input.io.write(question)
    const next = await lines.next()
    if (next.done) throw new Error('Authentication cancelled.')
    return next.value.trim()
  }
  input.io.write(
    'Select authentication method:\n  1) Sign in with an account\n  2) Sign in with an API key\n',
  )
  const method = await ask('Select [1-2]: ')
  if (method !== '2') throw new Error('Agnes account login is not configured yet.')
  input.io.write('Select provider:\n')
  ONBOARDING_PROVIDERS.forEach((provider, index) => {
    input.io.write(`  ${index + 1}) ${provider.label}\n`)
  })
  const providerIndex = Number(await ask(`Select [1-${ONBOARDING_PROVIDERS.length}]: `)) - 1
  const provider = ONBOARDING_PROVIDERS[providerIndex]
  if (!provider) throw new Error('Unknown API-key provider.')
  const key = await ask('API key: ')
  const result = await setupApiKeyProvider(provider.id, key, {
    credentials: input.credentials,
    profile: input.profile,
    signal,
    chooseModel: async (models) => {
      input.io.write('Select model:\n')
      models.forEach((model, index) => {
        input.io.write(`  ${index + 1}) ${model.name} (${model.id})\n`)
      })
      const selected = Number(await ask(`Select [1-${models.length}]: `)) - 1
      return models[selected]?.id ?? null
    },
  })
  input.io.write(`Configured ${provider.label} / ${result.model}. Starting chat.\n`)
  return result
}
