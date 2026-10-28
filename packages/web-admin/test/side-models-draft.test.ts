import type { ConfigAccount } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { presetsFor, savedDraft } from '../src/settings/side-models/model.js'

const fixed = { contextWindow: 65536, maxTokens: 4096 }
const voiceAccount: ConfigAccount = {
  accountId: 'siliconflow',
  label: 'SiliconFlow',
  providerId: 'openai-audio',
  route: 'account-siliconflow',
  baseUrl: 'https://api.siliconflow.cn/v1',
  model: 'asr',
  models: [
    { id: 'asr', name: 'asr', ...fixed, audioRole: 'transcribe' },
    { id: 'tts', name: 'tts', ...fixed, audioRole: 'speech' },
  ],
  enabled: true,
  credentialConfigured: true,
  authType: 'api-key',
}

it('opens a saved voice entry without a preset that could refill its endpoint', () => {
  const draft = savedDraft(voiceAccount)
  expect(draft).toMatchObject({
    accountId: 'siliconflow',
    providerId: 'openai-audio',
    isNew: false,
    baseUrl: 'https://api.siliconflow.cn/v1',
  })
  expect(draft?.models.map((model) => model.id)).toEqual(['asr', 'tts'])
  // The adapter has several presets; none of them is the saved entry's.
  expect(presetsFor('openai-audio').length).toBeGreaterThan(1)
  expect(draft && 'presetId' in draft).toBe(false)
})

it('has no draft for an account the side-model page does not manage', () => {
  expect(savedDraft({ ...voiceAccount, providerId: 'openai' })).toBeUndefined()
})
