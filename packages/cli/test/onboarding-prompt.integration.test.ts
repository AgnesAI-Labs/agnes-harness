import type { CredentialStore } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import { hasConfiguredApiKey, type PromptIO, runApiKeyPrompt } from '../src/onboarding/prompt.js'
import { ONBOARDING_PROVIDERS } from '../src/onboarding/provider-registry.js'

const key = 'sk-onboarding-integration-1234'

function credentials(read: CredentialStore['read'] = async () => null) {
  return {
    read,
    putApiKey: vi.fn(async () => undefined),
    putOAuth: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  } as unknown as CredentialStore
}

async function* lines(values: readonly string[]) {
  yield* values
}

function promptIO(values: readonly string[]) {
  const writes: string[] = []
  const io: PromptIO = { input: lines(values), write: (text) => writes.push(text) }
  return { io, writes }
}

describe('CLI API-key onboarding startup flow', () => {
  it('runs the first-start path through auth, provider, key, and model selection', async () => {
    const store = credentials()
    const openai = String(ONBOARDING_PROVIDERS.findIndex(({ id }) => id === 'openai') + 1)
    const { io, writes } = promptIO(['2', openai, key, '1'])

    const result = await runApiKeyPrompt({ io, credentials: store, profile: 'local-dev' })

    expect(result).toMatchObject({
      profile: 'local-dev',
      route: 'openai',
      credentialRef: 'secret://openai/default',
      thinking: 'off',
    })
    expect(result.model.length).toBeGreaterThan(0)
    expect(store.putApiKey).toHaveBeenCalledExactlyOnceWith('secret://openai/default', key)
    expect(writes.join('')).toContain('Select authentication method:')
    expect(writes.join('')).toContain('Select provider:')
    expect(writes.join('')).toContain('Select model:')
    expect(writes.join('')).toContain('Configured GPT (OpenAI)')
    expect(writes.join('')).not.toContain(key)
  })

  it('takes the configured fast path for every reviewed provider reference', async () => {
    for (const provider of ONBOARDING_PROVIDERS) {
      const read = vi.fn(async (ref: string) =>
        ref === provider.credentialRef
          ? { version: 1 as const, kind: 'api-key' as const, provider: provider.aiRegistryId, value: key }
          : null,
      )
      await expect(hasConfiguredApiKey(credentials(read))).resolves.toBe(true)
      expect(read).toHaveBeenCalledWith(provider.credentialRef)
    }
  })

  it('does not skip onboarding when all provider credentials are absent', async () => {
    const read = vi.fn(async () => null)
    await expect(hasConfiguredApiKey(credentials(read))).resolves.toBe(false)
    expect((read.mock.calls as unknown as string[][]).map(([ref]) => ref)).toEqual(
      ONBOARDING_PROVIDERS.map(({ credentialRef }) => credentialRef),
    )
  })
})
