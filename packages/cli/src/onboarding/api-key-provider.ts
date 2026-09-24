import { getApiKeyProvider } from '@agnes/ai'
import type { CredentialWriter } from '@agnes/host'
import { onboardingProvider } from './provider-registry.js'
import type { OnboardingResult } from './state.js'

const KEY = /^[\x21-\x7e]{8,65536}$/

export type ApiKeySetupDeps = {
  credentials: Pick<CredentialWriter, 'putApiKey'>
  chooseModel(models: readonly { id: string; name: string }[], signal: AbortSignal): Promise<string | null>
  signal: AbortSignal
  profile: string
}

/**
 * Completes the provider-select → API-key → model-select hand-off used by both TUI and CLI.
 * The UI id is deliberately translated through the CLI registry before touching the AI registry;
 * this keeps aliases such as `moonshotai` and `qwen-token-plan` out of the runtime route table.
 * Remote model discovery is optional: providers without a reviewed models endpoint use Pi's pinned
 * catalogue, while a discovered catalogue can only narrow that catalogue.
 */
export async function setupApiKeyProvider(
  providerId: string,
  key: string,
  deps: ApiKeySetupDeps,
): Promise<OnboardingResult> {
  const selected = onboardingProvider(providerId)
  if (!selected) throw new Error('Unknown API-key provider.')
  if (!KEY.test(key)) throw new Error('Enter a valid API key.')
  deps.signal.throwIfAborted()
  const entry = getApiKeyProvider(selected.aiRegistryId)
  if (!entry) throw new Error('Unknown API-key provider.')

  let modelIds: readonly string[] | undefined
  if (entry.fetchModels) modelIds = await entry.fetchModels({ credential: key, signal: deps.signal })
  const adapter = await entry.createAdapter(modelIds === undefined ? undefined : { modelIds })
  const models = adapter.models(entry.route).map((model) => ({ id: model.id, name: model.name }))
  if (models.length === 0) throw new Error('No models are available for this provider.')
  const model = await deps.chooseModel(models, deps.signal)
  deps.signal.throwIfAborted()
  if (model === null || !models.some((candidate) => candidate.id === model))
    throw new Error('Select a model returned by the provider catalogue.')
  await deps.credentials.putApiKey(entry.credentialRef, key)
  return {
    profile: deps.profile,
    route: entry.route,
    model,
    thinking: 'off',
    credentialRef: entry.credentialRef,
  }
}
