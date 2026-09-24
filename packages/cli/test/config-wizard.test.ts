import type { Client } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { runConfigurationWizard } from '../src/config-wizard.js'

const input = (...values: string[]): AsyncIterable<string> => ({
  async *[Symbol.asyncIterator]() {
    yield* values
  },
})

describe('CLI configuration wizard', () => {
  it('supports device-code subscription login without requesting or saving an API key', async () => {
    const snapshot = {
      profile: 'local-dev',
      revision: 0,
      configured: false,
      provider: null,
      accounts: [],
      defaultAccountId: null,
      effect: 'new-sessions' as const,
    }
    const saved = { ...snapshot, revision: 1, configured: true }
    const oauth = vi.fn(async (request: { action: string }) =>
      request.action === 'commit'
        ? { operationId: 'op', state: 'saved', snapshot: saved }
        : { operationId: 'op', state: 'ready', models: [{ id: 'm', name: 'Model' }] },
    )
    const client = {
      config: {
        oauth,
        providers: async () => ({
          providers: [
            {
              id: 'openai-codex',
              label: 'Codex',
              authType: 'oauth',
              baseUrl: 'https://chatgpt.com/backend-api',
            },
          ],
        }),
      },
    } as unknown as Client
    const secret = vi.fn(),
      write = vi.fn()
    expect(
      await runConfigurationWizard(client, snapshot, { input: input('Work', '1', '1'), secret, write }),
    ).toEqual(saved)
    expect(secret).not.toHaveBeenCalled()
    expect(oauth).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'start',
        loginMethod: 'device_code',
        label: 'Work',
        expectedRevision: 0,
      }),
    )
    expect(oauth).toHaveBeenCalledWith({ action: 'commit', operationId: 'op', model: 'm' })
  })
  it('tests and saves through client.config while using the revision returned by get', async () => {
    const test = vi.fn().mockResolvedValue({
      verified: true,
      models: [{ id: 'model-a', name: 'Model A' }],
    })
    const save = vi.fn().mockResolvedValue({
      profile: 'local-dev',
      revision: 2,
      configured: true,
      provider: {
        id: 'openai',
        baseUrl: 'https://api.example.test',
        model: 'model-a',
        credentialConfigured: true,
        authType: 'api-key',
      },
      effect: 'restart-required',
    })
    const client = {
      config: {
        providers: vi.fn().mockResolvedValue({
          providers: [
            { id: 'openai', label: 'OpenAI', api: 'openai-compatible', baseUrl: 'https://api.example.test' },
          ],
        }),
        test,
        save,
      },
    } as unknown as Client
    const output: string[] = []
    const secret = vi.fn().mockResolvedValue('secret-key')
    const saved = await runConfigurationWizard(
      client,
      { profile: 'local-dev', revision: 1, configured: false, provider: null, effect: 'restart-required' },
      { input: input('1', '', '1'), secret, write: (line) => output.push(line) },
    )
    expect(saved.revision).toBe(2)
    expect(test).toHaveBeenCalledWith({
      providerId: 'openai',
      baseUrl: 'https://api.example.test',
      apiKey: 'secret-key',
    })
    expect(save).toHaveBeenCalledWith({
      providerId: 'openai',
      baseUrl: 'https://api.example.test',
      apiKey: 'secret-key',
      model: 'model-a',
      expectedRevision: 1,
    })
    expect(secret).toHaveBeenCalledWith('API key (stored by the local backend; never returned): ')
    expect(output.join(' ')).not.toContain('secret-key')
    expect(output.join(' ')).toContain(
      'Credentials and model directory verified; selected-model inference was not tested.',
    )
  })

  it('does not claim selected-model inference when the catalogue passes but save rejects that model', async () => {
    const save = vi.fn().mockRejectedValue(new Error('CONFIG_MODEL_UNAVAILABLE'))
    const client = {
      config: {
        providers: async () => ({
          providers: [{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.example.test' }],
        }),
        test: async () => ({ verified: true, models: [{ id: 'model-a', name: 'Model A' }] }),
        save,
      },
    } as unknown as Client
    const output: string[] = []
    await expect(
      runConfigurationWizard(
        client,
        { profile: 'local-dev', revision: 1, configured: false, provider: null, effect: 'new-sessions' },
        { input: input('1', '', '1'), secret: async () => 'fixture-key', write: (line) => output.push(line) },
      ),
    ).rejects.toThrow('configuration save failed: CONFIG_MODEL_UNAVAILABLE')
    expect(output.join(' ')).toContain('selected-model inference was not tested')
    expect(output.join(' ')).not.toContain('Connection verified')
  })
})

it('manages an exact account through the shared SDK without asking for its key', async () => {
  const account = vi.fn(async () => ({ revision: 3 }))
  const client = { config: { account } } as unknown as Client
  const secret = vi.fn()
  await runConfigurationWizard(
    client,
    {
      profile: 'local-dev',
      revision: 2,
      configured: true,
      provider: null,
      effect: 'new-sessions',
      defaultAccountId: 'work',
      accounts: [
        {
          accountId: 'work',
          label: 'Work',
          providerId: 'openai',
          route: 'account-work',
          baseUrl: 'https://work.example/v1',
          model: 'm',
          models: [{ id: 'm', name: 'M' }],
          enabled: true,
          credentialConfigured: true,
        },
      ],
    },
    { input: input('1', 'disable'), write: () => undefined, secret },
  )
  expect(account).toHaveBeenCalledWith({ accountId: 'work', action: 'disable', expectedRevision: 2 })
  expect(secret).not.toHaveBeenCalled()
})
