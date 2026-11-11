import { knownModel } from '@agnes/ai'
import type { ConfigModel } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { chatModelPolicy } from '../src/configuration-compatible.js'

const policy = chatModelPolicy(() => true, knownModel)
const entry = {
  id: 'openai-compatible',
  api: 'openai-completions',
  baseUrl: 'https://placeholder.invalid/v1',
}

function record(model: ConfigModel) {
  const route = policy.compatibleRoute(
    {
      route: 'compat',
      baseUrl: 'https://example.test/v1',
      label: 'Compat',
      credentialRef: 'ref',
      model: model.id,
      models: [model],
    },
    'openai-completions',
  )
  return route.models[0]
}

describe('compatible account known models', () => {
  it('known DeepSeek model replays reasoning', () => {
    const [saved] = policy.compatibleModels(entry, 'https://example.test/v1', [
      { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek' },
    ])
    expect(record(saved as ConfigModel)).toMatchObject({
      reasoning: false,
      thinkingReplay: 'native',
      contextWindow: 1_000_000,
      maxTokens: 256_000,
    })
  })

  it('unknown model unchanged', () => {
    const [saved] = policy.compatibleModels(entry, 'https://example.test/v1', [{ id: 'foo-1', name: 'Foo' }])
    expect(record(saved as ConfigModel)).toMatchObject({
      reasoning: false,
      thinkingReplay: 'drop',
      contextWindow: 128_000,
      maxTokens: 8_192,
    })
  })

  it('user values win', () => {
    const [saved] = policy.compatibleModels(entry, 'https://example.test/v1', [
      { id: 'deepseek-v4-pro', name: 'DeepSeek Pro', contextWindow: 200_000 },
    ])
    expect(record(saved as ConfigModel)).toMatchObject({ contextWindow: 200_000, maxTokens: 256_000 })
  })

  it('record falls back to the table for a model without capacity', () => {
    expect(record({ id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' })).toMatchObject({
      reasoning: false,
      thinkingReplay: 'native',
      contextWindow: 1_000_000,
      maxTokens: 256_000,
    })
  })

  it('listing offers table values for known models', async () => {
    const result = await policy.testCompatibleAccount(
      { entry, baseUrl: 'https://example.test/v1', apiKey: 'k', row: undefined },
      {
        list: async () => ({ ids: ['deepseek-v4-flash', 'foo-1'] }),
        readCredential: async () => null,
      },
    )
    expect(result.models.map((m) => [m.id, m.contextWindow, m.maxTokens])).toEqual([
      ['deepseek-v4-flash', 1_000_000, 256_000],
      ['foo-1', 128_000, 8_192],
    ])
  })
})
